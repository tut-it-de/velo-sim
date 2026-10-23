import { describe, expect, it } from 'vitest';
import type { RouteSegment } from '@velo/routes';
import { BANNER, layoutBanner, planGates, START_COLOR, type Measure } from './gatePlan';

const seg = (type: RouteSegment['type'], name: string, startM: number, endM: number): RouteSegment => ({ id: name, name, type, startM, endM }) as RouteSegment;

/** Condensed font: every character half as wide as the font size. */
const measure: Measure = (text, _font, px) => text.length * px * 0.5;

describe('planGates', () => {
  it('puts one arch at the start/finish and at every segment start and end', () => {
    const gates = planGates(10000, 'Hügelrunde', [seg('sprint', 'Dorfsprint', 2000, 2500)]);
    expect(gates.map((g) => g.d)).toEqual([0, 2000, 2500]);
    expect(gates[0]).toMatchObject({ title: 'START · ZIEL', kicker: 'HÜGELRUNDE', color: START_COLOR });
    expect(gates[1]).toMatchObject({ title: 'DORFSPRINT', kicker: 'SPRINT' });
    expect(gates[2]).toMatchObject({ title: 'ZIEL', kicker: 'SPRINT DORFSPRINT' });
  });

  it('does not repeat the segment type when the name already contains it', () => {
    const gates = planGates(10000, 'Runde', [seg('sprint', 'Sprint Sodener Straße', 2000, 2500)]);
    expect(gates[2]!.kicker).toBe('SPRINT SODENER STRASSE');
  });

  it('merges the end of a climb with the start of the descent right after it', () => {
    const gates = planGates(10000, 'Runde', [seg('climb', 'Stich', 1000, 4000), seg('descent', 'Talfahrt', 4010, 6000)]);
    expect(gates.map((g) => g.d)).toEqual([0, 1000, 4010, 6000]);
    expect(gates[2]).toMatchObject({ title: 'TALFAHRT', kicker: 'ZIEL BERGWERTUNG · ABFAHRT' });
  });

  it('merges segments at the start/finish, also across the lap end', () => {
    const gates = planGates(10000, 'Runde', [seg('climb', 'Berg', 0, 4000), seg('descent', 'Tal', 5000, 9990)]);
    expect(gates).toHaveLength(3);
    expect(gates[0]).toMatchObject({ d: 0, title: 'START · ZIEL', kicker: 'ZIEL ABFAHRT · BERGWERTUNG BERG' });
  });
});

describe('layoutBanner', () => {
  it('keeps a short title on one big line', () => {
    const l = layoutBanner(measure, 'SPRINT', 'ZIEL', 10);
    expect(l.lines).toEqual(['ZIEL']);
    expect(l.titleM).toBe(BANNER.single.title);
  });

  it('breaks a long name into two lines instead of cutting it', () => {
    const l = layoutBanner(measure, 'BERGWERTUNG', 'MAMMOLSHAINER STICH ZUM FUCHSTANZ', 8);
    expect(l.lines).toHaveLength(2);
    expect(l.lines.join(' ')).toBe('MAMMOLSHAINER STICH ZUM FUCHSTANZ');
    expect(l.heightM).toBe(BANNER.double.height);
  });

  it('never lets a line run past the banner', () => {
    for (const width of [5, 7, 9, 12]) {
      for (const title of ['START · ZIEL', 'COL DU GLANDON', 'DONAUDAMPFSCHIFFAHRTSGESELLSCHAFT', 'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z']) {
        const l = layoutBanner(measure, 'ZIEL BERGWERTUNG · ABFAHRT', title, width);
        const avail = width - 2 * BANNER.pad;
        for (const line of l.lines) expect(measure(line, 'title', l.titleM)).toBeLessThanOrEqual(avail + 1e-9);
        expect(measure(l.kicker, 'kicker', l.kickerM)).toBeLessThanOrEqual(avail + 1e-9);
      }
    }
  });

  it('does not start a line with the separator dot', () => {
    const l = layoutBanner(measure, '', 'START · ZIELEINLAUF', 6);
    for (const line of l.lines) expect(line.startsWith('·') || line.endsWith('·')).toBe(false);
  });
});
