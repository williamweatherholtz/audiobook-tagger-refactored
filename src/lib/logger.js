// src/lib/logger.js
// Central in-memory log store for AI calls and batch operations.
// Entries are kept in a ring buffer and can be viewed in the LogPanel component.

const MAX_ENTRIES = 1000;

let entries = [];
let nextId = 1;
const listeners = new Set();

function notify() {
  listeners.forEach(fn => fn(entries));
}

/**
 * Add a log entry.
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} category - e.g. 'ClaudeCLI', 'AI', 'Classify'
 * @param {string} message
 * @param {any} [data] - optional structured data (will be JSON-stringified for display)
 */
export function log(level, category, message, data) {
  const entry = {
    id: nextId++,
    ts: Date.now(),
    level,
    category,
    message,
    data: data !== undefined ? data : null,
  };

  if (entries.length >= MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES + 1);
  }
  entries = [...entries, entry];

  // Mirror to browser DevTools console
  const tag = `[${category}] ${message}`;
  if (level === 'error') console.error(tag, data ?? '');
  else if (level === 'warn')  console.warn(tag, data ?? '');
  else                        console.log(tag, data ?? '');

  notify();
}

export const logger = {
  debug: (cat, msg, data) => log('debug', cat, msg, data),
  info:  (cat, msg, data) => log('info',  cat, msg, data),
  warn:  (cat, msg, data) => log('warn',  cat, msg, data),
  error: (cat, msg, data) => log('error', cat, msg, data),
};

/** Subscribe to log updates. Returns an unsubscribe function. */
export function subscribeLogs(fn) {
  listeners.add(fn);
  fn(entries); // immediate call with current state
  return () => listeners.delete(fn);
}

/** Get a snapshot of current log entries. */
export function getLogs() {
  return entries;
}

/** Clear all log entries. */
export function clearLogs() {
  entries = [];
  notify();
}

/** Return the last N error entries as plain text (for copy/paste). */
export function exportLogsText() {
  return entries.map(e => {
    const ts = new Date(e.ts).toISOString().slice(11, 23);
    const data = e.data !== null
      ? '\n  ' + (typeof e.data === 'string' ? e.data : JSON.stringify(e.data, null, 2)).replace(/\n/g, '\n  ')
      : '';
    return `${ts} [${e.level.toUpperCase().padEnd(5)}] [${e.category}] ${e.message}${data}`;
  }).join('\n');
}
