const $ = (id) => document.getElementById(id);

const els = {
  site: $('site'),
  email: $('email'),
  token: $('token'),
  project: $('project'),
  loadProjectsBtn: $('loadProjectsBtn'),
  projectsStatus: $('projectsStatus'),
  projectsPanel: $('projectsPanel'),
  projectFilter: $('projectFilter'),
  projectsList: $('projectsList'),
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
  tokenLink: $('tokenLink'),
  preloadMediaBtn: $('preloadMediaBtn'),
  selectAllMediaBtn: $('selectAllMediaBtn'),
  clearMediaBtn: $('clearMediaBtn'),
  mediaStatus: $('mediaStatus'),
  mediaList: $('mediaList'),
  loadMoreMediaBtn: $('loadMoreMediaBtn'),
  reportTitle: $('reportTitle'),
  reportGrouping: $('reportGrouping'),
  accomplishedNotes: $('accomplishedNotes'),
  todoNotes: $('todoNotes'),
  generateReportBtn: $('generateReportBtn')
};

const STORAGE_KEY = 'jira-downloader-settings';

let loadedProjects = [];
let preloadedMedia = [];
let selectedMediaIds = new Set();
let visibleMediaCount = 0;
const MEDIA_BATCH_SIZE = 80;

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---- Persist non-secret settings locally ----
function saveSettings() {
  const data = {
    site: els.site.value,
    email: els.email.value,
    project: els.project.value,
    dateFrom: els.dateFrom.value,
    dateTo: els.dateTo.value,
    folder: els.folder.value,
    groupByIssue: els.groupByIssue.checked,
    reportTitle: els.reportTitle.value,
    reportGrouping: els.reportGrouping.value,
    accomplishedNotes: els.accomplishedNotes.value,
    todoNotes: els.todoNotes.value
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
    els.reportTitle.value = data.reportTitle || '';
    els.reportGrouping.value = data.reportGrouping || 'task';
    els.accomplishedNotes.value = data.accomplishedNotes || '';
    els.todoNotes.value = data.todoNotes || '';
  } catch (_) {}
}

