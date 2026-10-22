import type { Workout, WorkoutStep } from './model';

const min = (m: number) => Math.round(m * 60);

/** Ramp test in % of FTP: +7 % per minute from 55 %. */
function rampTestSteps(): WorkoutStep[] {
  const steps: WorkoutStep[] = [{ type: 'warmup', durationS: min(5), powerStart: 0.4, powerEnd: 0.55, label: 'Einrollen' }];
  for (let i = 0; i < 24; i++) {
    steps.push({ type: 'steady', durationS: 60, power: Math.round((0.55 + i * 0.07) * 100) / 100, label: `Stufe ${i + 1}` });
  }
  steps.push({ type: 'cooldown', durationS: min(5), powerStart: 0.45, powerEnd: 0.35 });
  return steps;
}

/** Zwift-style ramp in absolute watts: one-minute steps from `start` to `end`. */
function wattRampSteps(start: number, step: number, end: number): WorkoutStep[] {
  const steps: WorkoutStep[] = [{ type: 'warmup', durationS: min(5), powerStart: Math.round(start * 0.5), powerEnd: start, label: 'Einrollen' }];
  for (let w = start, i = 1; w <= end; w += step, i++) steps.push({ type: 'steady', durationS: 60, power: w, label: `Stufe ${i}` });
  steps.push({ type: 'cooldown', durationS: min(5), powerStart: start, powerEnd: Math.round(start * 0.6) });
  return steps;
}

/** `count` blocks of `parts` (each with its own label) — for over-unders and the like. */
function blocks(count: number, parts: Array<{ s: number; p: number; label: string; cadence?: [number, number] }>, restS: number, restP = 0.55): WorkoutStep[] {
  const out: WorkoutStep[] = [];
  for (let b = 1; b <= count; b++) {
    for (const part of parts) out.push({ type: 'steady', durationS: part.s, power: part.p, cadence: part.cadence, label: `${part.label} ${b}/${count}` });
    if (b < count) out.push({ type: 'steady', durationS: restS, power: restP, label: `Pause ${b}/${count}` });
  }
  return out;
}

const RAMP_EVENTS = (warmS: number) => [
  { atS: 10, message: 'Locker einrollen – gleich geht’s los.' },
  { atS: warmS + 5, message: 'Stufe 1: ab jetzt jede Minute schwerer. Fahr, bis du die Kadenz nicht mehr halten kannst!' },
  { atS: warmS + min(8), message: 'Ruhig atmen, Oberkörper locker, Kadenz hoch halten.' },
];

const FTP20_BLOCK_START = min(10 + 6 + 3 + 5 + 10);

