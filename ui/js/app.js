import { Chess, validateFen } from '../vendor/chess.js';
import { invoke, listen, isDesktop } from './backend.js';
import { Engine } from './engine.js';
import { Board } from './board.js';
import { CLASSES, CLASS_ORDER, PHASES, winPct, fmtScore, pvToSan, reviewGame, summarize, openingKey, uciToMove } from './review.js';
import { playSound, setVolume, setSoundStyle, preloadSounds, soundForMove, material, parseClock, clockSeconds, estimateRating, fenToPieces, piecesToFen } from './extras.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const BOARD_THEMES = {
  green: ['Green', '#ebecd0', '#739552'],
  brown: ['Brown', '#f0d9b5', '#b58863'],
  blue: ['Blue', '#dee3e6', '#8ca2ad'],
  sky: ['Sky', '#e9eef4', '#6f97c4'],
  purple: ['Purple', '#f0eef6', '#8877b7'],
  tournament: ['Tournament', '#eaeed0', '#33684b'],
  walnut: ['Walnut', '#e3cba6', '#8f5f3f'],
  slate: ['Slate', '#d9dadc', '#7b8087'],
  rose: ['Rose', '#fbe4ea', '#d9879f'],
};
const PIECE_SETS = ['cburnett', 'merida', 'staunty', 'california', 'maestro', 'tatiana'];

// ---------------------------------------------------------------- settings
const defaults = {
  boardTheme: 'green', pieceSet: 'cburnett', coords: true, arrow: true, legal: true,
  threads: 2, hash: 256, multipv: 3, liveDepth: 24, reviewDepth: 16,
  engineId: null, engineOn: true, engineOpts: {}, autoReview: true,
  anim: true, sound: true, volume: 60, soundStyle: 'wood', book: true, playLevel: 2,
  threats: false, panelW: 440, updates: {}, updCheck: 0,
};
let settings = { ...defaults };
try { settings = { ...defaults, ...JSON.parse(localStorage.getItem('chesslens') || '{}') }; } catch { /* first run */ }
const hadSaved = (() => { try { return !!localStorage.getItem('chesslens'); } catch { return false; } })();
function save() { try { localStorage.setItem('chesslens', JSON.stringify(settings)); } catch { /* storage unavailable */ } }

// ---------------------------------------------------------------- game tree
let nextId = 1;
const nodes = new Map();
function makeNode(parent, mv, fen) {
  const n = {
    id: nextId++, parent, children: [], move: mv || null, fen,
    ply: parent ? parent.ply + 1 : 0, rev: null, cache: null,
  };
  nodes.set(n.id, n);
  if (parent) parent.children.push(n);
  return n;
}
const game = { root: null, current: null, headers: {}, review: null, startPly: 0 };

// Modes that take over the board. At most one is active.
let retry = null;      // { items, idx, state: 'try' | 'solved', msg, hint, found }
let play = null;       // { color, level, thinking, byElo }
let drill = null;      // { items, idx, pos, state, msg, hint, found, missed }: repertoire quiz
let batch = null;      // { done, total, cancel }: background review of many games
let preview = null;    // { line, k }: engine-line move being hovered
let lastShown = null;  // node the board last displayed, for animation and sound
let skipAnim = false;
let playStopping = null;  // promise while a finished game is giving the engine back

function newGame(fen = START, headers = {}) {
  if (reviewing) { reviewCancelled = true; engine.stop(); }
  retry = null;
  drill = null;
  preview = null;
  lastShown = null;
  if (play) playStopping = stopPlay().finally(() => { playStopping = null; });
  nodes.clear();
  const [, turn, , , , full] = fen.split(' ');
  game.startPly = (Number(full || 1) - 1) * 2 + (turn === 'b' ? 1 : 0);
  game.root = makeNode(null, null, fen);
  game.root.ply = game.startPly;
  game.current = game.root;
  game.headers = headers;
  game.review = null;
}

function mainline() {
  const out = [];
  for (let n = game.root; n.children.length; n = n.children[0]) out.push(n.children[0]);
  return out;
}
function onMainline(node) {
  for (let n = node; n.parent; n = n.parent) if (n.parent.children[0] !== n) return false;
  return true;
}

function loadPgn(text, { userName } = {}) {
  const c = new Chess();
  c.loadPgn(text, { strict: false });
  const headers = c.getHeaders ? c.getHeaders() : c.header();
  const history = c.history({ verbose: true });
  const clocks = new Map((c.getComments ? c.getComments() : []).map(({ fen, comment }) => [fen, [parseClock(comment), clockSeconds(comment)]]));
  const startFen = history.length ? history[0].before : c.fen();
  newGame(startFen, headers);
  let n = game.root;
  for (const mv of history) { n = makeNode(n, mv, mv.after); [n.clk, n.clkSec] = clocks.get(mv.after) || [null, null]; }
  if (userName) {
    const u = userName.toLowerCase();
    board.orientation = (headers.Black || '').toLowerCase() === u ? 'b' : 'w';
  }
  renderAll();
  analyze();
  if (settings.autoReview && engine.ready && history.length && !batch) cancelReview().then(() => runReview());
}

/** Adds a move at the current position (or follows it if it already exists). */
function addMove(from, to, promotion) {
  const c = new Chess(game.current.fen);
  let mv;
  try { mv = c.move({ from, to, promotion }); } catch { return null; }
  const existing = game.current.children.find((ch) => ch.move.san === mv.san);
  game.current = existing || makeNode(game.current, mv, mv.after);
  if (!existing) refreshSummary();
  return game.current;
}

function playMove(from, to, promotion) {
  if (!addMove(from, to, promotion)) return;
  renderAll();
  analyze();
}

/** Every move made on the board comes through here. */
function handleBoardMove(from, to, promotion, dragged) {
  skipAnim = !!dragged;
  if (retry) retryAttempt(from, to, promotion);
  else if (drill) drillAttempt(from, to, promotion);
  else if (play) playUserMove(from, to, promotion);
  else playMove(from, to, promotion);
}

function goto(node) {
  if (!node || node === game.current) return;
  retry = null;
  drill = null;
  game.current = node;
  renderAll();
  analyze();
}

function deleteCurrent() {
  const n = game.current;
  if (!n.parent || play || retry || drill) return;
  n.parent.children.splice(n.parent.children.indexOf(n), 1);
  game.current = n.parent;
  refreshSummary();
  renderAll();
  analyze();
}

function moveLabel(n, first) {
  const num = Math.floor((n.ply + 1) / 2);
  return n.move.color === 'w' ? `${num}.` : first ? `${num}...` : '';
}

const NAG = { brilliant: '!!', great: '!', inaccuracy: '?!', mistake: '?', miss: '?', blunder: '??' };

/** PGN of the whole tree. With `annotate`, graded moves carry their symbol and explanation. */
function toPgn({ annotate = false } = {}) {
  const h = { ...game.headers };
  if (game.root.fen !== START) { h.SetUp = '1'; h.FEN = game.root.fen; }
  const head = Object.entries(h).filter(([, v]) => v != null).map(([k, v]) => `[${k} "${String(v).replace(/"/g, '\\"')}"]`).join('\n');
  // Returns the move text and whether a comment follows it (the next move then needs its number).
  const tok = (n, first) => {
    const lab = moveLabel(n, first);
    let t = `${lab}${lab ? ' ' : ''}${n.move.san}`;
    const sym = annotate && n.rev ? NAG[n.rev.cls] : null;
    if (!sym) return [t, false];
    t += `${sym} {${CLASSES[n.rev.cls].label}. ${n.rev.text.replace(/[{}]/g, '')}}`;
    return [t, true];
  };
  const walk = (start, parts, force) => {
    let cur = start;
    while (cur.children.length) {
      const [main, ...alts] = cur.children;
      const [t, noted] = tok(main, force);
      parts.push(t);
      force = noted;
      for (const a of alts) {
        const [at, anoted] = tok(a, true);
        parts.push(`(${walk(a, [at], anoted).join(' ')})`);
        force = true;
      }
      cur = main;
    }
    return parts;
  };
  const body = walk(game.root, [], true).join(' ');
  return `${head}${head ? '\n\n' : ''}${body} ${h.Result || '*'}`.trim() + '\n';
}

/** Why a FEN cannot be analysed, or null when it is a legal position. */
function positionError(fen) {
  const v = validateFen(fen);
  if (!v.ok) return v.error;
  try {
    const c = new Chess(fen);
    const mover = c.turn();
    for (const row of c.board()) {
      for (const p of row) {
        if (p && p.type === 'k' && p.color !== mover && c.isAttacked(p.square, mover)) {
          return `${mover === 'w' ? 'Black' : 'White'} is in check but it is ${mover === 'w' ? 'White' : 'Black'} to move`;
        }
      }
    }
  } catch (e) {
    return e.message || String(e);
  }
  return null;
}

function terminalInfo(fen) {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { terminal: 'checkmate', text: 'Checkmate', score: { mate: 0, winner: c.turn() === 'w' ? 'b' : 'w' } };
  if (c.isStalemate()) return { terminal: 'draw', text: 'Stalemate', score: { cp: 0 } };
  if (c.isInsufficientMaterial()) return { terminal: 'draw', text: 'Draw by insufficient material', score: { cp: 0 } };
  if (!c.moves().length) return { terminal: 'draw', text: 'Draw', score: { cp: 0 } };
  return null;
}

// ---------------------------------------------------------------- engine + live analysis
const engine = new Engine();
let engines = [];
let catalog = [];
let openings = null;
let reviewing = false;
let reviewCancelled = false;
let live = { node: null, lines: [], depth: 0 };
let liveToken = 0;
let liveFrame = 0;

/** Engine options changed during a review, Insights or a game; applied once the engine is free. */
const pendingOptions = new Map();
function engineBusy() {
  return reviewing ? 'the review' : batch ? 'Insights' : play ? 'the game' : null;
}
async function setEngineOption(name, value) {
  const busy = engineBusy();
  if (busy) {
    pendingOptions.set(name, value);
    toast(`This takes effect when ${busy} is finished.`);
    return;
  }
  await engine.configure(name, value);
}

// Depth at which a live evaluation is good enough to grade a move.
const CLASSIFY_DEPTH = 14;

/** Evaluation record for a node: review/live cache, or the game result if it is over. */
function posOf(n) {
  if (n.cache) return n.cache;
  const t = terminalInfo(n.fen);
  return t ? { fen: n.fen, score: t.score, lines: [], terminal: t.terminal, depth: 99 } : null;
}

/** Grades the move leading to `n` from the evaluations along its path. */
function classifyPath(n) {
  if (!n.parent) return false;
  const path = [];
  for (let x = n; x; x = x.parent) path.unshift(x);
  const res = reviewGame(path.map(posOf), path.slice(1).map((x) => x.move), openings);
  let changed = false;
  path.slice(1).forEach((x, i) => {
    const r = res.moves[i];
    if (r && (!x.rev || x === n)) { x.rev = r; changed = true; }
  });
  return changed;
}

/** Re-grades a node and its replies after its evaluation became available. */
function classifyAround(node) {
  let changed = classifyPath(node);
  for (const ch of node.children) if (posOf(ch)) changed = classifyPath(ch) || changed;
  if (changed) refreshSummary();
  return changed;
}

/** Accuracy and counts for the main line, once every move in it is graded. */
function refreshSummary() {
  const main = mainline();
  if (!main.length || main.some((n) => !n.rev)) { game.review = null; return; }
  let opening = null;
  for (const n of main) {
    const o = openings && openings[openingKey(n.fen)];
    if (!o) break;
    opening = o;
  }
  const depths = [game.root, ...main].map((n) => n.cache?.depth).filter((d) => d && d < 99);
  game.review = { ...summarize(main.map((n) => n.rev), main.map((n) => n.move)), opening, depth: depths.length ? Math.min(...depths) : 0 };
}

function renderQuality() {
  renderKeyNav();
  renderPlayers();
  renderMoves();
  renderCoach();
  renderGraph();
  renderReview();
  renderBoard();
}

