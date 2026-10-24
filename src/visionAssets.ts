/** Detect missing binary assets before the vision runtime emits opaque WASM errors. */
export async function ensureVisionAssets(faceEnabled: boolean): Promise<void> {
  const paths = ['/models/hand_landmarker.task', ...(faceEnabled ? ['/models/face_landmarker.task'] : [])];
  await Promise.all(paths.map(async path => {
    let response: Response;
    try { response = await fetch(path, { method: 'HEAD', signal: AbortSignal.timeout(8000) }); }
    catch { throw new Error('Could not load tracking models. Check that the local app server is still running, then try again.'); }
    if (!response.ok || response.headers.get('Content-Type')?.includes('text/html') || Number(response.headers.get('Content-Length') ?? 0) < 100000) {
      throw new Error('Tracking models are not installed. In the MotionKey project folder, run npm run assets, then rebuild with npm run build (or restart the development server).');
    }
  }));
}
