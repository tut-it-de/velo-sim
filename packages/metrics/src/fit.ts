import type { ActivitySample, ActivitySummary, LapSummary } from './recorder';

/**
 * Minimal FIT activity encoder (Garmin Flexible and Interoperable Data Transfer).
 * Produces files Strava, Garmin Connect, intervals.icu and TrainingPeaks accept
 * as an indoor/virtual ride: file_id, event, record (1 Hz), lap, session, activity.
 */

const FIT_EPOCH_MS = Date.UTC(1989, 11, 31, 0, 0, 0);

const enum BaseType {
  Enum = 0x00,
  UInt8 = 0x02,
  UInt16 = 0x84,
  SInt16 = 0x83,
  UInt32 = 0x86,
  UInt32z = 0x8c,
}

const SIZE: Record<BaseType, number> = {
  [BaseType.Enum]: 1,
  [BaseType.UInt8]: 1,
  [BaseType.UInt16]: 2,
  [BaseType.SInt16]: 2,
  [BaseType.UInt32]: 4,
  [BaseType.UInt32z]: 4,
};

const INVALID: Record<BaseType, number> = {
  [BaseType.Enum]: 0xff,
  [BaseType.UInt8]: 0xff,
  [BaseType.UInt16]: 0xffff,
  [BaseType.SInt16]: 0x7fff,
  [BaseType.UInt32]: 0xffffffff,
  [BaseType.UInt32z]: 0,
};

const MESG = { fileId: 0, session: 18, lap: 19, record: 20, event: 21, activity: 34 } as const;

type FieldDef = [num: number, type: BaseType];

interface MessageDef {
  global: number;
  fields: FieldDef[];
}

const DEFS = {
  fileId: {
    global: MESG.fileId,
    fields: [
      [0, BaseType.Enum], // type
      [1, BaseType.UInt16], // manufacturer
      [2, BaseType.UInt16], // product
      [3, BaseType.UInt32z], // serial_number
      [4, BaseType.UInt32], // time_created
    ],
  },
  event: {
    global: MESG.event,
    fields: [
      [253, BaseType.UInt32], // timestamp
      [0, BaseType.Enum], // event
      [1, BaseType.Enum], // event_type
    ],
  },
  record: {
    global: MESG.record,
    fields: [
      [253, BaseType.UInt32], // timestamp
      [5, BaseType.UInt32], // distance, 1/100 m
      [6, BaseType.UInt16], // speed, 1/1000 m/s
      [2, BaseType.UInt16], // altitude, 1/5 m - 500
      [9, BaseType.SInt16], // grade, 1/100 %
      [7, BaseType.UInt16], // power, W
      [4, BaseType.UInt8], // cadence, rpm
      [3, BaseType.UInt8], // heart_rate, bpm
    ],
  },
  lap: {
    global: MESG.lap,
    fields: [
      [253, BaseType.UInt32], // timestamp
      [254, BaseType.UInt16], // message_index
      [0, BaseType.Enum], // event
      [1, BaseType.Enum], // event_type
      [2, BaseType.UInt32], // start_time
      [7, BaseType.UInt32], // total_elapsed_time, ms
      [8, BaseType.UInt32], // total_timer_time, ms
      [9, BaseType.UInt32], // total_distance, cm
      [13, BaseType.UInt16], // avg_speed
      [14, BaseType.UInt16], // max_speed
      [15, BaseType.UInt8], // avg_heart_rate
      [16, BaseType.UInt8], // max_heart_rate
      [17, BaseType.UInt8], // avg_cadence
      [19, BaseType.UInt16], // avg_power
      [20, BaseType.UInt16], // max_power
      [21, BaseType.UInt16], // total_ascent
      [25, BaseType.Enum], // sport
    ],
  },
  session: {
    global: MESG.session,
    fields: [
      [253, BaseType.UInt32], // timestamp
      [254, BaseType.UInt16], // message_index
      [0, BaseType.Enum], // event
      [1, BaseType.Enum], // event_type
      [2, BaseType.UInt32], // start_time
      [5, BaseType.Enum], // sport
      [6, BaseType.Enum], // sub_sport
      [7, BaseType.UInt32], // total_elapsed_time
      [8, BaseType.UInt32], // total_timer_time
      [9, BaseType.UInt32], // total_distance
      [11, BaseType.UInt16], // total_calories
      [14, BaseType.UInt16], // avg_speed
      [15, BaseType.UInt16], // max_speed
      [16, BaseType.UInt8], // avg_heart_rate
      [17, BaseType.UInt8], // max_heart_rate
      [18, BaseType.UInt8], // avg_cadence
      [20, BaseType.UInt16], // avg_power
      [21, BaseType.UInt16], // max_power
      [22, BaseType.UInt16], // total_ascent
      [25, BaseType.UInt16], // first_lap_index
      [26, BaseType.UInt16], // num_laps
      [34, BaseType.UInt16], // normalized_power
      [35, BaseType.UInt16], // training_stress_score, 1/10
      [36, BaseType.UInt16], // intensity_factor, 1/1000
      [45, BaseType.UInt16], // threshold_power
    ],
  },
  activity: {
    global: MESG.activity,
    fields: [
      [253, BaseType.UInt32], // timestamp
      [0, BaseType.UInt32], // total_timer_time
      [1, BaseType.UInt16], // num_sessions
      [2, BaseType.Enum], // type
      [3, BaseType.Enum], // event
      [4, BaseType.Enum], // event_type
      [5, BaseType.UInt32], // local_timestamp
    ],
  },
} satisfies Record<string, MessageDef>;

