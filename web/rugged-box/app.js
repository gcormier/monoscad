import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
import { parseBinarySTL, build3MF } from "./threemf.js";

const $ = (s, el = document) => el.querySelector(s);
const L_GRID = 42;
const H_UNIT = 7;
// Size fields live in the main form, so they are not shown in the preset editor
const SIZE_KEYS = ["Width", "Length", "Bottom_Height", "Top_Height"];
// Customizer metadata for nicer preset fields
const CHOICES = {
  Latch_Type: ["draw", "clip"],
  Lip_Seal_Type: ["none", "wedge", "square", "filament-1.75mm"],
  Gridfinity_Base_Style: ["minimal", "thick", "enabled", "enabled_full"],
};

let manifest = null;

// ---------------------------------------------------------------- helpers

function fmtBytes(n) {
  return n > 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.round(n / 1e3) + " kB";
}
function latchCount(w) {
  return w <= 2 ? 1 : 2;
}
function absUrl(rel) {
  return new URL(rel, location.href).href;
}
function bambuUrl(rel) {
  return "bambustudioopen://" + encodeURIComponent(absUrl(rel));
}
function saveBlob(data, name, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}
function isBool(v) {
  return v === "true" || v === "false";
}
function isNum(v) {
  return v !== "" && !isNaN(Number(v));
}

// ---------------------------------------------------------------- viewer

const viewer = (() => {
  const host = $("#viewer");
  const msg = $("#viewer-msg");
  let renderer, scene, camera, controls, group;
  function init() {
    if (renderer) return;
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.prepend(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(35, 4 / 3, 1, 5000);
    camera.up.set(0, 0, 1);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const d = new THREE.DirectionalLight(0xffffff, 1.6);
    d.position.set(1, -1.5, 2);
    scene.add(d);
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    group = new THREE.Group();
    scene.add(group);
    new ResizeObserver(resize).observe(host);
    resize();
    (function loop() {
      requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    })();
  }
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  function frame() {
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.9;
    camera.position.copy(c).add(new THREE.Vector3(0.55, -1, 0.75).normalize().multiplyScalar(dist));
    camera.near = dist / 100;
    camera.far = dist * 10;
    camera.updateProjectionMatrix();
    controls.target.copy(c);
  }
  const colors = [0x4682b4, 0xb0c4de, 0xe0a040, 0x7fb069, 0xc07090];
  return {
    message(t) {
      msg.textContent = t || "";
    },
    clear() {
      init();
      while (group.children.length) group.remove(group.children[0]);
    },
    // Lay parts out in a row like the 3MF kit
    addSTL(buffer, i) {
      init();
      const geo = new STLLoader().parse(buffer);
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const prev = new THREE.Box3().setFromObject(group);
      const x0 = prev.isEmpty() ? 0 : prev.max.x + 10;
      geo.translate(x0 - bb.min.x, -(bb.min.y + bb.max.y) / 2, -bb.min.z);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: colors[i % colors.length], roughness: 0.7, metalness: 0.05 }));
      group.add(mesh);
      frame();
    },
    async show3MF(url) {
      init();
      this.clear();
      this.message("Loading preview…");
      const obj = await new ThreeMFLoader().loadAsync(url);
      obj.traverse((o) => {
        if (o.isMesh) o.material = new THREE.MeshStandardMaterial({ color: 0x4682b4, roughness: 0.7 });
      });
      group.add(obj);
      frame();
      this.message("");
    },
  };
})();

// ---------------------------------------------------------------- catalog

