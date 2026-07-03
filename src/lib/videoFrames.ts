/*
 * videoFrames.ts
 * ==================
 * Client-side frame reader for the analyzer. Streams decoded frames with their
 * REAL presentation timestamps (mediaTime) and reports timing irregularities.
 *
 * Why this exists: the reference method assumes constant fps (time = frames/fps).
 * Phones drop frames in low light, so that assumption silently corrupts results.
 * Here every frame carries its true mediaTime, so downstream code measures elapsed
 * SECONDS between events (foul line -> arrows, etc.) and feeds speedRevs.ts's
 * seconds-based path — dropped frames stop mattering for timing.
 *
 * Decoder choice:
 *   - requestVideoFrameCallback (this module): simple, broadly supported, great for
 *     SPEED and the validity/landmark gate. Caveat: it surfaces frames at
 *     min(displayRefreshHz, videoFps). On a 60Hz screen a 240fps slow-mo clip yields
 *     ~60 frames/s — fine for timing crossings, NOT enough to count fast rotations.
 *   - WebCodecs + mp4box.js (separate module, for the REV path): decodes EVERY encoded
 *     frame regardless of display refresh. Required for rev counting on slow-mo clips.
 *
 * Fully static / no dependencies — runs on GitHub Pages.
 */

export interface Frame {
  index: number; // sequential index of frames we actually saw
  mediaTime: number; // seconds, position in the media timeline (authoritative clock)
  width: number;
  height: number;
  canvas: HTMLCanvasElement; // reused each frame — copy out if you need to keep it
}

export interface FrameTimingReport {
  frameCount: number;
  durationSeconds: number;
  estimatedFps: number; // 1 / median(inter-frame interval)
  medianIntervalMs: number;
  captureGaps: Array<{ afterIndex: number; gapMs: number }>; // irregular source spacing (likely dropped-at-capture)
  playbackSkips: number; // frames the browser skipped during our playback (presentedFrames jumps)
  refreshLimited: boolean; // true if estimatedFps ~ a common display rate (rVFC may be capping)
  warnings: string[];
}

export interface ExtractOptions {
  playbackRate?: number; // default 1 for accuracy; raise to trade accuracy for speed
  gapFactor?: number; // interval > gapFactor * median => flagged as a capture gap (default 1.6)
  signal?: AbortSignal;
}

/**
 * Stream every presented frame through `onFrame`, then resolve with a timing report.
 * `onFrame` may be async; extraction awaits it before advancing (back-pressure).
 */
export function extractFrames(
  file: File | Blob,
  onFrame: (frame: Frame) => void | Promise<void>,
  options: ExtractOptions = {}
): Promise<FrameTimingReport> {
  const { playbackRate = 1, gapFactor = 1.6, signal } = options;

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      cleanup();
      reject(new Error("2D canvas context unavailable"));
      return;
    }

    const times: number[] = [];
    let index = 0;
    let lastPresented: number | null = null;
    let playbackSkips = 0;
    let done = false;

    const anyVideo = video as unknown as {
      requestVideoFrameCallback?: (cb: (now: number, md: VideoFrameCallbackMetadata) => void) => number;
    };
    if (typeof anyVideo.requestVideoFrameCallback !== "function") {
      cleanup();
      reject(new Error("requestVideoFrameCallback not supported; use the WebCodecs reader instead."));
      return;
    }

    function cleanup() {
      video.pause();
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
    }

    function onAbort() {
      if (done) return;
      done = true;
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    const step = async (_now: number, md: VideoFrameCallbackMetadata) => {
      if (done) return;

      if (lastPresented != null && md.presentedFrames - lastPresented > 1) {
        playbackSkips += md.presentedFrames - lastPresented - 1;
      }
      lastPresented = md.presentedFrames;

      canvas.width = md.width;
      canvas.height = md.height;
      ctx.drawImage(video, 0, 0, md.width, md.height);
      times.push(md.mediaTime);

      try {
        await onFrame({ index, mediaTime: md.mediaTime, width: md.width, height: md.height, canvas });
      } catch (err) {
        done = true;
        cleanup();
        reject(err);
        return;
      }
      index++;
      if (!done) anyVideo.requestVideoFrameCallback!(step);
    };

    video.addEventListener("error", () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("Video failed to load or decode."));
    });

    video.addEventListener("loadedmetadata", () => {
      video.playbackRate = playbackRate;
    });

    video.addEventListener("ended", () => {
      if (done) return;
      done = true;
      cleanup();
      resolve(buildReport(times, playbackSkips, video.duration, gapFactor));
    });

    anyVideo.requestVideoFrameCallback!(step);
    video.play().catch((err) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    });
  });
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function buildReport(
  times: number[],
  playbackSkips: number,
  durationSeconds: number,
  gapFactor: number
): FrameTimingReport {
  const warnings: string[] = [];
  const intervals: number[] = [];
  for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);

  const medInterval = median(intervals);
  const estimatedFps = medInterval > 0 ? 1 / medInterval : 0;

  const captureGaps: Array<{ afterIndex: number; gapMs: number }> = [];
  intervals.forEach((iv, i) => {
    if (medInterval > 0 && iv > gapFactor * medInterval) {
      captureGaps.push({ afterIndex: i, gapMs: iv * 1000 });
    }
  });

  // rVFC caps at display refresh; if fps lands right on a common rate, warn it may be capped.
  const refreshLimited = [60, 120, 144, 240].some((hz) => Math.abs(estimatedFps - hz) < 1.5);

  if (captureGaps.length > 0)
    warnings.push(
      `${captureGaps.length} irregular frame gap(s) detected — timing is measured by timestamp, so results stay valid, but a rotation may fall inside a gap.`
    );
  if (playbackSkips > 0)
    warnings.push(`Browser skipped ${playbackSkips} frame(s) during playback; lower playbackRate or use the WebCodecs reader for full-rate decode.`);
  if (refreshLimited)
    warnings.push(
      `Effective rate ~${estimatedFps.toFixed(0)} fps may be display-refresh-limited. For rev counting on slow-mo, use the WebCodecs reader.`
    );

  return {
    frameCount: times.length,
    durationSeconds,
    estimatedFps,
    medianIntervalMs: medInterval * 1000,
    captureGaps,
    playbackSkips,
    refreshLimited,
    warnings,
  };
}

/** Elapsed seconds between two captured frames — feeds speedRevs.ts's seconds-based functions. */
export function secondsBetween(a: Frame, b: Frame): number {
  return Math.abs(b.mediaTime - a.mediaTime);
}
