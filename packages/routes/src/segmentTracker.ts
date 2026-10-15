import type { RouteSegment } from './types';

export interface ActiveSegment {
  segment: RouteSegment;
  /** Moving time at which the segment start was crossed. */
  startS: number;
  elapsedS: number;
  /** 0…1 */
  progress: number;
  distanceIntoM: number;
}

export interface SegmentResult {
  segment: RouteSegment;
  timeS: number;
  /** Average speed over the segment in m/s. */
  speedMps: number;
  lap: number;
}

/**
 * Times route segments (climbs, sprints, descents) every lap. Feed it the
 * rider's total distance and moving time each tick; start and finish times are
 * interpolated to the exact crossing point, so a 10 Hz tick rate is precise
 * to a few hundredths of a second.
 */
export class SegmentTracker {
  private active = new Map<string, { startS: number; startAbs: number }>();
  private lastDistance: number;
  private lastTime: number;

  constructor(
    private readonly segments: RouteSegment[],
    private readonly lapLength: number,
    startDistanceM = 0,
    startTimeS = 0,
  ) {
    this.lastDistance = startDistanceM;
    this.lastTime = startTimeS;
  }

  /** Returns segments finished during this step. */
  update(distanceM: number, timeS: number): SegmentResult[] {
    const d0 = this.lastDistance;
    const t0 = this.lastTime;
    const d1 = distanceM;
    const t1 = timeS;
    this.lastDistance = d1;
    this.lastTime = t1;
    if (d1 <= d0) return [];

    const at = (abs: number) => t0 + ((abs - d0) / (d1 - d0)) * (t1 - t0);
    const results: SegmentResult[] = [];
    const firstLap = Math.floor(d0 / this.lapLength);
    const lastLap = Math.floor(d1 / this.lapLength);

    for (let lap = firstLap; lap <= lastLap; lap++) {
      const base = lap * this.lapLength;
      for (const seg of this.segments) {
        const startAbs = base + seg.startM;
        const endAbs = base + seg.endM;
        const running = this.active.get(seg.id);
        if (running && running.startAbs === startAbs && d0 < endAbs && d1 >= endAbs) {
          const timeS = at(endAbs) - running.startS;
          results.push({ segment: seg, timeS, speedMps: (seg.endM - seg.startM) / timeS, lap: lap + 1 });
          this.active.delete(seg.id);
        }
        if (d0 < startAbs && d1 >= startAbs) {
          this.active.set(seg.id, { startS: at(startAbs), startAbs });
        }
      }
    }
    return results;
  }

  /** Segments currently being ridden. */
  current(): ActiveSegment[] {
    const out: ActiveSegment[] = [];
    for (const seg of this.segments) {
      const a = this.active.get(seg.id);
      if (!a) continue;
      const into = this.lastDistance - a.startAbs;
      const len = seg.endM - seg.startM;
      out.push({ segment: seg, startS: a.startS, elapsedS: this.lastTime - a.startS, progress: Math.min(1, into / len), distanceIntoM: into });
    }
    return out;
  }
}
