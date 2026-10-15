import { WORKOUT_LIBRARY, type Workout } from '@velo/workouts';
import { Store, loadJson, saveJson } from './store';

const KEY = 'velo.workouts.v1';

/** Imported and self-built workouts (stored locally until accounts exist). */
export const customWorkoutsStore = new Store<Workout[]>(loadJson<{ items: Workout[] }>(KEY, { items: [] }).items);
customWorkoutsStore.subscribe(() => saveJson(KEY, { items: customWorkoutsStore.get() }));

export function allWorkouts(): Workout[] {
  return [...WORKOUT_LIBRARY, ...customWorkoutsStore.get()];
}

export function isCustom(id: string): boolean {
  return customWorkoutsStore.get().some((w) => w.id === id);
}

export function saveCustomWorkout(w: Workout): void {
  const list = customWorkoutsStore.get();
  const idx = list.findIndex((x) => x.id === w.id);
  customWorkoutsStore.set(idx >= 0 ? list.map((x) => (x.id === w.id ? w : x)) : [...list, { ...w, category: 'custom' }]);
}

export function deleteCustomWorkout(id: string): void {
  customWorkoutsStore.set(customWorkoutsStore.get().filter((w) => w.id !== id));
}

export function newWorkoutId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
