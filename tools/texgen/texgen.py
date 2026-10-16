#!/usr/bin/env python3
"""Offline texture generator for the velo-sim detail maps.

Usage, from the repository root:
    python3 tools/texgen/texgen.py <name>     generate one texture
    python3 tools/texgen/texgen.py all        generate every registered texture
    python3 tools/texgen/texgen.py selftest   check tileability of the noise code

Output: apps/client/public/textures/<name>.webp (folder is created if missing).
Generators are registered with @generator('<name>') in the section at the end
of this file. Each one takes the size n and returns uint8 RGBA of shape (n, n, 4),
normally via noise.pack_detail.
"""

import os
import shutil
import sys
import tempfile

import numpy as np
from PIL import Image

import noise

SIZE = 1024
HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
TEXTURE_DIR = os.path.join(REPO_ROOT, "apps", "client", "public", "textures")

# name -> generator function fn(n) -> uint8 RGBA (n, n, 4)
GENERATORS = {}

SEAM_LIMIT = 0.02   # max mean absolute difference across the wrap seam
SEAM_RATIO = 3.0    # seam difference must be within this factor of the inner difference


def generator(name):
    """Register a texture generator under the given name."""
    def register(fn):
        if name in GENERATORS:
            raise ValueError(f"generator '{name}' is already registered")
        GENERATORS[name] = fn
        return fn
    return register


def build(name, n=SIZE):
    """Run one generator and write its WebP. Returns the output path."""
    rgba = GENERATORS[name](n)
    expected = (n, n, 4)
    if not isinstance(rgba, np.ndarray) or rgba.dtype != np.uint8 or rgba.shape != expected:
        raise ValueError(f"generator '{name}' must return uint8 array of shape {expected}")
    path = os.path.join(TEXTURE_DIR, name + ".webp")
    # Lossless: lossy WebP roughly doubles the difference across the tile seam.
    noise.save_webp(path, rgba, lossless=True)
    return path


def _seam_report(h):
    """Seam (first vs last row/column) against neighbouring inner rows/columns.

    Returns a dict with mean absolute differences:
      seam_rows, seam_cols   first row vs last row, first column vs last column
      inner_rows, inner_cols mean difference between all neighbouring rows/columns
    """
    return {
        "seam_rows": float(np.abs(h[0, :] - h[-1, :]).mean()),
        "seam_cols": float(np.abs(h[:, 0] - h[:, -1]).mean()),
        "inner_rows": float(np.abs(np.diff(h, axis=0)).mean()),
        "inner_cols": float(np.abs(np.diff(h, axis=1)).mean()),
    }


def _seam_ok(rep):
    """True if both seams are below the limit and in the same order as the inside."""
    for axis in ("rows", "cols"):
        seam = rep["seam_" + axis]
        inner = rep["inner_" + axis]
        if seam >= SEAM_LIMIT:
            return False
        if seam > SEAM_RATIO * inner and seam > 1e-6:
            return False
    return True


def _fmt(rep):
    return (f"seam rows {rep['seam_rows']:.5f} / inner rows {rep['inner_rows']:.5f}, "
            f"seam cols {rep['seam_cols']:.5f} / inner cols {rep['inner_cols']:.5f}")


