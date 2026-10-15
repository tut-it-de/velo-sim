/**
 * Turns cumulative crank revolution counters (CPS / CSC) into cadence in rpm.
 * Handles 16-bit wrap-around of both counters and drops to 0 when no new
 * crank event arrived for `timeoutMs` (rider stopped pedalling).
 */
export class CrankCadenceCalculator {
  private last?: { revolutions: number; eventTime: number; receivedAt: number };
  private cadence = 0;

  constructor(
    private readonly timeoutMs = 2500,
    private readonly ticksPerSecond = 1024,
  ) {}

  get value(): number {
    return this.cadence;
  }

  reset(): void {
    this.last = undefined;
    this.cadence = 0;
  }

  update(revolutions: number, eventTime: number, nowMs: number): number {
    const last = this.last;
    if (!last) {
      this.last = { revolutions, eventTime, receivedAt: nowMs };
      return this.cadence;
    }

    const dRevs = (revolutions - last.revolutions + 0x10000) % 0x10000;
    const dTicks = (eventTime - last.eventTime + 0x10000) % 0x10000;

    if (dRevs === 0 || dTicks === 0) {
      if (nowMs - last.receivedAt > this.timeoutMs) this.cadence = 0;
      return this.cadence;
    }

    const rpm = (dRevs / (dTicks / this.ticksPerSecond)) * 60;
    // Anything above 250 rpm is a glitch (e.g. counter reset after reconnect).
    if (rpm <= 250) this.cadence = rpm;
    this.last = { revolutions, eventTime, receivedAt: nowMs };
    return this.cadence;
  }

  /** Call periodically so cadence decays to 0 even when the sensor stops sending. */
  tick(nowMs: number): number {
    if (this.last && nowMs - this.last.receivedAt > this.timeoutMs) this.cadence = 0;
    return this.cadence;
  }
}