function renderCatalog() {
  const tbody = $("#catalog tbody");
  const kits = manifest.kits || [];
  $("#catalog-empty").classList.toggle("hidden", kits.length > 0);
  $("#catalog").classList.toggle("hidden", kits.length === 0);
  if (manifest.built) {
    $("#build-meta").textContent = `Built ${manifest.built}` + (manifest.commit ? ` · ${manifest.commit.slice(0, 7)}` : "");
  }
  const fw = $("#f-width"), fl = $("#f-length");
  if (fw.options.length === 1) {
    for (const v of [...new Set(kits.map((k) => k.width))].sort((a, b) => a - b)) fw.append(el("option", { value: v }, String(v)));
    for (const v of [...new Set(kits.map((k) => k.length))].sort((a, b) => a - b)) fl.append(el("option", { value: v }, String(v)));
    fw.onchange = fl.onchange = renderCatalog;
  }
  tbody.replaceChildren();
  for (const k of kits) {
    if (fw.value && k.width != fw.value) continue;
    if (fl.value && k.length != fl.value) continue;
    const parts = Object.entries(k.parts || {}).map(([p, i]) => (i.copies > 1 ? `${p} ×${i.copies}` : p)).join(", ");
    const tr = el(
      "tr",
      { "data-key": `${k.width}x${k.length}x${k.bottom_height}x${k.top_height}` },
      el("td", {}, el("b", {}, `${k.width} × ${k.length}`)),
      el("td", {}, `${k.bottom_height}U`),
      el("td", {}, `${k.top_height}U`),
      el("td", {}, `${k.width * L_GRID} × ${k.length * L_GRID} × ${(k.bottom_height + k.top_height) * H_UNIT}`),
      el("td", { title: parts }, fmtBytes(k.bytes)),
      el(
        "td",
        { class: "btns" },
        el("button", { class: "ghost small", type: "button", onclick: () => previewKit(k) }, "Preview"),
        el("a", { class: "btn ghost small", href: k.file, download: "" }, "3MF"),
        el("a", { class: "btn small", href: bambuUrl(k.file) }, "Open in Bambu Studio")
      )
    );
    tbody.append(tr);
  }
  updatePrebuiltHint();
}

async function previewKit(k) {
  $("#out").classList.remove("hidden");
  $("#progress").replaceChildren(el("li", {}, `Prebuilt kit ${k.width}×${k.length}, ${k.bottom_height}U + ${k.top_height}U`));
  $("#downloads").replaceChildren(
    el("div", { class: "row" },
      el("a", { class: "btn small", href: bambuUrl(k.file) }, "Open in Bambu Studio"),
      el("a", { class: "btn ghost small", href: k.file, download: "" }, "Download 3MF"))
  );
  $("#out").scrollIntoView({ behavior: "smooth", block: "nearest" });
  try {
    await viewer.show3MF(k.file);
  } catch (e) {
    viewer.message("Preview failed: " + e.message);
  }
}

// ---------------------------------------------------------------- generator form

const form = $("#gen");
const adv = $("#adv");

function buildAdvanced() {
  const p = manifest.preset_values;
  adv.replaceChildren();
  for (const [k, v] of Object.entries(p)) {
    if (SIZE_KEYS.includes(k)) continue;
    const name = k.replace(/_/g, " ");
    let field;
    if (isBool(v)) {
      const cb = el("input", { type: "checkbox", "data-key": k });
      cb.checked = v === "true";
      field = el("label", { class: "bool" }, cb, name);
    } else if (CHOICES[k]) {
      const sel = el("select", { "data-key": k }, ...CHOICES[k].map((c) => el("option", { value: c }, c)));
      sel.value = v;
      field = el("label", {}, name, sel);
    } else if (isNum(v)) {
      field = el("label", {}, name, el("input", { type: "number", step: "any", value: v, "data-key": k }));
    } else {
      field = el("label", {}, name, el("input", { type: "text", value: v, "data-key": k }));
    }
    adv.append(field);
  }
}

function advValues() {
  const out = {};
  for (const inp of adv.querySelectorAll("[data-key]")) {
    const k = inp.dataset.key;
    out[k] = inp.type === "checkbox" ? String(inp.checked) : String(inp.value);
  }
  return out;
}

function changedAdv() {
  const p = manifest.preset_values;
  const cur = advValues();
  const diff = {};
  for (const [k, v] of Object.entries(cur)) {
    const base = p[k];
    const same = isNum(v) && isNum(base) ? Number(v) === Number(base) : v === base;
    if (!same) diff[k] = v;
  }
  return diff;
}

function markChanged() {
  const diff = changedAdv();
  for (const inp of adv.querySelectorAll("[data-key]")) {
    const lab = inp.closest("label");
    lab.classList.toggle("changed", inp.dataset.key in diff);
  }
  const n = Object.keys(diff).length;
  $("#adv-count").textContent = n ? `(${n} changed)` : "(unchanged)";
  updatePrebuiltHint();
}

