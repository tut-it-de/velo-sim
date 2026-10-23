import { SERVICE } from '../uuids';
import type { BleDevice, BleTransport, DeviceRequest } from '../transport/types';
import { HeartRateMonitor, CadenceSensor } from './sensors';
import { ZWIFT_SHIFTER_REQUEST, ZwiftShifter } from './zwiftShifter';
import { SmartTrainer, type SmartTrainerOptions } from './smartTrainer';
import type { ManagedDeviceOptions } from './managedDevice';

/** Opens the chooser for smart trainers (FTMS or Cycling Power, plus anything named KICKR/Wahoo). */
export const TRAINER_REQUEST: DeviceRequest = {
  services: [SERVICE.fitnessMachine, SERVICE.cyclingPower],
  namePrefixes: ['KICKR', 'Wahoo'],
  optionalServices: [SERVICE.deviceInformation, SERVICE.fitnessMachine, SERVICE.cyclingPower, SERVICE.cyclingSpeedCadence],
};

export async function requestTrainer(transport: BleTransport, options: SmartTrainerOptions = {}, found?: BleDevice): Promise<SmartTrainer> {
  const trainer = new SmartTrainer(found ?? (await transport.requestDevice(TRAINER_REQUEST)), options);
  await trainer.start();
  return trainer;
}

/**
 * Name prefixes of common heart-rate straps and watches. Some of them leave the heart-rate service out of their
 * advertisement (it only shows after connecting), so the service filter alone does not list them.
 */
export const HEART_RATE_NAME_PREFIXES = [
  'Polar', 'TICKR', 'Wahoo', 'HRM', 'Garmin', 'Forerunner', 'fenix', 'COOSPO', 'CooSpo', 'Coospo', 'Magene', 'MAGENE',
  'XOSS', 'iGPSPORT', 'Decathlon', 'Kalenji', 'Suunto', 'Movesense', 'Scosche', 'RHYTHM', 'Whoop', 'WHOOP', 'Amazfit', 'Zepp',
  'Sigma', 'SIGMA', 'Bryton', 'Geonaute', 'H10', 'H9', 'Verity', 'OH1', 'Heart', 'HR',
];

export const HEART_RATE_REQUEST: DeviceRequest = {
  services: [SERVICE.heartRate],
  namePrefixes: HEART_RATE_NAME_PREFIXES,
  optionalServices: [SERVICE.deviceInformation],
};

export async function requestHeartRateMonitor(transport: BleTransport, options: ManagedDeviceOptions = {}, found?: BleDevice): Promise<HeartRateMonitor> {
  const hrm = new HeartRateMonitor(found ?? (await transport.requestDevice(HEART_RATE_REQUEST)), options);
  await hrm.start();
  return hrm;
}

/** Cadence sensors (Speed & Cadence) and power meters such as pedals or crank arms. */
export const CADENCE_REQUEST: DeviceRequest = {
  services: [SERVICE.cyclingSpeedCadence, SERVICE.cyclingPower],
  optionalServices: [SERVICE.deviceInformation],
};

export async function requestCadenceSensor(transport: BleTransport, options: ManagedDeviceOptions = {}, found?: BleDevice): Promise<CadenceSensor> {
  const sensor = new CadenceSensor(found ?? (await transport.requestDevice(CADENCE_REQUEST)), options);
  await sensor.start();
  return sensor;
}

/** Zwift Click, Play or Ride as a virtual shifter. */
export async function requestZwiftShifter(transport: BleTransport, options: ManagedDeviceOptions = {}, found?: BleDevice): Promise<ZwiftShifter> {
  const shifter = new ZwiftShifter(found ?? (await transport.requestDevice(ZWIFT_SHIFTER_REQUEST)), options);
  await shifter.start();
  return shifter;
}
