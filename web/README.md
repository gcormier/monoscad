# Rugged box web generator

Static site for the Gridfinity rugged box with the pinned **Greg** preset
(`gridfinity/rugged-box/rugged-box-gridfinity.json`). It is deployed to GitHub
Pages by `.github/workflows/pages.yml` on pushes to the `greg` branch.

* `rugged-box/`: UI (plain ES modules, with three.js and fflate from jsDelivr)
  * `worker.js`: runs the OpenSCAD WebAssembly build in a web worker, one part per run
  * `threemf.js`: packs the rendered STLs into one multi-object 3MF
* `catalog.json`: sizes `[Width, Length, Bottom_Height, Top_Height]` to prebuild, and the preset name
* `build_site.py`: assembles `_site/`. It copies the UI, the OpenSCAD sources and the WASM build, renders the catalog with native OpenSCAD, and writes `manifest.json`.

Build locally (needs OpenSCAD nightly with Manifold and the WASM build from
https://files.openscad.org/playground/):

```bash
python3 web/build_site.py --out _site --openscad openscad --wasm-dir path/to/openscad-wasm
python3 -m http.server -d _site 8000   # then open http://localhost:8000/rugged-box/
```

Use `--only 3x3x6x2,4x3x6x2` to render a subset of the catalog, or
`--skip-catalog` to build only the generator.

"Open in Bambu Studio" uses Bambu Studio's `bambustudioopen://<url-encoded 3MF URL>`
link handler. It only works for files served from a public URL, which means the
prebuilt kits. For a custom render, download the 3MF.
