/*
 * yoloDetector.ts
 * ==================
 * YOLOv8 object detector via onnxruntime-web, running in-browser (static / Pages).
 *
 * Everything self-hosted so nothing hits a CDN an extension could block:
 *   - ORT wasm files in /public/ort/   (wasmPaths -> "/ort/")
 *   - model in /public/models/best.onnx  (your trained single-class "ball" model)
 * Single-threaded (numThreads=1) because GitHub Pages can't send the COOP/COEP
 * headers wasm threads require.
 *
 * detect() returns boxes in the ORIGINAL canvas coordinate space.
 * COCO class 32 = "sports ball" — the class most likely to catch a bowling ball.
 */

import * as ort from "onnxruntime-web";

export const BALL_CLASS_ID = 0; // single-class trained model: the only class is "ball"
const INPUT = 640;

export interface Detection {
  x: number; // top-left, original-image px
  y: number;
  w: number;
  h: number;
  score: number;
  classId: number;
}

let session: ort.InferenceSession | null = null;

export async function loadYolo(modelUrl = "/models/best.onnx", wasmPath = "/ort/"): Promise<void> {
  if (session) return;
  ort.env.wasm.wasmPaths = wasmPath;
  ort.env.wasm.numThreads = 1; // Pages has no cross-origin isolation for threads
  session = await ort.InferenceSession.create(modelUrl, { executionProviders: ["wasm"] });
  console.log("[yolo] session ready. inputs:", session.inputNames, "outputs:", session.outputNames);
}

/** Resize+pad the canvas to 640x640 (letterbox), returning the CHW float tensor data + inverse transform. */
function letterbox(canvas: HTMLCanvasElement): { data: Float32Array; scale: number; padX: number; padY: number } {
  const w = canvas.width;
  const h = canvas.height;
  const scale = Math.min(INPUT / w, INPUT / h);
  const nw = Math.round(w * scale);
  const nh = Math.round(h * scale);
  const padX = Math.floor((INPUT - nw) / 2);
  const padY = Math.floor((INPUT - nh) / 2);

  const off = document.createElement("canvas");
  off.width = INPUT;
  off.height = INPUT;
  const octx = off.getContext("2d")!;
  octx.fillStyle = "rgb(114,114,114)";
  octx.fillRect(0, 0, INPUT, INPUT);
  octx.drawImage(canvas, 0, 0, w, h, padX, padY, nw, nh);

  const img = octx.getImageData(0, 0, INPUT, INPUT).data;
  const area = INPUT * INPUT;
  const data = new Float32Array(3 * area);
  for (let i = 0; i < area; i++) {
    data[i] = img[i * 4] / 255; // R plane
    data[area + i] = img[i * 4 + 1] / 255; // G plane
    data[2 * area + i] = img[i * 4 + 2] / 255; // B plane
  }
  return { data, scale, padX, padY };
}

function iou(a: Detection, b: Detection): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function nms(dets: Detection[], iouThreshold: number): Detection[] {
  const sorted = [...dets].sort((p, q) => q.score - p.score);
  const keep: Detection[] = [];
  for (const d of sorted) {
    if (keep.every((k) => k.classId !== d.classId || iou(k, d) < iouThreshold)) keep.push(d);
  }
  return keep;
}

/** Run detection on a canvas. Returns boxes in original-canvas coordinates. */
export async function detect(canvas: HTMLCanvasElement, confThreshold = 0.25, iouThreshold = 0.45): Promise<Detection[]> {
  if (!session) throw new Error("YOLO not loaded — call loadYolo() first.");
  const { data, scale, padX, padY } = letterbox(canvas);
  const input = new ort.Tensor("float32", data, [1, 3, INPUT, INPUT]);
  const feeds: Record<string, ort.Tensor> = {};
  feeds[session.inputNames[0]] = input;

  const out = await session.run(feeds);
  const output = out[session.outputNames[0]];
  const dims = output.dims as number[]; // YOLOv8: [1, 84, 8400]
  const num = dims[2];
  const numClasses = dims[1] - 4;
  const d = output.data as Float32Array;

  const dets: Detection[] = [];
  for (let i = 0; i < num; i++) {
    let bestC = 0;
    let bestS = 0;
    for (let c = 0; c < numClasses; c++) {
      const s = d[(4 + c) * num + i]; // row-major flat: value at (channel, anchor)
      if (s > bestS) {
        bestS = s;
        bestC = c;
      }
    }
    if (bestS >= confThreshold) {
      const cx = d[0 * num + i];
      const cy = d[1 * num + i];
      const bw = d[2 * num + i];
      const bh = d[3 * num + i];
      dets.push({
        x: (cx - bw / 2 - padX) / scale,
        y: (cy - bh / 2 - padY) / scale,
        w: bw / scale,
        h: bh / scale,
        score: bestS,
        classId: bestC,
      });
    }
  }
  return nms(dets, iouThreshold);
}
