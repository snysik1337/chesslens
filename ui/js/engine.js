// UCI client. One engine process at a time; searches are strictly serialised:
// a new search first stops the running one and waits for its `bestmove`.
import { invoke, listen } from './backend.js';

const MANAGED = new Set(['threads', 'hash', 'multipv', 'ponder', 'uci_chess960']);

function parseOption(line) {
  const m = /^option name (.+?) type (\w+)(.*)$/.exec(line);
  if (!m) return null;
  const [, name, type, rest] = m;
  const opt = { name, type };
  if (type === 'spin') {
    opt.default = Number((/ default (-?\d+)/.exec(rest) || [])[1] ?? 0);
    opt.min = Number((/ min (-?\d+)/.exec(rest) || [])[1] ?? 0);
    opt.max = Number((/ max (-?\d+)/.exec(rest) || [])[1] ?? 0);
  } else if (type === 'check') {
    opt.default = / default true/.test(rest);
  } else if (type === 'combo') {
    opt.default = (/ default (.+?)(?= var |$)/.exec(rest) || [])[1] ?? '';
    opt.vars = [...rest.matchAll(/ var (.+?)(?= var |$)/g)].map((v) => v[1]);
  } else if (type === 'string') {
    const d = (/ default ?(.*)$/.exec(rest) || [])[1] ?? '';
    opt.default = d === '<empty>' ? '' : d;
  }
  return opt;
}

function parseInfo(line) {
  const t = line.split(/\s+/);
  const info = { multipv: 1 };
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth': info.depth = +t[++i]; break;
      case 'seldepth': info.seldepth = +t[++i]; break;
      case 'multipv': info.multipv = +t[++i]; break;
      case 'nps': info.nps = +t[++i]; break;
      case 'nodes': info.nodes = +t[++i]; break;
      case 'score':
        if (t[i + 1] === 'cp') info.cp = +t[i + 2];
        else if (t[i + 1] === 'mate') info.mate = +t[i + 2];
        i += 2;
        break;
      case 'lowerbound': case 'upperbound': info.bound = true; break;
      case 'pv': info.pv = t.slice(i + 1).filter(Boolean); i = t.length; break;
    }
  }
  return info;
}

export class Engine {
  constructor() {
    this.gen = -1;
    this.info = null;      // registry entry of the running engine
    this.options = [];     // options the engine reported
    this.ready = false;
    this.job = null;       // active search
    this.waiters = [];     // [{test, resolve}]
    this.multipv = 1;
    this.seq = 0;
    this.onExit = null;
  }

  async init() {
    await listen('engine-line', ({ gen, line }) => { if (gen === this.gen) this.onLine(line.trim()); });
    await listen('engine-exit', (gen) => {
      if (gen !== this.gen) return;
      this.ready = false;
      this.finishJob(true);
      if (this.onExit) this.onExit();
    });
  }

  send(line) { return invoke('engine_send', { line }); }

