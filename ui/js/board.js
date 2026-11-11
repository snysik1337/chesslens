// Board rendering and input: drag or click to move, right-click to mark squares
// and draw arrows, promotion picker, last-move tint and classification badge.
import { Chess } from '../vendor/chess.js';

const FILES = 'abcdefgh';

export class Board {
  constructor(el, { onMove }) {
    this.el = el;
    this.onMove = onMove;
    this.chess = new Chess();
    this.fen = this.chess.fen();
    this.orientation = 'w';
    this.pieceSet = 'cburnett';
    this.showCoords = true;
    this.showLegal = true;
    this.movable = 'both';  // 'both' | 'w' | 'b' | 'none'
    this.key = '';
    this.lastMove = null;   // {from, to}
    this.badge = null;      // {square, cls, glyph, color}
    this.arrows = [];       // [{from, to, color}]
    this.selected = null;
    this.userArrows = [];
    this.userMarks = new Set();
    this.drag = null;
    this.rstart = null;

    el.innerHTML = '<div class="squares"></div><svg class="arrows" viewBox="0 0 8 8"></svg><div class="promo" hidden></div>';
    this.squaresEl = el.querySelector('.squares');
    this.arrowsEl = el.querySelector('.arrows');
    this.promoEl = el.querySelector('.promo');

    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', () => { this.endDrag(); this.render(); });
    this.render();
  }

  /**
   * Updates any of: fen, orientation, lastMove, badge, arrows, pieceSet, showCoords,
   * showLegal, movable. `anim: {from, to}` slides the piece now standing on `to`.
   */
  set(props) {
    const { anim, ...rest } = props;
    const fenChanged = rest.fen !== undefined && rest.fen !== this.fen;
    Object.assign(this, rest);
    if (fenChanged) {
      this.chess.load(this.fen);
      this.selected = null;
      this.userArrows = [];
      this.userMarks.clear();
      this.promoEl.hidden = true;
      this.endDrag();
    }
    const key = JSON.stringify([this.fen, this.orientation, this.pieceSet, this.showCoords, this.showLegal, this.lastMove, this.badge]);
    if (key === this.key) { this.renderArrows(); return; }
    this.key = key;
    this.render();
    if (fenChanged && anim) this.slide(anim.from, anim.to);
  }

  slide(from, to) {
    const [x1, y1] = this.centre(from);
    const [x2, y2] = this.centre(to);
    const el = this.squaresEl.children[Math.floor(y2) * 8 + Math.floor(x2)]?.querySelector('.piece');
    if (!el) return;
    el.style.zIndex = 5;
    el.style.transform = `translate(${(x1 - x2) * 100}%, ${(y1 - y2) * 100}%)`;
    el.getBoundingClientRect();   // commit the start position before transitioning
    el.style.transition = 'transform .15s ease-out';
    el.style.transform = 'none';
  }

