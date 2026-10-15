export * from '../src';
export { CommandQueue as CommandQueueForTest } from '../src/devices/commandQueue';

/** Lets pending microtasks and zero-delay timers run. */
export const flush = async (ms = 0) => {
  await new Promise((r) => setTimeout(r, ms));
};
