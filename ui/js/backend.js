// Thin wrapper over the Tauri bridge. In a plain browser (UI preview) the engine
// commands are unavailable and only the read-only pieces work.
const T = window.__TAURI__;
export const isDesktop = !!T;

const browserFallback = {
  catalog: async () => [
    { id: 'stockfish', name: 'Stockfish', repo: 'official-stockfish/Stockfish', blurb: 'The strongest open-source engine. The best default for analysis.' },
  ],
  list_engines: async () => [],
  system_info: async () => ({ threads: navigator.hardwareConcurrency || 4, args: [] }),
  http_get: async ({ url, accept }) => {
    const r = await fetch(url, { headers: accept ? { Accept: accept } : {} });
    if (r.status === 404) throw 'not-found';
    if (!r.ok) throw `The server answered with status ${r.status}.`;
    return r.text();
  },
  log_line: async ({ line }) => console.log(line),
};

export function invoke(cmd, args) {
  if (T) return T.core.invoke(cmd, args);
  const f = browserFallback[cmd];
  return f ? f(args || {}) : Promise.reject('This only works in the desktop app.');
}

export function listen(event, cb) {
  if (T) return T.event.listen(event, (e) => cb(e.payload));
  return Promise.resolve(() => {});
}