def selftest():
    """Write a test fbm texture to a temp folder, check tileability, clean up.

    Prints OK and returns 0 on success. Returns 1 on failure.
    """
    n = SIZE
    h = noise.fbm(n, octaves=5, base_freq=4, seed=1)
    rgba = noise.pack_detail(h, h, np.full((n, n), 0.5, dtype=np.float32), strength=1.0)

    tmpdir = tempfile.mkdtemp(prefix="texgen-selftest-")
    path = os.path.join(tmpdir, "selftest.webp")
    try:
        noise.save_webp(path, rgba, lossless=True)
        decoded = np.asarray(Image.open(path).convert("RGBA"))
        if decoded.shape != (n, n, 4):
            print(f"FAIL: decoded size {decoded.shape}, expected {(n, n, 4)}")
            return 1
        rep_float = _seam_report(h)
        rep_webp = _seam_report(decoded[..., 0].astype(np.float64) / 255.0)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    # Negative control: a plain ramp is not tileable and must fail the check.
    ramp = np.tile(np.linspace(0.0, 1.0, n, dtype=np.float64), (n, 1))
    ramp_ok = _seam_ok(_seam_report(ramp))

    print(f"fbm float:   {_fmt(rep_float)}")
    print(f"fbm decoded: {_fmt(rep_webp)}")
    print(f"control (ramp, must fail): {'FAILED as expected' if not ramp_ok else 'PASSED (check is broken)'}")

    if not _seam_ok(rep_float) or not _seam_ok(rep_webp) or ramp_ok:
        print("FAIL")
        return 1
    print("OK")
    return 0


def main(argv):
    if len(argv) != 2:
        print("Usage: python3 tools/texgen/texgen.py <name|all|selftest>", file=sys.stderr)
        return 2
    cmd = argv[1]
    if cmd == "selftest":
        return selftest()
    if cmd == "all":
        if not GENERATORS:
            print("Keine Generatoren registriert.")
            return 0
        for name in GENERATORS:
            print(build(name))
        return 0
    if cmd not in GENERATORS:
        available = ", ".join(sorted(GENERATORS)) or "(keine)"
        print(f"Unbekannter Generator '{cmd}'. Verfügbar: {available}", file=sys.stderr)
        return 2
    print(build(cmd))
    return 0


# --- Generators ---
# One function per texture, below this line, registered with @generator('<name>').
# Signature: def fn(n: int) -> np.ndarray   (uint8, shape (n, n, 4), see noise.pack_detail)


@generator('asphalt')
def asphalt(n):
    """Asphalt: dark, smooth binder with small scattered chippings and a few hairline cracks.

    About 40 % of the ~6000 Voronoi cells carry a small round chipping around their centre.
    Fine grain and large soft patches are added on top of the binder.
    """
    seed = 7
    f1, f2, cid = noise.voronoi(n, cells=6000, seed=seed)
    f1 = f1.astype(np.float64)                 # distance to the cell centre, in cell units

    rng = np.random.default_rng(seed + 1)
    has_grain = rng.random(77 * 77) < 0.4      # cell_id -> chipping present
    grain_r = rng.uniform(0.25, 0.35, 77 * 77)  # chipping radius in cell units (about 3-5 px)
    grain_u = rng.random(77 * 77)              # brightness offset per chipping, 0..1

    # Rounded chipping: dome profile inside radius r, 0 outside.
    r = grain_r[cid]
    inside = (f1 < r) & has_grain[cid]
    dome = np.where(inside, np.clip(1.0 - (f1 / r) ** 2, 0.0, 1.0), 0.0)
    u = grain_u[cid]

    # Fine isotropic grain (amplitude 0.08) and large soft patches (amplitude 0.06).
    fine = noise.fbm(n, octaves=4, base_freq=128, seed=seed + 2).astype(np.float64)
    patch = noise.fbm(n, octaves=3, base_freq=3, seed=seed + 3).astype(np.float64)

    # Hairline cracks: thin isolines of smooth noise (about 2-3 long, branching lines per tile).
    crack_field = noise.fbm(n, octaves=4, base_freq=4, seed=seed + 4).astype(np.float64)
    crack_gate = noise.fbm(n, octaves=2, base_freq=1, seed=seed + 5).astype(np.float64)
    crack = ((np.abs(crack_field - 0.5) < 0.004) & (crack_gate > 0.7)).astype(np.float64)

    # Brightness: binder 0.44 with patches, chippings 0.5 +/- 0.10, grain and cracks on top.
    binder = 0.44 + (patch - 0.5) * 0.12
    chip = 0.5 + (u - 0.5) * 0.20
    lum = binder + dome * (chip - binder)
    lum += (fine - 0.5) * 0.16
    lum -= 0.15 * crack
    lum = np.clip(lum, 0.0, 1.0)

    # Height: chippings raised, binder slightly uneven, cracks cut in.
    height = (0.40 + 0.35 * dome + 0.05 * (patch - 0.5) + 0.03 * (fine - 0.5) - 0.10 * crack)
    height = np.clip(height, 0.0, 1.0)

    # Roughness 0.85-0.95: binder smooth-ish, chipping tops rougher.
    rough = 0.92 - 0.07 * dome + 0.02 * (fine - 0.5)
    rough = np.clip(rough, 0.85, 0.95)

    return noise.pack_detail(lum, height, rough, strength=2.0)



