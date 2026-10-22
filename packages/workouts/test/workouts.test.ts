import { describe, expect, it } from 'vitest';
import {
  WORKOUT_LIBRARY,
  WorkoutPlayer,
  ZwoError,
  buildTimeline,
  evaluateTest,
  ftpFactorForDuration,
  ftpFromRampTest,
  resolveWorkout,
  zoneWatts,
  parseZwo,
  serializeZwo,
  totalDurationS,
  workoutStats,
  type Workout,
} from '../src';

const SAMPLE_ZWO = `<?xml version="1.0" encoding="UTF-8"?>
<workout_file>
  <author>Coach &amp; Co</author>
  <name>4x8 Schwelle</name>
  <description>Klassiker</description>
  <sportType>bike</sportType>
  <tags><tag name="FTP"/></tags>
  <workout>
    <Warmup Duration="600" PowerLow="0.50" PowerHigh="0.75" pace="0"/>
    <IntervalsT Repeat="4" OnDuration="480" OffDuration="240" OnPower="0.98" OffPower="0.55" Cadence="95" CadenceResting="85">
      <textevent timeoffset="0" message="Jetzt gilt's!"/>
    </IntervalsT>
    <SteadyState Duration="300" Power="0.7" CadenceLow="88" CadenceHigh="92"/>
    <FreeRide Duration="300" FlatRoad="1"/>
    <MaxEffort Duration="20"/>
    <!-- Zwift writes cooldowns with PowerLow > PowerHigh -->
    <Cooldown Duration="600" PowerLow="0.65" PowerHigh="0.40"/>
  </workout>
</workout_file>`;

describe('zwo import', () => {
  const w = parseZwo(SAMPLE_ZWO, 'test');

  it('reads metadata', () => {
    expect(w.name).toBe('4x8 Schwelle');
    expect(w.author).toBe('Coach & Co');
    expect(w.description).toBe('Klassiker');
  });

  it('reads all block types', () => {
    expect(w.steps.map((s) => s.type)).toEqual(['warmup', 'intervals', 'steady', 'freeride', 'maxeffort', 'cooldown']);
    const iv = w.steps[1]!;
    if (iv.type !== 'intervals') throw new Error();
    expect(iv.repeat).toBe(4);
    expect(iv.on).toEqual({ durationS: 480, power: 0.98, cadence: 95 });
    expect(iv.off).toEqual({ durationS: 240, power: 0.55, cadence: 85 });
    const steady = w.steps[2]!;
    if (steady.type !== 'steady') throw new Error();
    expect(steady.cadence).toEqual([88, 92]);
  });

  it('orders warmup up and cooldown down regardless of attribute order', () => {
    const cd = w.steps.at(-1)!;
    if (cd.type !== 'cooldown') throw new Error();
    expect(cd.powerStart).toBe(0.65);
    expect(cd.powerEnd).toBe(0.4);
  });

  it('places nested text events at absolute times', () => {
    expect(w.textEvents).toEqual([{ atS: 600, message: "Jetzt gilt's!", durationS: undefined }]);
  });

  it('rejects files that are not workouts', () => {
    expect(() => parseZwo('<html></html>')).toThrow(ZwoError);
    expect(() => parseZwo('<workout_file><workout></workout></workout_file>')).toThrow(ZwoError);
  });

  it('round-trips through serializeZwo', () => {
    const again = parseZwo(serializeZwo(w), 'test');
    expect(again.steps).toEqual(w.steps);
    expect(again.name).toBe(w.name);
    expect(again.textEvents).toEqual(w.textEvents);
  });
});

describe('timeline', () => {
  it('expands intervals and sums durations', () => {
    const w = parseZwo(SAMPLE_ZWO);
    const tl = buildTimeline(w);
    expect(tl).toHaveLength(1 + 8 + 1 + 1 + 1 + 1);
    expect(tl[1]!.label).toBe('Intervall 1/4');
    expect(tl[2]!.label).toBe('Pause 1/4');
    expect(totalDurationS(w)).toBe(600 + 4 * 720 + 300 + 300 + 20 + 600);
    expect(tl.find((s) => s.kind === 'freeride')!.mode).toBe('free');
  });

  it('estimates TSS: one hour at FTP ≈ 100', () => {
    const w: Workout = { id: 'x', name: 'x', description: '', steps: [{ type: 'steady', durationS: 3600, power: 1 }] };
    const s = workoutStats(w);
    expect(s.tss).toBeCloseTo(100, 0);
    expect(s.intensityFactor).toBeCloseTo(1, 3);
  });

  it('library workouts are well formed', () => {
    for (const w of WORKOUT_LIBRARY) {
      const stats = workoutStats(w);
      expect(stats.durationS).toBeGreaterThan(600);
      expect(stats.tss).toBeGreaterThan(5);
      expect(new Set(WORKOUT_LIBRARY.map((x) => x.id)).size).toBe(WORKOUT_LIBRARY.length);
      if (w.powerUnit === 'watts') continue;
      expect(parseZwo(serializeZwo(w)).steps).toEqual(w.steps.map((s) => ('label' in s ? (({ label: _l, ...rest }) => rest)(s) : s)));
    }
  });
});

