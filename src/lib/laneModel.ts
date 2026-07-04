/*
 * laneModel.ts
 * ==================
 * Lane geometry from the 4 clicked corners. Turns image points into lane-relative
 * measures: depth along the lane (foul line -> arrows) and lateral offset from the
 * center line. Used both to gate detections (is this ball in this lane's corridor?)
 * and to find crossing times for the speed calc.
 *
 * Corner order: foulL, foulR, farR, farL   (far edge = arrows for release speed).
 */

export interface Point {
  x: number;
  y: number;
}

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

export class LaneModel {
  readonly roi: Point[];
  readonly realDistanceFt: number;
  readonly nearMid: Point;
  readonly farMid: Point;
  readonly downlane: Point; // unit vector, foul line -> far edge
  readonly normal: Point; // unit vector, across the lane
  readonly laneLen: number; // px from foul line to far edge (along downlane)
  readonly nearWidth: number;
  readonly farWidth: number;

  constructor(corners: Point[], realDistanceFt: number) {
    if (corners.length !== 4) throw new Error("LaneModel needs 4 corners: foulL, foulR, farR, farL");
    this.roi = corners;
    this.realDistanceFt = realDistanceFt;
    this.nearMid = mid(corners[0], corners[1]);
    this.farMid = mid(corners[2], corners[3]);
    const d = sub(this.farMid, this.nearMid);
    this.laneLen = Math.hypot(d.x, d.y) || 1;
    this.downlane = { x: d.x / this.laneLen, y: d.y / this.laneLen };
    this.normal = { x: -this.downlane.y, y: this.downlane.x };
    this.nearWidth = dist(corners[0], corners[1]);
    this.farWidth = dist(corners[2], corners[3]);
  }

  /** Distance along the lane in px: 0 at foul line, laneLen at the far edge (may be <0 or >laneLen). */
  depthPx(p: Point): number {
    return dot(sub(p, this.nearMid), this.downlane);
  }

  /** Perpendicular offset from the lane center line, px (always >= 0). */
  lateralPx(p: Point): number {
    return Math.abs(dot(sub(p, this.nearMid), this.normal));
  }

  /** Lane width in px at the given point's depth (perspective interpolation). */
  localWidth(p: Point): number {
    let t = this.depthPx(p) / this.laneLen;
    t = Math.max(0, Math.min(1, t));
    return this.nearWidth + t * (this.farWidth - this.nearWidth);
  }

  /** Expected ball radius in px at a point (~ball is 0.1 of lane width). */
  expectedRadius(p: Point): number {
    return 0.1 * this.localWidth(p);
  }
}

/** Interpolate the mediaTime at which the path's depth first crosses targetDepthPx (rising). */
export function crossingTime(
  path: Array<{ mediaTime: number; depthPx: number }>,
  targetDepthPx: number
): number | null {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (a.depthPx < targetDepthPx && b.depthPx >= targetDepthPx) {
      const span = b.depthPx - a.depthPx || 1;
      const frac = (targetDepthPx - a.depthPx) / span;
      return a.mediaTime + frac * (b.mediaTime - a.mediaTime);
    }
  }
  return null;
}