type DefName = keyof typeof DEFS;

const EVENT = { timer: 0, session: 8, lap: 9, activity: 26 } as const;
const EVENT_TYPE = { start: 0, stop: 1, stopAll: 4 } as const;
const SPORT_CYCLING = 2;
const SUB_SPORT_VIRTUAL = 58;
const FILE_TYPE_ACTIVITY = 4;
const MANUFACTURER_DEVELOPMENT = 255;

const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

export function fitCrc(bytes: Uint8Array, start = 0, end = bytes.length, seed = 0): number {
  let crc = seed;
  for (let i = start; i < end; i++) {
    const b = bytes[i]!;
    let tmp = CRC_TABLE[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[b & 0xf]!;
    tmp = CRC_TABLE[crc & 0xf]!;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf]!;
  }
  return crc;
}

export function toFitTimestamp(ms: number): number {
  return Math.round((ms - FIT_EPOCH_MS) / 1000);
}

class FitWriter {
  private chunks: number[] = [];
  private localTypes = new Map<DefName, number>();

  private bytes(...b: number[]): void {
    for (const x of b) this.chunks.push(x & 0xff);
  }

  private value(type: BaseType, v: number | undefined): void {
    const raw = v === undefined || !Number.isFinite(v) ? INVALID[type] : v;
    const size = SIZE[type];
    let x = type === BaseType.SInt16 && raw < 0 ? raw + 0x10000 : raw;
    for (let i = 0; i < size; i++) {
      this.chunks.push(x & 0xff);
      x = Math.floor(x / 256);
    }
  }

  /** Writes a definition message the first time a message type is used. */
  private ensureDefinition(name: DefName): number {
    let local = this.localTypes.get(name);
    if (local !== undefined) return local;
    local = this.localTypes.size;
    this.localTypes.set(name, local);
    const def = DEFS[name];
    this.bytes(0x40 | local, 0, 0, def.global & 0xff, def.global >> 8, def.fields.length);
    for (const [num, type] of def.fields) this.bytes(num, SIZE[type], type);
    return local;
  }

  write(name: DefName, values: Record<number, number | undefined>): void {
    const local = this.ensureDefinition(name);
    this.bytes(local);
    for (const [num, type] of DEFS[name].fields as FieldDef[]) this.value(type, values[num]);
  }

  finish(): Uint8Array {
    const data = Uint8Array.from(this.chunks);
    const header = new Uint8Array(14);
    const hv = new DataView(header.buffer);
    hv.setUint8(0, 14);
    hv.setUint8(1, 0x20); // protocol 2.0
    hv.setUint16(2, 2132, true); // profile 21.32
    hv.setUint32(4, data.length, true);
    header.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
    hv.setUint16(12, fitCrc(header, 0, 12), true);
    const out = new Uint8Array(14 + data.length + 2);
    out.set(header, 0);
    out.set(data, 14);
    const crc = fitCrc(out, 0, 14 + data.length);
    out[out.length - 2] = crc & 0xff;
    out[out.length - 1] = crc >> 8;
    return out;
  }
}

const u = (v: number | undefined, scale = 1, offset = 0, max = 0xfffe) =>
  v === undefined || !Number.isFinite(v) ? undefined : Math.min(max, Math.max(0, Math.round((v + offset) * scale)));

