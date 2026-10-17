#!/usr/bin/env python3
"""
Adds surface car parks from OpenStreetMap to a generated world.

Run from the repository root (also called by worldgen.build after world.json is written):
  python3 tools/geo/add_parking.py feldberg-taunus [lago-di-como ...]

Fetches amenity=parking areas inside the world's near grid from the Overpass API (cached in
tools/geo/.cache/<id>/parking.json) and stores their outlines in world.json under `parking`:
one delta-encoded decimetre ring per car park (as the building footprints), in the world's local
frame. Multi-storey, underground and rooftop car parks are left out. Standard library only.
"""
from __future__ import annotations

import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OVERPASS = 'https://overpass-api.de/api/interpreter'
SKIP_KINDS = {'underground', 'multi-storey', 'rooftop', 'garage_boxes', 'carports'}
MIN_AREA = 60.0  # m², smaller ones are a few marked bays along a street


def frame(origin):
    phi = math.radians(origin[1])
    kx = 111412.84 * math.cos(phi) - 93.5 * math.cos(3 * phi) + 0.118 * math.cos(5 * phi)
    kz = 111132.92 - 559.82 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi)
    return kx, kz


def fetch(world_id: str, bbox) -> dict:
    cache = HERE / '.cache' / world_id / 'parking.json'
    if cache.exists():
        return json.loads(cache.read_text())
    s, w, n, e = bbox
    q = f'[out:json][timeout:120];(way["amenity"="parking"]({s},{w},{n},{e});relation["amenity"="parking"]({s},{w},{n},{e}););out geom;'
    req = urllib.request.Request(OVERPASS, data=urllib.parse.urlencode({'data': q}).encode(),
                                 headers={'User-Agent': 'velo-sim-worldgen/1.0', 'Accept': 'application/json'})
    for attempt in range(4):  # the public Overpass servers answer 429/504 when busy
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                data = json.loads(r.read())
            break
        except urllib.error.HTTPError as e:
            if attempt == 3 or e.code not in (429, 502, 503, 504):
                raise
            time.sleep(20 * (attempt + 1))
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(data))
    return data


def ring_dm(coords) -> list[int]:
    out, px, pz = [], 0, 0
    for x, z in coords:
        ix, iz = int(round(x * 10)), int(round(z * 10))
        out += [ix - px, iz - pz]
        px, pz = ix, iz
    return out


def area(ring) -> float:
    return 0.5 * sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:] + ring[:1]))


def outer_rings(el) -> list[list[tuple[float, float]]]:
    if el['type'] == 'way':
        return [[(p['lon'], p['lat']) for p in el.get('geometry', [])]]
    # multipolygon: closed outer members only (good enough for car parks)
    return [[(p['lon'], p['lat']) for p in m.get('geometry', [])] for m in el.get('members', []) if m.get('role') == 'outer']


def patch(world_id: str) -> None:
    path = ROOT / 'apps/client/public/worlds' / world_id / 'world.json'
    world = json.loads(path.read_text())
    origin = world['origin']
    kx, kz = frame(origin)
    g = world['grids']['near']
    x0, z0 = g['x0'], g['z0']
    x1, z1 = x0 + (g['nx'] - 1) * g['step'], z0 + (g['nz'] - 1) * g['step']
    bbox = (z0 / kz + origin[1], x0 / kx + origin[0], z1 / kz + origin[1], x1 / kx + origin[0])
    data = fetch(world_id, bbox)
    out = []
    for el in data['elements']:
        tags = el.get('tags', {})
        if tags.get('parking') in SKIP_KINDS or tags.get('location') == 'underground' or tags.get('layer', '0').startswith('-'):
            continue
        for ring in outer_rings(el):
            if len(ring) < 4 or ring[0] != ring[-1]:
                continue
            loc = [((lon - origin[0]) * kx, (lat - origin[1]) * kz) for lon, lat in ring[:-1]]
            if not all(x0 < x < x1 and z0 < z < z1 for x, z in loc):
                continue
            a = area(loc)
            if abs(a) < MIN_AREA:
                continue
            if a < 0:
                loc.reverse()  # counter-clockwise seen from above, as the buildings
            out.append(ring_dm(loc))
    world['parking'] = out
    path.write_text(json.dumps(world, separators=(',', ':'), ensure_ascii=False))
    print(f'{world_id}: {len(out)} car parks', file=sys.stderr)


if __name__ == '__main__':
    for wid in sys.argv[1:]:
        patch(wid)
