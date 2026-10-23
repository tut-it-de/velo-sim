#!/usr/bin/env python3
"""
Shared builder for real-world routes ("worlds") from open geodata.

Sources
  * Overture Maps Foundation, release RELEASE: roads, water, buildings, land, land use, land cover,
    divisions (place names). Contains data from OpenStreetMap contributors (ODbL) and ESA
    WorldCover (CC BY 4.0).
  * AWS Terrain Tiles (Terrarium encoding; SRTM, EU-DEM/Copernicus and others).

A route script (e.g. tools/geo/feldberg_taunus.py) describes one world with a `Config`, a lap
builder (road graph → closed list of graph nodes) and a segment builder, then calls `build()`:

    import worldgen as wg
    CFG = wg.Config(id='feldberg-taunus', ts_name='feldbergTaunus', ...)
    def make_lap(g): ...            # -> (nodes, info)
    def make_segments(ctx): ...     # -> [{'id', 'name', 'type', 'startM', 'endM'}, ...]
    wg.build(CFG, make_lap, make_segments)

Writes
  packages/routes/src/data/<ts_name>.ts          lap polyline (local metres) + segments
  apps/client/public/worlds/<id>/world.json      buildings, trees, side roads, car parks, lake, places, look
  apps/client/public/worlds/<id>/terrain.bin     height + land-class rasters (3 levels of detail)

Downloads are cached in tools/geo/.cache/<id>/ (Overture extracts) and tools/geo/.cache/dem/
(terrain tiles, shared by all worlds). Requirements: pip install pyarrow shapely networkx numpy pillow
"""
from __future__ import annotations

import json
import math
import sys
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import networkx as nx
import numpy as np
import shapely
from PIL import Image
from shapely.geometry import LineString, MultiPolygon, Polygon, shape

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CACHE_ROOT = HERE / '.cache'
RELEASE = '2026-09-23.1'
STEP = 4.0  # spacing of the generated lap polyline, metres

ROAD_CLASSES = {'primary', 'secondary', 'tertiary', 'trunk', 'unclassified', 'residential', 'living_street'}
MAJOR = {'primary', 'secondary', 'tertiary', 'trunk'}
SIDE_ROAD_WIDTH = {
    'trunk': 7.5, 'primary': 7.0, 'secondary': 6.5, 'tertiary': 5.5, 'unclassified': 4.5,
    'residential': 4.5, 'living_street': 3.5, 'service': 3.2, 'track': 2.6,
}
DEFAULT_ATTRIBUTION = '© OpenStreetMap-Mitwirkende, Overture Maps Foundation, ESA WorldCover; Gelände: AWS Terrain Tiles (EU-DEM, SRTM)'

# land classes (uint8 raster)
GRASS, FOREST, SHRUB, URBAN, GARDEN, FARMLAND, ROCK, WATER, SAND, PARK, ORCHARD, SNOW = range(12)
CLASS_NAMES = ['grass', 'forest', 'shrub', 'urban', 'garden', 'farmland', 'rock', 'water', 'sand', 'park', 'orchard', 'snow']


@dataclass
class Config:
    """Everything that differs between worlds."""

    id: str                    # route id and folder under apps/client/public/worlds
    name: str                  # world name (world.json)
    ts_name: str               # data module packages/routes/src/data/<ts_name>.ts, constants <TS_NAME>_*
    script: str                # generator script, for the header of the generated file
    origin: tuple[float, float]  # (lon, lat) of the local frame
    fetch_far: tuple[float, float, float, float]   # roads, land cover, near DEM (lon0, lat0, lon1, lat1)
    fetch_near: tuple[float, float, float, float]  # buildings, land, land use
    horizon: tuple[float, float, float, float]     # low-resolution DEM for the distant mountains
    # A lake (Overture water feature by name) carved to `water_level`; None = a world without water.
    lake_name: str | None = None
    water_bbox: tuple[float, float, float, float] | None = None
    water_level: float | None = None
    elev_offset: float = 0.0   # added to every DEM sample (corrects a datum offset of the tiles)
    # Look of the world in the client: 'mediterranean' | 'central' | 'alpine'
    flora: str = 'central'
    # Building palette in the client: 'italian' | 'german' | 'alpine'
    architecture: str = 'german'
    max_grade: float = 0.14
    road_classes: set[str] = field(default_factory=lambda: set(ROAD_CLASSES))
    near_margin: float = 3000.0
    near_step: float = 12.0
    far_step: float = 60.0
    horizon_step: float = 250.0
    near_zoom: int = 13
    horizon_zoom: int = 10
    # Place names: a cached JSON list [{name, pt: [lon, lat]}] in the world's cache folder, or None
    # to take localities from Overture divisions plus named peaks.
    places_file: str | None = None
    # Overture division subtypes used for place names (microhoods are mostly squares).
    place_subtypes: tuple[str, ...] = ('locality', 'neighborhood', 'macrohood')
    # Named spots that are no division, e.g. a pass: [(name, lon, lat)]
    extra_places: list[tuple[str, float, float]] = field(default_factory=list)
    attribution: str = DEFAULT_ATTRIBUTION
    cache_dir: Path | None = None  # default: tools/geo/.cache/<id>
    # Tall masts and towers from OpenStreetMap (summit transmitters, observation towers), seen from afar.
    landmarks: bool = True


