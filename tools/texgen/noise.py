"""Tileable noise building blocks for offline texture generation.

Everything wraps around at the edges, so every result tiles seamlessly.
Arrays are square (n x n). Only numpy is used for the maths; Pillow is used
for WebP output.
"""

import os

import numpy as np
from PIL import Image


def _normalize(a):
    """Map an array linearly to [0, 1] (float32). Flat input becomes zeros."""
    lo = float(a.min())
    hi = float(a.max())
    if hi - lo < 1e-12:
        return np.zeros(a.shape, dtype=np.float32)
    return ((a - lo) / (hi - lo)).astype(np.float32)


def _frequency_radius(n):
    """Radius of every FFT bin in cycles per tile (0 at DC)."""
    f = np.fft.fftfreq(n, d=1.0 / n)  # integer frequencies
    kx, ky = np.meshgrid(f, f)
    return np.hypot(kx, ky)


def fbm(n=1024, octaves=5, base_freq=4, seed=0):
    """Tileable fractal noise in [0, 1].

    Octave o is a band-pass of one white-noise field around base_freq * 2**o
    cycles per tile, weighted by 0.5**o. Filtering is done in the frequency
    domain with integer frequencies, so the result is periodic by construction.
    """
    rng = np.random.default_rng(seed)
    spectrum = np.fft.fft2(rng.standard_normal((n, n)))
    r = _frequency_radius(n)
    safe_r = np.where(r > 0, r, 1.0)
    total = np.zeros((n, n), dtype=np.float64)
    for o in range(octaves):
        f0 = base_freq * (2.0 ** o)
        # Gaussian band in log-frequency, centred on f0, 0.5 octave wide
        band = np.exp(-0.5 * (np.log2(safe_r / f0) / 0.5) ** 2)
        band[r == 0] = 0.0
        layer = np.real(np.fft.ifft2(spectrum * band))
        total += (0.5 ** o) * layer
    return _normalize(total)


def voronoi(n=1024, cells=900, seed=0):
    """Tileable Voronoi (cellular) noise.

    One jittered feature point per cell of a G x G grid, G = round(sqrt(cells)),
    so the real point count is G * G. Returns (f1, f2, cell_id):
      f1, f2   distance to the nearest and second-nearest point, in units of one
               grid cell (about 1.0 for a typical point spacing), float32
      cell_id  index of the nearest point, int32 in [0, G * G)
    Distances wrap around the tile edges. Neighbourhood search is 5 x 5 cells.
    """
    rng = np.random.default_rng(seed)
    g = max(1, int(round(np.sqrt(cells))))
    cs = n / g  # size of one grid cell in pixels

    jitter = rng.random((g, g, 2))
    gy, gx = np.meshgrid(np.arange(g), np.arange(g), indexing="ij")
    px = (gx + jitter[..., 0]) * cs
    py = (gy + jitter[..., 1]) * cs
    ids = (gy * g + gx).astype(np.int32)

    coords = np.arange(n) + 0.5
    X, Y = np.meshgrid(coords, coords)
    cell_x = np.floor(X / cs).astype(np.int64)
    cell_y = np.floor(Y / cs).astype(np.int64)

    f1 = np.full((n, n), np.inf)
    f2 = np.full((n, n), np.inf)
    cid = np.zeros((n, n), dtype=np.int32)
    for oy in range(-2, 3):
        for ox in range(-2, 3):
            nx = cell_x + ox
            ny = cell_y + oy
            wx = np.mod(nx, g)
            wy = np.mod(ny, g)
            # Neighbour cells across the tile edge are shifted by whole tiles.
            sx = np.floor_divide(nx, g) * n
            sy = np.floor_divide(ny, g) * n
            fx = px[wy, wx] + sx
            fy = py[wy, wx] + sy
            d = np.hypot(X - fx, Y - fy)
            closer = d < f1
            f2 = np.where(closer, f1, np.minimum(f2, d))
            cid = np.where(closer, ids[wy, wx], cid)
            f1 = np.minimum(f1, d)

    return (f1 / cs).astype(np.float32), (f2 / cs).astype(np.float32), cid


def _shifted(h, dy, dx):
    """h[i + dy, j + dx] with wrap-around."""
    return np.roll(h, shift=(-dy, -dx), axis=(0, 1))


