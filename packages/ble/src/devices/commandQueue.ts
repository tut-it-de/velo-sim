interface Entry {
  key: string;
  run: () => Promise<void>;
  waiters: Array<{ resolve: () => void; reject: (err: unknown) => void }>;
}

/**
 * Serialises BLE writes (GATT allows only one outstanding operation) and
 * coalesces commands with the same key: if a newer "target" command is queued
 * while an older one is still waiting, only the newest is sent.
 */
export class CommandQueue {
  private queue: Entry[] = [];
  private running = false;

  enqueue(key: string, run: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const existing = this.queue.find((e) => e.key === key);
      if (existing) {
        existing.run = run;
        existing.waiters.push({ resolve, reject });
      } else {
        this.queue.push({ key, run, waiters: [{ resolve, reject }] });
      }
      void this.drain();
    });
  }

  clear(): void {
    const dropped = this.queue;
    this.queue = [];
    for (const e of dropped) for (const w of e.waiters) w.resolve();
  }

  get size(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let entry: Entry | undefined;
      while ((entry = this.queue.shift())) {
        try {
          await entry.run();
          for (const w of entry.waiters) w.resolve();
        } catch (err) {
          for (const w of entry.waiters) w.reject(err);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