  waitFor(test, ms = 30000) {
    return new Promise((resolve, reject) => {
      const w = { test, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); reject('The engine stopped responding.'); }
      }, ms);
    });
  }

  onLine(line) {
    if (line.startsWith('option name ')) {
      const o = parseOption(line);
      if (o) this.options.push(o);
    } else if (line.startsWith('info ') && this.job) {
      const info = parseInfo(line);
      // A search stopped at once can report a score with an empty line; that is not usable.
      if (info.pv && info.pv[0] && !info.bound && (info.cp !== undefined || info.mate !== undefined)) {
        const sign = this.job.sign;
        const entry = {
          depth: info.depth,
          pv: info.pv,
          cp: info.cp !== undefined ? info.cp * sign : undefined,
          mate: info.mate !== undefined ? info.mate * sign : undefined,
        };
        this.job.lines[info.multipv - 1] = entry;
        this.job.depth = info.depth;
        this.job.nps = info.nps ?? this.job.nps;
        if (this.job.onInfo) this.job.onInfo(this.job.lines, this.job);
      }
    } else if (line.startsWith('bestmove')) {
      if (this.job) this.job.bestmove = line.split(/\s+/)[1];
      this.finishJob(false);
    }
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      if (this.waiters[i].test(line)) this.waiters.splice(i, 1)[0].resolve(line);
    }
  }

  finishJob(died) {
    const job = this.job;
    if (!job) return;
    this.job = null;
    job.resolve(died ? null : { lines: job.lines.filter(Boolean), depth: job.depth, stopped: job.stopped, bestmove: job.bestmove });
  }

  /** Launches the engine and applies settings. `overrides` is {optionName: value}. */
  async start(info, { threads, hash }, overrides = {}) {
    this.seq++;
    this.ready = false;
    this.finishJob(true);
    this.options = [];
    this.info = info;
    this.gen = -1;
    // Anything the engine prints before this resolves (its banner) is ignored.
    this.gen = await invoke('engine_start', { id: info.id });
    const ok = this.waitFor((l) => l === 'uciok');
    await this.send('uci');
    await ok;
    const has = (n) => this.options.some((o) => o.name.toLowerCase() === n);
    if (has('threads')) await this.setOption('Threads', threads);
    if (has('hash')) await this.setOption('Hash', hash);
    for (const [name, value] of Object.entries(overrides)) {
      if (this.options.some((o) => o.name === name)) await this.setOption(name, value);
    }
    this.multipv = 1;
    const rdy = this.waitFor((l) => l === 'readyok', 60000);
    await this.send('isready');
    await rdy;
    await this.send('ucinewgame');
    this.ready = true;
  }

  advancedOptions() {
    return this.options.filter((o) => !MANAGED.has(o.name.toLowerCase()));
  }

  setOption(name, value) {
    if (value === undefined) return this.send(`setoption name ${name}`);
    return this.send(`setoption name ${name} value ${value}`);
  }

  async halt() {
    while (this.job) {
      const job = this.job;
      job.stopped = true;
      await this.send('stop').catch(() => {});
      // An engine that ignores `stop` must not block every later search.
      const answered = await Promise.race([
        job.promise.then(() => true),
        new Promise((r) => setTimeout(() => r(false), 5000)),
      ]);
      if (!answered && this.job === job) {
        this.ready = false;
        this.finishJob(true);
        if (this.onExit) this.onExit();
      }
    }
  }

  /** Cancels the running search (and any search request still waiting to start). */
  async stop() {
    this.seq++;
    await this.halt();
  }

  /** Changes an option safely between searches. */
  async configure(name, value) {
    if (!this.ready) return;
    await this.stop();
    await this.setOption(name, value);
  }

  /**
   * Searches a position to a fixed depth. Scores in the result are from White's
   * point of view. Resolves with null when superseded, cancelled, or the engine died.
   */
  async search(fen, { depth, movetime, multipv = 1, onInfo } = {}) {
    if (!this.ready) return null;
    const mine = ++this.seq;
    await this.halt();
    if (mine !== this.seq || !this.ready) return null;
    if (multipv !== this.multipv) {
      this.multipv = multipv;
      await this.setOption('MultiPV', multipv);
      if (mine !== this.seq || !this.ready) return null;
    }
    const job = { lines: [], depth: 0, sign: fen.split(' ')[1] === 'b' ? -1 : 1, onInfo, stopped: false };
    job.promise = new Promise((r) => { job.resolve = r; });
    this.job = job;
    // One write, so a later `stop` can never land between `position` and `go`.
    await this.send(`position fen ${fen}\ngo ${movetime ? `movetime ${movetime}` : `depth ${depth}`}`);
    const res = await job.promise;
    return res && !res.stopped ? res : null;
  }

  async shutdown() {
    this.gen = -1;   // the exit that follows is expected
    this.seq++;
    this.ready = false;
    this.finishJob(true);
    this.info = null;
    await invoke('engine_stop').catch(() => {});
  }
}
