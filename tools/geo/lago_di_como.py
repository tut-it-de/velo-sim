#!/usr/bin/env python3
"""
Builds the world "Lago di Como – Bellagio Loop" from open geodata.

Sources
  * Overture Maps Foundation, release RELEASE: roads, water, buildings, land, land use,
    land cover. Contains data from OpenStreetMap contributors (ODbL) and ESA WorldCover (CC BY 4.0).
  * AWS Terrain Tiles (Terrarium encoding; SRTM, EU-DEM/Copernicus and others).

Run from the repository root (downloads are cached in tools/geo/.cache):
  pip install pyarrow shapely networkx numpy pillow
  python3 tools/geo/lago_di_como.py

Writes
  packages/routes/src/data/lagoDiComo.ts             lap polyline (local metres) + segments
  apps/client/public/worlds/lago-di-como/world.json  buildings, trees, side roads, lake, places
  apps/client/public/worlds/lago-di-como/terrain.bin height + land-class rasters (3 levels of detail)

The lap uses real roads only: Bellagio lakefront (Piazza Mazzini) → Via Valassina →
SS583 along the lake to Limonta (turn via Via Trento) → SP41 up to Civenna (turn via
Via Roma) → back down to Bellagio. Out-and-back legs are ridden on the right-hand lane.
"""
from __future__ import annotations

import json
import math
import struct
import sys
import urllib.request
from pathlib import Path

import networkx as nx
import numpy as np
import shapely
from PIL import Image
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, shape

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CACHE = HERE / '.cache'
OUT_ROUTE = ROOT / 'packages/routes/src/data/lagoDiComo.ts'
OUT_WORLD = ROOT / 'apps/client/public/worlds/lago-di-como'
RELEASE = '2026-09-23.1'

# Local metric frame: x = east, z = north, metres from ORIGIN (equirectangular, <0.3 % error here).
ORIGIN = (9.265, 45.96)
_phi = math.radians(ORIGIN[1])
KX = 111412.84 * math.cos(_phi) - 93.5 * math.cos(3 * _phi) + 0.118 * math.cos(5 * _phi)
KZ = 111132.92 - 559.82 * math.cos(2 * _phi) + 1.175 * math.cos(4 * _phi)

# The terrain model has the lake at 189 m; the real mean level of Lake Como is ~198 m.
ELEV_OFFSET = 9.0
WATER_LEVEL = 198.0

FETCH_FAR = (9.12, 45.83, 9.40, 46.03)   # roads, water, land cover
FETCH_NEAR = (9.20, 45.90, 9.33, 46.01)  # buildings, land, land use
NEAR_MARGIN = 3000.0
NEAR_STEP = 12.0
FAR_STEP = 60.0
HORIZON_STEP = 250.0

ROAD_CLASSES = {'primary', 'secondary', 'tertiary', 'trunk', 'unclassified', 'residential', 'living_street'}
SIDE_ROAD_WIDTH = {
    'trunk': 7.5, 'primary': 7.0, 'secondary': 6.5, 'tertiary': 5.5, 'unclassified': 4.5,
    'residential': 4.5, 'living_street': 3.5, 'service': 3.2, 'track': 2.6,
}

# land classes (uint8 raster)
GRASS, FOREST, SHRUB, URBAN, GARDEN, FARMLAND, ROCK, WATER, SAND, PARK, ORCHARD, SNOW = range(12)


def local(lon, lat):
    return (np.asarray(lon) - ORIGIN[0]) * KX, (np.asarray(lat) - ORIGIN[1]) * KZ


def geo(x, z):
    return np.asarray(x) / KX + ORIGIN[0], np.asarray(z) / KZ + ORIGIN[1]


# ---------------------------------------------------------------------------- downloads

def overture(theme: str, typ: str, bbox, columns, name: str | None = None, flt=None):
    path = CACHE / f'{name or typ}.json'
    if path.exists():
        return json.loads(path.read_text())
    import pyarrow.compute as pc
    import pyarrow.dataset as ds
    import pyarrow.fs as pafs
    from shapely import wkb

    s3 = pafs.S3FileSystem(anonymous=True, region='us-west-2')
    d = ds.dataset(f'overturemaps-us-west-2/release/{RELEASE}/theme={theme}/type={typ}/', filesystem=s3, format='parquet')
    x0, y0, x1, y1 = bbox
    f = (pc.field('bbox', 'xmax') > x0) & (pc.field('bbox', 'xmin') < x1) & (pc.field('bbox', 'ymax') > y0) & (pc.field('bbox', 'ymin') < y1)
    if flt is not None:
        f = f & flt
    cols = [c for c in ['id', 'geometry', 'names', 'class', 'subtype', 'height', 'num_floors', 'is_underground', 'connectors'] if c in d.schema.names]
    rows = []
    for r in d.to_table(filter=f, columns=cols).to_pylist():
        o = {'id': r['id'], 'class': r.get('class'), 'subtype': r.get('subtype'), 'name': (r.get('names') or {}).get('primary'),
             'geom': wkb.loads(r['geometry']).__geo_interface__}
        for k in ('height', 'num_floors', 'is_underground'):
            if r.get(k) is not None:
                o[k] = r[k]
        rows.append(o)
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows))
    print(f'  {typ}: {len(rows)} features', file=sys.stderr)
    return rows


