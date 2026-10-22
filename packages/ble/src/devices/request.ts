import { SERVICE } from '../uuids';
import type { BleTransport } from '../transport/types';
import { HeartRateMonitor, CadenceSensor } from './sensors';
import { SmartTrainer, type SmartTrainerOptions } from './smartTrainer';
import type { ManagedDeviceOptions } from './managedDevice';

/** Opens the chooser for smart trainers (FTMS or Cycling Power, plus anything named KICKR/Wahoo). */
export async function requestTrainer(transport: BleTransport, options: SmartTrainerOptions = {}): Promise<SmartTrainer> {
  const device = await transport.requestDevice({
    services: [SERVICE.fitnessMachine, SERVICE.cyclingPower],
    namePrefixes: ['KICKR', 'Wahoo'],
    optionalServices: [SERVICE.deviceInformation, SERVICE.fitnessMachine, SERVICE.cyclingPower, SERVICE.cyclingSpeedCadence],
  });
  const trainer = new SmartTrainer(device, options);
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

export async function requestHeartRateMonitor(transport: BleTransport, options: ManagedDeviceOptions = {}): Promise<HeartRateMonitor> {
  const device = await transport.requestDevice({
    services: [SERVICE.heartRate],
    namePrefixes: HEART_RATE_NAME_PREFIXES,
    optionalServices: [SERVICE.deviceInformation],
  });
  const hrm = new HeartRateMonitor(device, options);
  await hrm.start();
  return hrm;
}

export async function requestCadenceSensor(transport: BleTransport, options: ManagedDeviceOptions = {}): Promise<CadenceSensor> {
  const device = await transport.requestDevice({
    services: [SERVICE.cyclingSpeedCadence, SERVICE.cyclingPower],
    optionalServices: [SERVICE.deviceInformation],
  });
  const sensor = new CadenceSensor(device, options);
  await sensor.start();
  return sensor;
}