# ---------------------------------------------------------------------------- local frame

C: Config
ORIGIN = (0.0, 0.0)
KX = KZ = 1.0
CACHE = CACHE_ROOT
ELEV_OFFSET = 0.0


def configure(cfg: Config) -> None:
    """Sets up the local metric frame (x = east, z = north, metres from ORIGIN; equirectangular,
    well below 0.5 % error within the ~50 km of a world) and the cache folder."""
    global C, ORIGIN, KX, KZ, CACHE, ELEV_OFFSET
    C = cfg
    ORIGIN = cfg.origin
    phi = math.radians(ORIGIN[1])
    KX = 111412.84 * math.cos(phi) - 93.5 * math.cos(3 * phi) + 0.118 * math.cos(5 * phi)
    KZ = 111132.92 - 559.82 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi)
    CACHE = cfg.cache_dir or CACHE_ROOT / cfg.id
    ELEV_OFFSET = cfg.elev_offset


def local(lon, lat):
    return (np.asarray(lon) - ORIGIN[0]) * KX, (np.asarray(lat) - ORIGIN[1]) * KZ


def geo(x, z):
    return np.asarray(x) / KX + ORIGIN[0], np.asarray(z) / KZ + ORIGIN[1]


def log(*args):
    print(*args, file=sys.stderr)


# ---------------------------------------------------------------------------- downloads

def overture(theme: str, typ: str, bbox, name: str | None = None, flt=None, tags=False):
    """Features of one Overture type inside bbox (cached as JSON): id, class, subtype, name, geom (GeoJSON),
    with `tags` also the OpenStreetMap tags (source_tags)."""
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
    cols = [c for c in ['id', 'geometry', 'names', 'class', 'subtype', 'height', 'num_floors', 'is_underground', 'connectors', 'elevation']
            + (['source_tags'] if tags else []) if c in d.schema.names]
    rows = []
    for r in d.to_table(filter=f, columns=cols).to_pylist():
        o = {'id': r['id'], 'class': r.get('class'), 'subtype': r.get('subtype'), 'name': (r.get('names') or {}).get('primary'),
             'geom': wkb.loads(r['geometry']).__geo_interface__}
        for k in ('height', 'num_floors', 'is_underground', 'elevation'):
            if r.get(k) is not None:
                o[k] = r[k]
        if tags:
            o['tags'] = dict(r.get('source_tags') or [])
        rows.append(o)
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows))
    log(f'  {typ}: {len(rows)} features')
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
        dem = CACHE_ROOT / 'dem'
        dem.mkdir(parents=True, exist_ok=True)
        for tx in range(self.X0, self.X0 + nx_):
            for ty in range(self.Y0, self.Y0 + ny_):
                p = dem / f'{z}_{tx}_{ty}.png'
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

def build_graph(segments, classes=None):
    """Undirected graph of the road network (nodes = (lon, lat) rounded to 1e-7°), largest component."""
    classes = classes or C.road_classes
    g = nx.Graph()
    for s in segments:
        if s['subtype'] != 'road' or s['class'] not in classes:
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


def nearest(g, lon, lat, classes=None, names=None):
    """Graph node closest to (lon, lat), optionally only on roads of the given classes / names."""
    best, best_d = None, float('inf')
    for n in g.nodes:
        if classes and not any(g.edges[n, m]['cls'] in classes for m in g[n]):
            continue
        if names and not any(g.edges[n, m]['name'] in names for m in g[n]):
            continue
        d = math.hypot((n[0] - lon) * KX, (n[1] - lat) * KZ)
        if d < best_d:
            best, best_d = n, d
    return best


def shortest(g, a, b, avoid: set[str] | None = None, prefer: dict[str, float] | None = None):
    """Shortest path; `avoid` excludes road classes, `prefer` scales edge weights by road name/class
    (e.g. {'L 3004': 0.5} pulls the path onto that road)."""
    def weight(u, v, e):
        if avoid and e['cls'] in avoid:
            return None
        w = e['w']
        if prefer:
            w *= min(prefer.get(e['name'], 1.0), prefer.get(e['cls'], 1.0))
        return w
    return nx.shortest_path(g, a, b, weight=weight if (avoid or prefer) else 'w')


def path_len(g, p):
    return sum(g.edges[u, v]['w'] for u, v in zip(p, p[1:]))


def street_names(g, p):
    return [g.edges[u, v]['name'] for u, v in zip(p, p[1:])]


def find_loop(g, path, names: set[str], exact=False, max_len=1500.0):
    """Shortest detour (not using `path` edges) between two nodes of `path` whose street names match.
    Returns (a, b, length, detour) with detour running from path[a] to path[b]."""
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


