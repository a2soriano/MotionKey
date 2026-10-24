import { mkdir, cp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { fetch, EnvHttpProxyAgent } from 'undici';
const root = fileURLToPath(new URL('../', import.meta.url));
const dispatcher = new EnvHttpProxyAgent();
await mkdir(`${root}public/mediapipe`, { recursive: true });
await cp(`${root}node_modules/@mediapipe/tasks-vision/wasm`, `${root}public/mediapipe/wasm`, { recursive: true });
await mkdir(`${root}public/models`, { recursive: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  for (const name of ['hand_landmarker', 'face_landmarker']) {
    const dest = `${root}public/models/${name}.task`;
    const integrity = await readFile(`${dest}.sha256`, 'utf8').catch(() => '');
    const existing = await readFile(dest).catch(() => null);
    if (existing && integrity.trim() && digest(existing) === integrity.trim()) { console.log(`Verified cached ${name}`); continue; }
    const url = `https://storage.googleapis.com/mediapipe-models/${name}/${name}/float16/1/${name}.task`;
    console.log(`Downloading official ${name} model…`);
    const response = await fetch(url, { dispatcher, signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Model download failed: HTTP ${response.status}. Allow storage.googleapis.com in your environment network settings, then run npm run assets again.`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(`${dest}.download`));
    const bytes = await readFile(`${dest}.download`);
    if (bytes.length < 100000 || !bytes.subarray(0, 16).includes(Buffer.from('PK\x03\x04', 'binary'))) throw new Error(`Invalid model archive for ${name}. The downloaded file was not used.`);
    await rename(`${dest}.download`, dest);
    await writeFile(`${dest}.sha256`, `${digest(bytes)}\n`);
    console.log(`Prepared ${name} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
  }
} catch (error) {
  console.error(`\nVision assets are not ready: ${error.message}`);
  process.exitCode = 1;
} finally {
  await Promise.all(['hand_landmarker', 'face_landmarker'].map(name => rm(`${root}public/models/${name}.task.download`, { force: true })));
  await dispatcher.close();
}