async function analyze() {
  const node = game.current;
  const token = ++liveToken;
  live = { node, lines: [], depth: 0 };
  preview = null;
  if (reviewing || batch) { if (batch) renderLive(); return; }
  if (retry || play || drill) { renderLive(); return; }
  if (playStopping) {
    await playStopping;
    if (token !== liveToken) return;
  }
  // Engine settings changed while the engine was busy are applied now.
  if (pendingOptions.size && engine.ready) {
    for (const [name, value] of pendingOptions) await engine.configure(name, value);
    pendingOptions.clear();
    if (token !== liveToken) return;
  }
  if (!node.rev && classifyAround(node)) renderQuality();
  const usable = settings.engineOn && engine.ready;

  // The move that led here is graded against the position before it.
  const par = node.parent;
  if (usable && settings.autoReview && par && !par.cache && !terminalInfo(par.fen)) {
    renderLive();
    const res = await engine.search(par.fen, { depth: CLASSIFY_DEPTH, multipv: 2 });
    if (token !== liveToken) return;
    if (res && res.lines.length) {
      par.cache = { fen: par.fen, score: res.lines[0], lines: res.lines, depth: CLASSIFY_DEPTH };
      if (classifyAround(par)) renderQuality();
    }
  }

  // What would the opponent do if it were their move again? (Not asked while in check.)
  if (usable && settings.threats && node.threat === undefined && !terminalInfo(node.fen)) {
    node.threat = null;
    if (!new Chess(node.fen).inCheck()) {
      const f = node.fen.split(' ');
      f[1] = f[1] === 'w' ? 'b' : 'w';
      f[3] = '-';
      const flipped = f.join(' ');
      const res = await engine.search(flipped, { depth: 12, multipv: 1 });
      if (token !== liveToken) { node.threat = undefined; return; }
      const u = res && res.lines[0] && res.lines[0].pv[0];
      const mv = u && uciToMove(flipped, u);
      if (mv) node.threat = { uci: u, san: mv.san, show: !!(mv.captured || mv.promotion || /[+#]/.test(mv.san)) };
    }
  }

  const term = terminalInfo(node.fen);
  if (term || !usable) {
    if (engine.ready) engine.stop();
    renderLive();
    return;
  }
  renderLive();
  const legal = new Chess(node.fen).moves().length;
  await engine.search(node.fen, {
    depth: settings.liveDepth,
    multipv: Math.max(2, settings.multipv),
    onInfo: (lines, job) => {
      if (token !== liveToken) return;
      live.lines = lines.filter(Boolean);
      live.depth = job.depth;
      const settled = live.lines.length >= Math.min(2, legal) && live.lines.every((l) => l.depth === job.depth);
      if (settings.autoReview && !node.cache && settled && job.depth >= Math.min(CLASSIFY_DEPTH, settings.liveDepth)) {
        node.cache = { fen: node.fen, score: live.lines[0], lines: live.lines.map((l) => ({ ...l })), depth: job.depth };
        if (classifyAround(node)) renderQuality();
      }
      if (!liveFrame) liveFrame = requestAnimationFrame(() => { liveFrame = 0; renderLive(); });
    },
  });
}

/** Score for the current position: live engine output first, review cache second. */
function currentScore() {
  if (retry || play || drill) return null;
  const term = terminalInfo(game.current.fen);
  if (term) return term.score;
  if (live.node === game.current && live.lines[0]) return live.lines[0];
  if (game.current.cache) return game.current.cache.score;
  return null;
}

function renderLive() {
  const node = game.current;
  const term = terminalInfo(node.fen);
  const el = $('lines');
  if (retry || play || drill) {
    el.innerHTML = `<div class="msg">${retry ? 'Retry mode: engine lines are hidden.' : drill ? 'Repertoire training: engine lines are hidden.' : term ? esc(term.text) : 'Game in progress: engine lines are hidden.'}</div>`;
    $('engine-depth').textContent = '';
  } else if (term) {
    el.innerHTML = `<div class="msg">${esc(term.text)}</div>`;
    $('engine-depth').textContent = '';
  } else if (!engine.ready) {
    el.innerHTML = !engines.length ? ''
      : engineDown ? '<div class="msg">The engine keeps stopping. <button class="btn" data-restart="1">Restart engine</button></div>'
        : '<div class="msg">Starting engine…</div>';
    $('engine-depth').textContent = '';
  } else if (batch) {
    el.innerHTML = `<div class="msg">Analysing your games for Insights… ${batch.done} of ${batch.total}</div>`;
    $('engine-depth').textContent = '';
  } else if (reviewing) {
    el.innerHTML = `<div class="msg">Reviewing the game… ${reviewPct}%</div>`;
    $('engine-depth').textContent = '';
  } else if (!settings.engineOn) {
    el.innerHTML = '<div class="msg">Live analysis is off.</div>';
    $('engine-depth').textContent = '';
  } else if (!live.lines.length) {
    el.innerHTML = `${threatRow(node)}<div class="msg">Thinking…</div>`;
  } else {
    const [, turn, , , , full] = node.fen.split(' ');
    el.innerHTML = threatRow(node) + live.lines.slice(0, settings.multipv).map((l, i) => {
      const sans = pvToSan(node.fen, l.pv, 10);
      let num = Number(full), white = turn === 'w', txt = '';
      sans.forEach((s, k) => {
        const lab = white ? `${num}. ` : k === 0 ? `${num}... ` : '';
        txt += k === 0 ? `<b data-line="${i}" data-k="0">${lab}${esc(s)}</b> ` : `<span data-line="${i}" data-k="${k}">${lab}${esc(s)}</span> `;
        if (!white) num++;
        white = !white;
      });
      const neg = winPct(l) < 50;
      return `<div class="pv"><span class="score${neg ? ' neg' : ''}">${fmtScore(l)}</span><span class="san">${txt}</span></div>`;
    }).join('');
    $('engine-depth').textContent = `Depth ${live.depth}`;
  }
  renderEvalBar();
  renderBoard();
}

function threatRow(node) {
  if (!settings.threats || node.threat === undefined) return '';
  const t = node.threat;
  return `<div class="pv threat"><span class="score">Threat</span><span class="san">${t && t.show ? `<b>${esc(t.san)}</b>` : 'nothing forcing right now'}</span></div>`;
}

function renderEvalBar() {
  const score = currentScore();
  const bar = $('evalbar'), num = $('evalbar-num');
  bar.classList.toggle('flipped', board.orientation === 'b');
  if (!score) { $('evalbar-white').style.height = '50%'; num.textContent = ''; return; }
  const pct = winPct(score);
  $('evalbar-white').style.height = `${Math.max(3, Math.min(97, pct))}%`;
  const whiteAhead = pct >= 50;
  num.className = `evalbar-num ${whiteAhead ? 'w' : 'b'}`;
  num.textContent = score.mate !== undefined
    ? (score.mate === 0 ? '#' : `M${Math.abs(score.mate)}`)
    : Math.abs(score.cp / 100).toFixed(1);
}

let engineExits = [];
let engineDown = false;

/** The engine process ended or stopped answering: start it again, unless it keeps failing. */
function handleEngineExit() {
  engine.ready = false;
  const now = Date.now();
  engineExits = engineExits.filter((t) => now - t < 20000);
  engineExits.push(now);
  if (!engines.some((e) => e.id === settings.engineId)) { renderLive(); return; }
  if (engineExits.length > 2) {
    engineDown = true;
    renderLive();
    toast('The engine stopped three times in a row. It may not cope with this position.', true);
    return;
  }
  activateEngine(settings.engineId);
}

async function activateEngine(id) {
  const info = engines.find((e) => e.id === id);
  if (!info) return;
  // Swapping engines under a running review, Insights batch or game would break it.
  const busy = engineBusy();
  if (busy && engine.ready && engine.info && engine.info.id !== id) {
    toast(`Finish ${busy} before switching engines.`);
    renderEngines();
    return;
  }
  settings.engineId = id;
  save();
  renderEngines();
  renderLive();
  try {
    await engine.start(info, settings, settings.engineOpts[id] || {});
  } catch (e) {
    toast(`${info.name} failed to start: ${e}`, true);
    return;
  }
  engineDown = false;
  renderEngines();
  renderAdvanced();
  analyze();
}

async function refreshEngines({ activate } = {}) {
  engines = await invoke('list_engines');
  enginesLoaded = true;
  $('no-engine').hidden = engines.length > 0;
  if (activate) await activateEngine(activate);
  else if (!engines.some((e) => e.id === settings.engineId)) {
    if (engines.length) await activateEngine(engines[0].id);
    else { settings.engineId = null; await engine.shutdown(); }
  } else if (!engine.ready || engine.info?.id !== settings.engineId) {
    await activateEngine(settings.engineId);
  }
  renderEngines();
  renderLive();
}

const STAGES = { lookup: 'Finding the latest version…', download: 'Downloading', unpack: 'Unpacking…', verify: 'Checking the engine…', done: 'Done' };
function setProgress(el, pct, text) {
  if (!el) return;
  el.hidden = false;
  el.firstElementChild.style.width = `${pct}%`;
  el.lastElementChild.textContent = text;
}
function onInstallProgress({ id, stage, received, total }) {
  const text = stage === 'download'
    ? `${STAGES.download} ${(received / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`
    : STAGES[stage] || stage;
  const pct = stage === 'download' && total ? (received / total) * 100 : stage === 'lookup' ? 0 : 100;
  setProgress(document.querySelector(`#catalog [data-progress="${id}"]`), pct, text);
  if (id === 'stockfish') setProgress($('quick-progress'), pct, text);
  setProgress($('welcome-progress'), pct, text);
}

const installing = new Set();
let welcomeSkipped = false;
let enginesLoaded = false;
async function install(catalogId) {
  if (installing.has(catalogId)) return;
  installing.add(catalogId);
  renderEngines();
  setStatus('engine-status', '');
  $('welcome-error').textContent = '';
  try {
    const info = await invoke('install_engine', { catalogId });
    toast(`${info.name} is installed.`);
    installing.delete(catalogId);
    delete settings.updates[catalogId];
    save();
    await refreshEngines({ activate: info.id });
  } catch (e) {
    installing.delete(catalogId);
    setStatus('engine-status', String(e), true);
    $('welcome-error').textContent = String(e);
    toast(String(e), true);
    renderEngines();
  }
  $('quick-progress').hidden = true;
  $('welcome-progress').hidden = true;
}

async function importEngine() {
  setStatus('engine-status', 'Checking the engine…');
  try {
    const info = await invoke('import_engine');
    setStatus('engine-status', '');
    if (!info) return;
    toast(`${info.name} added.`);
    await refreshEngines({ activate: info.id });
  } catch (e) {
    setStatus('engine-status', String(e), true);
    toast(String(e), true);
  }
}

// ---------------------------------------------------------------- game review
let reviewPromise = null;
let reviewPct = 0;

async function cancelReview() {
  if (!reviewing) return;
  reviewCancelled = true;
  engine.stop();
  await reviewPromise;
}

/** Reviews the whole main line. A second call while one is running joins it. */
function runReview() {
  if (reviewing) return reviewPromise;
  if (batch || play) { toast(`Wait until ${engineBusy()} is finished.`); return Promise.resolve(null); }
  const main = mainline();
  if (!main.length) { toast('Load a game or play some moves first.'); return Promise.resolve(null); }
  if (!engine.ready) { toast('Install or choose an engine first.'); showTab('engines'); return Promise.resolve(null); }
  reviewing = true;
  reviewCancelled = false;
  reviewPromise = doReview(main).finally(() => { reviewPromise = null; });
  return reviewPromise;
}

async function doReview(main) {
  const depth = Number($('review-depth').value);
  settings.reviewDepth = depth;
  save();
  $('review-idle').hidden = true;
  $('review-running').hidden = false;
  await engine.stop();

  const seq = [game.root, ...main];
  const positions = [];
  for (let i = 0; i < seq.length && !reviewCancelled; i++) {
    const n = seq[i];
    reviewPct = Math.round((i / seq.length) * 100);
    $('review-status').textContent = `Analysing move ${Math.ceil(i / 2) || 1} of ${Math.ceil(main.length / 2)}…`;
    setProgress($('review-progress'), reviewPct, `${reviewPct}%`);
    renderLive();
    const term = terminalInfo(n.fen);
    let p;
    if (term) p = posOf(n);
    else if (n.cache && n.cache.depth >= depth) p = n.cache;
    else {
      const res = await engine.search(n.fen, { depth, multipv: 2 });
      if (!res || !res.lines.length) { reviewCancelled = true; break; }
      p = { fen: n.fen, score: res.lines[0], lines: res.lines, depth };
      n.cache = p;
    }
    positions.push(p);
    // Grades show up as soon as each move has both of its evaluations.
    if (i > 0 && game.root === seq[0] && classifyPath(n)) renderQuality();
  }
  reviewing = false;
  $('review-idle').hidden = false;
  $('review-running').hidden = true;
  if (game.root !== seq[0]) { analyze(); return null; }   // another game was loaded meanwhile
  if (reviewCancelled) {
    if (!engine.ready) toast('The engine stopped during the review.', true);
    renderAll();
    analyze();
    return null;
  }
  const result = reviewGame(positions, main.map((n) => n.move), openings);
  main.forEach((n, i) => { n.rev = result.moves[i]; });
  game.review = { accuracy: result.accuracy, counts: result.counts, phases: result.phases, opening: result.opening, depth };
  renderAll();
  analyze();
  return result;
}

function gradeOf(acc) {
  return acc >= 92 ? 'best' : acc >= 85 ? 'excellent' : acc >= 75 ? 'good' : acc >= 65 ? 'inaccuracy' : acc >= 50 ? 'mistake' : 'blunder';
}
function accCell(p) {
  return p && p.n ? `<span class="ci ci-${gradeOf(p.acc)}">${CLASSES[gradeOf(p.acc)].glyph}</span>${p.acc.toFixed(1)}` : '–';
}
function phaseTable(ph) {
  if (!ph) return '';
  const label = { opening: 'Opening', middlegame: 'Middlegame', endgame: 'Endgame' };
  return `<h3>By phase</h3><table class="mini"><tr><th>Phase</th><th class="num">White</th><th class="num">Black</th></tr>${
    PHASES.map((p) => `<tr><td>${label[p]}</td><td class="num">${accCell(ph.w[p])}</td><td class="num">${accCell(ph.b[p])}</td></tr>`).join('')}</table>`;
}

/** Seconds spent on each main-line move, from PGN clocks. Null when the game has none. */
function timeSpent() {
  const main = mainline();
  if (!main.some((n) => n.clkSec != null)) return null;
  const tc = /^(\d+)(?:\+(\d+))?$/.exec(game.headers.TimeControl || '');
  const inc = tc ? Number(tc[2] || 0) : 0;
  const last = { w: tc ? Number(tc[1]) : null, b: tc ? Number(tc[1]) : null };
  return main.map((n) => {
    const c = n.move.color;
    const spent = n.clkSec != null && last[c] != null ? Math.max(0, last[c] - n.clkSec + inc) : null;
    if (n.clkSec != null) last[c] = n.clkSec;
    return spent;
  });
}
function timeChart() {
  const spent = timeSpent();
  if (!spent) return '';
  const main = mainline();
  if (!spent.some((x) => x > 0)) return '';
  const max = Math.max(1, ...spent.map((x) => x || 0));
  const bars = spent.map((x, i) => {
    if (!x) return '';
    const n = main[i], white = n.move.color === 'w', h = (x / max) * 47;
    const fill = n.rev && ['inaccuracy', 'mistake', 'miss', 'blunder'].includes(n.rev.cls) ? CLASSES[n.rev.cls].color : white ? '#d9d7d3' : '#77746f';
    return `<rect x="${i + 0.1}" width="0.8" y="${white ? 50 - h : 50}" height="${h}" fill="${fill}"><title>${moveLabel(n, true)} ${esc(n.move.san)}: ${x.toFixed(x < 10 ? 1 : 0)}s</title></rect>`;
  }).join('');
  const longest = spent.indexOf(Math.max(...spent.map((x) => x || 0)));
  return `<h3>Time per move</h3><svg class="timechart" id="timechart" viewBox="0 0 ${main.length} 100" preserveAspectRatio="none">${bars}</svg>
    <p class="hint small" style="margin-top:6px">White above the line, Black below. Coloured bars are inaccuracies, mistakes, misses and blunders. Longest think: ${moveLabel(main[longest], true)} ${esc(main[longest].move.san)} (${Math.round(spent[longest])}s).</p>`;
}

function renderReview() {
  const el = $('review-result');
  const r = game.review;
  if (!r) { el.innerHTML = ''; return; }
  const h = game.headers;
  const fmt = (a) => (a == null ? '–' : a.toFixed(1));
  const est = (a) => (a == null ? '' : `<div class="est">plays like ≈ ${estimateRating(a)}</div>`);
  const mine = retryItems(board.orientation).length, all = retryItems().length;
  let rows = '';
  for (const k of CLASS_ORDER) {
    const w = r.counts.w[k] || 0, b = r.counts.b[k] || 0;
    rows += `<tr class="clk" data-cls="${k}"><td class="${w ? '' : 'z'}" style="color:${w ? CLASSES[k].color : ''}">${w}</td>` +
      `<td class="lab"><span class="ci ci-${k}">${CLASSES[k].glyph}</span>${CLASSES[k].label}</td>` +
      `<td class="${b ? '' : 'z'}" style="color:${b ? CLASSES[k].color : ''}">${b}</td></tr>`;
  }
  el.innerHTML = `
    <h3>Accuracy</h3>
    <div class="acc-row">
      <div class="acc-box w"><div class="who">${esc(h.White || 'White')}</div><div class="n">${fmt(r.accuracy.w)}</div>${est(r.accuracy.w)}</div>
      <div class="acc-box b"><div class="who">${esc(h.Black || 'Black')}</div><div class="n">${fmt(r.accuracy.b)}</div>${est(r.accuracy.b)}</div>
    </div>
    ${mine || all ? `<div class="row">
      ${mine ? `<button class="btn primary" data-retry-side="${board.orientation}">Retry ${board.orientation === 'w' ? "White's" : "Black's"} mistakes (${mine})</button>` : ''}
      ${all > mine ? `<button class="btn" data-retry-side="">Retry all (${all})</button>` : ''}
    </div>` : ''}
    <table class="counts">${rows}</table>
    ${phaseTable(r.phases)}
    ${timeChart()}
    <p class="hint small">${r.opening ? `Opening: ${esc(r.opening[1])} (${esc(r.opening[0])}). ` : ''}Reviewed at depth ${r.depth} with ${esc(engine.info?.name || 'the engine')}. Click a row to jump to those moves. The rating figure is a rough estimate from accuracy alone.</p>`;
}

// ---------------------------------------------------------------- rendering
let board;

function ci(cls) { return `<span class="ci ci-${cls}" title="${CLASSES[cls].label}">${CLASSES[cls].glyph}</span>`; }

function renderBoard() {
  const n = game.current;
  const common = { pieceSet: settings.pieceSet, showCoords: settings.coords, showLegal: settings.legal };

  // Hovering a move in an engine line shows that position without touching the game.
  if (preview && live.node === n && live.lines[preview.line]) {
    const c = new Chess(n.fen);
    let last = null;
    try {
      for (const u of live.lines[preview.line].pv.slice(0, preview.k + 1)) last = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    } catch { /* line no longer fits the position */ }
    if (last) {
      board.set({ ...common, fen: c.fen(), lastMove: { from: last.from, to: last.to }, badge: null, arrows: [], movable: 'none' });
      return;
    }
  }

  const arrows = [];
  const rev = n.rev;
  const green = (uci) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), color: '#81b64c', opacity: 0.85 });
  let lastMove = n.move ? { from: n.move.from, to: n.move.to } : null;
  let badge = rev ? { square: n.move.to, cls: rev.cls, glyph: CLASSES[rev.cls].glyph, color: CLASSES[rev.cls].color } : null;
  let movable = 'both';
  if (retry) {
    const item = retry.items[retry.idx];
    const best = item.rev.bestUci;
    badge = null;
    movable = retry.state === 'solved' ? 'none' : item.move.color;
    if (retry.state === 'solved') arrows.push(green(best));
    else if (retry.hint) lastMove = { from: best.slice(0, 2), to: best.slice(0, 2) };
  } else if (drill) {
    const line = drill.items[drill.idx];
    badge = null;
    movable = drill.state === 'try' ? line.color : 'none';
    if (drill.hint && drill.state === 'try') {
      try { const m = new Chess(n.fen).move(line.moves[drill.pos]); lastMove = { from: m.from, to: m.from }; } catch { /* line does not fit */ }
    }
  } else if (play) {
    badge = null;
    movable = !play.thinking && !n.children.length && n.fen.split(' ')[1] === play.color ? play.color : 'none';
  } else if (rev && !rev.isBest && rev.bestUci && ['inaccuracy', 'mistake', 'miss', 'blunder'].includes(rev.cls)) {
    arrows.push(green(rev.bestUci));
  } else if (settings.arrow && settings.engineOn && !reviewing && live.node === n && live.lines[0]) {
    const u = live.lines[0].pv[0];
    arrows.push({ from: u.slice(0, 2), to: u.slice(2, 4), color: '#4a90d9', opacity: 0.7 });
  }

  if (settings.threats && !retry && !play && !drill && n.threat && n.threat.show) {
    arrows.push({ from: n.threat.uci.slice(0, 2), to: n.threat.uci.slice(2, 4), color: '#e0483a', opacity: 0.8 });
  }

  // Slide the piece and play a sound when stepping exactly one move forward or back.
  let anim = null;
  if (lastShown !== n) {
    const fwd = n.move && n.parent === lastShown;
    const back = lastShown && lastShown.move && lastShown.parent === n;
    if (settings.anim && !skipAnim) {
      if (fwd) anim = { from: n.move.from, to: n.move.to };
      else if (back) anim = { from: lastShown.move.to, to: lastShown.move.from };
    }
    if (settings.sound && (fwd || back)) playSound(soundForMove(fwd ? n.move : lastShown.move, fwd && !!terminalInfo(n.fen)));
    lastShown = n;
    skipAnim = false;
  }
  board.set({ ...common, fen: n.fen, lastMove, badge, arrows, movable, anim });
}

