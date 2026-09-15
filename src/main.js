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

function assigneeName(issue) {
  return (issue && issue.fields && issue.fields.assignee && issue.fields.assignee.displayName) || 'Unassigned';
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
    url.searchParams.set('fields', 'attachment,key,summary,description,status,parent,issuetype,assignee');
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

// ---------- Markdown export helpers ----------

function encodeMdPath(relPath) {
  return String(relPath).split('/').map(encodeURIComponent).join('/');
}

function mdCell(value) {
  return String(value == null ? '' : value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br/>')
    .trim();
}

function adfApplyMarks(text, marks) {
  let out = text;
  for (const mark of marks || []) {
    if (mark.type === 'strong') out = `**${out}**`;
    else if (mark.type === 'em') out = `*${out}*`;
    else if (mark.type === 'code') out = '`' + out + '`';
    else if (mark.type === 'strike') out = `~~${out}~~`;
    else if (mark.type === 'link' && mark.attrs && mark.attrs.href) out = `[${out}](${mark.attrs.href})`;
  }
  return out;
}

// Converts Atlassian Document Format to Markdown. ctx.mediaById maps an ADF
// media id to a ready-to-embed markdown snippet for a downloaded attachment.
function adfToMarkdown(node, ctx = {}) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map((n) => adfToMarkdown(n, ctx)).join('');
  if (typeof node !== 'object') return '';

  const content = Array.isArray(node.content) ? node.content : [];
  const inner = () => content.map((n) => adfToMarkdown(n, ctx)).join('');

  switch (node.type) {
    case 'doc':
      return content.map((n) => adfToMarkdown(n, ctx)).join('\n');
    case 'text':
      return adfApplyMarks(node.text || '', node.marks);
    case 'hardBreak':
      return '\n';
    case 'paragraph':
      return `${inner()}\n`;
    case 'heading': {
      const level = Math.min(6, Math.max(1, (node.attrs && node.attrs.level) || 3));
      return `${'#'.repeat(level)} ${inner().trim()}\n`;
    }
    case 'blockquote':
      return inner().split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') + '\n';
    case 'bulletList':
      return content.map((li) => `- ${adfToMarkdown(li, ctx).trim().replace(/\n/g, '\n  ')}`).join('\n') + '\n';
    case 'orderedList':
      return content.map((li, i) => `${i + 1}. ${adfToMarkdown(li, ctx).trim().replace(/\n/g, '\n   ')}`).join('\n') + '\n';
    case 'listItem':
      return inner();
    case 'taskList':
      return inner();
    case 'taskItem':
      return `- [${node.attrs && node.attrs.state === 'DONE' ? 'x' : ' '}] ${inner().trim()}\n`;
    case 'codeBlock':
      return '```' + ((node.attrs && node.attrs.language) || '') + '\n' +
        content.map((c) => c.text || '').join('') + '\n```\n';
    case 'rule':
      return '\n---\n';
    case 'media': {
      const attrs = node.attrs || {};
      const embed = ctx.mediaById && ctx.mediaById.get(String(attrs.id));
      if (embed) return `\n${embed}\n`;
      return `\n*(embedded media: ${attrs.id || 'unknown'})*\n`;
    }
    case 'inlineCard':
    case 'blockCard':
      return (node.attrs && node.attrs.url) ? `<${node.attrs.url}>` : '';
    case 'mention':
      return `@${(node.attrs && node.attrs.text ? node.attrs.text.replace(/^@/, '') : 'unknown')}`;
    case 'emoji':
      return (node.attrs && (node.attrs.text || node.attrs.shortName)) || '';
    case 'status':
      return `\`${(node.attrs && node.attrs.text) || ''}\``;
    case 'date':
      return (node.attrs && node.attrs.timestamp) ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : '';
    case 'tableRow':
      return '| ' + content.map((c) => adfToMarkdown(c, ctx).replace(/\s*\n+\s*/g, ' ').trim()).join(' | ') + ' |';
    case 'table': {
      const rows = content.map((r) => adfToMarkdown(r, ctx));
      if (!rows.length) return '';
      const columnCount = (content[0].content || []).length || 1;
      const divider = '|' + ' --- |'.repeat(columnCount);
      return [rows[0], divider, ...rows.slice(1)].join('\n') + '\n';
    }
    default:
      return inner();
  }
}

function adfFieldToMarkdown(field, ctx) {
  if (!field) return '';
  if (typeof field === 'string') return field.trim();
  return adfToMarkdown(field, ctx).replace(/\n{3,}/g, '\n\n').trim();
}

function personLabel(person) {
  if (!person) return '';
  const name = person.displayName || person.name || person.accountId || '';
  const email = person.emailAddress ? ` <${person.emailAddress}>` : '';
  return `${name}${email}`.trim();
}

function renderFieldValue(value, ctx) {
  if (value == null || value === '') return '';
  if (Array.isArray(value)) {
    return value.map((v) => renderFieldValue(v, ctx)).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    if (value.type === 'doc') return adfFieldToMarkdown(value, ctx);
    if (value.displayName || value.emailAddress) return personLabel(value);
    if (value.name) return String(value.name);
    if (value.value) return String(value.value);
    if (value.key) return String(value.key);
    try {
      const json = JSON.stringify(value);
      return json.length > 500 ? `${json.slice(0, 500)}…` : json;
    } catch (_err) {
      return '';
    }
  }
  return String(value);
}

function mediaEmbedMarkdown(att, relPath) {
  const name = att.filename || `attachment-${att.id}`;
  const mime = (att.mimeType || '').toLowerCase();
  if (!relPath) return `\`${name}\` — not downloaded (outside the selected date range)`;
  const href = encodeMdPath(relPath);
  if (mime.startsWith('image/')) return `![${name}](${href})`;
  if (mime.startsWith('video/')) {
    return `<video src="${href}" controls width="640"></video>\n\n[▶ ${name}](${href})`;
  }
  return `[${name}](${href})`;
}

async function fetchFieldNameMap({ base, auth }) {
  const map = new Map();
  try {
    const res = await fetch(`${base}/rest/api/3/field`, {
      headers: { Authorization: auth, Accept: 'application/json' }
    });
    if (!res.ok) return map;
    for (const field of await res.json()) {
      if (field && field.id) map.set(field.id, field.name || field.id);
    }
  } catch (_err) {
    // A missing field map only costs us pretty custom-field names.
  }
  return map;
}

async function fetchAllComments({ base, auth, issueKey }) {
  const comments = [];
  let startAt = 0;
  for (;;) {
    if (cancelRequested) break;
    const url = new URL(`${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`);
    url.searchParams.set('maxResults', '100');
    url.searchParams.set('startAt', String(startAt));
    url.searchParams.set('orderBy', 'created');

    const res = await fetch(url.toString(), {
      headers: { Authorization: auth, Accept: 'application/json' }
    });
    if (!res.ok) break;

    const data = await res.json();
    const batch = data.comments || [];
    comments.push(...batch);
    startAt += batch.length;
    if (!batch.length || startAt >= (data.total || 0)) break;
  }
  return comments;
}

async function fetchAllIssuesForExport({ base, auth, projects, dateFrom, send }) {
  const issues = [];
  let nextPageToken = undefined;
  const projectList = projects.map((p) => `"${p}"`).join(', ');
  let jql = `project IN (${projectList})`;
  if (dateFrom) jql += ` AND updated >= "${dateFrom}"`;
  jql += ' ORDER BY created ASC';

  do {
    if (cancelRequested) return { cancelled: true };
    const url = new URL(`${base}/rest/api/3/search/jql`);
    url.searchParams.set('jql', jql);
    url.searchParams.set('fields', '*all');
    url.searchParams.set('expand', 'changelog');
    url.searchParams.set('maxResults', '50');
    if (nextPageToken) url.searchParams.set('nextPageToken', nextPageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: auth, Accept: 'application/json' }
    });
    if (!res.ok) return { error: `Metadata search failed with status ${res.status}.` };

    const data = await res.json();
    issues.push(...(data.issues || []));
    if (send) send({ type: 'status', message: `Collected metadata for ${issues.length} issue(s)…` });
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  return { issues };
}

