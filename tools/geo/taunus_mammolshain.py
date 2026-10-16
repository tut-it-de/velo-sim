#!/usr/bin/env python3
"""
Builds the world "Taunus – Mammolshainer Stich" (see worldgen.py for sources and outputs).

Run from the repository root:
  python3 tools/geo/taunus_mammolshain.py

A closed lap over the classic climb of the Eschborn–Frankfurt race, start and finish at the
Berliner Platz in Kronberg:
  Frankfurter Straße → Bahnhofstraße → Oberhöchstädter Straße → Schönberger Straße (Schönberg)
  → Altkönigstraße / Am Gänsborn / Stuhlbergstraße (Oberhöchstadt) → Am Kirchberg → Sodener Straße
  → Am Schanzenfeld → Schwalbacher Straße → Kronthal → Mammolshainer Stich (Kronthaler Straße,
  Am Steinbruch, Am Mönchswald, Mammolshainer Weg) → Königsteiner Kreisel (counter-clockwise)
  → Frankfurter Straße (Königstein) → Falkensteiner Straße (Falkenstein) → Kronberger Straße
  → B 455 past the Opel-Zoo → exit Kronberg-Nord → Hainstraße → Berliner Platz.

The road graph of worldgen.py is undirected; this script routes on a directed copy that respects
the one-way restrictions of the Overture segments (access_restrictions, cached as access.json).
The one exception is Am Steinbruch: the race and the Strava segment ride the steep one-way lane in
Mammolshain uphill against its direction.
"""
from __future__ import annotations

import json
import math

import networkx as nx

import worldgen as wg

CFG = wg.Config(
    id='taunus-mammolshain',
    name='Taunus – Mammolshainer Stich',
    ts_name='taunusMammolshain',
    script='tools/geo/taunus_mammolshain.py',
    origin=(8.505, 50.18),
    fetch_far=(8.38, 50.12, 8.60, 50.25),
    fetch_near=(8.42, 50.135, 8.59, 50.225),
    horizon=(7.95, 49.85, 9.05, 50.60),
    flora='central',
    architecture='german',
    # Am Steinbruch / end of Kronthaler Straße is the steep bit of the Stich (signposted up to ~20 %)
    max_grade=0.20,
    # Kronberg, Königstein and Oberhöchstadt are densely built: a narrower detail grid keeps world.json small
    near_margin=1800.0,
    extra_places=[
        ('Berliner Platz', 8.51158, 50.17896),
        ('Kronthal', 8.5110, 50.1693),
        ('Burg Kronberg', 8.5066, 50.1810),
        ('Burgruine Königstein', 8.46095, 50.18245),
        ('Burgruine Falkenstein', 8.47664, 50.19009),
        ('Opel-Zoo', 8.49022, 50.18443),
    ],
)

# streets that are ridden against their one-way direction (as in the race)
AGAINST_ONE_WAY = {'Am Steinbruch'}
# where the one-way rules are needed (the lap and its surroundings)
ACCESS_BBOX = (8.44, 50.155, 8.57, 50.21)
PREFER = {'residential': 1.6, 'living_street': 3.0, 'unclassified': 1.6, 'service': 4.0}

BERLINER_PLATZ = (8.51158, 50.17896)
KRONTHAL_JUNCTION = (8.51810, 50.16746)   # Schwalbacher Straße turns off to Kronthal
KRONTHALER_STRASSE = (8.51456, 50.16766)  # start of the named Kronthaler Straße, where the Stich begins
STEINBRUCH = (8.4982, 50.1727)            # Am Steinbruch, the steep lane in Mammolshain
STICH_TOP = (8.48694, 50.17700)           # first crest of Mammolshainer Weg (official top, ~371 m)
KOENIGSTEIN_TURN = (8.46960, 50.18199)    # Frankfurter Straße → Falkensteiner Straße
ZOO_JUNCTION = (8.49358, 50.18716)        # Kronberger Straße meets the B 455 (Opel-Zoo)
HAIN_BEND = (8.51281, 50.18720)           # Hainstraße below the B 455 exit
AM_KIRCHBERG = (8.54052, 50.18104)        # Am Kirchberg → Sodener Straße (Oberhöchstadt)
# Königsteiner Kreisel, ridden counter-clockwise: east and north side of the ring
KREISEL = [(8.47544, 50.17994), (8.47488, 50.18030)]


# ---------------------------------------------------------------------------- one-way routing

