#!/usr/bin/env python3
"""
Builds the world "Großer Feldberg (Taunus)" (see worldgen.py for sources and outputs).

Run from the repository root:
  python3 tools/geo/feldberg_taunus.py

The classic Feldberg climb from the Hohemark (Oberursel, at the restaurant "Das Waldtraut"):
Kanonenstraße up through the forest to the Sandplacken, Hochtaunusstraße to the summit road and
the turning loop on the summit plateau (Großer Feldberg, 879 m). The lap rides back down the same
roads and turns around in the Hohemark roundabout. Out-and-back legs are ridden on the right-hand lane.
"""
from __future__ import annotations

import worldgen as wg

WALDTRAUT = (8.53594, 50.21542)
SANDPLACKEN = (8.48848, 50.24513)
SUMMIT_LOOP = (8.45694, 50.23189)   # where the summit road meets the turning loop
# Hohemark roundabout (Kanonenstraße / Hohemarkstraße / B 455), ridden counter-clockwise
ROUNDABOUT = [(8.53657, 50.21570), (8.53673, 50.21583), (8.53653, 50.21591)]  # south, east, north

CFG = wg.Config(
    id='feldberg-taunus',
    name='Großer Feldberg – ab Hohemark',
    ts_name='feldbergTaunus',
    script='tools/geo/feldberg_taunus.py',
    origin=(8.50, 50.22),
    fetch_far=(8.36, 50.14, 8.66, 50.32),
    fetch_near=(8.41, 50.18, 8.58, 50.26),
    horizon=(7.95, 49.85, 9.05, 50.60),
    flora='central',
    architecture='german',
    road_classes=wg.ROAD_CLASSES | {'service'},
    extra_places=[('Hohemark', 8.5366, 50.2159), ('Sandplacken', *SANDPLACKEN)],
)

# keep the ride on the public roads (service roads only where the summit loop needs them)
PREFER = {'service': 4.0, 'residential': 2.0}


def make_lap(g):
    bottom = wg.nearest(g, 8.53612, 50.21590, names={'Kanonenstraße'})      # Kanonenstraße at the roundabout
    top = wg.nearest(g, *SUMMIT_LOOP)
    leg = wg.via(g, [bottom, SANDPLACKEN, top], prefer=PREFER)
    names = set(wg.street_names(g, leg))
    assert {'Kanonenstraße', 'Hochtaunusstraße', 'Großer Feldberg'} <= names, names
    summit = wg.turning_cycle(g, leg, max_len=200)
    roundabout = wg.via(g, [bottom, *ROUNDABOUT, bottom])
    assert 60 < wg.path_len(g, roundabout) < 200, wg.path_len(g, roundabout)
    nodes = leg + summit[1:] + list(reversed(leg))[1:] + roundabout[1:]
    assert nodes[0] == nodes[-1], 'lap must close'
    wg.log(f'leg {wg.path_len(g, leg):.0f} m, summit loop {wg.path_len(g, summit):.0f} m, roundabout {wg.path_len(g, roundabout):.0f} m')
    return nodes[:-1], {'bottom': bottom, 'top': top}


def make_segments(ctx: wg.Context):
    at_top = ctx.passes(*ctx.info['top'])
    assert len(at_top) == 2, at_top          # into the summit loop and out of it
    at_bottom = [i for i in ctx.passes(*ctx.info['bottom']) if i > at_top[1]]
    start = ctx.closest(*WALDTRAUT, 0, at_top[0])
    summit = ctx.highest(0, at_top[1])
    return [
        ctx.segment('feldberg-waldtraut', 'Feldberg ab Waldtraut', 'climb', start, summit),
        ctx.segment('feldberg-abfahrt', 'Abfahrt zur Hohemark', 'descent', at_top[1], at_bottom[0]),
    ]


if __name__ == '__main__':
    wg.build(CFG, make_lap, make_segments)
