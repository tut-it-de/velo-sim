import { STARTER_LOADOUT, rideEarnings, setupFor, total, type EarningLine, type Loadout } from '@velo/equipment';
import { ActivityRecorder, normalizedPower, type ActivitySample, type ActivitySummary } from '@velo/metrics';
import {
  draftReduction,
  step,
  totalMass,
  windResistanceCoefficient,
  type RiderSetup,
  type RiderState,
} from '@velo/physics';
import { SegmentTracker, getTrack, type ActiveSegment, type RouteSegment, type Track } from '@velo/routes';
import { WorkoutPlayer, evaluateTest, type PlayerState, type TestResult, type Workout, type WorkoutCategory } from '@velo/workouts';
import { deviceManager } from '../devices/deviceManager';
import type { MultiplayerClient } from '../net/multiplayer';
import type { RideSummaryDTO } from '@velo/protocol';
import type { RiderLook } from '../game/rider';
import type { RiderFrame } from '../game/world';
import { botPosition, planBots, type BotPlan } from './bots';
import type { RideAssist } from './groupAssist';
import { LiveStats } from './liveStats';
import { WattLock, wattLockAllowed, type WattLockReleaseReason } from './wattLock';
import { getBest, submitResult } from '../state/records';
import { settingsStore, type Settings } from '../state/settings';
import { referenceFtp } from '../ftp/advisor';
import { Store } from '../state/store';

export type RideState = 'riding' | 'paused' | 'finished';

export interface BotInfo {
  id: string;
  name: string;
  country?: string;
  wkg: number;
  look: RiderLook;
}

export interface RideSnapshot {
  state: RideState;
  /** Moving time in seconds (auto-pause when standing still). */
  movingS: number;
  distanceM: number;
  lapDistanceM: number;
  /** 1-based lap currently ridden. */
  lap: number;
  lapTimesS: number[];
  speedMps: number;
  power: number;
  power3s: number;
  cadence: number;
  heartRate?: number;
  gradePercent: number;
  elevationM: number;
  ascentM: number;
  avgPower: number;
  normalizedPower: number;
  kilojoules: number;
  draft: number;
  /** Grade last sent to the trainer (after difficulty scaling and the virtual gear). */
  trainerGrade?: number;
  /** Virtual gear, 1 (easiest) … GEARS.length. */
  gear: number;
  noTrainerData: boolean;
  /** Pacer bots and other online riders, with the gap to me along the loop (+ = ahead). */
  others: Array<{ id: string; name: string; country?: string; wkg?: number; gapM: number; speedMps: number; remote: boolean; power?: number }>;
  workout?: PlayerState & { name: string };
  activeSegments: Array<ActiveSegment & { bestS?: number }>;
  lastResult?: SegmentOutcome;
  /** Watt-Taler earned so far (0 with the simulator). */
  coins: number;
  coinsDisabled: boolean;
  /** The rider was moved with the admin teleport: no Taler, no best times. */
  teleported: boolean;
  /** Paused because the rider stopped pedalling; pedalling again resumes. */
  autoPaused: boolean;
  /** Ramp test: the rider could no longer keep pedalling – the ride ends with the result. */
  testAborted: boolean;
  /** Average of the last 10 recorded seconds. */
  power10s: number;
  /** Average power of the current lap (route lap, in a workout the current block) and its length in s. */
  lapPower: number;
  lapPowerS: number;
  /** Watts held by the Watt-Lock (free ride, ERG), undefined when off. */
  wattLock?: number;
  /** Watt-Lock can be switched on right now (free ride, ERG trainer, riding). */
  canWattLock: boolean;
}

export interface SegmentOutcome {
  /** 'lap' for a full lap, otherwise the route segment. */
  segment: RouteSegment | { id: 'lap'; name: string; type: 'lap' };
  timeS: number;
  previousBestS?: number;
  isPb: boolean;
  saved: boolean;
  /** ms timestamp, used by the HUD to show the result for a few seconds */
  at: number;
}

export interface RideResult {
  routeId: string;
  routeName: string;
  summary: ActivitySummary;
  samples: ActivitySample[];
  workout?: { id: string; name: string; category?: WorkoutCategory; compliance: number; completed: boolean; test?: TestResult };
  segments: SegmentOutcome[];
  earnings: EarningLine[];
  simulated: boolean;
  lapsCompleted: number;
  /** Booking by the game server (online rides while logged in). */
  server?: RideSummaryDTO;
}

