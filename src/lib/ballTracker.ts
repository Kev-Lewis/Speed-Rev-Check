/*
 * ballTracker.ts
 * ==================
 * Classical (no-ML) ball tracker using OpenCV.js background subtraction.
 *
 * Pipeline: MOG2 background subtraction -> denoise -> contours -> keep blobs that
 * pass size + roundness + lane-region + expected-size + direction gates -> among
 * survivors, prefer the one nearest the last position (or best size-match on first
 * acquisition).
 *
 * Gates:
 *  - roi (lane quad): excludes the bowler/hand and delays the track until the ball
 *    crosses the near edge (foul line).
 *  - expected size: the lane quad gives lane width at every depth; a ball is a fixed
 *    fraction of that, so we know how big the ball should look at each point. Blobs
 *    far off that size (merged reflection, hand, head) are rejected, and first
 *    acquisition prefers the best size-match rather than the biggest blob.
 *  - down-lane direction: once moving, candidates must have a forward component, so
 *    the track can't snap backward onto the hand.
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
  roi?: Point[]; // lane quad, order: foulL, foulR, pinR, pinL. Empty = no gating.
  minArea?: number;
  maxArea?: number;
  minCircularity?: number;
  maxJump?: number;
  maxMisses?: number;
  directionGate?: boolean;
  backwardTolerance?: number;
  ballRadiusRatio?: number; // ball radius as a fraction of local lane width (~0.1)
  sizeGateLo?: number; // accept radius >= expected * sizeGateLo
  sizeGateHi?: number; // accept radius <= expected * sizeGateHi
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

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export class BallTracker {
  private cv: CV;
  private fgMask: CV;
  private kernel: CV;
  private mog2: CV;
  private last: { x: number; y: number } | null = null;
  private misses = 0;
  private opts: Required<BallTrackerOptions>;

  // lane geometry (set when roi has 4 corners)
  private nearMid: Point | null = null;
  private downlane: Point | null = null; // unit vector foul line -> pins
  private laneLen = 1;
  private nearWidth = 0;
  private farWidth = 0;

  readonly path: BallDetection[] = [];

  constructor(cv: CV, opts: BallTrackerOptions = {}) {
    this.cv = cv;
    this.opts = {
      roi: [],
      minArea: 150,
      maxArea: 20000,
      minCircularity: 0.45,
      maxJump: 400,
      maxMisses: 8,
      directionGate: true,
      backwardTolerance: 15,
      ballRadiusRatio: 0.1,
      sizeGateLo: 0.35,
      sizeGateHi: 3.0,
      morphSize: 5,
      mog2History: 120,
      mog2VarThreshold: 32,
      ...opts,
    };

    if (this.opts.roi.length === 4) {
      const r = this.opts.roi;
      this.nearMid = mid(r[0], r[1]);
      const farMid = mid(r[2], r[3]);
      const dx = farMid.x - this.nearMid.x;
      const dy = farMid.y - this.nearMid.y;
      this.laneLen = Math.hypot(dx, dy) || 1;
      this.downlane = { x: dx / this.laneLen, y: dy / this.laneLen };
      this.nearWidth = dist(r[0], r[1]);
      this.farWidth = dist(r[2], r[3]);
    }

    this.fgMask = new cv.Mat();
    this.kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(this.opts.morphSize, this.opts.morphSize));
    this.mog2 = new cv.BackgroundSubtractorMOG2(this.opts.mog2History, this.opts.mog2VarThreshold, false);
  }

  /** Expected ball radius (px) at a point, from lane-width perspective. 0 if no lane geometry. */
  private expectedRadius(p: Point): number {
    if (!this.nearMid || !this.downlane) return 0;
    const relX = p.x - this.nearMid.x;
    const relY = p.y - this.nearMid.y;
    let t = (relX * this.downlane.x + relY * this.downlane.y) / this.laneLen;
    t = Math.max(0, Math.min(1, t));
    const localWidth = this.nearWidth + t * (this.farWidth - this.nearWidth);
    return this.opts.ballRadiusRatio * localWidth;
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
    const sizeOn = this.opts.roi.length === 4;
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
            const r = Math.sqrt(area / Math.PI);
            let ok = true;

            if (gateOn && !pointInPolygon({ x, y }, this.opts.roi)) ok = false; // lane gate

            // expected-size gate: rejects merged reflection blobs, hand, head
            const expR = sizeOn ? this.expectedRadius({ x, y }) : 0;
            if (ok && sizeOn && expR > 0) {
              if (r < expR * this.opts.sizeGateLo || r > expR * this.opts.sizeGateHi) ok = false;
            }

            let score = 0;
            if (ok) {
              if (this.last) {
                const stepX = x - this.last.x;
                const stepY = y - this.last.y;
                const d = Math.hypot(stepX, stepY);
                if (d > this.opts.maxJump) ok = false;
                if (ok && this.opts.directionGate && this.downlane) {
                  const forward = stepX * this.downlane.x + stepY * this.downlane.y;
                  if (forward < -this.opts.backwardTolerance) ok = false;
                }
                score = -d; // prefer nearest to last position
              } else {
                // first acquisition: prefer the best size-match (not the biggest blob)
                score = expR > 0 ? -Math.abs(r - expR) : area;
              }
            }

            if (ok && score > bestScore) {
              bestScore = score;
              best = { index, mediaTime, x, y, r, area, circularity };
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