class Mosaic:
    """Terrarium tiles of one zoom level stitched together; bilinear sampling by lon/lat."""

    def __init__(self, z: int, bbox):
        self.z = z
        n = 2 ** z
        x0, y0 = self._tile(bbox[0], bbox[3])
        x1, y1 = self._tile(bbox[2], bbox[1])
        self.X0, self.Y0 = int(x0), int(y0)
        nx_, ny_ = int(x1) - self.X0 + 1, int(y1) - self.Y0 + 1
        self.h = np.zeros((ny_ * 256, nx_ * 256), dtype=np.float32)
        (CACHE / 'dem').mkdir(parents=True, exist_ok=True)
        for tx in range(self.X0, self.X0 + nx_):
            for ty in range(self.Y0, self.Y0 + ny_):
                p = CACHE / 'dem' / f'{z}_{tx}_{ty}.png'
                if not p.exists():
                    urllib.request.urlretrieve(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{tx}/{ty}.png', p)
                a = np.asarray(Image.open(p).convert('RGB')).astype(np.float32)
                self.h[(ty - self.Y0) * 256:(ty - self.Y0 + 1) * 256, (tx - self.X0) * 256:(tx - self.X0 + 1) * 256] = (
                    a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768)
        self.lon0 = self.X0 / n * 360 - 180
        self.lon1 = (self.X0 + nx_) / n * 360 - 180
        self.lat1 = self._lat(self.Y0)
        self.lat0 = self._lat(self.Y0 + ny_)

    def _tile(self, lon, lat):
        n = 2 ** self.z
        lat = np.radians(lat)
        return (np.asarray(lon) + 180) / 360 * n, (1 - np.log(np.tan(lat) + 1 / np.cos(lat)) / math.pi) / 2 * n

    def _lat(self, ty):
        n = 2 ** self.z
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / n))))

    def sample(self, lon, lat):
        tx, ty = self._tile(lon, lat)
        px = np.clip((tx - self.X0) * 256 - 0.5, 0, self.h.shape[1] - 1.001)
        py = np.clip((ty - self.Y0) * 256 - 0.5, 0, self.h.shape[0] - 1.001)
        i = np.floor(px).astype(int)
        j = np.floor(py).astype(int)
        fx = px - i
        fy = py - j
        h = self.h
        return (h[j, i] * (1 - fx) * (1 - fy) + h[j, i + 1] * fx * (1 - fy) + h[j + 1, i] * (1 - fx) * fy + h[j + 1, i + 1] * fx * fy) + ELEV_OFFSET


# ---------------------------------------------------------------------------- road graph + lap

def build_graph(segments):
    g = nx.Graph()
    for s in segments:
        if s['subtype'] != 'road' or s['class'] not in ROAD_CLASSES:
            continue
        geom = s['geom']
        lines = [geom['coordinates']] if geom['type'] == 'LineString' else geom['coordinates']
        for line in lines:
            for a, b in zip(line, line[1:]):
                ka = (round(a[0], 7), round(a[1], 7))
                kb = (round(b[0], 7), round(b[1], 7))
                if ka == kb:
                    continue
                w = math.hypot((kb[0] - ka[0]) * KX, (kb[1] - ka[1]) * KZ)
                g.add_edge(ka, kb, w=w, cls=s['class'], name=s['name'] or '', sid=s['id'])
    biggest = max(nx.connected_components(g), key=len)
    return g.subgraph(biggest).copy()


def nearest(g, lon, lat, classes=None):
    best, best_d = None, float('inf')
    for n in g.nodes:
        if classes and not any(g.edges[n, m]['cls'] in classes for m in g[n]):
            continue
        d = math.hypot((n[0] - lon) * KX, (n[1] - lat) * KZ)
        if d < best_d:
            best, best_d = n, d
    return best


def path_len(g, p):
    return sum(g.edges[u, v]['w'] for u, v in zip(p, p[1:]))


