import { describe, expect, it } from 'vitest';
import { parseZwiftButtons } from '../src/devices/zwiftShifter';

describe('parseZwiftButtons', () => {
  it('reads the Click v1 plus/minus buttons (0 = pressed)', () => {
    expect(parseZwiftButtons(new Uint8Array([0x37, 0x08, 0x00, 0x10, 0x01]))).toEqual({ up: true, down: false });
    expect(parseZwiftButtons(new Uint8Array([0x37, 0x08, 0x01, 0x10, 0x00]))).toEqual({ up: false, down: true });
    expect(parseZwiftButtons(new Uint8Array([0x37, 0x08, 0x01, 0x10, 0x01]))).toEqual({ up: false, down: false });
  });

  it('reads the Ride / Click v2 bitmap as varint and as raw 32 bit', () => {
    const all = 0xffffffff;
    const varint = (v: number) => {
      const out: number[] = [];
      while (v >= 0x80) {
        out.push((v % 0x80) | 0x80);
        v = Math.floor(v / 0x80);
      }
      out.push(v);
      return out;
    };
    expect(parseZwiftButtons(new Uint8Array([0x23, 0x08, ...varint((all & ~0x2000) >>> 0)]))).toEqual({ up: true, down: false });
    expect(parseZwiftButtons(new Uint8Array([0x23, 0x08, ...varint(all)]))).toEqual({ up: false, down: false });
    const raw = (all & ~0x4000) >>> 0;
    expect(parseZwiftButtons(new Uint8Array([0x23, raw & 0xff, (raw >> 8) & 0xff, (raw >> 16) & 0xff, raw >>> 24]))).toEqual({ up: false, down: true });
  });

  it('reads the Play shoulder buttons by side', () => {
    expect(parseZwiftButtons(new Uint8Array([0x07, 0x08, 0x00, 0x30, 0x00]))).toEqual({ up: true, down: false });
    expect(parseZwiftButtons(new Uint8Array([0x07, 0x08, 0x01, 0x30, 0x00]))).toEqual({ up: false, down: true });
  });

  it('ignores idle and battery messages', () => {
    expect(parseZwiftButtons(new Uint8Array([0x15]))).toBeNull();
    expect(parseZwiftButtons(new Uint8Array([0x19, 0x08, 0x50]))).toBeNull();
  });
});
