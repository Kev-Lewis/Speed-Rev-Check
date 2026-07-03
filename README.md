# Speed-Rev-Check

Client-side bowling ball speed & rev-rate analyzer. Upload a clip; it measures
release speed and rev rate from the lane's fixed distances (15 ft to the arrows,
60 ft to the head pin) and rejects clips where the required landmarks are blocked
or the rotation isn't measurable. Runs entirely in the browser — clips never leave
the device — and deploys to GitHub Pages.

Live: https://speed-rev-check.kevinlewis.net

## Stack
- Vite + React + TypeScript
- `src/lib/videoFrames.ts` — timestamp-based frame reader (dropped-frame aware)
- `src/lib/speedRevs.ts` — pure speed/rev calculation engine

## Develop
```bash
npm install
npm run dev
```

## Deploy
Push to `main`; GitHub Actions builds and publishes to Pages automatically.