function renderPlayers() {
  const h = game.headers, r = game.review;
  const mat = material(game.current.fen);
  const side = (color) => {
    const name = color === 'w' ? h.White : h.Black;
    const elo = color === 'w' ? h.WhiteElo : h.BlackElo;
    const opp = color === 'w' ? 'b' : 'w';
    const lead = color === 'w' ? mat.diff : -mat.diff;
    const taken = mat[color].length || lead > 0
      ? `<span class="taken">${mat[color].map((t) => `<i style="background-image:url(pieces/${settings.pieceSet}/${opp}${t.toUpperCase()}.svg)"></i>`).join('')}${lead > 0 ? `<span class="plus">+${lead}</span>` : ''}</span>` : '';
    const acc = r && !play && r.accuracy[color] != null ? `<span class="acc" title="Accuracy">${r.accuracy[color].toFixed(1)}</span>` : '';
    let clk = null;
    for (let n = game.current; n && n.move && !clk; n = n.parent) if (n.move.color === color) clk = n.clk;
    const toMove = game.current.fen.split(' ')[1] === color;
    const clock = clk ? `<span class="clock${toMove ? ' live' : ''}">${esc(clk)}</span>` : '';
    return `<span class="avatar ${color === 'w' ? '' : 'black'}"></span><span>${esc(name && name !== '?' ? name : color === 'w' ? 'White' : 'Black')}</span>` +
      (elo && elo !== '?' ? `<span class="rating">(${esc(elo)})</span>` : '') + taken + `<span class="right">${acc}${clock}</span>`;
  };
  $('player-top').innerHTML = side(board.orientation === 'w' ? 'b' : 'w');
  $('player-bottom').innerHTML = side(board.orientation);
}

function renderMoves() {
  const cur = game.current;
  const cell = (n) => `<span class="mv${n === cur ? ' cur' : ''}" data-id="${n.id}">${esc(n.move.san)}${n.rev ? ci(n.rev.cls) : ''}</span>`;
  const tok = (n, first) => {
    const lab = moveLabel(n, first);
    return `${lab ? `<span class="n">${lab}</span> ` : ''}<span class="mv${n === cur ? ' cur' : ''}" data-id="${n.id}">${esc(n.move.san)}</span>`;
  };
  const line = (n, first) => {
    let s = tok(n, first), c = n, force = false;
    while (c.children.length) {
      const [main, ...alts] = c.children;
      s += ` ${tok(main, force)}`;
      force = false;
      for (const a of alts) { s += ` (${line(a, true)})`; force = true; }
      c = main;
    }
    return s;
  };
  let html = '', open = false;
  for (let n = game.root; n.children.length; n = n.children[0]) {
    const m = n.children[0];
    const num = Math.floor((m.ply + 1) / 2);
    if (m.move.color === 'w') { html += `<div class="mrow"><span class="num">${num}.</span>${cell(m)}`; open = true; }
    else {
      if (!open) html += `<div class="mrow"><span class="num">${num}.</span><span class="mv empty">…</span>`;
      html += `${cell(m)}</div>`;
      open = false;
    }
    if (n.children.length > 1) {
      if (open) { html += '<span class="mv empty"></span></div>'; open = false; }
      html += `<div class="var">${n.children.slice(1).map((v) => `<div>${line(v, true)}</div>`).join('')}</div>`;
    }
  }
  if (open) html += '</div>';
  const el = $('moves');
  el.innerHTML = html || '<div class="lines"><div class="msg" style="border:0">Make a move on the board, or load a game from the Games tab.</div></div>';
  const curEl = el.querySelector('.cur');
  if (curEl) curEl.scrollIntoView({ block: 'nearest' });
  else el.scrollTop = 0;
}

function renderOpening() {
  let name = '';
  if (openings) {
    const path = [];
    for (let n = game.current; n; n = n.parent) path.push(n);
    for (const n of path) {
      const o = openings[n.fen.split(' ').slice(0, 3).join(' ')];
      if (o) { name = `${o[0]} · ${o[1]}`; break; }
    }
  }
  $('opening').textContent = name || (game.root.fen === START ? 'Starting position' : 'Custom position');

  // Book moves: every legal move that leads to a named opening position.
  const el = $('book');
  let chips = [];
  if (openings && settings.book && !retry && !play && !drill) {
    chips = new Chess(game.current.fen).moves({ verbose: true })
      .map((m) => [m, openings[openingKey(m.after)]]).filter(([, o]) => o);
  }
  el.hidden = !chips.length;
  el.innerHTML = chips.map(([m, o]) =>
    `<button data-from="${m.from}" data-to="${m.to}" data-promo="${m.promotion || ''}" title="${esc(o[0])}"><b>${esc(m.san)}</b>${esc(o[1])}</button>`).join('');
}

function renderCoach() {
  const el = $('coach'), rev = game.current.rev;
  if (!rev || retry || play || drill) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `${ci(rev.cls)}<div><div>${esc(rev.text)}</div>` +
    (rev.scoreBefore && rev.scoreAfter ? `<div class="ev">Evaluation ${esc(fmtScore(rev.scoreBefore))} → ${esc(fmtScore(rev.scoreAfter))}</div>` : '') +
    (BAD.includes(rev.cls) && rev.bestUci && game.current.parent.cache ? `<button class="retry-one" data-retry="${game.current.id}">Retry this move</button>` : '') + '</div>';
}