/** Built-in workout library (powers as fraction of FTP unless powerUnit is 'watts'). */
export const WORKOUT_LIBRARY: Workout[] = [
  // ── Tests ────────────────────────────────────────────────
  {
    id: 'ramp-test-zwift',
    name: 'Rampentest',
    description:
      'Wie bei Zwift: Start bei 100 W, jede Minute +20 W bis maximal 600 W. Fahr bis zur Erschöpfung – deine FTP = 75 % der besten Minute. Für die meisten Fahrer ab ca. 175 W FTP.',
    category: 'test',
    level: 2,
    test: 'ramp',
    powerUnit: 'watts',
    steps: wattRampSteps(100, 20, 600),
    textEvents: RAMP_EVENTS(min(5)),
  },
  {
    id: 'ramp-test-lite',
    name: 'Rampentest Lite',
    description:
      'Die leichtere Variante wie bei Zwift: Start bei 50 W, jede Minute nur +10 W bis maximal 400 W. Empfohlen für Einsteiger, unter 60 kg oder unter ca. 175 W FTP. FTP = 75 % der besten Minute.',
    category: 'test',
    level: 1,
    test: 'ramp',
    powerUnit: 'watts',
    steps: wattRampSteps(50, 10, 400),
    textEvents: RAMP_EVENTS(min(5)),
  },
  {
    id: 'ramp-test',
    name: 'Rampentest (nach FTP)',
    description: 'Jede Minute steigt die Leistung um 7 % deiner aktuellen FTP – passt sich deinem Niveau an. FTP = 75 % der besten Minute.',
    category: 'test',
    level: 2,
    test: 'ramp',
    steps: rampTestSteps(),
    textEvents: RAMP_EVENTS(min(5)),
  },
  {
    id: 'ftp-test-20',
    name: 'FTP-Test 20 min',
    description:
      'Der Klassiker und genaueste Test: Aufwärmen, 5 min Vorbelastung, Erholung, dann 20 Minuten so hart, wie du gleichmäßig durchhältst. FTP = 95 % deines 20-min-Schnitts. Abbruch ab 12 min wird hochgerechnet.',
    category: 'test',
    level: 3,
    test: 'ftp20',
    steps: [
      { type: 'warmup', durationS: min(10), powerStart: 0.45, powerEnd: 0.7, label: 'Einrollen' },
      { type: 'intervals', repeat: 3, on: { durationS: 60, power: 0.95, cadence: [100, 110] }, off: { durationS: 60, power: 0.5 } },
      { type: 'steady', durationS: min(3), power: 0.55, label: 'Locker' },
      { type: 'maxeffort', durationS: min(5), label: 'Vorbelastung 5 min' },
      { type: 'steady', durationS: min(10), power: 0.5, label: 'Erholung' },
      { type: 'maxeffort', durationS: min(20), label: 'Testblock 20 min' },
      { type: 'cooldown', durationS: min(10), powerStart: 0.55, powerEnd: 0.4 },
    ],
    textEvents: [
      { atS: 10, message: 'Gut aufwärmen – gleich kommen drei schnelle Minuten mit hoher Kadenz.' },
      { atS: min(19) + 5, message: 'Vorbelastung: 5 Minuten hart, aber nicht ganz am Limit. Das leert die schnellen Speicher.' },
      { atS: min(24) + 5, message: 'Erholung: ganz locker treten und Kopf frei machen.' },
      { atS: FTP20_BLOCK_START - 30, message: 'Gleich startet der Testblock. Fang 2–3 % unter deinem Ziel an!', durationS: 25 },
      { atS: FTP20_BLOCK_START + 5, message: 'Testblock: gleichmäßig fahren, nicht losstürmen.', durationS: 15 },
      { atS: FTP20_BLOCK_START + min(5), message: '5 min geschafft – fühlt es sich gut an? Dann ein paar Watt mehr.' },
      { atS: FTP20_BLOCK_START + min(10), message: 'Halbzeit! Kadenz hoch halten, Schultern locker.' },
      { atS: FTP20_BLOCK_START + min(15), message: 'Noch 5 Minuten – jetzt darfst du steigern.' },
      { atS: FTP20_BLOCK_START + min(19), message: 'Letzte Minute: alles rein!', durationS: 30 },
    ],
  },
  {
    id: 'grundlage-45',
    name: 'Grundlage 45',
    description: '45 Minuten ruhige Grundlage mit kurzen Kadenzwechseln – ideal für lockere Tage.',
    category: 'endurance',
    level: 1,
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
    level: 1,
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
    level: 2,
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
    level: 2,
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
    level: 1,
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
    level: 1,
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
    level: 2,
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
    level: 1,
    steps: [
      { type: 'warmup', durationS: min(5), powerStart: 0.4, powerEnd: 0.5 },
      { type: 'steady', durationS: min(20), power: 0.52, cadence: 90 },
      { type: 'cooldown', durationS: min(5), powerStart: 0.5, powerEnd: 0.4 },
    ],
  },
  // ── Grundlage & Tempo ────────────────────────────────────
  {
    id: 'grundlage-60',
    name: 'Grundlage 60',
    description: 'Eine Stunde lockere Zone 2 (ca. 65–72 % FTP). Baut Ausdauer und Fettstoffwechsel auf – das Fundament für alles andere.',
    category: 'endurance',
    level: 1,
    steps: [
      { type: 'warmup', durationS: min(10), powerStart: 0.45, powerEnd: 0.65 },
      { type: 'steady', durationS: min(20), power: 0.68, cadence: [85, 95] },
      { type: 'steady', durationS: min(1), power: 0.68, cadence: [105, 110], label: 'Spin-up' },
      { type: 'steady', durationS: min(19), power: 0.7, cadence: [85, 95] },
      { type: 'cooldown', durationS: min(10), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'grundlage-90',
    name: 'Grundlage 90',
    description: '90 Minuten Zone 2 mit leicht steigendem Druck am Ende. Ideal fürs Wochenende – „locker, aber lang“.',
    category: 'endurance',
    level: 2,
    steps: [
      { type: 'warmup', durationS: min(10), powerStart: 0.45, powerEnd: 0.65 },
      { type: 'steady', durationS: min(30), power: 0.68, cadence: [85, 95] },
      { type: 'steady', durationS: min(30), power: 0.71, cadence: [85, 95] },
      { type: 'steady', durationS: min(12), power: 0.75, cadence: [85, 95] },
      { type: 'cooldown', durationS: min(8), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'tempo-3x10',
    name: 'Tempo 3×10',
    description: 'Drei Blöcke à 10 Minuten bei 80 % FTP – „zügig, aber man kann noch sprechen“. Gut für Einsteiger in strukturierte Intervalle.',
    category: 'tempo',
    level: 1,
    steps: [
      { type: 'warmup', durationS: min(10), powerStart: 0.45, powerEnd: 0.7 },
      { type: 'intervals', repeat: 3, on: { durationS: min(10), power: 0.8, cadence: [85, 95] }, off: { durationS: min(4), power: 0.55 } },
      { type: 'cooldown', durationS: min(6), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'tempo-2x20',
    name: 'Tempo 2×20',
    description: 'Zwei lange Tempoblöcke bei 82 % FTP – trainiert, lange Zeit zügig zu fahren (Gruppenfahrt, Gran Fondo).',
    category: 'tempo',
    level: 2,
    steps: [
      { type: 'warmup', durationS: min(10), powerStart: 0.45, powerEnd: 0.72 },
      { type: 'intervals', repeat: 2, on: { durationS: min(20), power: 0.82, cadence: [85, 95] }, off: { durationS: min(5), power: 0.55 } },
      { type: 'cooldown', durationS: min(5), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  // ── Sweet Spot & Schwelle ────────────────────────────────
  {
    id: 'sweetspot-3x15',
    name: 'Sweet Spot 3×15',
    description: 'Drei Viertelstunden bei 90 % FTP – hebt die FTP effizient, ohne so zu ermüden wie Schwellenarbeit.',
    category: 'sweetspot',
    level: 2,
    steps: [
      { type: 'warmup', durationS: min(10), powerStart: 0.45, powerEnd: 0.75 },
      { type: 'intervals', repeat: 3, on: { durationS: min(15), power: 0.9, cadence: [85, 95] }, off: { durationS: min(5), power: 0.55 } },
      { type: 'cooldown', durationS: min(5), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'sweetspot-2x20',
    name: 'Sweet Spot 2×20',
    description: 'Zwei 20-Minuten-Blöcke bei 92 % FTP – ein Klassiker vor dem Wettkampf und die beste Vorbereitung auf den FTP-Test.',
    category: 'sweetspot',
    level: 3,
    steps: [
      { type: 'warmup', durationS: min(12), powerStart: 0.45, powerEnd: 0.78 },
      { type: 'intervals', repeat: 2, on: { durationS: min(20), power: 0.92, cadence: [85, 95] }, off: { durationS: min(6), power: 0.55 } },
      { type: 'cooldown', durationS: min(7), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'schwelle-5x5',
    name: 'Schwelle 5×5',
    description: 'Der Einstieg in die Schwellenarbeit: fünf kurze Blöcke bei 97 % FTP mit gleich langer Pause.',
    category: 'threshold',
    level: 1,
    steps: [
      { type: 'warmup', durationS: min(10), powerStart: 0.45, powerEnd: 0.75 },
      { type: 'intervals', repeat: 5, on: { durationS: min(5), power: 0.97, cadence: [88, 98] }, off: { durationS: min(4), power: 0.55 } },
      { type: 'cooldown', durationS: min(6), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'schwelle-2x20',
    name: 'Schwelle 2×20',
    description: 'Zwei 20-Minuten-Blöcke direkt an der Schwelle (98–100 % FTP). Hart – nur ausgeruht fahren.',
    category: 'threshold',
    level: 3,
    steps: [
      { type: 'warmup', durationS: min(12), powerStart: 0.45, powerEnd: 0.8 },
      { type: 'intervals', repeat: 2, on: { durationS: min(20), power: 0.99, cadence: [88, 98] }, off: { durationS: min(8), power: 0.55 } },
      { type: 'cooldown', durationS: min(8), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'over-unders',
    name: 'Over-Unders 3×9',
    description: 'Wechsel zwischen knapp unter (95 %) und knapp über der Schwelle (108 %). Trainiert, Laktat abzubauen, während du weiter Druck machst – wie bei Attacken am Berg.',
    category: 'threshold',
    level: 3,
    steps: [
      { type: 'warmup', durationS: min(12), powerStart: 0.45, powerEnd: 0.8 },
      ...blocks(
        3,
        [
          { s: 120, p: 0.95, label: 'Under' },
          { s: 60, p: 1.08, label: 'Over' },
          { s: 120, p: 0.95, label: 'Under' },
          { s: 60, p: 1.08, label: 'Over' },
          { s: 120, p: 0.95, label: 'Under' },
          { s: 60, p: 1.08, label: 'Over' },
        ],
        min(5),
      ),
      { type: 'cooldown', durationS: min(8), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  // ── VO2max & Anaerob ─────────────────────────────────────
  {
    id: 'vo2max-30-30',
    name: 'VO2max 30/30',
    description: 'Zweimal zehn 30-Sekunden-Intervalle bei 120 % FTP mit 30 s locker (nach Billat). Viel Zeit nahe der maximalen Sauerstoffaufnahme, gut verträglich.',
    category: 'vo2max',
    level: 2,
    steps: [
      { type: 'warmup', durationS: min(12), powerStart: 0.45, powerEnd: 0.8 },
      { type: 'intervals', repeat: 10, on: { durationS: 30, power: 1.2, cadence: [95, 105] }, off: { durationS: 30, power: 0.5 } },
      { type: 'steady', durationS: min(5), power: 0.5, label: 'Satzpause' },
      { type: 'intervals', repeat: 10, on: { durationS: 30, power: 1.2, cadence: [95, 105] }, off: { durationS: 30, power: 0.5 } },
      { type: 'cooldown', durationS: min(8), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'ronnestad-30-15',
    name: 'Rønnestad 30/15',
    description:
      '3 Sätze × 13 × (30 s bei 125 % / 15 s locker), 3 min Satzpause. In Studien mit trainierten Radfahrern wirksamer als klassische 5-Minuten-Intervalle. Sehr hart!',
    category: 'vo2max',
    level: 3,
    steps: [
      { type: 'warmup', durationS: min(12), powerStart: 0.45, powerEnd: 0.8 },
      { type: 'intervals', repeat: 13, on: { durationS: 30, power: 1.25, cadence: [95, 110] }, off: { durationS: 15, power: 0.5 } },
      { type: 'steady', durationS: min(3), power: 0.5, label: 'Satzpause' },
      { type: 'intervals', repeat: 13, on: { durationS: 30, power: 1.25, cadence: [95, 110] }, off: { durationS: 15, power: 0.5 } },
      { type: 'steady', durationS: min(3), power: 0.5, label: 'Satzpause' },
      { type: 'intervals', repeat: 13, on: { durationS: 30, power: 1.25, cadence: [95, 110] }, off: { durationS: 15, power: 0.5 } },
      { type: 'cooldown', durationS: min(10), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'vo2max-4x4',
    name: 'VO2max 4×4',
    description: 'Vier Mal vier Minuten bei 115 % FTP mit drei Minuten Pause – das bewährte „norwegische“ Format.',
    category: 'vo2max',
    level: 3,
    steps: [
      { type: 'warmup', durationS: min(12), powerStart: 0.45, powerEnd: 0.8 },
      { type: 'intervals', repeat: 4, on: { durationS: min(4), power: 1.15, cadence: [95, 105] }, off: { durationS: min(3), power: 0.5 } },
      { type: 'cooldown', durationS: min(10), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'anaerob-8x1',
    name: 'Anaerob 8×1',
    description: 'Acht Ein-Minuten-Intervalle bei 135 % FTP mit langer Pause – für Attacken, kurze Anstiege und Zielsprints aus der Gruppe.',
    category: 'anaerobic',
    level: 3,
    steps: [
      { type: 'warmup', durationS: min(12), powerStart: 0.45, powerEnd: 0.8 },
      { type: 'intervals', repeat: 8, on: { durationS: 60, power: 1.35, cadence: [100, 115] }, off: { durationS: min(3), power: 0.5 } },
      { type: 'cooldown', durationS: min(8), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  // ── Sprint, Kadenz, Erholung ─────────────────────────────
  {
    id: 'sprints-6x10',
    name: 'Sprint-Einstieg 6×10 s',
    description: 'Sechs kurze 10-Sekunden-Sprints im SIM-Modus mit viel Erholung – lernt die Beine, schnell Leistung zu bringen.',
    category: 'sprint',
    level: 1,
    steps: [
      { type: 'warmup', durationS: min(10), powerStart: 0.45, powerEnd: 0.7 },
      ...Array.from({ length: 6 }, (): WorkoutStep[] => [
        { type: 'maxeffort', durationS: 10, label: 'Sprint' },
        { type: 'steady', durationS: 170, power: 0.5 },
      ]).flat(),
      { type: 'cooldown', durationS: min(5), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'spin-ups',
    name: 'Spin-ups',
    description: 'Lockere Leistung, aber immer wieder kurze Phasen mit sehr hoher Trittfrequenz (110–120 rpm). Für einen runden, effizienten Tritt.',
    category: 'cadence',
    level: 1,
    steps: [
      { type: 'warmup', durationS: min(8), powerStart: 0.45, powerEnd: 0.6 },
      ...Array.from({ length: 6 }, (): WorkoutStep[] => [
        { type: 'steady', durationS: 60, power: 0.6, cadence: [110, 120], label: 'Spin-up' },
        { type: 'steady', durationS: 120, power: 0.62, cadence: [85, 95] },
      ]).flat(),
      { type: 'cooldown', durationS: min(4), powerStart: 0.55, powerEnd: 0.4 },
    ],
  },
  {
    id: 'kraftausdauer-5x5',
    name: 'Kraftausdauer 5×5',
    description: 'Fünf Blöcke bei 85 % FTP mit niedriger Trittfrequenz (55–65 rpm) – wie ein langer Anstieg im großen Gang.',
    category: 'cadence',
    level: 2,
    steps: [
      { type: 'warmup', durationS: min(10), powerStart: 0.45, powerEnd: 0.7 },
      { type: 'intervals', repeat: 5, on: { durationS: min(5), power: 0.85, cadence: [55, 65] }, off: { durationS: min(3), power: 0.55, cadence: 95 } },
      { type: 'cooldown', durationS: min(5), powerStart: 0.6, powerEnd: 0.4 },
    ],
  },
  {
    id: 'erholung-45',
    name: 'Erholung 45',
    description: '45 Minuten ganz locker unter 55 % FTP mit hoher Kadenz – aktive Erholung, z. B. am Tag nach einem FTP-Test.',
    category: 'recovery',
    level: 1,
    steps: [
      { type: 'warmup', durationS: min(5), powerStart: 0.4, powerEnd: 0.5 },
      { type: 'steady', durationS: min(35), power: 0.52, cadence: [90, 100] },
      { type: 'cooldown', durationS: min(5), powerStart: 0.5, powerEnd: 0.4 },
    ],
  },
];
