import { useEffect } from 'react';
import { deviceManager } from '../devices/deviceManager';

/**
 * Keyboard control for the simulated trainer:
 *   ↑ / ↓  rider power ±10 W (Shift: ±50 W)
 *   ← / →  cadence ±5 rpm
 *   Space  stop / resume pedalling
 */
export function useSimulatorKeys(): void {
  useEffect(() => {
    let pausedCadence = 0;
    const onKey = (e: KeyboardEvent) => {
      const sim = deviceManager.simTransport.trainer;
      if (!sim?.connected) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const step = e.shiftKey ? 50 : 10;
      const r = sim.rider;
      switch (e.key) {
        case 'ArrowUp':
          sim.setRider({ power: Math.min(1500, r.power + step) });
          break;
        case 'ArrowDown':
          sim.setRider({ power: Math.max(0, r.power - step) });
          break;
        case 'ArrowRight':
          sim.setRider({ cadence: Math.min(150, r.cadence + 5) });
          break;
        case 'ArrowLeft':
          sim.setRider({ cadence: Math.max(0, r.cadence - 5) });
          break;
        case ' ':
          if (r.cadence > 0) {
            pausedCadence = r.cadence;
            sim.setRider({ cadence: 0 });
          } else {
            sim.setRider({ cadence: pausedCadence || 88 });
          }
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
