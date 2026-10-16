#!/usr/bin/env python3
"""Offline texture generator for the velo-sim detail maps.

Usage, from the repository root:
    python3 tools/texgen/texgen.py <name>     generate one texture
    python3 tools/texgen/texgen.py all        generate every registered texture
    python3 tools/texgen/texgen.py selftest   check tileability of the noise code

Output: apps/client/public/textures/<name>.webp (folder is created if missing).
Generators are registered with @generator('<name>') in the section at the end
of this file. Without a size argument a generator takes the side n (int) and returns
uint8 RGBA of shape (n, n, 4), normally via noise.pack_detail. With
@generator('<name>', size=(w, h)) it takes the tuple (w, h) and returns shape (h, w, 4).
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

# name -> generator function fn(n) or fn((w, h)) -> uint8 RGBA (h, w, 4)
GENERATORS = {}
# name -> None for square SIZE textures, or (w, h) for generators with their own size
SIZES = {}

SEAM_LIMIT = 0.02   # max mean absolute difference across the wrap seam
SEAM_RATIO = 3.0    # seam difference must be within this factor of the inner difference


def generator(name, size=None):
    """Register a texture generator under the given name.

    size=None: square SIZE x SIZE, the function takes n.
    size=(w, h): the function takes the tuple (w, h).
    """
    def register(fn):
        if name in GENERATORS:
            raise ValueError(f"generator '{name}' is already registered")
        GENERATORS[name] = fn
        SIZES[name] = size
        return fn
    return register


def build(name):
    """Run one generator and write its WebP. Returns the output path."""
    size = SIZES[name]
    if size is None:
        rgba = GENERATORS[name](SIZE)
        expected = (SIZE, SIZE, 4)
    else:
        w, h = size
        rgba = GENERATORS[name](size)
        expected = (h, w, 4)
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



# --- Leaves, bark and grass (albedo, straight alpha, see noise.pack_albedo) ---
# Shapes are drawn in pixels with a 1 px antialiased edge. Each cell is built on its own
# canvas and bled separately, so colour never crosses from one cell into another.

LEAF_CELL = 512                      # side of one cell of the 4 x 4 leaf atlas
LEAF_MARGIN = 8                      # free border inside each cell, nothing drawn there
LEAF_COVER = (0.45, 0.65)            # accepted opaque coverage per cell (alpha > 0.5)
LEAF_AIM = 0.55                      # coverage the scale search aims at
FREE_CELL_RGB = np.array([0.30, 0.42, 0.20])

CHESTNUT = (0.24, 0.42, 0.14)
BEECH = (0.34, 0.52, 0.22)
PLANE = (0.40, 0.54, 0.22)
OLIVE = (0.56, 0.62, 0.48)
PALM = (0.24, 0.44, 0.16)
PALM_STEM = (0.36, 0.42, 0.20)
SPRUCE = (0.10, 0.24, 0.13)
LARCH = (0.64, 0.76, 0.34)
CYPRESS = (0.14, 0.24, 0.16)
OLEANDER = (0.20, 0.38, 0.18)
OLEANDER_FLOWER = (0.92, 0.46, 0.62)
LAUREL = (0.14, 0.34, 0.13)


def _canvas(h, w):
    """Empty colour (h, w, 3) and alpha (h, w) arrays."""
    return np.zeros((h, w, 3)), np.zeros((h, w))


def _paint(rgb, alpha, cx, cy, theta, d_fn, reach, base, shade=None):
    """Composite one shape over the canvas with straight alpha ('over').

    The shape sits at (cx, cy) in canvas pixels and is rotated by theta. d_fn(lx, ly) gives
    the signed distance in pixels in the shape's own frame (x along the leaf, y across,
    positive inside). Alpha is clipped over one pixel for antialiasing. shade(lx, ly, d)
    returns a brightness factor per pixel. reach is the radius that contains the shape.
    """
    h, w = alpha.shape
    R = reach + 2.0
    x0 = max(0, int(np.floor(cx - R)))
    x1 = min(w, int(np.ceil(cx + R)) + 1)
    y0 = max(0, int(np.floor(cy - R)))
    y1 = min(h, int(np.ceil(cy + R)) + 1)
    if x1 <= x0 or y1 <= y0:
        return
    ys = np.arange(y0, y1) + 0.5
    xs = np.arange(x0, x1) + 0.5
    Y, X = np.meshgrid(ys, xs, indexing="ij")
    dx = X - cx
    dy = Y - cy
    c, s = np.cos(theta), np.sin(theta)
    lx = dx * c + dy * s
    ly = -dx * s + dy * c
    d = d_fn(lx, ly)
    a = np.clip(d + 0.5, 0.0, 1.0)
    if not a.any():
        return
    f = np.ones(a.shape) if shade is None else np.broadcast_to(shade(lx, ly, d), a.shape)
    col = np.asarray(base, dtype=np.float64)[None, None, :] * f[..., None]
    old_a = alpha[y0:y1, x0:x1]
    old_rgb = rgb[y0:y1, x0:x1]
    out_a = a + old_a * (1.0 - a)
    num = col * a[..., None] + old_rgb * (old_a * (1.0 - a))[..., None]
    rgb[y0:y1, x0:x1] = num / np.maximum(out_a, 1e-9)[..., None]
    alpha[y0:y1, x0:x1] = out_a


def _lance_d(L, W, p=0.8, teeth=0):
    """Lanceolate leaf: base at x = -L/2, tip at x = +L/2, widest width W. Optional saw teeth."""
    def d_fn(x, y):
        t = np.clip((x + L / 2) / L, 0.0, 1.0)
        hw = (W / 2) * np.sin(np.pi * t ** p) ** 0.9
        if teeth:
            hw = hw * (0.88 + 0.12 * np.abs(np.sin(np.pi * teeth * t)))
        d = hw - np.abs(y)
        return np.minimum(d, np.minimum(x + L / 2, L / 2 - x))
    return d_fn


def _ellipse_d(rx, ry):
    """Ellipse with semi-axes rx (along x) and ry."""
    def d_fn(x, y):
        q = np.sqrt((x / rx) ** 2 + (y / ry) ** 2)
        return (1.0 - q) * min(rx, ry)
    return d_fn


def _lobed_d(R, lobes=5, depth=0.4):
    """Palmate leaf with `lobes` rounded lobes; sinuses go down to (1 - depth) * R."""
    def d_fn(x, y):
        r = np.hypot(x, y)
        th = np.arctan2(y, x)
        edge = R * (1.0 - depth + depth * np.abs(np.cos(lobes / 2.0 * th)) ** 1.6)
        return edge - r
    return d_fn


def _disc_d(r):
    """Disc of radius r around the origin."""
    def d_fn(x, y):
        return r - np.hypot(x, y)
    return d_fn


def _leaf_shade(half_len, half_w, veins=0, gloss=0.0):
    """Brightness factor: lighter midrib, optional lateral veins, optional glossy stripe."""
    def shade(x, y, d):
        u = np.clip(x / half_len, -1.0, 1.0)
        v = np.clip(y / half_w, -1.0, 1.0)
        f = 1.0 - 0.05 * u
        f = f + 0.10 * np.exp(-(v / 0.08) ** 2)
        if veins:
            f = f + 0.06 * np.sin(np.pi * (veins * 0.5 * (u + 1.0) - 1.5 * np.abs(v)))
        if gloss:
            f = f + gloss * np.exp(-((v + 0.15) / 0.22) ** 2)
        return f
    return shade


def _place(rng, reach):
    """Random centre inside the cell, with the whole shape inside the margin. None if it does not fit."""
    lo = LEAF_MARGIN + reach
    hi = LEAF_CELL - LEAF_MARGIN - reach
    if lo > hi:
        return None
    return rng.uniform(lo, hi, size=2)


def _draw_lance(n, L, W, base, teeth=0, veins=0):
    def draw(rng, rgb, alpha, scale):
        for _ in range(n):
            L_i = L * scale * rng.uniform(0.9, 1.1)
            W_i = W * scale * rng.uniform(0.9, 1.1)
            reach = L_i / 2 + 1.0
            theta = rng.uniform(0.0, 2 * np.pi)
            tone = rng.uniform(0.9, 1.1)
            p = _place(rng, reach)
            if p is None:
                continue
            _paint(rgb, alpha, p[0], p[1], theta, _lance_d(L_i, W_i, teeth=teeth), reach,
                   np.array(base) * tone, _leaf_shade(L_i / 2, W_i / 2, veins))
    return draw


def _draw_ellipses(n, rx, ry, base, veins=0, gloss=0.0, angle=None):
    def draw(rng, rgb, alpha, scale):
        for _ in range(n):
            rx_i = rx * scale * rng.uniform(0.9, 1.1)
            ry_i = ry * scale * rng.uniform(0.9, 1.1)
            reach = rx_i + 1.0
            if angle is None:
                theta = rng.uniform(0.0, 2 * np.pi)
            else:
                theta = angle + rng.uniform(-0.4, 0.4)
            tone = rng.uniform(0.9, 1.1)
            p = _place(rng, reach)
            if p is None:
                continue
            _paint(rgb, alpha, p[0], p[1], theta, _ellipse_d(rx_i, ry_i), reach,
                   np.array(base) * tone, _leaf_shade(rx_i, ry_i, veins, gloss))
    return draw


def _draw_plane(n, R, base):
    def draw(rng, rgb, alpha, scale):
        for _ in range(n):
            R_i = R * scale * rng.uniform(0.9, 1.1)
            reach = R_i + 1.0
            theta = rng.uniform(0.0, 2 * np.pi)
            tone = rng.uniform(0.9, 1.1)
            p = _place(rng, reach)
            if p is None:
                continue
            # Radial veins run out into the five lobes.
            shade = lambda x, y, d: 1.0 + 0.08 * np.cos(5.0 * np.arctan2(y, x))
            _paint(rgb, alpha, p[0], p[1], theta, _lobed_d(R_i), reach,
                   np.array(base) * tone, shade)
    return draw


def _draw_sprigs(n, branch, needle_L, needle_W, base, spread=0.6, step=4.0):
    """Conifer sprigs: a short stem with needles on both sides, pointing forward."""
    def draw(rng, rgb, alpha, scale):
        Ln = needle_L * scale
        Wn = needle_W * scale
        for _ in range(n):
            ang = rng.uniform(0.0, np.pi)
            tone = rng.uniform(0.9, 1.1)
            p = _place(rng, branch / 2 + Ln + 2)
            if p is None:
                continue
            ax = np.array([np.cos(ang), np.sin(ang)])
            for s_ in np.linspace(-branch / 2, branch / 2, 24):
                q = p + ax * s_
                _paint(rgb, alpha, q[0], q[1], 0.0, _disc_d(1.6), 2.6, np.array(base) * 0.6)
            for s_ in np.arange(-branch / 2, branch / 2, step):
                q = p + ax * s_
                for side in (1.0, -1.0):
                    na = ang + side * spread * rng.uniform(0.9, 1.1)
                    c = q + np.array([np.cos(na), np.sin(na)]) * Ln / 2
                    _paint(rgb, alpha, c[0], c[1], na, _lance_d(Ln, Wn, p=0.5), Ln / 2 + 1,
                           np.array(base) * tone * rng.uniform(0.95, 1.05),
                           _leaf_shade(Ln / 2, Wn / 2))
    return draw


def _draw_larch(n, needle_L, needle_W, base, needles=7):
    """Larch: soft tufts of needles on short shoots. The needles of one tuft point the same way
    (a brush, not a star), with a thin shoot through the middle."""
    def draw(rng, rgb, alpha, scale):
        Ln = needle_L * scale
        Wn = needle_W * scale
        for _ in range(n):
            tone = rng.uniform(0.9, 1.1)
            p = _place(rng, Ln * 0.8 + 2)
            if p is None:
                continue
            ang = rng.uniform(0.0, 2 * np.pi)
            ax = np.array([np.cos(ang), np.sin(ang)])
            for s_ in np.linspace(-Ln * 0.4, Ln * 0.4, 10):
                q = p + ax * s_
                _paint(rgb, alpha, q[0], q[1], 0.0, _disc_d(1.2), 2.2, np.array(base) * 0.55)
            for k in range(needles):
                off = (k / (needles - 1) - 0.5) * Ln * 0.5
                na = ang + (k / (needles - 1) - 0.5) * 0.5 + rng.uniform(-0.06, 0.06)
                start = p + ax * off
                c = start + np.array([np.cos(na), np.sin(na)]) * Ln / 2
                _paint(rgb, alpha, c[0], c[1], na, _lance_d(Ln, Wn, p=0.5), Ln / 2 + 1,
                       np.array(base) * tone, _leaf_shade(Ln / 2, Wn / 2))
    return draw


def _draw_oleander(rng, rgb, alpha, scale):
    _draw_lance(110, 80, 12, OLEANDER)(rng, rgb, alpha, scale)
    # Four flower heads of about a dozen small pink florets each.
    for _ in range(4):
        p = _place(rng, 18.0 * scale + 4.0)
        if p is None:
            continue
        for _ in range(12):
            off = rng.normal(0.0, 7.0 * scale, size=2)
            r = 4.0 * scale * rng.uniform(0.9, 1.1)
            q = p + off
            _paint(rgb, alpha, q[0], q[1], 0.0, _disc_d(r), r + 1.0,
                   np.array(OLEANDER_FLOWER) * rng.uniform(0.9, 1.1))


def _draw_palm(rng, rgb, alpha, scale):
    """One palm frond: an arched rachis from the lower-left to the upper-right corner, with pinnae."""
    p0 = np.array([14.0, 14.0])
    p1 = np.array([498.0, 498.0])
    dv = p1 - p0
    tdir = dv / np.linalg.norm(dv)
    nrm = np.array([-tdir[1], tdir[0]])

    def pt(t):
        return p0 + dv * t + nrm * (40.0 * np.sin(np.pi * t))

    for t in np.linspace(0.0, 1.0, 120):
        q = pt(t)
        _paint(rgb, alpha, q[0], q[1], 0.0, _disc_d(4.0 * scale), 4.0 * scale + 1.0,
               np.array(PALM_STEM))
    for t in np.arange(0.03, 0.99, 0.006):
        bp = pt(t)
        tang = pt(min(t + 1e-3, 1.0)) - pt(max(t - 1e-3, 0.0))
        tang = tang / np.linalg.norm(tang)
        env = np.sin(np.pi * t) ** 0.5
        for side in (1.0, -1.0):
            ang = np.arctan2(tang[1], tang[0]) + side * rng.uniform(0.8, 1.0)
            Lp = 150.0 * scale * rng.uniform(0.85, 1.1) * (0.35 + 0.65 * env)
            Wp = 20.0 * scale * rng.uniform(0.9, 1.1)
            tone = rng.uniform(0.9, 1.1)
            dirv = np.array([np.cos(ang), np.sin(ang)])
            tip = bp + dirv * Lp
            if not (np.all(tip >= LEAF_MARGIN) and np.all(tip <= LEAF_CELL - LEAF_MARGIN)):
                continue
            c = bp + dirv * Lp / 2
            _paint(rgb, alpha, c[0], c[1], ang, _lance_d(Lp, Wp, p=0.6), Lp / 2 + 1,
                   np.array(PALM) * tone, _leaf_shade(Lp / 2, Wp / 2, veins=4))


def _fill_cell(seed, draw):
    """Draw one leaf cell, scaling the leaves until the coverage is in range.

    draw(rng, rgb, alpha, scale) is run again with the same seed for each try, so the result
    is deterministic. Returns (rgb, alpha, coverage).
    """
    scale = 1.0
    best = None
    last = 0.0
    for _ in range(14):
        rgb, alpha = _canvas(LEAF_CELL, LEAF_CELL)
        draw(np.random.default_rng(seed), rgb, alpha, scale)
        cov = float((alpha > 0.5).mean())
        last = cov
        if 0.50 <= cov <= 0.60:
            return rgb, alpha, cov
        # Keep the first result inside the accepted range, in case the search plateaus.
        if best is None and LEAF_COVER[0] <= cov <= LEAF_COVER[1]:
            best = (rgb, alpha, cov)
        if scale > 3.0:
            break
        scale *= np.sqrt(LEAF_AIM / max(cov, 1e-3))
    if best is None:
        raise ValueError(f"leaf cell coverage {last:.3f} outside {LEAF_COVER} (seed {seed})")
    return best


def _finish_cell(rgb, alpha, default):
    """Give transparent pixels the mean colour of the opaque ones (or default) before bleeding."""
    opaque = alpha > 0.5
    mean = rgb[opaque].mean(axis=0) if opaque.any() else np.asarray(default, dtype=np.float64)
    return np.where(opaque[..., None], rgb, mean)


LEAF_DRAWS = [
    _draw_lance(16, 280, 90, CHESTNUT, teeth=14, veins=10),    # 0 chestnut
    _draw_ellipses(75, 34, 22, BEECH, veins=3),                # 1 beech
    _draw_plane(14, 75, PLANE),                                # 2 plane
    _draw_lance(180, 80, 16, OLIVE),                           # 3 olive
    _draw_palm,                                                # 4 palm frond
    _draw_sprigs(90, 70, 28, 5, SPRUCE),                       # 5 spruce
    _draw_larch(110, 26, 3.5, LARCH, needles=9),               # 6 larch
    _draw_sprigs(120, 52, 14, 8, CYPRESS, spread=0.22, step=3.0),  # 7 cypress
    _draw_oleander,                                            # 8 oleander
    _draw_ellipses(60, 42, 21, LAUREL, gloss=0.12),            # 9 laurel
]


@generator('leaves', size=(2048, 2048))
def leaves(size):
    """Leaf tufts seen from above, 4 x 4 cells of 512 px. Cells 10-15 stay empty."""
    w, h = size
    out = np.zeros((h, w, 4), dtype=np.uint8)
    per_row = w // LEAF_CELL
    for i in range(per_row * (h // LEAF_CELL)):
        r, c = divmod(i, per_row)
        if i < len(LEAF_DRAWS):
            rgb, alpha, _ = _fill_cell(100 + i, LEAF_DRAWS[i])
        else:
            rgb, alpha = _canvas(LEAF_CELL, LEAF_CELL)
        rgb = _finish_cell(rgb, alpha, FREE_CELL_RGB)
        tile = noise.pack_albedo(rgb, alpha)
        out[r * LEAF_CELL:(r + 1) * LEAF_CELL, c * LEAF_CELL:(c + 1) * LEAF_CELL] = tile
    return out


def _bark_cell(kind, n=512):
    """One bark cell of n x n, tileable in both directions (periodic noise, integer repeats)."""
    seed = 300 + kind * 10
    yy, xx = np.indices((n, n)).astype(np.float64)
    x = xx / n
    y = yy / n
    grain = noise.fbm(n, octaves=4, base_freq=48, seed=seed + 1).astype(np.float64)
    warp = noise.fbm(n, octaves=3, base_freq=3, seed=seed + 2).astype(np.float64)
    if kind == 0:
        # Furrowed: 10 vertical folds per cell, slightly wavy. Grey-brown.
        ridge = np.abs(np.sin(np.pi * (10.0 * x + 0.25 * (warp - 0.5))))
        lum = 0.34 + 0.14 * ridge ** 0.6 + 0.05 * (grain - 0.5)
        tint = np.array([1.0, 0.97, 0.92])
    elif kind == 1:
        # Smooth grey with darker lichen blotches.
        spots = noise.fbm(n, octaves=4, base_freq=6, seed=seed + 3).astype(np.float64)
        m = np.clip((spots - 0.6) / 0.05, 0.0, 1.0)
        lum = 0.62 + 0.04 * (grain - 0.5)
        lum = lum * (1.0 - 0.35 * m)
        tint = np.array([1.0, 1.0, 0.98])
    elif kind == 2:
        # Scaly: rounded plates from a Voronoi grid of 10 x 10, reddish brown.
        f1, _, cid = noise.voronoi(n, cells=100, seed=seed + 4)
        rng = np.random.default_rng(seed + 5)
        tone = rng.uniform(-0.08, 0.08, 100)
        dome = np.clip(1.0 - f1.astype(np.float64) / 0.85, 0.0, 1.0) ** 0.5
        lum = 0.40 + 0.10 * (dome - 0.5) + tone[cid] + 0.06 * (grain - 0.5)
        tint = np.array([1.0, 0.82, 0.68])
    else:
        # Palm trunk: horizontal leaf-scar rings, 8 per cell, light grey-brown.
        ring = np.abs(np.sin(np.pi * (8.0 * y + 0.08 * (warp - 0.5))))
        lum = 0.52 + 0.14 * ring ** 0.5 + 0.05 * (grain - 0.5)
        tint = np.array([1.0, 0.94, 0.84])
    rgb = np.clip(lum, 0.0, 1.0)[..., None] * tint[None, None, :]
    return rgb


@generator('bark', size=(1024, 1024))
def bark(size):
    """2 x 2 cells of 512 px, opaque, each cell tileable in v (and in u)."""
    w, h = size
    out = np.zeros((h, w, 4), dtype=np.uint8)
    per_row = w // 512
    for i in range(per_row * (h // 512)):
        r, c = divmod(i, per_row)
        rgb = _bark_cell(i)
        tile = noise.pack_albedo(rgb, np.ones((512, 512)))
        out[r * 512:(r + 1) * 512, c * 512:(c + 1) * 512] = tile
    return out


def _grass_blade(rng, rgb, alpha, base_x, height, lean, width0, colors, bend=0.0):
    """One blade: a bent stroke from the bottom edge, tapering to the tip."""
    P0 = np.array([base_x, 500.0])
    tip_x = float(np.clip(base_x + lean, LEAF_MARGIN, LEAF_CELL - LEAF_MARGIN))
    P2 = np.array([tip_x, 500.0 - height])
    P1 = P0 + np.array([(P2[0] - P0[0]) * 0.2 + bend, -height * 0.55])
    color = np.array(colors[int(rng.integers(len(colors)))]) * rng.uniform(0.92, 1.08)
    n_pts = int(height / 1.5) + 2   # about 1.5 px between stamps, so the blade is a solid stroke
    for k in range(n_pts):
        t = k / (n_pts - 1)
        q = (1 - t) ** 2 * P0 + 2 * (1 - t) * t * P1 + t * t * P2
        r = width0 * (1 - t) ** 0.9 + 0.4
        _paint(rgb, alpha, q[0], q[1], 0.0, _disc_d(r), r + 1.0, color)
    return P2


def _grass_cell(kind):
    rng = np.random.default_rng(400 + kind)
    rgb, alpha = _canvas(LEAF_CELL, LEAF_CELL)
    if kind == 3:
        # Fern: arched fronds with paired leaflets.
        fern = [(0.20, 0.44, 0.18), (0.27, 0.52, 0.23)]
        for _ in range(5):
            base_x = 256.0 + rng.normal(0.0, 16.0)
            height = rng.uniform(280.0, 420.0)
            lean = rng.uniform(-150.0, 150.0)
            bend = rng.uniform(-60.0, 60.0)
            P0 = np.array([base_x, 500.0])
            P2 = P0 + np.array([lean, -height])
            P1 = P0 + np.array([lean * 0.15 + bend, -height * 0.6])
            color = np.array(fern[int(rng.integers(2))]) * rng.uniform(0.92, 1.08)
            n_stem = int(height / 1.5) + 2
            for k in range(n_stem):
                t = k / (n_stem - 1)
                q = (1 - t) ** 2 * P0 + 2 * (1 - t) * t * P1 + t * t * P2
                tg = 2 * (1 - t) * (P1 - P0) + 2 * t * (P2 - P1)
                tg = tg / np.linalg.norm(tg)
                _paint(rgb, alpha, q[0], q[1], 0.0, _disc_d(1.4), 2.4, color)
                if k >= 3 and k % 4 == 0 and k < n_stem - 3:
                    Lf = 46.0 * (1.0 - t) ** 0.7 + 8.0
                    for side in (1.0, -1.0):
                        na = np.arctan2(tg[1], tg[0]) + side * 0.9 * rng.uniform(0.9, 1.1)
                        c = q + np.array([np.cos(na), np.sin(na)]) * Lf / 2
                        _paint(rgb, alpha, c[0], c[1], na, _lance_d(Lf, Lf * 0.28, p=0.6),
                               Lf / 2 + 1, color * rng.uniform(0.95, 1.05),
                               _leaf_shade(Lf / 2, Lf * 0.14))
        return rgb, alpha

    if kind == 0:
        colors = [(0.34, 0.56, 0.20), (0.26, 0.46, 0.15), (0.42, 0.60, 0.24)]
    elif kind == 1:
        colors = [(0.70, 0.60, 0.34), (0.62, 0.50, 0.27), (0.76, 0.66, 0.40)]
    else:
        colors = [(0.34, 0.56, 0.20), (0.26, 0.46, 0.15), (0.42, 0.60, 0.24)]
    count = 110 if kind != 1 else 90
    tips = []
    for _ in range(count):
        base_x = 256.0 + rng.normal(0.0, 22.0)
        height = rng.uniform(170.0, 450.0)
        lean = rng.uniform(-200.0, 200.0)
        bend = rng.uniform(-40.0, 40.0)
        tip = _grass_blade(rng, rgb, alpha, base_x, height, lean, 3.4, colors, bend)
        tips.append(tip)
    if kind == 2:
        # White and yellow flowers at the tips of about a quarter of the blades.
        for k in range(0, len(tips), 4):
            tip = tips[k]
            yellow = rng.random() < 0.4
            petal = (0.95, 0.80, 0.25) if yellow else (0.96, 0.95, 0.90)
            for j in range(5):
                a = 2 * np.pi * j / 5 + rng.uniform(-0.2, 0.2)
                q = tip + np.array([np.cos(a), np.sin(a)]) * 4.0
                _paint(rgb, alpha, q[0], q[1], 0.0, _disc_d(3.0), 4.0, petal)
            _paint(rgb, alpha, tip[0], tip[1], 0.0, _disc_d(1.8), 2.8, (0.90, 0.70, 0.20))
    return rgb, alpha


@generator('grass', size=(2048, 512))
def grass(size):
    """Four cells of 512 px in a row: green tuft, dry grass, flowering grass, fern."""
    w, h = size
    out = np.zeros((h, w, 4), dtype=np.uint8)
    for i in range(w // 512):
        rgb, alpha = _grass_cell(i)
        rgb = _finish_cell(rgb, alpha, (0.3, 0.42, 0.2))
        out[:, i * 512:(i + 1) * 512] = noise.pack_albedo(rgb, alpha)
    return out


def _fbm_stretched(w, h, octaves, base_freq, seed, stretch_x):
    """Tileable fbm like noise.fbm, with features stretched by stretch_x along x.

    Same band-pass construction as noise.fbm; the x frequency is divided by stretch_x,
    so the result stays periodic with integer frequencies. Returns float64 in [0, 1].
    """
    rng = np.random.default_rng(seed)
    spectrum = np.fft.fft2(rng.standard_normal((h, w)))
    kx, ky = np.meshgrid(np.fft.fftfreq(w, d=1.0 / w), np.fft.fftfreq(h, d=1.0 / h))
    r = np.hypot(kx / stretch_x, ky)
    safe_r = np.where(r > 0, r, 1.0)
    total = np.zeros((h, w), dtype=np.float64)
    for o in range(octaves):
        f0 = base_freq * (2.0 ** o)
        band = np.exp(-0.5 * (np.log2(safe_r / f0) / 0.5) ** 2)
        band[r == 0] = 0.0
        total += (0.5 ** o) * np.real(np.fft.ifft2(spectrum * band))
    lo, hi = float(total.min()), float(total.max())
    return (total - lo) / (hi - lo)


@generator('ripples', size=(512, 512))
def ripples(size):
    """Lake ripple normal map, tileable and lossless.

    Height is fbm with 4 octaves, stretched 2.5x along x (wind direction). R = normal X,
    G = normal Z (both 0.5 = flat), B = 1, A = 1. Kept out of pack_detail on purpose: this
    map is sampled as a slope (rg), not as a detail map.
    """
    w, h = size
    height = _fbm_stretched(w, h, octaves=4, base_freq=4, seed=7, stretch_x=2.5)
    nx, nz = noise.height_to_normal(height, strength=2.0)
    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[..., 0] = np.clip(nx * 255.0 + 0.5, 0, 255).astype(np.uint8)
    out[..., 1] = np.clip(nz * 255.0 + 0.5, 0, 255).astype(np.uint8)
    out[..., 2] = 255
    out[..., 3] = 255
    return out


if __name__ == "__main__":
    sys.exit(main(sys.argv))