def access_rules() -> dict:
    """{segment id: access_restrictions} of the road segments around the lap (cached)."""
    path = wg.CACHE / 'access.json'
    if path.exists():
        return json.loads(path.read_text())
    import pyarrow.compute as pc
    import pyarrow.dataset as ds
    import pyarrow.fs as pafs

    s3 = pafs.S3FileSystem(anonymous=True, region='us-west-2')
    d = ds.dataset(f'overturemaps-us-west-2/release/{wg.RELEASE}/theme=transportation/type=segment/', filesystem=s3, format='parquet')
    x0, y0, x1, y1 = ACCESS_BBOX
    f = (pc.field('bbox', 'xmax') > x0) & (pc.field('bbox', 'xmin') < x1) & (pc.field('bbox', 'ymax') > y0) & (pc.field('bbox', 'ymin') < y1)
    f = f & (pc.field('subtype') == 'road') & pc.field('access_restrictions').is_valid()
    out = {r['id']: r['access_restrictions'] for r in d.to_table(filter=f, columns=['id', 'access_restrictions']).to_pylist()}
    path.write_text(json.dumps(out, default=str))
    wg.log(f'  access restrictions: {len(out)} segments')
    return out


def _plain(when: dict, *keys) -> bool:
    return not any(when.get(k) for k in keys)


def _bike_mode(when: dict) -> bool:
    mode = set(when.get('mode') or [])
    return not mode or bool(mode & {'bicycle', 'vehicle'})


def one_way_ranges(rules) -> list[tuple[float, float]]:
    """Parts of a segment (fractions along its geometry) that may only be ridden forwards."""
    out = []
    for a in rules or []:
        w = a.get('when') or {}
        if (a.get('access_type') == 'denied' and w.get('heading') == 'backward'
                and _plain(w, 'using', 'during', 'vehicle', 'recognized') and _bike_mode(w)):
            out.append(tuple(a.get('between') or (0.0, 1.0)))
    return out


def closed(rules) -> bool:
    """No access at all (for bicycles)."""
    for a in rules or []:
        w = a.get('when') or {}
        if a.get('access_type') == 'denied' and _plain(w, 'heading', 'using', 'during', 'vehicle', 'recognized') and _bike_mode(w):
            return True
    return False


def directed(g, against=frozenset()):
    """Directed copy of the road graph without the wrong-way direction of one-way segments
    (`against`: street names that may be ridden against their one-way direction)."""
    rules = access_rules()
    lines = {}
    for s in wg.overture('transportation', 'segment', CFG.fetch_far, 'segment'):
        if s['id'] in rules:
            geom = s['geom']
            parts = [geom['coordinates']] if geom['type'] == 'LineString' else geom['coordinates']
            lines[s['id']] = [[(round(p[0], 7), round(p[1], 7)) for p in line] for line in parts]
    dg = nx.DiGraph()
    for u, v, e in g.edges(data=True):
        r = rules.get(e['sid'])
        if closed(r):
            continue
        fwd = bwd = True
        ranges = one_way_ranges(r)
        if ranges and e['name'] not in against:
            for line in lines[e['sid']]:
                if u in line and v in line:
                    i, j = line.index(u), line.index(v)
                    cum = [0.0]
                    for a, b in zip(line, line[1:]):
                        cum.append(cum[-1] + math.hypot((b[0] - a[0]) * wg.KX, (b[1] - a[1]) * wg.KZ))
                    mid = 0.5 * (cum[i] + cum[j]) / cum[-1]
                    if any(lo <= mid <= hi for lo, hi in ranges):
                        if j > i:
                            bwd = False
                        else:
                            fwd = False
                    break
        if fwd:
            dg.add_edge(u, v, **e)
        if bwd:
            dg.add_edge(v, u, **e)
    return dg


def directed_via(dg, nodes, prefer=None):
    """Like worldgen.via, but on the directed graph."""
    def weight(u, v, e):
        return e['w'] * (min(prefer.get(e['name'], 1.0), prefer.get(e['cls'], 1.0)) if prefer else 1.0)
    out = [nodes[0]]
    for a, b in zip(nodes, nodes[1:]):
        out += nx.shortest_path(dg, a, b, weight=weight)[1:]
    return out


def against_one_way(dg, g, p):
    """Streets of path p that are ridden against a one-way restriction (edges missing in `dg`)."""
    return sorted({g.edges[u, v]['name'] for u, v in zip(p, p[1:]) if not dg.has_edge(u, v)})


# ---------------------------------------------------------------------------- lap + segments

