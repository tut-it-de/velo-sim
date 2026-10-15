import { describe, expect, it } from 'vitest';
import {
  SimulatedTransport,
  SmartTrainer,
  TrainerCommandError,
  flush,
  requestHeartRateMonitor,
  requestTrainer,
  toHex,
  type ConnectionState,
  type TrainerData,
} from './helpers';

const setup = async (profile: 'ftms' | 'wahoo-legacy' = 'ftms', opts: ConstructorParameters<typeof SmartTrainer>[1] = {}) => {
  const transport = new SimulatedTransport({ profile, autoTick: false, noise: false });
  const logs: string[] = [];
  const trainer = await requestTrainer(transport, { reconnectDelayMs: 5, log: (_l, m) => logs.push(m), ...opts });
  const device = transport.trainer!;
  return { transport, trainer, device, logs };
};

describe('SmartTrainer over FTMS', () => {
  it('detects FTMS, reads device info and takes control', async () => {
    const { trainer, device } = await setup();
    expect(trainer.protocol).toBe('ftms');
    expect(trainer.capabilities.erg).toBe(true);
    expect(trainer.capabilities.sim).toBe(true);
    expect(trainer.info.manufacturer).toBe('velo-sim');
    expect(device.controlGranted).toBe(true);
    expect(toHex(device.writes[0]!)).toBe('00');
    expect(trainer.state).toBe('connected');
  });

  it('sets ERG power', async () => {
    const { trainer, device } = await setup();
    await trainer.setErgPower(215);
    expect(device.mode).toBe('erg');
    expect(device.targetPower).toBe(215);
  });

  it('sets the simulated grade', async () => {
    const { trainer, device } = await setup();
    await trainer.setSimulation({ gradePercent: 6.5 });
    expect(device.mode).toBe('sim');
    expect(device.gradePercent).toBeCloseTo(6.5);
  });

  it('emits merged metrics: power/cadence/speed from Indoor Bike Data', async () => {
    const { trainer, device } = await setup();
    const samples: TrainerData[] = [];
    trainer.on('data', (d) => samples.push(d));
    await trainer.setErgPower(200);
    for (let i = 0; i < 40; i++) device.tick(250);
    const last = samples.at(-1)!;
    expect(last.power).toBeGreaterThan(190);
    expect(last.power).toBeLessThanOrEqual(200);
    expect(last.cadence).toBe(88);
    expect(last.speedKmh).toBeGreaterThan(30);
    expect(trainer.capabilities.cadence).toBe(true);
  });

  it('re-requests control once when the trainer answers "Control Not Permitted"', async () => {
    const { trainer, device } = await setup();
    device.revokeControl();
    await trainer.setErgPower(180);
    expect(device.targetPower).toBe(180);
    const ops = device.writes.map((w) => w[0]);
    // …, 0x05 (rejected), 0x00 (request control), 0x05 (accepted)
    expect(ops.slice(-3)).toEqual([0x05, 0x00, 0x05]);
  });

  it('reconnects after a link loss and restores the last target', async () => {
    const { trainer, device } = await setup();
    const states: ConnectionState[] = [];
    trainer.on('connection', (s) => states.push(s));
    await trainer.setErgPower(250);
    device.simulateLinkLoss();
    expect(device.mode).toBe('erg');
    device.mode = 'idle'; // a real trainer forgets its target on power loss
    device.targetPower = 0;
    await flush(50);
    expect(states).toEqual(['reconnecting', 'connected']);
    expect(device.controlGranted).toBe(true);
    expect(device.mode).toBe('erg');
    expect(device.targetPower).toBe(250);
  });

  it('does not reconnect after a manual disconnect', async () => {
    const { trainer, device } = await setup();
    await trainer.disconnect();
    await flush(30);
    expect(device.connected).toBe(false);
    expect(trainer.state).toBe('disconnected');
  });

  it('rejects commands while disconnected but remembers them for the reconnect', async () => {
    const { trainer, device } = await setup('ftms', { maxReconnectAttempts: 0 });
    device.simulateLinkLoss();
    await flush(10);
    await expect(trainer.setErgPower(100)).rejects.toBeInstanceOf(TrainerCommandError);
    expect(trainer.targetDescription).toBe('ERG 100 W');
  });
});

describe('SmartTrainer over the Wahoo legacy protocol', () => {
  it('falls back to Wahoo control when FTMS is missing', async () => {
    const { trainer, device } = await setup('wahoo-legacy');
    expect(trainer.protocol).toBe('wahoo');
    expect(device.unlocked).toBe(true);
    await trainer.setErgPower(190);
    expect(device.mode).toBe('erg');
    expect(device.targetPower).toBe(190);
  });

  it('sends sim mode once, then only grade updates', async () => {
    const { trainer, device } = await setup('wahoo-legacy');
    await trainer.setSimulation({ gradePercent: 4, totalWeightKg: 85 });
    await trainer.setSimulation({ gradePercent: 5, totalWeightKg: 85 });
    const ops = device.writes.map((w) => w[0]);
    expect(ops).toEqual([0x20, 0x43, 0x46, 0x46]);
    expect(device.simWeightKg).toBe(85);
    expect(device.gradePercent).toBeCloseTo(5, 1);
  });

  it('derives cadence from Cycling Power crank revolutions', async () => {
    const { trainer, device } = await setup('wahoo-legacy');
    const samples: TrainerData[] = [];
    trainer.on('data', (d) => samples.push(d));
    device.setRider({ power: 200, cadence: 90 });
    const t0 = Date.now();
    // Tick with real time passing so event times and receive times line up.
    for (let i = 0; i < 12; i++) {
      device.tick(250);
      await flush(0);
    }
    expect(Date.now() - t0).toBeGreaterThanOrEqual(0);
    const withCadence = samples.filter((s) => (s.cadence ?? 0) > 0);
    expect(withCadence.length).toBeGreaterThan(0);
    expect(withCadence.at(-1)!.cadence).toBeGreaterThan(80);
    expect(withCadence.at(-1)!.cadence).toBeLessThan(100);
  });
});

describe('simulated heart rate monitor', () => {
  it('connects through the same request helper', async () => {
    const transport = new SimulatedTransport({ autoTick: false, noise: false });
    const hrm = await requestHeartRateMonitor(transport);
    const values: number[] = [];
    hrm.on('data', (d) => values.push(d.heartRate));
    transport.heartRateMonitor!.tick(1000);
    expect(values).toEqual([70]);
  });
});
