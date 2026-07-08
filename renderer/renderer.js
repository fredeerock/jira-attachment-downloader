const $ = (id) => document.getElementById(id);

const els = {
  site: $('site'),
  email: $('email'),
  token: $('token'),
  project: $('project'),
  dateFrom: $('dateFrom'),
  dateTo: $('dateTo'),
  folder: $('folder'),
  groupByIssue: $('groupByIssue'),
  testBtn: $('testBtn'),
  testResult: $('testResult'),
  folderBtn: $('folderBtn'),
  downloadBtn: $('downloadBtn'),
  cancelBtn: $('cancelBtn'),
  progressBar: $('progressBar'),
  counter: $('counter'),
  currentItem: $('currentItem'),
  log: $('log'),
  tokenLink: $('tokenLink')
};

const STORAGE_KEY = 'jira-downloader-settings';

// ---- Persist non-secret settings locally ----
function saveSettings() {
  const data = {
    site: els.site.value,
    email: els.email.value,
    project: els.project.value,
    dateFrom: els.dateFrom.value,
    dateTo: els.dateTo.value,
    folder: els.folder.value,
    groupByIssue: els.groupByIssue.checked
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (_) {}
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    els.site.value = data.site || '';
    els.email.value = data.email || '';
    els.project.value = data.project || '';
    els.dateFrom.value = data.dateFrom || '';
    els.dateTo.value = data.dateTo || '';
    els.folder.value = data.folder || '';
    els.groupByIssue.checked = data.groupByIssue !== false;
  } catch (_) {}
}

['site', 'email', 'project', 'dateFrom', 'dateTo'].forEach((id) => {
  els[id].addEventListener('input', saveSettings);
});
els.groupByIssue.addEventListener('change', saveSettings);

// ---- Logging ----
function log(message, kind) {
  const line = document.createElement('div');
  if (kind) line.className = kind;
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;
  els.log.appendChild(line);
  els.log.scrollTop = els.log.scrollHeight;
}

function creds() {
  return {
    site: els.site.value.trim(),
    email: els.email.value.trim(),
    token: els.token.value.trim()
  };
}

// ---- Test connection ----
els.testBtn.addEventListener('click', async () => {
  els.testResult.className = 'status-line load';
  els.testResult.textContent = 'Testing…';
  els.testBtn.disabled = true;
  try {
    const result = await window.api.testConnection(creds());
    if (result.ok) {
      els.testResult.className = 'status-line ok';
      els.testResult.textContent = `Connected as ${result.displayName} ✓`;
    } else {
      els.testResult.className = 'status-line err';
      els.testResult.textContent = result.error;
    }
  } catch (err) {
    els.testResult.className = 'status-line err';
    els.testResult.textContent = err.message;
  } finally {
    els.testBtn.disabled = false;
  }
});

// ---- Pick folder ----
els.folderBtn.addEventListener('click', async () => {
  const folder = await window.api.pickFolder();
  if (folder) {
    els.folder.value = folder;
    saveSettings();
  }
});

// ---- Download ----
function setBusy(busy) {
  els.downloadBtn.disabled = busy;
  els.testBtn.disabled = busy;
  els.folderBtn.disabled = busy;
  els.cancelBtn.classList.toggle('hidden', !busy);
}

function validate() {
  const c = creds();
  if (!c.site || !c.email || !c.token) return 'Fill in your Jira site, email and API token.';
  if (!els.project.value.trim()) return 'Enter at least one project key.';
  if (!els.folder.value.trim()) return 'Choose a download folder.';
  const from = els.dateFrom.value;
  const to = els.dateTo.value;
  if (from && to && from > to) return 'The "from" date is after the "to" date.';
  return null;
}

els.downloadBtn.addEventListener('click', async () => {
  const error = validate();
  if (error) {
    log(error, 'err');
    els.currentItem.textContent = error;
    return;
  }

  els.log.innerHTML = '';
  els.progressBar.style.width = '0%';
  els.counter.textContent = '';
  els.currentItem.textContent = 'Starting…';
  setBusy(true);

  const c = creds();
  const payload = {
    ...c,
    projectKey: els.project.value.trim(),
    dateFrom: els.dateFrom.value,
    dateTo: els.dateTo.value,
    outputDir: els.folder.value.trim(),
    groupByIssue: els.groupByIssue.checked
  };

  log(`Starting download for project ${payload.projectKey}…`, 'info');

  const removeListener = window.api.onProgress((data) => {
    if (data.type === 'status') {
      els.currentItem.textContent = data.message;
    } else if (data.type === 'begin') {
      log(data.message, 'info');
      els.counter.textContent = `0 / ${data.total}`;
    } else if (data.type === 'progress') {
      const pct = Math.round((data.current / data.total) * 100);
      els.progressBar.style.width = `${pct}%`;
      els.counter.textContent = `${data.current} / ${data.total} · ${data.bytesLabel}`;
      els.currentItem.textContent = data.message;
      log(data.message, data.error ? 'err' : 'ok');
    }
  });

  try {
    const result = await window.api.startDownload(payload);
    if (result.cancelled) {
      els.currentItem.textContent = 'Cancelled.';
      log(`Cancelled after ${result.downloaded || 0} file(s).`, 'err');
    } else if (result.ok) {
      if (result.total === 0) {
        els.currentItem.textContent = 'No attachments found in this project.';
        els.progressBar.style.width = '100%';
        log('No attachments found.', 'info');
      } else {
        els.progressBar.style.width = '100%';
        els.currentItem.textContent =
          `Done — ${result.downloaded} downloaded, ${result.failed} failed (${result.bytesLabel}).`;
        log(`Finished: ${result.downloaded} downloaded, ${result.failed} failed.`, 'ok');
      }
      if (result.rootDir) {
        log('Saved to: ' + result.rootDir, 'info');
        window.api.openFolder(result.rootDir);
      }
    } else {
      els.currentItem.textContent = result.error || 'Something went wrong.';
      log(result.error || 'Something went wrong.', 'err');
    }
  } catch (err) {
    els.currentItem.textContent = err.message;
    log(err.message, 'err');
  } finally {
    removeListener();
    setBusy(false);
  }
});

els.cancelBtn.addEventListener('click', () => {
  window.api.cancelDownload();
  els.currentItem.textContent = 'Cancelling…';
});

els.tokenLink.addEventListener('click', () => {
  window.api.openExternal('https://id.atlassian.com/manage-profile/security/api-tokens');
});

loadSettings();
