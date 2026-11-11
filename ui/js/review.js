// Game review: turns engine evaluations into move classifications, accuracy
// scores and short explanations. Pure functions, no engine or DOM access.
import { Chess } from '../vendor/chess.js';

export const CLASSES = {
  brilliant: { label: 'Brilliant', glyph: '!!', color: '#26c2a3' },
  great: { label: 'Great', glyph: '!', color: '#749bbf' },
  best: { label: 'Best', glyph: '★', color: '#81b64c' },
  excellent: { label: 'Excellent', glyph: '✓', color: '#81b64c' },
  good: { label: 'Good', glyph: '✓', color: '#95b776' },
  book: { label: 'Book', glyph: '≡', color: '#d5a47d' },
  forced: { label: 'Forced', glyph: '→', color: '#97af8b' },
  inaccuracy: { label: 'Inaccuracy', glyph: '?!', color: '#f7c631' },
  mistake: { label: 'Mistake', glyph: '?', color: '#ffa459' },
  miss: { label: 'Miss', glyph: '✕', color: '#ff7769' },
  blunder: { label: 'Blunder', glyph: '??', color: '#fa412d' },
};
export const CLASS_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];

const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const PIECE_NAME = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

/** White's winning chances in percent for a score {cp} or {mate} (White's point of view). */
export function winPct(score) {
  if (!score) return 50;
  if (score.mate !== undefined) return score.mate > 0 ? 100 : score.mate < 0 ? 0 : (score.winner === 'w' ? 100 : 0);
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * score.cp)) - 1);
}

export function fmtScore(score) {
  if (!score) return '';
  if (score.mate !== undefined) {
    if (score.mate === 0) return score.winner === 'w' ? '1-0' : '0-1';
    return (score.mate < 0 ? '-M' : 'M') + Math.abs(score.mate);
  }
  const v = score.cp / 100;
  return (v > 0 ? '+' : '') + v.toFixed(Math.abs(v) >= 10 ? 1 : 2);
}

export function openingKey(fen) {
  return fen.split(' ').slice(0, 3).join(' ');
}

export function uciToMove(fen, uci) {
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  } catch {
    return null;
  }
}

