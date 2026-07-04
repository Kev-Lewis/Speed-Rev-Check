/*
 * tapeTracker.ts
 * ==================
 * Rev-rate measurement by tracking a colored mark (yellow logo) on the ball.
 *
 * Improvements over naive white-thresholding:
 *  - HUE-based yellow isolation (a distinct color beats "any bright pixel", which
 *    was catching glare).
 *  - CONTINUITY: after the first lock, only yellow pixels near the previous mark
 *    position count, so the mark can't jump to a random speck.
 *  - RUNS: angle is only accumulated over an unbroken run of tracked frames. When
 *    the mark rotates to the back and is lost, the run ends; a new one starts on
 *    re-acquisition. Rev rate is read from the earliest solid run (near release).
 *
 * No OpenCV — plain canvas pixel reads.
 */

export interface MarkPoint {
  x: number;
  y: number;
  count: number;
}

export interface MarkOptions {
  hueMin?: number; // yellow hue window (degrees)
  hueMax?: number;
  satMin?: number; // 0-1
  valMin?: number; // 0-1
  innerFrac?: number; // search within this fraction of ball radius
  continuityFrac?: number; // after lock, search within this fraction of radius around last mark
  minCount?: number; // min yellow pixels to trust a reading
}

interface AngleSample {
  mediaTime: number;
  angle: number;
}

export interface RevWindow {
  rotations: number;
  seconds: number;
  n: number;
}

function isYellow(R: number, G: number, B: number, o: Required<MarkOptions>): boolean {
  const mx = Math.max(R, G, B);
  const mn = Math.min(R, G, B);
  const v = mx / 255;
  const s = mx > 0 ? (mx - mn) / mx : 0;
  if (v < o.valMin || s < o.satMin) return false;
  let hue: number;
  if (mx === mn) hue = 0;
  else if (mx === R) hue = 60 * (((G - B) / (mx - mn)) % 6);
  else if (mx === G) hue = 60 * ((B - R) / (mx - mn) + 2);
  else hue = 60 * ((R - G) / (mx - mn) + 4);
  if (hue < 0) hue += 360;
  return hue >= o.hueMin && hue <= o.hueMax;
}

/** Find the yellow mark near the ball center (near `prev` if given), or null. */
export function detectYellowMark(
  src: HTMLCanvasElement,
  cx: number,
  cy: number,
  r: number,
  prev: { x: number; y: number } | null,
  opts: Required<MarkOptions>
): MarkPoint | null {
  const ctx = src.getContext("2d", { willReadFrequently: true });
  if (!ctx || r <= 1) return null;

  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(src.width, Math.ceil(cx + r));
  const y1 = Math.min(src.height, Math.ceil(cy + r));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;

  const data = ctx.getImageData(x0, y0, w, h).data;
  const innerR2 = (opts.innerFrac * r) * (opts.innerFrac * r);
  const contR = opts.continuityFrac * r;
  const contR2 = contR * contR;

  let sx = 0;
  let sy = 0;
  let count = 0;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const gx = x0 + px;
      const gy = y0 + py;
      const dcx = gx - cx;
      const dcy = gy - cy;
      if (dcx * dcx + dcy * dcy > innerR2) continue; // inside ball
      if (prev) {
        const dpx = gx - prev.x;
        const dpy = gy - prev.y;
        if (dpx * dpx + dpy * dpy > contR2) continue; // near last mark
      }
      const i = (py * w + px) * 4;
      if (isYellow(data[i], data[i + 1], data[i + 2], opts)) {
        sx += gx;
        sy += gy;
        count++;
      }
    }
  }
  if (count < opts.minCount) return null;
  return { x: sx / count, y: sy / count, count };
}

export class MarkTracker {
  private opts: Required<MarkOptions>;
  private prev: { x: number; y: number } | null = null;
  private current: AngleSample[] = [];
  private runs: AngleSample[][] = [];

  constructor(opts: MarkOptions = {}) {
    this.opts = {
      hueMin: 38,
      hueMax: 78,
      satMin: 0.35,
      valMin: 0.4,
      innerFrac: 0.95,
      continuityFrac: 0.6,
      minCount: 5,
      ...opts,
    };
  }

  /** Process one frame; returns the mark point (for drawing) or null if lost. */
  process(src: HTMLCanvasElement, cx: number, cy: number, r: number, mediaTime: number): MarkPoint | null {
    const mark = detectYellowMark(src, cx, cy, r, this.prev, this.opts);
    if (mark) {
      this.current.push({ mediaTime, angle: Math.atan2(mark.y - cy, mark.x - cx) });
      this.prev = { x: mark.x, y: mark.y };
      return mark;
    }
    // lost -> end the current run
    if (this.current.length) {
      this.runs.push(this.current);
      this.current = [];
    }
    this.prev = null;
    return null;
  }

  /** Rev window from the earliest solid run of tracked frames. */
  bestWindow(minRunFrames = 5, maxFrames = 40, minRotations = 0.4): RevWindow | null {
    if (this.current.length) {
      this.runs.push(this.current);
      this.current = [];
    }
    let fallback: RevWindow | null = null;
    for (const run of this.runs) {
      if (run.length < minRunFrames) continue;
      const seg = run.slice(0, maxFrames);
      let acc = 0;
      let prev = seg[0].angle;
      for (let i = 1; i < seg.length; i++) {
        let d = seg[i].angle - prev;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        acc += d;
        prev = seg[i].angle;
      }
      const rotations = Math.abs(acc) / (2 * Math.PI);
      const seconds = seg[seg.length - 1].mediaTime - seg[0].mediaTime;
      if (seconds <= 0) continue;
      const win: RevWindow = { rotations, seconds, n: seg.length };
      if (rotations >= minRotations) return win; // earliest good run wins
      if (!fallback || rotations > fallback.rotations) fallback = win;
    }
    return fallback;
  }
}