function lapValues(lap: Omit<LapSummary, 'index'>, index: number, elapsedS?: number): Record<number, number | undefined> {
  return {
    253: toFitTimestamp(lap.endTime),
    254: index,
    0: EVENT.lap,
    1: EVENT_TYPE.stop,
    2: toFitTimestamp(lap.startTime),
    7: u(elapsedS ?? lap.durationS, 1000, 0, 0xfffffffe),
    8: u(lap.durationS, 1000, 0, 0xfffffffe),
    9: u(lap.distanceM, 100, 0, 0xfffffffe),
    13: u(lap.avgSpeedMps, 1000),
    14: u(lap.maxSpeedMps, 1000),
    15: u(lap.avgHeartRate, 1, 0, 0xfe),
    16: u(lap.maxHeartRate, 1, 0, 0xfe),
    17: u(lap.avgCadence, 1, 0, 0xfe),
    19: u(lap.avgPower),
    20: u(lap.maxPower),
    21: u(lap.ascentM),
    25: SPORT_CYCLING,
  };
}

export interface FitOptions {
  /** Shown as product id in the file (0 = generic). */
  product?: number;
  serialNumber?: number;
  /** Local time zone offset in minutes (for activity.local_timestamp). Default: host time zone. */
  utcOffsetMinutes?: number;
}

/** Encodes a recorded ride as a FIT activity file. */
export function encodeFitActivity(samples: ActivitySample[], summary: ActivitySummary, options: FitOptions = {}): Uint8Array {
  const w = new FitWriter();
  const start = summary.startTime;
  const end = summary.endTime;

  w.write('fileId', {
    0: FILE_TYPE_ACTIVITY,
    1: MANUFACTURER_DEVELOPMENT,
    2: options.product ?? 0,
    3: options.serialNumber ?? 0x7e10,
    4: toFitTimestamp(start),
  });
  w.write('event', { 253: toFitTimestamp(start), 0: EVENT.timer, 1: EVENT_TYPE.start });

  for (const s of samples) {
    w.write('record', {
      253: toFitTimestamp(s.timestamp),
      5: u(s.distanceM, 100, 0, 0xfffffffe),
      6: u(s.speedMps, 1000),
      2: u(s.elevationM, 5, 500),
      9: Number.isFinite(s.gradePercent) ? Math.max(-32767, Math.min(32766, Math.round(s.gradePercent * 100))) : undefined,
      7: u(s.power),
      4: u(s.cadence, 1, 0, 0xfe),
      3: u(s.heartRate, 1, 0, 0xfe),
    });
  }

  w.write('event', { 253: toFitTimestamp(end), 0: EVENT.timer, 1: EVENT_TYPE.stopAll });

  summary.laps.forEach((lap, i) => w.write('lap', lapValues(lap, i)));

  w.write('session', {
    253: toFitTimestamp(end),
    254: 0,
    0: EVENT.session,
    1: EVENT_TYPE.stop,
    2: toFitTimestamp(start),
    5: SPORT_CYCLING,
    6: SUB_SPORT_VIRTUAL,
    7: u(summary.elapsedS, 1000, 0, 0xfffffffe),
    8: u(summary.durationS, 1000, 0, 0xfffffffe),
    9: u(summary.distanceM, 100, 0, 0xfffffffe),
    11: u(summary.calories),
    14: u(summary.avgSpeedMps, 1000),
    15: u(summary.maxSpeedMps, 1000),
    16: u(summary.avgHeartRate, 1, 0, 0xfe),
    17: u(summary.maxHeartRate, 1, 0, 0xfe),
    18: u(summary.avgCadence, 1, 0, 0xfe),
    20: u(summary.avgPower),
    21: u(summary.maxPower),
    22: u(summary.ascentM),
    25: 0,
    26: summary.laps.length,
    34: u(summary.normalizedPower),
    35: u(summary.tss, 10),
    36: u(summary.intensityFactor, 1000),
    45: u(summary.ftp),
  });

  const offset = options.utcOffsetMinutes ?? -new Date(end).getTimezoneOffset();
  w.write('activity', {
    253: toFitTimestamp(end),
    0: u(summary.durationS, 1000, 0, 0xfffffffe),
    1: 1,
    2: 0, // manual
    3: EVENT.activity,
    4: EVENT_TYPE.stop,
    5: toFitTimestamp(end) + offset * 60,
  });

  return w.finish();
}
