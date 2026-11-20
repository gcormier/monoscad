#!/usr/bin/env python3
"""
Build the static rugged box generator site.

  python3 web/build_site.py --out _site [--openscad openscad] [--wasm-dir DIR]
                            [--models-cache DIR] [--skip-catalog] [--jobs N]

* Copies the web UI from web/rugged-box into <out>/rugged-box
* Copies the OpenSCAD sources needed by the in-browser generator into
  <out>/rugged-box/scad (flattened: symlinks resolved)
* Copies the OpenSCAD WebAssembly build (openscad.js + openscad.wasm)
* Renders the prebuilt catalog in web/catalog.json with the "Greg" preset
  using a native OpenSCAD, and packs each size into one multi-part 3MF kit
  (bottom, top, latches, handle, label) that Bambu Studio can open directly.
"""

import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WEB = REPO / "web"
BOX_DIR = REPO / "gridfinity" / "rugged-box"
SCAD = "rugged-box-gridfinity.scad"
PRESETS = "rugged-box-gridfinity.json"
LIB_GRIDFINITY = REPO / "libraries" / "gridfinity-rebuilt-openscad"
LIB_RBOX = REPO / "rugged-box" / "rugged-box-library.scad"

# Files the browser generator needs, relative to the virtual FS root
SCAD_FILES = {
    SCAD: BOX_DIR / SCAD,
    PRESETS: BOX_DIR / PRESETS,
    "rugged-box-library.scad": LIB_RBOX,
}
for f in sorted(LIB_GRIDFINITY.glob("*.scad")):
    SCAD_FILES[f"gridfinity-rebuilt-openscad/{f.name}"] = f


TMP_DIR = None


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# 3MF writer
# --------------------------------------------------------------------------


def read_stl(path):
    """Return (vertices, triangles) from a binary or ASCII STL."""
    data = Path(path).read_bytes()
    verts, index, tris = [], {}, []

    def vid(v):
        i = index.get(v)
        if i is None:
            i = index[v] = len(verts)
            verts.append(v)
        return i

    is_ascii = data[:5] == b"solid" and b"facet" in data[:1024]
    if not is_ascii and len(data) >= 84:
        n = struct.unpack_from("<I", data, 80)[0]
        if 84 + n * 50 != len(data):
            is_ascii = True
    if is_ascii:
        cur = []
        for line in data.decode(errors="replace").splitlines():
            p = line.split()
            if p and p[0] == "vertex":
                cur.append(vid(tuple(float(x) for x in p[1:4])))
                if len(cur) == 3:
                    tris.append(tuple(cur))
                    cur = []
    else:
        n = struct.unpack_from("<I", data, 80)[0]
        off = 84
        for _ in range(n):
            c = struct.unpack_from("<12f", data, off)
            off += 50
            t = (vid(c[3:6]), vid(c[6:9]), vid(c[9:12]))
            if len(set(t)) == 3:
                tris.append(t)
    return verts, tris


def bbox(verts):
    xs, ys, zs = zip(*verts)
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def write_3mf(path, parts, gap=10.0):
    """
    parts: list of (name, verts, tris). Objects are laid out in a row along X,
    each resting on Z=0, so slicers can open the kit and arrange plates.
    """
    objs, items = [], []
    x = 0.0
    for oid, (name, verts, tris) in enumerate(parts, start=1):
        (x0, y0, z0), (x1, y1, _) = bbox(verts)
        tx, ty, tz = x - x0, -(y0 + y1) / 2, -z0
        x += (x1 - x0) + gap
        vs = "".join(
            f'<vertex x="{a:.5f}" y="{b:.5f}" z="{c:.5f}"/>' for a, b, c in verts
        )
        ts = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in tris)
        objs.append(
            f'<object id="{oid}" name="{name}" type="model"><mesh>'
            f"<vertices>{vs}</vertices><triangles>{ts}</triangles></mesh></object>"
        )
        items.append(
            f'<item objectid="{oid}" transform="1 0 0 0 1 0 0 0 1 '
            f'{tx:.5f} {ty:.5f} {tz:.5f}"/>'
        )
    model = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<model unit="millimeter" xml:lang="en-US" '
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
        '<metadata name="Application">gcormier rugged box generator</metadata>'
        f"<resources>{''.join(objs)}</resources><build>{''.join(items)}</build>"
        "</model>"
    )
    ctypes = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" '
        'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="model" '
        'ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
        'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
        "</Relationships>"
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("[Content_Types].xml", ctypes)
        z.writestr("_rels/.rels", rels)
        z.writestr("3D/3dmodel.model", model)