def find_any_loop(g, path, tail: int = 60, min_len=40.0, max_len=1500.0):
    """Shortest detour off the last `tail` nodes of `path` that comes back to `path` (a turning loop
    at the far end of an out-and-back leg, whatever the streets are called). Same result as find_loop."""
    h = g.copy()
    h.remove_edges_from(list(zip(path, path[1:])))
    best = None
    first = max(0, len(path) - tail)
    for a in range(first, len(path)):
        for b in range(a + 1, len(path)):
            try:
                alt = nx.shortest_path(h, path[a], path[b], weight='w')
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                continue
            length = path_len(g, alt)
            if length < min_len or length > max_len:
                continue
            # prefer loops at the very end: a loop is worth its length in leg distance
            score = length - path_len(g, path[a:])
            if best is None or score < best[4]:
                best = (a, b, length, alt, score)
    if best is None:
        raise SystemExit('no turning loop near the end of the leg')
    return best[:4]


def via(g, points, prefer: dict[str, float] | None = None, classes=None):
    """Concatenated shortest paths through waypoints given as (lon, lat) or graph nodes."""
    nodes = [p if p in g else nearest(g, p[0], p[1], classes) for p in points]
    out = [nodes[0]]
    for a, b in zip(nodes, nodes[1:]):
        out += shortest(g, a, b, prefer=prefer)[1:]
    return out


def signed_area(nodes) -> float:
    """Shoelace area of a closed node list in local metres; > 0 = counter-clockwise seen from above."""
    x, z = local(np.array([n[0] for n in nodes]), np.array([n[1] for n in nodes]))
    return 0.5 * float(np.sum(x * np.roll(z, -1) - np.roll(x, -1) * z))


def turning_cycle(g, leg, max_len=800.0):
    """Shortest cycle through the last node of `leg` that uses none of the leg's edges — a turning
    loop at the end of a road (e.g. a bus turnaround). Oriented counter-clockwise, as a loop is ridden
    in right-hand traffic: [end, ..., end]."""
    end = leg[-1]
    used = {frozenset(e) for e in zip(leg, leg[1:])}
    best = None
    for m in list(g[end]):
        if frozenset((end, m)) in used:
            continue

        def weight(u, v, e, m=m):
            k = frozenset((u, v))
            return None if (k in used or k == frozenset((end, m))) else e['w']
        try:
            back = nx.shortest_path(g, m, end, weight=weight)
        except nx.NetworkXNoPath:
            continue
        cyc = [end] + back
        length = path_len(g, cyc)
        if length <= max_len and (best is None or length < best[0]):
            best = (length, cyc)
    if best is None:
        raise SystemExit(f'no turning loop at {end}')
    cyc = best[1]
    return cyc if signed_area(cyc[:-1]) > 0 else list(reversed(cyc))


def out_and_back(leg, loop):
    """Nodes of an out-and-back ride along `leg` (start → far end) that turns around through `loop`
    = (a, b, _, detour) from find_loop/find_any_loop: out to leg[b], back through the detour to leg[a],
    then back to the start. The first node is repeated at the end."""
    a, b, _, detour = loop
    return leg[:b + 1] + list(reversed(detour))[1:] + list(reversed(leg[:a]))


def turnaround_points(pts: np.ndarray, radius: float = 9.0) -> np.ndarray:
    """A turning circle at the end of an open polyline in local metres, so an out-and-back lap can
    be closed where the map has no real loop. Ridden like a roundabout in right-hand traffic: bear
    right into it, once around counter-clockwise (seen from above), bear right out of it."""
    end, prev = pts[-1], pts[-2]
    d = (end - prev) / max(np.hypot(*(end - prev)), 1e-9)
    centre = end + d * radius
    a0 = math.atan2(-d[1], -d[0])  # angle of `end` seen from the centre (x east, z north)
    ts = np.linspace(0, 2 * math.pi, 36, endpoint=False)[1:]
    return np.array([centre + radius * np.array([math.cos(a0 + t), math.sin(a0 + t)]) for t in ts])