const simple: Workout = {
  id: 's',
  name: 's',
  description: '',
  steps: [
    { type: 'ramp', durationS: 100, powerStart: 0.5, powerEnd: 1.0 },
    { type: 'steady', durationS: 60, power: 1.2, cadence: 95 },
    { type: 'freeride', durationS: 30 },
  ],
  textEvents: [{ atS: 120, message: 'Halten!', durationS: 5 }],
};

describe('WorkoutPlayer', () => {
  it('interpolates ramps and applies FTP and intensity', () => {
    const p = new WorkoutPlayer(simple, 200);
    expect(p.advance(50, { power: 150, cadence: 90 }).state.targetWatts).toBe(150); // 0.75 × 200
    p.setIntensity(1.1);
    expect(p.state.targetWatts).toBe(165);
  });

  it('reports segment changes, free segments and finishing', () => {
    const p = new WorkoutPlayer(simple, 200);
    expect(p.advance(1, { power: 100, cadence: 90 }).segmentChanged).toBe(true);
    expect(p.advance(98, { power: 100, cadence: 90 }).segmentChanged).toBe(false);
    const s = p.advance(2, { power: 240, cadence: 95 });
    expect(s.segmentChanged).toBe(true);
    expect(s.state.targetWatts).toBe(240);
    expect(s.state.cadenceTarget).toBe(95);
    const free = p.advance(60, { power: 200, cadence: 90 });
    expect(free.state.mode).toBe('free');
    expect(free.state.targetWatts).toBeUndefined();
    expect(p.advance(40, { power: 0, cadence: 0 }).state.finished).toBe(true);
  });

  it('shows text events while they are active', () => {
    const p = new WorkoutPlayer(simple, 200);
    p.advance(121, { power: 200, cadence: 90 });
    expect(p.state.activeText).toBe('Halten!');
    p.advance(10, { power: 200, cadence: 90 });
    expect(p.state.activeText).toBeUndefined();
  });

  it('skip jumps to the next segment', () => {
    const p = new WorkoutPlayer(simple, 200);
    p.advance(10, { power: 100, cadence: 90 });
    p.skip();
    expect(p.state.segment?.kind).toBe('steady');
    expect(p.state.elapsedS).toBe(100);
  });

  it('relieves ERG when cadence collapses and restores it', () => {
    const p = new WorkoutPlayer(simple, 200);
    p.advance(101, { power: 240, cadence: 90 });
    for (let i = 0; i < 4; i++) p.advance(1, { power: 50, cadence: 25 });
    expect(p.state.relief).toBe(true);
    expect(p.state.targetWatts).toBe(120);
    for (let i = 0; i < 3; i++) p.advance(1, { power: 120, cadence: 80 });
    expect(p.state.relief).toBe(false);
    expect(p.state.targetWatts).toBe(240);
  });

  it('scores compliance', () => {
    const p = new WorkoutPlayer({ id: 'c', name: 'c', description: '', steps: [{ type: 'steady', durationS: 100, power: 1 }] }, 200);
    for (let i = 0; i < 50; i++) p.advance(1, { power: 200, cadence: 90 });
    for (let i = 0; i < 50; i++) p.advance(1, { power: 120, cadence: 90 });
    expect(p.state.compliance).toBeGreaterThan(0.45);
    expect(p.state.compliance).toBeLessThan(0.55);
  });

  it('ramp test ends the steps when the rider cannot keep pedalling', () => {
    const ramp = WORKOUT_LIBRARY.find((w) => w.id === 'ramp-test')!;
    const p = new WorkoutPlayer(ramp, 250);
    p.advance(300 + 8 * 60 + 10, { power: 300, cadence: 90 });
    expect(p.state.segment?.label).toBe('Stufe 9');
    for (let i = 0; i < 6; i++) p.advance(1, { power: 100, cadence: 30 });
    expect(p.state.segment?.kind).toBe('cooldown');
    expect(ftpFromRampTest(380)).toBe(285);
  });
});

