/*
 * opencvLoader.ts
 * ==================
 * Loads OpenCV.js once and resolves when the wasm runtime is ready.
 *
 * Uses the single-threaded docs.opencv.org build by default, which needs NO
 * COOP/COEP headers — important because GitHub Pages can't set them. For
 * production, download opencv.js into /public and pass "/opencv.js" so you're
 * not depending on a third-party CDN at runtime.
 */

declare global {
  interface Window {
    cv?: any;
  }
}

let loadingPromise: Promise<any> | null = null;

export function loadOpenCV(src = "https://docs.opencv.org/4.x/opencv.js"): Promise<any> {
  if (typeof window !== "undefined" && window.cv && window.cv.Mat) return Promise.resolve(window.cv);
  if (loadingPromise) return loadingPromise;

  loadingPromise = new Promise((resolve, reject) => {
    const finish = () => {
      const cv = window.cv;
      if (!cv) return reject(new Error("OpenCV.js loaded but global `cv` is missing."));
      if (cv.Mat) resolve(cv); // already initialized
      else cv.onRuntimeInitialized = () => resolve(cv); // wait for wasm
    };

    const existing = document.querySelector<HTMLScriptElement>("script[data-opencv]");
    if (existing) {
      existing.addEventListener("load", finish);
      existing.addEventListener("error", () => reject(new Error("OpenCV.js script failed to load.")));
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.setAttribute("data-opencv", "true");
    script.onload = finish;
    script.onerror = () => reject(new Error(`Failed to load OpenCV.js from ${src}`));
    document.head.appendChild(script);
  });

  return loadingPromise;
}