def _drystone_layout(n, rng, gx=5, gy=12, extra=12):
    """Stone centres for a staggered course layout, plus small filler stones.

    gx x gy = 5 x 12 = 60 stones, cells n/5 wide and n/12 tall (ratio 2.4).
    Odd rows are shifted half a cell (brick bond). Jitter is +-35 % of a cell.
    Filler stones sit between horizontal neighbours, offset up or down by
    0.3 cell, so they come out smaller than the main stones.
    Returns (px, py, count): pixel coordinates in [0, n) and the stone count.
    """
    cw = n / gx
    ch = n / gy
    rows, cols = np.meshgrid(np.arange(gy), np.arange(gx), indexing="ij")
    stagger = np.where(rows % 2 == 1, 0.5, 0.0)
    bx = ((cols + 0.5 + stagger + rng.uniform(-0.35, 0.35, (gy, gx))) * cw).ravel()
    by = ((rows + 0.5 + rng.uniform(-0.35, 0.35, (gy, gx))) * ch).ravel()
    rows_f = rows.ravel()
    cols_f = cols.ravel()

    px = list(bx)
    py = list(by)
    for k in rng.choice(gx * gy, size=extra, replace=False):
        r, c = rows_f[k], cols_f[k]
        k2 = r * gx + (c + 1) % gx
        x2 = bx[k2] + (n if c == gx - 1 else 0)
        px.append(((bx[k] + x2) * 0.5) % n)
        py.append((by[k] + rng.choice([-0.3, 0.3]) * ch) % n)
    return np.array(px), np.array(py), len(px)


def _drystone_voronoi(n, qx, qy, px, py):
    """Periodic Voronoi evaluated at query positions qx, qy (pixels).

    Each feature point is tested in 3 x 3 tile copies, so the result tiles.
    Returns (f1, f2, cell_id): distances to the nearest and second-nearest
    point in pixels, and the index of the nearest point.
    """
    f1 = np.full(qx.shape, np.inf)
    f2 = np.full(qx.shape, np.inf)
    cid = np.zeros(qx.shape, dtype=np.int32)
    for i in range(len(px)):
        for sx in (-n, 0, n):
            for sy in (-n, 0, n):
                d = np.hypot(qx - (px[i] + sx), qy - (py[i] + sy))
                closer = d < f1
                f2 = np.where(closer, f1, np.minimum(f2, d))
                cid = np.where(closer, np.int32(i), cid)
                f1 = np.minimum(f1, d)
    return f1, f2, cid