def height_to_normal(h, strength=1.0):
    """Normal map from a height field, tileable (Sobel 3 x 3 via np.roll).

    Slopes are dh/dx and dh/dy in pixel units (Sobel sum divided by 8), scaled
    by strength. Normal = normalize(-slope_x, -slope_y, 1). Returns (nx, ny) as
    float32 in [0, 1], 0.5 meaning flat. Image rows point down, so ny follows
    the row index.
    """
    h = np.asarray(h, dtype=np.float64)
    gx = (_shifted(h, -1, 1) + 2 * _shifted(h, 0, 1) + _shifted(h, 1, 1)
          - _shifted(h, -1, -1) - 2 * _shifted(h, 0, -1) - _shifted(h, 1, -1))
    gy = (_shifted(h, 1, -1) + 2 * _shifted(h, 1, 0) + _shifted(h, 1, 1)
          - _shifted(h, -1, -1) - 2 * _shifted(h, -1, 0) - _shifted(h, -1, 1))
    scale = strength / 8.0
    sx = -gx * scale
    sy = -gy * scale
    length = np.sqrt(sx * sx + sy * sy + 1.0)
    nx = sx / length
    ny = sy / length
    return (nx * 0.5 + 0.5).astype(np.float32), (ny * 0.5 + 0.5).astype(np.float32)


def pack_detail(lum, height, rough, strength=1.0):
    """Pack a detail map as uint8 RGBA (n, n, 4).

    R = lum (brightness), G = normal Y, B = roughness, A = normal X.
    lum, height and rough are float arrays in [0, 1]; the normal comes from height.
    Neutral value is 0.5.
    """
    nx, ny = height_to_normal(height, strength)
    rgba = np.stack([
        np.asarray(lum, dtype=np.float32),
        ny,
        np.asarray(rough, dtype=np.float32),
        nx,
    ], axis=-1)
    rgba = np.clip(rgba, 0.0, 1.0)
    return (rgba * 255.0 + 0.5).astype(np.uint8)


def save_webp(path, rgba, quality=90, lossless=False):
    """Write an RGBA uint8 array (n, n, 4) as a WebP file.

    Lossy by default (quality 0-100). lossless=True keeps the exact values,
    at a larger file size.
    """
    rgba = np.asarray(rgba)
    if rgba.dtype != np.uint8 or rgba.ndim != 3 or rgba.shape[2] != 4:
        raise ValueError("save_webp expects uint8 RGBA data of shape (n, n, 4)")
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    if lossless:
        Image.fromarray(rgba).save(path, "WEBP", lossless=True, method=6)
    else:
        Image.fromarray(rgba).save(path, "WEBP", quality=quality, method=6)


def dilate(rgb, alpha, steps=32):
    """Bleed colour from opaque pixels into transparent ones.

    rgb is float (h, w, 3), alpha float (h, w). A pixel counts as opaque when alpha > 0.5.
    Each step sets every non-opaque pixel that touches an opaque one (3 x 3 neighbourhood)
    to the mean colour of those opaque neighbours and counts it as opaque from then on.
    Stops when everything is filled or after `steps` steps. Alpha is not changed.
    Returns float64 (h, w, 3). Not periodic: the edges are not wrapped.
    """
    out = np.array(rgb, dtype=np.float64)
    known = np.asarray(alpha, dtype=np.float64) > 0.5
    h, w = known.shape
    for _ in range(steps):
        if known.all():
            break
        k = known.astype(np.float64)
        col = out * k[..., None]
        kp = np.pad(k, 1)
        cp = np.pad(col, ((1, 1), (1, 1), (0, 0)))
        cnt = np.zeros((h, w))
        acc = np.zeros((h, w, 3))
        for dy in range(3):
            for dx in range(3):
                cnt += kp[dy:dy + h, dx:dx + w]
                acc += cp[dy:dy + h, dx:dx + w]
        grow = (~known) & (cnt > 0)
        if not grow.any():
            break
        out[grow] = acc[grow] / cnt[grow][:, None]
        known = known | grow
    return out


def pack_albedo(rgb, alpha, steps=32):
    """Pack a colour texture as uint8 RGBA (h, w, 4), straight (not premultiplied) alpha.

    rgb is float in [0, 1] (sRGB), alpha float in [0, 1]. The colour of transparent pixels is
    bled outwards with dilate(), so mipmaps do not pick up dark fringes.
    """
    rgb = np.asarray(rgb, dtype=np.float64)
    alpha = np.clip(np.asarray(alpha, dtype=np.float64), 0.0, 1.0)
    bled = dilate(rgb, alpha, steps=steps)
    rgba = np.concatenate([bled, alpha[..., None]], axis=-1)
    rgba = np.clip(rgba, 0.0, 1.0)
    return (rgba * 255.0 + 0.5).astype(np.uint8)