function sizeValues() {
  const fd = new FormData(form);
  return Object.fromEntries(SIZE_KEYS.map((k) => [k, parseInt(fd.get(k), 10)]));
}

function updateDims() {
  const s = sizeValues();
  if (SIZE_KEYS.some((k) => !Number.isFinite(s[k]))) return;
  $("#dims").textContent =
    `Interior ${s.Width * L_GRID} × ${s.Length * L_GRID} mm, ` +
    `${s.Bottom_Height * H_UNIT} mm deep + ${s.Top_Height * H_UNIT} mm in the lid`;
  $("#latch-count").textContent = `(×${latchCount(s.Width)})`;
  updatePrebuiltHint();
}

function findPrebuilt() {
  if (!manifest) return null;
  const s = sizeValues();
  if (Object.keys(changedAdv()).length) return null;
  return (manifest.kits || []).find(
    (k) => k.width === s.Width && k.length === s.Length && k.bottom_height === s.Bottom_Height && k.top_height === s.Top_Height
  );
}

function updatePrebuiltHint() {
  const hint = $("#prebuilt-hint");
  const k = findPrebuilt();
  document.querySelectorAll("#catalog tr.match").forEach((r) => r.classList.remove("match"));
  hint.replaceChildren();
  if (k) {
    const key = `${k.width}x${k.length}x${k.bottom_height}x${k.top_height}`;
    document.querySelector(`#catalog tr[data-key="${key}"]`)?.classList.add("match");
    hint.append("This size is prebuilt: ", el("a", { href: bambuUrl(k.file) }, "Open in Bambu Studio"), " · ", el("a", { href: k.file, download: "" }, "Download 3MF"));
  }
}

// URL hash <-> form, e.g. #w=4&l=3&b=6&t=2&Latch_Type=clip
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const map = { w: "Width", l: "Length", b: "Bottom_Height", t: "Top_Height" };
  for (const [short, k] of Object.entries(map)) if (h.has(short)) form.elements[k].value = h.get(short);
  for (const inp of adv.querySelectorAll("[data-key]")) {
    const k = inp.dataset.key;
    if (!h.has(k)) continue;
    if (inp.type === "checkbox") inp.checked = h.get(k) === "true";
    else inp.value = h.get(k);
  }
  if ([...h.keys()].some((k) => !(k in map))) $("#advanced").open = true;
}
function writeHash() {
  const s = sizeValues();
  const h = new URLSearchParams({ w: s.Width, l: s.Length, b: s.Bottom_Height, t: s.Top_Height });
  for (const [k, v] of Object.entries(changedAdv())) h.set(k, v);
  history.replaceState(null, "", "#" + h.toString());
  return location.href;
}

// ---------------------------------------------------------------- rendering

let worker = null;
let seq = 0;
function renderPart(part, defines) {
  if (!worker) worker = new Worker("worker.js", { type: "module" });
  const id = ++seq;
  return new Promise((resolve) => {
    const onMsg = (ev) => {
      if (ev.data.id !== id) return;
      worker.removeEventListener("message", onMsg);
      resolve(ev.data);
    };
    worker.addEventListener("message", onMsg);
    worker.postMessage({ id, manifest, req: { part, defines, preset: manifest.preset } });
  });
}

// The latch is the same for every box size, and its minkowski() chamfer is
// too slow for the WebAssembly build, so use the CI-prebuilt one when the
// only changed preset value is the latch type.
function prebuiltLatchUrl() {
  const diff = changedAdv();
  const other = Object.keys(diff).filter((k) => k !== "Latch_Type");
  if (other.length) return null;
  const type = diff.Latch_Type || manifest.preset_values.Latch_Type || "draw";
  return (manifest.latches || {})[type] || null;
}

async function renderOrFetch(part, defines) {
  const url = part === "latch" ? prebuiltLatchUrl() : null;
  if (url) {
    const t0 = performance.now();
    try {
      const r = await fetch(url);
      if (r.ok) {
        const stl = await r.arrayBuffer();
        return { ok: true, stl, secs: (performance.now() - t0) / 1000, log: [`Using prebuilt ${url}`], prebuilt: true };
      }
    } catch (_) { /* fall back to rendering */ }
  }
  return renderPart(part, defines);
}

