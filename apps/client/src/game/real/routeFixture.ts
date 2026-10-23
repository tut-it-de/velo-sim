/**
 * Test fixture: a route's corridor built from the world files on disk (tests and analysis scripts only,
 * needs Node's fs). Babylon-free, like everything the corridor depends on.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTrack } from '@velo/routes';
import { RouteCorridor } from './corridor';
import { BuildingIndex, HeightField } from './heightField';
import { decodeWorld, type WorldData } from './worldData';

const WORLDS = fileURLToPath(new URL('../../../public/worlds/', import.meta.url));

export function loadWorldFromDisk(id: string): WorldData {
  const json = JSON.parse(readFileSync(`${WORLDS}${id}/world.json`, 'utf8')) as unknown;
  const buf = readFileSync(`${WORLDS}${id}/terrain.bin`);
  const bin = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return decodeWorld(id, json, bin);
}

export function corridorFromDisk(id: string): { data: WorldData; corridor: RouteCorridor } {
  const data = loadWorldFromDisk(id);
  const field = new HeightField(data);
  const buildings = new BuildingIndex(data.buildings, data.parking);
  return { data, corridor: new RouteCorridor(getTrack(id), field, buildings, data.roundabouts) };
}
