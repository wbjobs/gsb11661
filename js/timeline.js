/**
 * Timeline：在 Canvas 上绘制最近 WINDOW_MS 内的状态时间线。
 * 段类型：active / idle / locked / hidden / unknown
 */

const WINDOW_MS = 5 * 60 * 1000;
const COLORS = {
  active: '#2f9e5f',
  idle: '#c9a23a',
  locked: '#c04545',
  hidden: '#4a5265',
  unknown: '#2c3347',
};

export class Timeline {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.segments = []; // { type, start, end } end 为 null 表示进行中
    this._openSegment('unknown', Date.now());
  }

  /** 追加一个状态段（自动闭合上一段）。 */
  push(type, at = Date.now()) {
    const last = this.segments[this.segments.length - 1];
    if (last && last.type === type && last.end === null) return; // 合并连续同态
    this._closeLast(at);
    this._openSegment(type, at);
    this._prune();
  }

  _openSegment(type, start) {
    this.segments.push({ type, start, end: null });
  }

  _closeLast(at) {
    const last = this.segments[this.segments.length - 1];
    if (last && last.end === null) last.end = at;
  }

  _prune() {
    const cutoff = Date.now() - WINDOW_MS;
    while (this.segments.length > 1 && (this.segments[0].end ?? Infinity) < cutoff) {
      this.segments.shift();
    }
  }

  /** 重绘。调用方负责控制频率（空闲降频 / 后台暂停）。 */
  draw(now = Date.now()) {
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.width;
    const cssH = 120;
    if (canvas.width !== Math.round(cssW * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    const w = canvas.width;
    const h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const windowStart = now - WINDOW_MS;
    const barY = Math.round(h * 0.3);
    const barH = Math.round(h * 0.4);
    const toX = (t) => ((t - windowStart) / WINDOW_MS) * w;

    // 底槽
    ctx.fillStyle = COLORS.unknown;
    ctx.fillRect(0, barY, w, barH);

    // 状态段
    for (const seg of this.segments) {
      const segEnd = seg.end ?? now;
      if (segEnd < windowStart) continue;
      const x0 = Math.max(0, toX(seg.start));
      const x1 = Math.min(w, toX(segEnd));
      if (x1 <= x0) continue;
      ctx.fillStyle = COLORS[seg.type] ?? COLORS.unknown;
      ctx.fillRect(x0, barY, x1 - x0, barH);
    }

    // 时间刻度（每分钟）
    ctx.fillStyle = '#5b6478';
    ctx.font = `${11 * (window.devicePixelRatio || 1)}px sans-serif`;
    ctx.textAlign = 'center';
    for (let m = 0; m <= 5; m++) {
      const t = now - m * 60_000;
      const x = toX(t);
      ctx.fillRect(x, barY - 4, 1, barH + 8);
      ctx.fillText(m === 0 ? '现在' : `-${m}m`, x, barY + barH + 16 * (window.devicePixelRatio || 1));
    }

    // “现在”游标
    ctx.fillStyle = '#e6e9f0';
    ctx.fillRect(w - 1, barY - 6, 2, barH + 12);
  }
}