def find_loop(g, path, names: set[str], exact=False, max_len=1500.0):
    """Shortest detour (not using `path` edges) between two nodes of `path` whose street names match."""
    h = g.copy()
    h.remove_edges_from(list(zip(path, path[1:])))
    best = None
    for a in range(len(path)):
        for b in range(a + 1, len(path)):
            try:
                alt = nx.shortest_path(h, path[a], path[b], weight='w')
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                continue
            length = path_len(g, alt)
            if length > max_len:
                continue
            got = {g.edges[u, v]['name'] for u, v in zip(alt, alt[1:]) if g.edges[u, v]['name']}
            if (got == names) if exact else names <= got:
                if best is None or length < best[2]:
                    best = (a, b, length, alt)
    if best is None:
        raise SystemExit(f'no loop with streets {names}')
    return best


def build_lap(g):
    sp = lambda a, b: nx.shortest_path(g, a, b, weight='w')  # noqa: E731
    major = {'primary', 'secondary', 'tertiary', 'trunk'}
    bellagio = nearest(g, 9.2613, 45.9873, major)
    civenna = nearest(g, 9.2711, 45.9368, major)
    limonta = nearest(g, 9.2698, 45.9571, major)
    magreglio = nearest(g, 9.2621, 45.9207, major)
    onno = nearest(g, 9.2934, 45.9115, major)

    to_civenna = sp(bellagio, civenna)
    to_limonta = sp(bellagio, limonta)
    j = 0
    while to_civenna[j] == to_limonta[j]:
        j += 1
    junction = to_civenna[j - 1]                  # SP41 leaves the SS583 above Bellagio
    main = list(reversed(to_civenna[:j]))         # junction → Bellagio (Via Valassina)

    # Bellagio: lakefront past Piazza Mazzini, back up through Via Garibaldi
    a_idx, b_idx, _, lakefront = find_loop(g, main, {'Piazza Giuseppe Mazzini'})
    assert b_idx == len(main) - 1, 'Bellagio loop should end in the town centre'
    mazzini = [i for i, (u, v) in enumerate(zip(lakefront, lakefront[1:])) if g.edges[u, v]['name'] == 'Piazza Giuseppe Mazzini']
    s_idx = mazzini[len(mazzini) // 2]
    start = lakefront[s_idx:]                     # Piazza Mazzini → Via Roma → Via Garibaldi (town centre)
    finish = lakefront[:s_idx + 1]                # Via Valassina → lakefront → Piazza Mazzini

    # Limonta: out along the lake, around the block via Via Trento
    lake_leg = sp(junction, onno)
    l1, l2, _, trento = find_loop(g, lake_leg, {'Via Trento'}, exact=True)
    # Civenna: up the SP41, back through the village on Via Roma
    climb_leg = sp(junction, magreglio)
    c1, c2, _, roma = find_loop(g, climb_leg, {'Via Roma'}, exact=True)

    up_town = list(reversed(main))                # Bellagio centre → junction
    nodes = (start + up_town[up_town.index(start[-1]) + 1:]
             + lake_leg[1:l2 + 1] + list(reversed(trento))[1:] + list(reversed(lake_leg[:l1]))
             + climb_leg[1:c2 + 1] + list(reversed(roma))[1:] + list(reversed(climb_leg[:c1]))
             + main[1:a_idx + 1] + finish[1:])
    assert nodes[0] == nodes[-1], 'lap must close'
    return nodes[:-1], {'junction': junction}


def limit_grade(y: np.ndarray, max_step: float, iterations: int = 2000) -> np.ndarray:
    """Relaxes steps steeper than `max_step` symmetrically (keeps the profile direction-independent)."""
    y = y.copy()
    for _ in range(iterations):
        d = np.roll(y, -1) - y
        e = np.sign(d) * np.clip(np.abs(d) - max_step, 0, None)
        if np.abs(e).max() < 1e-3:
            break
        y += 0.25 * (e - np.roll(e, 1))
    return y


def road_profile(path, dem, near, lake_local):
    """Road elevation from a surface model (it contains trees and roofs and smooths steep slopes).

    Lower quartile of a 16 m disk around each point, the minimum of a 24 m disk in built-up areas,
    σ = 50 m smoothing, shore roads just above the water, grades limited to 14 %.
    """
    def disk(radii):
        offs = [(0.0, 0.0)] + [(r * math.cos(a), r * math.sin(a)) for r in radii for a in np.linspace(0, 2 * math.pi, 12, endpoint=False)]
        return np.stack([dem.sample(*geo(path[:, 0] + ox, path[:, 1] + oz)) for ox, oz in offs])

    i = np.clip(np.round((path[:, 0] - near.x0) / near.step).astype(int), 0, near.nx - 1)
    j = np.clip(np.round((path[:, 1] - near.z0) / near.step).astype(int), 0, near.nz - 1)
    built = np.isin(near.cls[j, i], [URBAN, GARDEN])
    raw = np.where(built, disk((8.0, 16.0, 24.0)).min(axis=0), np.percentile(disk((8.0, 16.0)), 25, axis=0))
    elev = circular_gauss(raw.astype(np.float64), 50 / 4.0)
    shore = shapely.distance(lake_local.boundary, shapely.points(path))
    w = np.clip((40.0 - shore) / 30.0, 0, 1)
    w = w * w * (3 - 2 * w)
    elev = elev + w * (np.minimum(elev, WATER_LEVEL + 2.0 + 0.1 * shore) - elev)
    elev = limit_grade(elev, 0.14 * 4.0)
    return circular_gauss(elev, 3.0)


def unify_passes(path: np.ndarray, elev: np.ndarray, min_gap_m: float = 150.0, step: float = 4.0) -> np.ndarray:
    """Out-and-back sections are the same road: both directions get the same elevation there."""
    n = len(path)
    pts = shapely.points(path)
    tree = shapely.STRtree(pts)
    src, dst = tree.query(pts, predicate='dwithin', distance=6.0)
    gap = np.abs(src - dst)
    gap = np.minimum(gap, n - gap) * step
    keep = gap > min_gap_m
    src, dst = src[keep], dst[keep]
    out = elev.copy()
    for _ in range(2):
        new = out.copy()
        for i in np.unique(src):
            cand = dst[src == i]
            best_d, best_e = 1e9, 0.0
            for j in cand:
                for k in (j - 1, j):  # project onto both neighbouring segments of the other pass
                    a, b = path[k % n], path[(k + 1) % n]
                    ab = b - a
                    t = float(np.clip(np.dot(path[i] - a, ab) / max(np.dot(ab, ab), 1e-9), 0, 1))
                    d = float(np.hypot(*(a + t * ab - path[i])))
                    if d < best_d:
                        best_d, best_e = d, out[k % n] + t * (out[(k + 1) % n] - out[k % n])
            w = float(np.clip((6.0 - best_d) / 3.5, 0, 1))
            w = w * w * (3 - 2 * w)
            new[i] = out[i] + 0.5 * w * (best_e - out[i])
        out = new
    return out


def resample_closed(pts: np.ndarray, step: float) -> np.ndarray:
    closed = np.vstack([pts, pts[:1]])
    seg = np.hypot(*np.diff(closed, axis=0).T)
    cum = np.concatenate([[0], np.cumsum(seg)])
    total = cum[-1]
    n = int(round(total / step))
    t = np.arange(n) * total / n
    return np.column_stack([np.interp(t, cum, closed[:, 0]), np.interp(t, cum, closed[:, 1])])


def circular_smooth(v: np.ndarray, half: int) -> np.ndarray:
    if half <= 0:
        return v.copy()
    k = np.ones(2 * half + 1) / (2 * half + 1)
    padded = np.concatenate([v[-half:], v, v[:half]])
    return np.convolve(padded, k, mode='valid')


def circular_gauss(v: np.ndarray, sigma: float) -> np.ndarray:
    half = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-half, half + 1) / sigma) ** 2)
    k /= k.sum()
    padded = np.concatenate([v[-half:], v, v[:half]])
    return np.convolve(padded, k, mode='valid')


