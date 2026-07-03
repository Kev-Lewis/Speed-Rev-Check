/*
 * opencvLoader.ts
 * ==================
 * Loads OpenCV.js once and resolves when the wasm runtime is truly ready.
 *
 * Why polling: depending on build/timing, `script.onload` can fire either
 * before OR after the wasm runtime finishes initializing, and the
 * `onRuntimeInitialized` callback may have already fired by the time we attach
 * it — which hangs the promise forever. So we set the callback AND poll for
 * `cv.Mat`, whichever wins first, with a hard timeout so it can never hang.
 *
 * Single-threaded docs.opencv.org build => no COOP/COEP headers needed (works
 * on GitHub Pages). For production, self-host opencv.js in /public and pass
 * "/opencv.js".
 */

declare global {
  interface Window {
    cv?: any;
  }
}

let loadingPromise: Promise<any> | null = null;

export function loadOpenCV(
  src = "https://docs.opencv.org/4.x/opencv.js",
  timeoutMs = 60000
): Promise<any> {
  if (typeof window !== "undefined" && window.cv && window.cv.Mat) return Promise.resolve(window.cv);
  if (loadingPromise) return loadingPromise;

  loadingPromise = new Promise((resolve, reject) => {
    let settled = false;
    const done = (cv: any) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolve(cv);
    };
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      loadingPromise = null; // let a later call retry
      reject(new Error(msg));
    };

    // 1) Poll for readiness — wins whenever the runtime becomes usable.
    const poll = setInterval(() => {
      if (window.cv && window.cv.Mat) done(window.cv);
    }, 50);

    // 2) Hard timeout so the tab can never sit hung.
    const timer = setTimeout(() => fail(`OpenCV.js did not initialize within ${timeoutMs / 1000}s.`), timeoutMs);

    // 3) Also hook the callback in case it fires (belt and suspenders).
    const attachCallback = () => {
      const cv = window.cv;
      if (!cv) return;
      if (cv.Mat) return done(cv);
      cv.onRuntimeInitialized = () => done(window.cv);
    };

    const existing = document.querySelector<HTMLScriptElement>("script[data-opencv]");
    if (existing) {
      attachCallback();
      existing.addEventListener("load", attachCallback);
      existing.addEventListener("error", () => fail("OpenCV.js script failed to load."));
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.setAttribute("data-opencv", "true");
    script.onload = attachCallback;
    script.onerror = () => fail(`Failed to load OpenCV.js from ${src}`);
    document.head.appendChild(script);
  });

  return loadingPromise;
}
