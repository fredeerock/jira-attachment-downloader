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
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
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

function parseProjectKeys(projectKey) {
  return [...new Set(
    (projectKey || '')
      .split(/[\s,]+/)
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean)
  )];
}

function parseDateRange(payload) {
  const dateFrom = (payload.dateFrom || '').trim();
  const dateTo = (payload.dateTo || '').trim();
  const fromMs = dateFrom ? Date.parse(`${dateFrom}T00:00:00`) : null;
  const toMs = dateTo ? Date.parse(`${dateTo}T23:59:59.999`) : null;

  if (dateFrom && Number.isNaN(fromMs)) return { error: 'Invalid "from" date.' };
  if (dateTo && Number.isNaN(toMs)) return { error: 'Invalid "to" date.' };
  if (fromMs != null && toMs != null && fromMs > toMs) {
    return { error: 'The "from" date is after the "to" date.' };
  }
  return { dateFrom, dateTo, fromMs, toMs };
}

function isMediaAttachment(att) {
  const mime = (att && att.mimeType ? att.mimeType : '').toLowerCase();
  return mime.startsWith('image/') || mime.startsWith('video/');
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function adfToText(node) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(adfToText).join('');
  if (typeof node !== 'object') return '';
  if (node.type === 'text') return node.text || '';

  const content = Array.isArray(node.content) ? node.content : [];
  const body = content.map(adfToText).join('');

  if (node.type === 'paragraph') return `${body}\n`;
  if (node.type === 'heading') return `${body}\n`;
  if (node.type === 'listItem') return `- ${body.trim()}\n`;
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'doc') return body;
  return body;
}

function descriptionToText(descriptionField) {
  if (!descriptionField) return '';
  if (typeof descriptionField === 'string') return descriptionField;
  const text = adfToText(descriptionField).replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

function statusName(issue) {
  return (issue && issue.fields && issue.fields.status && issue.fields.status.name) || 'Unknown';
}

function isDoneStatus(name) {
  return /(done|closed|resolved|complete|completed)/i.test(name || '');
}

function toFileUri(absPath) {
  return `file://${absPath.split(path.sep).join('/')}`;
}

async function fetchIssuesWithAttachments({ base, auth, projects, dateFrom }) {
  const issues = [];
  let nextPageToken = undefined;
  const projectList = projects.map((p) => `"${p}"`).join(', ');
  let jql = `project IN (${projectList}) AND attachments IS NOT EMPTY`;
  if (dateFrom) jql += ` AND updated >= "${dateFrom}"`;
  jql += ' ORDER BY created ASC';

  do {
    if (cancelRequested) return { cancelled: true };
    const url = new URL(`${base}/rest/api/3/search/jql`);
    url.searchParams.set('jql', jql);
    url.searchParams.set('fields', 'attachment,key,summary,description,status,parent,issuetype');
    url.searchParams.set('maxResults', '100');
    if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: auth, Accept: 'application/json' }
    });

    if (res.status === 401 || res.status === 403) {
      return { error: 'Authentication failed while searching issues.' };
    }
    if (res.status === 400) {
      return { error: 'One or more projects not found, or JQL rejected.' };
    }
    if (!res.ok) {
      return { error: `Search failed with status ${res.status}.` };
    }

    const data = await res.json();
    for (const issue of data.issues || []) {
      const attachments = (issue.fields && issue.fields.attachment) || [];
      if (attachments.length) issues.push(issue);
    }
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  return { issues };
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

// ---------- IPC: list projects ----------

ipcMain.handle('jira:projects', async (_event, { site, email, token }) => {
  const base = normalizeSite(site);
  if (!base || !email || !token) {
    return { ok: false, error: 'Please fill in site, email and API token.' };
  }
  const auth = authHeader(email, token);
  try {
    const projects = [];
    let startAt = 0;
    let isLast = false;
    do {
      const url = new URL(`${base}/rest/api/3/project/search`);
      url.searchParams.set('maxResults', '50');
      url.searchParams.set('startAt', String(startAt));
      url.searchParams.set('orderBy', 'name');

      const res = await fetch(url.toString(), {
        headers: { Authorization: auth, Accept: 'application/json' }
      });
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: 'Authentication failed. Check your credentials.' };
      }
      if (!res.ok) {
        return { ok: false, error: `Could not load projects (status ${res.status}).` };
      }
      const data = await res.json();
      for (const p of data.values || []) {
        projects.push({ key: p.key, name: p.name });
      }
      const batch = (data.values || []).length;
      startAt += batch;
      isLast = data.isLast === true || batch === 0 ||
        (data.total != null && startAt >= data.total);
    } while (!isLast);

    projects.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, projects };
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