# ---------------------------------------------------------------------------- rasters

class Grid:
    def __init__(self, name, x0, z0, x1, z1, step):
        self.name = name
        self.step = step
        self.nx = int(math.ceil((x1 - x0) / step)) + 1
        self.nz = int(math.ceil((z1 - z0) / step)) + 1
        self.x0 = math.floor(x0 / step) * step
        self.z0 = math.floor(z0 / step) * step
        self.xs = self.x0 + np.arange(self.nx) * step
        self.zs = self.z0 + np.arange(self.nz) * step
        self.X, self.Z = np.meshgrid(self.xs, self.zs)
        self.height = None
        self.cls = np.full((self.nz, self.nx), GRASS, dtype=np.uint8)

    def paint(self, geom_local, value):
        if geom_local.is_empty:
            return
        minx, minz, maxx, maxz = geom_local.bounds
        i0 = max(0, int((minx - self.x0) / self.step))
        i1 = min(self.nx, int((maxx - self.x0) / self.step) + 2)
        j0 = max(0, int((minz - self.z0) / self.step))
        j1 = min(self.nz, int((maxz - self.z0) / self.step) + 2)
        if i0 >= i1 or j0 >= j1:
            return
        shapely.prepare(geom_local)
        inside = shapely.contains_xy(geom_local, self.X[j0:j1, i0:i1], self.Z[j0:j1, i0:i1])
        self.cls[j0:j1, i0:i1][inside] = value


