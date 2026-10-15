import { toHex } from '../bytes';
import { CrankCadenceCalculator } from '../crankCadence';
import { parseCscMeasurement } from '../parsers/csc';
import { parseCyclingPowerMeasurement } from '../parsers/cyclingPower';
import { parseHeartRateMeasurement } from '../parsers/heartRate';
import { CHAR, SERVICE } from '../uuids';
import type { BleService } from '../transport/types';
import { ManagedDevice, errorMessage } from './managedDevice';
import type { CadenceData, HeartRateData } from './types';

/** Any heart rate strap or watch broadcasting the standard Heart Rate service. */
export class HeartRateMonitor extends ManagedDevice<HeartRateData> {
  protected override async setup(services: Map<string, BleService>): Promise<void> {
    const hr = services.get(SERVICE.heartRate);
    const char = hr && (await hr.getCharacteristic(CHAR.heartRateMeasurement));
    if (!char) throw new Error('Gerät hat keinen Heart-Rate-Service');
    this.track(
      await char.startNotifications((v) => {
        try {
          const m = parseHeartRateMeasurement(v);
          if (m.heartRate > 0) this.emit('data', { timestamp: Date.now(), heartRate: m.heartRate, rrIntervalsMs: m.rrIntervalsMs });
        } catch (err) {
          this.log('warn', `${this.name}: HR-Paket fehlerhaft (${toHex(v)}): ${errorMessage(err)}`);
        }
      }),
    );
  }
}

/**
 * Dedicated cadence source: a CSC sensor (e.g. Wahoo RPM) or the crank data of
 * a power meter. Useful because the KICKR Core v1 only estimates cadence.
 */
export class CadenceSensor extends ManagedDevice<CadenceData> {
  private readonly calc = new CrankCadenceCalculator();
  private decayTimer?: ReturnType<typeof setInterval>;

  protected override resetConnectionState(): void {
    this.calc.reset();
  }

  protected override async setup(services: Map<string, BleService>): Promise<void> {
    const csc = services.get(SERVICE.cyclingSpeedCadence);
    const cscChar = csc && (await csc.getCharacteristic(CHAR.cscMeasurement));
    if (cscChar) {
      this.track(
        await cscChar.startNotifications((v) => {
          try {
            const m = parseCscMeasurement(v);
            if (m.crank) this.push(this.calc.update(m.crank.revolutions, m.crank.eventTime, Date.now()));
          } catch (err) {
            this.log('warn', `${this.name}: CSC-Paket fehlerhaft (${toHex(v)}): ${errorMessage(err)}`);
          }
        }),
      );
    } else {
      const cps = services.get(SERVICE.cyclingPower);
      const cpsChar = cps && (await cps.getCharacteristic(CHAR.cyclingPowerMeasurement));
      if (!cpsChar) throw new Error('Gerät liefert keine Kadenz (weder CSC noch Cycling Power)');
      this.track(
        await cpsChar.startNotifications((v) => {
          try {
            const m = parseCyclingPowerMeasurement(v);
            if (m.crank) this.push(this.calc.update(m.crank.revolutions, m.crank.eventTime, Date.now()));
          } catch (err) {
            this.log('warn', `${this.name}: CPS-Paket fehlerhaft (${toHex(v)}): ${errorMessage(err)}`);
          }
        }),
      );
    }
    clearInterval(this.decayTimer);
    // Sensors stop sending when the crank stops: make cadence fall to 0.
    this.decayTimer = setInterval(() => {
      const before = this.calc.value;
      const now = this.calc.tick(Date.now());
      if (before !== now) this.push(now);
    }, 1000);
    this.track(async () => clearInterval(this.decayTimer));
  }

  private push(cadence: number): void {
    this.emit('data', { timestamp: Date.now(), cadence });
  }
}
