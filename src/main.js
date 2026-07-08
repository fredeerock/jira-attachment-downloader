const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

let mainWindow = null;
let cancelRequested = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 940,
    height: 760,
    minWidth: 720,
    minHeight: 600,
    title: 'Jira Attachment Downloader',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- Helpers ----------

function normalizeSite(site) {
  let s = (site || '').trim();
  if (!s) return '';
  s = s.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s;
}

function authHeader(email, token) {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

function sanitize(name) {
  return (name || 'untitled')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'untitled';
}

async function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = path.join(dir, filename);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i += 1;
  }
  return candidate;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------- IPC: Test connection ----------

ipcMain.handle('jira:test', async (_event, { site, email, token }) => {
  const base = normalizeSite(site);
  if (!base || !email || !token) {
    return { ok: false, error: 'Please fill in site, email and API token.' };
  }
  try {
    const res = await fetch(`${base}/rest/api/3/myself`, {
      headers: { Authorization: authHeader(email, token), Accept: 'application/json' }
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'Authentication failed. Check your email and API token.' };
    }
    if (!res.ok) {
      return { ok: false, error: `Server returned ${res.status}. Check the site URL.` };
    }
    const me = await res.json();
    return { ok: true, displayName: me.displayName || me.emailAddress || 'Connected' };
  } catch (err) {
    return { ok: false, error: `Could not reach Jira: ${err.message}` };
  }
});

// ---------- IPC: pick / open folder ----------

ipcMain.handle('jira:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a download folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('jira:openFolder', async (_event, folder) => {
  if (folder) shell.openPath(folder);
});