const TICK_MS = 100;
/** Seconds without pedalling before a ride pauses itself. */
const AUTO_PAUSE_S = 3;

/**
 * Virtual shifting (as in Zwift): 24 gear ratios from 0.75 to 5.0. The trainer feels the gear as an
 * offset on the grade – a heavier gear means more resistance at the same cadence, so the same
 * cadence takes more watts and the rider goes faster. No effect in ERG mode.
 */
export const GEARS = Array.from({ length: 24 }, (_, i) => 0.75 * (5 / 0.75) ** (i / 23));
/** The gear that matches the plain route grade (ratio ≈ 2.3, like 50×22). */
export const NEUTRAL_GEAR = GEARS.reduce((best, r, i) => (Math.abs(Math.log(r / 2.3)) < Math.abs(Math.log(GEARS[best - 1]! / 2.3)) ? i + 1 : best), 1);
/** Grade offset in % for a gear: about −7 % in the easiest, +4.7 % in the heaviest. */
export const gearGradeOffset = (gear: number) => 6 * Math.log(GEARS[gear - 1]! / GEARS[NEUTRAL_GEAR - 1]!);
const BIKE_LENGTH = 1.8;
const RIDER_LATERAL = 1.4;

export interface RideOptions {
  bots?: boolean;
  workout?: Workout;
  loadout?: Loadout;
  /** Route ids on which the first-lap bonus has already been paid. */
  routesWithLap?: string[];
  /** Online room connection (multiplayer). */
  net?: MultiplayerClient;
  /** Group ride "stay together": changes speed/position only, never the power. */
  assist?: RideAssist;
}

/** Shortest signed distance between two lap positions on a loop. */
export function wrapGap(gap: number, length: number): number {
  const g = ((gap % length) + length) % length;
  return g > length / 2 ? g - length : g;
}

function lateralFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return 0.4 + (h % 100) / 100 * 2.6;
}

interface Bot extends BotInfo {
  plan: BotPlan;
  state: RiderState;
  renderDistance: number;
  lateral: number;
  power: number;
  cadence: number;
}

/**
 * Free ride on a route: integrates physics at 10 Hz from live trainer power,
 * sends the (difficulty-scaled) grade to the trainer, records 1 Hz samples and
 * simulates pacer bots you can draft behind.
 */
export class RideSession {
  readonly track: Track;
  readonly snapshot: Store<RideSnapshot>;
  readonly bots: Bot[] = [];
  private readonly setup: RiderSetup;
  private readonly recorder: ActivityRecorder;
  private state: RiderState = { speedMps: 0, distanceM: 0 };
  private renderDistance = 0;
  private timer?: ReturnType<typeof setInterval>;
  private lastTick = 0;
  private movingMs = 0;
  private idleS = 0;
  private autoPaused = false;
  private secondAcc = { ms: 0, power: 0, cadence: 0, cadenceN: 0, hr: 0, hrN: 0 };
  private lapStartMovingS = 0;
  private lapTimes: number[] = [];
  private lastTrainerUpdate = 0;
  private lastTrainerGrade?: number;
  private ascent = 0;
  private lastElevation: number;
  private draft = 0;
  private runState: RideState = 'riding';
  private powerSum = 0;
  private np = 0;
  private lastErgTarget?: number;
  private lastErgSent = 0;
  private gear = NEUTRAL_GEAR;
  private readonly live = new LiveStats();
  readonly wattLock = new WattLock();
  /** Actual power per recorded second against workout time, for the chart overlay. */
  readonly workoutTrace: Array<[number, number]> = [];
  readonly player?: WorkoutPlayer;
  private segmentTracker: SegmentTracker;
  private teleported = false;
  /** Metres skipped with the teleport: the recording and the summary count only the distance actually ridden. */
  private skippedM = 0;
  readonly segmentResults: SegmentOutcome[] = [];
  private lastResult?: SegmentOutcome;
  private workoutKj = 0;
  private readonly firstLapOnRoute: boolean;
  readonly net?: MultiplayerClient;
  private readonly assist?: RideAssist;
  /** Laps already behind a late group rider at the start (not ridden). */
  private lapOffset = 0;