const SUMMARY_FIELD_IDS = new Set([
  'summary', 'description', 'status', 'issuetype', 'priority', 'assignee', 'reporter',
  'creator', 'created', 'updated', 'resolutiondate', 'resolution', 'labels', 'components',
  'fixVersions', 'versions', 'parent', 'subtasks', 'issuelinks', 'duedate', 'environment',
  'votes', 'watches', 'project', 'attachment', 'comment', 'worklog', 'timetracking',
  'progress', 'aggregateprogress', 'workratio', 'statuscategorychangedate', 'lastViewed',
  'timespent', 'timeestimate', 'timeoriginalestimate', 'aggregatetimespent',
  'aggregatetimeestimate', 'aggregatetimeoriginalestimate', 'security', 'thumbnail'
]);

async function buildMarkdownExport({ base, auth, projects, dateFrom, dateTo, attachmentPaths, send }) {
  if (send) send({ type: 'status', message: 'Building Markdown metadata export…' });

  const [fieldNames, issueResult] = await Promise.all([
    fetchFieldNameMap({ base, auth }),
    fetchAllIssuesForExport({ base, auth, projects, dateFrom, send })
  ]);

  if (issueResult.cancelled) return { cancelled: true };
  if (issueResult.error) return { error: issueResult.error };

  const issues = issueResult.issues;
  const lines = [];

  lines.push(`# Jira Export — ${projects.join(', ')}`);
  lines.push('');
  lines.push(`> Machine-readable knowledge dump intended for AI analysis. Attachments are embedded as relative links so images and videos render in a Markdown viewer.`);
  lines.push('');
  lines.push('| | |');
  lines.push('| --- | --- |');
  lines.push(`| Projects | ${mdCell(projects.join(', '))} |`);
  lines.push(`| Generated | ${mdCell(new Date().toISOString())} |`);
  lines.push(`| Jira site | ${mdCell(base)} |`);
  lines.push(`| Date filter | ${mdCell(`${dateFrom || 'any start'} to ${dateTo || 'any end'}`)} |`);
  lines.push(`| Issues exported | ${issues.length} |`);
  lines.push('');

  lines.push('## Contents');
  lines.push('');
  for (const issue of issues) {
    const summary = (issue.fields && issue.fields.summary) || '';
    lines.push(`- **${issue.key}** — ${mdCell(summary)} *(${renderFieldValue(issue.fields && issue.fields.status)})*`);
  }
  lines.push('');

  let processed = 0;
  for (const issue of issues) {
    if (cancelRequested) return { cancelled: true };
    const f = issue.fields || {};
    const attachments = f.attachment || [];

    // Map ADF media ids to embeddable markdown so inline screenshots survive.
    const mediaById = new Map();
    for (const att of attachments) {
      const rel = attachmentPaths.get(String(att.id));
      mediaById.set(String(att.id), mediaEmbedMarkdown(att, rel));
    }
    const ctx = { mediaById };

    lines.push('---');
    lines.push('');
    lines.push(`## ${issue.key} — ${f.summary || '(no summary)'}`);
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('| --- | --- |');
    lines.push(`| Issue key | ${mdCell(issue.key)} |`);
    lines.push(`| URL | ${mdCell(`${base}/browse/${issue.key}`)} |`);
    lines.push(`| Type | ${mdCell(renderFieldValue(f.issuetype, ctx))} |`);
    lines.push(`| Status | ${mdCell(renderFieldValue(f.status, ctx))} |`);
    lines.push(`| Status category | ${mdCell(f.status && f.status.statusCategory ? f.status.statusCategory.name : '')} |`);
    lines.push(`| Resolution | ${mdCell(renderFieldValue(f.resolution, ctx))} |`);
    lines.push(`| Priority | ${mdCell(renderFieldValue(f.priority, ctx))} |`);
    lines.push(`| Assignee | ${mdCell(personLabel(f.assignee) || 'Unassigned')} |`);
    lines.push(`| Reporter | ${mdCell(personLabel(f.reporter))} |`);
    lines.push(`| Creator | ${mdCell(personLabel(f.creator))} |`);
    lines.push(`| Created | ${mdCell(f.created)} |`);
    lines.push(`| Updated | ${mdCell(f.updated)} |`);
    lines.push(`| Resolved | ${mdCell(f.resolutiondate)} |`);
    lines.push(`| Due date | ${mdCell(f.duedate)} |`);
    lines.push(`| Labels | ${mdCell((f.labels || []).join(', '))} |`);
    lines.push(`| Components | ${mdCell(renderFieldValue(f.components, ctx))} |`);
    lines.push(`| Fix versions | ${mdCell(renderFieldValue(f.fixVersions, ctx))} |`);
    lines.push(`| Affects versions | ${mdCell(renderFieldValue(f.versions, ctx))} |`);
    lines.push(`| Parent | ${mdCell(f.parent ? `${f.parent.key} — ${(f.parent.fields && f.parent.fields.summary) || ''}` : '')} |`);
    lines.push(`| Subtasks | ${mdCell((f.subtasks || []).map((s) => `${s.key} (${(s.fields && s.fields.summary) || ''})`).join('; '))} |`);
    lines.push(`| Original estimate | ${mdCell(f.timeoriginalestimate)} |`);
    lines.push(`| Time estimate | ${mdCell(f.timeestimate)} |`);
    lines.push(`| Time spent | ${mdCell(f.timespent)} |`);
    lines.push(`| Votes | ${mdCell(f.votes && f.votes.votes)} |`);
    lines.push(`| Watchers | ${mdCell(f.watches && f.watches.watchCount)} |`);
    lines.push(`| Attachments | ${attachments.length} |`);
    lines.push('');

    const links = (f.issuelinks || []).map((link) => {
      const other = link.outwardIssue || link.inwardIssue;
      if (!other) return '';
      const rel = link.outwardIssue ? (link.type && link.type.outward) : (link.type && link.type.inward);
      return `- ${rel || 'relates to'} **${other.key}** — ${(other.fields && other.fields.summary) || ''}`;
    }).filter(Boolean);
    if (links.length) {
      lines.push('### Linked issues');
      lines.push('');
      lines.push(...links);
      lines.push('');
    }

    const description = adfFieldToMarkdown(f.description, ctx);
    lines.push('### Description');
    lines.push('');
    lines.push(description || '*(no description)*');
    lines.push('');

    const environment = adfFieldToMarkdown(f.environment, ctx);
    if (environment) {
      lines.push('### Environment');
      lines.push('');
      lines.push(environment);
      lines.push('');
    }

    const customEntries = [];
    for (const [fieldId, value] of Object.entries(f)) {
      if (SUMMARY_FIELD_IDS.has(fieldId)) continue;
      if (value == null || value === '' || (Array.isArray(value) && !value.length)) continue;
      const rendered = renderFieldValue(value, ctx);
      if (!rendered) continue;
      customEntries.push(`- **${fieldNames.get(fieldId) || fieldId}** (\`${fieldId}\`): ${mdCell(rendered)}`);
    }
    if (customEntries.length) {
      lines.push('### Other fields');
      lines.push('');
      lines.push(...customEntries);
      lines.push('');
    }

    if (attachments.length) {
      lines.push(`### Attachments (${attachments.length})`);
      lines.push('');
      for (const att of attachments) {
        const rel = attachmentPaths.get(String(att.id));
        lines.push(`#### ${att.filename || `attachment-${att.id}`}`);
        lines.push('');
        lines.push(`- Uploaded by: ${mdCell(personLabel(att.author))}`);
        lines.push(`- Uploaded at: ${mdCell(att.created)}`);
        lines.push(`- Type: ${mdCell(att.mimeType)} · Size: ${mdCell(formatBytes(att.size || 0))}`);
        lines.push(`- Local file: ${rel ? `\`${rel}\`` : '*not downloaded*'}`);
        lines.push('');
        lines.push(mediaEmbedMarkdown(att, rel));
        lines.push('');
      }
    }

    const comments = await fetchAllComments({ base, auth, issueKey: issue.key });
    if (comments.length) {
      lines.push(`### Comments (${comments.length})`);
      lines.push('');
      comments.forEach((comment, index) => {
        const body = adfFieldToMarkdown(comment.body, ctx);
        lines.push(`#### Comment ${index + 1} — ${personLabel(comment.author) || 'Unknown'}`);
        lines.push('');
        lines.push(`*Created ${comment.created || 'unknown'}${comment.updated && comment.updated !== comment.created ? ` · Updated ${comment.updated}` : ''}${comment.updateAuthor && comment.updateAuthor.accountId !== (comment.author && comment.author.accountId) ? ` by ${personLabel(comment.updateAuthor)}` : ''}*`);
        lines.push('');
        lines.push(body || '*(empty comment)*');
        lines.push('');
      });
    }

    const worklogs = (f.worklog && f.worklog.worklogs) || [];
    if (worklogs.length) {
      lines.push(`### Worklog (${worklogs.length})`);
      lines.push('');
      for (const entry of worklogs) {
        lines.push(`- ${mdCell(personLabel(entry.author))} · ${mdCell(entry.timeSpent)} · started ${mdCell(entry.started)}${entry.comment ? ` — ${mdCell(adfFieldToMarkdown(entry.comment, ctx))}` : ''}`);
      }
      lines.push('');
    }

    const histories = (issue.changelog && issue.changelog.histories) || [];
    if (histories.length) {
      lines.push(`### Change history (${histories.length})`);
      lines.push('');
      lines.push('| When | Who | Field | From | To |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const history of histories) {
        for (const item of history.items || []) {
          lines.push(`| ${mdCell(history.created)} | ${mdCell(personLabel(history.author))} | ${mdCell(item.field)} | ${mdCell(item.fromString)} | ${mdCell(item.toString)} |`);
        }
      }
      lines.push('');
    }

    processed += 1;
    if (send && processed % 5 === 0) {
      send({ type: 'status', message: `Markdown export: ${processed}/${issues.length} issue(s) written…` });
    }
  }

  return { markdown: lines.join('\n'), issueCount: issues.length };
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

ipcMain.handle('jira:preloadMedia', async (event, payload) => {
  cancelRequested = false;
  const send = (data) => event.sender.send('preload:progress', data);

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
    send({ type: 'status', message: 'Scanning Jira issues for media…' });
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

    const progressTotal = Math.min(totalCandidates, maxItems);
    send({ type: 'begin', total: progressTotal, message: `Preparing to cache ${progressTotal} media file(s)…` });

    let cached = 0;
    let processed = 0;
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
      const assignee = assigneeName(issue);

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

        processed += 1;

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
            assigneeName: assignee,
            fileName: safeName,
            mimeType: (att.mimeType || '').toLowerCase(),
            created: att.created || '',
            bytes: buffer.length,
            localPath,
            localUri: toFileUri(localPath)
          });
          send({
            type: 'progress',
            current: processed,
            total: progressTotal,
            cached,
            message: `${issue.key} · ${safeName}`
          });
        } catch (_err) {
          // Ignore individual media failures and continue.
          send({
            type: 'progress',
            current: processed,
            total: progressTotal,
            cached,
            message: `Skipped one file from ${issue.key}`
          });
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
    const grouping = ['epic', 'person'].includes(payload.grouping) ? payload.grouping : 'none';
    const mediaOrganize = ['issue', 'epic', 'person'].includes(payload.mediaOrganize) ? payload.mediaOrganize : 'none';
    const format = payload.format === 'pdf' ? 'pdf' : 'html';
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

    const mediaSubfolderFor = (item) => {
      if (mediaOrganize === 'issue') return sanitize(item.issueKey);
      if (mediaOrganize === 'epic') return sanitize(item.epicKey ? `${item.epicKey} ${item.epicSummary || ''}`.trim() : 'No Epic');
      if (mediaOrganize === 'person') return sanitize(item.assigneeName || 'Unassigned');
      return '';
    };

    const copiedItems = [];
    for (const item of selected) {
      const ext = path.extname(item.fileName || '') || (item.mimeType.startsWith('video/') ? '.mp4' : '.jpg');
      const base = sanitize(`${item.issueKey}_${path.basename(item.fileName || 'media', ext)}`);
      const subfolder = mediaSubfolderFor(item);
      const destDir = subfolder ? path.join(mediaDir, subfolder) : mediaDir;
      await fsp.mkdir(destDir, { recursive: true });
      const dest = await uniquePath(destDir, `${base}${ext}`);
      await fsp.copyFile(item.localPath, dest);
      const relFile = subfolder ? `${subfolder}/${path.basename(dest)}` : path.basename(dest);
      copiedItems.push({ ...item, reportMediaFile: relFile });
    }

    const accomplishedNotes = String(payload.accomplishedNotes || '').trim();
    const todoNotes = String(payload.todoNotes || '').trim();

    const byIssueGlobal = new Map();
    for (const item of copiedItems) {
      if (!byIssueGlobal.has(item.issueKey)) {
        byIssueGlobal.set(item.issueKey, {
          issueKey: item.issueKey,
          issueSummary: item.issueSummary || '',
          issueDescription: item.issueDescription || '',
          status: item.status || 'Unknown',
          epicKey: item.epicKey || '',
          epicSummary: item.epicSummary || '',
          assigneeName: item.assigneeName || 'Unassigned',
          media: []
        });
      }
      byIssueGlobal.get(item.issueKey).media.push({
        fileName: item.fileName,
        mimeType: item.mimeType || '',
        bytes: item.bytes || 0,
        reportMediaFile: item.reportMediaFile
      });
    }

    const issuesData = [...byIssueGlobal.values()];

    const projects = parseProjectKeys(payload.projectKey || '').join(', ');
    const dateLine = [payload.dateFrom || 'Any start', payload.dateTo || 'Any end'].join(' to ');
    const manualAccomplished = accomplishedNotes
      ? `<section class="manual-notes"><h3>Project Accomplishments (Manual Notes)</h3><p>${escapeHtml(accomplishedNotes).replace(/\n/g, '<br/>')}</p></section>`
      : '';
    const manualTodo = todoNotes
      ? `<section class="manual-notes"><h3>Project Remaining Work (Manual Notes)</h3><p>${escapeHtml(todoNotes).replace(/\n/g, '<br/>')}</p></section>`
      : '';

    // Embed the issue/media data as JSON so the report can regroup itself
    // client-side (no grouping/epic/person/none) without needing a server.
    const dataJson = JSON.stringify(issuesData).replace(/</g, '\\u003c');

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
    .hero-controls { margin-top: 14px; display: flex; align-items: center; gap: 8px; }
    .hero-controls label { color: #ede9fe; font-size: 13px; }
    .hero-controls select { font: inherit; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.4); background: rgba(255,255,255,0.12); color: #fff; }
    .hero-controls select option { color: #111827; }
    .no-print { }
    @media print { .no-print { display: none !important; } }
    .manual-notes, .group { background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; padding: 18px; margin-top: 18px; }
    .group h3 { margin: 0 0 12px; }
    .summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .summary-grid h5 { margin: 0 0 8px; font-size: 14px; color: #374151; }
    ul { margin: 0; padding-left: 18px; }
    .issue-block { border-top: 1px solid #e5e7eb; padding-top: 14px; margin-top: 14px; }
    .issue-block h4 { margin: 0 0 8px; }
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
      <div class="hero-controls no-print">
        <label for="groupSelect">Group by:</label>
        <select id="groupSelect">
          <option value="none">No grouping</option>
          <option value="epic">Epic</option>
          <option value="person">Person</option>
        </select>
      </div>
    </header>
    ${manualAccomplished}
    ${manualTodo}
    <div id="groupBlocks"></div>
  </div>
  <script id="report-data" type="application/json">${dataJson}</script>
  <script>
    (function () {
      function escapeHtml(s) {
        return String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }
      function formatBytes(bytes) {
        if (!bytes) return '0 B';
        var units = ['B', 'KB', 'MB', 'GB', 'TB'];
        var i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
      }
      function isDoneStatus(name) {
        return /(done|closed|resolved|complete|completed)/i.test(name || '');
      }

      var issues = JSON.parse(document.getElementById('report-data').textContent);

      function renderIssueBlock(issue) {
        var descText = (issue.issueDescription || '').trim();
        var desc = descText ? '<p class="desc">' + escapeHtml(descText).replace(/\\n/g, '<br/>') + '</p>' : '';
        var mediaHtml = issue.media.map(function (m) {
          var src = 'media/' + m.reportMediaFile.split('/').map(encodeURIComponent).join('/');
          var meta = escapeHtml(m.fileName) + ' · ' + formatBytes(m.bytes || 0);
          if ((m.mimeType || '').indexOf('video/') === 0) {
            return '<figure class="media-card"><video controls preload="metadata" src="' + src + '"></video><figcaption>' + meta + '</figcaption></figure>';
          }
          return '<figure class="media-card"><img loading="lazy" src="' + src + '" alt="' + escapeHtml(m.fileName) + '"/><figcaption>' + meta + '</figcaption></figure>';
        }).join('');

        return '<article class="issue-block"><h4>' + escapeHtml(issue.issueKey) + ' · ' + escapeHtml(issue.issueSummary || '') + '</h4>' +
          desc + '<div class="media-grid">' + mediaHtml + '</div></article>';
      }

      function buildProgressSummary(issuesInGroup) {
        var accomplished = issuesInGroup.filter(function (i) { return isDoneStatus(i.status); })
          .map(function (i) { return '<li><strong>' + escapeHtml(i.issueKey) + ':</strong> ' + escapeHtml(i.issueSummary || '') + '</li>'; })
          .join('');
        var pending = issuesInGroup.filter(function (i) { return !isDoneStatus(i.status); })
          .map(function (i) { return '<li><strong>' + escapeHtml(i.issueKey) + ':</strong> ' + escapeHtml(i.issueSummary || '') + '</li>'; })
          .join('');
        if (!accomplished && !pending) return '';
        var a = accomplished ? '<div><h5>Accomplished</h5><ul>' + accomplished + '</ul></div>' : '';
        var p = pending ? '<div><h5>Yet To Be Accomplished</h5><ul>' + pending + '</ul></div>' : '';
        return '<div class="summary-grid">' + a + p + '</div>';
      }

      function render(mode) {
        var html = '';
        if (mode === 'epic') {
          var groups = new Map();
          issues.forEach(function (issue) {
            var key = issue.epicKey ? (issue.epicKey + ' ' + (issue.epicSummary || '')).trim() : 'Additional Tasks';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(issue);
          });
          groups.forEach(function (issuesInGroup, groupName) {
            html += '<section class="group"><h3>' + escapeHtml(groupName) + '</h3>' +
              buildProgressSummary(issuesInGroup) +
              issuesInGroup.map(renderIssueBlock).join('') + '</section>';
          });
        } else if (mode === 'person') {
          var byPerson = new Map();
          issues.forEach(function (issue) {
            var key = issue.assigneeName || 'Unassigned';
            if (!byPerson.has(key)) byPerson.set(key, []);
            byPerson.get(key).push(issue);
          });
          byPerson.forEach(function (issuesInGroup, groupName) {
            html += '<section class="group"><h3>' + escapeHtml(groupName) + '</h3>' +
              buildProgressSummary(issuesInGroup) +
              issuesInGroup.map(renderIssueBlock).join('') + '</section>';
          });
        } else {
          html += '<section class="group">' + buildProgressSummary(issues) + issues.map(renderIssueBlock).join('') + '</section>';
        }
        document.getElementById('groupBlocks').innerHTML = html;
      }

      var select = document.getElementById('groupSelect');
      select.value = ${JSON.stringify(grouping)};
      select.addEventListener('change', function () { render(select.value); });
      render(select.value);
    })();
  </script>
</body>
</html>`;

    const reportPath = path.join(rootDir, 'index.html');
    await fsp.writeFile(reportPath, html, 'utf8');

    let pdfPath = null;
    if (format === 'pdf') {
      const pdfWin = new BrowserWindow({
        show: false,
        webPreferences: { offscreen: true }
      });
      try {
        await pdfWin.loadFile(reportPath);
        const pdfBuffer = await pdfWin.webContents.printToPDF({
          printBackground: true,
          pageSize: 'Letter',
          preferCSSPageSize: false
        });
        pdfPath = path.join(rootDir, 'report.pdf');
        await fsp.writeFile(pdfPath, pdfBuffer);
      } finally {
        pdfWin.destroy();
      }
    }

    return {
      ok: true,
      reportPath,
      pdfPath,
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
  const groupBy = ['issue', 'epic', 'person', 'none'].includes(payload.groupBy)
    ? payload.groupBy
    : (payload.groupByIssue === false ? 'none' : 'issue');

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
      url.searchParams.set('fields', 'attachment,key,summary,parent,issuetype,assignee');
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
          const parent = issue.fields && issue.fields.parent;
          const parentIssueType = parent && parent.fields && parent.fields.issuetype && parent.fields.issuetype.name;
          issues.push({
            key: issue.key,
            summary: (issue.fields && issue.fields.summary) || '',
            epicKey: parentIssueType === 'Epic' ? parent.key : '',
            epicSummary: parentIssueType === 'Epic' && parent.fields ? (parent.fields.summary || '') : '',
            assigneeName: assigneeName(issue),
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
        allAttachments.push({
          issueKey: issue.key,
          epicKey: issue.epicKey,
          epicSummary: issue.epicSummary,
          assigneeName: issue.assigneeName,
          att
        });
      }
    }

    const total = allAttachments.length;
    const attachmentPaths = new Map();

    if (total === 0) {
      let markdownPath = null;
      if (payload.generateMarkdown) {
        const md = await buildMarkdownExport({ base, auth, projects, dateFrom, dateTo, attachmentPaths, send });
        if (md.markdown) {
          markdownPath = path.join(rootDir, sanitize(`${label} metadata`) + '.md');
          await fsp.writeFile(markdownPath, md.markdown, 'utf8');
        }
      }
      return { ok: true, total: 0, downloaded: 0, failed: 0, rootDir, markdownPath };
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
      const { issueKey, epicKey, epicSummary, assigneeName: personName, att } = allAttachments[i];
      let targetDir = rootDir;
      if (projects.length > 1) targetDir = path.join(targetDir, sanitize(projectOf(issueKey)));
      if (groupBy === 'issue') targetDir = path.join(targetDir, sanitize(issueKey));
      else if (groupBy === 'epic') targetDir = path.join(targetDir, sanitize(epicKey ? `${epicKey} ${epicSummary || ''}`.trim() : 'No Epic'));
      else if (groupBy === 'person') targetDir = path.join(targetDir, sanitize(personName || 'Unassigned'));
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
        attachmentPaths.set(String(att.id), path.relative(rootDir, destPath).split(path.sep).join('/'));
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

    let markdownPath = null;
    if (payload.generateMarkdown && !cancelRequested) {
      const md = await buildMarkdownExport({ base, auth, projects, dateFrom, dateTo, attachmentPaths, send });
      if (md.error) {
        send({ type: 'status', message: `Markdown export failed: ${md.error}` });
      } else if (md.markdown) {
        markdownPath = path.join(rootDir, sanitize(`${label} metadata`) + '.md');
        await fsp.writeFile(markdownPath, md.markdown, 'utf8');
        send({ type: 'status', message: `Markdown export written for ${md.issueCount} issue(s).` });
      }
    }

    return { ok: true, total, downloaded, failed, bytes, bytesLabel: formatBytes(bytes), rootDir, markdownPath };
  } catch (err) {
    return { ok: false, error: err.message, rootDir };
  }
});