// ---------- IPC: preload media for report ----------

ipcMain.handle('jira:preloadMedia', async (_event, payload) => {
  cancelRequested = false;

  const base = normalizeSite(payload.site);
  const { email, token } = payload;
  const projects = parseProjectKeys(payload.projectKey);
  const parsedRange = parseDateRange(payload);

  if (!base || !email || !token) return { ok: false, error: 'Missing credentials.' };
  if (!projects.length) return { ok: false, error: 'Enter at least one project key.' };
  if (parsedRange.error) return { ok: false, error: parsedRange.error };

  const auth = authHeader(email, token);
  const { dateFrom, fromMs, toMs } = parsedRange;
  const maxItems = Math.max(50, Math.min(Number(payload.maxItems) || 1500, 5000));

  try {
    const issueResult = await fetchIssuesWithAttachments({ base, auth, projects, dateFrom });
    if (issueResult.cancelled) return { ok: false, cancelled: true };
    if (issueResult.error) return { ok: false, error: issueResult.error };

    const cacheRoot = path.join(app.getPath('userData'), 'report-media-cache');
    await fsp.rm(cacheRoot, { recursive: true, force: true });
    await fsp.mkdir(cacheRoot, { recursive: true });

    const items = [];
    let totalCandidates = 0;
    for (const issue of issueResult.issues) {
      const attachments = (issue.fields && issue.fields.attachment) || [];
      for (const att of attachments) {
        const created = att.created ? Date.parse(att.created) : NaN;
        if (fromMs != null || toMs != null) {
          if (Number.isNaN(created)) continue;
          if (fromMs != null && created < fromMs) continue;
          if (toMs != null && created > toMs) continue;
        }
        if (!isMediaAttachment(att)) continue;
        totalCandidates += 1;
      }
    }

    let cached = 0;
    let truncated = false;
    for (const issue of issueResult.issues) {
      const attachments = (issue.fields && issue.fields.attachment) || [];
      const issueSummary = (issue.fields && issue.fields.summary) || '';
      const issueDescription = descriptionToText(issue.fields && issue.fields.description).slice(0, 4000);
      const status = statusName(issue);

      const parent = issue.fields && issue.fields.parent;
      const parentIssueType = parent && parent.fields && parent.fields.issuetype && parent.fields.issuetype.name;
      const epicKey = parentIssueType === 'Epic' ? parent.key : '';
      const epicSummary = parentIssueType === 'Epic' && parent.fields ? (parent.fields.summary || '') : '';

      for (const att of attachments) {
        const created = att.created ? Date.parse(att.created) : NaN;
        if (fromMs != null || toMs != null) {
          if (Number.isNaN(created)) continue;
          if (fromMs != null && created < fromMs) continue;
          if (toMs != null && created > toMs) continue;
        }
        if (!isMediaAttachment(att)) continue;

        if (items.length >= maxItems) {
          truncated = true;
          break;
        }

        if (cancelRequested) return { ok: false, cancelled: true };

        const issueDir = path.join(cacheRoot, sanitize(issue.key));
        await fsp.mkdir(issueDir, { recursive: true });
        const safeName = sanitize(att.filename || `attachment-${att.id}`);
        const localPath = await uniquePath(issueDir, safeName);

        try {
          const res = await fetch(att.content, { headers: { Authorization: auth } });
          if (!res.ok) continue;
          const buffer = Buffer.from(await res.arrayBuffer());
          await fsp.writeFile(localPath, buffer);

          cached += 1;
          items.push({
            id: `${issue.key}:${att.id}`,
            issueKey: issue.key,
            issueSummary,
            issueDescription,
            status,
            epicKey,
            epicSummary,
            fileName: safeName,
            mimeType: (att.mimeType || '').toLowerCase(),
            created: att.created || '',
            bytes: buffer.length,
            localPath,
            localUri: toFileUri(localPath)
          });
        } catch (_err) {
          // Ignore individual media failures and continue.
        }
      }

      if (truncated) break;
    }

    return {
      ok: true,
      projects,
      totalCandidates,
      preloaded: items.length,
      truncated,
      maxItems,
      items
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- IPC: generate stakeholder report ----------

ipcMain.handle('jira:generateReport', async (_event, payload) => {
  try {
    const outputDir = (payload.outputDir || '').trim();
    const selectedIds = Array.isArray(payload.selectedIds) ? payload.selectedIds : [];
    const mediaItems = Array.isArray(payload.mediaItems) ? payload.mediaItems : [];
    const grouping = payload.grouping === 'epic' ? 'epic' : 'task';
    const reportTitle = (payload.reportTitle || 'Stakeholder Report').trim();

    if (!outputDir) return { ok: false, error: 'Choose a download folder first.' };
    if (!selectedIds.length) return { ok: false, error: 'Select at least one media item.' };

    const selectedSet = new Set(selectedIds);
    const selected = mediaItems.filter((m) => selectedSet.has(m.id));
    if (!selected.length) return { ok: false, error: 'No selected media items were found.' };

    const stamp = new Date().toISOString().slice(0, 10);
    const rootDir = path.join(outputDir, sanitize(`${reportTitle} ${stamp}`));
    const mediaDir = path.join(rootDir, 'media');
    await fsp.mkdir(mediaDir, { recursive: true });

    const copiedItems = [];
    for (const item of selected) {
      const ext = path.extname(item.fileName || '') || (item.mimeType.startsWith('video/') ? '.mp4' : '.jpg');
      const base = sanitize(`${item.issueKey}_${path.basename(item.fileName || 'media', ext)}`);
      const dest = await uniquePath(mediaDir, `${base}${ext}`);
      await fsp.copyFile(item.localPath, dest);
      copiedItems.push({ ...item, reportMediaFile: path.basename(dest) });
    }

    const groups = new Map();
    for (const item of copiedItems) {
      const groupKey = grouping === 'epic'
        ? (item.epicKey ? `${item.epicKey} ${item.epicSummary || ''}`.trim() : 'No Epic')
        : `${item.issueKey} ${item.issueSummary || ''}`.trim();
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(item);
    }

    const accomplishedNotes = String(payload.accomplishedNotes || '').trim();
    const todoNotes = String(payload.todoNotes || '').trim();

    const groupBlocks = [...groups.entries()].map(([groupName, itemsInGroup]) => {
      const byIssue = new Map();
      for (const item of itemsInGroup) {
        if (!byIssue.has(item.issueKey)) byIssue.set(item.issueKey, []);
        byIssue.get(item.issueKey).push(item);
      }

      const issueBlocks = [...byIssue.entries()].map(([issueKey, issueItems]) => {
        const first = issueItems[0];
        const desc = escapeHtml(first.issueDescription || 'No description provided.').replace(/\n/g, '<br/>');
        const mediaHtml = issueItems.map((m) => {
          const src = `media/${encodeURIComponent(m.reportMediaFile)}`;
          const meta = `${escapeHtml(m.fileName)} · ${escapeHtml(m.status)} · ${formatBytes(m.bytes || 0)}`;
          if ((m.mimeType || '').startsWith('video/')) {
            return `<figure class="media-card"><video controls preload="metadata" src="${src}"></video><figcaption>${meta}</figcaption></figure>`;
          }
          return `<figure class="media-card"><img loading="lazy" src="${src}" alt="${escapeHtml(m.fileName)}"/><figcaption>${meta}</figcaption></figure>`;
        }).join('');

        const accomplished = isDoneStatus(first.status)
          ? `<li><strong>${escapeHtml(issueKey)}:</strong> ${escapeHtml(first.issueSummary || '')}</li>`
          : '';
        const pending = !isDoneStatus(first.status)
          ? `<li><strong>${escapeHtml(issueKey)}:</strong> ${escapeHtml(first.issueSummary || '')}</li>`
          : '';

        return {
          html: `
            <article class="issue-block">
              <h4>${escapeHtml(issueKey)} · ${escapeHtml(first.issueSummary || '')}</h4>
              <p class="status-chip">Status: ${escapeHtml(first.status || 'Unknown')}</p>
              <p class="desc">${desc}</p>
              <div class="media-grid">${mediaHtml}</div>
            </article>
          `,
          accomplished,
          pending
        };
      });

      const accomplishedList = issueBlocks.map((b) => b.accomplished).filter(Boolean).join('') || '<li>None marked done in this group yet.</li>';
      const pendingList = issueBlocks.map((b) => b.pending).filter(Boolean).join('') || '<li>No open items in this group.</li>';

      return `
        <section class="group">
          <h3>${escapeHtml(groupName)}</h3>
          <div class="summary-grid">
            <div>
              <h5>Accomplished</h5>
              <ul>${accomplishedList}</ul>
            </div>
            <div>
              <h5>Yet To Be Accomplished</h5>
              <ul>${pendingList}</ul>
            </div>
          </div>
          ${issueBlocks.map((b) => b.html).join('')}
        </section>
      `;
    }).join('');

    const projects = parseProjectKeys(payload.projectKey || '').join(', ');
    const dateLine = [payload.dateFrom || 'Any start', payload.dateTo || 'Any end'].join(' to ');
    const manualAccomplished = accomplishedNotes
      ? `<section class="manual-notes"><h3>Project Accomplishments (Manual Notes)</h3><p>${escapeHtml(accomplishedNotes).replace(/\n/g, '<br/>')}</p></section>`
      : '';
    const manualTodo = todoNotes
      ? `<section class="manual-notes"><h3>Project Remaining Work (Manual Notes)</h3><p>${escapeHtml(todoNotes).replace(/\n/g, '<br/>')}</p></section>`
      : '';

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(reportTitle)}</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; background: #f3f4f6; color: #111827; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .hero { background: linear-gradient(135deg, #312e81, #6d28d9); color: #fff; border-radius: 16px; padding: 24px; }
    .hero h1 { margin: 0 0 8px; font-size: 30px; }
    .hero p { margin: 4px 0; color: #ddd6fe; }
    .manual-notes, .group { background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; padding: 18px; margin-top: 18px; }
    .group h3 { margin: 0 0 12px; }
    .summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .summary-grid h5 { margin: 0 0 8px; font-size: 14px; color: #374151; }
    ul { margin: 0; padding-left: 18px; }
    .issue-block { border-top: 1px solid #e5e7eb; padding-top: 14px; margin-top: 14px; }
    .issue-block h4 { margin: 0 0 8px; }
    .status-chip { display: inline-block; margin: 0 0 8px; padding: 4px 10px; border-radius: 999px; background: #eef2ff; color: #3730a3; font-size: 12px; }
    .desc { margin: 0 0 12px; color: #374151; line-height: 1.5; }
    .media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
    .media-card { margin: 0; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; background: #f9fafb; }
    .media-card img, .media-card video { width: 100%; display: block; max-height: 220px; object-fit: cover; background: #000; }
    .media-card figcaption { padding: 8px; font-size: 12px; color: #4b5563; word-break: break-word; }
    @media (max-width: 760px) {
      .summary-grid { grid-template-columns: 1fr; }
      .hero h1 { font-size: 24px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="hero">
      <h1>${escapeHtml(reportTitle)}</h1>
      <p><strong>Projects:</strong> ${escapeHtml(projects || 'N/A')}</p>
      <p><strong>Date Range:</strong> ${escapeHtml(dateLine)}</p>
      <p><strong>Generated:</strong> ${escapeHtml(new Date().toLocaleString())}</p>
      <p><strong>Grouping:</strong> ${escapeHtml(grouping === 'epic' ? 'Epic' : 'Task')}</p>
    </header>
    ${manualAccomplished}
    ${manualTodo}
    ${groupBlocks}
  </div>
</body>
</html>`;

    const reportPath = path.join(rootDir, 'index.html');
    await fsp.writeFile(reportPath, html, 'utf8');

    return {
      ok: true,
      reportPath,
      rootDir,
      mediaCount: copiedItems.length
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
