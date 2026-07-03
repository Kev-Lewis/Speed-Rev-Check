import { useRef, useState } from "react";
import { extractFramesWebCodecs, isWebCodecsSupported } from "./lib/videoFramesWebCodecs";
import { extractFrames } from "./lib/videoFrames";
import { loadOpenCV } from "./lib/opencvLoader";
import { BallTracker } from "./lib/ballTracker";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setSummary("");

    setStatus("Loading OpenCV.js (~8 MB, first time only)…");
    let cv: any;
    try {
      cv = await loadOpenCV();
    } catch (err) {
      setStatus(`OpenCV load failed: ${(err as Error).message}`);
      setBusy(false);
      return;
    }

    const display = canvasRef.current!;
    const dctx = display.getContext("2d")!;
    const tracker = new BallTracker(cv);
    const reader = isWebCodecsSupported() ? extractFramesWebCodecs : extractFrames;

    let found = 0;
    let total = 0;
    setStatus("Tracking ball…");

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

        // trajectory trail
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

        if (total % 15 === 0) setStatus(`Tracking… ${total} frames, ball found in ${found}`);
        // yield so the canvas paints and the overlay animates
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      });

      tracker.dispose();
      const pct = total ? Math.round((100 * found) / total) : 0;
      setStatus("");
      setSummary(
        `Done. Ball detected in ${found}/${total} frames (${pct}%). ` +
          `True ${report.estimatedFps.toFixed(0)} fps, ${report.frameCount} frames.`
      );
    } catch (err) {
      tracker.dispose();
      setStatus(`Error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ fontFamily: "monospace", maxWidth: 640, margin: "3rem auto", padding: "0 1rem" }}>
      <h1>Speed-Rev-Check</h1>
      <p style={{ opacity: 0.7 }}>
        Ball tracker — watch it follow the ball. If it locks onto the bowler or pins, tune the options in{" "}
        <code>ballTracker.ts</code> (minArea / maxArea / minCircularity).
      </p>
      <input type="file" accept="video/*" onChange={handleFile} disabled={busy} />
      {status && <p>{status}</p>}
      {summary && <p>{summary}</p>}
      <canvas ref={canvasRef} style={{ width: "100%", maxWidth: 480, border: "1px solid #333", borderRadius: 6 }} />
    </main>
  );
}
