import { useRef, useState } from "react";
import { extractFramesWebCodecs, isWebCodecsSupported } from "./lib/videoFramesWebCodecs";
import { extractFrames } from "./lib/videoFrames";
import { loadYolo, detect, BALL_CLASS_ID } from "./lib/yoloDetector";

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setSummary("");

    setStatus("Loading YOLO model (first time downloads the model + wasm)…");
    console.log("[app] loading YOLO…");
    try {
      await loadYolo();
      console.log("[app] YOLO ready");
    } catch (err) {
      console.error("[app] YOLO load failed:", err);
      setStatus(`YOLO load failed: ${(err as Error).message}`);
      setBusy(false);
      return;
    }

    const display = canvasRef.current!;
    const dctx = display.getContext("2d")!;
    const reader = isWebCodecsSupported() ? extractFramesWebCodecs : extractFrames;

    let total = 0;
    let ballFrames = 0;
    let bestBall = 0; // best sports-ball score seen
    const otherClasses = new Set<number>();
    setStatus("Detecting… (wasm inference is slow, ~minute for the clip)");

    try {
      await reader(file, async (frame) => {
        total++;
        const dets = await detect(frame.canvas, 0.25);

        if (display.width !== frame.width) {
          display.width = frame.width;
          display.height = frame.height;
        }
        dctx.drawImage(frame.canvas, 0, 0);

        let ballHere = false;
        for (const d of dets) {
          const isBall = d.classId === BALL_CLASS_ID;
          if (isBall) {
            ballHere = true;
            bestBall = Math.max(bestBall, d.score);
          } else {
            otherClasses.add(d.classId);
          }
          dctx.strokeStyle = isBall ? "lime" : "rgba(180,180,180,0.8)";
          dctx.lineWidth = isBall ? 3 : 1;
          dctx.strokeRect(d.x, d.y, d.w, d.h);
          dctx.fillStyle = dctx.strokeStyle;
          dctx.font = "14px monospace";
          dctx.fillText(`${isBall ? "ball" : "c" + d.classId} ${d.score.toFixed(2)}`, d.x, d.y - 4);
        }
        if (ballHere) ballFrames++;

        if (total % 10 === 0) {
          console.log(`[app] frame ${total}, ball frames ${ballFrames}, bestBall ${bestBall.toFixed(2)}`);
          setStatus(`Detecting… ${total} frames, ball in ${ballFrames}`);
        }
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      });

      const pct = total ? Math.round((100 * ballFrames) / total) : 0;
      setStatus("");
      setSummary(
        `Done. Sports-ball detected in ${ballFrames}/${total} frames (${pct}%), best score ${bestBall.toFixed(2)}. ` +
          `Other classes seen: ${[...otherClasses].join(", ") || "none"}.`
      );
      console.log("[app] done", { total, ballFrames, bestBall, otherClasses: [...otherClasses] });
    } catch (err) {
      console.error("[app] detection error:", err);
      setStatus(`Error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ fontFamily: "monospace", maxWidth: 640, margin: "3rem auto", padding: "0 1rem" }}>
      <h1>Speed-Rev-Check</h1>
      <p style={{ opacity: 0.7 }}>
        YOLO smoke test: green boxes are "sports ball" detections, gray are other classes. We're checking whether the
        pretrained model sees your bowling ball before wiring it into tracking.
      </p>
      <input type="file" accept="video/*" onChange={onFileChange} disabled={busy} />
      <p style={{ minHeight: "1.2em" }}>{status}</p>
      {summary && <p>{summary}</p>}
      <canvas ref={canvasRef} style={{ width: "100%", maxWidth: 480, border: "1px solid #333", borderRadius: 6 }} />
    </main>
  );
}
