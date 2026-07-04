import { useRef, useState } from "react";
import { extractFramesWebCodecs, isWebCodecsSupported } from "./lib/videoFramesWebCodecs";
import { extractFrames } from "./lib/videoFrames";
import { loadYolo, detect } from "./lib/yoloDetector";
import { LaneModel, fitDepthSlope, type Point } from "./lib/laneModel";
import { BallTrack, type Candidate } from "./lib/ballTrack";
import { releaseSpeedFromSeconds } from "./lib/speedRevs";

type Phase = "idle" | "calibrating" | "ready" | "tracking" | "done";
const FOUL_TO_ARROWS_FT = 15;
const CORNER_LABELS = ["foul line — LEFT", "foul line — RIGHT", "arrows — RIGHT", "arrows — LEFT"];

// --- Tunables (calibrate against your hand-measured throw) ---
const LOFT_SKIP = 0; // fit the full 15 ft window (matches foul→arrows averaging; release is the fast part)
const SPEED_CALIBRATION = 1.08; // corrects far-edge/arrows placement scale to hand-measured truth

function smooth(pts: Point[], w = 3): Point[] {
  if (pts.length <= 2) return pts;
  return pts.map((_, i) => {
    let sx = 0,
      sy = 0,
      c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(pts.length - 1, i + w); j++) {
      sx += pts[j].x;
      sy += pts[j].y;
      c++;
    }
    return { x: sx / c, y: sy / c };
  });
}

/** Least-squares line y = m*x + b. */
function linreg(xs: number[], ys: number[]): { m: number; b: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const d = n * sxx - sx * sx;
  if (Math.abs(d) < 1e-9) return null;
  const m = (n * sxy - sx * sy) / d;
  return { m, b: (sy - m * sx) / n };
}

