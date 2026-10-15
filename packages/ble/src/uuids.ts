/** Expands a 16-bit Bluetooth SIG UUID to the full 128-bit lowercase form. */
export function uuid16(short: number): string {
  return `0000${short.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}

/** Normalises any UUID notation (16-bit hex, number, 128-bit, any case) to 128-bit lowercase. */
export function normalizeUuid(uuid: string | number): string {
  if (typeof uuid === 'number') return uuid16(uuid);
  const u = uuid.toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{4}$/.test(u)) return uuid16(parseInt(u, 16));
  if (/^[0-9a-f]{8}$/.test(u)) return `${u}-0000-1000-8000-00805f9b34fb`;
  return u;
}

export const SERVICE = {
  deviceInformation: uuid16(0x180a),
  heartRate: uuid16(0x180d),
  cyclingSpeedCadence: uuid16(0x1816),
  cyclingPower: uuid16(0x1818),
  fitnessMachine: uuid16(0x1826),
} as const;

export const CHAR = {
  // Device Information
  manufacturerName: uuid16(0x2a29),
  modelNumber: uuid16(0x2a24),
  serialNumber: uuid16(0x2a25),
  firmwareRevision: uuid16(0x2a26),
  hardwareRevision: uuid16(0x2a27),
  // Heart Rate
  heartRateMeasurement: uuid16(0x2a37),
  // Cycling Speed and Cadence
  cscMeasurement: uuid16(0x2a5b),
  // Cycling Power
  cyclingPowerMeasurement: uuid16(0x2a63),
  cyclingPowerFeature: uuid16(0x2a65),
  // Fitness Machine
  fitnessMachineFeature: uuid16(0x2acc),
  indoorBikeData: uuid16(0x2ad2),
  trainingStatus: uuid16(0x2ad3),
  supportedPowerRange: uuid16(0x2ad8),
  fitnessMachineControlPoint: uuid16(0x2ad9),
  fitnessMachineStatus: uuid16(0x2ada),
  /**
   * Wahoo's proprietary trainer control characteristic. It lives inside the
   * Cycling Power service of KICKR trainers and predates FTMS support.
   */
  wahooTrainerControl: 'a026e005-0a7d-4ab3-97fa-f1500f9feb8b',
} as const;

const NAMES: Record<string, string> = {
  [SERVICE.deviceInformation]: 'Device Information',
  [SERVICE.heartRate]: 'Heart Rate',
  [SERVICE.cyclingSpeedCadence]: 'Cycling Speed and Cadence',
  [SERVICE.cyclingPower]: 'Cycling Power',
  [SERVICE.fitnessMachine]: 'Fitness Machine (FTMS)',
  [CHAR.manufacturerName]: 'Manufacturer Name',
  [CHAR.modelNumber]: 'Model Number',
  [CHAR.serialNumber]: 'Serial Number',
  [CHAR.firmwareRevision]: 'Firmware Revision',
  [CHAR.hardwareRevision]: 'Hardware Revision',
  [CHAR.heartRateMeasurement]: 'Heart Rate Measurement',
  [CHAR.cscMeasurement]: 'CSC Measurement',
  [CHAR.cyclingPowerMeasurement]: 'Cycling Power Measurement',
  [CHAR.cyclingPowerFeature]: 'Cycling Power Feature',
  [CHAR.fitnessMachineFeature]: 'Fitness Machine Feature',
  [CHAR.indoorBikeData]: 'Indoor Bike Data',
  [CHAR.trainingStatus]: 'Training Status',
  [CHAR.supportedPowerRange]: 'Supported Power Range',
  [CHAR.fitnessMachineControlPoint]: 'Fitness Machine Control Point',
  [CHAR.fitnessMachineStatus]: 'Fitness Machine Status',
  [CHAR.wahooTrainerControl]: 'Wahoo Trainer Control',
};

/** Human readable name for diagnostics output. */
export function describeUuid(uuid: string): string {
  const n = normalizeUuid(uuid);
  const name = NAMES[n];
  const short = n.endsWith('-0000-1000-8000-00805f9b34fb') ? `0x${n.slice(4, 8)}` : n;
  return name ? `${name} (${short})` : short;
}
