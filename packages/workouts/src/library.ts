import type { Workout, WorkoutStep } from './model';

const min = (m: number) => Math.round(m * 60);

function rampTestSteps(): WorkoutStep[] {
  const steps: WorkoutStep[] = [{ type: 'warmup', durationS: min(5), powerStart: 0.4, powerEnd: 0.55, label: 'Einrollen' }];
  for (let i = 0; i < 24; i++) {
    steps.push({ type: 'steady', durationS: 60, power: Math.round((0.55 + i * 0.07) * 100) / 100, label: `Stufe ${i + 1}` });
  }
  steps.push({ type: 'cooldown', durationS: min(5), powerStart: 0.45, powerEnd: 0.35 });
  return steps;
}

/** Built-in workout library (powers as fraction of FTP). */
export const WORKOUT_LIBRARY: Workout[] = [
  {
    id: 'ramp-test',
    name: 'FTP-Rampentest',
    description:
      'Jede Minute steigt die Leistung um 7 % deiner FTP – fahre, bis du die Kadenz nicht mehr halten kannst. Deine neue FTP = 75 % der besten Minute.',
    category: 'test',
    test: 'ramp',
    steps: rampTestSteps(),
    textEvents: [
      { atS: 10, message: 'Locker einrollen – gleich geht’s los.' },
      { atS: min(5) + 5, message: 'Stufe 1: ab jetzt jede Minute schwerer. Durchhalten, solange es geht!' },
    ],
  },
  {
    id: 'grundlage-45',
    name: 'Grundlage 45',
    description: '45 Minuten ruhige Grundlage mit kurzen Kadenzwechseln – ideal für lockere Tage.',
    category: 'endurance',
    steps: [
      { type: 'warmup', durationS: min(8), powerStart: 0.45, powerEnd: 0.65 },
      { type: 'steady', durationS: min(10), power: 0.68, cadence: 90 },
      { type: 'steady', durationS: min(2), power: 0.68, cadence: [100, 105] },
      { type: 'steady', durationS: min(10), power: 0.7, cadence: 88 },
      { type: 'steady', durationS: min(2), power: 0.68, cadence: [100, 105] },
      { type: 'steady', durationS: min(8), power: 0.7, cadence: 88 },
      { type: 'cooldown', durationS: min(5), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'sweetspot-3x10',
    name: 'Sweet Spot 3×10',
    description: 'Drei mal zehn Minuten knapp unter der Schwelle – viel Trainingswirkung pro Minute.',
    category: 'sweetspot',
    steps: [
      { type: 'warmup', durationS: min(10), powerStart: 0.45, powerEnd: 0.75 },
      { type: 'intervals', repeat: 3, on: { durationS: min(10), power: 0.9, cadence: 90 }, off: { durationS: min(5), power: 0.55 } },
      { type: 'cooldown', durationS: min(5), powerStart: 0.6, powerEnd: 0.4 },
    ],
    textEvents: [{ atS: min(10), message: 'Sweet Spot: fordernd, aber gleichmäßig. Ruhig atmen.' }],
  },
  {
    id: 'schwelle-4x8',
    name: 'Schwelle 4×8',
    description: 'Vier Blöcke à acht Minuten an der Schwelle mit vier Minuten Pause.',
    category: 'threshold',
    steps: [
      { type: 'warmup', durationS: min(10), powerStart: 0.5, powerEnd: 0.75 },
      { type: 'intervals', repeat: 4, on: { durationS: min(8), power: 0.98, cadence: [90, 100] }, off: { durationS: min(4), power: 0.55 } },
      { type: 'freeride', durationS: min(5) },
      { type: 'cooldown', durationS: min(10), powerStart: 0.65, powerEnd: 0.4 },
    ],
    textEvents: [{ atS: min(10), message: 'Jetzt gilt’s!' }],
  },
  {
    id: 'vo2max-5x3',
    name: 'VO2max 5×3',
    description: 'Fünf harte Drei-Minuten-Intervalle bei 120 % FTP – hebt deine Spitzenleistung.',
    category: 'vo2max',
    steps: [
      { type: 'warmup', durationS: min(10), powerStart: 0.5, powerEnd: 0.8 },
      { type: 'steady', durationS: min(3), power: 0.55 },
      { type: 'intervals', repeat: 5, on: { durationS: min(3), power: 1.2, cadence: [95, 105] }, off: { durationS: min(3), power: 0.5 } },
      { type: 'cooldown', durationS: min(8), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'kurz-knackig-30',
    name: 'Kurz & knackig 30',
    description: '30 Minuten mit sechs Ein-Minuten-Intervallen über der Schwelle – passt in jede Mittagspause.',
    category: 'vo2max',
    steps: [
      { type: 'warmup', durationS: min(8), powerStart: 0.45, powerEnd: 0.75 },
      { type: 'intervals', repeat: 6, on: { durationS: 60, power: 1.1, cadence: 95 }, off: { durationS: 60, power: 0.55 } },
      { type: 'steady', durationS: min(5), power: 0.7 },
      { type: 'cooldown', durationS: min(5), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'kadenz-pyramide',
    name: 'Kadenz-Pyramide',
    description: 'Gleichbleibende Leistung, wechselnde Trittfrequenz von 70 bis 110 rpm – für einen runden Tritt.',
    category: 'cadence',
    steps: [
      { type: 'warmup', durationS: min(8), powerStart: 0.45, powerEnd: 0.65 },
      { type: 'steady', durationS: min(3), power: 0.7, cadence: [68, 72] },
      { type: 'steady', durationS: min(3), power: 0.7, cadence: [78, 82] },
      { type: 'steady', durationS: min(3), power: 0.7, cadence: [88, 92] },
      { type: 'steady', durationS: min(3), power: 0.7, cadence: [98, 102] },
      { type: 'steady', durationS: min(2), power: 0.7, cadence: [108, 112] },
      { type: 'steady', durationS: min(3), power: 0.7, cadence: [98, 102] },
      { type: 'steady', durationS: min(3), power: 0.7, cadence: [88, 92] },
      { type: 'steady', durationS: min(3), power: 0.7, cadence: [78, 82] },
      { type: 'cooldown', durationS: min(5), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'sprints-8x20',
    name: 'Sprints 8×20 s',
    description: 'Acht Vollgas-Sprints über 20 Sekunden mit langer Erholung. Die Sprints laufen im SIM-Modus – du bestimmst die Leistung.',
    category: 'sprint',
    steps: [
      { type: 'warmup', durationS: min(10), powerStart: 0.45, powerEnd: 0.75 },
      ...Array.from({ length: 8 }, (): WorkoutStep[] => [
        { type: 'maxeffort', durationS: 20 },
        { type: 'steady', durationS: 160, power: 0.5 },
      ]).flat(),
      { type: 'cooldown', durationS: min(6), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'erholung-30',
    name: 'Erholung 30',
    description: 'Ganz locker rollen – fördert die Regeneration nach harten Tagen.',
    category: 'recovery',
    steps: [
      { type: 'warmup', durationS: min(5), powerStart: 0.4, powerEnd: 0.5 },
      { type: 'steady', durationS: min(20), power: 0.52, cadence: 90 },
      { type: 'cooldown', durationS: min(5), powerStart: 0.5, powerEnd: 0.4 },
    ],
  },
];
