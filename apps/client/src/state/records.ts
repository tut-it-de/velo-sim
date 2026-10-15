import { Store, loadJson, saveJson } from './store';

export interface PersonalBest {
  timeS: number;
  date: number;
}

const KEY = 'velo.records.v1';

/** Personal bests per route: `${routeId}:lap` and `${routeId}:${segmentId}`. */
export const recordsStore = new Store<Record<string, PersonalBest>>(loadJson<Record<string, PersonalBest>>(KEY, {}));
recordsStore.subscribe(() => saveJson(KEY, recordsStore.get()));

export function recordKey(routeId: string, id: string): string {
  return `${routeId}:${id}`;
}

export function getBest(routeId: string, id: string): PersonalBest | undefined {
  return recordsStore.get()[recordKey(routeId, id)];
}

export interface SubmitOutcome {
  previous?: PersonalBest;
  isPb: boolean;
  /** False for simulator rides — they never overwrite real bests. */
  saved: boolean;
}

export function submitResult(routeId: string, id: string, timeS: number, simulated: boolean): SubmitOutcome {
  const previous = getBest(routeId, id);
  const isPb = !previous || timeS < previous.timeS;
  if (isPb && !simulated) {
    recordsStore.set({ ...recordsStore.get(), [recordKey(routeId, id)]: { timeS, date: Date.now() } });
  }
  return { previous, isPb, saved: isPb && !simulated };
}
