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

if __name__ == "__main__":
    sys.exit(main(sys.argv))
