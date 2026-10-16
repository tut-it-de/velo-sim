#!/usr/bin/env python3
"""
Builds the world "Alpe d'Huez" (see worldgen.py for sources and outputs).

Run from the repository root:
  python3 tools/geo/alpe_dhuez.py

The classic climb: from the roundabout of the D1091 at Bourg-d'Oisans (720 m) up the D211 with its
21 numbered hairpins (virage 21 at the first ramp, virage 7 in Huez, virage 1 below the resort)
through La Garde and Huez to the resort, round the Rond-Point de l'Europe and up the Avenue du
Rif Nel to the Tour de France finish (≈1850 m). The lap turns around in a loop of resort streets
(Avenue du Rif Nel – Route du Signal – Avenue de l'Étendard – Rond-Point du Tour de France), rides
back down the same road and turns around in the Bourg-d'Oisans roundabout.

Out-and-back legs are ridden on the right-hand lane. Where the map has one-way carriageways (the
roundabouts and the dual carriageway above Huez) each direction takes its own carriageway, and every
roundabout is ridden counter-clockwise.

The 30 m terrain model cannot resolve the hairpins: it puts dips into the climb at many bends and
ramps of 15–30 % between them. The D211 rises all the way from Bourg-d'Oisans to the Rond-Point de
l'Europe, so its profile is fitted monotonically (dips become flat bends), smoothed a little more
and limited to 12 % (published maxima of the climb are 11–14 %).
"""
from __future__ import annotations

import numpy as np

import worldgen as wg

FINISH = (6.07119, 45.09403)          # "Arrivée du Tour de France", Avenue du Rif Nel
HUEZ = (6.0575, 45.0812)
LA_GARDE = (6.04437, 45.06720)        # Église Saint-Pierre de La Garde-en-Oisans

# Bourg-d'Oisans: the D211 splits into two one-way lanes just above the D1091 roundabout
BOTTOM = (6.0377827, 45.059727)
ROUNDABOUT = [(6.0375556, 45.0591928), (6.0377617, 45.0590545), (6.0380547, 45.0592657)]  # west, south, east
# dual carriageway above Huez (virage 3): uphill on the east, downhill on the west carriageway
UP_HUEZ = (6.0594439, 45.0859572)
DOWN_HUEZ = (6.0592255, 45.0860018)
# Rond-Point de l'Europe (resort entrance): in from the south, out to the north (Avenue du Rif Nel)
EUROPE_SOUTH = (6.0740702, 45.0896273)   # D211 splits into the entry and exit lanes
EUROPE_UP = (6.0743108, 45.0902419)       # ring east
EUROPE_DOWN = (6.073687, 45.0902536)     # ring west
EUROPE_NORTH = (6.0737359, 45.0908454)   # Avenue du Rif Nel splits into the exit and entry lanes
# Rond-Point du Tour de France
TDF_SOUTH = (6.0722839, 45.0923082)
TDF_UP = (6.0721412, 45.0926155)         # ring east
TDF_IN = (6.0719228, 45.0925118)         # ring south-west, entry from the Avenue de l'Étendard
TOP = (6.0703245, 45.0958784)            # Avenue du Rif Nel meets the Route du Signal
ETENDARD = (6.0676154, 45.093406)        # Route du Signal → Avenue de l'Étendard
JEAN_MOULIN = (6.0683099, 45.092994)     # Place Jean Moulin roundabout, west side

CFG = wg.Config(
    id='alpe-dhuez',
    name="Alpe d'Huez – 21 Kehren ab Bourg-d'Oisans",
    ts_name='alpeDHuez',
    script='tools/geo/alpe_dhuez.py',
    origin=(6.05, 45.075),
    fetch_far=(5.88, 44.97, 6.22, 45.17),
    fetch_near=(5.98, 45.02, 6.13, 45.13),
    horizon=(5.6, 44.75, 6.6, 45.4),
    flora='alpine',
    architecture='alpine',
    max_grade=0.12,
    extra_places=[('Virage 21', 6.03905, 45.07184), ('Virage 7', 6.05498, 45.08071), ('Virage 1', 6.06191, 45.08748),
                  ('Arrivée', *FINISH)],
)

# Keep the ride on the D211 and the main resort streets. (worldgen.shortest only honours factors < 1
# for road classes, so the wanted classes are made cheaper instead of the others dearer.)
PREFER = {'primary': 0.1, 'secondary': 0.1, 'tertiary': 0.3}


def node(g, p):
    assert p in g, f'{p} is no graph node (map data changed?)'
    return p


