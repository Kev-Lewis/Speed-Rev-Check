/*
 * tapeTracker.ts
 * ==================
 * Rev-rate measurement by tracking a white tape mark on the ball.
 *
 * Per frame: inside the ball crop, threshold bright/low-saturation (white) pixels,
 * take their centroid = the tape, and record its ANGLE around the ball center.
 * Across the early frames (near release) the tape's angle sweeps; the total sweep
 * over the elapsed time gives revolutions/second -> RPM.
 *
 * We measure only the EARLY window on purpose: lane friction changes the ball's
 * rev rate down the lane, so the release rev rate is the meaningful number
 * (the rotational analog of release speed over the first 15 ft).
 *
 * No OpenCV — plain canvas pixel reads.
 */

export interface TapeReading {
  angle: number; // radians, tape position around the ball center
  tx: number;
  ty: number;
  count: number; // white-pixel count (confidence)
}

export interface TapeOptions {
  brightMin?: number; // min max-channel value to count as "white" (0-255)
  satMax?: number; // max saturation to count as "white"
  innerFrac?: number; // only look within this fraction of the radius (avoid the bright rim/lane)
  minCount?: number; // min white pixels to trust a reading
}

/** Find the tape's angle around the ball center in one frame, or null if not confidently visible. */
export function detectTapeAngle(
  src: HTMLCanvasElement,
  cx: number,
  cy: number,
  r: number,
  opts: TapeOptions = {}
): TapeReading | null {
  const brightMin = opts.brightMin ?? 200;
  const satMax = opts.satMax ?? 0.28;
  const innerR = (opts.innerFrac ?? 0.92) * r;
  const minCount = opts.minCount ?? 6;

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
  const innerR2 = innerR * innerR;
  let sx = 0;
  let sy = 0;
  let count = 0;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const gx = x0 + px;
      const gy = y0 + py;
      const ddx = gx - cx;
      const ddy = gy - cy;
      if (ddx * ddx + ddy * ddy > innerR2) continue;
      const i = (py * w + px) * 4;
      const R = data[i];
      const G = data[i + 1];
      const B = data[i + 2];
      const mx = Math.max(R, G, B);
      const mn = Math.min(R, G, B);
      const sat = mx > 0 ? (mx - mn) / mx : 0;
      if (mx >= brightMin && sat <= satMax) {
        sx += gx;
        sy += gy;
        count++;
      }
    }
  }

  if (count < minCount) return null;
  const tx = sx / count;
  const ty = sy / count;
  return { angle: Math.atan2(ty - cy, tx - cx), tx, ty, count };
}

export interface RevSample {
  mediaTime: number;
  angle: number;
}

export interface RevWindow {
  rotations: number;
  seconds: number;
  n: number;
}

/**
 * Accumulate the tape's angular sweep over the earliest usable run of frames.
 * Unwraps frame-to-frame angle steps (valid while < half a turn per frame).
 * Returns rotations + elapsed seconds for the early (release) window.
 */
export function computeRevWindow(samples: RevSample[], maxFrames = 20): RevWindow | null {
  if (samples.length < 3) return null;
  const early = samples.slice(0, maxFrames);
  let acc = 0;
  let prev = early[0].angle;
  for (let i = 1; i < early.length; i++) {
    let d = early[i].angle - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    acc += d;
    prev = early[i].angle;
  }
  const rotations = Math.abs(acc) / (2 * Math.PI);
  const seconds = early[early.length - 1].mediaTime - early[0].mediaTime;
  if (seconds <= 0 || rotations < 0.25) return null;
  return { rotations, seconds, n: early.length };
}