  constructor(
    readonly routeId: string,
    private readonly settings: Settings,
    options: RideOptions = {},
  ) {
    this.track = getTrack(routeId);
    this.setup = setupFor(settings, options.loadout ?? STARTER_LOADOUT);
    this.firstLapOnRoute = !(options.routesWithLap ?? []).includes(routeId);
    this.net = options.net;
    this.assist = options.assist;
    this.recorder = new ActivityRecorder(settings.ftp);
    this.lastElevation = this.track.sample(0).y;
    if (options.workout) this.player = new WorkoutPlayer(options.workout, referenceFtp(settings));
    this.segmentTracker = new SegmentTracker(this.track.segments, this.track.length);
    if (options.bots) {
      for (const plan of planBots(this.track, this.setup)) {
        this.bots.push({ ...plan, plan, state: { speedMps: 0, distanceM: 0 }, renderDistance: 0, power: plan.wkg * 75 });
      }
      this.stepBots();
      for (const b of this.bots) b.renderDistance = b.state.distanceM;
    }
    this.snapshot = new Store<RideSnapshot>(this.buildSnapshot(0, 0, 0, undefined, false));
  }

  /** 'free' = SIM mode (grade to trainer); 'erg' = the workout holds a target power. */
  get mode(): 'free' | 'erg' {
    const w = this.player?.state;
    return w && !w.finished && w.mode === 'erg' ? 'erg' : 'free';
  }

  skipSegment(): void {
    this.player?.skip();
    this.lastErgTarget = undefined;
  }

  /** Virtual shifting: +1 heavier, −1 easier. The trainer gets the new resistance at once. With Watt-Lock on, ±5 W instead. */
  shift(delta: number): void {
    if (this.wattLock.active) {
      this.adjustWattLock(delta);
      return;
    }
    const next = Math.min(GEARS.length, Math.max(1, this.gear + delta));
    if (next === this.gear) return;
    this.gear = next;
    this.lastTrainerUpdate = 0;
    this.lastTrainerGrade = undefined;
    this.snapshot.set({ ...this.snapshot.get(), gear: next });
  }

  /** Free ride with an ERG trainer: Watt-Lock may be switched on. */
  get canWattLock(): boolean {
    const p = this.player;
    return wattLockAllowed({ riding: this.runState === 'riding', canErg: deviceManager.canErg, workoutActive: !!p && !p.state.finished });
  }

  /** Watt-Lock on (at the current 3-s power, rounded to 5 W) or off. */
  toggleWattLock(): void {
    if (this.wattLock.active) {
      this.releaseWattLock('toggle');
      return;
    }
    if (!this.canWattLock) return;
    this.wattLock.engage(deviceManager.metrics.get().power3s);
    this.lastErgTarget = undefined;
    this.updateErg(performance.now(), this.wattLock.watts);
    this.snapshot.set({ ...this.snapshot.get(), wattLock: this.wattLock.watts });
  }

  /** Locked watts ± steps × 5 W. */
  adjustWattLock(steps: number): void {
    if (this.wattLock.adjust(steps) === undefined) return;
    this.snapshot.set({ ...this.snapshot.get(), wattLock: this.wattLock.watts });
  }

  /** Watt-Lock off: the trainer goes back to SIM (grade + gear) at once. */
  private releaseWattLock(reason: WattLockReleaseReason): void {
    if (!this.wattLock.release(reason)) return;
    this.lastErgTarget = undefined;
    this.lastTrainerGrade = undefined;
    this.lastTrainerUpdate = 0;
    this.updateTrainer(this.track.sample(this.state.distanceM).gradePercent, performance.now());
    this.snapshot.set({ ...this.snapshot.get(), wattLock: undefined });
  }

  setIntensity(value: number): void {
    this.player?.setIntensity(value);
  }

  get riderLateral(): number {
    return RIDER_LATERAL;
  }

  get riderSetup(): RiderSetup {
    return this.setup;
  }

  /** Simulator rides and teleported rides earn no Taler and set no best times. */
  private get noCredit(): boolean {
    return this.settings.useSimulator || this.teleported;
  }

  /** Teleport is not offered online: the server books from the riders' positions. */
  get canTeleport(): boolean {
    return !this.net;
  }