[
  'site', 'email', 'project', 'dateFrom', 'dateTo',
  'reportTitle', 'reportGrouping', 'accomplishedNotes', 'todoNotes'
].forEach((id) => {
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

function buildBasePayload() {
  return {
    ...creds(),
    projectKey: els.project.value.trim(),
    dateFrom: els.dateFrom.value,
    dateTo: els.dateTo.value
  };
}

function validateBaseInputs(requireFolder) {
  const c = creds();
  if (!c.site || !c.email || !c.token) return 'Fill in your Jira site, email and API token.';
  if (!els.project.value.trim()) return 'Enter at least one project key.';
  const from = els.dateFrom.value;
  const to = els.dateTo.value;
  if (from && to && from > to) return 'The "from" date is after the "to" date.';
  if (requireFolder && !els.folder.value.trim()) return 'Choose a download folder.';
  return null;
}

// ---- Project list ----
function getSelectedKeys() {
  return els.project.value
    .split(/[\s,]+/)
    .map((k) => k.trim().toUpperCase())
    .filter(Boolean);
}

function setSelectedKeys(keys) {
  const unique = [...new Set(keys)];
  els.project.value = unique.join(', ');
  saveSettings();
}

function renderProjects() {
  const selected = new Set(getSelectedKeys());
  const filter = els.projectFilter.value.trim().toLowerCase();
  els.projectsList.innerHTML = '';

  const filtered = loadedProjects.filter((p) =>
    !filter ||
    p.key.toLowerCase().includes(filter) ||
    (p.name || '').toLowerCase().includes(filter)
  );

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'projects-empty';
    empty.textContent = loadedProjects.length ? 'No projects match your filter.' : 'No projects found.';
    els.projectsList.appendChild(empty);
    return;
  }

  filtered.forEach((p) => {
    const label = document.createElement('label');
    label.className = 'project-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(p.key.toUpperCase());
    cb.addEventListener('change', () => {
      const keys = new Set(getSelectedKeys());
      if (cb.checked) keys.add(p.key.toUpperCase());
      else keys.delete(p.key.toUpperCase());
      setSelectedKeys([...keys]);
    });

    const key = document.createElement('span');
    key.className = 'pkey';
    key.textContent = p.key;

    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name || '';

    label.append(cb, key, name);
    els.projectsList.appendChild(label);
  });
}

els.loadProjectsBtn.addEventListener('click', async () => {
  els.projectsStatus.className = 'status-line inline-status load';
  els.projectsStatus.textContent = 'Loading…';
  els.loadProjectsBtn.disabled = true;
  try {
    const result = await window.api.listProjects(creds());
    if (result.ok) {
      loadedProjects = result.projects || [];
      els.projectsStatus.className = 'status-line inline-status ok';
      els.projectsStatus.textContent = `${loadedProjects.length} project(s) found`;
      els.projectsPanel.classList.remove('hidden');
      renderProjects();
    } else {
      els.projectsStatus.className = 'status-line inline-status err';
      els.projectsStatus.textContent = result.error;
    }
  } catch (err) {
    els.projectsStatus.className = 'status-line inline-status err';
    els.projectsStatus.textContent = err.message;
  } finally {
    els.loadProjectsBtn.disabled = false;
  }
});

els.projectFilter.addEventListener('input', renderProjects);
els.project.addEventListener('input', () => {
  if (loadedProjects.length) renderProjects();
});

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

els.downloadBtn.addEventListener('click', async () => {
  const error = validateBaseInputs(true);
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

  const payload = {
    ...buildBasePayload(),
    outputDir: els.folder.value.trim(),
    groupByIssue: els.groupByIssue.checked
  };

  log(`Starting download for projects ${payload.projectKey}…`, 'info');

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
        els.currentItem.textContent = 'No attachments found in these projects.';
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

// ---- Report media preload + selection ----
function setReportBusy(busy) {
  els.preloadMediaBtn.disabled = busy;
  els.selectAllMediaBtn.disabled = busy || preloadedMedia.length === 0;
  els.clearMediaBtn.disabled = busy || preloadedMedia.length === 0;
  els.generateReportBtn.disabled = busy || selectedMediaIds.size === 0;
}

function updateMediaActionsEnabled() {
  els.selectAllMediaBtn.disabled = preloadedMedia.length === 0;
  els.clearMediaBtn.disabled = preloadedMedia.length === 0;
  els.generateReportBtn.disabled = selectedMediaIds.size === 0;
}

function renderMediaList() {
  const visible = preloadedMedia.slice(0, visibleMediaCount || MEDIA_BATCH_SIZE);
  els.mediaList.innerHTML = '';

  if (!preloadedMedia.length) {
    const empty = document.createElement('div');
    empty.className = 'media-empty';
    empty.textContent = 'No preloaded media yet. Click "Preload media from selected projects".';
    els.mediaList.appendChild(empty);
    els.loadMoreMediaBtn.classList.add('hidden');
    updateMediaActionsEnabled();
    return;
  }

  visible.forEach((item) => {
    const wrap = document.createElement('div');
    wrap.className = 'media-item';

    const top = document.createElement('label');
    top.className = 'media-check';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedMediaIds.has(item.id);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedMediaIds.add(item.id);
      else selectedMediaIds.delete(item.id);
      updateMediaActionsEnabled();
      els.mediaStatus.className = 'status-line ok';
      els.mediaStatus.textContent = `${selectedMediaIds.size} selected of ${preloadedMedia.length}`;
    });

    const topText = document.createElement('span');
    topText.textContent = `${item.issueKey} · ${item.status}`;

    top.append(cb, topText);

    const src = encodeURI(item.localUri || '');
    let preview;
    if ((item.mimeType || '').startsWith('video/')) {
      preview = document.createElement('div');
      preview.className = 'media-video-placeholder';
      preview.textContent = 'Video file (preview disabled for stability)';
    } else {
      preview = document.createElement('img');
      preview.className = 'media-preview';
      preview.src = src;
      preview.alt = item.fileName || 'image';
      preview.loading = 'lazy';
    }

    const meta = document.createElement('div');
    meta.className = 'media-meta';

    const title = document.createElement('strong');
    title.textContent = item.fileName || 'media';

    const info = document.createElement('span');
    info.textContent = `${item.issueSummary || ''}`;

    const extra = document.createElement('span');
    extra.textContent = `${formatBytes(item.bytes || 0)} · ${item.epicKey ? `Epic ${item.epicKey}` : 'No epic'}`;

    meta.append(title, info, extra);
    wrap.append(top, preview, meta);
    els.mediaList.appendChild(wrap);
  });

  if (visible.length < preloadedMedia.length) {
    els.loadMoreMediaBtn.classList.remove('hidden');
    els.loadMoreMediaBtn.textContent = `Load more media (${visible.length}/${preloadedMedia.length})`;
  } else {
    els.loadMoreMediaBtn.classList.add('hidden');
  }

  updateMediaActionsEnabled();
}

els.loadMoreMediaBtn.addEventListener('click', () => {
  visibleMediaCount = Math.min(preloadedMedia.length, (visibleMediaCount || MEDIA_BATCH_SIZE) + MEDIA_BATCH_SIZE);
  renderMediaList();
  els.mediaStatus.className = 'status-line ok';
  els.mediaStatus.textContent = `Showing ${visibleMediaCount} of ${preloadedMedia.length} media items.`;
});

els.preloadMediaBtn.addEventListener('click', async () => {
  const error = validateBaseInputs(false);
  if (error) {
    els.mediaStatus.className = 'status-line err';
    els.mediaStatus.textContent = error;
    return;
  }

  setReportBusy(true);
  els.mediaStatus.className = 'status-line load';
  els.mediaStatus.textContent = 'Preloading media… this may take a while for large projects.';

  try {
    const result = await window.api.preloadMedia(buildBasePayload());
    if (result.cancelled) {
      els.mediaStatus.className = 'status-line err';
      els.mediaStatus.textContent = 'Preload cancelled.';
      return;
    }
    if (!result.ok) {
      els.mediaStatus.className = 'status-line err';
      els.mediaStatus.textContent = result.error || 'Media preload failed.';
      return;
    }

    preloadedMedia = result.items || [];
    selectedMediaIds = new Set();
    visibleMediaCount = Math.min(preloadedMedia.length, MEDIA_BATCH_SIZE);
    renderMediaList();

    els.mediaStatus.className = 'status-line ok';
    els.mediaStatus.textContent = `Preloaded ${result.preloaded} media files (${result.totalCandidates} found). ${result.truncated ? `Showing first ${result.maxItems} to keep the app stable.` : ''} Select the ones to include.`;
    log(`Preloaded media for report: ${result.preloaded} file(s).`, 'info');
  } catch (err) {
    els.mediaStatus.className = 'status-line err';
    els.mediaStatus.textContent = err.message;
  } finally {
    setReportBusy(false);
  }
});

els.selectAllMediaBtn.addEventListener('click', () => {
  selectedMediaIds = new Set(preloadedMedia.map((i) => i.id));
  renderMediaList();
  els.mediaStatus.className = 'status-line ok';
  els.mediaStatus.textContent = `${selectedMediaIds.size} selected of ${preloadedMedia.length}`;
});

els.clearMediaBtn.addEventListener('click', () => {
  selectedMediaIds = new Set();
  renderMediaList();
  els.mediaStatus.className = 'status-line ok';
  els.mediaStatus.textContent = 'Selection cleared.';
});

els.generateReportBtn.addEventListener('click', async () => {
  const error = validateBaseInputs(true);
  if (error) {
    els.mediaStatus.className = 'status-line err';
    els.mediaStatus.textContent = error;
    return;
  }
  if (selectedMediaIds.size === 0) {
    els.mediaStatus.className = 'status-line err';
    els.mediaStatus.textContent = 'Select at least one media item for the report.';
    return;
  }

  setReportBusy(true);
  els.mediaStatus.className = 'status-line load';
  els.mediaStatus.textContent = 'Generating report…';

  try {
    const result = await window.api.generateReport({
      ...buildBasePayload(),
      outputDir: els.folder.value.trim(),
      reportTitle: els.reportTitle.value.trim() || 'Stakeholder Report',
      grouping: els.reportGrouping.value,
      accomplishedNotes: els.accomplishedNotes.value,
      todoNotes: els.todoNotes.value,
      selectedIds: [...selectedMediaIds],
      mediaItems: preloadedMedia
    });

    if (!result.ok) {
      els.mediaStatus.className = 'status-line err';
      els.mediaStatus.textContent = result.error || 'Report generation failed.';
      return;
    }

    els.mediaStatus.className = 'status-line ok';
    els.mediaStatus.textContent = `Report generated with ${result.mediaCount} media item(s).`;
    log(`Stakeholder report created: ${result.reportPath}`, 'ok');
    if (result.rootDir) window.api.openFolder(result.rootDir);
  } catch (err) {
    els.mediaStatus.className = 'status-line err';
    els.mediaStatus.textContent = err.message;
  } finally {
    setReportBusy(false);
  }
});

els.tokenLink.addEventListener('click', () => {
  window.api.openExternal('https://id.atlassian.com/manage-profile/security/api-tokens');
});

loadSettings();
renderMediaList();
