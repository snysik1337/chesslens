// Logic tests. Run with `./run-tests.sh` (or `chesslens --test`): no window is shown and
// no engine is needed, because evaluations are supplied by hand.
import { Chess } from '../vendor/chess.js';
import { reviewGame, summarize, winPct, fmtScore, openingKey, pvToSan, uciToMove } from './review.js';
import { material, parseClock, clockSeconds, estimateRating, fenToPieces, piecesToFen, soundForMove } from './extras.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const OPERA = '1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0';

function history(pgn) {
  const c = new Chess();
  c.loadPgn(pgn);
  return c.history({ verbose: true });
}
/** Evaluation record: `lines` are [uci, cp] or [uci, {mate}] pairs, White's point of view. */
function pos(fen, ...lines) {
  const ls = lines.map(([uci, s]) => (typeof s === 'number' ? { cp: s, pv: [uci] } : { ...s, pv: [uci] }));
  return { fen, score: ls[0], lines: ls, depth: 20 };
}
const mated = (fen, winner) => ({ fen, score: { mate: 0, winner }, lines: [], terminal: 'checkmate', depth: 99 });

export async function runTests(app) {
  const failures = [];
  let count = 0;
  const test = (name, fn) => {
    count++;
    try { fn(); } catch (e) { failures.push(`${name}: ${e.message || e}`); }
  };
  const eq = (a, b, what = '') => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  };
  const ok = (cond, what) => { if (!cond) throw new Error(what); };

  // ------------------------------------------------------------ scores
  test('winPct is 50 for a level position and symmetric', () => {
    eq(winPct({ cp: 0 }), 50);
    ok(Math.abs(winPct({ cp: 150 }) + winPct({ cp: -150 }) - 100) < 1e-9, 'not symmetric');
    eq(winPct({ mate: 3 }), 100);
    eq(winPct({ mate: -2 }), 0);
    eq(winPct({ mate: 0, winner: 'b' }), 0);
  });
  test('fmtScore', () => {
    eq(fmtScore({ cp: 35 }), '+0.35');
    eq(fmtScore({ cp: -1250 }), '-12.5');
    eq(fmtScore({ mate: -4 }), '-M4');
    eq(fmtScore({ mate: 0, winner: 'w' }), '1-0');
  });
  test('uci and pv conversion', () => {
    eq(uciToMove(START, 'g1f3').san, 'Nf3');
    eq(uciToMove(START, 'e2e5'), null);
    eq(pvToSan(START, ['e2e4', 'e7e5', 'g1f3']), ['e4', 'e5', 'Nf3']);
  });

  // ------------------------------------------------------------ grading
  test("fool's mate: inaccuracy, best, blunder, checkmate", () => {
    const h = history('1. f3 e5 2. g4 Qh4#');
    const r = reviewGame([
      pos(h[0].before, ['e2e4', 30], ['d2d4', 25]),
      pos(h[1].before, ['e7e5', -45], ['d7d5', -40]),
      pos(h[2].before, ['d2d4', -45], ['e2e4', -50]),
      pos(h[3].before, ['d8h4', { mate: -1 }], ['d7d5', -150]),
      mated(h[3].after, 'b'),
    ], h, null);
    eq(r.moves.map((m) => m.cls), ['inaccuracy', 'best', 'blunder', 'best']);
    ok(r.moves[2].text.includes('mate in 1'), `blunder text: ${r.moves[2].text}`);
    ok(r.moves[3].text.includes('checkmate'), `mate text: ${r.moves[3].text}`);
    ok(r.accuracy.b > 99.9 && r.accuracy.w < 80, `accuracy ${JSON.stringify(r.accuracy)}`);
  });

  const opera = history(OPERA);
  const sparse = (filled) => {
    const p = opera.map(() => null);
    p.push(null);
    for (const [i, v] of Object.entries(filled)) p[i] = v;
    return p;
  };
  test('a queen sacrifice that is best is Brilliant; the only legal reply is Forced', () => {
    const r = reviewGame(sparse({
      30: pos(opera[30].before, ['b3b8', { mate: 2 }], ['b3c3', 300]),
      31: pos(opera[31].before, ['d7b8', { mate: 1 }]),
      32: pos(opera[32].before, ['d1d8', { mate: 1 }], ['g5d8', 500]),
      33: mated(opera[32].after, 'w'),
    }), opera, null);
    eq(r.moves[30].cls, 'brilliant', '16. Qb8+');
    eq(r.moves[31].cls, 'forced', '16... Nxb8');
    eq(r.moves[32].cls, 'best', '17. Rd8#');
    eq(r.moves[0], null, 'ungraded move');
  });
  test('a sacrifice is not Brilliant when a safe move wins anyway', () => {
    const r = reviewGame(sparse({
      30: pos(opera[30].before, ['b3b8', { mate: 2 }], ['b3c3', 2500]),
      31: pos(opera[31].before, ['d7b8', { mate: 1 }]),
    }), opera, null);
    eq(r.moves[30].cls, 'best');
  });
  test('the only move that holds is Great; an ordinary best move is Best', () => {
    const at = (second) => reviewGame(sparse({
      12: pos(opera[12].before, ['f3b3', 180], ['c4b3', second]),
      13: pos(opera[13].before, ['d8e7', 180], ['d8d7', 300]),
    }), opera, null).moves[12].cls;
    eq(at(-40), 'great');
    eq(at(160), 'best');
  });
  test('loss thresholds map to Excellent, Good, Inaccuracy, Mistake, Blunder', () => {
    const cls = (after) => reviewGame(sparse({
      14: pos(opera[14].before, ['b1d2', 100], ['c1e3', 95]),
      15: pos(opera[15].before, ['c7c6', after], ['b8c6', after + 20]),
    }), opera, null).moves[14].cls;
    eq([95, 75, 0, -100, -300].map(cls), ['excellent', 'good', 'inaccuracy', 'mistake', 'blunder']);
  });
  test('failing to punish a blunder is a Miss', () => {
    const r = reviewGame(sparse({
      10: pos(opera[10].before, ['c1e3', 60], ['b1c3', 50]),
      11: pos(opera[11].before, ['d8d7', 60], ['d8f6', 55]),
      12: pos(opera[12].before, ['f3b3', 400], ['b1c3', 100]),
      13: pos(opera[13].before, ['d8e7', 90], ['d8d7', 200]),
    }), opera.map((m, i) => (i === 12 ? { ...m, to: 'c3', from: 'b1', san: 'Nc3', piece: 'n', after: opera[12].after } : m)), null);
    eq(r.moves[11].cls, 'blunder', '6... Nf6');
    eq(r.moves[12].cls, 'miss', 'reply');
  });
  test('book moves are graded without any evaluation', () => {
    const book = { [openingKey(opera[0].after)]: ['B00', "King's Pawn"], [openingKey(opera[1].after)]: ['C20', "King's Pawn Game"] };
    const r = reviewGame(sparse({}), opera, book);
    eq(r.moves.slice(0, 3).map((m) => m && m.cls), ['book', 'book', null]);
    eq(r.opening[0], 'C20');
    eq(r.moves[0].phase, 'opening');
  });
  test('summarize counts per colour and skips ungraded moves', () => {
    const s = summarize([{ cls: 'best', acc: 100, phase: 'opening' }, null, { cls: 'blunder', acc: 20, phase: 'opening' }], opera.slice(0, 3));
    eq(s.counts.w, { best: 1, blunder: 1 });
    eq(s.accuracy.w, 60);
    eq(s.accuracy.b, null);
    eq(s.phases.w.opening.n, 2);
  });

  // ------------------------------------------------------------ helpers
  test('material count', () => {
    eq(material(START), { w: [], b: [], diff: 0 });
    const m = material('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
    eq(m.diff, 5);
    eq(m.b.length, 14, 'pieces Black has taken');
  });
  test('clock parsing', () => {
    eq(parseClock('[%clk 0:09:58.3]'), '9:58');
    eq(parseClock('[%clk 1:02:03]'), '1:02:03');
    eq(parseClock('[%clk 0:00:07.4]'), '0:07.4');
    eq(parseClock('no clock'), null);
    eq(clockSeconds('[%clk 0:01:30]'), 90);
  });
  test('rating estimate rises with accuracy and stays in range', () => {
    let last = 0;
    for (let a = 0; a <= 100; a += 5) {
      const r = estimateRating(a);
      ok(r >= last && r >= 100 && r <= 3200, `accuracy ${a} gave ${r}`);
      last = r;
    }
    eq(estimateRating(null), null);
  });
  test('editor FEN round trip and castling rights', () => {
    eq(piecesToFen(fenToPieces(START), 'w', 'KQkq'), START);
    const p = fenToPieces(START);
    delete p.h1;
    eq(piecesToFen(p, 'b', 'KQkq').split(' ').slice(1, 3), ['b', 'Qkq']);
  });
  test('sound choice', () => {
    eq(soundForMove({ san: 'Nf3' }, false), 'move');
    eq(soundForMove({ san: 'Bxf7+', captured: 'p' }, false), 'check');
    eq(soundForMove({ san: 'exd5', captured: 'p' }, false), 'capture');
    eq(soundForMove({ san: 'O-O' }, false), 'castle');
    eq(soundForMove({ san: 'Qh4#' }, true), 'end');
  });

  // ------------------------------------------------------------ PGN handling in the app
  test('PGN loads, exports and reloads with the same moves', () => {
    app.loadPgn(`[White "A"]\n[Black "B"]\n\n${OPERA}`);
    eq(app.mainline().length, 33);
    const out = app.toPgn();
    ok(out.includes('[White "A"]') && out.includes('17. Rd8# 1-0'), `export: ${out.slice(-60)}`);
    app.loadPgn(out);
    eq(app.mainline().map((n) => n.move.san).join(' '), opera.map((m) => m.san).join(' '));
  });
  test('variations are exported in brackets and clocks are read', () => {
    app.loadPgn('1. e4 {[%clk 0:05:00]} e5 {[%clk 0:04:57]} 2. Nf3 *');
    eq(app.mainline()[1].clk, '4:57');
    app.goto(app.mainline()[0]);
    app.playMove('c7', 'c5');
    const out = app.toPgn();
    ok(out.includes('1. e4 e5 (1... c5) 2. Nf3'), `export: ${out}`);
  });
  test('a position can be loaded from FEN and exported with SetUp', () => {
    app.loadText('8/8/8/4k3/8/8/4P3/4K3 w - - 0 1');
    app.playMove('e2', 'e4');
    const out = app.toPgn();
    ok(out.includes('[SetUp "1"]') && out.includes('1. e4 *'), `export: ${out}`);
  });

  // ------------------------------------------------------------ regressions
  test('positions with the wrong side in check are rejected', () => {
    eq(app.positionError(START), null);
    ok(app.positionError('4k3/8/8/8/8/8/8/4RK2 w - - 0 1'), 'accepted Black in check with White to move');
    eq(app.positionError('4k3/8/8/8/8/8/8/4RK2 b - - 0 1'), null, 'Black to move in check is legal');
    ok(app.positionError('8/8/8/8/8/8/8/4K3 w - - 0 1'), 'accepted a board without a black king');
    app.loadText(START);
    app.loadText('4k3/8/8/8/8/8/8/4RK2 w - - 0 1');
    eq(app.mainline().length, 0);
  });
  test('a high fifty-move counter does not end an imported game', () => {
    eq(app.terminalInfo('4k3/8/8/8/8/8/R7/4K3 w - - 120 90'), null);
    eq(app.terminalInfo('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').terminal, 'draw');
  });
  test('time chart copes with clocks but no usable times', () => {
    app.loadPgn('1. e4 {[%clk 0:05:00]} e5 {[%clk 0:05:00]} *');
    eq(app.timeChart(), '');
    app.loadPgn('[TimeControl "300"]\n\n1. e4 {[%clk 0:04:50]} e5 {[%clk 0:04:40]} *');
    ok(app.timeChart().includes('<rect'), 'no bars drawn');
  });
  test('re-grading with unchanged inputs returns the same objects', () => {
    const h = history('1. f3 e5 2. g4 Qh4#');
    const p = [
      pos(h[0].before, ['e2e4', 30], ['d2d4', 25]),
      pos(h[1].before, ['e7e5', -45], ['d7d5', -40]),
      pos(h[2].before, ['d2d4', -45], ['e2e4', -50]),
      null, null,
    ];
    const a = reviewGame(p, h, null), b = reviewGame(p, h, null);
    ok(a.moves[0] === b.moves[0] && a.moves[1] === b.moves[1], 'grades were recomputed');
    eq(b.moves[2], null);
    p[3] = pos(h[3].before, ['d8h4', { mate: -1 }], ['d7d5', -150]);
    const c = reviewGame(p, h, null);
    eq(c.moves[2].cls, 'blunder', 'new evaluation was not picked up');
    ok(c.moves[0] === a.moves[0], 'earlier grade changed');
  });

  return { count, failures };
}
