/*
 * videoFramesWebCodecs.ts
 * ==================
 * Full-rate frame reader built on WebCodecs + mp4box.js. Unlike the
 * requestVideoFrameCallback reader (videoFrames.ts), this decodes EVERY encoded
 * frame regardless of playback speed or display refresh — required for rev
 * counting and for accurate crossing timestamps on high-fps / slow-mo clips.
 *
 * It also reads the TRUE fps and duration from the container (fixes the
 * durationSeconds: null / effective-fps problems seen with the rVFC reader).
 *
 * Setup:  npm install mp4box
 * The `Frame` / `FrameTimingReport` shapes match videoFrames.ts, so this is a
 * drop-in replacement for extractFrames().
 *
 * Browser support: Chrome/Edge, Safari 16.4+, recent Firefox. Feature-detect
 * `window.VideoDecoder` and fall back to the rVFC reader where it's missing.
 */

import MP4Box, { type MP4File, type MP4Info, type MP4Sample, type MP4VideoTrack } from "mp4box";
import type { Frame, FrameTimingReport } from "./videoFrames";

export interface WebCodecsExtractOptions {
  maxInFlight?: number; // decoder/consumer backpressure window (default 8)
  gapFactor?: number; // interval > gapFactor * median => flagged capture gap (default 1.6)
  signal?: AbortSignal;
}

export function isWebCodecsSupported(): boolean {
  return typeof (globalThis as unknown as { VideoDecoder?: unknown }).VideoDecoder !== "undefined";
}

/** Pull the codec description (avcC/hvcC/…) bytes needed to configure the decoder. */
function getDescription(file: MP4File, trackId: number): Uint8Array | undefined {
  const trak = file.getTrackById(trackId) as {
    mdia: { minf: { stbl: { stsd: { entries: Array<Record<string, { write(s: unknown): void } | undefined>> } } } };
  };
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // strip the 8-byte box header
    }
  }
  return undefined;
}

const delay = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Decode every frame of `file`, streaming each through `onFrame` (awaited, in order).
 * Resolves with a timing report built from real container timestamps.
 */
export async function extractFramesWebCodecs(
  file: File | Blob,
  onFrame: (frame: Frame) => void | Promise<void>,
  options: WebCodecsExtractOptions = {}
): Promise<FrameTimingReport> {
  const { maxInFlight = 8, gapFactor = 1.6, signal } = options;

  if (!isWebCodecsSupported()) throw new Error("WebCodecs not supported in this browser.");

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context unavailable");

  const mp4 = MP4Box.createFile() as MP4File;
  const queue: Array<{ mediaTime: number; frame: VideoFrame }> = [];
  const times: number[] = [];
  const samples: MP4Sample[] = [];

  let track: MP4VideoTrack | null = null;
  let infoDuration = 0;
  let infoTimescale = 1;
  let decodeError: Error | null = null;
  let allSamplesReceived = false;

  const decoder = new VideoDecoder({
    output: (frame) => {
      queue.push({ mediaTime: frame.timestamp / 1e6, frame });
    },
    error: (e) => {
      decodeError = e instanceof Error ? e : new Error(String(e));
    },
  });

  // --- demux ---
  const ready = new Promise<void>((resolve, reject) => {
    mp4.onError = (e) => reject(new Error(`mp4box: ${e}`));
    mp4.onReady = (info: MP4Info) => {
      const vtrack = info.videoTracks[0];
      if (!vtrack) return reject(new Error("No video track found."));
      track = vtrack;
      infoDuration = info.duration;
      infoTimescale = info.timescale || 1;
      decoder.configure({
        codec: vtrack.codec,
        codedWidth: vtrack.video.width,
        codedHeight: vtrack.video.height,
        description: getDescription(mp4, vtrack.id),
      });
      mp4.setExtractionOptions(vtrack.id, null, { nbSamples: vtrack.nb_samples });
      mp4.start();
      resolve();
    };
    mp4.onSamples = (_id, _user, s) => {
      for (const smp of s) samples.push(smp);
      if (track && samples.length >= track.nb_samples) allSamplesReceived = true;
    };
  });

  const ab = (await file.arrayBuffer()) as ArrayBuffer & { fileStart: number };
  ab.fileStart = 0;
  mp4.appendBuffer(ab);
  mp4.flush();
  await ready;

  // Wait until mp4box has handed us all samples.
  while (!allSamplesReceived) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await delay();
  }

  // --- consumer: drain decoded frames in order, awaiting onFrame (canvas reuse is safe) ---
  let consuming = true;
  let inputDone = false;
  const consumer = (async () => {
    while (consuming) {
      if (decodeError) throw decodeError;
      const item = queue.shift();
      if (!item) {
        if (inputDone && queue.length === 0) break;
        await delay();
        continue;
      }
      canvas.width = item.frame.displayWidth;
      canvas.height = item.frame.displayHeight;
      ctx.drawImage(item.frame, 0, 0);
      const w = item.frame.displayWidth;
      const h = item.frame.displayHeight;
      item.frame.close();
      times.push(item.mediaTime);
      await onFrame({ index: times.length - 1, mediaTime: item.mediaTime, width: w, height: h, canvas });
    }
  })();

  // --- feed samples into the decoder with backpressure ---
  try {
    for (const s of samples) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      while (decoder.decodeQueueSize > maxInFlight || queue.length > maxInFlight) {
        if (decodeError) throw decodeError;
        await delay();
      }
      decoder.decode(
        new EncodedVideoChunk({
          type: s.is_sync ? "key" : "delta",
          timestamp: (s.cts * 1e6) / s.timescale,
          duration: (s.duration * 1e6) / s.timescale,
          data: s.data,
        })
      );
    }
    await decoder.flush();
  } finally {
    inputDone = true;
  }

  await consumer;
  consuming = false;
  decoder.close();
  while (queue.length) queue.shift()!.frame.close(); // safety: release any stragglers
  if (decodeError) throw decodeError;

  // --- report from true container timing ---
  const containerDuration = infoTimescale ? infoDuration / infoTimescale : 0;
  const durationSeconds = containerDuration || (times.length ? times[times.length - 1] : 0);
  return buildReport(times, durationSeconds, gapFactor);
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function buildReport(times: number[], durationSeconds: number, gapFactor: number): FrameTimingReport {
  const warnings: string[] = [];
  const intervals: number[] = [];
  for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i - 1]);

  const medInterval = median(intervals);
  const estimatedFps = medInterval > 0 ? 1 / medInterval : times.length / (durationSeconds || 1);

  const captureGaps: Array<{ afterIndex: number; gapMs: number }> = [];
  intervals.forEach((iv, i) => {
    if (medInterval > 0 && iv > gapFactor * medInterval) captureGaps.push({ afterIndex: i, gapMs: iv * 1000 });
  });

  if (captureGaps.length > 0)
    warnings.push(
      `${captureGaps.length} irregular frame gap(s) in the source — timing stays valid (measured by timestamp), but a rotation may fall inside a gap.`
    );
  if (estimatedFps < 60)
    warnings.push(`~${estimatedFps.toFixed(0)} fps capture; rev counting is marginal below 60 fps. Prefer slow-motion for rev rate.`);

  return {
    frameCount: times.length,
    durationSeconds,
    estimatedFps,
    medianIntervalMs: medInterval * 1000,
    captureGaps,
    playbackSkips: 0, // WebCodecs decodes every frame; nothing is skipped
    refreshLimited: false,
    warnings,
  };
}
