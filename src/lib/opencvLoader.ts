/*
 * opencvLoader.ts
 * ==================
 * Loads OpenCV.js via the @techstark/opencv-js npm package (the docs single-file
 * build with the wasm EMBEDDED). No <script> tag, no self-hosted /opencv.js, no
 * CDN — so nothing for a browser extension to block and no wasm path issues.
 *
 *   npm install @techstark/opencv-js
 *
 * The package is dynamically imported so its ~11 MB lands in its own lazy chunk,
 * fetched only when tracking starts, keeping the initial page load fast.
 *
 * Resolution handles all three shapes the package can present: a Promise, an
 * already-initialized module, or one that fires onRuntimeInitialized later.
 * A poll + hard timeout guarantee it can never hang silently.
 */

let readyPromise: Promise<any> | null = null;

export function loadOpenCV(timeoutMs = 60000): Promise<any> {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    const mod: any = await import("@techstark/opencv-js");
    const cv: any = mod.default ?? mod;

    // Case 1: package exports a Promise for the ready module
    if (cv && typeof cv.then === "function") return await cv;
    // Case 2: already initialized
    if (cv && cv.Mat) return cv;

    // Case 3: wait for the wasm runtime — poll + callback + timeout
    return await new Promise<any>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (!settled && cv && cv.Mat) {
          settled = true;
          clearInterval(poll);
          clearTimeout(timer);
          resolve(cv);
        }
      };
      const poll = setInterval(finish, 50);
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          clearInterval(poll);
          reject(new Error(`OpenCV did not initialize within ${timeoutMs / 1000}s.`));
        }
      }, timeoutMs);
      cv.onRuntimeInitialized = finish;
    });
  })().catch((e) => {
    readyPromise = null; // allow a later retry
    throw e;
  });

  return readyPromise;
}