function renderGraph() {
  const wrap = $('graph-wrap');
  const main = mainline();
  const seq = [game.root, ...main];
  const pos = seq.map(posOf);
  if (!game.review || play || pos.some((p) => !p)) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const n = seq.length - 1;
  const svg = $('graph');
  svg.setAttribute('viewBox', `0 0 ${n} 100`);
  const pts = pos.map((p, i) => `${i},${(100 - winPct(p.score)).toFixed(2)}`).join(' ');
  let marks = '';
  main.forEach((m, i) => {
    if (!m.rev || !['brilliant', 'great', 'mistake', 'miss', 'blunder'].includes(m.rev.cls)) return;
    const y = 100 - winPct(pos[i + 1].score);
    marks += `<line x1="${i + 1}" x2="${i + 1.0001}" y1="${y}" y2="${y}" stroke="${CLASSES[m.rev.cls].color}" stroke-width="7" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
  });
  const curIdx = seq.indexOf(game.current);
  const curLine = curIdx >= 0
    ? `<line x1="${curIdx}" x2="${curIdx}" y1="0" y2="100" stroke="#f5a623" stroke-width="2" vector-effect="non-scaling-stroke"/>` : '';
  svg.innerHTML = `<polygon points="0,100 ${pts} ${n},100" fill="#f1f1f1"/>` +
    `<line x1="0" x2="${n}" y1="50" y2="50" stroke="#8a8782" stroke-width="1" vector-effect="non-scaling-stroke"/>${marks}${curLine}`;
}

function renderEngines() {
  const sel = $('engine-select');
  sel.innerHTML = engines.length
    ? engines.map((e) => `<option value="${esc(e.id)}"${e.id === settings.engineId ? ' selected' : ''}>${esc(e.name)}</option>`).join('')
    : '<option>No engine</option>';
  sel.innerHTML += '<option value="__more">＋ Get more engines…</option>';
  $('no-engine').hidden = engines.length > 0;

  // First run: one big button, shown until an engine exists or the user skips.
  $('welcome').hidden = !enginesLoaded || engines.length > 0 || welcomeSkipped || !isDesktop;
  const busyAny = installing.size > 0;
  $('welcome-main').disabled = busyAny;
  $('welcome-main').textContent = installing.has('stockfish') ? 'Installing Stockfish…' : 'Install Stockfish';
  $('welcome-others').innerHTML = catalog.filter((c) => c.id !== 'stockfish')
    .map((c) => `<button class="btn" data-install="${esc(c.id)}"${busyAny ? ' disabled' : ''} title="${esc(c.blurb)}">${esc(c.name)}</button>`).join('');

  $('installed').innerHTML = engines.length ? engines.map((e) => `
    <div class="card${e.id === settings.engineId ? ' active' : ''}">
      <div class="name">${esc(e.name)}<span class="tag">${e.source === 'downloaded' ? 'downloaded' : 'from file'}</span></div>
      <div class="sub" title="${esc(e.path)}">${esc(e.version ? `${e.version} · ` : '')}${esc(e.path)}</div>
      <div class="acts">
        ${e.id === settings.engineId ? '' : `<button class="btn" data-use="${esc(e.id)}">Use</button>`}
        <button class="btn danger" data-remove="${esc(e.id)}">Remove</button>
      </div>
    </div>`).join('') : '<p class="hint">Nothing installed yet. Pick one below, or add an engine file you already have.</p>';

  $('catalog').innerHTML = catalog.map((c) => {
    const have = engines.find((e) => e.id === c.id);
    const busy = installing.has(c.id);
    const upd = have && settings.updates[c.id] && settings.updates[c.id] !== have.version ? settings.updates[c.id] : null;
    return `<div class="card">
      <div class="name">${esc(c.name)}${have ? `<span class="tag">installed ${esc(have.version)}</span>` : ''}${upd ? `<span class="tag" style="background:var(--green);color:#fff">new: ${esc(upd)}</span>` : ''}</div>
      <div class="sub">${esc(c.blurb)}</div>
      <div class="acts"><button class="btn${have && !upd ? '' : ' primary'}" data-install="${esc(c.id)}"${busy ? ' disabled' : ''}>${busy ? 'Installing…' : upd ? 'Update' : have ? 'Reinstall' : 'Install'}</button></div>
      <div class="progress" data-progress="${esc(c.id)}"${busy ? '' : ' hidden'}><div></div><span></span></div>
    </div>`;
  }).join('');
}

function renderAdvanced() {
  const body = $('advanced-body');
  if (!engine.ready) { body.innerHTML = '<p class="hint">Start an engine to see its options.</p>'; return; }
  const over = settings.engineOpts[engine.info.id] || {};
  const opts = engine.advancedOptions();
  body.innerHTML = opts.map((o, i) => {
    const v = over[o.name] ?? o.default;
    const name = esc(o.name);
    if (o.type === 'spin') return `<label>${name}<input type="number" data-opt="${i}" min="${o.min}" max="${o.max}" value="${esc(v)}"></label>`;
    if (o.type === 'check') return `<label class="chk"><input type="checkbox" data-opt="${i}"${String(v) === 'true' ? ' checked' : ''}>${name}</label>`;
    if (o.type === 'combo') return `<label>${name}<select data-opt="${i}">${o.vars.map((x) => `<option${x === v ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>`;
    if (o.type === 'string') return `<label class="wide">${name}<input type="text" data-opt="${i}" value="${esc(v)}" spellcheck="false"></label>`;
    if (o.type === 'button') return `<label>&nbsp;<button class="btn" data-opt="${i}">${name}</button></label>`;
    return '';
  }).join('') + (opts.length ? '<label class="wide"><button class="btn" id="adv-reset">Reset to engine defaults</button></label>' : '<p class="hint">This engine reports no extra options.</p>');
}

function renderSettings() {
  $('board-themes').innerHTML = Object.entries(BOARD_THEMES).map(([k, [name, l, d]]) => `
    <button class="swatch${k === settings.boardTheme ? ' active' : ''}" data-theme="${k}">
      <div class="chip"><i style="background:${l}"></i><i style="background:${d}"></i><i style="background:${d}"></i><i style="background:${l}"></i></div>${name}
    </button>`).join('');
  $('piece-sets').innerHTML = PIECE_SETS.map((s) => `
    <button class="swatch${s === settings.pieceSet ? ' active' : ''}" data-set="${s}">
      <div class="chip pc" style="background-image:url(pieces/${s}/wN.svg)"></div>${s[0].toUpperCase() + s.slice(1)}
    </button>`).join('');
  // Warm the image cache so switching positions never flashes empty squares.
  for (const c of 'wb') for (const t of 'KQRBNP') new Image().src = `pieces/${settings.pieceSet}/${c}${t}.svg`;
  $('set-coords').checked = settings.coords;
  $('set-arrow').checked = settings.arrow;
  $('set-legal').checked = settings.legal;
  $('set-auto').checked = settings.autoReview;
  const [, l, d] = BOARD_THEMES[settings.boardTheme] || BOARD_THEMES.green;
  document.documentElement.style.setProperty('--sq-light', l);
  document.documentElement.style.setProperty('--sq-dark', d);
}

function renderAll() {
  renderModes();
  renderKeyNav();
  renderPlayers();
  renderMoves();
  renderOpening();
  renderCoach();
  renderGraph();
  renderReview();
  renderEvalBar();
  renderBoard();
}

function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  for (const t of ['analysis', 'review', 'games', 'play', 'insights', 'engines', 'settings']) $(`tab-${t}`).hidden = t !== name;
  if (name === 'games') renderLibrary();
  if (name === 'play') renderRep();
  if (name === 'insights') renderInsights();
  if (name === 'engines') checkUpdates(false);
}

let toastTimer;
function toast(msg, err = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast${err ? ' err' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, err ? 6000 : 2600);
}
function setStatus(id, msg, err = false) {
  const el = $(id);
  el.textContent = msg;
  el.className = `status${err ? ' err' : ''}`;
}

// ---------------------------------------------------------------- key moves
const KEY = ['brilliant', 'great', 'mistake', 'miss', 'blunder'];
const BAD = ['mistake', 'miss', 'blunder'];

function keyMoves() { return mainline().filter((n) => n.rev && KEY.includes(n.rev.cls)); }

function renderKeyNav() {
  const k = keyMoves();
  $('keynav').hidden = !k.length || !!retry || !!play || !!drill;
  const i = k.indexOf(game.current);
  $('key-count').textContent = i >= 0 ? `Key move ${i + 1} of ${k.length}` : `${k.length} key move${k.length === 1 ? '' : 's'}`;
}

function keyStep(dir) {
  const k = keyMoves(), ply = game.current.ply;
  const target = dir > 0 ? k.find((n) => n.ply > ply) : [...k].reverse().find((n) => n.ply < ply);
  if (target) goto(target);
}

// ---------------------------------------------------------------- retry mistakes
function retryItems(color) {
  return mainline().filter((n) => n.rev && BAD.includes(n.rev.cls) && n.rev.bestUci && n.parent.cache && (!color || n.move.color === color));
}

function startRetry(items) {
  if (reviewing || batch) { toast(`Wait until ${engineBusy()} is finished.`); return; }
  if (!items.length) { toast('No mistakes to retry.'); return; }
  if (engine.ready) engine.stop();
  retry = { items, idx: 0, found: 0 };
  showTab('analysis');
  showRetryItem();
}

function showRetryItem() {
  const it = retry.items[retry.idx];
  retry.state = 'try';
  retry.hint = false;
  retry.msg = `${it.move.color === 'w' ? 'White' : 'Black'} played <b>${esc(it.move.san)}</b> here, a ${CLASSES[it.rev.cls].label.toLowerCase()}. Find a better move.`;
  game.current = it.parent;
  board.orientation = it.move.color;
  renderAll();
  renderLive();
}

function exitRetry() {
  if (!retry) return;
  retry = null;
  renderAll();
  analyze();
}

function retrySolved(msg, found) {
  retry.state = 'solved';
  retry.msg = msg;
  if (found) { retry.found++; if (settings.sound) playSound('right'); }
  renderModes();
  renderBoard();
}

async function retryAttempt(from, to, promotion) {
  const session = retry, it = retry.items[retry.idx];
  if (retry.state !== 'try') return;
  let mv;
  try { mv = new Chess(it.parent.fen).move({ from, to, promotion }); } catch { return; }
  const uci = mv.from + mv.to + (mv.promotion || '');
  const san = esc(mv.san);
  const wrong = (msg) => { retry.msg = msg; if (settings.sound) playSound('wrong'); renderModes(); renderBoard(); };
  if (uci === it.rev.bestUci) { retrySolved(`<span class="ok">Correct!</span> ${san} is the best move.`, true); return; }
  if (mv.san === it.move.san) { wrong('<span class="no">That is the move from the game.</span> Try something else.'); return; }

  // Any other move counts if it keeps nearly all of the winning chances.
  const term = terminalInfo(mv.after);
  let score = term ? term.score : null;
  if (!score) {
    if (!engine.ready) { wrong(`<span class="no">${san} is not the engine's choice.</span> Try again.`); return; }
    retry.msg = `Checking ${san}…`;
    renderModes();
    const res = await engine.search(mv.after, { depth: 12, multipv: 1 });
    if (retry !== session || retry.items[retry.idx] !== it || retry.state !== 'try') return;
    score = res && res.lines[0];
    if (!score) { wrong('The engine did not answer. Try again.'); return; }
  }
  const pov = (s) => (it.move.color === 'w' ? winPct(s) : 100 - winPct(s));
  if (pov(it.parent.cache.score) - pov(score) <= 3) {
    retrySolved(`<span class="ok">Good!</span> ${san} works too. The engine's first choice was ${esc(it.rev.bestSan)}.`, true);
  } else wrong(`<span class="no">${san} is not it.</span> Try again.`);
}

function retryNext() {
  if (retry.idx + 1 < retry.items.length) { retry.idx++; showRetryItem(); return; }
  toast(`Done. You found ${retry.found} of ${retry.items.length}.`);
  exitRetry();
}

// ---------------------------------------------------------------- play against the engine
const LEVELS = [
  { name: 'Beginner', elo: 1350, depth: 1 },
  { name: 'Casual', elo: 1500, depth: 2 },
  { name: 'Intermediate', elo: 1700, depth: 3 },
  { name: 'Club player', elo: 1900, depth: 5 },
  { name: 'Strong', elo: 2200, depth: 8 },
  { name: 'Expert', elo: 2500, depth: 11 },
  { name: 'Master', elo: 2800, depth: 14 },
  { name: 'Maximum', elo: null, depth: null },
];

async function startPlay() {
  if (!engine.ready) { toast('Install or choose an engine first.'); showTab('engines'); return; }
  if (batch) { toast('Wait until Insights is finished.'); return; }
  await cancelReview();
  let color = $('play-side').value;
  if (color === 'r') color = Math.random() < 0.5 ? 'w' : 'b';
  const idx = Number($('play-level').value);
  const level = LEVELS[idx];
  settings.playLevel = idx;
  save();
  const opp = `${engine.info.name} (${level.name})`;
  newGame(START, {
    Event: 'Chesslens game', Date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
    White: color === 'w' ? 'You' : opp, Black: color === 'w' ? opp : 'You', Result: '*',
  });
  const limit = engine.options.find((o) => o.name === 'UCI_LimitStrength');
  const elo = engine.options.find((o) => o.name === 'UCI_Elo');
  play = { color, level, thinking: false, byElo: !!(limit && elo && level.elo) };
  board.orientation = color;
  await engine.stop();
  if (limit) await engine.setOption('UCI_LimitStrength', play.byElo ? 'true' : 'false');
  if (play.byElo) await engine.setOption('UCI_Elo', Math.max(elo.min, Math.min(elo.max, level.elo)));
  await engine.send('ucinewgame');
  showTab('analysis');
  renderAll();
  renderLive();
  if (color === 'b') engineTurn();
}

/** Ends play mode and gives the engine its full strength back. */
async function stopPlay() {
  const p = play;
  play = null;
  if (!p || !engine.ready) return;
  await engine.stop();
  if (engine.options.some((o) => o.name === 'UCI_LimitStrength')) await engine.setOption('UCI_LimitStrength', 'false');
}

function gameOver() {
  const tip = mainline().at(-1) || game.root;
  const term = terminalInfo(tip.fen);
  if (term) return term;
  const c = new Chess(game.root.fen);
  for (const n of mainline()) c.move(n.move.san);
  if (c.isThreefoldRepetition()) return { terminal: 'draw', text: 'Draw by repetition', score: { cp: 0 } };
  if (Number(tip.fen.split(' ')[4]) >= 100) return { terminal: 'draw', text: 'Draw by the fifty-move rule', score: { cp: 0 } };
  return null;
}

async function endPlay(result, text) {
  game.headers.Result = result;
  await stopPlay();
  if (settings.sound) playSound('end');
  toast(`${text} ${result.replace('1/2-1/2', '½-½')}`);
  renderAll();
  analyze();
  if (settings.autoReview && mainline().length) runReview();
}

function finishIfOver() {
  const over = gameOver();
  if (!over) return false;
  endPlay(over.terminal === 'checkmate' ? (over.score.winner === 'w' ? '1-0' : '0-1') : '1/2-1/2', `${over.text}.`);
  return true;
}

async function engineTurn() {
  const p = play, node = game.current;
  p.thinking = true;
  renderAll();
  renderLive();
  const limits = p.byElo ? { movetime: 700 } : p.level.depth ? { depth: p.level.depth } : { movetime: 1500 };
  const [res] = await Promise.all([
    engine.search(node.fen, { ...limits, multipv: 1 }),
    new Promise((r) => setTimeout(r, 350)),   // never answer instantly
  ]);
  if (play !== p) return;
  p.thinking = false;
  const u = res && res.bestmove;
  if (!u || u === '(none)') {
    toast('The engine did not answer, so the game was stopped.', true);
    await stopPlay();
    renderAll();
    analyze();
    return;
  }
  game.current = node;
  addMove(u.slice(0, 2), u.slice(2, 4), u[4]);
  renderAll();
  renderLive();
  finishIfOver();
}

function playUserMove(from, to, promotion) {
  const n = game.current;
  if (play.thinking || n.children.length || n.fen.split(' ')[1] !== play.color) return;
  if (!addMove(from, to, promotion)) return;
  renderAll();
  if (!finishIfOver()) engineTurn();
}

function takeBack() {
  if (!play || play.thinking) return;
  let tip = mainline().at(-1);
  if (!tip) return;
  // Undo the engine's reply and your move, so it is your turn again.
  for (let i = 0; i < 2 && tip && tip.parent; i++) {
    if (i === 1 && tip.move.color !== play.color) break;
    tip.parent.children.splice(tip.parent.children.indexOf(tip), 1);
    tip = tip.parent;
  }
  game.current = tip || game.root;
  skipAnim = true;
  renderAll();
  renderLive();
  if (game.current.fen.split(' ')[1] !== play.color) engineTurn();
}

function renderModes() {
  $('playbar').hidden = !play;
  if (play) {
    $('play-status').textContent = play.thinking ? `${engine.info?.name || 'Engine'} is thinking…` : 'Your move';
    $('play-takeback').disabled = play.thinking || mainline().length < (play.color === 'w' ? 2 : 3);
  }
  const m = retry || drill;
  $('retry').hidden = !m;
  if (m) {
    $('retry-text').innerHTML = `<b>${m.idx + 1} / ${m.items.length}</b> &nbsp;${m.msg}`;
    const solved = m.state === 'solved';
    $('retry-hint').hidden = solved;
    $('retry-answer').hidden = solved;
    $('retry-next').textContent = m.idx + 1 < m.items.length ? (solved ? 'Next' : 'Skip') : 'Finish';
  }
}

// ---------------------------------------------------------------- layout
function applyLayout() {
  document.documentElement.style.setProperty('--panel-w', `${settings.panelW}px`);
}
function toggleFocus() {
  const on = $('app').classList.toggle('focus');
  $('focus-exit').hidden = !on;
}

// ---------------------------------------------------------------- engine updates
async function checkUpdates(manual) {
  if (!isDesktop) return;
  if (!manual && Date.now() - settings.updCheck < 6 * 3600 * 1000) return;
  try {
    const list = await invoke('check_updates');
    settings.updates = Object.fromEntries(list);
    settings.updCheck = Date.now();
    save();
    renderEngines();
    if (manual) toast(list.length ? `${list.length} engine update${list.length === 1 ? '' : 's'} available.` : 'All downloaded engines are up to date.');
  } catch (e) {
    if (manual) toast(String(e), true);
  }
}

// ---------------------------------------------------------------- opening repertoire
function loadRep() {
  try { return JSON.parse(localStorage.getItem('chesslens-repertoire') || '[]'); } catch { return []; }
}
function storeRep(list) {
  try { localStorage.setItem('chesslens-repertoire', JSON.stringify(list)); } catch { toast('The repertoire could not be saved.', true); }
}
function numbered(sans) {
  return sans.map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san)).join(' ');
}