describe('FTP tests', () => {
  const byId = (id: string) => WORKOUT_LIBRARY.find((w) => w.id === id)!;

  it('Zwift ramp: 100 W, +20 W per minute up to 600 W, independent of FTP', () => {
    const p = new WorkoutPlayer(byId('ramp-test-zwift'), 180);
    p.advance(300 + 10, { power: 100, cadence: 90 });
    expect(p.state.segment?.label).toBe('Stufe 1');
    expect(p.state.targetWatts).toBe(100);
    p.advance(60 * 4, { power: 180, cadence: 90 });
    expect(p.state.targetWatts).toBe(180);
    const steps = buildTimeline(byId('ramp-test-zwift'), 250).filter((s) => s.label.startsWith('Stufe'));
    expect(steps).toHaveLength(26);
    expect(Math.round(steps.at(-1)!.powerEnd * 250)).toBe(600);
  });

  it('Ramp Lite: 50 W, +10 W per minute up to 400 W', () => {
    const steps = buildTimeline(byId('ramp-test-lite'), 150).filter((s) => s.label.startsWith('Stufe'));
    expect(Math.round(steps[0]!.powerStart * 150)).toBe(50);
    expect(Math.round(steps[1]!.powerStart * 150)).toBe(60);
    expect(Math.round(steps.at(-1)!.powerEnd * 150)).toBe(400);
    expect(resolveWorkout(byId('ramp-test-lite'), 150).powerUnit).toBeUndefined();
  });

  it('evaluates an aborted ramp from the best minute', () => {
    const w = byId('ramp-test-zwift');
    const p = new WorkoutPlayer(w, 200);
    p.advance(300 + 12 * 60 + 20, { power: 300, cadence: 90 });
    for (let i = 0; i < 6; i++) p.advance(1, { power: 80, cadence: 30 });
    expect(p.state.segment?.kind).toBe('cooldown');
    const r = evaluateTest(w, p.testProgress, 330)!;
    expect(r.ftp).toBe(248);
    expect(r.confidence).toBe('mittel');
    expect(p.testProgress.rampTopReached).toBe(false);
  });

  it('flags a ramp that was too easy and refuses one that was too short', () => {
    const w = byId('ramp-test-lite');
    const p = new WorkoutPlayer(w, 200);
    p.advance(300 + 36 * 60 + 5, { power: 400, cadence: 90 });
    expect(p.testProgress.rampTopReached).toBe(true);
    const r = evaluateTest(w, p.testProgress, 400)!;
    expect(r.confidence).toBe('schätzung');
    expect(r.notes[0]).toContain('400 W');

    const early = new WorkoutPlayer(w, 200);
    early.advance(300 + 90, { power: 70, cadence: 90 });
    expect(evaluateTest(w, early.testProgress, 70)!.ftp).toBeUndefined();
  });

  it('20-minute test: 95 % of the block average, scaled when stopped after 12 min, nothing below', () => {
    const w = byId('ftp-test-20');
    const blockStart = buildTimeline(w).find((s) => s.label.startsWith('Testblock'))!.startS;
    const full = new WorkoutPlayer(w, 250);
    full.advance(blockStart, { power: 150, cadence: 90 });
    for (let i = 0; i < 1200; i++) full.advance(1, { power: 260, cadence: 92 });
    expect(full.testProgress.blockAvgPower).toBeCloseTo(260, 5);
    expect(evaluateTest(w, full.testProgress, 300)).toMatchObject({ ftp: 247, confidence: 'hoch' });

    const stopped = new WorkoutPlayer(w, 250);
    stopped.advance(blockStart, { power: 150, cadence: 90 });
    for (let i = 0; i < 14 * 60; i++) stopped.advance(1, { power: 270, cadence: 92 });
    const r = evaluateTest(w, stopped.testProgress, 300)!;
    expect(r.confidence).toBe('schätzung');
    expect(r.ftp).toBe(Math.round(270 * ftpFactorForDuration(14 * 60)));
    expect(r.ftp!).toBeLessThan(270 * 0.95);

    const short = new WorkoutPlayer(w, 250);
    short.advance(blockStart + 300, { power: 280, cadence: 92 });
    expect(evaluateTest(w, short.testProgress, 300)!.ftp).toBeUndefined();
  });

  it('duration factor: 90 % at 8 min, 95 % at 20 min', () => {
    expect(ftpFactorForDuration(480)).toBeCloseTo(0.9, 5);
    expect(ftpFactorForDuration(1200)).toBeCloseTo(0.95, 5);
    expect(ftpFactorForDuration(720)).toBeGreaterThan(0.91);
  });
});

describe('zoneWatts', () => {
  it('splits FTP into seven contiguous zones', () => {
    const z = zoneWatts(250);
    expect(z).toHaveLength(7);
    expect(z[1]).toMatchObject({ from: 139, to: 188 });
    expect(z[3]).toMatchObject({ from: 226, to: 263 });
    expect(z[6]!.to).toBeUndefined();
  });
});
