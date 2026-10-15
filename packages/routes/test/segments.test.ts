import { describe, expect, it } from 'vitest';
import { SegmentTracker, type RouteSegment } from '../src';

const segs: RouteSegment[] = [
  { id: 'climb', name: 'Climb', type: 'climb', startM: 1000, endM: 2000 },
  { id: 'sprint', name: 'Sprint', type: 'sprint', startM: 4500, endM: 4900 },
];

/** Rides at constant speed in steps of dt and collects results. */
function ride(tracker: SegmentTracker, speed: number, untilM: number, dt = 0.1) {
  const results = [];
  let d = 0;
  let t = 0;
  while (d < untilM) {
    d += speed * dt;
    t += dt;
    results.push(...tracker.update(d, t));
  }
  return results;
}

describe('SegmentTracker', () => {
  it('times a segment precisely with interpolated crossings', () => {
    const tr = new SegmentTracker(segs, 5000);
    const results = ride(tr, 10, 2100, 0.37);
    expect(results).toHaveLength(1);
    expect(results[0]!.segment.id).toBe('climb');
    expect(results[0]!.timeS).toBeCloseTo(100, 6);
    expect(results[0]!.speedMps).toBeCloseTo(10, 6);
  });

  it('reports progress while inside a segment', () => {
    const tr = new SegmentTracker(segs, 5000);
    ride(tr, 10, 1500);
    const cur = tr.current();
    expect(cur).toHaveLength(1);
    expect(cur[0]!.progress).toBeCloseTo(0.5, 1);
    expect(cur[0]!.elapsedS).toBeCloseTo(50, 0);
  });

  it('repeats every lap and handles big steps across the finish line', () => {
    const tr = new SegmentTracker(segs, 5000);
    const results = ride(tr, 10, 12100, 1);
    expect(results.map((r) => `${r.segment.id}@${r.lap}`)).toEqual(['climb@1', 'sprint@1', 'climb@2', 'sprint@2', 'climb@3']);
    expect(results.every((r) => Math.abs(r.timeS - (r.segment.endM - r.segment.startM) / 10) < 1e-6)).toBe(true);
  });

  it('ignores standing still', () => {
    const tr = new SegmentTracker(segs, 5000);
    expect(tr.update(0, 10)).toEqual([]);
    expect(tr.current()).toEqual([]);
  });
});