function addRepLine() {
  if (game.root.fen !== START) { toast('Repertoire lines have to start from the normal starting position.'); return; }
  const sans = [];
  let name = '';
  for (let n = game.current; n.parent; n = n.parent) {
    sans.unshift(n.move.san);
    const o = openings && openings[openingKey(n.fen)];
    if (o && !name) name = o[1];
  }
  if (sans.length < 2) { toast('Play at least two moves on the board first.'); return; }
  const list = loadRep(), color = board.orientation, key = sans.join(' ');
  if (list.some((l) => l.color === color && l.moves.join(' ') === key)) { toast('That line is already in your repertoire.'); return; }
  list.push({ id: Date.now(), name: name || `Line ${list.length + 1}`, color, moves: sans });
  storeRep(list);
  renderRep();
  toast(`Saved as a ${color === 'w' ? 'White' : 'Black'} line. Flip the board first to save it for the other side.`);
}

function renderRep() {
  const list = loadRep();
  $('rep-list').innerHTML = list.length ? list.map((l) => `
    <div class="game rep">
      <div>${esc(l.name)} <span class="tag">${l.color === 'w' ? 'White' : 'Black'}</span></div>
      <div><button class="btn" data-one="${l.id}">Train</button> <button class="del" data-del="${l.id}" title="Remove">×</button></div>
      <div class="meta" title="${esc(numbered(l.moves))}">${esc(numbered(l.moves))}</div>
    </div>`).join('') : '<p class="hint">No lines yet. Play an opening on the board, then press "Add the line on the board".</p>';
}

