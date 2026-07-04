import { useRef, useState } from "react";
import { extractFramesWebCodecs, isWebCodecsSupported } from "./lib/videoFramesWebCodecs";
import { extractFrames } from "./lib/videoFrames";
import { loadYolo, detect } from "./lib/yoloDetector";
import { LaneModel, crossingTime, type Point } from "./lib/laneModel";
import { BallTrack, type Candidate } from "./lib/ballTrack";
import { releaseSpeedFromSeconds } from "./lib/speedRevs";

type Phase = "idle" | "calibrating" | "ready" | "tracking" | "done";
const FOUL_TO_ARROWS_FT = 15;
const CORNER_LABELS = ["foul line — LEFT", "foul line — RIGHT", "arrows — RIGHT", "arrows — LEFT"];

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

    try {
      await reader(file, async (frame) => {
        total++;
        const dets = await detect(frame.canvas, 0.3);
        const candidates: Candidate[] = dets.map((d) => ({
          x: d.x + d.w / 2,
          y: d.y + d.h / 2,
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
        // lane
        dctx.strokeStyle = "rgba(255,255,0,0.7)";
        dctx.lineWidth = 2;
        dctx.beginPath();
        points.forEach((p, i) => (i ? dctx.lineTo(p.x, p.y) : dctx.moveTo(p.x, p.y)));
        dctx.closePath();
        dctx.stroke();
        // trajectory
        if (track.path.length > 1) {
          dctx.strokeStyle = "rgba(0,200,255,0.9)";
          dctx.lineWidth = 2;
          dctx.beginPath();
          track.path.forEach((s, i) => (i ? dctx.lineTo(s.x, s.y) : dctx.moveTo(s.x, s.y)));
          dctx.stroke();
        }
        // current ball
        if (chosen) {
          dctx.strokeStyle = "lime";
          dctx.lineWidth = 3;
          dctx.beginPath();
          dctx.arc(chosen.x, chosen.y, chosen.r, 0, 2 * Math.PI);
          dctx.stroke();
        }
        if (total % 20 === 0) setStatus(`Tracking… ${total} frames, ball in ${hits}`);
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      });

      // --- crossings + speed ---
      const t0 = crossingTime(track.path, 0); // foul line
      const t1 = crossingTime(track.path, lane.laneLen); // arrows
      console.log("[app] path", track.path.length, "t0", t0, "t1", t1);

      if (t0 == null || t1 == null) {
        setPhase("done");
        setStatus("");
        setSummary(
          `Couldn't get a clean crossing (${t0 == null ? "foul line" : "arrows"} not crossed by the track). ` +
            `Ball tracked in ${hits}/${total} frames. Try re-clicking the corners so the near edge is right at the foul line and the far edge at the arrows.`
        );
        return;
      }

      const seconds = t1 - t0;
      const speed = releaseSpeedFromSeconds(seconds);
      // mark crossings
      dctx.fillStyle = "red";
      dctx.font = "20px monospace";
      dctx.fillText(`${speed.mph.toFixed(1)} mph`, 12, 28);
      setPhase("done");
      setStatus("");
      setSummary(
        `Release speed: ${speed.mph.toFixed(1)} mph (${speed.kph.toFixed(1)} kph). ` +
          `15 ft in ${seconds.toFixed(3)} s. Ball tracked in ${hits}/${total} frames.` +
          (speed.warnings.length ? ` ⚠ ${speed.warnings.join(" ")}` : "")
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
