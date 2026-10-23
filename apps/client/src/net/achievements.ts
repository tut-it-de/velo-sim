import { evaluateAchievements, toAchievementRide, type Achievements } from '@velo/metrics';
import { ROUTES } from '@velo/routes';
import type { StoredActivity } from '../state/activities';
import { Store, loadJson, saveJson } from '../state/store';
import { accountStore, apiCall, isLoggedIn, refreshAccount } from './api';

/**
 * Challenges and badges are worked out here for display; the Watt-Taler for them are booked by the
 * server from the synced rides (once per key), so they follow the account and cannot be doubled.
 */

const CLAIMS_KEY = 'velo.achievementClaims.v1';
/** Keys the server has booked, per account – shown as "Taler erhalten". */
export const achievementClaims = new Store<Record<string, string[]>>(loadJson(CLAIMS_KEY, {}));
achievementClaims.subscribe(() => saveJson(CLAIMS_KEY, achievementClaims.get()));

export interface Booking {
  key: string;
  label: string;
  amount: number;
}
/** Bookings of this session, newest last – the ride summary shows the ones of its ride. */
export const recentBookings = new Store<Booking[]>([]);

const ROUTE_IDS = ROUTES.map((r) => r.id);
const ROUTE_NAMES = Object.fromEntries(ROUTES.map((r) => [r.id, r.name]));

export function achievementsOf(all: StoredActivity[], now = Date.now()): Achievements {
  return evaluateAchievements(all.map(toAchievementRide), ROUTE_IDS, ROUTE_NAMES, now);
}

/** Badges and challenge tiers that this ride unlocked (empty for simulator rides). */
export function unlockedBy(all: StoredActivity[], rideId: string): Array<{ key: string; label: string; reward: number }> {
  const ride = all.find((a) => a.id === rideId);
  if (!ride || ride.simulated) return [];
  const before = achievementsOf(all.filter((a) => a.id !== rideId), ride.startTime).earned;
  const after = achievementsOf(all, ride.startTime);
  const out = [...after.earned].filter(([key]) => !before.has(key)).map(([key, e]) => ({ key, label: e.label, reward: e.reward }));
  // route badges carry no Taler and are not in `earned`
  for (const b of after.badges) {
    if (b.key.startsWith('route:') && b.earnedAt === ride.startTime) out.push({ key: b.key, label: `Strecke komplett: ${b.title}`, reward: 0 });
  }
  return out;
}

/** Asks the server to book everything earned; called at the end of each ride sync. */
export async function claimAchievements(): Promise<void> {
  const user = accountStore.get().user?.id;
  if (!user || !isLoggedIn()) return;
  const r = await apiCall<{ booked: Booking[]; claimed: string[]; balance: number }>('/api/achievements/claim', {});
  achievementClaims.set((c) => ({ ...c, [user]: r.claimed }));
  if (!r.booked.length) return;
  recentBookings.set((b) => [...b, ...r.booked]);
  await refreshAccount();
}