def to_local_geom(geojson):
    g = shape(geojson)
    return shapely.transform(g, lambda c: np.column_stack(local(c[:, 0], c[:, 1])))


def erosion_depth(mask: np.ndarray, iterations: int) -> np.ndarray:
    """Number of 4-neighbour erosion steps each cell survives (cheap distance-to-shore)."""
    depth = np.zeros(mask.shape, dtype=np.float32)
    cur = mask.copy()
    for _ in range(iterations):
        nxt = cur.copy()
        nxt[1:, :] &= cur[:-1, :]
        nxt[:-1, :] &= cur[1:, :]
        nxt[:, 1:] &= cur[:, :-1]
        nxt[:, :-1] &= cur[:, 1:]
        depth += nxt
        cur = nxt
    return depth


def carve_lake(grid: Grid, lake_local):
    shapely.prepare(lake_local)
    inside = shapely.contains_xy(lake_local, grid.X, grid.Z)
    dist = (erosion_depth(inside, 60) + inside) * grid.step
    depth = np.where(inside, 1.6 + np.minimum(dist * 0.22, 45.0), 0)
    h = grid.height
    h = np.where(inside, np.minimum(h, WATER_LEVEL) - depth, h)
    # keep the shore dry: land next to the lake never dips under the water plane
    h = np.where(~inside, np.maximum(h, WATER_LEVEL + 0.6), h)
    grid.height = h
    grid.cls[inside] = WATER


LAND_COVER = {'forest': FOREST, 'shrub': SHRUB, 'urban': URBAN, 'crop': FARMLAND, 'grass': GRASS, 'barren': ROCK, 'moss': GRASS, 'snow': SNOW, 'wetland': GRASS}
LAND = {'forest': FOREST, 'wood': FOREST, 'grassland': GRASS, 'scrub': SHRUB, 'heath': SHRUB, 'bare_rock': ROCK, 'rock': ROCK,
        'scree': ROCK, 'stone': ROCK, 'beach': SAND, 'sand': SAND, 'fell': GRASS}
LAND_USE = {'garden': GARDEN, 'residential': URBAN, 'meadow': FARMLAND, 'farmland': FARMLAND, 'grass': PARK, 'park': PARK,
            'pitch': PARK, 'recreation_ground': PARK, 'cemetery': PARK, 'grave_yard': PARK, 'orchard': ORCHARD, 'vineyard': ORCHARD,
            'plaza': URBAN, 'pedestrian': URBAN, 'retail': URBAN, 'industrial': URBAN, 'school': URBAN, 'farmyard': FARMLAND,
            'playground': PARK, 'marina': URBAN, 'allotments': GARDEN, 'plant_nursery': GARDEN, 'camp_site': PARK, 'works': URBAN}


def paint_classes(grids, land_cover, land, land_use):
    layers = [(land_cover, 'subtype', LAND_COVER), (land, 'class', LAND), (land_use, 'class', LAND_USE)]
    for rows, key, table in layers:
        for r in rows:
            v = table.get(r.get(key))
            if v is None or r['geom']['type'] not in ('Polygon', 'MultiPolygon'):
                continue
            g = to_local_geom(r['geom'])
            for grid in grids:
                grid.paint(g, v)


# ---------------------------------------------------------------------------- output helpers

def delta_encode(values) -> list[int]:
    out, prev = [], 0
    for v in values:
        v = int(round(v))
        out.append(v - prev)
        prev = v
    return out


def ring_dm(coords) -> list[int]:
    """Flattened, delta-encoded decimetre coordinates."""
    flat = []
    for x, z in coords:
        flat += [x * 10, z * 10]
    xs = delta_encode(flat[0::2])
    zs = delta_encode(flat[1::2])
    return [v for pair in zip(xs, zs) for v in pair]