def mesh_volume(verts, tris):
    v = 0.0
    for a, b, c in tris:
        (ax, ay, az), (bx, by, bz), (cx, cy, cz) = verts[a], verts[b], verts[c]
        v += (
            ax * (by * cz - bz * cy)
            - ay * (bx * cz - bz * cx)
            + az * (bx * cy - by * cx)
        ) / 6.0
    return abs(v)


# --------------------------------------------------------------------------
# Catalog rendering
# --------------------------------------------------------------------------


def render_part(openscad, preset, size, part, out_stl, extra=()):
    w, l, bh, th = size
    cmd = [
        *openscad,
        str(BOX_DIR / SCAD),
        "-p", str(BOX_DIR / PRESETS),
        "-P", preset,
        "-D", f'Part="{part}"',
        "-D", f"Width={w}",
        "-D", f"Length={l}",
        "-D", f"Bottom_Height={bh}",
        "-D", f"Top_Height={th}",
        *[x for d in extra for x in ("-D", d)],
        "--backend=Manifold",
        "--export-format=binstl",
        "-o", str(out_stl),
    ]
    t = time.time()
    r = subprocess.run(cmd, capture_output=True, text=True)
    ok = r.returncode == 0 and out_stl.exists() and out_stl.stat().st_size > 84
    if not ok:
        tail = ((r.stderr or "") + (r.stdout or "")).strip().splitlines()[-3:]
        log(f"  [{part} {w}x{l}x{bh}/{th}] no output ({' | '.join(tail)})")
    return ok, time.time() - t


def kit_name(size):
    w, l, bh, th = size
    return f"rugged-box-greg-{w}x{l}-b{bh}-t{th}.3mf"


def build_kit(openscad, preset, size, parts, models_dir, cache_dir):
    name = kit_name(size)
    out = models_dir / name
    meta_path = (cache_dir / (name + ".json")) if cache_dir else None
    if cache_dir and (cache_dir / name).exists() and meta_path.exists():
        shutil.copy2(cache_dir / name, out)
        return json.loads(meta_path.read_text())
    w = size[0]
    with tempfile.TemporaryDirectory(dir=TMP_DIR) as td:
        meshes, info = [], {}
        for part in parts:
            stl = Path(td) / f"{part}.stl"
            ok, secs = render_part(openscad, preset, size, part, stl)
            if not ok:
                continue
            verts, tris = read_stl(stl)
            if not tris:
                continue
            copies = (1 if w <= 2 else 2) if part == "latch" else 1
            for i in range(copies):
                label = part if copies == 1 else f"{part} {i + 1}"
                meshes.append((label, verts, tris))
            info[part] = {
                "copies": copies,
                "volume_cm3": round(mesh_volume(verts, tris) / 1000, 1),
                "render_s": round(secs, 1),
            }
        if not meshes:
            raise RuntimeError(f"No parts rendered for {name}")
        write_3mf(out, meshes)
    meta = {
        "file": f"models/{name}",
        "width": size[0],
        "length": size[1],
        "bottom_height": size[2],
        "top_height": size[3],
        "bytes": out.stat().st_size,
        "parts": info,
    }
    if cache_dir:
        shutil.copy2(out, cache_dir / name)
        meta_path.write_text(json.dumps(meta))
    log(f"  built {name} ({', '.join(info)})")
    return meta