/** Converts a UCI principal variation to SAN moves. */
export function pvToSan(fen, pv, max = 12) {
  const c = new Chess(fen);
  const out = [];
  for (const u of pv.slice(0, max)) {
    try {
      out.push(c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
    } catch {
      break;
    }
  }
  return out;
}

/** Material the side to move wins by capturing on `sq` (static exchange evaluation). */
function exchangeGain(chess, sq) {
  const caps = chess.moves({ verbose: true }).filter((m) => m.to === sq && m.captured);
  if (!caps.length) return 0;
  caps.sort((a, b) => VALUE[a.piece] - VALUE[b.piece]);
  const m = caps[0];
  chess.move(m);
  const gain = VALUE[m.captured] - exchangeGain(chess, sq);
  chess.undo();
  return Math.max(0, gain);
}

/** Material the opponent could already win on `sq` if it were their move (0 when unknown). */
function alreadyLosing(fen, sq) {
  const f = fen.split(' ');
  f[1] = f[1] === 'w' ? 'b' : 'w';
  f[3] = '-';
  try { return exchangeGain(new Chess(f.join(' ')), sq); } catch { return 0; }
}

/**
 * The real sacrifice a move makes, or null: { square, piece, offer }. `offer` is the
 * material the opponent can win at once, net of anything the move captured, and must be
 * worth at least two pawns. A piece that was lost anyway and sells itself does not count.
 */
function findSacrifice(move, { inCheck = false, prevOwn = null } = {}) {
  if (move.promotion) return null;
  const after = new Chess(move.after);
  if (after.isCheckmate()) return null;
  const taken = move.captured ? VALUE[move.captured] : 0;
  if (move.piece !== 'p' && move.piece !== 'k') {
    const offer = exchangeGain(after, move.to) - taken;
    if (offer >= 2 && alreadyLosing(move.before, move.from) < offer) return { square: move.to, piece: move.piece, offer };
  }
  // Answering a check, or leaving the piece that just captured to be retaken, is not an offer.
  if (inCheck) return null;
  let best = null;
  const seen = new Set([move.to]);
  if (prevOwn && prevOwn.captured) seen.add(prevOwn.to);
  for (const m of after.moves({ verbose: true })) {
    if (!m.captured || m.captured === 'p' || seen.has(m.to)) continue;
    seen.add(m.to);
    const offer = exchangeGain(after, m.to) - taken;
    if (offer >= 2 && (!best || offer > best.offer)) best = { square: m.to, piece: m.captured, offer };
  }
  return best;
}

/**
 * True when the opponent takes the offered piece in the engine's main line and the
 * material is back within the next few moves: a combination, not a sacrifice.
 */
function regainsMaterial(move, next, sac) {
  const pv = next.lines[0] ? next.lines[0].pv : [];
  if (pv.length < 3) return false;
  const c = new Chess(move.after);
  let balance = move.captured ? VALUE[move.captured] : 0;
  for (let k = 0; k < Math.min(5, pv.length); k++) {
    let m;
    try { m = c.move({ from: pv[k].slice(0, 2), to: pv[k].slice(2, 4), promotion: pv[k][4] }); } catch { return false; }
    if (k === 0 && !(m.captured && m.to === sac.square)) return false;   // declined: the offer stands
    const sign = m.color === move.color ? 1 : -1;
    if (m.captured) balance += sign * VALUE[m.captured];
    if (m.promotion) balance += sign * 8;
    if (c.isCheckmate()) return false;
  }
  return balance >= 0;
}

/** A capture that simply wins material: taking a piece that is not defended well enough. */
function isObviousCapture(move) {
  if (!move.captured || VALUE[move.captured] < 3) return false;
  return exchangeGain(new Chess(move.after), move.to) < VALUE[move.captured];
}

export const PHASES = ['opening', 'middlegame', 'endgame'];

/** Phase of the game for the position a move is played from. */
function phaseOf(fen, index, inBook) {
  let heavy = 0, queens = 0;
  for (const ch of fen.split(' ')[0]) {
    const t = ch.toLowerCase();
    if (t === 'q') { heavy += 9; queens++; } else if (t === 'r') heavy += 5; else if (t === 'b' || t === 'n') heavy += 3;
  }
  if (heavy <= 14 || (queens === 0 && heavy <= 20)) return 'endgame';
  return inBook || index < 12 ? 'opening' : 'middlegame';
}

function accuracyOf(loss) {
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
}

/**
 * positions[i] = { fen, score, lines, terminal } for the position before move i
 * (positions.length === moves.length + 1). moves[i] is a chess.js verbose move.
 * `openings` maps openingKey(fen) -> [eco, name].
 */
export function reviewGame(positions, moves, openings) {
  const out = [];
  let inBook = true;
  let opening = null;

  for (let i = 0; i < moves.length; i++) {
    const mv = moves[i];
    const pos = positions[i];
    const next = positions[i + 1];
    const white = mv.color === 'w';
    const pov = (score) => (white ? winPct(score) : 100 - winPct(score));

    const best = pos?.lines?.[0];
    const second = pos?.lines?.[1];
    const bestUci = best ? best.pv[0] : null;
    const playedUci = mv.from + mv.to + (mv.promotion || '');
    const isBest = bestUci === playedUci;
    const before = pov(pos?.score);
    const after = pov(next?.score);
    const loss = isBest ? 0 : Math.max(0, before - after);
    const bestMove = bestUci ? uciToMove(mv.before, bestUci) : null;
    mv.legalCount ??= new Chess(mv.before).moves().length;
    const legalCount = mv.legalCount;

    const book = inBook && openings && openings[openingKey(mv.after)];
    if (book) opening = book;
    else inBook = false;
    const phase = phaseOf(mv.before, i, inBook);
    // Callers re-grade the same path many times as evaluations arrive; a move whose
    // inputs have not changed keeps its previous result.
    const prevCls = out[i - 1] ? out[i - 1].cls : null;
    const memo = mv.memo;
    if (memo && memo.pos === pos && memo.next === next && memo.prevCls === prevCls && memo.book === (book || null)
      && memo.phase === phase && memo.prevMove === (moves[i - 1] || null)) {
      out.push(memo.result);
      continue;
    }
    const remember = (result) => {
      mv.memo = { pos, next, prevCls, book: book || null, phase, prevMove: moves[i - 1] || null, result };
      return result;
    };
    // Without engine evaluations only book moves can be graded.
    if (!book && !(pos && next && pos.lines.length)) { out.push(remember(null)); continue; }

    const moverMate = (s) => s && s.mate !== undefined
      && (s.mate === 0 ? s.winner === mv.color : white ? s.mate > 0 : s.mate < 0);
    let cls, sac = null;
    if (book) cls = 'book';
    else if (legalCount === 1) cls = 'forced';
    else if (next.terminal === 'checkmate') cls = 'best';
    else {
      cls = isBest ? 'best'
        : loss <= 2 ? 'excellent'
        : loss <= 5 ? 'good'
        : loss <= 10 ? 'inaccuracy'
        : loss <= 20 ? 'mistake'
        : 'blunder';

      const prev = out[i - 1];
      const gifted = prev && ['mistake', 'blunder'].includes(prev.cls);
      if (!isBest && moverMate(pos.score) && !moverMate(next.score) && after >= 50 && cls !== 'blunder') {
        cls = 'miss';
      } else if (['inaccuracy', 'mistake', 'blunder'].includes(cls) && gifted && after >= 35) {
        cls = 'miss';
      }

      if (isBest || loss <= 1.5) {
        const secondPov = second ? pov(second) : null;
        const alreadyWinning = secondPov !== null && secondPov >= 90;
        const recapture = i > 0 && moves[i - 1].captured && moves[i - 1].to === mv.to;
        // Brilliant is reserved for a real sacrifice that is the engine's choice, is clearly
        // better than the safe alternative (or mates), and is not just a quick combination.
        const context = { inCheck: i > 0 && /[+#]/.test(moves[i - 1].san), prevOwn: i > 1 ? moves[i - 2] : null };
        const exact = isBest || loss <= 0.5;
        const needed = secondPov === null || before - secondPov >= 3 || moverMate(next.score);
        sac = exact && after >= 50 && !alreadyWinning && needed ? findSacrifice(mv, context) : null;
        if (sac && regainsMaterial(mv, next, sac)) sac = null;
        if (sac) cls = 'brilliant';
        else if (secondPov !== null && before - secondPov >= 15 && secondPov < 85 && !recapture && legalCount > 2
          && before >= 25 && !isObviousCapture(mv)) cls = 'great';
      }
    }

    out.push({
      cls, loss, acc: accuracyOf(loss), isBest, phase, sac,
      bestUci, bestSan: bestMove ? bestMove.san : null,
      scoreBefore: pos?.score, scoreAfter: next?.score,
      text: '',
    });
    out[i].text = explain(out[i], mv, pos, next, white, opening);
    remember(out[i]);
  }

  return { moves: out, ...summarize(out, moves), opening };
}

/** Accuracy and classification counts per colour. Ungraded (null) moves are skipped. */
export function summarize(revs, moves) {
  const blank = () => ({ acc: [], counts: {}, phase: { opening: [], middlegame: [], endgame: [] } });
  const stats = { w: blank(), b: blank() };
  revs.forEach((r, i) => {
    if (!r) return;
    const s = stats[moves[i].color];
    s.acc.push(r.acc);
    if (r.phase) s.phase[r.phase].push(r.acc);
    s.counts[r.cls] = (s.counts[r.cls] || 0) + 1;
  });
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    accuracy: { w: mean(stats.w.acc), b: mean(stats.b.acc) },
    counts: { w: stats.w.counts, b: stats.b.counts },
    phases: Object.fromEntries(['w', 'b'].map((c) => [c, Object.fromEntries(PHASES.map((ph) => [ph, { acc: mean(stats[c].phase[ph]), n: stats[c].phase[ph].length }]))])),
  };
}

function explain(r, mv, pos, next, white, opening) {
  const san = mv.san;
  if (r.cls === 'book') return `${san} is a book move${opening ? ` (${opening[1]})` : ''}.`;
  const best = r.bestSan;
  const alt = best && !r.isBest ? best : null;
  const moverMate = (s) => s && s.mate !== undefined && s.mate !== 0 && (white ? s.mate > 0 : s.mate < 0);
  const oppMate = (s) => s && s.mate !== undefined && s.mate !== 0 && (white ? s.mate < 0 : s.mate > 0);

  // What the opponent can do now, for the bad-move explanations.
  let consequence = '';
  if (next.terminal) {
    consequence = '';
  } else if (oppMate(next.score)) {
    const reply = next.lines[0] && uciToMove(mv.after, next.lines[0].pv[0]);
    consequence = ` It allows a forced mate in ${Math.abs(next.score.mate)}${reply ? `, starting with ${reply.san}` : ''}.`;
  } else if (next.lines[0]) {
    const reply = uciToMove(mv.after, next.lines[0].pv[0]);
    if (reply) {
      if (reply.captured && exchangeGain(new Chess(mv.after), reply.to) >= 2) {
        consequence = ` It loses the ${PIECE_NAME[reply.captured]} on ${reply.to} to ${reply.san}.`;
      } else {
        consequence = ` It allows ${reply.san}.`;
      }
    }
  }
  const better = alt
    ? (moverMate(pos.score) ? ` ${alt} forced mate in ${Math.abs(pos.score.mate)}.` : ` ${alt} was best.`)
    : '';

  switch (r.cls) {
    case 'brilliant': {
      const what = r.sac ? `offers the ${PIECE_NAME[r.sac.piece]} on ${r.sac.square}` : 'gives up material';
      if (moverMate(next.score)) return `${san} is brilliant! It ${what} and forces mate in ${Math.abs(next.score.mate)}.`;
      const line = next.lines[0];
      const reply = line && uciToMove(mv.after, line.pv[0]);
      if (reply && r.sac && reply.captured && reply.to === r.sac.square) {
        const follow = pvToSan(mv.after, line.pv, 2)[1];
        const keeps = winPctFor(r.scoreAfter, white) >= 60 ? 'keeps the advantage' : 'holds the balance';
        return `${san} is brilliant! It ${what}. After ${reply.san}${follow ? `, ${follow} ${keeps}` : ' the compensation is worth more'}.`;
      }
      return `${san} is brilliant! It ${what}, and taking it only makes things worse.`;
    }
    case 'great': return `${san} is a great move. It was the only move that kept ${r.scoreAfter && winPctFor(r.scoreAfter, white) >= 60 ? 'the advantage' : 'the position together'}.`;
    case 'best': return next.terminal === 'checkmate' ? `${san} is checkmate.` : `${san} is the best move.`;
    case 'excellent': return `${san} is an excellent move.${alt ? ` The engine slightly prefers ${alt}.` : ''}`;
    case 'good': return `${san} is a good move.${alt ? ` ${alt} was more precise.` : ''}`;
    case 'book': return `${san} is a book move${opening ? ` (${opening[1]})` : ''}.`;
    case 'forced': return `${san} was the only legal move.`;
    case 'inaccuracy': return `${san} is an inaccuracy.${better}`;
    case 'mistake': return `${san} is a mistake.${consequence}${better}`;
    case 'miss': return `${san} misses an opportunity.${better}`;
    case 'blunder': return `${san} is a blunder.${consequence}${better}`;
    default: return '';
  }
}

function winPctFor(score, white) {
  return white ? winPct(score) : 100 - winPct(score);
}
