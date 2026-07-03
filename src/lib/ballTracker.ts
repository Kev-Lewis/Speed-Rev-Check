/*
 * ballTracker.ts
 * ==================
 * Classical (no-ML) ball tracker using OpenCV.js background subtraction.
 * Feed it decoded frames in order; it returns the ball's per-frame position.
 *
 * Method: MOG2 background subtraction (static lane, moving ball) -> denoise ->
 * contours -> keep blobs that are the right size AND round enough -> pick the
 * one closest to the previous position (temporal continuity), or the largest
 * round blob when first acquiring the track.
 *
 * This is a first pass: it WILL need per-clip tuning and may occasionally lock
 * onto the bowler or pins. The live overlay is there so you can see that happen
 * and adjust the options below. Every Mat is released to avoid wasm memory leaks.
 */

type CV = any;

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
  minArea?: number; // ignore blobs smaller than this (px^2)
  maxArea?: number; // ignore blobs larger than this (excludes the bowler's body)
  minCircularity?: number; // 1.0 = perfect circle; ball is usually > 0.55
  maxJump?: number; // max px the ball may move between frames once tracked
  maxMisses?: number; // consecutive misses before allowing re-acquisition
  morphSize?: number; // denoise kernel size
  mog2History?: number;
  mog2VarThreshold?: number;
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
      minArea: 200,
      maxArea: 8000,
      minCircularity: 0.55,
      maxJump: 250,
      maxMisses: 8,
      morphSize: 5,
      mog2History: 120,
      mog2VarThreshold: 32,
      ...opts,
    };
    this.fgMask = new cv.Mat();
    this.kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(this.opts.morphSize, this.opts.morphSize));
    // (history, varThreshold, detectShadows=false) -> clean binary mask
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
            let score: number;
            if (this.last) {
              const d = Math.hypot(x - this.last.x, y - this.last.y);
              if (d > this.opts.maxJump) ok = false;
              score = -d; // prefer the blob nearest the last known position
            } else {
              score = area; // first acquisition: the biggest round blob
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
      if (this.misses >= this.opts.maxMisses) this.last = null; // allow re-acquisition
    }
    return best;
  }

  dispose(): void {
    this.fgMask.delete();
    this.kernel.delete();
    this.mog2.delete();
  }
}