  capture(e) {
    try { this.el.setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
  }

  squareAt(x, y) {
    const r = this.el.getBoundingClientRect();
    const col = Math.floor(((x - r.left) / r.width) * 8);
    const row = Math.floor(((y - r.top) / r.height) * 8);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    return this.orientation === 'w' ? FILES[col] + (8 - row) : FILES[7 - col] + (row + 1);
  }

  /** Centre of a square in board units (0..8), display orientation applied. */
  centre(sq) {
    const f = FILES.indexOf(sq[0]);
    const r = +sq[1];
    return this.orientation === 'w' ? [f + 0.5, 8 - r + 0.5] : [7 - f + 0.5, r - 0.5];
  }

  targets(from) {
    return this.chess.moves({ square: from, verbose: true });
  }

  pieceUrl(p) {
    return `pieces/${this.pieceSet}/${p.color}${p.type.toUpperCase()}.svg`;
  }

  render() {
    const targets = this.selected ? this.targets(this.selected) : [];
    const targetMap = new Map(targets.map((m) => [m.to, m]));
    let html = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const f = this.orientation === 'w' ? col : 7 - col;
        const r = this.orientation === 'w' ? 8 - row : row + 1;
        const sq = FILES[f] + r;
        const cls = ['sq', (f + r) % 2 === 1 ? 'dark' : 'light'];
        let style = '';
        const isLast = this.lastMove && (this.lastMove.from === sq || this.lastMove.to === sq);
        if (this.userMarks.has(sq)) cls.push('mark');
        else if (this.selected === sq) cls.push('sel');
        else if (isLast) {
          cls.push('last');
          if (this.badge && this.badge.color) { cls.push('tint'); style = ` style="--tint:${this.badge.color}"`; }
        }
        const t = targetMap.get(sq);
        if (t && this.showLegal) cls.push('dot', ...(t.captured ? ['cap'] : []));
        let inner = '';
        if (this.showCoords) {
          if (col === 0) inner += `<span class="coord rank">${r}</span>`;
          if (row === 7) inner += `<span class="coord file">${FILES[f]}</span>`;
        }
        const p = this.chess.get(sq);
        if (p) {
          const dragging = this.drag && this.drag.moved && this.drag.from === sq ? ' dragging' : '';
          inner += `<div class="piece${dragging}" style="background-image:url(${this.pieceUrl(p)})"></div>`;
        }
        if (this.badge && this.badge.square === sq) {
          inner += `<span class="ci ci-${this.badge.cls} badge">${this.badge.glyph}</span>`;
        }
        html += `<div class="${cls.join(' ')}"${style}>${inner}</div>`;
      }
    }
    this.squaresEl.innerHTML = html;
    this.renderArrows();
  }

  renderArrows() {
    const all = [...this.arrows, ...this.userArrows.map((a) => ({ ...a, color: '#f5a623' }))];
    this.arrowsEl.innerHTML = all.map(({ from, to, color, opacity = 0.8 }) => {
      const [x1, y1] = this.centre(from);
      const [x2, y2] = this.centre(to);
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (!len) return '';
      const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      const head = 0.42, w = 0.23;
      const ex = x2 - ux * head, ey = y2 - uy * head;
      const sx = x1 + ux * 0.32, sy = y1 + uy * 0.32;
      const tip = `${x2 - ux * 0.08},${y2 - uy * 0.08} ${ex - uy * w},${ey + ux * w} ${ex + uy * w},${ey - ux * w}`;
      return `<g opacity="${opacity}" fill="${color}" stroke="${color}">` +
        `<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" stroke-width="0.17"/>` +
        `<polygon points="${tip}" stroke="none"/></g>`;
    }).join('');
  }

  down(e) {
    const sq = this.squareAt(e.clientX, e.clientY);
    if (!sq) return;
    if (e.button === 2) { this.rstart = sq; this.capture(e); return; }
    if (e.button !== 0) return;
    if (!this.promoEl.hidden) { this.promoEl.hidden = true; return; }
    this.userArrows = [];
    this.userMarks.clear();

    if (this.selected && this.selected !== sq && this.targets(this.selected).some((m) => m.to === sq)) {
      const from = this.selected;
      this.selected = null;
      this.tryMove(from, sq);
      return;
    }
    const p = this.chess.get(sq);
    if (p && p.color === this.chess.turn() && (this.movable === 'both' || this.movable === p.color)) {
      const wasSelected = this.selected === sq;
      this.selected = sq;
      const size = this.el.getBoundingClientRect().width / 8;
      const ghost = document.createElement('div');
      ghost.className = 'ghost';
      ghost.style.cssText = `width:${size}px;height:${size}px;background-image:url(${this.pieceUrl(p)});display:none`;
      document.body.appendChild(ghost);
      this.drag = { from: sq, ghost, size, moved: false, wasSelected, x: e.clientX, y: e.clientY };
      this.capture(e);
    } else {
      this.selected = null;
    }
    this.render();
  }

  move(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) {
      d.moved = true;
      d.ghost.style.display = 'block';
      this.render();
    }
    if (d.moved) {
      d.ghost.style.left = `${e.clientX - d.size / 2}px`;
      d.ghost.style.top = `${e.clientY - d.size / 2}px`;
    }
  }

  up(e) {
    const sq = this.squareAt(e.clientX, e.clientY);
    if (e.button === 2) {
      const from = this.rstart;
      this.rstart = null;
      if (!from || !sq) return;
      if (from === sq) {
        this.userMarks.has(sq) ? this.userMarks.delete(sq) : this.userMarks.add(sq);
      } else {
        const i = this.userArrows.findIndex((a) => a.from === from && a.to === sq);
        i >= 0 ? this.userArrows.splice(i, 1) : this.userArrows.push({ from, to: sq });
      }
      this.render();
      return;
    }
    const d = this.drag;
    if (!d) return;
    this.endDrag();
    if (d.moved && sq && sq !== d.from && this.targets(d.from).some((m) => m.to === sq)) {
      this.selected = null;
      this.tryMove(d.from, sq, true);
      return;
    }
    // A plain click on an already-selected piece deselects it.
    if (!d.moved && d.wasSelected) this.selected = null;
    this.render();
  }

  endDrag() {
    if (this.drag) { this.drag.ghost.remove(); this.drag = null; }
  }

  tryMove(from, to, dragged = false) {
    const options = this.targets(from).filter((m) => m.to === to);
    if (!options.length) { this.render(); return; }
    if (!options[0].promotion) { this.onMove(from, to, undefined, dragged); return; }
    const color = options[0].color;
    this.promoEl.innerHTML = ['q', 'n', 'r', 'b']
      .map((t) => `<button data-p="${t}" style="background-image:url(${this.pieceUrl({ color, type: t })})"></button>`)
      .join('');
    this.promoEl.hidden = false;
    this.promoEl.onpointerdown = (ev) => {
      ev.stopPropagation();
      const p = ev.target.dataset.p;
      if (!p) return;
      this.promoEl.hidden = true;
      this.onMove(from, to, p, dragged);
    };
    this.render();
  }
}
