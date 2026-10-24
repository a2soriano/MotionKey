import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureVisionAssets } from './visionAssets';
afterEach(() => vi.unstubAllGlobals());
describe('vision asset readiness', () => {
  it('accepts real model headers and checks both models when face tracking is enabled', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '4000000' } }));
    vi.stubGlobal('fetch', fetch);
    await ensureVisionAssets(true);
    expect(fetch.mock.calls.map(c=>c[0])).toEqual(['/models/hand_landmarker.task','/models/face_landmarker.task']);
    expect(fetch.mock.calls[0][1].method).toBe('HEAD');
  });
  it('does not require the face model when face tracking is disabled', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { headers: { 'Content-Length': '4000000' } }));
    vi.stubGlobal('fetch', fetch);
    await ensureVisionAssets(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    new Response(null, { status: 404 }),
    new Response(null, { headers: { 'Content-Type': 'text/html', 'Content-Length': '4000000' } }),
    new Response(null, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '10' } }),
  ])('rejects missing or HTML-fallback model responses', async response => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(ensureVisionAssets(false)).rejects.toThrow('npm run assets');
  });
  it('explains a disconnected server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(ensureVisionAssets(false)).rejects.toThrow('local app server');
  });
});
