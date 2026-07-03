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
    const input = e.target;
    const file = input.files?.[0];
    console.log("[app] handleFile fired", file ? { name: file.name, type: file.type, size: file.size } : "no file");
    if (!file) return;
    setBusy(true);
    setSummary("");

    setStatus("Loading OpenCV.js (~9 MB, first time only)…");
    console.log("[app] loading OpenCV…");
    let cv: any;
    try {
      cv = await loadOpenCV();
      console.log("[app] OpenCV ready:", typeof cv, "Mat?", !!cv?.Mat);
    } catch (err) {
      console.error("[app] OpenCV load failed:", err);
      setStatus(`OpenCV load failed: ${(err as Error).message}`);
      setBusy(false);
      input.value = "";
      return;
    }

    const display = canvasRef.current!;
    const dctx = display.getContext("2d")!;
    const tracker = new BallTracker(cv);
    const wc = isWebCodecsSupported();
    const reader = wc ? extractFramesWebCodecs : extractFrames;
    console.log("[app] starting tracker, reader =", wc ? "WebCodecs" : "rVFC");

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

        if (tracker.path.length > 1) {
          dctx.strokeStyle = "rgba(0,200,255,0.9)";
          dctx.lineWidth = 2;
          dctx.beginPath();
          tracker.path.forEach((p, i) => (i ? dctx.lineTo(p.x, p.y) : dctx.moveTo(p.x, p.y)));
          dctx.stroke();
        }
        if (det) {
          dctx.strokeStyle = "red";
          dctx.lineWidth = 3;
          dctx.beginPath();
          dctx.arc(det.x, det.y, det.r + 3, 0, 2 * Math.PI);
          dctx.stroke();
        }

        if (total % 30 === 0) {
          console.log(`[app] frame ${total}, ball found in ${found}`);
          setStatus(`Tracking… ${total} frames, ball found in ${found}`);
        }
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      });

      tracker.dispose();
      const pct = total ? Math.round((100 * found) / total) : 0;
      console.log(`[app] done. found ${found}/${total} (${pct}%)`, report);
      setStatus("");
      setSummary(
        `Done. Ball detected in ${found}/${total} frames (${pct}%). ` +
          `True ${report.estimatedFps.toFixed(0)} fps, ${report.frameCount} frames.`
      );
    } catch (err) {
      console.error("[app] tracking error:", err);
      tracker.dispose();
      setStatus(`Error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
      input.value = ""; // allow re-selecting the same file
    }
  }

  return (
    <main style={{ fontFamily: "monospace", maxWidth: 640, margin: "3rem auto", padding: "0 1rem" }}>
      <h1>Speed-Rev-Check</h1>
      <p style={{ opacity: 0.7 }}>
        Ball tracker — watch it follow the ball. If it locks onto the bowler or pins, tune the options in{" "}
        <code>ballTracker.ts</code>. Progress shows below and in the console.
      </p>
      <input type="file" accept="video/*" onChange={handleFile} disabled={busy} />
      <p style={{ minHeight: "1.2em" }}>{status || (busy ? "Working…" : "")}</p>
      {summary && <p>{summary}</p>}
      <canvas ref={canvasRef} style={{ width: "100%", maxWidth: 480, border: "1px solid #333", borderRadius: 6 }} />
    </main>
  );
}
