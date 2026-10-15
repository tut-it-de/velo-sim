import { useSyncExternalStore } from 'react';

/** Tiny observable value: framework-free so game loop code can use it too. */
export class Store<T> {
  private listeners = new Set<() => void>();

  constructor(private value: T) {}

  get = (): T => this.value;

  set(next: T | ((prev: T) => T)): void {
    const value = typeof next === 'function' ? (next as (prev: T) => T)(this.value) : next;
    if (Object.is(value, this.value)) return;
    this.value = value;
    for (const l of [...this.listeners]) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** localStorage can be unavailable (private mode, iOS quirks) — never let that break the app. */
export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}