ipcMain.handle('jira:openExternal', async (_event, url) => {
  if (url && /^https:\/\//i.test(url)) shell.openExternal(url);
});

ipcMain.handle('jira:cancel', async () => {
  cancelRequested = true;
});

// ---------- IPC: download ----------

ipcMain.handle('jira:download', async (event, payload) => {
  cancelRequested = false;
  const send = (data) => event.sender.send('download:progress', data);

  const base = normalizeSite(payload.site);
  const { email, token, projectKey, outputDir } = payload;
  const groupByIssue = payload.groupByIssue !== false;

  if (!base || !email || !token) return { ok: false, error: 'Missing credentials.' };
  if (!projectKey) return { ok: false, error: 'Missing project key.' };
  if (!outputDir) return { ok: false, error: 'Missing download folder.' };

  const auth = authHeader(email, token);

  // Parse one or more project keys (comma / space / newline separated).
  const projects = [...new Set(
    projectKey
      .split(/[\s,]+/)
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean)
  )];
  if (projects.length === 0) return { ok: false, error: 'Missing project key.' };

  // Parse optional date range (YYYY-MM-DD). Range applies to attachment date.
  const dateFrom = (payload.dateFrom || '').trim();
  const dateTo = (payload.dateTo || '').trim();
  const fromMs = dateFrom ? Date.parse(`${dateFrom}T00:00:00`) : null;
  const toMs = dateTo ? Date.parse(`${dateTo}T23:59:59.999`) : null;
  if (dateFrom && Number.isNaN(fromMs)) return { ok: false, error: 'Invalid "from" date.' };
  if (dateTo && Number.isNaN(toMs)) return { ok: false, error: 'Invalid "to" date.' };
  if (fromMs != null && toMs != null && fromMs > toMs) {
    return { ok: false, error: 'The "from" date is after the "to" date.' };
  }

  const projectOf = (issueKey) => (issueKey.split('-')[0] || '').toUpperCase();
  const label = projects.length === 1 ? projects[0] : 'Jira';
  const rootDir = path.join(outputDir, sanitize(`${label} attachments`));
  await fsp.mkdir(rootDir, { recursive: true });

  try {
    send({ type: 'status', message: `Searching issues in ${projects.join(', ')}…` });

    // 1. Collect all issues + attachments (paginated via enhanced JQL search).
    const issues = [];
    let nextPageToken = undefined;
    const projectList = projects.map((p) => `"${p}"`).join(', ');
    let jql = `project IN (${projectList}) AND attachments IS NOT EMPTY`;
    // Narrow by updated date when a start date is set: an attachment created on
    // date T means the issue was updated at or after T.
    if (dateFrom) jql += ` AND updated >= "${dateFrom}"`;
    jql += ' ORDER BY created ASC';

    do {
      if (cancelRequested) return { ok: false, cancelled: true };
      const url = new URL(`${base}/rest/api/3/search/jql`);
      url.searchParams.set('jql', jql);
      url.searchParams.set('fields', 'attachment,key,summary');
      url.searchParams.set('maxResults', '100');
      if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);

      const res = await fetch(url.toString(), {
        headers: { Authorization: auth, Accept: 'application/json' }
      });

      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: 'Authentication failed while searching issues.' };
      }
      if (res.status === 400) {
        return { ok: false, error: `One or more projects not found, or JQL rejected.` };
      }
      if (!res.ok) {
        return { ok: false, error: `Search failed with status ${res.status}.` };
      }

      const data = await res.json();
      for (const issue of data.issues || []) {
        const attachments = (issue.fields && issue.fields.attachment) || [];
        if (attachments.length) {
          issues.push({
            key: issue.key,
            summary: (issue.fields && issue.fields.summary) || '',
            attachments
          });
        }
      }
      nextPageToken = data.nextPageToken;
      send({ type: 'status', message: `Found ${issues.length} issue(s) with attachments so far…` });
    } while (nextPageToken);

    const allAttachments = [];
    for (const issue of issues) {
      for (const att of issue.attachments) {
        // Apply the optional date range to each attachment's creation date.
        if (fromMs != null || toMs != null) {
          const created = att.created ? Date.parse(att.created) : NaN;
          if (Number.isNaN(created)) continue;
          if (fromMs != null && created < fromMs) continue;
          if (toMs != null && created > toMs) continue;
        }
        allAttachments.push({ issueKey: issue.key, att });
      }
    }

    const total = allAttachments.length;
    if (total === 0) {
      return { ok: true, total: 0, downloaded: 0, failed: 0, rootDir };
    }

    send({ type: 'begin', total, message: `Downloading ${total} attachment(s)…` });

    // 2. Download each attachment.
    let downloaded = 0;
    let failed = 0;
    let bytes = 0;

    for (let i = 0; i < allAttachments.length; i++) {
      if (cancelRequested) {
        return { ok: false, cancelled: true, downloaded, failed, total, rootDir };
      }
      const { issueKey, att } = allAttachments[i];
      let targetDir = rootDir;
      if (projects.length > 1) targetDir = path.join(targetDir, sanitize(projectOf(issueKey)));
      if (groupByIssue) targetDir = path.join(targetDir, sanitize(issueKey));
      await fsp.mkdir(targetDir, { recursive: true });

      const filename = sanitize(att.filename || `attachment-${att.id}`);
      const destPath = await uniquePath(targetDir, filename);

      try {
        const res = await fetch(att.content, {
          headers: { Authorization: auth }
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        await fsp.writeFile(destPath, buffer);
        bytes += buffer.length;
        downloaded += 1;
        send({
          type: 'progress',
          current: i + 1,
          total,
          downloaded,
          failed,
          bytes,
          bytesLabel: formatBytes(bytes),
          message: `${issueKey} · ${filename}`
        });
      } catch (err) {
        failed += 1;
        send({
          type: 'progress',
          current: i + 1,
          total,
          downloaded,
          failed,
          bytes,
          bytesLabel: formatBytes(bytes),
          message: `Failed: ${issueKey} · ${filename} (${err.message})`,
          error: true
        });
      }
    }

    return { ok: true, total, downloaded, failed, bytes, bytesLabel: formatBytes(bytes), rootDir };
  } catch (err) {
    return { ok: false, error: err.message, rootDir };
  }
});