  /**
   * Admin teleport: puts the rider at `lapDistanceM` of the current lap (bots move along by the same
   * distance). Running segments are dropped, the ride counts as simulated from here on.
   */
  teleport(lapDistanceM: number): void {
    if (!this.canTeleport || this.runState === 'finished') return;
    const lapBase = Math.floor(this.state.distanceM / this.track.length) * this.track.length;
    const target = lapBase + Math.min(Math.max(0, lapDistanceM), this.track.length - 1);
    const delta = target - this.state.distanceM;
    this.teleported = true;
    this.skippedM += delta;
    this.state = { ...this.state, distanceM: target };
    this.renderDistance = target;
    this.stepBots();
    for (const b of this.bots) b.renderDistance = b.state.distanceM;
    this.lastElevation = this.track.sample(target).y;
    this.segmentTracker = new SegmentTracker(this.track.segments, this.track.length, target, this.movingMs / 1000);
    this.lastTrainerGrade = undefined;
    const m = deviceManager.metrics.get();
    this.snapshot.set(this.buildSnapshot(m.stale ? 0 : m.power, m.power3s, m.cadence, m.heartRate, m.stale));
  }

  /** Group ride: a late rider starts where the group is – not a teleport, the ride simply starts there. */
  startFrom(distanceM: number): void {
    if (this.movingMs > 0 || distanceM <= 0) return;
    this.state = { speedMps: 0, distanceM };
    this.renderDistance = distanceM;
    this.skippedM = distanceM;
    this.lapOffset = Math.floor(distanceM / this.track.length);
    this.lastElevation = this.track.sample(distanceM).y;
    this.segmentTracker = new SegmentTracker(this.track.segments, this.track.length, distanceM, 0);
  }

