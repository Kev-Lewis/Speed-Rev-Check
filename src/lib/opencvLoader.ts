/*
 * opencvLoader.ts
 * ==================
 * Loads OpenCV.js via @techstark/opencv-js (docs single-file build, wasm embedded).
 * Dynamically imported so its ~11 MB lands in a lazy chunk fetched on first use.
 *
 *   npm install @techstark/opencv-js
 *
 * CAREFUL: the OpenCV module is "thenable" (Emscripten adds a `.then` that is NOT
 * a real Promise). If you `await` it, `resolve(cv)` with it, or `return cv` from an
 * async fn, JS tries to adopt it as a promise and throws
 * "Promise.prototype.then called on incompatible receiver". So we:
 *   - detect readiness with `instanceof Promise` (real) + `.Mat` + onRuntimeInitialized,
 *   - resolve the wait-promise with nothing (void),
 *   - return the module wrapped as { cv } so it never passes through promise adoption.
 *
 * Call site:  const { cv } = await loadOpenCV();
 */

let cvReady: any = null;
let pending: Promise<void> | null = null;

export function loadOpenCV(timeoutMs = 60000): Promise<{ cv: any }> {
  if (cvReady) return Promise.resolve({ cv: cvReady });

  if (!pending) {
    pending = (async () => {
      const mod: any = await import("@techstark/opencv-js");
      const cvModule: any = mod.default ?? mod;

      if (cvModule instanceof Promise) {
        cvReady = await cvModule; // this branch is a genuine Promise, safe to await
        return;
      }
      if (cvModule.Mat) {
        cvReady = cvModule; // already initialized
        return;
      }

      // Wait for the wasm runtime. Resolve with VOID (never with the thenable module).
      await new Promise<void>((resolve, reject) => {
        let done = false;
        const check = () => {
          if (!done && cvModule.Mat) {
            done = true;
            clearInterval(poll);
            clearTimeout(timer);
            resolve();
          }
        };
        const poll = setInterval(check, 50);
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            clearInterval(poll);
            reject(new Error(`OpenCV did not initialize within ${timeoutMs / 1000}s.`));
          }
        }, timeoutMs);
        cvModule.onRuntimeInitialized = check;
      });
      cvReady = cvModule;
    })().catch((e) => {
      pending = null; // allow retry
      throw e;
    });
  }

  // Wrap in a plain object so the thenable module never triggers promise adoption.
  return pending.then(() => ({ cv: cvReady }));
}