def make_lap(g):
    n = lambda p: node(g, p)  # noqa: E731
    up = wg.via(g, [n(BOTTOM), n(UP_HUEZ), n(EUROPE_SOUTH), n(EUROPE_UP), n(EUROPE_NORTH), n(TDF_SOUTH), n(TDF_UP), n(TOP)],
                prefer=PREFER)
    resort = wg.via(g, [n(TOP), n(ETENDARD), n(JEAN_MOULIN), n(TDF_IN), n(TDF_SOUTH)], prefer=PREFER)
    down = wg.via(g, [n(TDF_SOUTH), n(EUROPE_NORTH), n(EUROPE_DOWN), n(EUROPE_SOUTH), n(DOWN_HUEZ), n(BOTTOM)], prefer=PREFER)
    roundabout = wg.via(g, [n(BOTTOM), *map(n, ROUNDABOUT), n(BOTTOM)])

    names = set(wg.street_names(g, up))
    assert {"Route de l'Alpe d'Huez", "Rond-Point de l'Europe", 'Avenue du Rif Nel'} <= names, names
    classes = {g.edges[u, v]['cls'] for p in (up, down) for u, v in zip(p, p[1:])}
    assert classes == {'secondary'}, classes
    # the resort loop: Avenue du Rif Nel (north) – Route du Signal – Avenue de l'Étendard, counter-clockwise
    i = up.index(TDF_SOUTH)
    loop = up[i:] + resort[1:]
    assert loop[0] == loop[-1] and wg.signed_area(loop[:-1]) > 0, 'resort loop must run counter-clockwise'
    assert {'Route du Signal', "Avenue de l'Étendard"} <= set(wg.street_names(g, resort))
    assert wg.signed_area(roundabout[:-1]) > 0 and 80 < wg.path_len(g, roundabout) < 250, wg.path_len(g, roundabout)

    nodes = up + resort[1:] + down[1:] + roundabout[1:]
    assert nodes[0] == nodes[-1], 'lap must close'
    wg.log(f'up {wg.path_len(g, up):.0f} m, resort loop {wg.path_len(g, loop):.0f} m, down {wg.path_len(g, down):.0f} m, '
           f'roundabout {wg.path_len(g, roundabout):.0f} m')
    return nodes[:-1], {'bottom': BOTTOM, 'tdf_south': TDF_SOUTH}


def make_segments(ctx: wg.Context):
    finish = ctx.passes(*FINISH, radius=10.0)
    assert len(finish) == 1, finish                  # the finish street is only ridden uphill
    at_tdf = ctx.passes(*ctx.info['tdf_south'])
    assert len(at_tdf) == 2 and at_tdf[0] < finish[0] < at_tdf[1], (at_tdf, finish)
    bottom = ctx.closest(*ctx.info['bottom'], at_tdf[1], ctx.n - 20)   # back at the roundabout
    return [
        ctx.segment('alpe-dhuez', "Alpe d'Huez (21 Kehren)", 'climb', 0, finish[0]),
        ctx.segment('alpe-dhuez-abfahrt', "Abfahrt nach Bourg-d'Oisans", 'descent', at_tdf[1], bottom),
    ]


def isotonic(v):
    """Non-decreasing least-squares fit (pool adjacent violators); never steepens a step."""
    vals, wts = [], []
    for e in v:
        vals.append(float(e))
        wts.append(1)
        while len(vals) > 1 and vals[-2] > vals[-1]:
            w = wts[-2] + wts[-1]
            vals[-2] = (vals[-2] * wts[-2] + vals[-1] * wts[-1]) / w
            wts[-2] = w
            vals.pop()
            wts.pop()
    return np.repeat(vals, wts)


_road_profile = wg.road_profile


def road_profile(path, dem, near, lake_local):
    """worldgen's road profile, then the D211 legs (Bourg-d'Oisans ⇄ Rond-Point de l'Europe) made
    monotonic, σ = 75 m smoothing, and a grade limit that is iterated until it holds (worldgen's 2000
    iterations of limit_grade do not converge on this climb)."""
    elev = _road_profile(path, dem, near, lake_local).copy()
    n = len(path)
    ex, ez = wg.local(*EUROPE_SOUTH)
    d = np.hypot(path[:, 0] - ex, path[:, 1] - ez)
    a, b = int(np.argmin(d[:n // 2])), n // 2 + int(np.argmin(d[n // 2:]))
    assert d[a] < 10 and d[b] < 10, (d[a], d[b])
    elev[:a + 1] = isotonic(elev[:a + 1])           # up to the resort
    elev[b:] = -isotonic(-elev[b:])                 # down to Bourg-d'Oisans and round the roundabout
    elev = wg.circular_gauss(elev, 75 / wg.STEP)
    return wg.circular_gauss(wg.limit_grade(elev, CFG.max_grade * wg.STEP, 50000), 3.0)


if __name__ == '__main__':
    wg.road_profile = road_profile  # worldgen.build has no hook for the profile
    wg.build(CFG, make_lap, make_segments)
