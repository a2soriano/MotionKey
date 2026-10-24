const localHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
export const BRIDGE_URL = localHost && !['5173', '4173'].includes(window.location.port) ? window.location.origin : 'http://127.0.0.1:8765';
export interface BridgeHealth { ok: boolean; authenticated: boolean; mode: 'desktop' | 'dry-run'; }
export async function bridgeRequest<T>(path: string, token: string, body?: object): Promise<T> {
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3500),
    credentials: 'omit',
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('Pairing token is incorrect or expired. Copy the current token from your companion terminal.');
    if (response.status === 429) throw new Error('Commands are arriving too quickly. Wait a moment and try again.');
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error ?? `Companion returned ${response.status}.`);
  }
  return response.json() as Promise<T>;
}
