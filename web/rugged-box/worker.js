// Renders one part per request with the OpenSCAD WebAssembly build.
// A fresh OpenSCAD instance is created for every render (main() can only run
// once per instance); the compiled wasm module is cached by the browser.
import OpenSCAD from "./openscad.js";

let sources = null;

async function loadSources(manifest) {
  if (sources) return sources;
  const entries = await Promise.all(
    manifest.scad_files.map(async (rel) => {
      const r = await fetch(`scad/${rel}`);
      if (!r.ok) throw new Error(`Failed to fetch scad/${rel}: ${r.status}`);
      return [rel, await r.text()];
    })
  );
  sources = entries;
  return sources;
}

function mkdirp(FS, path) {
  let cur = "";
  for (const seg of path.split("/").filter(Boolean)) {
    cur += "/" + seg;
    try { FS.mkdir(cur); } catch (_) { /* exists */ }
  }
}

function scadValue(v) {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return JSON.stringify(String(v)); // quoted, escaped string
}

async function renderOnce(manifest, req, backendArg) {
  const log = [];
  const inst = await OpenSCAD({
    noInitialRun: true,
    print: (t) => log.push(t),
    printErr: (t) => log.push(t),
  });
  const FS = inst.FS;
  for (const [rel, text] of await loadSources(manifest)) {
    const full = "/src/" + rel;
    mkdirp(FS, full.substring(0, full.lastIndexOf("/")));
    FS.writeFile(full, text);
  }
  const args = [
    "/src/" + manifest.main_file,
    "-p", "/src/" + manifest.presets_file,
    "-P", req.preset,
    "-D", `Part=${scadValue(req.part)}`,
  ];
  for (const [k, v] of Object.entries(req.defines)) {
    args.push("-D", `${k}=${scadValue(v)}`);
  }
  if (backendArg) args.push(backendArg);
  args.push("--export-format=binstl", "-o", "/out.stl");
  let code;
  try {
    code = inst.callMain(args);
  } catch (e) {
    log.push(String(e && e.message ? e.message : e));
    code = -1;
  }
  let stl = null;
  try { stl = FS.readFile("/out.stl"); } catch (_) { /* no output */ }
  return { code, stl, log };
}

self.onmessage = async (ev) => {
  const { id, manifest, req } = ev.data;
  const t0 = performance.now();
  try {
    let res = await renderOnce(manifest, req, "--backend=manifold");
    if (!res.stl && res.log.some((l) => /backend/i.test(l) && /unknown|invalid|unrecognised|unrecognized/i.test(l))) {
      res = await renderOnce(manifest, req, "--enable=manifold");
    }
    const secs = (performance.now() - t0) / 1000;
    if (res.stl && res.stl.length > 84) {
      const buf = res.stl.buffer.slice(res.stl.byteOffset, res.stl.byteOffset + res.stl.byteLength);
      self.postMessage({ id, ok: true, stl: buf, log: res.log, secs }, [buf]);
    } else {
      self.postMessage({ id, ok: false, log: res.log, secs, empty: res.code === 0 });
    }
  } catch (e) {
    self.postMessage({ id, ok: false, log: [String(e && e.stack ? e.stack : e)], secs: 0 });
  }
};
