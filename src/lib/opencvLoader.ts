/*
 * opencvLoader.ts
 * ==================
 * Loads the PLAIN OpenCV.js build (the official docs Emscripten build) via a
 * <script> tag. This deliberately AVOIDS bundling OpenCV through Vite, which is a
 * known dead end (node polyfills, "Module is not defined", thenable-adoption
 * crashes). The plain build sets a global `cv` and fires onRuntimeInitialized —
 * no bundler involved, nothing to adopt as a promise.
 *
 * We poll for `window.cv.Mat` AND hook onRuntimeInitialized (whichever wins),
 * with a hard timeout so it can never hang.
 *
 * NOTE: use a PLAIN build URL. If you self-host later, verify the file does NOT
 * begin with "(function (root, factory)" — that header is the UMD/npm build,
 * which does not work via a script tag.
 *
 * Call site:  const { cv } = await loadOpenCV();
 */

declare global {
  interface Window {
    cv?: any;
  }
}

let readyPromise: Promise<{ cv: any }> | null = null;

export function loadOpenCV(
  src = "https://docs.opencv.org/4.11.0/opencv.js", // if this 404s, try 4.10.0 or 4.8.0
  timeoutMs = 60000
): Promise<{ cv: any }> {
  if (typeof window !== "undefined" && window.cv && window.cv.Mat) {
    return Promise.resolve({ cv: window.cv });
  }
  if (readyPromise) return readyPromise;

  readyPromise = new Promise((resolve, reject) => {
    let settled = false;
    const succeed = () => {
      if (settled) return;
      if (window.cv && window.cv.Mat) {
        settled = true;
        clearInterval(poll);
        clearTimeout(timer);
        resolve({ cv: window.cv }); // wrap so a thenable module can't trigger adoption
      }
    };
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      readyPromise = null; // allow retry
      reject(new Error(msg));
    };

    const poll = setInterval(succeed, 50);
    const timer = setTimeout(() => fail(`OpenCV.js did not initialize within ${timeoutMs / 1000}s (check that ${src} loads).`), timeoutMs);

    const hook = () => {
      if (!window.cv) return;
      if (window.cv.Mat) return succeed();
      window.cv.onRuntimeInitialized = succeed;
    };

    const existing = document.querySelector<HTMLScriptElement>("script[data-opencv]");
    if (existing) {
      hook();
      existing.addEventListener("load", hook);
      existing.addEventListener("error", () => fail("OpenCV.js script failed to load."));
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.setAttribute("data-opencv", "true");
    script.onload = hook;
    script.onerror = () => fail(`Failed to load OpenCV.js from ${src}`);
    document.head.appendChild(script);
  });

  return readyPromise;
}
