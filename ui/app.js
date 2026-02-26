// Main app — wires everything together

import { state, rebuild, appendEntry, clearLogs, setSearch, esc, terminalColor, updateSearchMatches, setSearchMode } from './log-engine.js';
import { tagColor } from './log-engine.js';
import * as Profiles from './profiles.js';
import * as LogIO from './log-io.js';

const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

const $ = s => document.querySelector(s);
const logArea = $('#logArea');
const tagbar = $('#tagbar');
const termbar = $('#termbar');
const countEl = $('#count');
const dot = $('#dot');
const searchInput = $('#search');
const btnConnect = $('#btnConnect');
const btnMock = $('#btnMock');
const probeSelect = $('#probeSelect');
const btnRefreshProbes = $('#btnRefreshProbes');
const btnExport = $('#btnExport');
const btnImport = $('#btnImport');


const btnSearchMode = $('#btnSearchMode');
const btnPrev = $('#btnPrev');
const btnNext = $('#btnNext');
const searchInfo = $('#searchInfo');

let source = null;

listen('menu-event', async (e) => {
  const id = e.payload;
  if (id === 'import') {
    try {
      const count = await LogIO.importLogs(null, logArea, {
        onTagsChanged: renderTagbar,
        onTerminalsChanged: renderTermbar,
        onCountChanged: () => { countEl.textContent = state.logs.length; },
      });
      if (count) {
        renderTagbar();
        renderTermbar();
        updateUI();
      }
    } catch (e) { alert('Import failed: ' + e); }
  } else if (id.startsWith('export_')) {
    const format = id.replace('export_', '');
    try {
      await LogIO.exportLogs(format);
    } catch (e) { alert('Export failed: ' + e); }
  }
});

// ── Probe enumeration ──

async function refreshProbes() {
  try {
    btnRefreshProbes.disabled = true;
    btnRefreshProbes.textContent = '…';
    const probes = await invoke('list_probes');
    probeSelect.innerHTML = probes.length === 0
      ? '<option value="">— no probes —</option>'
      : probes.map(p => {
          const label = p.serial ? `${p.name} (${p.serial})` : p.name;
          return `<option value="${p.index}">${esc(label)}</option>`;
        }).join('');
  } catch (e) {
    probeSelect.innerHTML = `<option value="">— error —</option>`;
  } finally {
    btnRefreshProbes.textContent = '⟳';
    btnRefreshProbes.disabled = false;
  }
}

btnRefreshProbes.addEventListener('click', refreshProbes);

// ── UI State ──

function updateUI() {
  if (source === 'rtt') {
    btnConnect.textContent = 'Disconnect';
    btnConnect.className = 'btn red';
    btnMock.disabled = true;
    dot.className = 'dot on';
  } else if (source === 'mock') {
    btnMock.textContent = 'Stop';
    btnMock.className = 'btn red';
    btnConnect.disabled = true;
    dot.className = 'dot mock';
  } else {
    btnConnect.textContent = 'Connect';
    btnConnect.className = 'btn green';
    btnConnect.disabled = false;
    btnMock.textContent = 'Mock';
    btnMock.className = 'btn';
    btnMock.disabled = false;
    dot.className = 'dot';
  }
  countEl.textContent = state.logs.length;
}

// ── Terminal bar ──

function renderTermbar() {
  termbar.classList.add('visible');
  const allActive = state.activeTerminals === null;

  let html = '<span class="termbar-label">Term</span>';
  html += `<span class="term-chip${allActive ? ' active' : ''}" data-term="all" style="color:var(--text)">All</span>`;

  const sorted = Array.from(state.terminals.entries()).sort((a, b) => a[0] - b[0]);
  for (const [id, count] of sorted) {
    const c = terminalColor(id);
    const isActive = !allActive && state.activeTerminals.has(id);
    html += `<span class="term-chip${isActive ? ' active' : ''}" data-term="${id}" style="color:${c}">${id}<span class="term-count">${count}</span></span>`;
  }

  termbar.innerHTML = html;

  termbar.querySelectorAll('.term-chip').forEach(el => {
    el.addEventListener('click', () => {
      const val = el.dataset.term;
      if (val === 'all') {
        state.activeTerminals = null;
      } else {
        const id = parseInt(val);
        if (state.activeTerminals === null) {
          state.activeTerminals = new Set([id]);
        } else if (state.activeTerminals.has(id)) {
          state.activeTerminals.delete(id);
          if (state.activeTerminals.size === 0) state.activeTerminals = null;
        } else {
          state.activeTerminals.add(id);
        }
      }
      renderTermbar();
      rebuild(logArea);
    });
  });
}

