export type GestureKind = 'hand' | 'face' | 'custom';
export interface Mapping { id: string; name: string; kind: GestureKind; command: string; enabled: boolean; description: string; samples?: number[][]; }
export const COMMANDS = [
  { id: 'play_pause', label: 'Play / pause', key: 'Media', group: 'Media' },
  { id: 'next_track', label: 'Next track', key: 'Media →', group: 'Media' },
  { id: 'previous_track', label: 'Previous track', key: '← Media', group: 'Media' },
  { id: 'volume_up', label: 'Volume up', key: 'Vol +', group: 'Media' },
  { id: 'volume_down', label: 'Volume down', key: 'Vol −', group: 'Media' },
  { id: 'mute', label: 'Mute audio', key: 'Mute', group: 'Media' },
  { id: 'scroll_up', label: 'Scroll up', key: 'Scroll ↑', group: 'Navigation' },
  { id: 'scroll_down', label: 'Scroll down', key: 'Scroll ↓', group: 'Navigation' },
  { id: 'tab_next', label: 'Next tab', key: 'Ctrl Tab', group: 'Navigation' },
  { id: 'tab_previous', label: 'Previous tab', key: 'Ctrl ⇧ Tab', group: 'Navigation' },
  { id: 'copy', label: 'Copy', key: '⌘ / Ctrl C', group: 'Editing' },
  { id: 'paste', label: 'Paste', key: '⌘ / Ctrl V', group: 'Editing' },
  { id: 'undo', label: 'Undo', key: '⌘ / Ctrl Z', group: 'Editing' },
  { id: 'redo', label: 'Redo', key: 'Redo', group: 'Editing' },
  { id: 'enter', label: 'Enter', key: '↵', group: 'Keyboard' },
  { id: 'escape', label: 'Escape', key: 'Esc', group: 'Keyboard' },
  { id: 'screenshot', label: 'Take screenshot', key: 'Screenshot', group: 'Keyboard' },
] as const;
export const commandLabel = (id: string) => COMMANDS.find(c => c.id === id)?.label ?? id;
export const DEFAULT_MAPPINGS: Mapping[] = [
  { id: 'open_palm', name: 'Open palm', kind: 'hand', command: 'play_pause', enabled: true, description: 'Hold your palm open, fingers apart.' },
  { id: 'victory', name: 'Peace sign', kind: 'hand', command: 'next_track', enabled: true, description: 'Raise your index and middle fingers.' },
  { id: 'thumbs_up', name: 'Thumbs up', kind: 'hand', command: 'volume_up', enabled: true, description: 'Make a fist with your thumb pointing up.' },
  { id: 'closed_fist', name: 'Closed fist', kind: 'hand', command: 'mute', enabled: false, description: 'Curl all your fingers into your palm.' },
  { id: 'pinch', name: 'Pinch', kind: 'hand', command: 'copy', enabled: false, description: 'Touch your thumb and index fingertips.' },
  { id: 'swipe_right', name: 'Swipe right', kind: 'hand', command: 'tab_next', enabled: false, description: 'Move your hand to the right of the preview.' },
  { id: 'swipe_left', name: 'Swipe left', kind: 'hand', command: 'tab_previous', enabled: false, description: 'Move your hand to the left of the preview.' },
  { id: 'pointing_up', name: 'Point up', kind: 'hand', command: 'scroll_up', enabled: false, description: 'Extend just your index finger.' },
  { id: 'smile', name: 'Smile', kind: 'face', command: 'play_pause', enabled: false, description: 'Give the camera a smile and hold it.' },
  { id: 'head_left', name: 'Look left', kind: 'face', command: 'previous_track', enabled: false, description: 'Slowly turn your face to your left.' },
  { id: 'head_right', name: 'Look right', kind: 'face', command: 'next_track', enabled: false, description: 'Slowly turn your face to your right.' },
  { id: 'blink', name: 'Close eyes', kind: 'face', command: 'mute', enabled: false, description: 'Close both eyes. Enable deliberately: natural blinks can trigger this.' },
];
export interface Settings { dwell: number; cooldown: number; showLandmarks: boolean; faceEnabled: boolean; }
export const DEFAULT_SETTINGS: Settings = { dwell: 600, cooldown: 1500, showLandmarks: true, faceEnabled: true };
export function readMappings(): Mapping[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem('motionkey.mappings.v1') ?? 'null');
    if (!Array.isArray(raw)) return DEFAULT_MAPPINGS.map(m => ({ ...m }));
    const valid = (value: unknown): value is Mapping => {
      if (!value || typeof value !== 'object') return false;
      const m = value as Mapping;
      return typeof m.id === 'string' && typeof m.name === 'string' && m.name.length > 0 && typeof m.enabled === 'boolean' && typeof m.description === 'string' && COMMANDS.some(c => c.id === m.command) &&
        (m.kind === 'hand' || m.kind === 'face' || (m.kind === 'custom' && m.id.startsWith('custom_') && Array.isArray(m.samples) && m.samples.length >= 3 && m.samples.every(s => Array.isArray(s) && s.length === 63 && s.every(Number.isFinite))));
    };
    const saved = raw.filter(valid);
    return [...DEFAULT_MAPPINGS.map(base => saved.find(m => m.id === base.id && m.kind === base.kind) ?? { ...base }), ...saved.filter(m => m.kind === 'custom')];
  } catch { return DEFAULT_MAPPINGS.map(m => ({ ...m })); }
}
export function readSettings(): Settings {
  try {
    const s = JSON.parse(localStorage.getItem('motionkey.settings.v1') ?? '{}');
    return { dwell: typeof s.dwell === 'number' ? Math.min(1500, Math.max(300, s.dwell)) : 600, cooldown: typeof s.cooldown === 'number' ? Math.min(5000, Math.max(750, s.cooldown)) : 1500, showLandmarks: typeof s.showLandmarks === 'boolean' ? s.showLandmarks : true, faceEnabled: typeof s.faceEnabled === 'boolean' ? s.faceEnabled : true };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

/** One trigger per held gesture. Release for 250ms before repeating. */
export class GestureGate {
  private states = new Map<string, { since: number; lastSeen: number; fired: boolean }>();
  private lastFired = -Infinity;
  reset() { this.states.clear(); this.lastFired = -Infinity; }
  update(candidates: { id: string; confidence: number; transient?: boolean }[], mappings: Mapping[], now: number, settings: Settings): Mapping | null {
    for (const [id, state] of this.states) if (now - state.lastSeen > 250) this.states.delete(id);
    let trigger: Mapping | null = null;
    // A held pose may match a custom and built-in gesture simultaneously.
    // Keep one priority winner, so lower-priority matches cannot fire later.
    const primary = candidates.find(candidate => candidate.confidence >= 0.75 && mappings.some(m => m.id === candidate.id && m.enabled && (m.kind !== 'face' || settings.faceEnabled)));
    for (const candidate of candidates) {
      const mapping = mappings.find(m => m.id === candidate.id && m.enabled);
      if (!mapping || (mapping.kind === 'face' && !settings.faceEnabled)) continue;
      const state = this.states.get(mapping.id) ?? { since: now, lastSeen: now, fired: false };
      state.lastSeen = now;
      if (candidate.confidence < 0.75) {
        state.since = now;
        this.states.set(mapping.id, state);
        continue;
      }
      this.states.set(mapping.id, state);
      if (candidate === primary && !trigger && !state.fired && now - this.lastFired >= settings.cooldown && (candidate.transient || now - state.since >= settings.dwell)) {
        state.fired = true;
        this.lastFired = now;
        trigger = mapping;
      }
    }
    return trigger;
  }
}
