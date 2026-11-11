// Small self-contained helpers: sounds, material count, clocks, rating estimate,
// and the position editor's FEN handling.

// ---------------------------------------------------------------- sounds (synthesised, no audio files)
// Soft, rounded tones: sine waves with a gentle attack and a low-pass filter, kept quiet.
let audio = null;
let master = null;
let volume = 0.6;

export function setVolume(v) {
  volume = Math.max(0, Math.min(1, v));
  if (master) master.gain.value = volume;
}

function out() {
  if (!audio) {
    audio = new (window.AudioContext || window.webkitAudioContext)();
    const soften = audio.createBiquadFilter();
    soften.type = 'lowpass';
    soften.frequency.value = 1800;
    master = audio.createGain();
    master.gain.value = volume;
    soften.connect(master).connect(audio.destination);
    audio.entry = soften;
  }
  if (audio.state === 'suspended') audio.resume();
  return audio;
}

/** One soft note. `drop` glides the pitch down a little, which reads as a muted wooden tap. */
function note(freq, dur, { gain = 0.1, at = 0, drop = 0, type = 'sine' } = {}) {
  const c = out(), t = c.currentTime + at;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (drop) o.frequency.exponentialRampToValueAtTime(freq * (1 - drop), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.012);            // no click at the start
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.entry);
  o.start(t);
  o.stop(t + dur + 0.02);
}

const tap = (at = 0, freq = 196) => { note(freq, 0.16, { gain: 0.11, at, drop: 0.25 }); note(freq * 2, 0.08, { gain: 0.03, at }); };
const SOUNDS = {
  move: () => tap(),
  capture: () => { tap(0, 147); note(110, 0.22, { gain: 0.07, at: 0.03, drop: 0.2 }); },
  castle: () => { tap(); tap(0.13, 175); },
  check: () => { tap(); note(587, 0.5, { gain: 0.035, at: 0.04 }); },
  end: () => { [262, 330, 392].forEach((f, i) => note(f, 1.1, { gain: 0.05, at: i * 0.14 })); },
  right: () => { note(523, 0.35, { gain: 0.05 }); note(659, 0.5, { gain: 0.05, at: 0.12 }); },
  wrong: () => { note(196, 0.3, { gain: 0.06, drop: 0.12 }); },
};
// Recorded board sounds (see ui/sounds/LICENSES.md). Castling plays the move sound twice.
const SAMPLE_FILES = { move: 'Move', capture: 'Capture', check: 'Check', end: 'GenericNotify' };
const samples = {};
let style = 'soft';   // 'soft' = generated tones, 'wood' = recorded sounds

export function setSoundStyle(s) { style = s; }

/** Loads and decodes the recorded sounds. Returns how many are ready. */
export async function preloadSounds() {
  try {
    const c = out();
    await Promise.all(Object.entries(SAMPLE_FILES).map(async ([name, file]) => {
      if (samples[name]) return;
      const data = await (await fetch(`sounds/${file}.ogg`)).arrayBuffer();
      samples[name] = await new Promise((ok, fail) => c.decodeAudioData(data, ok, fail));
    }));
  } catch { /* missing decoder or no audio device: the generated tones are used instead */ }
  return Object.keys(samples).length;
}

function sample(name, at = 0) {
  const buf = samples[name];
  if (!buf) return false;
  const c = out(), src = c.createBufferSource();
  src.buffer = buf;
  src.connect(master);
  src.start(c.currentTime + at);
  return true;
}

export function playSound(name) {
  try {
    if (style === 'wood') {
      if (name === 'castle' && sample('move') && sample('move', 0.14)) return;
      if (sample(name)) return;
    }
    SOUNDS[name]?.();
  } catch { /* no audio device */ }
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

/** Seconds left on the clock from a "[%clk h:mm:ss]" comment, or null. */
export function clockSeconds(comment) {
  const m = /\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/.exec(comment || '');
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
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