function startDrill(color, id) {
  if (play || batch) { toast(play ? 'Finish or resign the current game first.' : 'Wait until Insights is finished.'); return; }
  let items = loadRep().filter((l) => (id ? String(l.id) === String(id) : !color || l.color === color));
  if (!items.length) { toast('There are no repertoire lines to train yet.'); return; }
  items = items.map((l) => [Math.random(), l]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  if (engine.ready) engine.stop();
  showTab('analysis');
  drill = { items, idx: 0, found: 0 };
  setupDrillLine();
}

function setupDrillLine() {
  const d = drill, line = d.items[d.idx];
  newGame(START, { White: line.color === 'w' ? 'You' : 'Repertoire', Black: line.color === 'w' ? 'Repertoire' : 'You' });
  drill = d;   // newGame clears modes
  Object.assign(d, { pos: 0, state: 'try', hint: false, missed: false });
  d.msg = `<b>${esc(line.name)}</b>: play ${line.color === 'w' ? "White's" : "Black's"} moves from memory.`;
  board.orientation = line.color;
  drillAdvance();
}

function drillPlaySan(san) {
  try {
    const mv = new Chess(game.current.fen).move(san);
    return !!addMove(mv.from, mv.to, mv.promotion);
  } catch { return false; }
}

/** Plays the other side's moves until it is the user's turn or the line ends. */
function drillAdvance() {
  const d = drill, line = d.items[d.idx];
  while (d.pos < line.moves.length && game.current.fen.split(' ')[1] !== line.color) {
    if (!drillPlaySan(line.moves[d.pos])) { d.pos = line.moves.length; break; }
    d.pos++;
  }
  if (d.pos >= line.moves.length) {
    d.state = 'solved';
    if (!d.missed) d.found++;
    d.msg = `<span class="ok">Line complete${d.missed ? '' : ', no slips'}.</span> ${esc(line.name)}`;
    if (settings.sound) playSound('right');
  }
  renderAll();
  renderLive();
}

function drillAttempt(from, to, promotion) {
  const d = drill, line = d.items[d.idx];
  if (d.state !== 'try') return;
  let mv;
  try { mv = new Chess(game.current.fen).move({ from, to, promotion }); } catch { return; }
  if (mv.san !== line.moves[d.pos]) {
    d.missed = true;
    d.msg = `<span class="no">${esc(mv.san)} is not the move in this line.</span> Try again.`;
    if (settings.sound) playSound('wrong');
    renderModes();
    renderBoard();
    return;
  }
  addMove(from, to, promotion);
  d.pos++;
  d.hint = false;
  d.msg = '<span class="ok">Right.</span> Keep going.';
  renderAll();
  setTimeout(() => { if (drill === d && d.items[d.idx] === line) drillAdvance(); }, 350);
}

function drillShow() {
  const d = drill, line = d.items[d.idx];
  if (d.state !== 'try') return;
  d.missed = true;
  d.hint = false;
  d.msg = `The move was <b>${esc(line.moves[d.pos])}</b>.`;
  drillPlaySan(line.moves[d.pos]);
  d.pos++;
  drillAdvance();
}

function drillNext() {
  if (drill.idx + 1 < drill.items.length) { drill.idx++; setupDrillLine(); return; }
  toast(`Done. ${drill.found} of ${drill.items.length} line${drill.items.length === 1 ? '' : 's'} without a slip.`);
  exitDrill();
}

function exitDrill() {
  if (!drill) return;
  drill = null;
  renderAll();
  analyze();
}

// ---------------------------------------------------------------- insights across games
function loadInsights() {
  try { return JSON.parse(localStorage.getItem('chesslens-insights') || '{}'); } catch { return {}; }
}
function storeInsights(map) {
  try { localStorage.setItem('chesslens-insights', JSON.stringify(map)); } catch { toast('Insights could not be saved.', true); }
}
function gameKey(headers, sans) {
  let h = 0;
  for (const ch of `${headers.White}|${headers.Black}|${headers.Date}|${sans.join(' ')}`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return `${sans.length}_${(h >>> 0).toString(36)}`;
}

/** Reviews one PGN without touching the board. Returns a summary record, or null if cancelled. */
async function reviewHeadless(pgn, depth, extra) {
  const c = new Chess();
  c.loadPgn(pgn, { strict: false });
  const headers = c.getHeaders ? c.getHeaders() : c.header();
  const hist = c.history({ verbose: true });
  if (hist.length < 8) return { skip: true };
  const key = gameKey(headers, hist.map((m) => m.san));
  const stored = loadInsights()[key];
  if (stored && stored.depth >= depth) return stored;

  // Book moves need no engine: start at the position before the first non-book move.
  let book = 0;
  while (openings && book < hist.length && openings[openingKey(hist[book].after)]) book++;
  const fens = [hist[0].before, ...hist.map((m) => m.after)];
  const positions = fens.map(() => null);
  for (let i = book; i < fens.length; i++) {
    const term = terminalInfo(fens[i]);
    if (term) { positions[i] = { fen: fens[i], score: term.score, lines: [], terminal: term.terminal, depth: 99 }; continue; }
    const res = await engine.search(fens[i], { depth, multipv: 2 });
    if (!res || !res.lines.length) return null;
    positions[i] = { fen: fens[i], score: res.lines[0], lines: res.lines, depth };
  }
  const r = reviewGame(positions, hist, openings);
  return {
    key, depth, white: headers.White || '?', black: headers.Black || '?', result: headers.Result || '*',
    ts: extra.ts || Date.parse(String(headers.UTCDate || headers.Date || '').replace(/\./g, '-')) || 0,
    tc: extra.tc || 'other', opening: r.opening, accuracy: r.accuracy, counts: r.counts, phases: r.phases, plies: hist.length,
  };
}

async function runInsights() {
  if (batch) return;
  if (!engine.ready) { toast('Install or choose an engine first.'); showTab('engines'); return; }
  if (play) { toast('Finish or resign the current game first.'); return; }
  const fromList = $('ins-source').value === 'fetched';
  let src = fromList ? gameList.map((g) => ({ pgn: g.pgn, tc: g.tc, ts: g.ts })) : loadLibrary().map((g) => ({ pgn: g.pgn, ts: Date.parse(g.date) }));
  if (!src.length) {
    setStatus('ins-status', fromList ? 'Fetch your games in the Games tab first (Import by username).' : 'Your library is empty. Save some games first.', true);
    return;
  }
  src = src.slice(0, Number($('ins-count').value));
  const depth = Number($('ins-depth').value);
  await cancelReview();
  retry = null;
  drill = null;
  batch = { done: 0, total: src.length, cancel: false };
  $('ins-run').disabled = true;
  $('ins-cancel').hidden = false;
  setStatus('ins-status', '');
  await engine.stop();
  renderAll();
  renderLive();
  let added = 0, failed = 0;
  for (const g of src) {
    if (batch.cancel) break;
    setProgress($('ins-progress'), (batch.done / batch.total) * 100, `${batch.done} / ${batch.total}`);
    renderLive();
    let rec = null;
    try { rec = await reviewHeadless(g.pgn, depth, g); } catch { failed++; batch.done++; continue; }
    if (!rec) break;   // engine stopped or cancelled
    if (!rec.skip) {
      const map = loadInsights();
      if (!map[rec.key] || map[rec.key].depth < rec.depth) added++;
      map[rec.key] = rec;
      storeInsights(map);
    }
    batch.done++;
    renderInsights();
  }
  const cancelled = batch.cancel || batch.done < batch.total;
  batch = null;
  $('ins-run').disabled = false;
  $('ins-cancel').hidden = true;
  $('ins-progress').hidden = true;
  setStatus('ins-status', `${cancelled ? 'Stopped early. ' : ''}${added} game${added === 1 ? '' : 's'} analysed${failed ? `, ${failed} could not be read` : ''}.`);
  renderInsights();
  renderAll();
  analyze();
}

function renderInsights() {
  const all = Object.values(loadInsights());
  const el = $('ins-result');
  if (!all.length) { el.innerHTML = ''; return; }
  // The player is whoever appears in the most games, unless a name was typed.
  let who = $('ins-player').value.trim();
  if (!who) {
    const tally = {};
    for (const g of all) for (const nm of [g.white, g.black]) tally[nm] = (tally[nm] || 0) + 1;
    who = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
  }
  const lw = who.toLowerCase();
  const mine = all.filter((g) => g.white.toLowerCase() === lw || g.black.toLowerCase() === lw)
    .map((g) => {
      const c = g.white.toLowerCase() === lw ? 'w' : 'b';
      const score = g.result === '1/2-1/2' ? 0.5 : (g.result === '1-0') === (c === 'w') ? 1 : g.result === '*' ? null : 0;
      return { g, c, acc: g.accuracy[c], score, counts: g.counts[c] || {}, phases: g.phases ? g.phases[c] : null };
    }).filter((x) => x.acc != null).sort((a, b) => a.g.ts - b.g.ts);
  if (!mine.length) { el.innerHTML = `<p class="hint">No analysed games found for "${esc(who)}".</p>`; return; }

  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const f1 = (x) => (x == null ? '–' : x.toFixed(1));
  const pct = (xs) => { const s = xs.filter((x) => x.score != null); return s.length ? `${Math.round(avg(s.map((x) => x.score)) * 100)}%` : '–'; };
  const overall = avg(mine.map((x) => x.acc));
  const tone = (a) => (a == null ? '' : a >= overall + 2 ? ' high' : a <= overall - 2 ? ' low' : '');
  const group = (keyOf) => {
    const m = new Map();
    for (const x of mine) { const k = keyOf(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  };
  const table = (title, head, rows) => `<h3>${title}</h3><table class="mini"><tr><th>${head}</th><th class="num">Games</th><th class="num">Score</th><th class="num">Accuracy</th></tr>${
    rows.map(([k, xs]) => `<tr><td class="name" title="${esc(k)}">${esc(k)}</td><td class="num">${xs.length}</td><td class="num">${pct(xs)}</td><td class="num${tone(avg(xs.map((x) => x.acc)))}">${f1(avg(xs.map((x) => x.acc)))}</td></tr>`).join('')}</table>`;

  const phaseAvg = (ph) => {
    let sum = 0, n = 0;
    for (const x of mine) { const p = x.phases && x.phases[ph]; if (p && p.n) { sum += p.acc * p.n; n += p.n; } }
    return n ? { acc: sum / n, n } : null;
  };
  const per = (cls) => avg(mine.map((x) => x.counts[cls] || 0));
  const total = (cls) => mine.reduce((s, x) => s + (x.counts[cls] || 0), 0);
  const pts = mine.map((x, i) => `${mine.length === 1 ? 0.5 : i / (mine.length - 1)},${(100 - x.acc).toFixed(1)}`);
  const lo = Math.min(...mine.map((x) => x.acc)), hi = Math.max(...mine.map((x) => x.acc));

  el.innerHTML = `
    <h3>${esc(who)} · ${mine.length} game${mine.length === 1 ? '' : 's'}</h3>
    <div class="stat-row">
      <div class="stat"><div class="v">${f1(overall)}</div><div class="l">accuracy</div></div>
      <div class="stat"><div class="v">${pct(mine)}</div><div class="l">score</div></div>
      <div class="stat"><div class="v">${f1(avg(mine.filter((x) => x.c === 'w').map((x) => x.acc)))}</div><div class="l">as White</div></div>
      <div class="stat"><div class="v">${f1(avg(mine.filter((x) => x.c === 'b').map((x) => x.acc)))}</div><div class="l">as Black</div></div>
    </div>
    ${mine.length > 2 ? `<svg class="spark" viewBox="0 ${(100 - hi - 3).toFixed(1)} 1 ${(hi - lo + 6).toFixed(1)}" preserveAspectRatio="none"><polyline points="${pts.join(' ')}" fill="none" stroke="#81b64c" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
    <p class="hint small" style="margin-top:4px">Accuracy per game, oldest to newest (${f1(lo)} to ${f1(hi)}).</p>` : ''}
    <h3>By phase</h3>
    <table class="mini"><tr><th>Phase</th><th class="num">Accuracy</th></tr>${
      PHASES.map((p) => `<tr><td>${p[0].toUpperCase() + p.slice(1)}</td><td class="num">${accCell(phaseAvg(p))}</td></tr>`).join('')}</table>
    <h3>Per game, on average</h3>
    <table class="mini"><tr><th>Move type</th><th class="num">Per game</th><th class="num">Total</th></tr>${
      ['blunder', 'miss', 'mistake', 'inaccuracy', 'great', 'brilliant'].map((k) => `<tr><td><span class="ci ci-${k}">${CLASSES[k].glyph}</span>${CLASSES[k].label}</td><td class="num">${per(k).toFixed(1)}</td><td class="num">${total(k)}</td></tr>`).join('')}</table>
    ${table('By opening', 'Opening', group((x) => (x.g.opening ? x.g.opening[1].split(':')[0] : 'Unknown')).slice(0, 8))}
    ${table('By time control', 'Time control', group((x) => x.g.tc || 'other'))}
    ${table('By colour', 'Colour', group((x) => (x.c === 'w' ? 'White' : 'Black')))}
    <p class="hint small">Green and red mark results at least two points above or below your overall accuracy. Small samples are not reliable.</p>`;
}

// ---------------------------------------------------------------- position editor
let ed = null;

function editorFen() {
  const rights = [...document.querySelectorAll('#editor [data-castle]')].filter((c) => c.checked).map((c) => c.dataset.castle).join('');
  return piecesToFen(ed.pieces, $('editor-turn').value, rights);
}

function renderEditor() {
  let html = '';
  for (let r = 8; r >= 1; r--) {
    for (let f = 0; f < 8; f++) {
      const sq = 'abcdefgh'[f] + r, p = ed.pieces[sq];
      html += `<div class="${(f + r) % 2 === 1 ? 'dark' : 'light'}" data-sq="${sq}"${p ? ` style="background-image:url(pieces/${settings.pieceSet}/${p}.svg)"` : ''}></div>`;
    }
  }
  $('editor-board').innerHTML = html;
  $('editor-palette').innerHTML = ['w', 'b'].flatMap((c) => [...'KQRBNP'].map((t) => c + t))
    .map((p) => `<button data-tool="${p}" class="${ed.tool === p ? 'on' : ''}" style="background-image:url(pieces/${settings.pieceSet}/${p}.svg)"></button>`).join('') +
    `<button data-tool="x" class="erase${ed.tool === 'x' ? ' on' : ''}">Eraser</button>`;
  const fen = editorFen(), bad = positionError(fen);
  const el = $('editor-fen');
  el.textContent = bad ? `Not a legal position yet: ${bad}` : fen;
  el.className = `status${bad ? ' err' : ''}`;
  $('editor-ok').disabled = !!bad;
}

function openEditor() {
  const parts = game.current.fen.split(' ');
  ed = { pieces: fenToPieces(game.current.fen), tool: 'wP' };
  $('editor-turn').value = parts[1];
  document.querySelectorAll('#editor [data-castle]').forEach((c) => { c.checked = parts[2].includes(c.dataset.castle); });
  $('editor').hidden = false;
  renderEditor();
}

// ---------------------------------------------------------------- library
function loadLibrary() {
  try { return JSON.parse(localStorage.getItem('chesslens-games') || '[]'); } catch { return []; }
}
function storeLibrary(list) {
  try { localStorage.setItem('chesslens-games', JSON.stringify(list)); return true; } catch { toast('The library could not be saved.', true); return false; }
}

function saveToLibrary() {
  const n = mainline().length;
  if (!n) { toast('There is no game to save yet.'); return; }
  const h = game.headers;
  const list = loadLibrary();
  list.unshift({
    id: Date.now(), date: new Date().toISOString(), white: h.White || 'White', black: h.Black || 'Black',
    result: h.Result || '*', acc: game.review ? game.review.accuracy : null, moves: Math.ceil(n / 2), pgn: toPgn({ annotate: true }),
  });
  if (storeLibrary(list.slice(0, 300))) { renderLibrary(); toast('Saved to the library.'); }
}

function renderLibrary() {
  const list = loadLibrary();
  $('library').innerHTML = list.length ? list.map((g) => `
    <div class="game lib" data-lib="${g.id}">
      <div>${esc(g.white)} vs ${esc(g.black)}</div>
      <div class="res">${esc(String(g.result).replace('1/2-1/2', '½-½'))}</div>
      <button class="del" data-del="${g.id}" title="Remove from library">×</button>
      <div class="meta">${esc(new Date(g.date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))} · ${g.moves} moves${g.acc && g.acc.w != null && g.acc.b != null ? ` · accuracy ${g.acc.w.toFixed(1)} / ${g.acc.b.toFixed(1)}` : ''}</div>
    </div>`).join('') : '<p class="hint">Games you save appear here.</p>';
}

// ---------------------------------------------------------------- game import
let gameList = [];

function splitPgn(text) {
  return text.split(/(?=^\[Event\s)/m).map((s) => s.trim()).filter(Boolean);
}

function loadText(text) {
  text = text.trim();
  if (!text) return;
  if (validateFen(text).ok) {
    const bad = positionError(text);
    if (bad) { setStatus('games-status', `That position is not legal: ${bad}.`, true); return; }
    newGame(text);
    renderAll();
    analyze();
    showTab('analysis');
    return;
  }
  const parts = splitPgn(text);
  if (parts.length > 1) {
    gameList = parts.map((pgn) => {
      const tag = (k) => (new RegExp(`\\[${k}\\s+"([^"]*)"`).exec(pgn) || [])[1] || '';
      return { white: tag('White') || '?', black: tag('Black') || '?', wr: tag('WhiteElo'), br: tag('BlackElo'), result: tag('Result'), meta: [tag('Event'), tag('Date')].filter(Boolean).join(' · '), pgn };
    });
    renderGameList();
    setStatus('games-status', `${parts.length} games found. Pick one.`);
    return;
  }
  try {
    loadPgn(text);
    showTab('analysis');
  } catch (e) {
    setStatus('games-status', `That text is not a valid PGN or FEN (${e.message || e}).`, true);
  }
}

function renderGameList(userName) {
  const u = (userName || '').toLowerCase();
  $('game-list').innerHTML = gameList.map((g, i) => {
    let cls = '';
    if (u && g.result !== '½-½' && g.result !== '1/2-1/2') {
      const userWhite = g.white.toLowerCase() === u;
      cls = (g.result === '1-0') === userWhite ? 'win' : 'loss';
    }
    return `<div class="game" data-game="${i}">
      <div>${esc(g.white)}${g.wr ? ` (${esc(g.wr)})` : ''} vs ${esc(g.black)}${g.br ? ` (${esc(g.br)})` : ''}</div>
      <div class="res ${cls}">${esc(g.result.replace('1/2-1/2', '½-½'))}</div>
      <div class="meta">${esc(g.meta)}</div></div>`;
  }).join('');
  $('game-list').dataset.user = userName || '';
}

async function fetchGames() {
  const site = $('site-select').value;
  const user = $('site-user').value.trim();
  if (!user) { setStatus('games-status', 'Type a username first.', true); return; }
  settings.lastUser = { ...(settings.lastUser || {}), [site]: user };
  save();
  setStatus('games-status', 'Fetching games…');
  $('game-list').innerHTML = '';
  const day = (ms) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  try {
    if (site === 'chesscom') {
      const base = `https://api.chess.com/pub/player/${encodeURIComponent(user.toLowerCase())}/games/archives`;
      const archives = JSON.parse(await invoke('http_get', { url: base })).archives || [];
      let list = [];
      for (let i = archives.length - 1; i >= 0 && list.length < 25 && i >= archives.length - 3; i--) {
        const month = JSON.parse(await invoke('http_get', { url: archives[i] })).games || [];
        list = list.concat(month.reverse());
      }
      gameList = list.filter((g) => g.pgn && g.rules === 'chess').slice(0, 50).map((g) => ({
        white: g.white.username, black: g.black.username, wr: g.white.rating, br: g.black.rating,
        result: g.white.result === 'win' ? '1-0' : g.black.result === 'win' ? '0-1' : '½-½',
        meta: `${g.time_class} · ${day(g.end_time * 1000)}`, pgn: g.pgn, tc: g.time_class, ts: g.end_time * 1000,
      }));
    } else {
      const url = `https://lichess.org/api/games/user/${encodeURIComponent(user)}?max=40&pgnInJson=true&opening=true&clocks=true`;
      const body = await invoke('http_get', { url, accept: 'application/x-ndjson' });
      const who = (p) => p.user?.name || (p.aiLevel ? `Stockfish level ${p.aiLevel}` : 'Anonymous');
      gameList = body.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((g) => g.variant === 'standard' && g.pgn).map((g) => ({
        white: who(g.players.white), black: who(g.players.black), wr: g.players.white.rating, br: g.players.black.rating,
        result: g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : '½-½',
        meta: `${g.speed} · ${day(g.createdAt)}${g.opening ? ` · ${g.opening.name}` : ''}`, pgn: g.pgn, tc: g.speed, ts: g.createdAt,
      }));
    }
    renderGameList(user);
    setStatus('games-status', gameList.length ? `${gameList.length} recent games. Click one to load it.` : 'No standard games found for that player.');
  } catch (e) {
    setStatus('games-status', String(e) === 'not-found' ? `No player called "${user}" was found.` : String(e.message || e), true);
  }
}

// ---------------------------------------------------------------- wiring
function wire() {
  $('tabs').addEventListener('click', (e) => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); });

  $('moves').addEventListener('click', (e) => {
    const el = e.target.closest('[data-id]');
    if (el) goto(nodes.get(Number(el.dataset.id)));
  });
  // Clicking a move in an engine line plays the line up to that move; hovering previews it.
  $('lines').addEventListener('click', (e) => {
    if (e.target.dataset.restart) { engineExits = []; engineDown = false; renderLive(); activateEngine(settings.engineId); return; }
    const { line, k } = e.target.dataset;
    if (line === undefined || live.node !== game.current || !live.lines[line]) return;
    const pv = live.lines[line].pv.slice(0, Number(k) + 1);
    preview = null;
    for (const u of pv) if (!addMove(u.slice(0, 2), u.slice(2, 4), u[4])) break;
    skipAnim = pv.length > 1;
    renderAll();
    analyze();
  });
  $('lines').addEventListener('mouseover', (e) => {
    const { line, k } = e.target.dataset;
    if (line === undefined) return;
    preview = { line: Number(line), k: Number(k) };
    renderBoard();
  });
  $('lines').addEventListener('mouseleave', () => { if (preview) { preview = null; renderBoard(); } });
  $('book').addEventListener('click', (e) => {
    const b = e.target.closest('[data-from]');
    if (b) playMove(b.dataset.from, b.dataset.to, b.dataset.promo || undefined);
  });
  $('coach').addEventListener('click', (e) => {
    if (e.target.dataset.retry) startRetry([nodes.get(Number(e.target.dataset.retry))]);
  });
  $('key-prev').onclick = () => keyStep(-1);
  $('key-next').onclick = () => keyStep(1);

  // retry
  $('retry-hint').onclick = () => { (retry || drill).hint = true; renderBoard(); };
  $('retry-answer').onclick = () => (retry ? retrySolved(`The best move was <b>${esc(retry.items[retry.idx].rev.bestSan)}</b>.`, false) : drillShow());
  $('retry-next').onclick = () => (retry ? retryNext() : drillNext());
  $('retry-exit').onclick = () => (retry ? exitRetry() : exitDrill());

  // play
  $('play-level').innerHTML = LEVELS.map((l, i) => `<option value="${i}">${l.name}${l.elo ? ` (about ${l.elo})` : ''}</option>`).join('');
  $('play-level').value = String(settings.playLevel);
  $('play-start').onclick = startPlay;
  $('play-takeback').onclick = takeBack;
  $('play-resign').onclick = () => { if (play) endPlay(play.color === 'w' ? '0-1' : '1-0', 'You resigned.'); };

  // threats, layout
  $('threat-toggle').classList.toggle('on', settings.threats);
  $('threat-toggle').onclick = () => {
    settings.threats = !settings.threats;
    save();
    $('threat-toggle').classList.toggle('on', settings.threats);
    analyze();
  };
  const sp = $('splitter');
  sp.addEventListener('pointerdown', (e) => { sp.setPointerCapture(e.pointerId); sp.classList.add('drag'); });
  sp.addEventListener('pointermove', (e) => {
    if (!sp.classList.contains('drag')) return;
    settings.panelW = Math.round(Math.max(340, Math.min(820, window.innerWidth - 380, window.innerWidth - e.clientX - 18)));
    applyLayout();
  });
  sp.addEventListener('pointerup', () => { sp.classList.remove('drag'); save(); });
  $('nav-focus').onclick = toggleFocus;
  $('focus-exit').onclick = toggleFocus;

  // repertoire
  $('rep-add').onclick = addRepLine;
  $('rep-train').onclick = () => startDrill();
  $('rep-train-w').onclick = () => startDrill('w');
  $('rep-train-b').onclick = () => startDrill('b');
  $('rep-list').addEventListener('click', (e) => {
    const { del, one } = e.target.dataset;
    if (del) { storeRep(loadRep().filter((l) => String(l.id) !== del)); renderRep(); }
    if (one) startDrill(null, one);
  });

  // insights
  $('ins-run').onclick = runInsights;
  $('ins-cancel').onclick = () => { if (batch) { batch.cancel = true; engine.stop(); } };
  $('ins-clear').onclick = () => { storeInsights({}); renderInsights(); toast('Stored results removed.'); };
  $('ins-player').onchange = renderInsights;
  $('check-updates').onclick = () => checkUpdates(true);
  $('review-result').addEventListener('click', (e) => {
    const svg = e.target.closest('#timechart');
    if (!svg) return;
    const r = svg.getBoundingClientRect(), main = mainline();
    goto(main[Math.min(main.length - 1, Math.floor(((e.clientX - r.left) / r.width) * main.length))]);
  });

  // editor
  $('open-editor').onclick = openEditor;
  $('editor-board').addEventListener('click', (e) => {
    const sq = e.target.dataset.sq;
    if (!sq) return;
    if (ed.tool === 'x' || ed.pieces[sq] === ed.tool) delete ed.pieces[sq];
    else ed.pieces[sq] = ed.tool;
    renderEditor();
  });
  $('editor-palette').addEventListener('click', (e) => { if (e.target.dataset.tool) { ed.tool = e.target.dataset.tool; renderEditor(); } });
  $('editor').addEventListener('change', renderEditor);
  $('editor-start').onclick = () => { ed.pieces = fenToPieces(START); document.querySelectorAll('#editor [data-castle]').forEach((c) => { c.checked = true; }); $('editor-turn').value = 'w'; renderEditor(); };
  $('editor-clear').onclick = () => { ed.pieces = {}; renderEditor(); };
  $('editor-cancel').onclick = () => { $('editor').hidden = true; };
  $('editor-ok').onclick = () => {
    const fen = editorFen();
    if (positionError(fen)) return;
    $('editor').hidden = true;
    newGame(fen);
    renderAll();
    analyze();
    showTab('analysis');
  };

  // library and export
  $('lib-save').onclick = saveToLibrary;
  $('library').addEventListener('click', (e) => {
    const del = e.target.dataset.del;
    if (del) { storeLibrary(loadLibrary().filter((g) => String(g.id) !== del)); renderLibrary(); return; }
    const row = e.target.closest('[data-lib]');
    const g = row && loadLibrary().find((x) => String(x.id) === row.dataset.lib);
    if (!g) return;
    try { loadPgn(g.pgn); showTab('analysis'); } catch (err) { toast(`That game could not be read (${err.message || err}).`, true); }
  });
  $('pgn-copy-notes').onclick = async () => {
    const pgn = toPgn({ annotate: true });
    try { await navigator.clipboard.writeText(pgn); toast('PGN with grades copied.'); }
    catch { $('pgn-input').value = pgn; $('pgn-input').select(); toast('PGN placed in the text box.'); }
  };
  $('pgn-save-file').onclick = async () => {
    const h = game.headers;
    const name = `${h.White || 'White'}-vs-${h.Black || 'Black'}`.replace(/[^\w.-]+/g, '_').slice(0, 80) + '.pgn';
    try {
      const path = await invoke('save_text_file', { name, contents: toPgn({ annotate: true }) });
      if (path) toast(`Saved to ${path}`);
    } catch (err) { toast(String(err), true); }
  };
  $('graph-wrap').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const seq = [game.root, ...mainline()];
    goto(seq[Math.round(((e.clientX - r.left) / r.width) * (seq.length - 1))]);
  });

  const step = (d) => {
    const n = game.current;
    if (d < 0) goto(n.parent);
    else goto(n.children[0]);
  };
  $('nav-prev').onclick = () => step(-1);
  $('nav-next').onclick = () => step(1);
  $('nav-start').onclick = () => goto(game.root);
  $('nav-end').onclick = () => { let n = game.current; while (n.children.length) n = n.children[0]; goto(n); };
  $('nav-flip').onclick = flip;
  $('nav-delete').onclick = deleteCurrent;
  $('nav-new').onclick = () => { newGame(); renderAll(); analyze(); showTab('analysis'); };
  document.addEventListener('keydown', (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' && retry) exitRetry();
    else if (e.key === 'Escape' && drill) exitDrill();
    else if (e.key === 'b' || e.key === 'B') toggleFocus();
    else if (e.shiftKey && e.key === 'ArrowLeft') keyStep(-1);
    else if (e.shiftKey && e.key === 'ArrowRight') keyStep(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'Home' || e.key === 'ArrowUp') $('nav-start').click();
    else if (e.key === 'End' || e.key === 'ArrowDown') $('nav-end').click();
    else if (e.key === 'f' || e.key === 'F') flip();
    else return;
    e.preventDefault();
  });

  // engines
  $('engine-on').checked = settings.engineOn;
  $('engine-on').onchange = (e) => { settings.engineOn = e.target.checked; save(); analyze(); };
  $('engine-select').onchange = (e) => {
    if (e.target.value === '__more') { showTab('engines'); renderEngines(); } else activateEngine(e.target.value);
  };
  $('welcome').addEventListener('click', (e) => { if (e.target.dataset.install) install(e.target.dataset.install); });
  $('welcome-file').onclick = importEngine;
  $('welcome-skip').onclick = () => { welcomeSkipped = true; renderEngines(); };
  $('quick-install').onclick = () => install('stockfish');
  $('quick-import').onclick = importEngine;
  $('import-engine').onclick = importEngine;
  $('installed').addEventListener('click', async (e) => {
    const { use, remove } = e.target.dataset;
    if (use) activateEngine(use);
    if (remove) {
      if (engineBusy()) { toast(`Wait until ${engineBusy()} is finished.`); return; }
      await invoke('remove_engine', { id: remove }).catch((err) => toast(String(err), true));
      if (remove === settings.engineId) { engine.ready = false; engine.info = null; }
      await refreshEngines();
    }
  });
  $('catalog').addEventListener('click', (e) => { if (e.target.dataset.install) install(e.target.dataset.install); });

  const num = (id, key, uci, lo, hi) => {
    const el = $(id);
    el.value = settings[key];
    el.onchange = async () => {
      const v = Math.max(lo, Math.min(hi, Math.round(Number(el.value) || lo)));
      el.value = v;
      settings[key] = v;
      save();
      if (uci) await setEngineOption(uci, v);
      if (!engineBusy()) analyze();
    };
  };
  num('set-threads', 'threads', 'Threads', 1, 512);
  num('set-hash', 'hash', 'Hash', 16, 65536);
  num('set-multipv', 'multipv', null, 1, 5);
  num('set-livedepth', 'liveDepth', null, 8, 60);

  $('advanced-body').addEventListener('change', async (e) => {
    const i = e.target.dataset.opt;
    if (i === undefined || !engine.ready) return;
    const o = engine.advancedOptions()[i];
    const v = o.type === 'check' ? String(e.target.checked) : e.target.value;
    const id = engine.info.id;
    settings.engineOpts[id] = { ...(settings.engineOpts[id] || {}), [o.name]: v };
    save();
    await setEngineOption(o.name, v === '' ? '<empty>' : v);
    if (!engineBusy()) analyze();
  });
  $('advanced-body').addEventListener('click', async (e) => {
    if (e.target.id === 'adv-reset' && engine.ready && !engineBusy()) {
      delete settings.engineOpts[engine.info.id];
      save();
      await activateEngine(engine.info.id);
      toast('Options reset.');
      return;
    }
    const i = e.target.dataset.opt;
    if (e.target.tagName !== 'BUTTON' || i === undefined || !engine.ready || engineBusy()) return;
    await engine.configure(engine.advancedOptions()[i].name);
    analyze();
  });

  // review
  $('review-depth').value = String(settings.reviewDepth);
  $('review-start').onclick = () => runReview();
  $('review-cancel').onclick = () => { cancelReview(); };
  $('review-result').addEventListener('click', (e) => {
    const row = e.target.closest('[data-cls]');
    if (!row) return;
    const hits = mainline().filter((n) => n.rev && n.rev.cls === row.dataset.cls);
    if (!hits.length) return;
    const next = hits.find((n) => n.ply > game.current.ply) || hits[0];
    goto(next);
    showTab('analysis');
  });
  $('review-result').addEventListener('click', (e) => {
    const side = e.target.dataset.retrySide;
    if (side !== undefined) startRetry(retryItems(side || undefined));
  });

  // games
  $('pgn-load').onclick = () => { setStatus('games-status', ''); loadText($('pgn-input').value); };
  $('pgn-file-btn').onclick = () => $('pgn-file').click();
  $('pgn-file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const text = await f.text();
    $('pgn-input').value = text.length < 20000 ? text : '';
    setStatus('games-status', '');
    loadText(text);
    e.target.value = '';
  };
  $('pgn-copy').onclick = async () => {
    const pgn = toPgn();
    try { await navigator.clipboard.writeText(pgn); toast('PGN copied.'); }
    catch { $('pgn-input').value = pgn; $('pgn-input').select(); toast('PGN placed in the text box.'); }
  };
  $('site-fetch').onclick = fetchGames;
  $('site-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchGames(); });
  $('site-select').onchange = () => { $('site-user').value = settings.lastUser?.[$('site-select').value] || ''; };
  $('site-user').value = settings.lastUser?.chesscom || '';
  $('game-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-game]');
    if (!row) return;
    try {
      loadPgn(gameList[row.dataset.game].pgn, { userName: $('game-list').dataset.user });
      showTab('analysis');
    } catch (err) {
      setStatus('games-status', `That game could not be read (${err.message || err}).`, true);
    }
  });

  // appearance
  $('board-themes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme]');
    if (b) { settings.boardTheme = b.dataset.theme; save(); renderSettings(); }
  });
  $('piece-sets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-set]');
    if (b) { settings.pieceSet = b.dataset.set; save(); renderSettings(); renderBoard(); }
  });
  setVolume(settings.volume / 100);
  setSoundStyle(settings.soundStyle);
  $('set-soundstyle').value = settings.soundStyle;
  $('set-soundstyle').onchange = (e) => { settings.soundStyle = e.target.value; setSoundStyle(settings.soundStyle); save(); if (settings.sound) playSound('move'); };
  $('set-volume').value = settings.volume;
  $('set-volume').oninput = (e) => { settings.volume = Number(e.target.value); setVolume(settings.volume / 100); save(); };
  $('set-volume').onchange = () => { if (settings.sound) playSound('move'); };
  $('set-auto').onchange = (e) => { settings.autoReview = e.target.checked; save(); analyze(); };
  for (const [id, key] of [['set-coords', 'coords'], ['set-arrow', 'arrow'], ['set-legal', 'legal'], ['set-anim', 'anim'], ['set-sound', 'sound'], ['set-book', 'book']]) {
    $(id).checked = settings[key];
    $(id).onchange = (e) => { settings[key] = e.target.checked; save(); renderBoard(); renderOpening(); };
  }
}

