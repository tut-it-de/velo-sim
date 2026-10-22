import { toHex } from '../bytes';
import { normalizeUuid } from '../uuids';
import type { BleService, DeviceRequest } from '../transport/types';
import { ManagedDevice, errorMessage } from './managedDevice';

/**
 * Zwift's shifter remotes – Click (v1 and v2), Play and Ride – over the Zwift Accessory Protocol.
 * Reverse engineered by the community (ajchellew/zwiftplay, makinolo.com). After a plain "RideOn"
 * written to SYNC_RX, the controllers send their button states unencrypted on ASYNC:
 *  - 0x37 Click v1: protobuf, field 1 = plus, field 2 = minus, value 0 = pressed
 *  - 0x07 Play: protobuf, field 1 = side (0 right, 1 left), field 6 = shoulder, value 0 = pressed
 *  - 0x23 Click v2 / Ride: field 1 = 32-bit button bitmap, bit 0 = pressed
 */
export const ZWIFT = {
  service: normalizeUuid('00000001-19ca-4651-86e5-fa29dcdd09d1'),
  /** Advertised (and since the 2025 firmware also the GATT service) of the newer controllers. */
  serviceFc82: normalizeUuid(0xfc82),
  async: normalizeUuid('00000002-19ca-4651-86e5-fa29dcdd09d1'),
  syncRx: normalizeUuid('00000003-19ca-4651-86e5-fa29dcdd09d1'),
  syncTx: normalizeUuid('00000004-19ca-4651-86e5-fa29dcdd09d1'),
} as const;

export const ZWIFT_SHIFTER_REQUEST: DeviceRequest = {
  services: [ZWIFT.serviceFc82, ZWIFT.service],
  namePrefixes: ['Zwift'],
  optionalServices: [ZWIFT.service, ZWIFT.serviceFc82],
};

const RIDE_ON = [0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e];

/** Zwift Ride / Click v2 button bits (pressed = bit cleared). */
const RIDE_UP = 0x2 | 0x200 | 0x2000; // d-pad up, left and right shift up
const RIDE_DOWN = 0x8 | 0x400 | 0x4000; // d-pad down, left and right shift down

export interface ShifterButtons {
  up: boolean;
  down: boolean;
}

function readVarint(b: Uint8Array, i: number): [number, number] {
  let v = 0;
  let shift = 0;
  for (;;) {
    if (i >= b.length) throw new Error('Varint abgeschnitten');
    const byte = b[i++]!;
    v += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [v, i];
    shift += 7;
  }
}

/** Varint fields of a protobuf message (other wire types are skipped). */
function varintFields(b: Uint8Array, from: number): Map<number, number> {
  const out = new Map<number, number>();
  let i = from;
  while (i < b.length) {
    let tag: number;
    [tag, i] = readVarint(b, i);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) {
      let v: number;
      [v, i] = readVarint(b, i);
      out.set(field, v);
    } else if (wire === 2) {
      let len: number;
      [len, i] = readVarint(b, i);
      i += len;
    } else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else break;
  }
  return out;
}

/** Which shift buttons a ZAP message says are held; null for messages without buttons. */
export function parseZwiftButtons(msg: Uint8Array): ShifterButtons | null {
  if (msg.length < 1) return null;
  const type = msg[0];
  if (type === 0x37) {
    const f = varintFields(msg, 1);
    return { up: f.get(1) === 0, down: f.get(2) === 0 };
  }
  if (type === 0x07) {
    const f = varintFields(msg, 1);
    const shoulder = f.get(6) === 0;
    const right = (f.get(1) ?? 0) === 0;
    return { up: shoulder && right, down: shoulder && !right };
  }
  if (type === 0x23) {
    // Field 1 is a varint in the protobuf, but some firmware sends the raw 32-bit little-endian map.
    let map: number;
    if (msg[1] === 0x08) map = readVarint(msg, 2)[0];
    else if (msg.length >= 5) map = (msg[1]! | (msg[2]! << 8) | (msg[3]! << 16) | (msg[4]! << 24)) >>> 0;
    else return null;
    return { up: (map & RIDE_UP) !== RIDE_UP, down: (map & RIDE_DOWN) !== RIDE_DOWN };
  }
  return null;
}

export interface ShiftData {
  timestamp: number;
  /** +1 = heavier gear, −1 = lighter. */
  shift: 1 | -1;
}

/** A Zwift Click / Play / Ride: emits one `data` event per button press. */
export class ZwiftShifter extends ManagedDevice<ShiftData> {
  private held: ShifterButtons = { up: false, down: false };

  protected override resetConnectionState(): void {
    this.held = { up: false, down: false };
  }

  protected override async setup(services: Map<string, BleService>): Promise<void> {
    const service = services.get(ZWIFT.service) ?? services.get(ZWIFT.serviceFc82);
    const async = service && (await service.getCharacteristic(ZWIFT.async));
    const rx = service && (await service.getCharacteristic(ZWIFT.syncRx));
    const tx = service && (await service.getCharacteristic(ZWIFT.syncTx));
    if (!async || !rx) throw new Error('Kein Zwift-Controller (Click, Play oder Ride)');
    const onMessage = (v: DataView) => {
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      if (RIDE_ON.every((c, i) => bytes[i] === c)) return; // handshake answer
      try {
        const b = parseZwiftButtons(bytes);
        if (!b) return;
        // Shift once per press, not while the button is held.
        if (b.up && !this.held.up) this.emit('data', { timestamp: Date.now(), shift: 1 });
        if (b.down && !this.held.down) this.emit('data', { timestamp: Date.now(), shift: -1 });
        this.held = b;
      } catch (err) {
        this.log('warn', `${this.name}: Zwift-Paket fehlerhaft (${toHex(bytes)}): ${errorMessage(err)}`);
      }
    };
    this.track(await async.startNotifications(onMessage));
    if (tx) this.track(await tx.startNotifications(onMessage));
    await rx.write(new Uint8Array(RIDE_ON), true);
    this.log('info', `${this.name}: RideOn gesendet – Schalter bereit`);
  }
}
