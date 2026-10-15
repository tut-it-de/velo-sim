import type { LogLevel } from '@velo/ble';
import { Store } from './store';

export interface LogEntry {
  id: number;
  time: number;
  level: LogLevel;
  message: string;
}

const MAX = 400;
let nextId = 1;

export const logStore = new Store<LogEntry[]>([]);

export function log(level: LogLevel, message: string): void {
  const entry = { id: nextId++, time: Date.now(), level, message };
  logStore.set((entries) => [...entries.slice(-(MAX - 1)), entry]);
  if (level === 'error') console.error(message);
  else if (level === 'warn') console.warn(message);
}

export function logText(): string {
  return logStore
    .get()
    .map((e) => `${new Date(e.time).toISOString().slice(11, 23)} ${e.level.toUpperCase().padEnd(5)} ${e.message}`)
    .join('\n');
}