function flip() {
  if (play || retry || drill) return;
  board.orientation = board.orientation === 'w' ? 'b' : 'w';
  renderAll();
}

// ---------------------------------------------------------------- self test (`chesslens --selftest`)
const OPERA = '[White "Paul Morphy"]\n[Black "Duke Karl / Count Isouard"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0';

const FISCHER = '[White "Donald Byrne"]\n[Black "Robert James Fischer"]\n[Result "0-1"]\n\n1. Nf3 Nf6 2. c4 g6 3. Nc3 Bg7 4. d4 O-O 5. Bf4 d5 6. Qb3 dxc4 7. Qxc4 c6 8. e4 Nbd7 9. Rd1 Nb6 10. Qc5 Bg4 11. Bg5 Na4 12. Qa3 Nxc3 13. bxc3 Nxe4 14. Bxe7 Qb6 15. Bc4 Nxc3 16. Bc5 Rfe8+ 17. Kf1 Be6 18. Bxb6 Bxc4+ 19. Kg1 Ne2+ 20. Kf1 Nxd4+ 21. Kg1 Ne2+ 22. Kf1 Nc3+ 23. Kg1 axb6 24. Qb4 Ra4 25. Qxb6 Nxd1 26. h3 Rxa2 27. Kh2 Nxf2 28. Re1 Rxe1 29. Qd8+ Bf8 30. Nxe1 Bd5 31. Nf3 Ne4 32. Qb8 b5 33. h4 h5 34. Ne5 Kg7 35. Kg1 Bc5+ 36. Kf1 Ng3+ 37. Ke1 Bb4+ 38. Kd1 Bb3+ 39. Kc1 Ne2+ 40. Kb1 Nc3+ 41. Kc1 Rc2# 0-1';

