#!/usr/bin/env python3
"""
Builds the world "Lago di Como – Bellagio Loop" (see worldgen.py for sources and outputs).

Run from the repository root:
  python3 tools/geo/lago_di_como.py

The lap uses real roads only: Bellagio lakefront (Piazza Mazzini) → Via Valassina →
SS583 along the lake to Limonta (turn via Via Trento) → SP41 up to Civenna (turn via
Via Roma) → back down to Bellagio. Out-and-back legs are ridden on the right-hand lane.
"""
from __future__ import annotations

import networkx as nx
import numpy as np

import worldgen as wg

CFG = wg.Config(
    id='lago-di-como',
    name='Lago di Como – Bellagio Loop',
    ts_name='lagoDiComo',
    script='tools/geo/lago_di_como.py',
    origin=(9.265, 45.96),
    fetch_far=(9.12, 45.83, 9.40, 46.03),
    fetch_near=(9.20, 45.90, 9.33, 46.01),
    horizon=(8.85, 45.65, 9.75, 46.30),
    lake_name='Lago di Como',
    water_bbox=(9.05, 45.78, 9.45, 46.10),
    # The terrain model has the lake at 189 m; the real mean level of Lake Como is ~198 m.
    water_level=198.0,
    elev_offset=9.0,
    flora='mediterranean',
    architecture='italian',
    places_file='localities.json',
)


def make_lap(g):
    sp = lambda a, b: nx.shortest_path(g, a, b, weight='w')  # noqa: E731
    major = wg.MAJOR
    bellagio = wg.nearest(g, 9.2613, 45.9873, major)
    civenna = wg.nearest(g, 9.2711, 45.9368, major)
    limonta = wg.nearest(g, 9.2698, 45.9571, major)
    magreglio = wg.nearest(g, 9.2621, 45.9207, major)
    onno = wg.nearest(g, 9.2934, 45.9115, major)

    to_civenna = sp(bellagio, civenna)
    to_limonta = sp(bellagio, limonta)
    j = 0
    while to_civenna[j] == to_limonta[j]:
        j += 1
    junction = to_civenna[j - 1]                  # SP41 leaves the SS583 above Bellagio
    main = list(reversed(to_civenna[:j]))         # junction → Bellagio (Via Valassina)

    # Bellagio: lakefront past Piazza Mazzini, back up through Via Garibaldi
    a_idx, b_idx, _, lakefront = wg.find_loop(g, main, {'Piazza Giuseppe Mazzini'})
    assert b_idx == len(main) - 1, 'Bellagio loop should end in the town centre'
    mazzini = [i for i, (u, v) in enumerate(zip(lakefront, lakefront[1:])) if g.edges[u, v]['name'] == 'Piazza Giuseppe Mazzini']
    s_idx = mazzini[len(mazzini) // 2]
    start = lakefront[s_idx:]                     # Piazza Mazzini → Via Roma → Via Garibaldi (town centre)
    finish = lakefront[:s_idx + 1]                # Via Valassina → lakefront → Piazza Mazzini

    # Limonta: out along the lake, around the block via Via Trento
    lake_leg = sp(junction, onno)
    l1, l2, _, trento = wg.find_loop(g, lake_leg, {'Via Trento'}, exact=True)
    # Civenna: up the SP41, back through the village on Via Roma
    climb_leg = sp(junction, magreglio)
    c1, c2, _, roma = wg.find_loop(g, climb_leg, {'Via Roma'}, exact=True)

    up_town = list(reversed(main))                # Bellagio centre → junction
    nodes = (start + up_town[up_town.index(start[-1]) + 1:]
             + lake_leg[1:l2 + 1] + list(reversed(trento))[1:] + list(reversed(lake_leg[:l1]))
             + climb_leg[1:c2 + 1] + list(reversed(roma))[1:] + list(reversed(climb_leg[:c1]))
             + main[1:a_idx + 1] + finish[1:])
    assert nodes[0] == nodes[-1], 'lap must close'
    return nodes[:-1], {'junction': junction}


def make_segments(ctx: wg.Context):
    elev = ctx.elev
    # the junction is passed three times: up from town, back from the lake, back from Civenna (see lap order)
    # radius covers the shift from curve rounding near the junction node (worldgen.JUNCTION_SHIFT)
    jpass = ctx.passes(*ctx.info['junction'], radius=12.0)
    assert len(jpass) == 3, jpass
    jx, jz = wg.local(*ctx.info['junction'])
    dj = np.hypot(ctx.path[:, 0] - jx, ctx.path[:, 1] - jz)
    climb_start = jpass[1]
    turn = climb_start + int(np.argmax(dj[climb_start:jpass[2]]))  # Civenna, farthest from the junction
    top = ctx.highest(climb_start, turn)
    # flattest 500 m on the outbound lake leg
    lake_a, lake_b = jpass[0], jpass[0] + (jpass[1] - jpass[0]) // 2
    best_i = ctx.flattest(lake_a + 10, lake_b, 500.0)
    # descent: from the highest point after the Civenna turn down to the junction
    back_top = turn + int(np.argmax(elev[turn:jpass[2]]))
    return [
        ctx.segment('salita-civenna', 'Salita di Civenna', 'climb', climb_start, top),
        ctx.segment('lungolago-limonta', 'Lungolago Limonta', 'sprint', best_i, best_i + 125),
        ctx.segment('discesa-bellagio', 'Discesa su Bellagio', 'descent', back_top, jpass[2]),
    ]


if __name__ == '__main__':
    wg.build(CFG, make_lap, make_segments)
