const TAG_COLORS = ['#79c0ff', '#7ee787', '#ffa657', '#ff7b72', '#d2a8ff', '#56d4dd', '#f778ba', '#e3b341', '#a5d6ff', '#ffd8b5'];
const TERMINAL_COLORS = ['#7ee787', '#79c0ff', '#ffa657', '#d2a8ff', '#56d4dd', '#f778ba', '#e3b341', '#ff7b72'];
const tagColorMap = {};
let colorIdx = 0;

export function tagColor(t) {
    if (!tagColorMap[t]) tagColorMap[t] = TAG_COLORS[colorIdx++ % TAG_COLORS.length];
    return tagColorMap[t];
}

export function terminalColor(n) {
    return TERMINAL_COLORS[n % TERMINAL_COLORS.length];
}

export const state = {
    logs: [],
    tags: new Set(),
    activeTags: new Set(),
    excludedTags: new Set(),
    enabledLevels: new Set(['error', 'warn', 'info', 'debug', 'raw']),
    searchRe: null,
    autoScroll: true,
    terminals: new Map(), // id -> count
    activeTerminals: null, // null = all, Set = specific
    searchMode: 'find',    // 'find' | 'regex' | 'filter'
    searchMatches: [],      // indices into logs[]
    searchCurrent: -1,      // index into searchMatches[]
};

export function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function matches(e) {
    if (!state.enabledLevels.has(e.level)) return false;
    if (e.tag && state.excludedTags.has(e.tag)) return false;
    if (state.activeTags.size > 0 && !state.activeTags.has(e.tag)) return false;
    if (state.searchMode === 'filter' && state.searchRe && !state.searchRe.test(e.raw)) return false;
    if (state.activeTerminals !== null) {
        const t = e.terminal ?? 0;
        if (!state.activeTerminals.has(t)) return false;
    }
    return true;
}

export function renderLine(e) {
    let msg = esc(e.message);
    if (state.searchRe) msg = msg.replace(state.searchRe, '<span class="hl">$&</span>');
    const c = e.tag ? tagColor(e.tag) : '#666';
    const tagH = e.tag
        ? `<span class="tag" style="background:${c}18;color:${c}">${esc(e.tag)}</span>`
        : '<span class="tag"></span>';
    const ts = e.device_timestamp
        ? `<span class="ts">${esc(e.device_timestamp)}</span>`
        : '<span class="ts"></span>';
    const termId = e.terminal ?? 0;
    const tc = terminalColor(termId);
    const termH = `<span class="term" style="color:${tc}">${termId}</span>`;

    const isMatch = state.searchMode !== 'filter' && state.searchMatches.includes(e.id);
    const isCurrent = isMatch && state.searchMatches[state.searchCurrent] === e.id;
    let cls = `log-line level-${e.level}`;
    if (isMatch) cls += ' search-match';
    if (isCurrent) cls += ' search-current';

    return `<div class="${cls}" data-id="${e.id}"><span class="seq">${e.id}</span>${termH}${ts}<span class="lvl ${e.level}">${e.level.substring(0, 3)}</span>${tagH}<span class="msg">${msg}</span></div>`;
}

export function updateSearchMatches() {
  state.searchMatches = [];
  state.searchCurrent = -1;
  if (!state.searchRe || state.searchMode === 'filter') return;
  for (const e of state.logs) {
    if (matches(e) && state.searchRe.test(e.raw || e.message)) {
      state.searchMatches.push(e.id);
    }
  }
}

export function setSearchMode(mode) {
  state.searchMode = mode;
}

export function rebuild(logArea) {
    logArea.innerHTML = state.logs.filter(matches).map(renderLine).join('') || '<div class="empty">No matching logs</div>';
    if (state.autoScroll) logArea.scrollTop = logArea.scrollHeight;
}

export function appendEntry(e, logArea) {
    state.logs.push(e);
    const isNewTag = e.tag && !state.tags.has(e.tag);
    if (e.tag) state.tags.add(e.tag);

    let isNewTerminal = false;
    const termId = e.terminal ?? 0;
    if (!state.terminals.has(termId)) {
        state.terminals.set(termId, 0);
        isNewTerminal = true;
    }
    state.terminals.set(termId, state.terminals.get(termId) + 1);

    if (matches(e)) {
        const empty = logArea.querySelector('.empty');
        if (empty) empty.remove();
        logArea.insertAdjacentHTML('beforeend', renderLine(e));
        if (state.autoScroll) logArea.scrollTop = logArea.scrollHeight;
    }

    return { isNewTag, isNewTerminal };
}

export function clearLogs(logArea) {
  state.logs = [];
  state.tags.clear();
  state.activeTags.clear();
  state.excludedTags.clear();
  state.terminals.clear();
  state.activeTerminals = null;
  state.searchRe = null;
  state.searchMatches = [];
  state.searchCurrent = -1;
  logArea.innerHTML = '<div class="empty">Cleared</div>';
}

export function setSearch(val) {
    try {
        state.searchRe = val ? new RegExp(val, 'gi') : null;
    } catch {
        state.searchRe = null;
    }
}