// ── Tag bar ──

function renderTagbar() {
  const lh = ['error', 'warn', 'info', 'debug', 'raw'].map(l =>
    `<span class="level-chip${state.enabledLevels.has(l) ? '' : ' off'}" data-level="${l}">${l.substring(0, 3).toUpperCase()}</span>`
  ).join('');

  const th = Array.from(state.tags).sort().map(t => {
    const c = tagColor(t);
    let cls = 'tag-chip';
    if (state.activeTags.has(t)) cls += ' active';
    if (state.excludedTags.has(t)) cls += ' excluded';
    return `<span class="${cls}" data-tag="${esc(t)}" style="color:${c}">${esc(t)}</span>`;
  }).join('');

  tagbar.innerHTML = lh + '<span class="tagbar-sep"></span>' + th;

  tagbar.querySelectorAll('.level-chip').forEach(el => el.addEventListener('click', () => {
    const l = el.dataset.level;
    state.enabledLevels.has(l) ? state.enabledLevels.delete(l) : state.enabledLevels.add(l);
    renderTagbar();
    rebuild(logArea);
  }));

  tagbar.querySelectorAll('.tag-chip').forEach(el => el.addEventListener('click', ev => {
    const t = el.dataset.tag;
    if (ev.altKey || ev.metaKey) {
      state.excludedTags.has(t) ? state.excludedTags.delete(t) : (state.excludedTags.add(t), state.activeTags.delete(t));
    } else {
      state.activeTags.has(t) ? state.activeTags.delete(t) : (state.activeTags.add(t), state.excludedTags.delete(t));
    }
    renderTagbar();
    rebuild(logArea);
  }));
}

// ── Connection ──


btnConnect.addEventListener('click', async () => {
  if (source === 'rtt') {
    await invoke('stop_source');
    source = null;
    updateUI();
    return;
  }
  const prof = Profiles.getSelectedProfile();
  if (!prof) { alert('Select a profile first'); return; }
  const probeIdx = probeSelect.value !== '' ? parseInt(probeSelect.value) : null;
  try {
    await invoke('start_rtt', {
      chip: prof.chip,
      rttAddress: prof.rtt_address || null,
      coreIndex: prof.core || 0,
      probeIndex: probeIdx,
    });
    source = 'rtt';
    updateUI();
  } catch (e) { alert(e); }
});

btnMock.addEventListener('click', async () => {
  if (source === 'mock') {
    await invoke('stop_source');
    source = null;
    updateUI();
    return;
  }
  try {
    await invoke('start_mock');
    source = 'mock';
    updateUI();
  } catch (e) { alert(e); }
});

$('#btnClear').addEventListener('click', () => {
  clearLogs(logArea);
  searchInput.value = '';
  updateSearchInfo();
  renderTagbar();
  renderTermbar();
  updateUI();
});


// btnExport.addEventListener('click', async () => {
//   try {
//     await LogIO.exportLogs($('#exportFormat').value);
//   } catch (e) { alert('Export failed: ' + e); }
// });

// btnImport.addEventListener('click', async () => {
//   try {
//     console.log('Importing logs...');
//     const count = await LogIO.importLogs(null, logArea, {
//       onTagsChanged: renderTagbar,
//       onTerminalsChanged: renderTermbar,
//       onCountChanged: () => { countEl.textContent = state.logs.length; },
//     });
//     console.log(`Imported ${count} logs.`);
//     if (count) {
//       renderTagbar();
//       renderTermbar();
//       updateUI();
//     }
//   } catch (e) { alert('Import failed: ' + e); }
// });

// ── Scroll ──

logArea.addEventListener('scroll', () => {
  state.autoScroll = logArea.scrollHeight - logArea.scrollTop - logArea.clientHeight < 40;
});

