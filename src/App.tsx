import { useState } from "react";
import { extractFrames, type FrameTimingReport } from "./lib/videoFrames";
import { extractFramesWebCodecs, isWebCodecsSupported } from "./lib/videoFramesWebCodecs";

export default function App() {
  const [report, setReport] = useState<FrameTimingReport | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setReport(null);

    const useWC = isWebCodecsSupported();
    setStatus(`Decoding with ${useWC ? "WebCodecs (full-rate)" : "rVFC fallback"}…`);
    let count = 0;
    const onFrame = () => {
      count++;
      if (count % 30 === 0) setStatus(`Decoded ${count} frames…`);
    };

    try {
      const r = useWC
        ? await extractFramesWebCodecs(file, onFrame)
        : await extractFrames(file, onFrame);
      setReport(r);
      setStatus(`Done — ${r.frameCount} frames at ~${r.estimatedFps.toFixed(0)} fps via ${useWC ? "WebCodecs" : "rVFC"}.`);
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ fontFamily: "monospace", maxWidth: 640, margin: "3rem auto", padding: "0 1rem" }}>
      <h1>Speed-Rev-Check</h1>
      <p style={{ opacity: 0.7 }}>
        Foundation build: full-rate decode + frame-timing. Ball tracking, validity gate, and revs come next.
      </p>
      <input type="file" accept="video/*" onChange={handleFile} disabled={busy} />
      {status && <p>{status}</p>}
      {report && (
        <pre style={{ background: "#111", color: "#0f0", padding: "1rem", overflowX: "auto", borderRadius: 6 }}>
{JSON.stringify(report, null, 2)}
        </pre>
      )}
    </main>
  );
}
