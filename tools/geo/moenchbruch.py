#!/usr/bin/env python3
"""
Builds the world "Mönchbruch-Runde" (see worldgen.py for sources and outputs).

Run from the repository root:
  python3 tools/geo/moenchbruch.py

A flat lap in the Rhine–Main plain south of Frankfurt, start and finish in Mörfelden: west through
the Mönchbruch forest towards Rüsselsheim-Königstädten, south to Nauheim and Groß-Gerau and back
east to Mörfelden. Hardly 20 m of difference in height, most of it in the woods.
"""
from __future__ import annotations

import worldgen as wg

MOERFELDEN = (8.5660, 49.9770)
MOENCHBRUCH = (8.5200, 49.9790)
KOENIGSTAEDTEN = (8.4700, 49.9750)
NAUHEIM = (8.4550, 49.9430)
GROSS_GERAU = (8.4850, 49.9200)

CFG = wg.Config(
    id='moenchbruch',
    name='Mönchbruch-Runde',
    ts_name='moenchbruch',
    script='tools/geo/moenchbruch.py',
    origin=(8.51, 49.955),
    fetch_far=(8.38, 49.87, 8.65, 50.03),
    fetch_near=(8.42, 49.895, 8.61, 50.005),
    horizon=(7.95, 49.60, 9.05, 50.30),
    flora='central',
    architecture='german',
    extra_places=[('Mönchbruch', *MOENCHBRUCH)],
    # the plain is flat; steeper bits in the terrain model are bridges, trees and noise
    max_grade=0.025,
    road_smooth_m=300.0,
)

# main roads between the towns, through the villages only where needed
PREFER = {'residential': 2.0, 'unclassified': 1.5, 'living_street': 3.0}


def make_lap(g):
    start = wg.nearest(g, *MOERFELDEN, wg.MAJOR)
    nodes = wg.via(g, [start, MOENCHBRUCH, KOENIGSTAEDTEN, NAUHEIM, GROSS_GERAU, start], prefer=PREFER)
    assert nodes[0] == nodes[-1], 'lap must close'
    names = [n for n in dict.fromkeys(wg.street_names(g, nodes)) if n]
    wg.log(f'lap {wg.path_len(g, nodes):.0f} m over {", ".join(names[:14])}')
    return nodes[:-1], {}


def make_segments(ctx: wg.Context):
    forest = ctx.closest(*MOENCHBRUCH)
    sprint = ctx.flattest(max(0, forest - 400), min(ctx.n, forest + 400), 600.0)
    return [ctx.segment('moenchbruch-sprint', 'Mönchbruch-Sprint', 'sprint', sprint, sprint + int(600 / wg.STEP))]


if __name__ == '__main__':
    wg.build(CFG, make_lap, make_segments)