def make_lap(g):
    def at(lon, lat, names=None, classes=None):
        n = wg.nearest(g, lon, lat, classes, names)
        assert n is not None, (lon, lat, names)
        return n

    start = at(*BERLINER_PLATZ, {'Frankfurter Straße'})
    waypoints = [
        start,
        at(8.5140, 50.1797, {'Bahnhofstraße'}),
        at(8.5230, 50.1815, {'Oberhöchstädter Straße'}),
        at(8.5300, 50.1830, {'Schönberger Straße'}),                     # Schönberg
        at(8.5440, 50.1850, {'Altkönigstraße'}),                         # Oberhöchstadt
        at(8.5475, 50.1830, {'Stuhlbergstraße'}),
        at(8.5450, 50.1790, {'Am Kirchberg', 'Sodener Straße'}, {'secondary'}),
        at(8.5330, 50.1760, {'Sodener Straße'}, {'secondary'}),
        at(8.5200, 50.1690, {'Schwalbacher Straße'}),
        at(8.5100, 50.1660, {'Kronthaler Straße'}),                      # Kronthal
        at(*STEINBRUCH, {'Am Steinbruch'}),
        at(8.4870, 50.1765, {'Mammolshainer Weg'}),
        *[at(*p) for p in KREISEL],
        at(8.4700, 50.1820, {'Frankfurter Straße'}),                     # Königstein
        at(8.4775, 50.1865, {'Falkensteiner Straße'}),
        at(8.4800, 50.1905, {'Kronberger Straße'}),                      # Falkenstein
        at(8.4870, 50.1895, {'Kronberger Straße'}),
        at(8.5000, 50.1905, None, {'primary'}),                          # B 455
        at(8.5085, 50.1920, {'Hainstraße'}),
        at(8.5080, 50.1840, {'Hainstraße'}),
        start,
    ]
    dg = directed(g, AGAINST_ONE_WAY)
    nodes = directed_via(dg, waypoints, prefer=PREFER)
    assert nodes[0] == nodes[-1], 'lap must close'
    assert len({frozenset(e) for e in zip(nodes, nodes[1:])}) == len(nodes) - 1, 'a road piece is ridden twice'
    names = set(wg.street_names(g, nodes))
    need = {'Bahnhofstraße', 'Schönberger Straße', 'Altkönigstraße', 'Am Kirchberg', 'Schwalbacher Straße', 'Kronthaler Straße',
            'Am Steinbruch', 'Am Mönchswald', 'Mammolshainer Weg', 'Frankfurter Straße', 'Falkensteiner Straße', 'Kronberger Straße', 'Hainstraße'}
    assert need <= names, need - names
    wrong = against_one_way(directed(g), g, nodes)
    assert set(wrong) <= AGAINST_ONE_WAY, wrong
    wg.log(f'lap {wg.path_len(g, nodes):.0f} m on the road graph; against one-way: {", ".join(wrong) or "-"}')
    return nodes[:-1], {}


def make_segments(ctx: wg.Context):
    j = ctx.closest(*KRONTHAL_JUNCTION)
    s = ctx.closest(*STEINBRUCH, j)
    stich_start = ctx.closest(*KRONTHALER_STRASSE, j, s)   # the official 2.3 km start below Kronthal
    t = ctx.closest(*STICH_TOP, s)
    stich_top = ctx.highest(t - 25, t + 25)
    k = ctx.closest(*KOENIGSTEIN_TURN, stich_top)
    z = ctx.closest(*ZOO_JUNCTION, k)
    falk_top = ctx.highest(k, z)                        # Falkenstein
    falk_start = ctx.lowest(max(k, falk_top - int(650 / wg.STEP)), falk_top)   # the ramp up Falkensteiner Straße
    h = ctx.closest(*HAIN_BEND, z)
    bottom = ctx.lowest(z, h + 25)                      # Hainstraße below the B 455 exit
    # flattest 450 m on Sodener Straße / Am Schanzenfeld between Oberhöchstadt and Kronthal
    sprint = ctx.flattest(ctx.closest(*AM_KIRCHBERG), j, 450.0)
    return [
        ctx.segment('sodener-strasse-sprint', 'Sprint Sodener Straße', 'sprint', sprint, sprint + int(450 / wg.STEP)),
        ctx.segment('mammolshainer-stich', 'Mammolshainer Stich', 'climb', stich_start, stich_top),
        ctx.segment('falkenstein', 'Anstieg nach Falkenstein', 'climb', falk_start, falk_top),
        ctx.segment('abfahrt-kronberg', 'Abfahrt nach Kronberg', 'descent', falk_top, bottom),
    ]


if __name__ == '__main__':
    wg.build(CFG, make_lap, make_segments)
