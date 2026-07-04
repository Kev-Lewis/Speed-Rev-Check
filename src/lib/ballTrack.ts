/*
 * ballTrack.ts
 * ==================
 * Picks the in-play ball from YOLO detections and builds its trajectory.
 * No OpenCV — YOLO is the detector; this just selects + tracks.
 *
 * Per frame it receives ball candidates (box centers + radius + confidence) and
 * chooses the one that is (a) inside the lane corridor laterally, (b) a plausible
 * size, (c) near the last position and moving down-lane. A commit rule requires
 * real down-lane progress before trusting the track, so a stray detection (e.g. a
 * ball in the return) can't seed it.
 */

import { LaneModel, type Point } from "./laneModel";

export interface Candidate {
  x: number;
  y: number;
  r: number; // half the mean box side
  score: number;
}

export interface Sample {
  mediaTime: number;
  x: number;
  y: number;
  depthPx: number;
  score: number;
}

export interface BallTrackOptions {
  maxJumpPx?: number;
  backwardTolPx?: number;
  corridorFactor?: number; // lateral offset allowed, as a fraction of local lane width
  sizeLo?: number;
  sizeHi?: number;
  commitFrames?: number;
  commitProgressFrac?: number; // required down-lane progress as a fraction of lane length
}

export class BallTrack {
  private lane: LaneModel;
  private opts: Required<BallTrackOptions>;
  private last: Point | null = null;
  private committed = false;
  private tentative: Sample[] = [];
  readonly path: Sample[] = [];

  constructor(lane: LaneModel, opts: BallTrackOptions = {}) {
    this.lane = lane;
    this.opts = {
      maxJumpPx: 400,
      backwardTolPx: 20,
      corridorFactor: 0.65,
      sizeLo: 0.3,
      sizeHi: 3.0,
      commitFrames: 3,
      commitProgressFrac: 0.04,
      ...opts,
    };
  }

  /** Feed one frame's ball candidates. Returns the chosen ball (or null). */
  addFrame(candidates: Candidate[], mediaTime: number): Candidate | null {
    let best: Candidate | null = null;
    let bestScore = -Infinity;

    for (const c of candidates) {
      const p: Point = { x: c.x, y: c.y };
      let ok = true;

      // in this lane's corridor (rejects the return balls / adjacent lanes)
      if (this.lane.lateralPx(p) > this.opts.corridorFactor * this.lane.localWidth(p)) ok = false;

      // plausible size for this depth
      const expR = this.lane.expectedRadius(p);
      if (ok && expR > 0 && (c.r < expR * this.opts.sizeLo || c.r > expR * this.opts.sizeHi)) ok = false;

      let score = 0;
      if (ok) {
        if (this.last) {
          const dx = c.x - this.last.x;
          const dy = c.y - this.last.y;
          const d = Math.hypot(dx, dy);
          if (d > this.opts.maxJumpPx) ok = false;
          const forward = dx * this.lane.downlane.x + dy * this.lane.downlane.y;
          if (ok && forward < -this.opts.backwardTolPx) ok = false;
          score = c.score * 100 - d; // prefer confident + nearest
        } else {
          score = c.score; // first acquisition: most confident in-corridor ball
        }
      }

      if (ok && score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    if (best) {
      const s: Sample = { mediaTime, x: best.x, y: best.y, depthPx: this.lane.depthPx({ x: best.x, y: best.y }), score: best.score };
      this.last = { x: best.x, y: best.y };
      if (this.committed) {
        this.path.push(s);
      } else {
        this.tentative.push(s);
        if (this.tentative.length >= this.opts.commitFrames) {
          const progress = this.tentative[this.tentative.length - 1].depthPx - this.tentative[0].depthPx;
          if (progress >= this.opts.commitProgressFrac * this.lane.laneLen) {
            this.committed = true;
            for (const t of this.tentative) this.path.push(t);
            this.tentative = [];
          } else {
            this.tentative.shift();
          }
        }
      }
    }
    return best;
  }
}