  start(): void {
    this.lastTick = performance.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  pause(auto = false): void {
    if (this.runState !== 'riding') return;
    this.releaseWattLock('paused');
    this.runState = 'paused';
    this.autoPaused = auto;
    this.snapshot.set({ ...this.snapshot.get(), state: 'paused', autoPaused: auto });
  }

  resume(): void {
    if (this.runState !== 'paused') return;
    this.runState = 'riding';
    this.autoPaused = false;
    this.idleS = 0;
    this.lastTick = performance.now();
  }

  /** Auto-pause is on in the settings – except during the ramp steps, where stopping ends the test. */
  private get autoPauseAllowed(): boolean {
    const p = this.player;
    return settingsStore.get().autoPause && !(p && p.workout.test === 'ramp' && !p.state.finished);
  }

  finish(): RideResult {
    clearInterval(this.timer);
    this.releaseWattLock('finished');
    this.runState = 'finished';
    this.snapshot.set({ ...this.snapshot.get(), state: 'finished' });
    const summary = this.recorder.summary();
    const p = this.player;
    return {
      routeId: this.routeId,
      routeName: this.track.name,
      summary,
      samples: this.recorder.samples,
      segments: [...this.segmentResults],
      earnings: this.earningLines(),
      simulated: this.noCredit,
      lapsCompleted: this.lapTimes.length,
      workout: p && {
        id: p.workout.id,
        name: p.workout.name,
        category: p.workout.category,
        compliance: p.state.compliance,
        completed: p.state.finished,
        test: evaluateTest(p.workout, p.testProgress, summary.best1min),
      },
    };
  }

  dispose(): void {
    clearInterval(this.timer);
    this.releaseWattLock('finished');
  }

  private tick(): void {
    if (this.runState === 'paused' && this.autoPaused) {
      const live = deviceManager.metrics.get();
      if (live.stale || (live.power <= 0 && live.cadence <= 0)) return;
      this.resume();
    }
    const now = performance.now();
    const dt = Math.min(0.5, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (this.runState !== 'riding') return;

    const m = deviceManager.metrics.get();
    const power = m.stale ? 0 : m.power;
    const cadence = m.cadence;
    // Auto-pause a few seconds after the pedals stop (only once the ride has really started).
    this.idleS = power > 0 || cadence > 0 ? 0 : this.idleS + dt;
    // Watt-Lock ends when the pedals stop (also with auto-pause off) or ERG is no longer possible.
    if (this.wattLock.active && (this.idleS >= AUTO_PAUSE_S || !this.canWattLock)) {
      this.releaseWattLock(this.idleS >= AUTO_PAUSE_S ? 'stopped' : 'unavailable');
    }
    if (this.idleS >= AUTO_PAUSE_S && this.movingMs > 0 && this.autoPauseAllowed) {
      this.pause(true);
      return;
    }
    const sample = this.track.sample(this.state.distanceM);

    // Drafting: nearest rider ahead of me.
    this.draft = draftReduction(this.gapAhead(this.state.distanceM) - BIKE_LENGTH);
    const env = { gradePercent: sample.gradePercent, draftReduction: this.draft };
    if (this.assist) {
      const prev = this.state;
      this.state = this.assist.constrain(prev, step(prev, power, this.setup, this.assist.environment(env, prev, now), dt), dt, now);
    } else {
      this.state = step(this.state, power, this.setup, env, dt);
    }
    this.stepBots();
    this.net?.sendState(this.state.distanceM, this.state.speedMps, power, cadence, RIDER_LATERAL);

    const moving = this.state.speedMps > 0.3 || power > 0;
    if (this.player && moving && !this.player.state.finished) {
      const { state: ws, segmentChanged } = this.player.advance(dt, { power, cadence });
      if (segmentChanged && this.recorder.samples.length > 0) this.recorder.lap();
      if (segmentChanged) this.live.lap();
      if (segmentChanged) this.lastErgTarget = undefined;
      if (ws.finished) this.lastTrainerGrade = undefined; // hand control back to SIM immediately
    }
    if (this.mode === 'erg') this.updateErg(now, this.player?.state.targetWatts);
    else if (this.wattLock.active) this.updateErg(now, this.wattLock.watts);
    else this.updateTrainer(sample.gradePercent, now);

    const elev = this.track.sample(this.state.distanceM).y;
    if (elev > this.lastElevation) this.ascent += elev - this.lastElevation;
    this.lastElevation = elev;

    if (moving) {
      this.movingMs += dt * 1000;
      const acc = this.secondAcc;
      acc.ms += dt * 1000;
      acc.power += power * dt;
      if (cadence > 0) {
        acc.cadence += cadence * dt;
        acc.cadenceN += dt;
      }
      if (m.heartRate) {
        acc.hr += m.heartRate * dt;
        acc.hrN += dt;
      }
      if (acc.ms >= 1000) {
        const s = acc.ms / 1000;
        const cur = this.track.sample(this.state.distanceM);
        const avg = Math.round(acc.power / s);
        this.powerSum += avg;
        this.live.addSecond(avg);
        this.recorder.record({
          timestamp: Date.now(),
          distanceM: this.state.distanceM - this.skippedM,
          speedMps: this.state.speedMps,
          elevationM: cur.y,
          gradePercent: cur.gradePercent,
          power: avg,
          cadence: acc.cadenceN > 0 ? Math.round(acc.cadence / acc.cadenceN) : undefined,
          heartRate: acc.hrN > 0 ? Math.round(acc.hr / acc.hrN) : undefined,
        });
        this.secondAcc = { ms: acc.ms - 1000, power: 0, cadence: 0, cadenceN: 0, hr: 0, hrN: 0 };
        const n = this.recorder.samples.length;
        if (n < 60 || n % 10 === 0) this.np = normalizedPower(this.recorder.samples.map((x) => x.power));
        if (this.player) {
          this.workoutTrace.push([this.player.state.elapsedS, avg]);
          if (!this.player.state.finished) this.workoutKj += avg / 1000;
        }
      }
    }

    for (const r of this.segmentTracker.update(this.state.distanceM, this.movingMs / 1000)) {
      this.addOutcome(r.segment, r.timeS);
    }

    const lap = Math.floor(this.state.distanceM / this.track.length) + 1;
    if (lap > this.lapTimes.length + this.lapOffset + 1) {
      const movingS = this.movingMs / 1000;
      this.lapTimes.push(movingS - this.lapStartMovingS);
      this.addOutcome({ id: 'lap', name: `Runde ${this.lapTimes.length}`, type: 'lap' }, movingS - this.lapStartMovingS);
      this.lapStartMovingS = movingS;
      // In a workout the FIT laps follow the workout blocks instead of the route.
      if (!this.player) {
        this.recorder.lap();
        this.live.lap();
      }
    }

    this.snapshot.set(this.buildSnapshot(power, m.power3s, cadence, m.heartRate, m.stale));
  }

  /** Itemised Watt-Taler for this ride; nothing in the simulator. */
  earningLines(): EarningLine[] {
    if (this.noCredit) return [];
    return rideEarnings({
      kilojoules: this.powerSum / 1000,
      workoutKilojoules: this.workoutKj,
      workoutCompleted: !!this.player?.state.finished,
      // with the group help only the work counts (the server books it the same way)
      lapsCompleted: this.assist ? 0 : this.lapTimes.length,
      firstLapOnRoute: this.firstLapOnRoute,
      personalBests: this.segmentResults.filter((r) => r.saved).length,
    });
  }

  private addOutcome(segment: SegmentOutcome['segment'], timeS: number): void {
    const res = submitResult(this.routeId, segment.id, timeS, this.noCredit || !!this.assist);
    const outcome: SegmentOutcome = { segment, timeS, previousBestS: res.previous?.timeS, isPb: res.isPb, saved: res.saved, at: Date.now() };
    this.segmentResults.push(outcome);
    this.lastResult = outcome;
  }

  private gapAhead(myDistance: number): number {
    let best = Infinity;
    for (const b of this.bots) {
      const gap = b.state.distanceM - myDistance;
      if (gap > 0 && gap < best) best = gap;
    }
    if (this.net) {
      for (const id of this.net.riders.keys()) {
        const pos = this.net.position(id);
        if (!pos) continue;
        const gap = wrapGap(pos.d - myDistance, this.track.length);
        if (gap > 0 && gap < best) best = gap;
      }
    }
    return best;
  }

  /**
   * Bots close enough to draw: up to `max` within `nearM`, keeping those already drawn up to `keepM`
   * (50 full avatars would be too much for a tablet; the quality profile sets `max`).
   */
  botsToDraw(drawn: ReadonlySet<string>, max = 14, nearM = 280, keepM = 380): Set<string> {
    const near = this.bots
      .map((b) => ({ id: b.id, gap: Math.abs(b.state.distanceM - this.state.distanceM) }))
      .filter((b) => b.gap < (drawn.has(b.id) ? keepM : nearM))
      .sort((a, b) => a.gap - b.gap)
      .slice(0, max);
    return new Set(near.map((b) => b.id));
  }

  /** Bots ride on the shared clock (see bots.ts); placed on the lap copy nearest to me. */
  private stepBots(): void {
    const clockS = Date.now() / 1000;
    const len = this.track.length;
    const myLap = ((this.state.distanceM % len) + len) % len;
    for (const b of this.bots) {
      const { lapM, speedMps } = botPosition(b.plan, clockS, len);
      b.state = { speedMps, distanceM: this.state.distanceM + wrapGap(lapM - myLap, len) };
    }
  }

  private updateErg(now: number, target: number | undefined): void {
    if (target === undefined || !deviceManager.canErg) return;
    const changed = this.lastErgTarget === undefined || Math.abs(target - this.lastErgTarget) >= 1;
    // New blocks are sent at once; ramps at most once per second.
    if (!changed || (this.lastErgTarget !== undefined && now - this.lastErgSent < 1000)) return;
    this.lastErgTarget = target;
    this.lastErgSent = now;
    this.lastTrainerGrade = undefined;
    void deviceManager.setErg(target);
  }

  private updateTrainer(gradePercent: number, now: number): void {
    if (!deviceManager.canSim) return;
    this.lastErgTarget = undefined;
    const withGear = gradePercent * this.settings.trainerDifficulty + gearGradeOffset(this.gear);
    const scaled = Math.round(Math.min(20, Math.max(-10, withGear)) * 10) / 10;
    const changed = this.lastTrainerGrade === undefined || Math.abs(scaled - this.lastTrainerGrade) >= 0.2;
    if (now - this.lastTrainerUpdate < 1000 || (!changed && now - this.lastTrainerUpdate < 5000)) return;
    this.lastTrainerUpdate = now;
    this.lastTrainerGrade = scaled;
    void deviceManager.setSim({
      gradePercent: scaled,
      crr: this.setup.crr,
      cwKgPerM: windResistanceCoefficient(this.setup.cda * (1 - this.draft)),
      totalWeightKg: totalMass(this.setup),
    });
  }

  private buildSnapshot(power: number, power3s: number, cadence: number, heartRate: number | undefined, stale: boolean): RideSnapshot {
    const s = this.track.sample(this.state.distanceM);
    const n = this.recorder.samples.length;
    const avgPower = n ? this.powerSum / n : 0;
    return {
      state: this.runState,
      movingS: this.movingMs / 1000,
      distanceM: this.state.distanceM,
      lapDistanceM: s.distanceM,
      lap: Math.floor(this.state.distanceM / this.track.length) + 1,
      lapTimesS: [...this.lapTimes],
      speedMps: this.state.speedMps,
      power,
      power3s,
      cadence,
      heartRate,
      gradePercent: s.gradePercent,
      elevationM: s.y,
      ascentM: this.ascent,
      avgPower,
      normalizedPower: this.np,
      kilojoules: this.powerSum / 1000,
      draft: this.draft,
      trainerGrade: this.lastTrainerGrade,
      gear: this.gear,
      noTrainerData: stale,
      others: [
        ...this.bots.map((b) => ({
          id: b.id,
          name: b.name,
          country: b.country,
          wkg: b.wkg,
          gapM: b.state.distanceM - this.state.distanceM,
          speedMps: b.state.speedMps,
          remote: false,
        })),
        ...[...(this.net?.riders.values() ?? [])].flatMap((r) => {
          const pos = this.net!.position(r.info.id);
          if (!pos) return [];
          const gapM = wrapGap(pos.d - this.state.distanceM, this.track.length);
          return [{ id: r.info.id, name: r.info.name, country: r.info.country, gapM, speedMps: pos.v, remote: true, power: pos.p }];
        }),
      ],
      workout: this.player ? { ...this.player.state, name: this.player.workout.name } : undefined,
      activeSegments: this.segmentTracker
        ? this.segmentTracker.current().map((a) => ({ ...a, bestS: getBest(this.routeId, a.segment.id)?.timeS }))
        : [],
      lastResult: this.lastResult,
      coins: total(this.earningLines()),
      coinsDisabled: this.noCredit,
      teleported: this.teleported,
      autoPaused: this.autoPaused,
      testAborted: !!this.player?.rampAbortedByRider,
      power10s: this.live.power10s,
      lapPower: this.live.lapPower,
      lapPowerS: this.live.lapSeconds,
      wattLock: this.wattLock.watts,
      canWattLock: this.canWattLock,
    };
  }

  private remoteFrames(): Array<RiderFrame & { id: string }> {
    if (!this.net) return [];
    const out: Array<RiderFrame & { id: string }> = [];
    for (const id of this.net.riders.keys()) {
      const pos = this.net.position(id);
      if (pos) out.push({ id, distanceM: pos.d, lateralM: lateralFor(id), speedMps: pos.v, cadence: pos.v > 0.3 ? pos.c : 0 });
    }
    return out;
  }

  /** Smoothed positions for rendering (physics runs at 10 Hz, rendering at 60 Hz). */
  frame(dt: number): { me: RiderFrame; others: Array<RiderFrame & { id: string }> } {
    const v = this.runState === 'riding' ? this.state.speedMps : 0;
    this.renderDistance += v * dt;
    const err = this.state.distanceM - this.renderDistance;
    this.renderDistance += Math.abs(err) > 20 ? err : err * (1 - Math.exp(-dt * 6));
    const m = deviceManager.metrics.get();
    const cadence = v < 0.3 ? 0 : m.cadence > 0 ? m.cadence : m.power > 0 ? 85 : 0;
    return {
      me: { distanceM: this.renderDistance, lateralM: RIDER_LATERAL, speedMps: v, cadence },
      others: this.bots.map((b) => {
        const bv = this.runState === 'riding' ? b.state.speedMps : 0;
        b.renderDistance += bv * dt;
        const e = b.state.distanceM - b.renderDistance;
        b.renderDistance += Math.abs(e) > 20 ? e : e * (1 - Math.exp(-dt * 6));
        return {
        id: b.id,
        distanceM: b.renderDistance,
        lateralM: b.lateral,
        speedMps: b.state.speedMps,
        cadence: b.state.speedMps > 0.3 ? b.cadence : 0,
        };
      }).concat(this.remoteFrames()),
    };
  }
}