/** Intersection of the infinite line O + t*D with the line through A,B. */
function lineIntersect(O: Point, D: Point, A: Point, B: Point): Point | null {
  const ex = B.x - A.x;
  const ey = B.y - A.y;
  const det = -D.x * ey + ex * D.y;
  if (Math.abs(det) < 1e-9) return null;
  const t = (-(A.x - O.x) * ey + ex * (A.y - O.y)) / det;
  return { x: O.x + t * D.x, y: O.y + t * D.y };
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [points, setPoints] = useState<Point[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState("");
  const [summary, setSummary] = useState("");

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setFile(f);
    setPoints([]);
    setSummary("");
    setStatus("Loading preview…");
    try {
      const url = URL.createObjectURL(f);
      const video = document.createElement("video");
      video.src = url;
      video.muted = true;
      video.playsInline = true;
      await new Promise<void>((res, rej) => {
        video.onloadeddata = () => res();
        video.onerror = () => rej(new Error("Could not load video for preview."));
      });
      video.currentTime = Math.min(1.2, (video.duration || 3) / 2);
      await new Promise<void>((res) => (video.onseeked = () => res()));
      const display = canvasRef.current!;
      display.width = video.videoWidth;
      display.height = video.videoHeight;
      display.getContext("2d")!.drawImage(video, 0, 0);
      const pv = document.createElement("canvas");
      pv.width = display.width;
      pv.height = display.height;
      pv.getContext("2d")!.drawImage(display, 0, 0);
      previewRef.current = pv;
      URL.revokeObjectURL(url);
      setPhase("calibrating");
      setStatus(`Click 4 corners: ${CORNER_LABELS.join(" → ")}.`);
    } catch (err) {
      setStatus(`Preview failed: ${(err as Error).message}`);
      setPhase("idle");
    }
  }

  function redraw(pts: Point[]) {
    const display = canvasRef.current;
    const pv = previewRef.current;
    if (!display || !pv) return;
    const ctx = display.getContext("2d")!;
    ctx.drawImage(pv, 0, 0);
    ctx.strokeStyle = "yellow";
    ctx.fillStyle = "yellow";
    ctx.lineWidth = 2;
    ctx.font = "16px monospace";
    if (pts.length >= 2) {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (pts.length === 4) ctx.closePath();
      ctx.stroke();
    }
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillText(String(i + 1), p.x + 9, p.y - 9);
    });
  }

  function onCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (phase !== "calibrating") return;
    const display = canvasRef.current!;
    const rect = display.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (display.width / rect.width);
    const y = (e.clientY - rect.top) * (display.height / rect.height);
    const next = [...points, { x, y }].slice(0, 4);
    setPoints(next);
    redraw(next);
    if (next.length === 4) {
      setPhase("ready");
      setStatus("Lane set (near edge = foul line, far edge = arrows). Click Measure.");
    } else {
      setStatus(`Corner ${next.length + 1}: click ${CORNER_LABELS[next.length]}.`);
    }
  }

  async function measure() {
    if (!file || points.length !== 4) return;
    setPhase("tracking");
    setSummary("");
    setStatus("Loading YOLO…");
    try {
      await loadYolo();
    } catch (err) {
      setStatus(`YOLO load failed: ${(err as Error).message}`);
      setPhase("ready");
      return;
    }

    const lane = new LaneModel(points, FOUL_TO_ARROWS_FT);
    const track = new BallTrack(lane);
    const display = canvasRef.current!;
    const dctx = display.getContext("2d")!;
    const reader = isWebCodecsSupported() ? extractFramesWebCodecs : extractFrames;
    let total = 0;
    let hits = 0;
    setStatus("Detecting + tracking… (wasm inference is slow)");

    const drawLane = () => {
      dctx.strokeStyle = "rgba(255,255,0,0.7)";
      dctx.lineWidth = 2;
      dctx.beginPath();
      points.forEach((p, i) => (i ? dctx.lineTo(p.x, p.y) : dctx.moveTo(p.x, p.y)));
      dctx.closePath();
      dctx.stroke();
    };

    try {
      await reader(file, async (frame) => {
        total++;
        const dets = await detect(frame.canvas, 0.3);
        const candidates: Candidate[] = dets.map((d) => ({
          x: d.x + d.w / 2,
          y: d.y + d.h, // contact point (bottom of ball, on the lane plane)
          r: (d.w + d.h) / 4,
          score: d.score,
        }));
        const chosen = track.addFrame(candidates, frame.mediaTime);
        if (chosen) hits++;

        if (display.width !== frame.width) {
          display.width = frame.width;
          display.height = frame.height;
        }
        dctx.drawImage(frame.canvas, 0, 0);
        drawLane();
        // faint live trail for feedback
        if (track.path.length > 1) {
          const sm = smooth(track.path.map((s) => ({ x: s.x, y: s.y })));
          dctx.strokeStyle = "rgba(0,200,255,0.45)";
          dctx.lineWidth = 2;
          dctx.beginPath();
          sm.forEach((p, i) => (i ? dctx.lineTo(p.x, p.y) : dctx.moveTo(p.x, p.y)));
          dctx.stroke();
        }
        if (chosen) {
          dctx.strokeStyle = "lime";
          dctx.lineWidth = 3;
          dctx.beginPath();
          dctx.arc(chosen.x, chosen.y - chosen.r, chosen.r, 0, 2 * Math.PI);
          dctx.stroke();
        }
        if (total % 20 === 0) setStatus(`Tracking… ${total} frames, ball in ${hits}`);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      });

      // --- fit the ROLLING segment (skip the airborne loft by TIME, not depth) ---
      const rolling = track.path.slice(LOFT_SKIP).filter((s) => s.depthPx >= 0 && s.depthPx <= lane.laneLen);
      const slopeFit = fitDepthSlope(rolling.map((s) => ({ mediaTime: s.mediaTime, depthPx: s.depthPx })));
      console.log("[app] committed", track.path.length, "rolling", rolling.length, "slope", slopeFit);

      if (!slopeFit || slopeFit.slopePxPerSec <= 0 || rolling.length < 4) {
        setPhase("done");
        setStatus("");
        setSummary(
          `Not enough clean rolling track to fit (${rolling.length} points). ` +
            `Ball tracked in ${hits}/${total} frames. Try lowering LOFT_SKIP or re-clicking the far edge at the arrows.`
        );
        return;
      }

      const seconds = lane.laneLen / slopeFit.slopePxPerSec / SPEED_CALIBRATION;
      const speed = releaseSpeedFromSeconds(seconds);

      // clean fitted trajectory clipped to foul + arrows; foul end anchored to real data
      const depths = rolling.map((s) => s.depthPx);
      const laterals = rolling.map((s) => lane.signedLateral({ x: s.x, y: s.y }));
      const latFit = linreg(depths, laterals);
      if (latFit) {
        // arrows end: from the fitted line (well-supported by data up there)
        const O = { x: lane.nearMid.x + latFit.b * lane.normal.x, y: lane.nearMid.y + latFit.b * lane.normal.y };
        const D = { x: lane.downlane.x + latFit.m * lane.normal.x, y: lane.downlane.y + latFit.m * lane.normal.y };
        const arrowPt =
          lineIntersect(O, D, points[2], points[3]) ?? lane.toImage(lane.laneLen, latFit.m * lane.laneLen + latFit.b);

        // foul end: extend from the EARLIEST real points (local direction), not a long extrapolation
        const head = rolling.slice(0, Math.min(8, rolling.length));
        const a = head[0];
        const b = head[head.length - 1];
        const dir = { x: a.x - b.x, y: a.y - b.y }; // pointing back toward the foul line
        const foulPt = lineIntersect({ x: a.x, y: a.y }, dir, points[0], points[1]) ?? { x: a.x, y: a.y };

        dctx.strokeStyle = "rgba(0,225,255,1)";
        dctx.lineWidth = 4;
        dctx.beginPath();
        dctx.moveTo(foulPt.x, foulPt.y);
        dctx.lineTo(arrowPt.x, arrowPt.y);
        dctx.stroke();
        dctx.fillStyle = "red";
        dctx.beginPath();
        dctx.arc(foulPt.x, foulPt.y, 6, 0, 2 * Math.PI);
        dctx.fill();
      }

      dctx.fillStyle = "red";
      dctx.font = "22px monospace";
      dctx.fillText(`${speed.mph.toFixed(1)} mph`, 12, 30);
      setPhase("done");
      setStatus("");
      setSummary(
        `Release speed: ${speed.mph.toFixed(1)} mph (${speed.kph.toFixed(1)} kph). ` +
          `15 ft in ${seconds.toFixed(3)} s, fit over ${slopeFit.n} rolling points. Ball tracked in ${hits}/${total} frames.`
      );
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
      setPhase("ready");
    }
  }

  return (
    <main style={{ fontFamily: "monospace", maxWidth: 640, margin: "3rem auto", padding: "0 1rem" }}>
      <h1>Speed-Rev-Check</h1>
      <p style={{ opacity: 0.7 }}>
        Pick a clip, click the 4 lane corners (near edge = foul line, far edge = arrows, 15 ft), then Measure.
      </p>
      <input type="file" accept="video/*" onChange={onFileChange} disabled={phase === "tracking"} />
      {phase === "ready" && (
        <button onClick={measure} style={{ marginLeft: 8 }}>
          Measure
        </button>
      )}
      <p style={{ minHeight: "1.2em" }}>{status}</p>
      {summary && <p style={{ fontWeight: "bold" }}>{summary}</p>}
      <canvas
        ref={canvasRef}
        onClick={onCanvasClick}
        style={{
          width: "100%",
          maxWidth: 480,
          border: "1px solid #333",
          borderRadius: 6,
          cursor: phase === "calibrating" ? "crosshair" : "default",
        }}
      />
    </main>
  );
}
