import { useRef, useState } from "react";
import { extractFramesWebCodecs, isWebCodecsSupported } from "./lib/videoFramesWebCodecs";
import { extractFrames } from "./lib/videoFrames";
import { loadOpenCV } from "./lib/opencvLoader";
import { BallTracker, type Point } from "./lib/ballTracker";

type Phase = "idle" | "calibrating" | "ready" | "tracking" | "done";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null); // offscreen copy of the preview frame
  const [phase, setPhase] = useState<Phase>("idle");
  const [points, setPoints] = useState<Point[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState("");
  const [summary, setSummary] = useState("");

  const CORNER_LABELS = ["foul line — left", "foul line — right", "pins — right", "pins — left"];

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
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
      video.currentTime = Math.min(1.2, (video.duration || 3) / 2); // a frame where the lane is visible
      await new Promise<void>((res) => {
        video.onseeked = () => res();
      });

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
      setStatus(`Click the 4 lane corners in order: ${CORNER_LABELS.join(" → ")}.`);
    } catch (err) {
      setStatus(`Preview failed: ${(err as Error).message}`);
      setPhase("idle");
    }
  }

  function redrawCalibration(pts: Point[]) {
    const display = canvasRef.current;
    const pv = previewRef.current;
    if (!display || !pv) return;
    const ctx = display.getContext("2d")!;
    ctx.drawImage(pv, 0, 0);
    ctx.fillStyle = "yellow";
    ctx.strokeStyle = "yellow";
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
    redrawCalibration(next);
    if (next.length === 4) {
      setPhase("ready");
      setStatus("Lane set. Click Start Tracking.");
    } else {
      setStatus(`Corner ${next.length + 1}: click ${CORNER_LABELS[next.length]}.`);
    }
  }

  async function startTracking() {
    if (!file || points.length !== 4) return;
    setPhase("tracking");
    setSummary("");
    setStatus("Loading OpenCV…");

    let cv: any;
    try {
      const r = await loadOpenCV();
      cv = r.cv;
    } catch (err) {
      setStatus(`OpenCV load failed: ${(err as Error).message}`);
      setPhase("ready");
      return;
    }

    const display = canvasRef.current!;
    const dctx = display.getContext("2d")!;
    const tracker = new BallTracker(cv, { roi: points });
    const reader = isWebCodecsSupported() ? extractFramesWebCodecs : extractFrames;
    let found = 0;
    let total = 0;
    setStatus("Tracking…");

    try {
      const report = await reader(file, async (frame) => {
        total++;
        const det = tracker.processFrame(frame.canvas, frame.mediaTime, frame.index);
        if (det) found++;

        if (display.width !== frame.width) {
          display.width = frame.width;
          display.height = frame.height;
        }
        dctx.drawImage(frame.canvas, 0, 0);

        // lane outline
        dctx.strokeStyle = "rgba(255,255,0,0.7)";
        dctx.lineWidth = 2;
        dctx.beginPath();
        points.forEach((p, i) => (i ? dctx.lineTo(p.x, p.y) : dctx.moveTo(p.x, p.y)));
        dctx.closePath();
        dctx.stroke();

        // trajectory
        if (tracker.path.length > 1) {
          dctx.strokeStyle = "rgba(0,200,255,0.9)";
          dctx.lineWidth = 2;
          dctx.beginPath();
          tracker.path.forEach((p, i) => (i ? dctx.lineTo(p.x, p.y) : dctx.moveTo(p.x, p.y)));
          dctx.stroke();
        }
        // current detection
        if (det) {
          dctx.strokeStyle = "red";
          dctx.lineWidth = 3;
          dctx.beginPath();
          dctx.arc(det.x, det.y, det.r + 3, 0, 2 * Math.PI);
          dctx.stroke();
        }

        if (total % 30 === 0) setStatus(`Tracking… ${total} frames, ball found in ${found}`);
        await new Promise((res) => requestAnimationFrame(() => res(null)));
      });

      tracker.dispose();
      const pct = total ? Math.round((100 * found) / total) : 0;
      setStatus("");
      setPhase("done");
      setSummary(
        `Done. Ball detected in ${found}/${total} frames (${pct}%). ${report.frameCount} frames @ ~${report.estimatedFps.toFixed(0)} fps.`
      );
    } catch (err) {
      tracker.dispose();
      setStatus(`Error: ${(err as Error).message}`);
      setPhase("ready");
    }
  }

  return (
    <main style={{ fontFamily: "monospace", maxWidth: 640, margin: "3rem auto", padding: "0 1rem" }}>
      <h1>Speed-Rev-Check</h1>
      <p style={{ opacity: 0.7 }}>
        Pick a clip, click the 4 lane corners (this sets the foul line and excludes the bowler), then track. Tune
        detection in <code>ballTracker.ts</code>.
      </p>
      <input type="file" accept="video/*" onChange={onFileChange} disabled={phase === "tracking"} />
      {phase === "ready" && (
        <button onClick={startTracking} style={{ marginLeft: 8 }}>
          Start Tracking
        </button>
      )}
      <p style={{ minHeight: "1.2em" }}>{status}</p>
      {summary && <p>{summary}</p>}
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