def build_latches(openscad, preset, site, cache):
    """
    Prebuild the latch for each latch type. The latch does not depend on the
    box size, and its minkowski() edge chamfer is too slow for the in-browser
    WebAssembly build, so the generator uses these when the latch settings
    match the preset.
    """
    out = {}
    (site / "latches").mkdir(parents=True, exist_ok=True)
    for latch_type in ("draw", "clip"):
        name = f"latch-{latch_type}.stl"
        dst = site / "latches" / name
        if cache and (cache / name).exists():
            shutil.copy2(cache / name, dst)
        else:
            with tempfile.TemporaryDirectory(dir=TMP_DIR) as td:
                stl = Path(td) / name
                ok, _ = render_part(openscad, preset, (3, 3, 6, 1), "latch",
                                    stl, [f'Latch_Type="{latch_type}"'])
                if not ok:
                    continue
                shutil.copy2(stl, dst)
            if cache:
                shutil.copy2(dst, cache / name)
        out[latch_type] = f"latches/{name}"
    log(f"  latches: {', '.join(out)}")
    return out


def source_hash(preset):
    h = hashlib.sha256()
    for k, p in sorted(SCAD_FILES.items()):
        h.update(k.encode())
        h.update(p.read_bytes())
    h.update(preset.encode())
    h.update(Path(__file__).read_bytes())
    return h.hexdigest()[:16]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="_site")
    ap.add_argument("--openscad", default="openscad",
                    help="OpenSCAD command (may contain spaces for wrappers)")
    ap.add_argument("--wasm-dir", help="Directory with openscad.js/openscad.wasm")
    ap.add_argument("--models-cache", help="Persistent cache dir for rendered kits")
    ap.add_argument("--skip-catalog", action="store_true")
    ap.add_argument("--only", help="Comma list of WxLxBxT sizes to render")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 2)
    ap.add_argument("--tmp-dir", help="Scratch dir for intermediate STLs")
    args = ap.parse_args()
    global TMP_DIR
    TMP_DIR = args.tmp_dir

    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    site = out / "rugged-box"
    shutil.copytree(WEB / "rugged-box", site)
    shutil.copy2(WEB / "index.html", out / "index.html")
    (out / ".nojekyll").write_text("")

    # Sources for the in-browser generator
    scad_out = site / "scad"
    for rel, src in SCAD_FILES.items():
        dst = scad_out / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src.resolve(), dst)
    for lic in ("LICENSE", "LICENSE.gridfinity"):
        if (BOX_DIR / lic).exists():
            shutil.copy2(BOX_DIR / lic, scad_out / lic)

    if args.wasm_dir:
        for f in ("openscad.js", "openscad.wasm"):
            shutil.copy2(Path(args.wasm_dir) / f, site / f)

    catalog = json.loads((WEB / "catalog.json").read_text())
    preset = catalog["preset"]
    presets = json.loads((BOX_DIR / PRESETS).read_text())["parameterSets"]
    if preset not in presets:
        sys.exit(f"Preset {preset!r} not found in {PRESETS}")

    sizes = [tuple(s) for s in catalog["sizes"]]
    if args.only:
        want = {tuple(int(x) for x in s.split("x")) for s in args.only.split(",")}
        sizes = [s for s in sizes if s in want]

    manifest = {
        "preset": preset,
        "preset_values": presets[preset],
        "source_hash": source_hash(json.dumps(presets[preset], sort_keys=True)),
        "commit": os.environ.get("GITHUB_SHA", ""),
        "built": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
        "scad_files": sorted(SCAD_FILES),
        "main_file": SCAD,
        "presets_file": PRESETS,
        "kits": [],
    }

    cache = None
    if args.models_cache:
        cache = Path(args.models_cache) / manifest["source_hash"]
        cache.mkdir(parents=True, exist_ok=True)
        # Drop parts rendered from older sources
        for old in Path(args.models_cache).iterdir():
            if old.is_dir() and old != cache:
                shutil.rmtree(old)
    openscad = args.openscad.split()
    manifest["latches"] = build_latches(openscad, preset, site, cache)

    if not args.skip_catalog and sizes:
        models = site / "models"
        models.mkdir(parents=True, exist_ok=True)
        log(f"Rendering {len(sizes)} kits with {args.jobs} jobs ...")
        with cf.ThreadPoolExecutor(args.jobs) as ex:
            futs = [
                ex.submit(build_kit, openscad, preset, s, catalog["parts"],
                          models, cache)
                for s in sizes
            ]
            for f in futs:
                manifest["kits"].append(f.result())

    (site / "manifest.json").write_text(json.dumps(manifest, indent=1))
    log(f"Site written to {out}")


if __name__ == "__main__":
    main()
