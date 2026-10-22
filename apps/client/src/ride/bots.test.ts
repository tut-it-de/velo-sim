import { describe, expect, it } from 'vitest';
import { STARTER_LOADOUT, setupFor } from '@velo/equipment';
import { ROUTES, getTrack } from '@velo/routes';
import { BOT_COUNT, botPosition, planBots } from './bots';

const setup = setupFor({ weightKg: 75, heightCm: 178 }, STARTER_LOADOUT);

describe('bots', () => {
  it('are the same for everyone on a route and ride at a plausible pace', () => {
    for (const r of ROUTES) {
      const track = getTrack(r.id);
      const t0 = performance.now();
      const a = planBots(track, setup);
      const ms = performance.now() - t0;
      const b = planBots(track, setup);
      expect(a).toHaveLength(BOT_COUNT);
      expect(a.map((x) => [x.name, x.wkg, x.offsetS])).toEqual(b.map((x) => [x.name, x.wkg, x.offsetS]));
      expect(ms).toBeLessThan(1500);
      for (const bot of a) {
        const avgKmh = (track.length / bot.table.lapS) * 3.6;
        expect(avgKmh).toBeGreaterThan(4);
        expect(avgKmh).toBeLessThan(50);
      }
      // positions move forward smoothly on the shared clock
      const p1 = botPosition(a[5]!, 1000, track.length);
      const p2 = botPosition(a[5]!, 1001, track.length);
      const moved = (((p2.lapM - p1.lapM) % track.length) + track.length) % track.length;
      expect(moved).toBeGreaterThan(0.5);
      expect(moved).toBeLessThan(25);
    }
  });
});
