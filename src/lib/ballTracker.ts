/*
 * ballTracker.ts
 * ==================
 * Classical (no-ML) ball tracker using OpenCV.js background subtraction.
 *
 * Pipeline: MOG2 background subtraction (static lane, moving ball) -> denoise ->
 * contours -> keep blobs that pass size + roundness + lane-region gates -> among
 * survivors, prefer the one nearest the last position AND moving down-lane.
 *
 * Two gates do the heavy lifting:
 *  - roi (lane quad): excludes the bowler/hand (on the approach) and delays the
 *    track until the ball crosses the near edge (the foul line).
 *  - down-lane direction: once the ball is moving, candidates must have a forward
 *    (toward-pins) component, so the track can't snap backward onto the hand.
 *
 * Defaults are tuned loose enough to hold a fast, motion-blurred ball right after
 * release (blur lowers roundness and inflates area), which is where a strict
 * tracker loses it.
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
  roi?: Point[]; // lane quad (video coords), order: foulL, foulR, pinR, pinL. Empty = no gating.
  minArea?: number;
  maxArea?: number;
  minCircularity?: number;
  maxJump?: number; // max px between frames once tracked (raised for fast release)
  maxMisses?: number;
  directionGate?: boolean; // require forward (down-lane) motion once tracked
  backwardTolerance?: number; // px of backward slack allowed before rejecting
  morphSize?: number;
  mog2History?: number;
  mog2VarThreshold?: number;
}

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
  private downlane: Point | null = null; // unit vector from foul line toward pins
  readonly path: BallDetection[] = [];

  constructor(cv: CV, opts: BallTrackerOptions = {}) {
    this.cv = cv;
    this.opts = {
      roi: [],
      minArea: 150,
      maxArea: 20000, // raised: a blurred near-release ball is large
      minCircularity: 0.45, // lowered: motion blur elongates the ball
      maxJump: 400, // raised: fast ball jumps far between frames
      maxMisses: 8,
      directionGate: true,
      backwardTolerance: 15,
      morphSize: 5,
      mog2History: 120,
      mog2VarThreshold: 32,
      ...opts,
    };

    if (this.opts.roi.length === 4) {
      const r = this.opts.roi;
      const nearMid = { x: (r[0].x + r[1].x) / 2, y: (r[0].y + r[1].y) / 2 };
      const farMid = { x: (r[2].x + r[3].x) / 2, y: (r[2].y + r[3].y) / 2 };
      const dx = farMid.x - nearMid.x;
      const dy = farMid.y - nearMid.y;
      const len = Math.hypot(dx, dy) || 1;
      this.downlane = { x: dx / len, y: dy / len };
    }

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
                const stepX = x - this.last.x;
                const stepY = y - this.last.y;
                const d = Math.hypot(stepX, stepY);
                if (d > this.opts.maxJump) ok = false;
                if (ok && this.opts.directionGate && this.downlane) {
                  const forward = stepX * this.downlane.x + stepY * this.downlane.y;
                  if (forward < -this.opts.backwardTolerance) ok = false; // no snapping backward
                }
                score = -d; // prefer nearest to last position
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