let busy = false;
async function onRender(ev) {
  ev.preventDefault();
  if (busy) return;
  const s = sizeValues();
  const parts = [...form.querySelectorAll("input[name=part]:checked")].map((i) => i.value);
  if (!parts.length) return;
  busy = true;
  writeHash();
  const btn = $("#render-btn");
  btn.disabled = true;
  btn.textContent = "Rendering…";
  $("#out").classList.remove("hidden");
  const progress = $("#progress");
  const downloads = $("#downloads");
  const logEl = $("#log");
  progress.replaceChildren();
  downloads.replaceChildren();
  logEl.textContent = "";
  viewer.clear();
  viewer.message("Loading OpenSCAD…");

  const defines = { ...s, ...changedAdv() };
  const items = Object.fromEntries(parts.map((p) => [p, el("li", {}, p)]));
  progress.append(...Object.values(items));
  const done = [];
  const tag = `${s.Width}x${s.Length}-b${s.Bottom_Height}-t${s.Top_Height}`;
  for (const [i, part] of parts.entries()) {
    const li = items[part];
    li.className = "run";
    viewer.message(done.length ? "" : `Rendering ${part}…`);
    const t0 = performance.now();
    const tick = setInterval(() => (li.textContent = `${part}: ${Math.round((performance.now() - t0) / 1000)} s`), 1000);
    const res = await renderOrFetch(part, defines);
    if (!res.ok && res.log.some((l) => /top level object is empty/i.test(l))) res.empty = true;
    clearInterval(tick);
    logEl.textContent += `--- ${part} ---\n${res.log.join("\n")}\n`;
    if (res.ok) {
      li.className = "ok";
      li.textContent = res.prebuilt ? `${part}: prebuilt` : `${part}: done in ${Math.round(res.secs)} s`;
      done.push({ part, stl: res.stl });
      viewer.addSTL(res.stl, i);
      viewer.message("");
    } else {
      li.className = "err";
      li.textContent = res.empty
        ? `${part}: not used for this size`
        : part === "latch"
          ? `${part}: failed. Changed latch settings must render in the browser, which is very slow; use the Greg latch settings or render the latch locally.`
          : `${part}: failed (see log)`;
    }
  }

  if (done.length) {
    const kitParts = [];
    for (const d of done) {
      const mesh = parseBinarySTL(d.stl);
      const copies = d.part === "latch" ? latchCount(s.Width) : 1;
      for (let c = 0; c < copies; c++) kitParts.push({ name: copies > 1 ? `${d.part} ${c + 1}` : d.part, mesh });
    }
    const kit = build3MF(kitParts);
    downloads.append(
      el("div", { class: "row" },
        el("button", { type: "button", onclick: () => saveBlob(kit, `rugged-box-greg-${tag}.3mf`, "model/3mf") }, "Download kit 3MF")),
      el("div", { class: "row" },
        ...done.map((d) => el("button", { type: "button", class: "ghost small", onclick: () => saveBlob(d.stl, `rugged-box-greg-${tag}-${d.part}.stl`, "model/stl") }, `${d.part}.stl`))),
      el("p", { class: "hint" }, "Double-click the downloaded 3MF to open it in Bambu Studio.")
    );
  } else {
    viewer.message("Nothing rendered. Check the log.");
  }
  btn.disabled = false;
  btn.textContent = "Render";
  busy = false;
}

// ---------------------------------------------------------------- init

async function init() {
  try {
    manifest = await (await fetch("manifest.json", { cache: "no-cache" })).json();
  } catch (e) {
    document.querySelector("main").prepend(el("p", { class: "card" }, "Could not load manifest.json: " + e.message));
    return;
  }
  buildAdvanced();
  adv.addEventListener("input", markChanged);
  adv.addEventListener("change", markChanged);
  readHash();
  markChanged();
  renderCatalog();
  updateDims();
  form.addEventListener("input", updateDims);
  form.addEventListener("submit", onRender);
  $("#adv-reset").onclick = () => { buildAdvanced(); markChanged(); };
  $("#share-btn").onclick = async () => {
    const url = writeHash();
    try {
      await navigator.clipboard.writeText(url);
      $("#share-btn").textContent = "Link copied";
    } catch (_) {
      $("#share-btn").textContent = "Copy the address bar";
    }
    setTimeout(() => ($("#share-btn").textContent = "Copy link to this size"), 2000);
  };
}
init();
