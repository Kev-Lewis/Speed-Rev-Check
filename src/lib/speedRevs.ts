/*
 * speedRevs.ts
 * ==================
 * Pure calculation engine for bowling ball speed & rev rate from recorded video.
 *
 * Two ways in:
 *   - seconds-based  (preferred): timing comes from real per-frame timestamps,
 *     so DROPPED / IRREGULAR frames don't corrupt the result.
 *   - frame-based    (parity with the reference spreadsheet): time = frames / fps,
 *     which assumes a constant capture rate.
 * The frame-based functions delegate to the seconds core, so both share one math path.
 *
 * The lane's fixed distances are the ruler — no physical calibration needed:
 *   foul line -> arrows   = 15 ft  ("release", friction not yet a factor)
 *   foul line -> head pin = 60 ft  ("average", varies with ball/friction)
 *
 * No computer-vision dependency. The CV layer only needs to produce the elapsed
 * seconds (or frame counts) and rotation counts these functions consume.
 *
 * Verified against the reference sheet: 10.22727 = 15*0.681818, 40.909 = 60*0.681818,
 * M1 9f@60=400rpm, M3 11h/5f@60=660rpm, M4 0.16s=375rpm.
 */

/*
 * Constants
 * ==================
 */
const MPH_PER_FTPS = 3600 / 5280; // 0.6818182 — ft/s -> mph
const MPH_TO_KPH = 1.609344;
const HOURS_PER_ROTATION = 12; // clock-face method: a full turn is 12 "hours"

export const FOUL_TO_ARROWS_FT = 15; // release-speed reference distance
export const FOUL_TO_HEADPIN_FT = 60; // average-speed reference distance

/* Advisory sanity envelopes (flags, not hard rejects). */
const PLAUSIBLE_MPH = { min: 8, max: 26 } as const;
const PLAUSIBLE_RPM = { min: 100, max: 700 } as const;
const MIN_FPS_FOR_SPEED = 30;
const MIN_FPS_FOR_REVS = 60; // below this, rotation counting aliases badly

/*
 * Types
 * ==================
 */
export type SpeedKind = "release" | "average";

export interface SpeedResult {
  kind: SpeedKind;
  mph: number;
  kph: number;
  seconds: number;
  distanceFt: number;
  frames: number | null; // present only when computed from a frame count
  fps: number | null;
  warnings: string[];
}

export type RevMethod =
  | "rotationsOverSeconds" // timestamp-based, preferred
  | "framesPerRotation" // M1
  | "rotationsInWindow" // M2
  | "clockHours" // M3
  | "rotationTime"; // M4

export interface RevResult {
  method: RevMethod;
  rpm: number;
  fps: number | null; // null for timestamp/time-based methods
  warnings: string[];
}

/*
 * Speed — seconds core
 * ==================
 * mph = distanceFt * MPH_PER_FTPS / seconds
 */
function speedCore(
  distanceFt: number,
  seconds: number,
  kind: SpeedKind,
  meta: { frames?: number; fps?: number } = {}
): SpeedResult {
  if (!(seconds > 0)) throw new Error("seconds must be > 0");
  const mph = (distanceFt * MPH_PER_FTPS) / seconds;
  const kph = mph * MPH_TO_KPH;

  const warnings: string[] = [];
  if (meta.fps != null && meta.fps < MIN_FPS_FOR_SPEED)
    warnings.push(`Low FPS (${meta.fps}); frame-based speed timing is coarse.`);
  if (mph < PLAUSIBLE_MPH.min || mph > PLAUSIBLE_MPH.max)
    warnings.push(
      `Speed ${mph.toFixed(1)} mph is outside the typical ${PLAUSIBLE_MPH.min}-${PLAUSIBLE_MPH.max} mph range; clip may be invalid or miscounted.`
    );

  return {
    kind,
    mph,
    kph,
    seconds,
    distanceFt,
    frames: meta.frames ?? null,
    fps: meta.fps ?? null,
    warnings,
  };
}

/* Seconds-based (preferred, dropped-frame-proof) */
export function releaseSpeedFromSeconds(seconds: number): SpeedResult {
  return speedCore(FOUL_TO_ARROWS_FT, seconds, "release");
}
export function averageSpeedFromSeconds(seconds: number): SpeedResult {
  return speedCore(FOUL_TO_HEADPIN_FT, seconds, "average");
}

/* Frame-based (spreadsheet parity) — delegates to the seconds core */
export function releaseSpeed(framesFoulToArrows: number, fps: number): SpeedResult {
  if (!(fps > 0) || !(framesFoulToArrows > 0)) throw new Error("frames and fps must be > 0");
  return speedCore(FOUL_TO_ARROWS_FT, framesFoulToArrows / fps, "release", { frames: framesFoulToArrows, fps });
}
export function averageSpeed(framesFoulToHeadpin: number, fps: number): SpeedResult {
  if (!(fps > 0) || !(framesFoulToHeadpin > 0)) throw new Error("frames and fps must be > 0");
  return speedCore(FOUL_TO_HEADPIN_FT, framesFoulToHeadpin / fps, "average", { frames: framesFoulToHeadpin, fps });
}

/*
 * Rev rate
 * ==================
 * All methods reduce to (rotations per second) * 60.
 */
function flagRevs(rpm: number, fps: number | null): string[] {
  const warnings: string[] = [];
  if (fps !== null && fps < MIN_FPS_FOR_REVS)
    warnings.push(
      `FPS ${fps} < ${MIN_FPS_FOR_REVS}; rotation counting aliases and rev rate is unreliable. Use slow-motion capture.`
    );
  if (rpm < PLAUSIBLE_RPM.min || rpm > PLAUSIBLE_RPM.max)
    warnings.push(
      `Rev rate ${Math.round(rpm)} rpm is outside the typical ${PLAUSIBLE_RPM.min}-${PLAUSIBLE_RPM.max} rpm range; clip may be invalid or miscounted.`
    );
  return warnings;
}

