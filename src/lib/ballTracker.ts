/*
 * ballTracker.ts
 * ==================
 * Classical (no-ML) ball tracker using OpenCV.js background subtraction.
 *
 * Method: MOG2 background subtraction (static lane, moving ball) -> denoise ->
 * contours -> keep blobs that are the right size AND round enough AND INSIDE the
 * lane region -> pick the one closest to the previous position (continuity), or
 * the largest round blob when first acquiring the track.
 *
 * The `roi` lane quad is the big discriminator: it excludes the bowler and his
 * hand/arm (all on the approach, outside the lane) and means tracking only
 * begins once the ball crosses the near edge (the foul line) into the lane.
 *
 * Every Mat is released to avoid wasm memory leaks.
 */

type CV = any;

export interface Point {
  x: number;
  y: number;
}

export interface BallDetection {
  index: number;
  mediaTime: number;
  x: number;
  y: number;
  r: number;
  area: number;
  circularity: number;
}

export interface BallTrackerOptions {
  roi?: Point[]; // lane quad (video coords). Detections outside are ignored. Empty = no gating.
  minArea?: number;
  maxArea?: number;
  minCircularity?: number;
  maxJump?: number;
  maxMisses?: number;
  morphSize?: number;
  mog2History?: number;
  mog2VarThreshold?: number;
}

/** Ray-casting point-in-polygon test. */
function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y,
      xj = poly[j].x,
      yj = poly[j].y;
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export class BallTracker {
  private cv: CV;
  private fgMask: CV;
  private kernel: CV;
  private mog2: CV;
  private last: { x: number; y: number } | null = null;
  private misses = 0;
  private opts: Required<BallTrackerOptions>;
  readonly path: BallDetection[] = [];

  constructor(cv: CV, opts: BallTrackerOptions = {}) {
    this.cv = cv;
    this.opts = {
      roi: [],
      minArea: 200,
      maxArea: 8000,
      minCircularity: 0.6,
      maxJump: 250,
      maxMisses: 8,
      morphSize: 5,
      mog2History: 120,
      mog2VarThreshold: 32,
      ...opts,
    };
    this.fgMask = new cv.Mat();
    this.kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(this.opts.morphSize, this.opts.morphSize));
    this.mog2 = new cv.BackgroundSubtractorMOG2(this.opts.mog2History, this.opts.mog2VarThreshold, false);
  }

  processFrame(canvas: HTMLCanvasElement, mediaTime: number, index: number): BallDetection | null {
    const cv = this.cv;
    const src = cv.imread(canvas);
    this.mog2.apply(src, this.fgMask);
    cv.morphologyEx(this.fgMask, this.fgMask, cv.MORPH_OPEN, this.kernel);
    cv.morphologyEx(this.fgMask, this.fgMask, cv.MORPH_CLOSE, this.kernel);

    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(this.fgMask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const gateOn = this.opts.roi.length >= 3;
    let best: BallDetection | null = null;
    let bestScore = -Infinity;

    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area >= this.opts.minArea && area <= this.opts.maxArea) {
        const perimeter = cv.arcLength(c, true);
        const circularity = perimeter > 0 ? (4 * Math.PI * area) / (perimeter * perimeter) : 0;
        if (circularity >= this.opts.minCircularity) {
          const m = cv.moments(c);
          if (m.m00 !== 0) {
            const x = m.m10 / m.m00;
            const y = m.m01 / m.m00;
            let ok = true;
            if (gateOn && !pointInPolygon({ x, y }, this.opts.roi)) ok = false; // lane gate
            let score = 0;
            if (ok) {
              if (this.last) {
                const d = Math.hypot(x - this.last.x, y - this.last.y);
                if (d > this.opts.maxJump) ok = false;
                score = -d; // prefer nearest to last known position
              } else {
                score = area; // first acquisition: biggest round blob in the lane
              }
            }
            if (ok && score > bestScore) {
              bestScore = score;
              best = { index, mediaTime, x, y, r: Math.sqrt(area / Math.PI), area, circularity };
            }
          }
        }
      }
      c.delete();
    }

    contours.delete();
    hierarchy.delete();
    src.delete();

    if (best) {
      this.last = { x: best.x, y: best.y };
      this.misses = 0;
      this.path.push(best);
    } else {
      this.misses++;
      if (this.misses >= this.opts.maxMisses) this.last = null;
    }
    return best;
  }

  dispose(): void {
    this.fgMask.delete();
    this.kernel.delete();
    this.mog2.delete();
  }
}
