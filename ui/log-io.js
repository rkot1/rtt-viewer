// Log import/export — JSON, CSV, plain text

import { state, rebuild, appendEntry, clearLogs, esc } from './log-engine.js';

const invoke = window.__TAURI__.core.invoke;

let save, open_;
try {
    const dialog = window.__TAURI__.dialog;
    save = dialog?.save;
    open_ = dialog?.open;
} catch (_) { }

// ── Format definitions ──

const FORMATS = {
    json: { name: 'JSON', ext: 'json', mime: 'application/json' },
    csv: { name: 'CSV', ext: 'csv', mime: 'text/csv' },
    txt: { name: 'Plain Text', ext: 'txt', mime: 'text/plain' },
};

// ── Export ──

function logsToJSON(logs) {
   return JSON.stringify(logs.map(({ raw, ...rest }) => rest), null, 2);
}

function logsToCSV(logs) {
    const columns = ['id', 'terminal', 'device_timestamp', 'level', 'tag', 'message'];
    const escCSV = (v) => {
        if (v == null) return '';
        const s = String(v);
        return s.includes(',') || s.includes('"') || s.includes('\n')
            ? '"' + s.replace(/"/g, '""') + '"'
            : s;
    };
    const header = columns.join(',');
    const rows = logs.map(e =>
        columns.map(c => escCSV(e[c])).join(',')
    );
    return [header, ...rows].join('\n');
}

function logsToText(logs) {
    return logs.map(e => {
        const parts = [];
        if (e.id != null) parts.push(String(e.id).padStart(5));
        if (e.terminal != null) parts.push(`T${e.terminal}`);
        if (e.device_timestamp) parts.push(e.device_timestamp);
        parts.push(`[${(e.level || 'raw').toUpperCase().substring(0, 3)}]`);
        if (e.tag) parts.push(`<${e.tag}>`);
        parts.push(e.message || e.raw || '');
        return parts.join(' ');
    }).join('\n');
}

const serializers = { json: logsToJSON, csv: logsToCSV, txt: logsToText };

export async function exportLogs(format = 'json') {
    const fmt = FORMATS[format];
    if (!fmt) throw new Error(`Unknown format: ${format}`);

    const logs = state.logs;
    if (logs.length === 0) {
        alert('No logs to export');
        return;
    }

    const content = serializers[format](logs);
    const defaultName = `rtt-logs-${timestamp()}.${fmt.ext}`;

    if (save) {
        const path = await save({
            defaultPath: defaultName,
            filters: [{ name: fmt.name, extensions: [fmt.ext] }],
        });
        if (!path) return;
        await invoke('write_text_file', { path, contents: content });
    } else {
        downloadBlob(content, defaultName, fmt.mime);
    }
}

// ── Import ──

function parseJSON(text) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error('Expected a JSON array');
    return arr.map(normalize);
}

function parseCSV(text) {
    const lines = splitCSVLines(text);
    if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row');

    const header = parseCSVRow(lines[0]);
    return lines.slice(1)
        .filter(l => l.trim())
        .map(line => {
            const vals = parseCSVRow(line);
            const obj = {};
            header.forEach((col, i) => { obj[col] = vals[i] ?? ''; });
            return normalize(obj);
        });
}

function parseText(text) {
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rttPrefix = /^(\d{2})>\s(.*)$/;
  
  let id = 0;
  return text.split('\n')
    .filter(l => l.trim())
    .map(line => {
      let terminal = 0;
      let content = line;

      // Strip RTT terminal prefix
      const pm = line.match(rttPrefix);
      if (pm) {
        terminal = parseInt(pm[1]);
        content = pm[2];
      }

      // Try Zephyr format: [00:29:56.296,813] <inf> ble_manager: IU 3 ON
      const zephyr = /^\[(\d{2}:\d{2}:\d{2}\.\d{3}(?:,\d{3})?)\]\s*<(\w+)>\s*([\w._-]+):\s*(.*)$/;
      const zm = content.match(zephyr);
      if (zm) {
        return normalize({
          id: id++,
          terminal,
          device_timestamp: zm[1],
          level: zm[2],
          tag: zm[3],
          message: zm[4],
          raw: line,
        });
      } 

      // Try generic tagged: <NetCore>Cannot notify mesh RX...
      const tagged = /^<(\w+)>(.*)$/;
      const tm = content.match(tagged);
      if (tm) {
        return normalize({
          id: id++,
          terminal,
          level: 'raw',
          tag: tm[1],
          message: tm[2].trim(),
          raw: line,
        });
      }

      // Try: SEQ  Tn  TIMESTAMP  [LVL]  <TAG>  message (re-import of our own export)
      const re = /^\s*(\d+)?\s*(?:T(\d+))?\s*([\d:.,]+)?\s*\[(\w+)\]\s*(?:<([^>]+)>)?\s*(.*)$/;
      const m = content.match(re);
      if (m) {
        return normalize({
          id: m[1] ? parseInt(m[1]) : id++,
          terminal: m[2] ? parseInt(m[2]) : terminal,
          device_timestamp: m[3] || null,
          level: m[4],
          tag: m[5] || null,
          message: m[6] || '',
          raw: line,
        });
      }

      // Fallback: raw line
      return normalize({ id: id++, terminal, level: 'raw', message: content, raw: line });
    });
}