/** Preferred: rotations counted over a real elapsed time window. rpm = 60 * rotations / seconds */
export function revsFromRotationsOverSeconds(rotations: number, seconds: number): RevResult {
  if (!(seconds > 0)) throw new Error("seconds must be > 0");
  if (!(rotations > 0)) throw new Error("rotations must be > 0");
  const rpm = (rotations / seconds) * 60;
  return { method: "rotationsOverSeconds", rpm, fps: null, warnings: flagRevs(rpm, null) };
}

/** M1 — frames for a single full rotation. rpm = 60 * fps / F */
export function revsFromFramesPerRotation(framesPerRotation: number, fps: number): RevResult {
  if (!(fps > 0) || !(framesPerRotation > 0)) throw new Error("framesPerRotation and fps must be > 0");
  const rpm = (fps / framesPerRotation) * 60;
  return { method: "framesPerRotation", rpm, fps, warnings: flagRevs(rpm, fps) };
}

/** M2 — rotations R across F frames. rpm = 60 * fps * R / F */
export function revsFromRotationsInWindow(rotations: number, frames: number, fps: number): RevResult {
  if (!(fps > 0) || !(frames > 0) || !(rotations > 0)) throw new Error("rotations, frames, fps must be > 0");
  const rpm = (rotations / frames) * fps * 60;
  return { method: "rotationsInWindow", rpm, fps, warnings: flagRevs(rpm, fps) };
}

/** M3 — clock-face: "hours" H across F frames (12 hours = one rotation). rpm = 5 * fps * H / F */
export function revsFromClockHours(hours: number, frames: number, fps: number): RevResult {
  if (!(fps > 0) || !(frames > 0) || !(hours > 0)) throw new Error("hours, frames, fps must be > 0");
  const rpm = (hours / HOURS_PER_ROTATION / frames) * fps * 60;
  return { method: "clockHours", rpm, fps, warnings: flagRevs(rpm, fps) };
}

/** M4 — time (seconds) for one rotation. rpm = 60 / T */
export function revsFromRotationTime(secondsPerRotation: number): RevResult {
  if (!(secondsPerRotation > 0)) throw new Error("secondsPerRotation must be > 0");
  const rpm = 60 / secondsPerRotation;
  return { method: "rotationTime", rpm, fps: null, warnings: flagRevs(rpm, null) };
}

/*
 * Combined analysis
 * ==================
 * Feed whatever the CV layer extracted; get the best available speed
 * (release preferred, seconds preferred) plus rev rate and a validity flag.
 */
export interface ClipMeasurements {
  fps?: number; // required only for frame-based inputs
  // Speed: supply seconds (preferred) OR frames
  secondsFoulToArrows?: number;
  secondsFoulToHeadpin?: number;
  framesFoulToArrows?: number;
  framesFoulToHeadpin?: number;
  // Revs: supply one
  rev?:
    | { method: "rotationsOverSeconds"; rotations: number; seconds: number }
    | { method: "framesPerRotation"; framesPerRotation: number }
    | { method: "rotationsInWindow"; rotations: number; frames: number }
    | { method: "clockHours"; hours: number; frames: number }
    | { method: "rotationTime"; secondsPerRotation: number };
}

export interface ClipAnalysis {
  valid: boolean;
  speed: SpeedResult | null;
  revs: RevResult | null;
  warnings: string[];
}

export function analyzeClip(m: ClipMeasurements): ClipAnalysis {
  const warnings: string[] = [];
  let speed: SpeedResult | null = null;
  let revs: RevResult | null = null;

  // Speed: prefer release over average, seconds over frames.
  if (m.secondsFoulToArrows != null) speed = releaseSpeedFromSeconds(m.secondsFoulToArrows);
  else if (m.framesFoulToArrows != null && m.fps != null) speed = releaseSpeed(m.framesFoulToArrows, m.fps);
  else if (m.secondsFoulToHeadpin != null) speed = averageSpeedFromSeconds(m.secondsFoulToHeadpin);
  else if (m.framesFoulToHeadpin != null && m.fps != null) speed = averageSpeed(m.framesFoulToHeadpin, m.fps);
  else warnings.push("No speed window measured (need foul-line->arrows or foul-line->head-pin timing).");

  if (m.rev) {
    switch (m.rev.method) {
      case "rotationsOverSeconds":
        revs = revsFromRotationsOverSeconds(m.rev.rotations, m.rev.seconds);
        break;
      case "framesPerRotation":
        if (m.fps == null) throw new Error("fps required for framesPerRotation");
        revs = revsFromFramesPerRotation(m.rev.framesPerRotation, m.fps);
        break;
      case "rotationsInWindow":
        if (m.fps == null) throw new Error("fps required for rotationsInWindow");
        revs = revsFromRotationsInWindow(m.rev.rotations, m.rev.frames, m.fps);
        break;
      case "clockHours":
        if (m.fps == null) throw new Error("fps required for clockHours");
        revs = revsFromClockHours(m.rev.hours, m.rev.frames, m.fps);
        break;
      case "rotationTime":
        revs = revsFromRotationTime(m.rev.secondsPerRotation);
        break;
    }
  } else {
    warnings.push("No rotation measurement provided; rev rate unavailable.");
  }

  const allWarnings = [...warnings, ...(speed?.warnings ?? []), ...(revs?.warnings ?? [])];
  // Calc-layer plausibility only; the CV layer owns "is this really a valid throw?".
  const valid = speed !== null && speed.warnings.length === 0 && (revs === null || revs.warnings.length === 0);

  return { valid, speed, revs, warnings: allWarnings };
}