def main():
    print('roads …', file=sys.stderr)
    segments = overture('transportation', 'segment', FETCH_FAR, None, 'segment')
    water = overture('base', 'water', (9.05, 45.78, 9.45, 46.10), None, 'water')
    g = build_graph(segments)
    nodes, info = build_lap(g)
    lon = np.array([n[0] for n in nodes])
    lat = np.array([n[1] for n in nodes])
    x, z = local(lon, lat)
    pts = np.column_stack([x, z])
    # drop duplicates, round corners (±6 m moving average on a 1 m resampling), resample to 4 m
    dense = resample_closed(pts, 1.0)
    dense = np.column_stack([circular_smooth(dense[:, 0], 6), circular_smooth(dense[:, 1], 6)])
    path = resample_closed(dense, 4.0)
    n = len(path)
    lap_m = n * 4.0
    print(f'lap {lap_m / 1000:.2f} km, {n} points', file=sys.stderr)

    near_dem = Mosaic(13, FETCH_FAR)
    water = [w for w in water if w.get('name') == 'Lago di Como']
    lake_geo = max((shape(w['geom']) for w in water), key=lambda s: s.area)
    lake_local = to_local_geom(lake_geo.__geo_interface__)

    # ---- terrain rasters
    print('terrain …', file=sys.stderr)
    bx0, bz0 = path.min(axis=0) - NEAR_MARGIN
    bx1, bz1 = path.max(axis=0) + NEAR_MARGIN
    near = Grid('near', bx0, bz0, bx1, bz1, NEAR_STEP)
    lo0, la0 = near_dem.lon0 + 0.002, near_dem.lat0 + 0.002
    lo1, la1 = near_dem.lon1 - 0.002, near_dem.lat1 - 0.002
    fx0, fz0 = local(lo0, la0)
    fx1, fz1 = local(lo1, la1)
    far = Grid('far', float(fx0), float(fz0), float(fx1), float(fz1), FAR_STEP)
    hz_dem = Mosaic(10, (8.85, 45.65, 9.75, 46.30))
    hx0, hz0 = local(hz_dem.lon0 + 0.01, hz_dem.lat0 + 0.01)
    hx1, hz1 = local(hz_dem.lon1 - 0.01, hz_dem.lat1 - 0.01)
    horizon = Grid('horizon', float(hx0), float(hz0), float(hx1), float(hz1), HORIZON_STEP)
    for grid, dem in ((near, near_dem), (far, near_dem), (horizon, hz_dem)):
        glon, glat = geo(grid.X, grid.Z)
        grid.height = dem.sample(glon, glat).astype(np.float32)

    print('land classes …', file=sys.stderr)
    land_cover = overture('base', 'land_cover', FETCH_FAR, None, 'land_cover')
    land = overture('base', 'land', FETCH_NEAR, None, 'land')  # also holds single trees
    land_use = overture('base', 'land_use', FETCH_NEAR, None, 'land_use')
    paint_classes([near, far], land_cover, [], [])
    paint_classes([near], [], land, land_use)
    for grid in (near, far, horizon):
        carve_lake(grid, lake_local)
        # bare rock on steep high ground
        gz, gx = np.gradient(grid.height, grid.step)
        steep = np.hypot(gx, gz) > 1.1
        grid.cls[steep & (grid.cls != WATER)] = ROCK

    # ---- road profile (needs the land classes)
    elev = unify_passes(path, road_profile(path, near_dem, near, lake_local))
    elev = circular_gauss(limit_grade(elev, 0.14 * 4.0), 2.0)

    # ---- segments
    jx, jz = local(info['junction'][0], info['junction'][1])
    dj = np.hypot(path[:, 0] - jx, path[:, 1] - jz)
    passes = [i for i in range(n) if dj[i] < 6]
    clusters = []
    for i in passes:
        if clusters and i - clusters[-1][-1] < 10:
            clusters[-1].append(i)
        else:
            clusters.append([i])
    # the junction is passed four times: up from town, back from the lake, back from Civenna, ... (see lap order)
    jpass = [c[len(c) // 2] for c in clusters]
    assert len(jpass) == 3, jpass
    climb_start = jpass[1]
    turn = climb_start + int(np.argmax(dj[climb_start:jpass[2]]))  # Civenna, farthest from the junction
    top = climb_start + int(np.argmax(elev[climb_start:turn]))
    # flattest 500 m on the outbound lake leg
    lake_a, lake_b = jpass[0], jpass[0] + (jpass[1] - jpass[0]) // 2
    best, best_i = 1e9, lake_a
    for i in range(lake_a + 10, lake_b - 125):
        span = elev[i:i + 125]
        score = span.max() - span.min()
        if score < best:
            best, best_i = score, i
    segments_out = [
        {'id': 'salita-civenna', 'name': 'Salita di Civenna', 'type': 'climb', 'startM': climb_start * 4.0, 'endM': top * 4.0},
        {'id': 'lungolago-limonta', 'name': 'Lungolago Limonta', 'type': 'sprint', 'startM': best_i * 4.0, 'endM': (best_i + 125) * 4.0},
    ]
    # descent: from the highest point after the Civenna turn down to the junction
    back_top = turn + int(np.argmax(elev[turn:jpass[2]]))
    segments_out.append({'id': 'discesa-bellagio', 'name': 'Discesa su Bellagio', 'type': 'descent', 'startM': back_top * 4.0, 'endM': jpass[2] * 4.0})
    for s in segments_out:
        a, b = int(s['startM'] / 4), int(s['endM'] / 4)
        s['lengthM'] = round(s['endM'] - s['startM'])
        s['avgGrade'] = round((elev[b] - elev[a]) / (s['endM'] - s['startM']) * 100, 1)
    gain = float(np.sum(np.clip(np.diff(np.append(elev, elev[0])), 0, None)))
    print(f'gain {gain:.0f} m, min {elev.min():.0f} max {elev.max():.0f}', file=sys.stderr)
    for s in segments_out:
        print('  segment', s, file=sys.stderr)

    write_route(path, elev, lap_m, gain, segments_out)

    # ---- buildings, trees, roads, places
    print('buildings …', file=sys.stderr)
    nb = (near.x0, near.z0, near.x0 + (near.nx - 1) * near.step, near.z0 + (near.nz - 1) * near.step)
    buildings = build_buildings(overture('buildings', 'building', FETCH_NEAR, None, 'building'), nb, lake_local)
    trees = [r for r in land if r['class'] in ('tree',) and r['geom']['type'] == 'Point']
    tree_xy = []
    for t in trees:
        tx, tz = local(*t['geom']['coordinates'])
        if nb[0] < tx < nb[2] and nb[1] < tz < nb[3]:
            tree_xy += [int(round(float(tx) * 10)), int(round(float(tz) * 10))]
    lap_edges = {frozenset((u, v)) for u, v in zip(nodes, nodes[1:] + nodes[:1])}
    roads = build_side_roads(segments, lap_edges, nb)
    places = []
    for p in json.loads((CACHE / 'localities.json').read_text()):
        px, pz = local(*p['pt'][:2])
        if far.x0 < px < far.x0 + far.nx * far.step and far.z0 < pz < far.z0 + far.nz * far.step and p['name']:
            places.append({'name': p['name'], 'x': round(float(px)), 'z': round(float(pz))})
    minimap_lake = lake_local.intersection(shapely.box(nb[0] - 4000, nb[1] - 4000, nb[2] + 4000, nb[3] + 4000)).simplify(12)
    rings = []
    for poly in getattr(minimap_lake, 'geoms', [minimap_lake]):
        if isinstance(poly, Polygon) and poly.area > 20000:
            rings.append([[round(c[0]), round(c[1])] for c in poly.exterior.coords])
    write_world(near, far, horizon, buildings, tree_xy, roads, places, rings)


def build_buildings(rows, nb, lake_local):
    out = []
    count = 0
    for r in rows:
        if r.get('is_underground') or r['geom']['type'] not in ('Polygon', 'MultiPolygon'):
            continue
        g = to_local_geom(r['geom'])
        polys = list(g.geoms) if isinstance(g, MultiPolygon) else [g]
        for p in polys:
            c = p.centroid
            if not (nb[0] < c.x < nb[2] and nb[1] < c.y < nb[3]):
                continue
            area = p.area
            if area < 12:
                continue
            p = shapely.orient_polygons(Polygon(p.exterior).simplify(0.4), exterior_cw=False) if hasattr(shapely, 'orient_polygons') else shapely.geometry.polygon.orient(Polygon(p.exterior).simplify(0.4), 1.0)
            coords = list(p.exterior.coords)[:-1]
            if len(coords) < 3:
                continue
            h = r.get('height')
            if not h:
                floors = r.get('num_floors')
                if floors:
                    h = floors * 3.1 + 1.5
                elif r.get('class') in ('church', 'cathedral', 'chapel'):
                    h = 14.0
                elif r.get('class') == 'greenhouse':
                    h = 3.0
                else:
                    h = 6.2 if area < 60 else 8.5 if area < 160 else 11.0 if area < 450 else 13.0
            h = float(min(max(h, 2.5), 60.0))
            rect = p.minimum_rotated_rectangle
            hip = 1 if (area > 30 and area < 1600 and p.area / max(rect.area, 1e-6) > 0.82 and r.get('class') != 'greenhouse') else 0
            kind = 2 if r.get('class') in ('church', 'cathedral', 'chapel') else hip
            out.append([int(round(h * 10)), kind] + ring_dm(coords))
            count += 1
    print(f'  {count} buildings', file=sys.stderr)
    return out


def build_side_roads(segments, lap_edges, nb):
    out = []
    for s in segments:
        cls = s['class']
        if s['subtype'] != 'road' or cls not in SIDE_ROAD_WIDTH:
            continue
        geom = s['geom']
        lines = [geom['coordinates']] if geom['type'] == 'LineString' else geom['coordinates']
        for line in lines:
            # split where the segment runs along the lap
            run = []
            for a, b in zip(line, line[1:]):
                ka = (round(a[0], 7), round(a[1], 7))
                kb = (round(b[0], 7), round(b[1], 7))
                if frozenset((ka, kb)) in lap_edges:
                    if len(run) >= 2:
                        out.append((cls, run))
                    run = []
                    continue
                if not run:
                    run = [ka]
                run.append(kb)
            if len(run) >= 2:
                out.append((cls, run))
    roads = []
    for cls, run in out:
        xs, zs = local(np.array([p[0] for p in run]), np.array([p[1] for p in run]))
        ls = LineString(np.column_stack([xs, zs])).simplify(0.8)
        cs = list(ls.coords)
        mx = sum(c[0] for c in cs) / len(cs)
        mz = sum(c[1] for c in cs) / len(cs)
        if not (nb[0] < mx < nb[2] and nb[1] < mz < nb[3]):
            continue
        roads.append([int(round(SIDE_ROAD_WIDTH[cls] * 10)), 1 if cls == 'track' else 0] + ring_dm(cs))
    print(f'  {len(roads)} side roads', file=sys.stderr)
    return roads


def write_route(path, elev, lap_m, gain, segments):
    OUT_ROUTE.parent.mkdir(parents=True, exist_ok=True)
    xs = delta_encode(path[:, 0] * 10)
    zs = delta_encode(path[:, 1] * 10)
    ys = delta_encode(elev * 10)
    seg = json.dumps([{k: s[k] for k in ('id', 'name', 'type', 'startM', 'endM')} for s in segments], ensure_ascii=False)
    body = f"""// Generated by tools/geo/lago_di_como.py – do not edit by hand.
// Lap polyline in local metres (x = east, z = north from {ORIGIN[1]}°N {ORIGIN[0]}°E), 4 m spacing,
// elevation in metres above sea level; all values delta-encoded decimetres.
// Data: © OpenStreetMap contributors, Overture Maps Foundation; terrain: AWS Terrain Tiles (EU-DEM, SRTM).
import type {{ RouteSegment }} from '../types';

export const LAGO_DI_COMO_ORIGIN: [lon: number, lat: number] = [{ORIGIN[0]}, {ORIGIN[1]}];
export const LAGO_DI_COMO_LENGTH_M = {lap_m:.0f};
export const LAGO_DI_COMO_GAIN_M = {gain:.0f};
export const LAGO_DI_COMO_PATH = {{
  step: 4,
  x: {json.dumps(xs, separators=(',', ':'))},
  z: {json.dumps(zs, separators=(',', ':'))},
  y: {json.dumps(ys, separators=(',', ':'))},
}};
export const LAGO_DI_COMO_SEGMENTS: RouteSegment[] = {seg};
"""
    OUT_ROUTE.write_text(body)
    print(f'wrote {OUT_ROUTE.relative_to(ROOT)} ({len(body) // 1024} KB)', file=sys.stderr)


def write_world(near, far, horizon, buildings, trees, roads, places, lake_rings):
    OUT_WORLD.mkdir(parents=True, exist_ok=True)
    blobs = []
    meta = {}
    offset = 0
    for grid in (near, far, horizon):
        h = np.clip(np.round(grid.height * 10), 0, 65535).astype('<u2')
        meta[grid.name] = {'x0': grid.x0, 'z0': grid.z0, 'step': grid.step, 'nx': grid.nx, 'nz': grid.nz, 'heightOffset': offset}
        blobs.append(h.tobytes())
        offset += h.nbytes
    for grid in (near, far, horizon):
        meta[grid.name]['classOffset'] = offset
        blobs.append(grid.cls.tobytes())
        offset += grid.cls.nbytes
    data = b''.join(blobs)
    (OUT_WORLD / 'terrain.bin').write_bytes(data)
    world = {
        'version': 1,
        'name': 'Lago di Como – Bellagio Loop',
        'attribution': '© OpenStreetMap-Mitwirkende, Overture Maps Foundation, ESA WorldCover; Gelände: AWS Terrain Tiles (EU-DEM, SRTM)',
        'origin': list(ORIGIN),
        'waterLevel': WATER_LEVEL,
        'grids': meta,
        'terrainBytes': len(data),
        'classes': ['grass', 'forest', 'shrub', 'urban', 'garden', 'farmland', 'rock', 'water', 'sand', 'park', 'orchard', 'snow'],
        'lake': lake_rings,
        'places': places,
        'buildings': buildings,
        'trees': trees,
        'roads': roads,
    }
    text = json.dumps(world, separators=(',', ':'), ensure_ascii=False)
    (OUT_WORLD / 'world.json').write_text(text)
    print(f'wrote terrain.bin ({len(data) // 1024} KB), world.json ({len(text) // 1024} KB)', file=sys.stderr)


if __name__ == '__main__':
    main()