@generator('drystone')
def drystone(n):
    """Dry-stone wall: staggered courses of domed stones, warped edges, dark deep mortar."""
    rng = np.random.default_rng(17)
    px, py, count = _drystone_layout(n, rng)
    tone = rng.uniform(-0.15, 0.15, count)          # per-stone brightness, +-15 %
    off = rng.integers(0, n, size=(count, 2))       # per-stone offset into the shared relief field

    coords = np.arange(n) + 0.5
    X, Y = np.meshgrid(coords, coords)
    yy, xx = np.indices((n, n))

    # Domain warp: wobble the query positions by up to +-10 px for irregular outlines.
    w1 = noise.fbm(n, octaves=4, base_freq=12, seed=21).astype(np.float64)
    w2 = noise.fbm(n, octaves=4, base_freq=12, seed=22).astype(np.float64)
    qx = X + 10.0 * (2.0 * w1 - 1.0)
    qy = Y + 10.0 * (2.0 * w2 - 1.0)

    f1, f2, cid = _drystone_voronoi(n, qx, qy, px, py)

    # Mortar width varies 4-10 px (full gap), via a periodic fbm field.
    fj = noise.fbm(n, octaves=4, base_freq=10, seed=23).astype(np.float64)
    joint_half = 0.5 * (4.0 + 6.0 * fj)

    # Distance to the nearest stone border: (f2 - f1) / 2 is exact for two points.
    edge = 0.5 * (f2 - f1)
    t = np.clip((edge - joint_half) / 40.0, 0.0, 1.0)
    dome = np.sqrt(1.0 - (1.0 - t) ** 2)            # domed stone: 0 in the joint, 1 at the top

    # Each stone samples its own region of the periodic relief field (wrap-around gather).
    relief_field = noise.fbm(n, octaves=6, base_freq=8, seed=9).astype(np.float64)
    own = relief_field[(yy + off[cid, 0]) % n, (xx + off[cid, 1]) % n]

    joint_depth = 0.12                               # mortar sits 12 % below the stone tops
    height = 1.0 - joint_depth * (1.0 - dome) + 0.02 * (own - 0.5) * dome

    stone_lum = 0.6 + tone[cid] + 0.10 * (own - 0.5)
    joint_lum = 0.2 + 0.03 * (own - 0.5)           # dark mortar
    lum = joint_lum + (stone_lum - joint_lum) * dome

    rough = 0.88 + 0.12 * (own - 0.5) + 0.05 * (1.0 - dome)

    return noise.pack_detail(lum, height, rough, strength=320.0)



@generator('plaster')
def plaster(n):
    # Coarse render plaster: fine grain plus a medium trowel pattern, very weak overall.
    fine = noise.fbm(n, octaves=4, base_freq=96, seed=11)
    mid = noise.fbm(n, octaves=3, base_freq=12, seed=12)

    # Blotches: the largest 10 % of a low-frequency field are 10 % darker.
    blot_field = noise.fbm(n, octaves=3, base_freq=4, seed=13)
    blot_thr = np.quantile(blot_field, 0.90)
    blot = np.clip((blot_field - blot_thr) / 0.03, 0.0, 1.0).astype(np.float32)

    # Chips: some Voronoi cells (about 8 % of them) get a small flaked-off spot.
    rng = np.random.default_rng(14)
    f1, _, cid = noise.voronoi(n, cells=400, seed=15)
    chip_cell = (rng.random(400) < 0.08).astype(np.float32)
    chip = chip_cell[cid] * np.clip(1.0 - f1 / 0.3, 0.0, 1.0)

    height = 0.6 * mid + 0.4 * fine - 0.25 * chip
    lum = (0.5 + 0.05 * (2.0 * mid - 1.0) + 0.03 * (2.0 * fine - 1.0)
           - 0.05 * blot - 0.05 * chip)
    rough = 0.78 + 0.08 * (2.0 * fine - 1.0) + 0.04 * blot
    return noise.pack_detail(lum, height, rough, strength=1.5)


