import { describe, expect, it } from 'vitest';
import { Decoder, Stream } from '@garmin/fitsdk';
import {
  ActivityRecorder,
  bestAverage,
  encodeFitActivity,
  fitCrc,
  intensityFactor,
  kilojoules,
  normalizedPower,
  powerZone,
  timeInZones,
  trainingStressScore,
} from '../src';

describe('power metrics', () => {
  it('NP of a constant effort equals the average', () => {
    expect(normalizedPower(new Array(600).fill(200))).toBeCloseTo(200, 6);
  });

  it('NP of intervals is higher than the average', () => {
    const p: number[] = [];
    for (let i = 0; i < 20; i++) p.push(...new Array(60).fill(i % 2 ? 100 : 300));
    expect(normalizedPower(p)).toBeGreaterThan(220);
  });

  it('one hour at FTP = 100 TSS, IF 1.0', () => {
    expect(trainingStressScore(3600, 250, 250)).toBeCloseTo(100, 6);
    expect(intensityFactor(250, 250)).toBe(1);
    expect(trainingStressScore(1800, 200, 250)).toBeCloseTo(32, 0);
  });

  it('kJ and best averages', () => {
    expect(kilojoules(new Array(3600).fill(200))).toBeCloseTo(720);
    const p = [...new Array(100).fill(100), ...new Array(5).fill(900), ...new Array(100).fill(100)];
    expect(bestAverage(p, 5)).toBe(900);
  });

  it('zones relative to FTP', () => {
    expect(powerZone(100, 200).zone).toBe(1);
    expect(powerZone(140, 200).zone).toBe(2);
    expect(powerZone(170, 200).zone).toBe(3);
    expect(powerZone(200, 200).zone).toBe(4);
    expect(powerZone(230, 200).zone).toBe(5);
    expect(powerZone(300, 200).zone).toBe(6);
    expect(timeInZones([100, 200, 200, 300], 200)).toEqual([1, 0, 0, 2, 0, 1]);
  });
});

const T0 = Date.UTC(2026, 9, 15, 17, 0, 0);

function fakeRide(seconds: number, lapEvery: number): ActivityRecorder {
  const rec = new ActivityRecorder(250, T0);
  let distance = 0;
  for (let i = 0; i < seconds; i++) {
    const speed = 9 + Math.sin(i / 30);
    distance += speed;
    rec.record({
      timestamp: T0 + i * 1000,
      distanceM: distance,
      speedMps: speed,
      elevationM: 10 + 5 * Math.sin(i / 100),
      gradePercent: 2 * Math.cos(i / 100),
      power: 200 + (i % 60 < 30 ? 50 : -50),
      cadence: 90,
      heartRate: 140 + (i % 10),
    });
    if ((i + 1) % lapEvery === 0) rec.lap();
  }
  return rec;
}

describe('ActivityRecorder', () => {
  it('summarises a ride with laps', () => {
    const rec = fakeRide(600, 200);
    const s = rec.summary();
    expect(s.durationS).toBe(600);
    expect(s.laps).toHaveLength(3);
    expect(s.laps.reduce((a, l) => a + l.durationS, 0)).toBe(600);
    expect(s.laps.reduce((a, l) => a + l.distanceM, 0)).toBeCloseTo(s.distanceM, -1);
    expect(s.avgPower).toBeCloseTo(200, 0);
    expect(s.kilojoules).toBeCloseTo(120, 0);
    expect(s.avgCadence).toBe(90);
    expect(s.maxHeartRate).toBe(149);
    expect(s.ascentM).toBeGreaterThan(5);
  });
});

describe('FIT export', () => {
  const rec = fakeRide(900, 300);
  const summary = rec.summary();
  const bytes = encodeFitActivity(rec.samples, summary, { utcOffsetMinutes: 120 });

  it('has a valid header and CRC', () => {
    expect(bytes[0]).toBe(14);
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('.FIT');
    expect(fitCrc(bytes)).toBe(0); // CRC over data + CRC bytes is zero
  });

  it('decodes with the official Garmin FIT SDK', () => {
    const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
    expect(decoder.isFIT()).toBe(true);
    expect(decoder.checkIntegrity()).toBe(true);
    // The SDK typings mark every message list optional; the assertions below check presence anyway.
    const { messages, errors } = decoder.read() as unknown as {
      messages: Record<'fileIdMesgs' | 'recordMesgs' | 'lapMesgs' | 'sessionMesgs' | 'activityMesgs', any[]>;
      errors: unknown[];
    };
    expect(errors).toEqual([]);

    expect(messages.fileIdMesgs[0].type).toBe('activity');
    expect(messages.recordMesgs).toHaveLength(900);
    const r = messages.recordMesgs[100];
    expect(r.power).toBe(rec.samples[100]!.power);
    expect(r.cadence).toBe(90);
    expect(r.heartRate).toBe(rec.samples[100]!.heartRate);
    expect(r.distance).toBeCloseTo(rec.samples[100]!.distanceM, 1);
    expect(r.altitude).toBeCloseTo(rec.samples[100]!.elevationM, 0);
    expect(new Date(r.timestamp).getTime()).toBe(T0 + 100_000);

    expect(messages.lapMesgs).toHaveLength(3);
    const session = messages.sessionMesgs[0];
    expect(session.sport).toBe('cycling');
    expect(session.subSport).toBe('virtualActivity');
    expect(session.totalTimerTime).toBeCloseTo(900, 0);
    expect(session.totalDistance).toBeCloseTo(summary.distanceM, 0);
    expect(session.avgPower).toBe(Math.round(summary.avgPower));
    expect(session.normalizedPower).toBe(Math.round(summary.normalizedPower));
    expect(session.thresholdPower).toBe(250);
    expect(session.numLaps).toBe(3);
    expect(messages.activityMesgs[0].numSessions).toBe(1);
  });
});
