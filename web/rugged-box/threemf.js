// Minimal STL parsing and multi-object 3MF writing (no dependencies besides fflate).
import { zipSync, strToU8 } from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";

export function parseBinarySTL(buffer) {
  const dv = new DataView(buffer);
  const n = dv.getUint32(80, true);
  const verts = [];
  const index = new Map();
  const tris = [];
  let off = 84;
  const vid = (x, y, z) => {
    const key = x + "," + y + "," + z;
    let i = index.get(key);
    if (i === undefined) {
      i = verts.length;
      index.set(key, i);
      verts.push([x, y, z]);
    }
    return i;
  };
  for (let t = 0; t < n; t++) {
    const p = off + 12;
    const a = vid(dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true));
    const b = vid(dv.getFloat32(p + 12, true), dv.getFloat32(p + 16, true), dv.getFloat32(p + 20, true));
    const c = vid(dv.getFloat32(p + 24, true), dv.getFloat32(p + 28, true), dv.getFloat32(p + 32, true));
    if (a !== b && b !== c && a !== c) tris.push([a, b, c]);
    off += 50;
  }
  return { verts, tris };
}

function bbox(verts) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of verts) {
    for (let i = 0; i < 3; i++) {
      if (v[i] < min[i]) min[i] = v[i];
      if (v[i] > max[i]) max[i] = v[i];
    }
  }
  return { min, max };
}

const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

// parts: [{ name, mesh: {verts, tris} }]; laid out in a row along X, resting on Z=0.
export function build3MF(parts, gap = 10) {
  const objs = [];
  const items = [];
  let x = 0;
  parts.forEach((part, i) => {
    const id = i + 1;
    const { verts, tris } = part.mesh;
    const { min, max } = bbox(verts);
    const tx = x - min[0], ty = -(min[1] + max[1]) / 2, tz = -min[2];
    x += max[0] - min[0] + gap;
    const vs = verts.map((v) => `<vertex x="${v[0].toFixed(5)}" y="${v[1].toFixed(5)}" z="${v[2].toFixed(5)}"/>`).join("");
    const ts = tris.map((t) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join("");
    objs.push(`<object id="${id}" name="${esc(part.name)}" type="model"><mesh><vertices>${vs}</vertices><triangles>${ts}</triangles></mesh></object>`);
    items.push(`<item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${tx.toFixed(5)} ${ty.toFixed(5)} ${tz.toFixed(5)}"/>`);
  });
  const model =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
    '<metadata name="Application">gcormier rugged box generator</metadata>' +
    `<resources>${objs.join("")}</resources><build>${items.join("")}</build></model>`;
  const ctypes =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>';
  return zipSync(
    {
      "[Content_Types].xml": strToU8(ctypes),
      "_rels/.rels": strToU8(rels),
      "3D/3dmodel.model": strToU8(model),
    },
    { level: 6 }
  );
}