# ---------------------------------------------------------------------------- profile

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
    σ = 50 m smoothing, shore roads just above the water, grades limited to `max_grade`.
    """
    def disk(radii):
        offs = [(0.0, 0.0)] + [(r * math.cos(a), r * math.sin(a)) for r in radii for a in np.linspace(0, 2 * math.pi, 12, endpoint=False)]
        return np.stack([dem.sample(*geo(path[:, 0] + ox, path[:, 1] + oz)) for ox, oz in offs])

    i = np.clip(np.round((path[:, 0] - near.x0) / near.step).astype(int), 0, near.nx - 1)
    j = np.clip(np.round((path[:, 1] - near.z0) / near.step).astype(int), 0, near.nz - 1)
    built = np.isin(near.cls[j, i], [URBAN, GARDEN])
    raw = np.where(built, disk((8.0, 16.0, 24.0)).min(axis=0), np.percentile(disk((8.0, 16.0)), 25, axis=0))
    elev = circular_gauss(raw.astype(np.float64), 50 / 4.0)
    if lake_local is not None:
        shore = shapely.distance(lake_local.boundary, shapely.points(path))
        w = np.clip((40.0 - shore) / 30.0, 0, 1)
        w = w * w * (3 - 2 * w)
        elev = elev + w * (np.minimum(elev, C.water_level + 2.0 + 0.1 * shore) - elev)
    elev = limit_grade(elev, C.max_grade * STEP)
    return circular_gauss(elev, 3.0)


def unify_passes(path: np.ndarray, elev: np.ndarray, min_gap_m: float = 150.0, step: float = STEP) -> np.ndarray:
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


def resample_closed(pts: np.ndarray, step: float, with_index: bool = False):
    """Closed polyline resampled at (about) `step`; with_index also returns, per new point, the index
    of the source segment it lies on."""
    closed = np.vstack([pts, pts[:1]])
    seg = np.hypot(*np.diff(closed, axis=0).T)
    cum = np.concatenate([[0], np.cumsum(seg)])
    total = cum[-1]
    n = int(round(total / step))
    t = np.arange(n) * total / n
    out = np.column_stack([np.interp(t, cum, closed[:, 0]), np.interp(t, cum, closed[:, 1])])
    if with_index:
        return out, np.clip(np.searchsorted(cum, t, side='right') - 1, 0, len(pts) - 1)
    return out


# Smallest centre-line radius a road class is drawn with (metres). The map draws junction corners and
# switchbacks as sharp kinks; real carriageways turn on arcs. Hairpins whose legs lie closer together
# than twice this radius keep their radius (the shift limit stops the smoothing), the client copes.
MIN_RADIUS = {'trunk': 9.0, 'primary': 8.0, 'secondary': 7.0, 'tertiary': 7.0, 'unclassified': 6.0,
              'residential': 5.5, 'living_street': 5.0, 'service': 5.0}
MAX_SHIFT = 3.0  # how far the smoothed lap may leave the mapped centre line, metres


def circumradius(p: np.ndarray, h: int) -> np.ndarray:
    """Radius of the circle through the points i-h, i, i+h of a closed polyline (inf on straights)."""
    a, b, c = np.roll(p, h, 0), p, np.roll(p, -h, 0)
    ab = np.hypot(*(b - a).T)
    bc = np.hypot(*(c - b).T)
    ca = np.hypot(*(a - c).T)
    cross = np.abs((b - a)[:, 0] * (c - a)[:, 1] - (b - a)[:, 1] * (c - a)[:, 0])
    with np.errstate(divide='ignore', invalid='ignore'):
        return np.where(cross > 1e-9, ab * bc * ca / np.maximum(2 * cross, 1e-12), np.inf)


def limit_radius(p: np.ndarray, rmin: np.ndarray, max_shift: float = MAX_SHIFT, iterations: int = 400) -> np.ndarray:
    """Rounds bends of a closed 1 m polyline that are tighter than `rmin` (per point): local Laplacian
    smoothing around the tight spots, never more than `max_shift` away from the input line. Direction
    independent, so both passes of an out-and-back road get the same line."""
    orig = p.copy()
    p = p.copy()
    for _ in range(iterations):
        bad = circumradius(p, 4) < rmin
        if not bad.any():
            break
        w = np.zeros(len(p))
        for k in range(-6, 7):
            w = np.maximum(w, np.roll(bad, k) * (1 - abs(k) / 7))
        mid = 0.5 * (np.roll(p, 2, 0) + np.roll(p, -2, 0))
        p = p + 0.5 * w[:, None] * (mid - p)
        d = p - orig
        dist = np.hypot(*d.T)
        scale = np.minimum(1.0, max_shift / np.maximum(dist, 1e-9))
        p = orig + d * scale[:, None]
    return p


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
    wl = C.water_level
    shapely.prepare(lake_local)
    inside = shapely.contains_xy(lake_local, grid.X, grid.Z)
    dist = (erosion_depth(inside, 60) + inside) * grid.step
    depth = np.where(inside, 1.6 + np.minimum(dist * 0.22, 45.0), 0)
    h = grid.height
    h = np.where(inside, np.minimum(h, wl) - depth, h)
    # keep the shore dry: land next to the lake never dips under the water plane
    h = np.where(~inside, np.maximum(h, wl + 0.6), h)
    grid.height = h
    grid.cls[inside] = WATER


LAND_COVER = {'forest': FOREST, 'shrub': SHRUB, 'urban': URBAN, 'crop': FARMLAND, 'grass': GRASS, 'barren': ROCK, 'moss': GRASS, 'snow': SNOW, 'wetland': GRASS}
LAND = {'forest': FOREST, 'wood': FOREST, 'grassland': GRASS, 'scrub': SHRUB, 'heath': SHRUB, 'bare_rock': ROCK, 'rock': ROCK,
        'scree': ROCK, 'stone': ROCK, 'beach': SAND, 'sand': SAND, 'fell': GRASS, 'glacier': SNOW}
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


# ---------------------------------------------------------------------------- segments

@dataclass
class Context:
    """What a segment builder gets: the final lap (STEP-spaced local metres) and its elevation."""

    path: np.ndarray
    elev: np.ndarray
    nodes: list
    info: dict

    @property
    def n(self) -> int:
        return len(self.path)

    def passes(self, lon: float, lat: float, radius: float = 6.0) -> list[int]:
        """Lap indices where the ride passes (lon, lat), one per pass (middle of each cluster)."""
        x, z = local(lon, lat)
        d = np.hypot(self.path[:, 0] - x, self.path[:, 1] - z)
        hits = [i for i in range(self.n) if d[i] < radius]
        clusters: list[list[int]] = []
        for i in hits:
            if clusters and i - clusters[-1][-1] < 10:
                clusters[-1].append(i)
            else:
                clusters.append([i])
        return [c[len(c) // 2] for c in clusters]

    def closest(self, lon: float, lat: float, lo: int = 0, hi: int | None = None) -> int:
        """Index of the lap point closest to (lon, lat) within [lo, hi)."""
        x, z = local(lon, lat)
        hi = self.n if hi is None else hi
        d = np.hypot(self.path[lo:hi, 0] - x, self.path[lo:hi, 1] - z)
        return lo + int(np.argmin(d))

    def highest(self, lo: int, hi: int) -> int:
        return lo + int(np.argmax(self.elev[lo:hi]))

    def lowest(self, lo: int, hi: int) -> int:
        return lo + int(np.argmin(self.elev[lo:hi]))

    def flattest(self, lo: int, hi: int, length_m: float = 500.0) -> int:
        """Start index of the flattest stretch of `length_m` within [lo, hi)."""
        k = int(length_m / STEP)
        best, best_i = 1e9, lo
        for i in range(lo, hi - k):
            span = self.elev[i:i + k]
            score = span.max() - span.min()
            if score < best:
                best, best_i = score, i
        return best_i

    def segment(self, id: str, name: str, typ: str, a: int, b: int) -> dict:
        return {'id': id, 'name': name, 'type': typ, 'startM': a * STEP, 'endM': b * STEP}


# ---------------------------------------------------------------------------- the build

def build(cfg: Config, make_lap: Callable, make_segments: Callable[[Context], list]) -> None:
    configure(cfg)
    log('roads …')
    segments = overture('transportation', 'segment', cfg.fetch_far, 'segment')
    lake_local = None
    if cfg.lake_name:
        water = overture('base', 'water', cfg.water_bbox or cfg.fetch_far, 'water')
    g = build_graph(segments)
    nodes, info = make_lap(g)
    lon = np.array([n[0] for n in nodes])
    lat = np.array([n[1] for n in nodes])
    x, z = local(lon, lat)
    pts = np.column_stack([x, z])
    # road class of the segment that starts at each point (the last point closes the lap)
    cls = [g.edges[u, v]['cls'] if g.has_edge(u, v) else 'service' for u, v in zip(nodes, nodes[1:] + nodes[:1])]
    if info.get('turnaround'):
        # open out-and-back without a real loop at the far end: nodes run start → end only
        turn = turnaround_points(pts, info.get('turnaround_radius', 9.0))
        cls = cls[:-1] + [cls[-2]] * (len(turn) + 1) + cls[:-1][::-1][1:len(pts) - 1]
        pts = np.vstack([pts, turn, pts[::-1][1:-1]])
    assert len(cls) == len(pts), (len(cls), len(pts))
    # drop duplicates, round corners (±6 m moving average on a 1 m resampling), widen the bends that are
    # still tighter than the road class allows, resample to STEP
    dense, seg_of = resample_closed(pts, 1.0, with_index=True)
    dense = np.column_stack([circular_smooth(dense[:, 0], 6), circular_smooth(dense[:, 1], 6)])
    rmin = np.array([MIN_RADIUS.get(cls[k], 5.0) if k < len(cls) else 5.0 for k in seg_of])
    before = float(np.sum(np.hypot(*np.diff(np.vstack([dense, dense[:1]]), axis=0).T)))
    tight = int(np.sum(circumradius(dense, 4) < rmin))
    dense = limit_radius(dense, rmin)
    after = float(np.sum(np.hypot(*np.diff(np.vstack([dense, dense[:1]]), axis=0).T)))
    log(f'bends: {tight} m tighter than the class radius, lap {after - before:+.1f} m by rounding them, '
        f'{int(np.sum(circumradius(dense, 4) < rmin))} m left (hairpins with close legs)')
    path = resample_closed(dense, STEP)
    n = len(path)
    lap_m = n * STEP
    log(f'lap {lap_m / 1000:.2f} km, {n} points')

    near_dem = Mosaic(cfg.near_zoom, cfg.fetch_far)
    if cfg.lake_name:
        water = [w for w in water if w.get('name') == cfg.lake_name]
        lake_geo = max((shape(w['geom']) for w in water), key=lambda s: s.area)
        lake_local = to_local_geom(lake_geo.__geo_interface__)

    # ---- terrain rasters
    log('terrain …')
    bx0, bz0 = path.min(axis=0) - cfg.near_margin
    bx1, bz1 = path.max(axis=0) + cfg.near_margin
    near = Grid('near', bx0, bz0, bx1, bz1, cfg.near_step)
    lo0, la0 = near_dem.lon0 + 0.002, near_dem.lat0 + 0.002
    lo1, la1 = near_dem.lon1 - 0.002, near_dem.lat1 - 0.002
    fx0, fz0 = local(lo0, la0)
    fx1, fz1 = local(lo1, la1)
    far = Grid('far', float(fx0), float(fz0), float(fx1), float(fz1), cfg.far_step)
    hz_dem = Mosaic(cfg.horizon_zoom, cfg.horizon)
    hx0, hz0 = local(hz_dem.lon0 + 0.01, hz_dem.lat0 + 0.01)
    hx1, hz1 = local(hz_dem.lon1 - 0.01, hz_dem.lat1 - 0.01)
    horizon = Grid('horizon', float(hx0), float(hz0), float(hx1), float(hz1), cfg.horizon_step)
    for grid, dem in ((near, near_dem), (far, near_dem), (horizon, hz_dem)):
        glon, glat = geo(grid.X, grid.Z)
        grid.height = dem.sample(glon, glat).astype(np.float32)

    log('land classes …')
    land_cover = overture('base', 'land_cover', cfg.fetch_far, 'land_cover')
    land = overture('base', 'land', cfg.fetch_near, 'land')  # also holds single trees and peaks
    land_use = overture('base', 'land_use', cfg.fetch_near, 'land_use')
    paint_classes([near, far], land_cover, [], [])
    paint_classes([near], [], land, land_use)
    for grid in (near, far, horizon):
        if lake_local is not None:
            carve_lake(grid, lake_local)
        # bare rock on steep high ground
        gz, gx = np.gradient(grid.height, grid.step)
        steep = np.hypot(gx, gz) > 1.1
        grid.cls[steep & (grid.cls != WATER)] = ROCK

    # ---- road profile (needs the land classes)
    elev = unify_passes(path, road_profile(path, near_dem, near, lake_local))
    elev = circular_gauss(limit_grade(elev, cfg.max_grade * STEP), 2.0)

    # ---- segments
    segments_out = make_segments(Context(path, elev, nodes, info))
    for s in segments_out:
        a, b = int(s['startM'] / STEP), int(s['endM'] / STEP)
        s['lengthM'] = round(s['endM'] - s['startM'])
        s['avgGrade'] = round((elev[b] - elev[a]) / (s['endM'] - s['startM']) * 100, 1)
    gain = float(np.sum(np.clip(np.diff(np.append(elev, elev[0])), 0, None)))
    log(f'gain {gain:.0f} m, min {elev.min():.0f} max {elev.max():.0f}')
    for s in segments_out:
        log('  segment', s)

    write_route(path, elev, lap_m, gain, segments_out)

    # ---- buildings, trees, roads, places
    log('buildings …')
    nb = (near.x0, near.z0, near.x0 + (near.nx - 1) * near.step, near.z0 + (near.nz - 1) * near.step)
    buildings = build_buildings(overture('buildings', 'building', cfg.fetch_near, 'building'), nb, lake_local)
    trees = [r for r in land if r['class'] in ('tree',) and r['geom']['type'] == 'Point']
    tree_xy = []
    for t in trees:
        tx, tz = local(*t['geom']['coordinates'])
        if nb[0] < tx < nb[2] and nb[1] < tz < nb[3]:
            tree_xy += [int(round(float(tx) * 10)), int(round(float(tz) * 10))]
    lap_edges = {frozenset((u, v)) for u, v in zip(nodes, nodes[1:] + nodes[:1])}
    roads = build_side_roads(segments, lap_edges, set(nodes), path, nb)
    places = []
    for p in place_points(land):
        px, pz = local(*p['pt'][:2])
        if far.x0 < px < far.x0 + far.nx * far.step and far.z0 < pz < far.z0 + far.nz * far.step and p['name']:
            places.append({'name': p['name'], 'x': round(float(px)), 'z': round(float(pz))})
    rings = []
    if lake_local is not None:
        minimap_lake = lake_local.intersection(shapely.box(nb[0] - 4000, nb[1] - 4000, nb[2] + 4000, nb[3] + 4000)).simplify(12)
        for poly in getattr(minimap_lake, 'geoms', [minimap_lake]):
            if isinstance(poly, Polygon) and poly.area > 20000:
                rings.append([[round(c[0]), round(c[1])] for c in poly.exterior.coords])
    water_level = cfg.water_level if lake_local is not None else math.floor(float(horizon.height.min())) - 50.0
    landmarks = build_landmarks(overture('base', 'infrastructure', cfg.fetch_near, 'infrastructure', tags=True), nb) if cfg.landmarks else []
    write_world(near, far, horizon, buildings, tree_xy, roads, places, rings, water_level, landmarks)
    import add_parking  # surface car parks from OpenStreetMap (Overpass), patched into world.json
    add_parking.patch(C.id)


def place_points(land) -> list[dict]:
    """[{name, pt}] for the minimap: the configured file, or Overture localities plus named peaks."""
    if C.places_file:
        return json.loads((CACHE / C.places_file).read_text())
    import pyarrow.compute as pc
    divisions = overture('divisions', 'division', C.fetch_far, 'division', pc.field('subtype').isin(list(C.place_subtypes)))
    cand = [{'name': n, 'pt': [lon, lat]} for n, lon, lat in C.extra_places]
    for d in divisions:
        if d['name'] and d['geom']['type'] == 'Point' and d['subtype'] in C.place_subtypes:
            cand.append({'name': d['name'], 'pt': d['geom']['coordinates']})
    for r in land:
        if r['class'] == 'peak' and r['name'] and r['geom']['type'] == 'Point':
            cand.append({'name': r['name'], 'pt': r['geom']['coordinates']})
    # the same name twice within 1.5 km (locality + macrohood of one town) is one place
    out = []
    for c in cand:
        x, z = local(*c['pt'][:2])
        if not any(o['name'] == c['name'] and math.hypot(float(x) - o['x'], float(z) - o['z']) < 1500 for o in out):
            out.append({**c, 'x': float(x), 'z': float(z)})
    return [{'name': o['name'], 'pt': o['pt']} for o in out]


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
    log(f'  {count} buildings')
    return out


LANDMARK_MIN_HEIGHT = 20.0


def build_landmarks(rows, nb) -> list[dict]:
    """Masts and towers with a mapped height: {kind, name, x, z, h, r}. kind is 'mast' (guyed or
    tubular steel mast, banded red and white above 60 m), 'lattice' (steel lattice), 'telecom'
    (freestanding concrete telecommunication tower) or 'observation' (stone observation tower)."""
    out = []
    for r in rows:
        t = r.get('tags') or {}
        made = t.get('man_made')
        if made not in ('mast', 'tower'):
            continue
        typ = t.get('tower:type', 'communication' if made == 'mast' else '')
        if typ not in ('communication', 'observation', 'radar', 'monitoring'):
            continue
        h = r.get('height')
        if not h or h < LANDMARK_MIN_HEIGHT:
            continue
        construction = t.get('tower:construction', '')
        g = to_local_geom(r['geom'])
        c = g.centroid
        if not (nb[0] < c.x < nb[2] and nb[1] < c.y < nb[3]):
            continue
        if typ == 'observation':
            kind = 'observation'
        elif 'lattice' in construction:
            kind = 'lattice'
        elif made == 'mast' or 'tube' in construction or 'guyed' in construction:
            kind = 'mast'
        else:
            kind = 'telecom'
        default_r = {'mast': 0.9, 'lattice': 2.5, 'telecom': 4.5, 'observation': 3.0}[kind]
        radius = math.sqrt(g.area / math.pi) if g.geom_type in ('Polygon', 'MultiPolygon') else default_r
        out.append({'kind': kind, 'name': r.get('name') or '', 'x': round(float(c.x), 1), 'z': round(float(c.y), 1),
                    'h': round(float(min(h, 400.0)), 1), 'r': round(float(min(max(radius, 0.6), 14.0)), 1)})
    log(f'  {len(out)} landmarks: ' + ', '.join(f"{o['name'] or o['kind']} {o['h']:.0f} m" for o in out))
    return out


# Flags of a side road end (world.json version 2): it meets the lap / other side roads there.
JOIN_LAP_START, JOIN_LAP_END, JOIN_ROAD_START, JOIN_ROAD_END = 1, 2, 4, 8


def build_side_roads(segments, lap_edges, lap_nodes, path, nb):
    """Side roads as a network: [width dm, kind (0 paved, 1 track), flags, ring_dm …] per arm.

    Every road is split where it meets the lap and at its junctions with other side roads, so each
    piece ends exactly in a junction. Ends on the lap are moved onto the smoothed lap centre line (the
    client builds the junction mouth from there); the flags say which ends are junctions.
    """
    pieces = []
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
                if ka == kb:
                    continue
                if frozenset((ka, kb)) in lap_edges:
                    if len(run) >= 2:
                        pieces.append((cls, run))
                    run = []
                    continue
                if not run:
                    run = [ka]
                run.append(kb)
            if len(run) >= 2:
                pieces.append((cls, run))
    # node degree in the side-road network (an end counts once, a node inside a piece twice)
    degree: dict = {}
    for _, run in pieces:
        for k, p in enumerate(run):
            degree[p] = degree.get(p, 0) + (1 if k in (0, len(run) - 1) else 2)
    split_at = {p for p, d in degree.items() if d >= 3} | set(lap_nodes)
    out = []
    for cls, run in pieces:
        cur = [run[0]]
        for p in run[1:]:
            cur.append(p)
            if p in split_at and len(cur) >= 2:
                out.append((cls, cur))
                cur = [p]
        if len(cur) >= 2:
            out.append((cls, cur))
    lap_line = LineString(np.vstack([path, path[:1]]))
    roads = []
    joined = 0
    for cls, run in out:
        xs, zs = local(np.array([p[0] for p in run]), np.array([p[1] for p in run]))
        cs = [tuple(c) for c in LineString(np.column_stack([xs, zs])).simplify(0.8).coords]
        mx = sum(c[0] for c in cs) / len(cs)
        mz = sum(c[1] for c in cs) / len(cs)
        if not (nb[0] < mx < nb[2] and nb[1] < mz < nb[3]):
            continue
        flags = 0
        for end, lap_flag, road_flag in ((0, JOIN_LAP_START, JOIN_ROAD_START), (-1, JOIN_LAP_END, JOIN_ROAD_END)):
            node = run[end]
            if node in lap_nodes:
                # the smoothed lap may have left the map node (rounded corners): end on the lap itself
                foot = lap_line.interpolate(lap_line.project(shapely.Point(cs[end])))
                if math.hypot(foot.x - cs[end][0], foot.y - cs[end][1]) < 12:
                    cs[end] = (foot.x, foot.y)
                    flags |= lap_flag
                    joined += 1
            elif degree.get(node, 0) >= 3:
                flags |= road_flag
        if len(cs) < 2 or math.hypot(cs[-1][0] - cs[0][0], cs[-1][1] - cs[0][1]) < 0.5:
            continue
        roads.append([int(round(SIDE_ROAD_WIDTH[cls] * 10)), 1 if cls == 'track' else 0, flags] + ring_dm(cs))
    log(f'  {len(roads)} side roads, {joined} ends on the lap')
    return roads


# ---------------------------------------------------------------------------- output

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


def const_prefix(ts_name: str) -> str:
    out = ''
    for ch in ts_name:
        out += ('_' + ch) if ch.isupper() else ch.upper()
    return out


def write_route(path, elev, lap_m, gain, segments):
    out_route = ROOT / 'packages/routes/src/data' / f'{C.ts_name}.ts'
    out_route.parent.mkdir(parents=True, exist_ok=True)
    P = const_prefix(C.ts_name)
    xs = delta_encode(path[:, 0] * 10)
    zs = delta_encode(path[:, 1] * 10)
    ys = delta_encode(elev * 10)
    seg = json.dumps([{k: s[k] for k in ('id', 'name', 'type', 'startM', 'endM')} for s in segments], ensure_ascii=False)
    body = f"""// Generated by {C.script} – do not edit by hand.
