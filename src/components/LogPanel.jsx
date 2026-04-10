// src/components/LogPanel.jsx
// Collapsible panel showing recent AI / batch operation logs.
// Toggle with the bug icon button; copy-to-clipboard exports the full log.

import { useState, useEffect, useRef } from 'react';
import { Bug, X, Trash2, Copy, ChevronDown, ChevronUp } from 'lucide-react';
import { subscribeLogs, clearLogs, exportLogsText } from '../lib/logger.js';

const LEVEL_STYLES = {
  debug: { text: 'text-gray-400', badge: 'bg-gray-700 text-gray-300' },
  info:  { text: 'text-blue-300', badge: 'bg-blue-900/60 text-blue-200' },
  warn:  { text: 'text-yellow-300', badge: 'bg-yellow-900/60 text-yellow-200' },
  error: { text: 'text-red-300', badge: 'bg-red-900/60 text-red-200' },
};

function LogEntry({ entry }) {
  const [expanded, setExpanded] = useState(false);
  const style = LEVEL_STYLES[entry.level] || LEVEL_STYLES.info;
  const ts = new Date(entry.ts).toISOString().slice(11, 23); // HH:MM:SS.mmm

  return (
    <div className={`py-1 px-2 border-b border-neutral-800 font-mono text-xs ${entry.level === 'error' ? 'bg-red-950/20' : ''}`}>
      <div className="flex items-start gap-2">
        <span className="text-neutral-500 flex-shrink-0 w-28">{ts}</span>
        <span className={`px-1 rounded text-[10px] font-bold flex-shrink-0 ${style.badge}`}>
          {entry.level.toUpperCase()}
        </span>
        <span className="text-neutral-400 flex-shrink-0">[{entry.category}]</span>
        <span className={`flex-1 break-all ${style.text}`}>{entry.message}</span>
        {entry.data !== null && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="flex-shrink-0 text-neutral-500 hover:text-neutral-300"
          >
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        )}
      </div>
      {expanded && entry.data !== null && (
        <pre className="mt-1 ml-[7.5rem] text-neutral-400 whitespace-pre-wrap break-all text-[10px] bg-neutral-900 rounded p-1">
          {typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function LogPanel() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState([]);
  const [filter, setFilter] = useState('all'); // 'all' | 'error' | 'warn'
  const [errorCount, setErrorCount] = useState(0);
  const bottomRef = useRef(null);

  useEffect(() => {
    return subscribeLogs((all) => {
      setEntries(all);
      setErrorCount(all.filter(e => e.level === 'error').length);
    });
  }, []);

  // Auto-scroll to bottom when new entries arrive (only while open)
  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries, open]);

  const visible = filter === 'all' ? entries
    : filter === 'error' ? entries.filter(e => e.level === 'error')
    : entries.filter(e => e.level === 'warn' || e.level === 'error');

  function copyLogs() {
    navigator.clipboard.writeText(exportLogsText()).catch(() => {});
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 pointer-events-none">
      {/* Toggle button — always visible in bottom-left */}
      <div className="absolute bottom-4 left-4 pointer-events-auto">
        <button
          onClick={() => setOpen(v => !v)}
          title="Toggle log panel"
          className={`
            flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium shadow-lg border
            transition-colors
            ${open
              ? 'bg-neutral-800 border-neutral-600 text-neutral-200'
              : errorCount > 0
                ? 'bg-red-950 border-red-700 text-red-300 animate-pulse'
                : 'bg-neutral-900 border-neutral-700 text-neutral-400 hover:text-neutral-200'
            }
          `}
        >
          <Bug className="w-3.5 h-3.5" />
          Logs
          {errorCount > 0 && (
            <span className="bg-red-600 text-white rounded-full px-1.5 py-0.5 text-[10px] leading-none">
              {errorCount}
            </span>
          )}
        </button>
      </div>

      {/* Log panel — slides up from bottom */}
      {open && (
        <div className="pointer-events-auto mx-0 bg-neutral-950 border-t border-neutral-700 shadow-2xl flex flex-col" style={{ height: '280px' }}>
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-neutral-800 flex-shrink-0">
            <Bug className="w-4 h-4 text-neutral-400" />
            <span className="text-xs font-semibold text-neutral-300">AI Debug Log</span>
            <span className="text-xs text-neutral-500">{entries.length} entries</span>

            {/* Filter tabs */}
            <div className="flex gap-1 ml-2">
              {['all', 'warn', 'error'].map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    filter === f
                      ? 'bg-neutral-700 text-neutral-100'
                      : 'text-neutral-500 hover:text-neutral-300'
                  }`}
                >
                  {f === 'all' ? 'All' : f === 'warn' ? 'Warnings+' : 'Errors'}
                </button>
              ))}
            </div>

            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={copyLogs}
                title="Copy all logs to clipboard"
                className="p-1 rounded hover:bg-neutral-800 text-neutral-500 hover:text-neutral-300"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={clearLogs}
                title="Clear logs"
                className="p-1 rounded hover:bg-neutral-800 text-neutral-500 hover:text-neutral-300"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setOpen(false)}
                className="p-1 rounded hover:bg-neutral-800 text-neutral-500 hover:text-neutral-300"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Log entries */}
          <div className="flex-1 overflow-y-auto">
            {visible.length === 0 ? (
              <div className="flex items-center justify-center h-full text-xs text-neutral-600">
                {entries.length === 0 ? 'No log entries yet. Run a classification to see AI call details.' : 'No entries match the current filter.'}
              </div>
            ) : (
              <>
                {visible.map(entry => (
                  <LogEntry key={entry.id} entry={entry} />
                ))}
                <div ref={bottomRef} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
