/**
 * Load test / company: connects N simulated riders to a server.
 *   npm run bots -w @velo/server -- --count 100 --route bergrunde --url ws://localhost:8080
 */
import WebSocket from 'ws';
import { BIKES, JERSEYS, WHEELS, setupFor } from '@velo/equipment';
import { step } from '@velo/physics';
import { getTrack } from '@velo/routes';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const url = arg('url', 'ws://localhost:8080').replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
const count = Number(arg('count', '20'));
const routeId = arg('route', 'kuestenrunde');
const hz = Number(arg('hz', '2'));
const track = getTrack(routeId);
const pick = <T>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)]!;

let received = 0;
let connected = 0;

for (let i = 0; i < count; i++) {
  setTimeout(() => startBot(i), i * 50);
}

function startBot(i: number) {
  const ws = new WebSocket(url);
  const loadout = { bike: pick(BIKES).id, wheels: pick(WHEELS).id, jersey: pick(JERSEYS).id };
  const weightKg = 60 + Math.random() * 30;
  const wkg = 1.8 + Math.random() * 2.2;
  const setup = setupFor({ weightKg, heightCm: 175 }, loadout);
  let state = { speedMps: 8, distanceM: Math.random() * track.length };
  const lat = 0.5 + Math.random() * 2.5;
  let timer: ReturnType<typeof setInterval> | undefined;

  ws.on('open', () => {
    connected++;
    ws.send(JSON.stringify({ type: 'hello', v: 1, name: `Bot ${i + 1}`, routeId, loadout, weightKg, bot: true }));
    let last = Date.now();
    timer = setInterval(() => {
      const now = Date.now();
      const dt = (now - last) / 1000;
      last = now;
      const g = track.sample(state.distanceM).gradePercent;
      const power = wkg * weightKg * (1 + 0.05 * Math.sin(now / 7000 + i));
      state = step(state, power, setup, { gradePercent: g }, dt);
      ws.send(JSON.stringify({ type: 'state', d: state.distanceM, v: state.speedMps, p: power, c: 85 + (i % 10), lat }));
    }, 1000 / hz);
  });
  ws.on('message', () => received++);
  ws.on('close', () => {
    connected--;
    clearInterval(timer);
  });
  ws.on('error', (err) => console.error(`Bot ${i + 1}:`, err.message));
}

setInterval(() => {
  console.log(`${connected}/${count} verbunden · ${Math.round(received / 5)} Nachrichten/s empfangen`);
  received = 0;
}, 5000);
