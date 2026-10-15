import { describe, expect, it } from 'vitest';
import {
  CommandQueueForTest,
  encodeIndoorBikeSimulation,
  encodeRequestControl,
  encodeSetTargetPower,
  encodeWahooErg,
  encodeWahooSimGrade,
  encodeWahooSimMode,
  encodeWahooUnlock,
  parseControlPointResponse,
  toHex,
} from './helpers';

describe('FTMS control point encoding', () => {
  it('request control', () => {
    expect(toHex(encodeRequestControl())).toBe('00');
  });

  it('target power is a signed 16-bit LE value', () => {
    expect(toHex(encodeSetTargetPower(250))).toBe('05 fa 00');
    expect(toHex(encodeSetTargetPower(1000.4))).toBe('05 e8 03');
    expect(toHex(encodeSetTargetPower(-10))).toBe('05 00 00');
  });

  it('indoor bike simulation: wind 0.001 m/s, grade 0.01 %, crr 0.0001, cw 0.01 kg/m', () => {
    const bytes = encodeIndoorBikeSimulation({ gradePercent: 5.25, windSpeedMps: -1.5, crr: 0.004, cwKgPerM: 0.51 });
    // wind -1500 = 0xfa24, grade 525 = 0x020d, crr 40 = 0x28, cw 51 = 0x33
    expect(toHex(bytes)).toBe('11 24 fa 0d 02 28 33');
  });

  it('negative grades are two’s complement', () => {
    expect(toHex(encodeIndoorBikeSimulation({ gradePercent: -3, crr: 0.004, cwKgPerM: 0.2 }))).toBe('11 00 00 d4 fe 28 14');
  });

  it('parses responses and ignores other indications', () => {
    expect(parseControlPointResponse(new DataView(Uint8Array.of(0x80, 0x05, 0x01).buffer))).toEqual({
      requestOpCode: 0x05,
      resultCode: 0x01,
      ok: true,
    });
    expect(parseControlPointResponse(new DataView(Uint8Array.of(0x80, 0x11, 0x05).buffer))?.ok).toBe(false);
    expect(parseControlPointResponse(new DataView(Uint8Array.of(0x05, 0x01).buffer))).toBeNull();
  });
});

describe('Wahoo legacy encoding', () => {
  it('unlock', () => {
    expect(toHex(encodeWahooUnlock())).toBe('20 ee fc');
  });

  it('erg', () => {
    expect(toHex(encodeWahooErg(200))).toBe('42 c8 00');
  });

  it('grade maps [-100 %, 100 %] onto 0…65535', () => {
    expect(toHex(encodeWahooSimGrade(0))).toBe('46 00 80');
    expect(toHex(encodeWahooSimGrade(-100))).toBe('46 00 00');
    expect(toHex(encodeWahooSimGrade(100))).toBe('46 ff ff');
  });

  it('sim mode', () => {
    expect(toHex(encodeWahooSimMode({ weightKg: 85, crr: 0.004, windResistance: 0.51 }))).toBe('43 34 21 28 00 fe 01');
  });
});

describe('CommandQueue', () => {
  it('runs commands strictly one after another', async () => {
    const q = new CommandQueueForTest();
    const order: string[] = [];
    let release!: () => void;
    const first = q.enqueue('a', () => new Promise<void>((r) => (release = () => (order.push('a'), r()))));
    const second = q.enqueue('b', async () => {
      order.push('b');
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['a', 'b']);
  });

  it('coalesces queued commands with the same key (latest wins)', async () => {
    const q = new CommandQueueForTest();
    const sent: number[] = [];
    let release!: () => void;
    const blocker = q.enqueue('control', () => new Promise<void>((r) => (release = r)));
    const p1 = q.enqueue('target', async () => void sent.push(100));
    const p2 = q.enqueue('target', async () => void sent.push(200));
    const p3 = q.enqueue('target', async () => void sent.push(300));
    release();
    await Promise.all([blocker, p1, p2, p3]);
    expect(sent).toEqual([300]);
  });
});
