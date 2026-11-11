// Small self-contained helpers: sounds, material count, clocks, rating estimate,
// and the position editor's FEN handling.

// ---------------------------------------------------------------- sounds (synthesised, no audio files)
let audio = null;
function ctx() {
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  if (audio.state === 'suspended') audio.resume();
  return audio;
}
function tone(freq, dur, { type = 'sine', gain = 0.18, at = 0 } = {}) {
  const c = ctx(), t = c.currentTime + at;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur);
}
function knock(freq, dur, { gain = 0.5, at = 0 } = {}) {
  const c = ctx(), t = c.currentTime + at;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
  src.buffer = buf;
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = 1.2;
  g.gain.value = gain;
  src.connect(f).connect(g).connect(c.destination);
  src.start(t);
}
const SOUNDS = {
  move: () => { knock(700, 0.06); tone(170, 0.07, { gain: 0.12 }); },
  capture: () => { knock(1500, 0.05, { gain: 0.7 }); knock(500, 0.09, { at: 0.02 }); tone(110, 0.1, { gain: 0.15 }); },
  castle: () => { SOUNDS.move(); knock(700, 0.06, { at: 0.11 }); tone(170, 0.07, { gain: 0.12, at: 0.11 }); },
  check: () => { SOUNDS.move(); tone(880, 0.14, { type: 'triangle', gain: 0.1, at: 0.03 }); },
  end: () => { [523, 659, 784].forEach((f, i) => tone(f, 0.28, { type: 'triangle', gain: 0.12, at: i * 0.11 })); },
  right: () => { tone(660, 0.1, { type: 'triangle', gain: 0.12 }); tone(990, 0.16, { type: 'triangle', gain: 0.12, at: 0.09 }); },
  wrong: () => { tone(200, 0.18, { type: 'square', gain: 0.05 }); },
};
export function playSound(name) {
  try { SOUNDS[name]?.(); } catch { /* no audio device */ }
}
export function soundForMove(mv, terminal) {
  if (terminal) return 'end';
  if (mv.san.includes('+')) return 'check';
  if (mv.captured) return 'capture';
  if (mv.san.startsWith('O-O')) return 'castle';
  return 'move';
}

// ---------------------------------------------------------------- material
const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const POINTS = { p: 1, n: 3, b: 3, r: 5, q: 9 };

/** Pieces each side has captured, and the point difference (positive = White ahead). */
export function material(fen) {
  const count = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const ch of fen.split(' ')[0]) {
    const t = ch.toLowerCase();
    if (t in START_COUNT) count[ch === t ? 'b' : 'w'][t]++;
  }
  const taken = (victim) => ['q', 'r', 'b', 'n', 'p'].flatMap((t) => Array(Math.max(0, START_COUNT[t] - count[victim][t])).fill(t));
  const pts = (c) => Object.entries(count[c]).reduce((s, [t, n]) => s + POINTS[t] * n, 0);
  return { w: taken('b'), b: taken('w'), diff: pts('w') - pts('b') };
}

// ---------------------------------------------------------------- clocks
/** "[%clk 0:09:58.3]" -> "9:58" (tenths kept under 20 seconds). */
export function parseClock(comment) {
  const m = /\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/.exec(comment || '');
  if (!m) return null;
  const h = +m[1], min = +m[2], sec = +m[3];
  const total = h * 3600 + min * 60 + sec;
  const ss = total < 20 ? sec.toFixed(1).padStart(4, '0') : String(Math.floor(sec)).padStart(2, '0');
  return h ? `${h}:${String(min).padStart(2, '0')}:${ss}` : `${min}:${ss}`;
}

// ---------------------------------------------------------------- rating estimate
const CURVE = [[20, 100], [50, 500], [60, 800], [70, 1100], [75, 1300], [80, 1500], [85, 1800], [90, 2100], [93, 2300], [96, 2600], [98, 2850], [100, 3200]];
/** Very rough playing strength for one game from its accuracy. Not chess.com's formula. */
export function estimateRating(acc) {
  if (acc == null) return null;
  const a = Math.max(CURVE[0][0], Math.min(100, acc));
  for (let i = 1; i < CURVE.length; i++) {
    const [x0, y0] = CURVE[i - 1], [x1, y1] = CURVE[i];
    if (a <= x1) return Math.round((y0 + ((a - x0) / (x1 - x0)) * (y1 - y0)) / 50) * 50;
  }
  return 3200;
}

// ---------------------------------------------------------------- position editor
const FILES = 'abcdefgh';
/** FEN placement -> { e1: 'wK', ... } */
export function fenToPieces(fen) {
  const out = {};
  fen.split(' ')[0].split('/').forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { f += +ch; continue; }
      out[FILES[f] + (8 - r)] = (ch === ch.toLowerCase() ? 'b' : 'w') + ch.toUpperCase();
      f++;
    }
  });
  return out;
}
/** { e1: 'wK', ... } + side to move + wanted castling letters -> FEN (castling kept only where legal). */
export function piecesToFen(pieces, turn, castling) {
  const rows = [];
  for (let r = 8; r >= 1; r--) {
    let row = '', gap = 0;
    for (const f of FILES) {
      const p = pieces[f + r];
      if (!p) { gap++; continue; }
      if (gap) { row += gap; gap = 0; }
      row += p[0] === 'w' ? p[1] : p[1].toLowerCase();
    }
    rows.push(row + (gap || ''));
  }
  const ok = { K: ['e1', 'wK', 'h1', 'wR'], Q: ['e1', 'wK', 'a1', 'wR'], k: ['e8', 'bK', 'h8', 'bR'], q: ['e8', 'bK', 'a8', 'bR'] };
  const rights = [...'KQkq'].filter((c) => castling.includes(c) && pieces[ok[c][0]] === ok[c][1] && pieces[ok[c][2]] === ok[c][3]).join('');
  return `${rows.join('/')} ${turn} ${rights || '-'} - 0 1`;
}
