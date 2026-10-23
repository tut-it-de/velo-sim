import { describe, expect, it } from 'vitest';
import { DEFAULT_HUD_LAYOUT } from '../ride/hudFields';
import { DEFAULT_SETTINGS, migrateSettings, type Settings } from './settings';

describe('settings migration', () => {
  it('gives settings from before the data fields today’s layout', () => {
    const { hudFields: _none, ...old } = DEFAULT_SETTINGS;
    const migrated = migrateSettings(old as Settings);
    expect(migrated.hudFields).toEqual(DEFAULT_HUD_LAYOUT);
    expect(migrated.hudFields.free).toEqual(['speed', 'power3s', 'cadence', 'heartRate', 'distance', 'time', 'grade']);
  });

  it('keeps a chosen layout and drops what this version does not know', () => {
    const stored = { ...DEFAULT_SETTINGS, hudFields: { free: ['np', 'tss', 'warp', 'np', 'targetPower'], workout: ['targetPower', 'intervalRemaining'] } } as unknown as Settings;
    expect(migrateSettings(stored).hudFields).toEqual({ free: ['np', 'tss'], workout: ['targetPower', 'intervalRemaining'] });
  });

  it('repairs a broken entry', () => {
    const stored = { ...DEFAULT_SETTINGS, hudFields: { free: 'x' } } as unknown as Settings;
    expect(migrateSettings(stored).hudFields).toEqual(DEFAULT_HUD_LAYOUT);
  });
});
