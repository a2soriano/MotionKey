import { describe, expect, it } from 'vitest';
import { DEFAULT_MAPPINGS, DEFAULT_SETTINGS, GestureGate, type Mapping, type Settings } from './domain';

const palm = { ...DEFAULT_MAPPINGS.find(m => m.id === 'open_palm')! };
const victory = { ...DEFAULT_MAPPINGS.find(m => m.id === 'victory')! };
const smile = { ...DEFAULT_MAPPINGS.find(m => m.id === 'smile')!, enabled: true };
const swipe = { ...DEFAULT_MAPPINGS.find(m => m.id === 'swipe_right')!, enabled: true };
const candidates = (id = palm.id, confidence = 0.95, transient = false) => [{ id, confidence, transient }];

/** Simulates regular camera frames; gaps themselves must not accidentally release a pose. */
function hold(gate: GestureGate, mapping: Mapping, from: number, until: number, settings: Settings = DEFAULT_SETTINGS) {
  const results: { time: number; mapping: Mapping }[] = [];
  for (let time = from; time <= until; time += 100) {
    const result = gate.update(candidates(mapping.id), [mapping], time, settings);
    if (result) results.push({ time, mapping: result });
  }
  return results;
}

describe('GestureGate', () => {
  it('waits for the configured dwell and fires once for a continuously held pose', () => {
    const gate = new GestureGate();
    expect(hold(gate, palm, 0, 500)).toEqual([]);
    expect(gate.update(candidates(), [palm], 600, DEFAULT_SETTINGS)).toEqual(palm);
    expect(hold(gate, palm, 700, 4000)).toEqual([]);
  });

  it('requires a real release before the same held pose can fire again', () => {
    const gate = new GestureGate();
    expect(hold(gate, palm, 0, 2200).map(result => result.time)).toEqual([600]);
    expect(gate.update([], [palm], 2300, DEFAULT_SETTINGS)).toBeNull();
    expect(gate.update([], [palm], 2500, DEFAULT_SETTINGS)).toBeNull();
    expect(hold(gate, palm, 2600, 3200).map(result => result.time)).toEqual([3200]);
  });

  it('keeps the fired latch across a brief missing camera detection', () => {
    const gate = new GestureGate();
    hold(gate, palm, 0, 2200);
    gate.update([], [palm], 2300, DEFAULT_SETTINGS);
    expect(hold(gate, palm, 2400, 3300)).toEqual([]);
  });

  it('applies the cooldown globally across different gestures', () => {
    const gate = new GestureGate();
    hold(gate, palm, 0, 600);
    expect(hold(gate, victory, 700, 2000)).toEqual([]);
    expect(gate.update(candidates(victory.id), [victory], 2100, DEFAULT_SETTINGS)).toEqual(victory);
  });

  it('ignores disabled mappings and unknown gestures', () => {
    const gate = new GestureGate();
    expect(hold(gate, { ...palm, enabled: false }, 0, 3000)).toEqual([]);
    expect(gate.update(candidates('not_saved', 0.99, true), [palm], 4000, DEFAULT_SETTINGS)).toBeNull();
  });

  it('ignores facial commands when face recognition is disabled', () => {
    const gate = new GestureGate();
    const settings = { ...DEFAULT_SETTINGS, faceEnabled: false };
    expect(hold(gate, smile, 0, 3000, settings)).toEqual([]);
    expect(hold(gate, palm, 3100, 3700, settings).map(result => result.time)).toEqual([3700]);
  });

  it('accepts transient swipes immediately while retaining release and cooldown protection', () => {
    const gate = new GestureGate();
    expect(gate.update(candidates(swipe.id, 0.95, true), [swipe], 0, DEFAULT_SETTINGS)).toEqual(swipe);
    expect(gate.update(candidates(swipe.id, 0.95, true), [swipe], 100, DEFAULT_SETTINGS)).toBeNull();
    gate.update([], [swipe], 500, DEFAULT_SETTINGS);
    expect(gate.update(candidates(swipe.id, 0.95, true), [swipe], 600, DEFAULT_SETTINGS)).toBeNull();
    gate.update([], [swipe], 1000, DEFAULT_SETTINGS);
    expect(gate.update(candidates(swipe.id, 0.95, true), [swipe], 1500, DEFAULT_SETTINGS)).toEqual(swipe);
  });

  it('does not mistake noisy confidence on a still-present gesture for a release', () => {
    const gate = new GestureGate();
    hold(gate, palm, 0, 2200);
    for (let time = 2300; time <= 2800; time += 100) {
      expect(gate.update(candidates(palm.id, 0.5), [palm], time, DEFAULT_SETTINGS)).toBeNull();
    }
    expect(hold(gate, palm, 2900, 3600)).toEqual([]);
  });

  it('rejects low-confidence poses and low-confidence transient events', () => {
    const gate = new GestureGate();
    for (let time = 0; time <= 2500; time += 100) {
      expect(gate.update(candidates(palm.id, 0.6), [palm], time, DEFAULT_SETTINGS)).toBeNull();
    }
    expect(gate.update(candidates(swipe.id, 0.6, true), [swipe], 2600, DEFAULT_SETTINGS)).toBeNull();
  });

  it('resets pending dwell and cooldown when recognition starts a fresh session', () => {
    const gate = new GestureGate();
    hold(gate, palm, 0, 600);
    gate.reset();
    expect(hold(gate, victory, 700, 1200)).toEqual([]);
    expect(gate.update(candidates(victory.id), [victory], 1300, DEFAULT_SETTINGS)).toEqual(victory);
  });
});


describe('simultaneous recognition priority', () => {
  it('keeps a custom pose from also triggering its matching built-in command', () => {
    const gate = new GestureGate();
    const custom: Mapping = { ...palm, id: 'custom_pose', kind: 'custom', command: 'copy' };
    const results: string[] = [];
    for (let time = 0; time <= 5000; time += 100) {
      const result = gate.update([...candidates(custom.id), ...candidates(palm.id)], [custom, palm], time, DEFAULT_SETTINGS);
      if (result) results.push(result.id);
    }
    expect(results).toEqual([custom.id]);
  });

  it('still allows a lower-priority enabled gesture when the first is disabled', () => {
    const gate = new GestureGate();
    const results: string[] = [];
    for (let time = 0; time <= 3000; time += 100) {
      const result = gate.update([...candidates(palm.id), ...candidates(victory.id)], [{ ...palm, enabled: false }, victory], time, DEFAULT_SETTINGS);
      if (result) results.push(result.id);
    }
    expect(results).toEqual([victory.id]);
  });
});