// ── Keyboard ──

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
  if (e.key === 'Escape') {
    Profiles.closeModals();
    searchInput.value = '';
    setSearch('');
    searchInput.blur();
    rebuild(logArea);
  }
});

// ── Tauri Events ──

listen('rtt-log', e => {
  const { isNewTag, isNewTerminal } = appendEntry(e.payload, logArea);
  if (isNewTag) renderTagbar();
  if (isNewTerminal) renderTermbar();
  else if (state.terminals.size > 0 && state.logs.length % 50 === 0) renderTermbar();
  countEl.textContent = state.logs.length;
});

listen('rtt-connected', () => { dot.className = 'dot on'; });
listen('rtt-disconnected', () => { source = null; updateUI(); });
listen('rtt-stopped', () => { source = null; updateUI(); });
listen('rtt-error', e => {
  dot.className = 'dot err';
  alert('RTT Error: ' + e.payload);
  source = null;
  updateUI();
});

// -- Search --

const MODES = ['find', 'regex', 'filter'];
const MODE_LABELS = { find: 'Find', regex: 'Regex', filter: 'Filter' };
const MODE_PLACEHOLDERS = { find: 'Find text…', regex: 'Regex search…', filter: 'Filter (regex)…' };

function cycleSearchMode() {
  const idx = (MODES.indexOf(state.searchMode) + 1) % MODES.length;
  setSearchMode(MODES[idx]);
  btnSearchMode.textContent = MODE_LABELS[state.searchMode];
  btnSearchMode.className = state.searchMode === 'filter' ? 'btn active' : 'btn';
  searchInput.placeholder = MODE_PLACEHOLDERS[state.searchMode];
  applySearch();
}

function applySearch() {
  const val = searchInput.value.trim();
  if (state.searchMode === 'find') {
    // Plain text — escape for regex
    try {
      state.searchRe = val ? new RegExp(val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') : null;
    } catch { state.searchRe = null; }
  } else {
    setSearch(val);
  }
  updateSearchMatches();
  rebuild(logArea);
  updateSearchInfo();

  // Auto-jump to first match in find/regex modes
  if (state.searchMatches.length > 0 && state.searchCurrent === -1) {
    state.searchCurrent = 0;
    scrollToCurrentMatch();
  }
}

function updateSearchInfo() {
  if (!state.searchRe || state.searchMode === 'filter') {
    searchInfo.textContent = '';
    return;
  }
  if (state.searchMatches.length === 0) {
    searchInfo.textContent = 'No matches';
    return;
  }
  searchInfo.textContent = `${state.searchCurrent + 1}/${state.searchMatches.length}`;
}

function scrollToCurrentMatch() {
  if (state.searchCurrent < 0 || state.searchCurrent >= state.searchMatches.length) return;
  rebuild(logArea);
  const id = state.searchMatches[state.searchCurrent];
  const el = logArea.querySelector(`[data-id="${id}"]`);
  if (el) {
    el.scrollIntoView({ block: 'center' });
    state.autoScroll = false;
  }
  updateSearchInfo();
}

function navigateMatch(dir) {
  if (state.searchMatches.length === 0) return;
  state.searchCurrent = (state.searchCurrent + dir + state.searchMatches.length) % state.searchMatches.length;
  scrollToCurrentMatch();
}

btnSearchMode.addEventListener('click', cycleSearchMode);
btnPrev.addEventListener('click', () => navigateMatch(-1));
btnNext.addEventListener('click', () => navigateMatch(1));

// Replace the old search debounce:
let debounce;
searchInput.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(applySearch, 150);
});

// Update keyboard handler — add Enter for next match:
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
  if (e.key === 'Enter' && document.activeElement === searchInput) {
    e.preventDefault();
    navigateMatch(e.shiftKey ? -1 : 1);
  }
  if (e.key === 'Escape') {
    Profiles.closeModals();
    searchInput.value = '';
    setSearch('');
    state.searchMatches = [];
    state.searchCurrent = -1;
    searchInput.blur();
    rebuild(logArea);
    updateSearchInfo();
  }
});

// ── Init ──

await Profiles.init();
await refreshProbes();
renderTagbar();
renderTermbar();
updateUI();