@generator('rooftile')
def rooftile(n):
    # Mönch-Nonne roof (Italy / southern France). Tiles run in vertical columns
    # (v = roof slope). Columns alternate Mönch (convex, high) and Nonne (trough, low).
    COLS = 16          # columns per texture, each 64 px wide, n must be divisible
    TILES = 8          # tiles per column per texture, each 128 px long
    CW = n // COLS
    TH = n // TILES
    rng = np.random.default_rng(21)
    offs = rng.integers(1, TH, size=COLS)          # vertical offset per column, never 0
    tile_bright = rng.uniform(-0.12, 0.12, size=(COLS, TILES)).astype(np.float32)

    y, x = np.mgrid[0:n, 0:n]
    c = x // CW                                    # column index
    yy = (y + offs[c]) % n                         # tiles of each column shifted by its offset
    k = yy // TH                                   # tile index within the column
    ly = (yy % TH) / float(TH)                     # 0..1 along one tile
    xc = (x % CW) + 0.5 - CW / 2.0                 # across the column, centred

    # Taper: each tile narrows slightly towards its lower end.
    s = 1.0 - 0.12 * ly
    uu = 0.5 + xc / (CW * s)
    inside = (uu >= 0.0) & (uu < 1.0)
    prof = np.where(inside, np.abs(np.sin(np.pi * uu)) ** 0.6, 0.0)

    odd = (c % 2) == 1                             # Nonne columns
    body = np.where(odd, 0.4, 1.0) * prof

    # Overlap lip at the lower end of each tile: height steps down at the tile boundary.
    lip = np.clip((ly - 0.9) / 0.1, 0.0, 1.0)
    grain = noise.fbm(n, octaves=3, base_freq=48, seed=22)
    height = body + 0.15 * lip * inside + 0.03 * grain

    # Narrow shadow strip (about 5 px) just below the lip.
    shadow = ((ly * TH) < 5.0) & inside

    flec = noise.fbm(n, octaves=4, base_freq=6, seed=23)   # lichen and dirt
    lum = (0.5 + 0.12 * body + tile_bright[c, k]
           + 0.08 * (2.0 * flec - 1.0)
           - 0.08 * odd - 0.15 * shadow)
    lum = lum + (0.5 - float(lum.mean()))         # keep the mean at 0.5
    rough = 0.85 + 0.05 * (2.0 * grain - 1.0)
    return noise.pack_detail(lum, height, rough, strength=8.0)



def _rock_norm(a):
    """Map an array linearly to [0, 1] (float64). Flat input becomes zeros."""
    lo = float(a.min())
    hi = float(a.max())
    if hi - lo < 1e-12:
        return np.zeros(a.shape)
    return (a - lo) / (hi - lo)


def _rock_smoothstep(e0, e1, x):
    """Hermite smoothstep from e0 to e1, clamped to [0, 1]."""
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


@generator('rock')
def rock(n):
    # Pixel coordinates; Y is the row index, X the column index.
    p = np.arange(n, dtype=np.float64)
    X, Y = np.meshgrid(p, p)

    # Low-frequency, tileable displacement of the layer boundaries.
    wy = noise.fbm(n, octaves=3, base_freq=2, seed=11).astype(np.float64)
    wx = noise.fbm(n, octaves=3, base_freq=2, seed=12).astype(np.float64)
    yw = Y + (wy - 0.5) * 90.0
    xw = X + (wx - 0.5) * 40.0

    # 7 layers per tile: an integer count keeps the strata seamless in y.
    K = 7
    s = yw / n * K + 0.5  # shift so the tile edge lies mid-bank, not on a step
    base = np.floor(s)
    layer = np.mod(base, K).astype(np.int64)
    f = s - base  # 0 at the top of a layer, 1 at the bottom

    # Per-layer random values, fixed seed.
    rng = np.random.default_rng(40)
    bright = rng.uniform(-0.12, 0.12, K)
    depth = rng.uniform(0.2, 0.6, K)

    # Bank profile: the top edge sticks out, the bottom edge steps back to the next layer.
    depth_px = depth[layer]
    h_layer = 1.0 - _rock_smoothstep(0.75, 1.0, f) * depth_px
    surf = 0.25 * noise.fbm(n, octaves=5, base_freq=6, seed=13).astype(np.float64)
    height = h_layer + surf

    # Vertical joints inside each layer, plus dark joints between layers.
    lum = 0.5 + bright[layer] + 0.1 * (noise.fbm(n, octaves=4, base_freq=8, seed=14).astype(np.float64) - 0.5)
    for l in range(K):
        in_layer = layer == l
        count = int(rng.integers(3, 6))
        for _ in range(count):
            xi = rng.uniform(0.0, n)
            w = rng.uniform(2.0, 4.0)
            # Shortest distance around the tile in x.
            d = np.abs(np.mod(xw - xi + n / 2.0, n) - n / 2.0)
            crack = (d < w) & in_layer
            height = np.where(crack, height - 0.5, height)
            lum = np.where(crack, lum - 0.25, lum)
    fuge = f > 0.92
    lum = np.where(fuge, lum - 0.2, lum)

    height = _rock_norm(height)
    lum = np.clip(lum, 0.0, 1.0)

    rough = 0.85 + 0.10 * (noise.fbm(n, octaves=4, base_freq=8, seed=14).astype(np.float64))
    rough = np.clip(rough, 0.0, 1.0)

    return noise.pack_detail(lum, height, rough, strength=12.0)