let sysArgs = [];
async function selfTest() {
  const log = (s) => invoke('log_line', { line: `[selftest] ${s}` });
  try {
    await log(`engines installed: ${engines.map((e) => e.name).join(', ') || 'none'}`);
    const want = (sysArgs.find((a) => a.startsWith('--engine=')) || '').slice(9) || 'stockfish';
    if (!engines.some((e) => e.id === want)) {
      await log(`installing ${want}`);
      await install(want);
      if (!engines.some((e) => e.id === want)) throw new Error('install failed');
    }
    for (let i = 0; i < 100 && !engine.ready; i++) await new Promise((r) => setTimeout(r, 100));
    if (!engine.ready) throw new Error('engine did not start');
    await log(`engine ready: ${engine.info.name}, ${engine.options.length} options`);
    loadPgn(OPERA);
    $('review-depth').value = '12';
    const t0 = performance.now();
    const result = await runReview();
    if (!result) throw new Error('review returned nothing');
    await log(`review took ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    await log(`accuracy white ${result.accuracy.w.toFixed(1)} black ${result.accuracy.b.toFixed(1)}; opening ${result.opening?.[1]}`);
    const main = mainline();
    for (const [i, r] of result.moves.entries()) {
      await log(`${moveLabel(main[i], true)} ${main[i].move.san} -> ${r.cls} (loss ${r.loss.toFixed(1)}) ${r.text}`);
    }
    settings.autoReview = false;   // keep background reviews out of the remaining checks

    // advanced options
    renderAdvanced();
    const adv = engine.advancedOptions();
    await log(`advanced options: ${adv.length} reported, ${document.querySelectorAll('#advanced-body [data-opt]').length} controls drawn`);
    const spin = adv.find((o) => o.type === 'spin');
    if (spin) {
      await engine.configure(spin.name, spin.default);
      const r = await engine.search(START, { depth: 8, multipv: 2 });
      await log(`set ${spin.name}=${spin.default}; search after change: ${r ? `${r.lines.length} lines, bestmove ${r.bestmove}` : 'FAILED'}`);
      if (!r) throw new Error('search failed after setoption');
    }

    // adding an engine by path (what the file picker does after you choose a file)
    const again = await invoke('add_engine_path', { path: engine.info.path });
    await log(`add by path: ${again.name} (${again.source})`);

    // annotated PGN round trip, retry list, key moves
    const noted = toPgn({ annotate: true });
    await log(`retry items: ${retryItems().length}; key moves: ${keyMoves().length}`);
    loadPgn(noted);
    if (mainline().length !== main.length) throw new Error(`annotated PGN reloaded with ${mainline().length} plies, expected ${main.length}`);
    await log(`annotated PGN reloads: ${mainline().length} plies; sample: ${noted.split('\n').pop() || noted.slice(-160)}`.slice(0, 400));

    // a second sample game with two famous sacrifices
    loadPgn(FISCHER);
    const r2 = await runReview();
    if (!r2) throw new Error('second review returned nothing');
    const m2 = mainline();
    await log(`Byrne-Fischer: accuracy ${r2.accuracy.w.toFixed(1)} / ${r2.accuracy.b.toFixed(1)}`);
    for (const [i, r] of r2.moves.entries()) {
      if (KEY.includes(r.cls) || r.cls === 'inaccuracy') await log(`  ${moveLabel(m2[i], true)} ${m2[i].move.san} -> ${r.cls}`);
    }

    // play against the engine
    $('play-side').value = 'b';
    $('play-level').value = '0';
    await startPlay();
    const waitFor = async (test, ms = 15000) => { for (let t = 0; t < ms && !test(); t += 100) await new Promise((r) => setTimeout(r, 100)); return test(); };
    if (!await waitFor(() => mainline().length >= 1 && !play.thinking)) throw new Error('engine made no first move');
    handleBoardMove('e7', 'e5');
    if (!await waitFor(() => mainline().length >= 3 && !play.thinking)) throw new Error('engine did not reply');
    await log(`play: ${mainline().map((n) => n.move.san).join(' ')}; limited by ${play.byElo ? 'rating' : 'depth'}`);
    takeBack();
    await log(`after take back: ${mainline().length} ply, your turn: ${game.current.fen.split(' ')[1] === play.color}`);
    await endPlay('1-0', 'Test game stopped.');
    const full = await engine.search(START, { depth: 10, multipv: 1 });
    await log(`engine back to full strength search: ${full ? 'ok' : 'FAILED'}`);

    // importing by username (public accounts of well-known players)
    for (const [site, user] of [['lichess', 'DrNykterstein'], ['chesscom', 'hikaru']]) {
      $('site-select').value = site;
      $('site-user').value = user;
      await fetchGames();
      await log(`${site}: ${gameList.length} games; "${$('games-status').textContent}"`);
      if (!gameList.length) throw new Error(`${site} import returned no games`);
      loadPgn(gameList[0].pgn, { userName: user });
      await log(`  first game: ${mainline().length} plies, ${game.headers.White} vs ${game.headers.Black}, clock on move 1: ${mainline()[0]?.clk}`);
    }
    // phases and time chart on the last imported game (it has clocks)
    $('review-depth').value = '12';
    const r3 = await runReview();
    if (!r3) throw new Error('third review returned nothing');
    const ph = (c) => PHASES.map((p) => `${p} ${r3.phases[c][p].n ? r3.phases[c][p].acc.toFixed(0) : '-'}`).join(', ');
    await log(`phases white: ${ph('w')}; black: ${ph('b')}`);
    const spent = timeSpent();
    await log(`time chart drawn: ${!!document.getElementById('timechart')}; moves with a time: ${spent ? spent.filter((x) => x != null).length : 0}`);

    // threats
    settings.threats = true;
    goto(mainline()[24]);
    await waitFor(() => game.current.threat !== undefined && live.lines.length > 0, 20000);
    await log(`threat at move 13: ${JSON.stringify(game.current.threat)}; row shown: ${!!document.querySelector('.pv.threat')}`);
    settings.threats = false;

    // insights over the fetched list
    $('ins-source').value = 'fetched';
    $('ins-count').value = '10';
    $('ins-depth').value = '10';
    const t1 = performance.now();
    await runInsights();
    await log(`insights (${((performance.now() - t1) / 1000).toFixed(0)}s): "${$('ins-status').textContent}"`);
    await log(`  result: ${$('ins-result').textContent.replace(/\s+/g, ' ').slice(0, 520)}`);
    if (!Object.keys(loadInsights()).length) throw new Error('insights stored nothing');

    // repertoire quiz
    newGame();
    board.orientation = 'w';
    for (const [a, b] of [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'b5']]) addMove(a, b);
    addRepLine();
    startDrill();
    handleBoardMove('d2', 'd4');
    const wrongMsg = drill.msg;
    handleBoardMove('e2', 'e4');
    await new Promise((r) => setTimeout(r, 700));
    handleBoardMove('g1', 'f3');
    await new Promise((r) => setTimeout(r, 700));
    handleBoardMove('f1', 'b5');
    await new Promise((r) => setTimeout(r, 700));
    await log(`repertoire: "${loadRep()[0].name}"; wrong try -> ${wrongMsg.replace(/<[^>]+>/g, '')}; end state ${drill.state}, moves ${mainline().map((n) => n.move.san).join(' ')}`);
    if (drill.state !== 'solved') throw new Error('repertoire line was not completed');
    exitDrill();

    // engine update check
    const upd = await invoke('check_updates');
    await log(`update check: ${upd.length ? upd.map((u) => u.join(' -> ')).join(', ') : 'everything up to date'}`);

    // loading a game in the middle of a game against the engine must still start analysis
    $('play-side').value = 'w';
    await startPlay();
    handleBoardMove('e2', 'e4');
    loadPgn(OPERA);
    goto(mainline()[9]);
    const resumed = await waitFor(() => live.node === game.current && live.lines.length > 0, 15000);
    await log(`analysis after loading a game mid-play: ${resumed ? 'running' : 'NOT running'}; play mode off: ${!play}`);
    if (!resumed) throw new Error('analysis did not start after loading a game during play');

    // grading still happens when live depth is below the usual grading depth
    settings.autoReview = true;
    settings.liveDepth = 10;
    newGame();
    renderAll();
    for (const [a, b] of [['a2', 'a3'], ['a7', 'a5'], ['h2', 'h3'], ['h7', 'h5'], ['g2', 'g4']]) { playMove(a, b); await new Promise((r) => setTimeout(r, 50)); }
    const graded = await waitFor(() => !!game.current.rev, 20000);
    await log(`grading at live depth 10: ${graded ? game.current.rev.cls : 'NOT graded'}`);
    if (!graded) throw new Error('move was not graded at live depth 10');
    settings.autoReview = false;

    // a setting changed during a review is deferred, not allowed to cancel it
    loadPgn(OPERA);
    const rv = runReview();
    await new Promise((r) => setTimeout(r, 300));
    await setEngineOption('Threads', settings.threads);
    const r4 = await rv;
    await log(`review with a setting changed mid-way: ${r4 ? 'completed' : 'CANCELLED'}; deferred options: ${pendingOptions.size}`);
    if (!r4) throw new Error('changing a setting cancelled the review');

    // the engine process dying is recovered from
    await invoke('engine_stop');
    await waitFor(() => !engine.ready, 5000);
    const back = await waitFor(() => engine.ready, 20000);
    await log(`engine restarted after its process ended: ${back}`);
    if (!back) throw new Error('engine was not restarted');
    goto(mainline()[5]);
    const alive = await waitFor(() => live.node === game.current && live.lines.length > 0, 15000);
    await log(`analysis after restart: ${alive ? 'running' : 'NOT running'}`);
    if (!alive) throw new Error('no analysis after engine restart');

    await log('OK');
    await invoke('quit', { code: 0 });
  } catch (e) {
    await log(`FAILED: ${e.message || e}`);
    if (e.stack) await log(String(e.stack).split('\n').slice(0, 6).join(' <- '));
    await invoke('quit', { code: 1 });
  }
}

// ---------------------------------------------------------------- start
async function main() {
  applyLayout();
  board = new Board($('board'), { onMove: handleBoardMove });
  newGame();
  wire();
  renderSettings();
  renderAll();
  renderEngines();
  renderAdvanced();

  fetch('data/openings.json').then((r) => r.json()).then((o) => { openings = o; renderOpening(); analyze(); }).catch(() => {});
  preloadSounds();

  const sys = await invoke('system_info');
  if (sys.args.includes('--test')) {
    // Logic tests only: no engine is started and the window stays hidden.
    settings.autoReview = false;
    settings.sound = false;
    const log = (line) => invoke('log_line', { line });
    try {
      openings = await fetch('data/openings.json').then((r) => r.json());
      const { runTests } = await import('./tests.js');
      const { count, failures } = await runTests({ loadPgn, loadText, toPgn, mainline, goto, playMove, positionError, timeChart, terminalInfo, preloadSounds });
      for (const f of failures) await log(`FAIL  ${f}`);
      await log(`${count - failures.length} of ${count} tests passed`);
      await invoke('quit', { code: failures.length ? 1 : 0 });
    } catch (e) {
      await log(`Tests could not run: ${e.message || e}`);
      await invoke('quit', { code: 2 });
    }
    return;
  }
  if (!hadSaved) {
    settings.threads = Math.max(1, Math.min(8, Math.floor(sys.threads / 2)));
    $('set-threads').value = settings.threads;
    save();
  }
  await engine.init();
  engine.onExit = handleEngineExit;
  await listen('install-progress', onInstallProgress);
  catalog = await invoke('catalog');
  try { await refreshEngines(); } catch (e) { toast(String(e), true); }
  renderEngines();
  if (!isDesktop) $('no-engine').querySelector('p').textContent = 'Engines only run in the desktop app.';
  sysArgs = sys.args;
  if (sys.args.includes('--selftest')) selfTest();
}

// Handles for debugging from the web inspector.
window.chesslens = { engine, game, runReview, loadPgn, loadText, positionError, timeChart, settings, mainline, startRetry, retryItems, startPlay, toPgn, fetchGames, state: () => ({ retry, play, gameList }) };

main();