// Lap polyline in local metres (x = east, z = north from {ORIGIN[1]}°N {ORIGIN[0]}°E), 4 m spacing,
// elevation in metres above sea level; all values delta-encoded decimetres.
// Data: © OpenStreetMap contributors, Overture Maps Foundation; terrain: AWS Terrain Tiles (EU-DEM, SRTM).
import type {{ RouteSegment }} from '../types';

export const {P}_ORIGIN: [lon: number, lat: number] = [{ORIGIN[0]}, {ORIGIN[1]}];
export const {P}_LENGTH_M = {lap_m:.0f};
export const {P}_GAIN_M = {gain:.0f};
export const {P}_PATH = {{
  step: 4,
  x: {json.dumps(xs, separators=(',', ':'))},
  z: {json.dumps(zs, separators=(',', ':'))},
  y: {json.dumps(ys, separators=(',', ':'))},
}};
export const {P}_SEGMENTS: RouteSegment[] = {seg};
"""
    out_route.write_text(body)
    log(f'wrote {out_route.relative_to(ROOT)} ({len(body) // 1024} KB)')


def write_world(near, far, horizon, buildings, trees, roads, places, lake_rings, water_level, landmarks=()):
    out_world = ROOT / 'apps/client/public/worlds' / C.id
    out_world.mkdir(parents=True, exist_ok=True)
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
    (out_world / 'terrain.bin').write_bytes(data)
    world = {
        'version': 2,
        'name': C.name,
        'attribution': C.attribution,
        'origin': list(ORIGIN),
        'waterLevel': water_level,
        'grids': meta,
        'terrainBytes': len(data),
        'classes': CLASS_NAMES,
        'lake': lake_rings,
        'places': places,
        'buildings': buildings,
        'trees': trees,
        'roads': roads,
        'landmarks': list(landmarks),
        'look': {'flora': C.flora, 'architecture': C.architecture},
    }
    text = json.dumps(world, separators=(',', ':'), ensure_ascii=False)
    (out_world / 'world.json').write_text(text)
    log(f'wrote terrain.bin ({len(data) // 1024} KB), world.json ({len(text) // 1024} KB)')