def _forestfloor_soil(n):
    """Dark soil base: lum, height and roughness arrays for the ground."""
    soil_fine = noise.fbm(n, octaves=6, base_freq=40, seed=102).astype(np.float64)
    soil_big = noise.fbm(n, octaves=4, base_freq=6, seed=103).astype(np.float64)
    lum = 0.36 + 0.07 * (soil_big - 0.5) + 0.05 * (soil_fine - 0.5)
    height = 0.12 + 0.10 * soil_fine
    rough = np.full((n, n), 0.9, dtype=np.float64)
    return lum, height, rough


@generator('forestfloor')
def forestfloor(n):
    rng = np.random.default_rng(101)
    lum, height, rough = _forestfloor_soil(n)

    # Leaves: ellipses at random positions and angles, drawn with wrap-around.
    # Semi-axis a of 6..13 px: with 1024 px = 3 m, leaves are about 4..8 cm long.
    count = 14000
    for _ in range(count):
        a = rng.uniform(6.0, 13.0)
        b = a * rng.uniform(0.35, 0.5)
        th = rng.uniform(0.0, np.pi)
        cx = int(rng.integers(n))
        cy = int(rng.integers(n))
        R = int(np.ceil(a)) + 1
        d = np.arange(-R, R + 1)
        dy, dx = np.meshgrid(d, d, indexing='ij')
        c, s = np.cos(th), np.sin(th)
        u = dx * c + dy * s  # along the leaf
        v = -dx * s + dy * c  # across the leaf
        q = (u / a) ** 2 + (v / b) ** 2
        inside = q <= 1.0
        if not inside.any():
            continue

        ys = (cy + d) % n
        xs = (cx + d) % n
        ix = np.ix_(ys, xs)

        # Dome height: leaves stand above the soil.
        dome = np.sqrt(np.clip(1.0 - q, 0.0, 1.0))

        # Colour: per-leaf brightness, lateral veins and a midrib.
        base = rng.uniform(0.45, 0.78)
        vein_phase = (u / a) * 4.0 - 2.5 * np.abs(v) / b
        vein = np.exp(-(np.sin(np.pi * vein_phase) / 0.15) ** 2)
        mid = np.exp(-(v / (0.08 * b + 0.6)) ** 2)
        shade = base * (1.0 - 0.14 * vein - 0.2 * mid)

        rough_leaf = rng.uniform(0.55, 0.7)

        lum[ix] = np.where(inside, shade, lum[ix])
        height[ix] = np.where(inside, 0.35 + 0.6 * dome, height[ix])
        rough[ix] = np.where(inside, rough_leaf, rough[ix])

    height = _rock_norm(height)
    lum = np.clip(lum, 0.0, 1.0)
    rough = np.clip(rough, 0.0, 1.0)
    return noise.pack_detail(lum, height, rough, strength=4.0)



if __name__ == "__main__":
    sys.exit(main(sys.argv))