const parsers = { json: parseJSON, csv: parseCSV, txt: parseText };

export async function importLogs(format, logArea, callbacks = {}) {
    let text;


    if (open_) {
        const path = await open_({
            multiple: false,
            filters: format
                ? [{ name: FORMATS[format].name, extensions: [FORMATS[format].ext] }]
                : [
                    { name: 'All Log Formats', extensions: ['json', 'csv', 'txt', 'log'] },
                    { name: 'JSON', extensions: ['json'] },
                    { name: 'CSV', extensions: ['csv'] },
                    { name: 'Plain Text', extensions: ['txt', 'log'] },
                ],
        });
        console.log('Dialog returned path:', path);
        if (!path) return;
        text = await invoke('read_text_file', { path });
        console.log('Read file, length:', text?.length);
        if (!format) format = detectFormat(path, text);
    } else {
        console.log('Falling back to web file picker');
        text = await pickFileWeb();
        if (!text) return;
        if (!format) format = detectFormatFromContent(text);
    }

    const parser = parsers[format];
    if (!parser) throw new Error(`Unknown format: ${format}`);

    let entries;
    try {
        entries = parser(text);
    } catch (e) {
        alert(`Failed to parse ${format.toUpperCase()}: ${e.message}`);
        return;
    }

    if (entries.length === 0) {
        alert('No log entries found in file');
        return;
    }

    // Clear existing and load
    clearLogs(logArea);

    // Bulk load — add to state without rendering each one
    let newTags = false, newTerminals = false;
    for (const e of entries) {
        state.logs.push(e);
        if (e.tag && !state.tags.has(e.tag)) {
            state.tags.add(e.tag);
            newTags = true;
        }
        const termId = e.terminal ?? 0;
        if (!state.terminals.has(termId)) {
            state.terminals.set(termId, 0);
            newTerminals = true;
        }
        state.terminals.set(termId, state.terminals.get(termId) + 1);
    }

    // Single DOM rebuild at the end
    rebuild(logArea);

    if (callbacks.onTagsChanged && newTags) callbacks.onTagsChanged();
    if (callbacks.onTerminalsChanged && newTerminals) callbacks.onTerminalsChanged();
    if (callbacks.onCountChanged) callbacks.onCountChanged();

    return entries.length;
}

// ── Helpers ──

function normalize(obj) {
    const level = (obj.level || 'raw').toLowerCase();
    return {
        id: obj.id != null ? Number(obj.id) : state.logs.length,
        terminal: obj.terminal != null ? Number(obj.terminal) : 0,
        device_timestamp: obj.device_timestamp || null,
        level: ['error', 'warn', 'info', 'debug', 'raw'].includes(level) ? level : 'raw',
        tag: obj.tag || null,
        message: obj.message || obj.raw || '',
        raw: obj.raw || obj.message || '',
    };
}

function levelFromAbbrev(s) {
    if (!s) return 'raw';
    const l = s.toLowerCase();
    if (l.startsWith('err')) return 'error';
    if (l.startsWith('wrn') || l.startsWith('war')) return 'warn';
    if (l.startsWith('inf')) return 'info';
    if (l.startsWith('dbg') || l.startsWith('deb')) return 'debug';
    return 'raw';
}

function detectFormat(path, _text) {
    const ext = path.split('.').pop().toLowerCase();
    if (ext === 'json') return 'json';
    if (ext === 'csv') return 'csv';
    return 'txt';
}

function detectFormatFromContent(text) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try { JSON.parse(trimmed); return 'json'; } catch (_) { }
    }
    // Check if first line looks like CSV header
    const firstLine = trimmed.split('\n')[0];
    if (firstLine.includes('id,') && firstLine.includes('level')) return 'csv';
    return 'txt';
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
}

function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function pickFileWeb() {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,.csv,.txt,.log';
        input.onchange = async () => {
            if (!input.files[0]) return resolve(null);
            resolve(await input.files[0].text());
        };
        input.click();
    });
}

// CSV parsing with proper quote handling
function splitCSVLines(text) {
    const lines = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
            current += ch;
        } else if (ch === '\n' && !inQuotes) {
            lines.push(current);
            current = '';
        } else if (ch === '\r' && !inQuotes) {
            // skip
        } else {
            current += ch;
        }
    }
    if (current) lines.push(current);
    return lines;
}

function parseCSVRow(line) {
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === ',' && !inQuotes) {
            values.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    values.push(current);
    return values;
}