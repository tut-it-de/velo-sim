/**
 * Running values for the HUD that the recorder does not keep cheaply: the 10-second average and the
 * average of the current lap (a route lap in a free ride, a workout block in a workout). Fed with the
 * same 1 Hz power the recorder gets.
 */
export class LiveStats {
  private window: number[] = [];
  private windowSum = 0;
  private lapSum = 0;
  private lapN = 0;

  constructor(private readonly windowS = 10) {}

  addSecond(power: number): void {
    this.window.push(power);
    this.windowSum += power;
    if (this.window.length > this.windowS) this.windowSum -= this.window.shift()!;
    this.lapSum += power;
    this.lapN++;
  }

  /** A new lap / workout block starts. */
  lap(): void {
    this.lapSum = 0;
    this.lapN = 0;
  }

  /** Average of the last `windowS` recorded seconds (fewer at the start). */
  get power10s(): number {
    return this.window.length ? this.windowSum / this.window.length : 0;
  }

  get lapPower(): number {
    return this.lapN ? this.lapSum / this.lapN : 0;
  }

  /** Recorded seconds in the current lap. */
  get lapSeconds(): number {
    return this.lapN;
  }
}
