/* Field or area analysis. You draw a boundary on the map or upload one (.zip shapefile, .shp + .dbf + .prj, .kml, .kmz,
   .geojson). Soil Data Access clips the SSURGO soil polygons to it, and stratified random sample points estimate the
   share of the area in each Wind Erodibility Group and bare-soil risk class (E = I × C / 100; each map unit split by
   its component percentages). Buildings (FEMA/ORNL USA Structures), roads (Census TIGER, widened by road class) and
   water (USGS NHD water bodies, else Esri's NHD copy, plus SSURGO "Water" map units) are left out of the shares, and
   map clicks on them are refused through excludedAt(). */
WG.area = (function () {
  const { $, esc, fmt, fetchJSON, toast, download } = WG.util;
  const map = WG.map, LAYERS = window.WE_LAYERS;
  const SDA = "https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest";
  const STRUCT = "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0/query";
  const TIGER = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/";
  const TIGER_LAYERS = [2, 6, 8]; // primary, secondary (most detailed), local roads
  const NHD = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/12/query";
  const NHD_COPY = "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Detailed_Water_Bodies/FeatureServer/0/query";
  const LIBS = {
    shp: "https://cdnjs.cloudflare.com/ajax/libs/shpjs/4.0.4/shp.min.js",
    kml: "https://cdn.jsdelivr.net/npm/@tmcw/togeojson@5.8.1/dist/togeojson.umd.js",
    zip: "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
  };
  const MAX_KM2 = 500, SAMPLES = 20000, MAX_VERTS = 600;
  // half-widths in metres by TIGER road class (MTFCC): pavement plus shoulders
  const ROAD_HALF = { S1100: 15, S1200: 9, S1400: 5, S1500: 2, S1630: 6, S1640: 4, S1730: 3, S1740: 3, S1750: 3, S1780: 4,
    S1710: 1.5, S1720: 1.5, S1820: 1.5, S1830: 1.5 };
  // NHD water-body types left out: lake/pond, reservoir, swamp/marsh, estuary (playas, 361, stay in: most are farmed)
  const WATER_FTYPE = new Set([390, 436, 466, 493, "Lake/Pond", "Reservoir", "Swamp/Marsh", "Estuary"]);
  const WEG_ORDER = ["1", "2", "3", "4", "4L", "5", "6", "7", "8"];
  const WEG_COLOR = Object.fromEntries(WEG_ORDER.map((k, i) => [k, LAYERS.layers.weg.legend[i].color]));
  const RISK = [["Low", "< 10"], ["Moderate", "10–40"], ["High", "40–80"], ["Very high", "80–150"], ["Extreme", "≥ 150"]]
    .map(([name, range], i) => ({ name, range, color: LAYERS.layers.susceptibility.legend[i].color }));
  const riskClass = E => (E < 10 ? 0 : E < 40 ? 1 : E < 80 ? 2 : E < 150 ? 3 : 4);

  /* ---------------- geometry ---------------- */
  const R = 6378137, rad = Math.PI / 180;
  function ringArea(r) { // m², spherical excess (as geojson-area); sign follows orientation
    let a = 0;
    for (let i = 0; i < r.length - 1; i++) a += (r[i + 1][0] - r[i][0]) * rad * (2 + Math.sin(r[i][1] * rad) + Math.sin(r[i + 1][1] * rad));
    return (a * R * R) / 2;
  }
  const polysArea = polys => polys.reduce((s, p) => s + Math.abs(ringArea(p[0])) - p.slice(1).reduce((h, r) => h + Math.abs(ringArea(r)), 0), 0);
  const bboxOf = rings => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    rings.forEach(r => r.forEach(([x, y]) => { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }));
    return [w, s, e, n];
  };
  function inRings(x, y, rings) { // even-odd over every ring: works for holes and multipolygons
    let inside = false;
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [xi, yi] = r[i], [xj, yj] = r[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }
  function segDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    const qx = ax + t * dx - px, qy = ay + t * dy - py;
    return qx * qx + qy * qy;
  }
  function simplify(ring, tol) { // Douglas–Peucker, degrees
    if (ring.length < 5) return ring;
    const keep = new Uint8Array(ring.length);
    keep[0] = keep[ring.length - 1] = 1;
    const stack = [[0, ring.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let best = -1, at = -1;
      for (let i = a + 1; i < b; i++) {
        const d = segDist2(ring[i][0], ring[i][1], ring[a][0], ring[a][1], ring[b][0], ring[b][1]);
        if (d > best) { best = d; at = i; }
      }
      if (best > tol * tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
    }
    const out = ring.filter((_, i) => keep[i]);
    return out.length >= 4 ? out : ring;
  }
  function toWKT(polys) {
    let tol = 0, p = polys;
    const count = q => q.reduce((s, x) => s + x.reduce((t, r) => t + r.length, 0), 0);
    while (count(p) > MAX_VERTS && tol < 0.01) { tol = tol ? tol * 2 : 0.00002; p = polys.map(x => x.map(r => simplify(r, tol))); }
    const ring = r => `(${r.map(([x, y]) => `${x.toFixed(6)} ${y.toFixed(6)}`).join(", ")})`;
    return `MULTIPOLYGON(${p.map(x => `(${x.map(ring).join(", ")})`).join(", ")})`;
  }
  const wktRings = wkt => [...String(wkt).matchAll(/\(([^()]+)\)/g)]
    .map(m => m[1].split(",").map(s => s.trim().split(/\s+/).map(Number)))
    .filter(r => r.length >= 4 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]);

  /* Polygons from GeoJSON (Feature, FeatureCollection, geometry, or an array of collections from shpjs). */
  function geojsonPolys(g, out = []) {
    if (!g) return out;
    if (Array.isArray(g)) g.forEach(x => geojsonPolys(x, out));
    else if (g.type === "FeatureCollection") g.features.forEach(f => geojsonPolys(f, out));
    else if (g.type === "Feature") geojsonPolys(g.geometry, out);
    else if (g.type === "GeometryCollection") g.geometries.forEach(x => geojsonPolys(x, out));
    else if (g.type === "Polygon") out.push(g.coordinates.map(r => r.map(c => [c[0], c[1]])));
    else if (g.type === "MultiPolygon") g.coordinates.forEach(p => out.push(p.map(r => r.map(c => [c[0], c[1]]))));
    return out;
  }

  /* ---------------- data ---------------- */
  async function sda(query) {
    const j = await fetchJSON(SDA, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, format: "JSON+COLUMNNAME" }) }, 60000);
    const t = j.Table || [];
    return t.length ? t.slice(1).map(r => Object.fromEntries(t[0].map((c, i) => [c, r[i]]))) : [];
  }

  async function soils(polys) {
    const aoi = `geometry::STGeomFromText('${toWKT(polys)}', 4326).MakeValid()`;
    const rows = await sda(`SELECT P.mukey, P.mupolygongeo.STIntersection(${aoi}).STAsText() AS wkt
      FROM mupolygon P WHERE P.mupolygongeo.STIntersects(${aoi}) = 1`);
    const keys = [...new Set(rows.map(r => r.mukey))];
    if (!keys.length) return { parts: [], units: {} };
    const inList = keys.map(k => +k).join(",");
    const [comps, cf] = await Promise.all([
      sda(`SELECT mu.mukey, mu.musym, mu.muname, c.compname, c.comppct_r, c.weg, c.wei FROM mapunit mu
           LEFT JOIN component c ON c.mukey = mu.mukey WHERE mu.mukey IN (${inList})`),
      sda(`SELECT mo.mukey, la.areasymbol, la.areatypename FROM muaoverlap mo JOIN laoverlap la ON la.lareaovkey = mo.lareaovkey
           WHERE mo.mukey IN (${inList}) AND la.areatypename LIKE 'Climate Factor%'`),
    ]);
    const units = {};
    comps.forEach(c => {
      const u = units[c.mukey] || (units[c.mukey] = { mukey: c.mukey, musym: c.musym, muname: c.muname, comps: [], C: null });
      if (c.compname) u.comps.push({ name: c.compname, pct: +c.comppct_r || 0, weg: c.weg || null, wei: c.wei === null ? null : +c.wei });
    });
    cf.forEach(r => { if (units[r.mukey]) units[r.mukey].C = +r.areasymbol || null; });
    Object.values(units).forEach(u => {
      u.water = /^water\b/i.test(u.muname || "") || (u.comps.length && u.comps.every(c => /^water$/i.test(c.name)));
      u.comps.sort((a, b) => b.pct - a.pct);
      const top = u.comps.find(c => c.weg);
      u.weg = top ? top.weg : null;
    });
    const parts = rows.map(r => ({ mukey: r.mukey, rings: wktRings(r.wkt) })).filter(p => p.rings.length);
    return { parts, units };
  }

  /* ArcGIS feature query as GeoJSON over an envelope; headerMs: wait for the first answer. When the server caps a
     reply, later pages are asked for by offset (a server without paging just keeps the first page). */
  async function arcgis(url, env, fields, { pages = 10, headerMs = 15000 } = {}) {
    const base = { geometry: env.join(","), geometryType: "esriGeometryEnvelope", inSR: "4326",
      spatialRel: "esriSpatialRelIntersects", outFields: fields, returnGeometry: "true", outSR: "4326", f: "geojson" };
    const more = j => j.exceededTransferLimit || (j.properties && j.properties.exceededTransferLimit);
    let j = await fetchJSON(`${url}?${new URLSearchParams(base)}`, {}, 45000, headerMs);
    if (j.error) throw new Error(j.error.message || "query failed");
    const out = [...(j.features || [])];
    for (let k = 1; k < pages && more(j) && j.features && j.features.length; k++) {
      try {
        j = await fetchJSON(`${url}?${new URLSearchParams({ ...base, resultOffset: String(out.length) })}`, {}, 45000, headerMs);
      } catch (e) { break; }
      if (j.error) break;
      out.push(...(j.features || []));
    }
    return out;
  }

  async function exclusions(env, quick) {
    const opt = quick ? { pages: 1, headerMs: 3000 } : {};
    // water: USGS NHD, with Esri's NHD copy asked at the same time because NHD can take several seconds to wake up.
    // A click check takes whichever answers first; an area analysis waits up to 5 s for NHD before using the copy.
    const nhd = arcgis(NHD, env, "FTYPE,GNIS_NAME", { ...opt, headerMs: quick ? 3000 : 5000 }).then(f => ({ ok: true, f, src: "USGS NHD" }));
    const copy = arcgis(NHD_COPY, env, "FTYPE,NAME", opt).then(f => ({ ok: true, f, src: "Esri copy of NHD" }));
    nhd.catch(() => {});
    copy.catch(() => {}); // the request not used may still fail later
    const [bld, roads, water] = await Promise.all([
      arcgis(STRUCT, env, "OCC_CLS", opt).then(f => ({ ok: true, f })).catch(e => ({ ok: false, f: [], e })),
      Promise.all(TIGER_LAYERS.map(l => arcgis(TIGER + l + "/query", env, "MTFCC,NAME", opt)))
        .then(a => ({ ok: true, f: a.flat() })).catch(e => ({ ok: false, f: [], e })),
      (quick ? Promise.any([nhd, copy]) : nhd.catch(() => copy)).catch(e => ({ ok: false, f: [], e })),
    ]);
    const polyFeats = fs => fs.flatMap(f => geojsonPolys(f.geometry).map(p => ({ rings: p, props: f.properties || {} })));
    const lines = f => {
      const g = f.geometry || {};
      return g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    };
    return {
      buildings: polyFeats(bld.f), roads: roads.f.flatMap(f => lines(f).map(c => ({ line: c, props: f.properties || {} }))),
      water: polyFeats(water.f.filter(f => WATER_FTYPE.has((f.properties || {}).FTYPE ?? (f.properties || {}).ftype))),
      status: { buildings: bld.ok, roads: roads.ok, water: water.ok, waterSrc: water.src },
    };
  }

  /* Local metric frame and a uniform grid index over features. */
  function frame(bb) {
    const lat0 = (bb[1] + bb[3]) / 2, kx = Math.cos(lat0 * rad) * 111320, ky = 110540;
    return { x: lon => (lon - bb[0]) * kx, y: lat => (lat - bb[1]) * ky, W: (bb[2] - bb[0]) * kx, H: (bb[3] - bb[1]) * ky };
  }
  function grid(fr, n = 64) {
    const cells = Array.from({ length: n * n }, () => []);
    const cw = Math.max(fr.W, 1) / n, ch = Math.max(fr.H, 1) / n;
    const clampI = (v, m) => Math.max(0, Math.min(n - 1, Math.floor(v / m)));
    return {
      add(item, x0, y0, x1, y1) {
        for (let i = clampI(x0, cw); i <= clampI(x1, cw); i++) for (let j = clampI(y0, ch); j <= clampI(y1, ch); j++) cells[j * n + i].push(item);
      },
      at: (x, y) => cells[clampI(y, ch) * n + clampI(x, cw)],
    };
  }
  function indexPolys(list, fr, g, kind) {
    list.forEach(p => {
      const bb = bboxOf(p.rings);
      g.add({ kind, p }, fr.x(bb[0]), fr.y(bb[1]), fr.x(bb[2]), fr.y(bb[3]));
    });
  }
  function indexRoads(list, fr, g) {
    list.forEach(r => {
      const half = ROAD_HALF[r.props.MTFCC] || 4;
      const pts = r.line.map(([x, y]) => [fr.x(x), fr.y(y)]);
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
        g.add({ kind: "road", seg: [ax, ay, bx, by], half, props: r.props },
          Math.min(ax, bx) - half, Math.min(ay, by) - half, Math.max(ax, bx) + half, Math.max(ay, by) + half);
      }
    });
  }
  /* What, if anything, covers a point: building, road or water (first match wins). */
  function hitAt(lon, lat, fr, g) {
    const x = fr.x(lon), y = fr.y(lat);
    for (const it of g.at(x, y)) {
      if (it.kind === "road") {
        const [ax, ay, bx, by] = it.seg;
        if (segDist2(x, y, ax, ay, bx, by) <= it.half * it.half) return it;
      } else if (inRings(lon, lat, it.p.rings)) return it;
    }
    return null;
  }

  /* Point check used by app.js before a clicked point is analysed; null when clear or when the services are slow. */
  async function excludedAt(lat, lon) {
    const d = 0.0008; // ~90 m box: wide enough to catch the edges of large buildings
    const env = [lon - d, lat - d, lon + d, lat + d];
    const timer = new Promise(r => setTimeout(() => r(null), 3500));
    const check = exclusions(env, true).then(ex => {
      const fr = frame(env), g = grid(fr, 8);
      indexPolys(ex.buildings, fr, g, "building");
      indexPolys(ex.water, fr, g, "water");
      indexRoads(ex.roads, fr, g);
      const hit = hitAt(lon, lat, fr, g);
      if (!hit) return null;
      if (hit.kind === "road") {
        const nm = (hit.props.NAME || "").trim();
        return { kind: "road", label: `on a road${nm ? ` (${nm})` : ""}`, src: "Census TIGER" };
      }
      if (hit.kind === "water") {
        const nm = ((hit.p.props.GNIS_NAME || hit.p.props.NAME || "") + "").trim();
        return { kind: "water", label: `in water${nm ? ` (${nm})` : ""}`, src: ex.status.waterSrc };
      }
      return { kind: "building", label: "on a building", src: "USA Structures" };
    }).catch(() => null);
    return Promise.race([check, timer]);
  }

  /* Stratified random sample points over the bounding box, kept inside the boundary (seeded: same area, same answer). */
  function samples(bb, ringsAll, acres) {
    let s = 1234567;
    const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const fr = frame(bb), boxArea = fr.W * fr.H, aoiArea = acres * 4046.86;
    const cells = Math.min(80000, Math.max(400, Math.round(SAMPLES * boxArea / Math.max(aoiArea, 1))));
    const nx = Math.max(1, Math.round(Math.sqrt(cells * fr.W / Math.max(fr.H, 1)))), ny = Math.max(1, Math.round(cells / nx));
    const pts = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const lon = bb[0] + ((i + rnd()) / nx) * (bb[2] - bb[0]), lat = bb[1] + ((j + rnd()) / ny) * (bb[3] - bb[1]);
      if (inRings(lon, lat, ringsAll)) pts.push([lon, lat]);
    }
    return pts;
  }

  /* ---------------- analysis ---------------- */
  let current = null, seq = 0;
  const layer = L.layerGroup().addTo(map);

  async function analyse(polys, name) {
    const my = ++seq;
    const acres = polysArea(polys) / 4046.86;
    if (!(acres > 0)) return fail("The boundary has no area.");
    if (acres / 247.105 > MAX_KM2) return fail(`This area is ${fmt(acres / 247.105, 0)} km² (${fmt(acres, 0)} ac). The limit is ${MAX_KM2} km² (${fmt(MAX_KM2 * 247.105, 0)} ac); split it into smaller parts.`);
    const ringsAll = polys.flat(), bb = bboxOf(ringsAll);
    current = { polys, name, acres, bb };
    drawLayers();
    const sheet = $("#areaSheet"), phone = innerWidth < 768; // keep the area clear of the panel
    map.fitBounds([[bb[1], bb[0]], [bb[3], bb[2]]], { maxZoom: 16,
      paddingTopLeft: [phone ? 24 : (sheet.hidden ? 0 : sheet.offsetWidth) + 30, 80],
      paddingBottomRight: [24, phone && !sheet.hidden ? Math.round(innerHeight * 0.55) + 20 : 30] }); // the phone panel grows to 55 %
    const excl = $("#areaExclude").checked;
    status(`Reading the soil survey${excl ? ", building footprints, roads and water" : ""} for ${fmt(acres, 0)} ac…`);
    try {
      const pad = 0.0003, env = [bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad];
      const [soil, ex] = await Promise.all([soils(polys), excl ? exclusions(env, false) : null]);
      if (my !== seq) return;
      const pts = samples(bb, ringsAll, acres);
      const fr = frame(env), gS = grid(fr), gX = grid(fr);
      soil.parts.forEach(p => { const b = bboxOf(p.rings); gS.add(p, fr.x(b[0]), fr.y(b[1]), fr.x(b[2]), fr.y(b[3])); });
      if (ex) { indexPolys(ex.buildings, fr, gX, "building"); indexPolys(ex.water, fr, gX, "water"); indexRoads(ex.roads, fr, gX); }
      const count = { outside: 0, building: 0, road: 0, water: 0, nodata: 0, valid: 0 };
      const weg = {}, risk = [0, 0, 0, 0, 0], mu = {};
      let sumI = 0, sumE = 0, wI = 0, wE = 0, notRated = 0, noC = 0;
      const cvals = Object.values(soil.units).map(u => u.C).filter(Boolean);
      const cMean = cvals.length ? cvals.reduce((a, b) => a + b, 0) / cvals.length : null;
      for (const [lon, lat] of pts) {
        if (!WG.inTexas(lat, lon)) { count.outside++; continue; }
        const hit = ex ? hitAt(lon, lat, fr, gX) : null;
        if (hit) { count[hit.kind]++; continue; }
        const x = fr.x(lon), y = fr.y(lat);
        const part = gS.at(x, y).find(p => inRings(lon, lat, p.rings));
        const u = part && soil.units[part.mukey];
        if (!u) { count.nodata++; continue; }
        if (u.water) { count.water++; continue; }
        count.valid++;
        mu[u.mukey] = (mu[u.mukey] || 0) + 1;
        const rated = u.comps.filter(c => c.weg);
        const tot = u.comps.reduce((a, c) => a + c.pct, 0) || 1;
        notRated += 1 - rated.reduce((a, c) => a + c.pct, 0) / tot;
        const C = u.C || cMean;
        rated.forEach(c => {
          const w = c.pct / tot, I = c.wei ?? WG.soil.WEG_I[c.weg] ?? 0;
          weg[c.weg] = (weg[c.weg] || 0) + w;
          sumI += w * I; wI += w;
          if (C) { const E = (I * C) / 100; risk[riskClass(E)] += w; sumE += w * E; wE += w; } else noC += w;
        });
      }
      const N = pts.length;
      current.result = { N, count, weg, risk, notRated, noC, meanI: wI ? sumI / wI : null, meanE: wE ? sumE / wE : null,
        cMean, cRange: cvals.length ? [Math.min(...cvals), Math.max(...cvals)] : null,
        mu: Object.entries(mu).map(([k, n]) => ({ ...soil.units[k], n })).sort((a, b) => b.n - a.n),
        status: ex ? ex.status : null, soil, ex };
      drawLayers();
      render();
    } catch (e) {
      if (my !== seq) return;
      console.warn("area analysis failed", e);
      status(`Could not finish the analysis: ${esc(e.message || String(e))}`);
    }
  }

  /* ---------------- map layers ---------------- */
  function drawLayers() {
    layer.clearLayers();
    if (!current) return;
    const r = current.result;
    if (r && $("#areaSoils").checked) {
      r.soil.parts.forEach(p => {
        const u = r.soil.units[p.mukey] || {};
        const color = u.water ? "#2563eb" : WEG_COLOR[u.weg] || "#9aa5b1";
        L.polygon(p.rings.map(rg => rg.map(([x, y]) => [y, x])), { pane: "thematic", color: "#ffffff", weight: 0.8, fillColor: color,
          fillOpacity: 0.6, interactive: true }).bindTooltip(`${esc(u.musym || "")} · ${esc(u.muname || "")}${u.weg ? ` · WEG ${esc(u.weg)}` : ""}`, { sticky: true })
          .addTo(layer);
      });
    }
    if (r && r.ex) {
      const ll = rg => rg.map(([x, y]) => [y, x]);
      r.ex.water.forEach(w => L.polygon(w.rings.map(ll), { pane: "refs", color: "#1d4ed8", weight: 1, fillColor: "#3b82f6", fillOpacity: 0.55, interactive: false }).addTo(layer));
      r.ex.buildings.forEach(b => L.polygon(b.rings.map(ll), { pane: "refs", color: "#111827", weight: 0.6, fillColor: "#111827", fillOpacity: 0.75, interactive: false }).addTo(layer));
      r.ex.roads.forEach(rd => L.polyline(ll(rd.line), { pane: "refs", color: "#374151", weight: 3, opacity: 0.8, interactive: false }).addTo(layer));
    }
    L.polygon(current.polys.map(p => p.map(rg => rg.map(([x, y]) => [y, x]))), { pane: "refs", color: "#facc15", weight: 3,
      dashArray: "6 4", fill: false, interactive: false }).addTo(layer);
  }

  /* ---------------- results panel ---------------- */
  const pct = v => `${fmt(v * 100, v < 0.1 ? 1 : 0)} %`;
  function bars(rows) {
    return `<div class="abars">${rows.map(r => `<div class="abar"><span class="sw" style="background:${r.color}"></span>
      <span class="al">${r.label}</span><span class="track"><i style="width:${Math.min(100, r.share * 100).toFixed(1)}%;background:${r.color}"></i></span>
      <span class="av">${pct(r.share)}</span><span class="aa">${fmt(r.acres, r.acres < 10 ? 1 : 0)} ac</span></div>`).join("")}</div>`;
  }
  function render() {
    const c = current, r = c.result, n = r.N || 1;
    const share = k => r.count[k] / n, validAc = c.acres * share("valid");
    const left = ["building", "road", "water"].filter(k => r.count[k]).map(k => `${{ building: "buildings", road: "roads", water: "water" }[k]} ${fmt(c.acres * share(k), 1)} ac`);
    const ratedAc = validAc * (1 - r.notRated / Math.max(r.count.valid, 1)); // open land in components with a WEG
    const wegTot = Object.values(r.weg).reduce((a, b) => a + b, 0) || 1;
    const wegRows = WEG_ORDER.filter(k => r.weg[k]).map(k => ({ label: esc(LAYERS.layers.weg.legend[WEG_ORDER.indexOf(k)].label), color: WEG_COLOR[k],
      share: r.weg[k] / wegTot, acres: ratedAc * (r.weg[k] / wegTot) }));
    const riskTot = r.risk.reduce((a, b) => a + b, 0);
    const riskRows = riskTot ? RISK.map((k, i) => ({ label: `${k.name} <small>${k.range}</small>`, color: k.color, share: r.risk[i] / riskTot,
      acres: ratedAc * (r.risk[i] / riskTot) })).filter(x => x.share > 0) : [];
    const meanE = r.meanE;
    const cTxt = r.cRange ? (r.cRange[0] === r.cRange[1] ? `C = ${fmt(r.cRange[0], 0)}` : `C = ${fmt(r.cRange[0], 0)}–${fmt(r.cRange[1], 0)}`) : "no climatic factor in SSURGO";
    const st = r.status;
    const srcBits = [
      "soils: USDA-NRCS SSURGO (Soil Data Access)",
      st && (st.buildings ? "buildings: FEMA/ORNL USA Structures" : "buildings: <b>service did not answer, not removed</b>"),
      st && (st.roads ? "roads: Census TIGER, widened by road class" : "roads: <b>service did not answer, not removed</b>"),
      st && (st.water ? `water: ${st.waterSrc} and SSURGO Water map units` : "water: SSURGO Water map units only (NHD did not answer)"),
    ].filter(Boolean);
    $("#areaResults").innerHTML = `
      <div class="area-sum"><b>${esc(c.name)}</b><span>${fmt(c.acres, 0)} ac · ${fmt(c.acres / 2.47105, 0)} ha</span></div>
      <p class="fine">Analysed: <b>${fmt(validAc, 0)} ac</b> of open land${left.length ? `; left out ${left.join(", ")}` : ""}${r.count.outside ? `; ${fmt(c.acres * share("outside"), 0)} ac outside Texas` : ""}${r.count.nodata ? `; ${fmt(c.acres * share("nodata"), 1)} ac without soil data` : ""}.</p>
      ${meanE !== null ? `<div class="area-kpi"><div><small>Mean bare-soil potential</small><b>${fmt(meanE, 0)} t/ac/yr</b><span>${RISK[riskClass(meanE)].name}</span></div>
        <div><small>Mean erodibility I</small><b>${fmt(r.meanI, 0)} t/ac/yr</b><span>${cTxt}</span></div></div>` : ""}
      <h4>Wind Erodibility Group (share of rated soil)</h4>${wegRows.length ? bars(wegRows) : '<p class="fine">No rated soils in this area.</p>'}
      ${r.notRated > 0.005 * r.count.valid ? `<p class="fine">${pct(r.notRated / r.count.valid)} of the open land is in components without a WEG (rock outcrop, urban land, pits); it is not in the shares.</p>` : ""}
      <h4>Bare-soil erosion potential, E = I × C / 100</h4>${riskRows.length ? bars(riskRows) : '<p class="fine">No climatic factor C for these map units.</p>'}
      <h4>Soil map units</h4>
      <div class="mtable-wrap"><table class="mtable area-mu"><thead><tr><th>Symbol</th><th>Map unit</th><th>WEG</th><th>Share</th></tr></thead><tbody>
        ${r.mu.slice(0, 12).map(u => `<tr><td>${esc(u.musym || "")}</td><td>${esc(u.muname || "")}</td><td>${esc(u.weg || "—")}</td><td>${pct(u.n / Math.max(r.count.valid, 1))}</td></tr>`).join("")}
      </tbody></table></div>
      ${r.mu.length > 12 ? `<p class="fine">${r.mu.length - 12} smaller map units not listed (all are in the CSV).</p>` : ""}
      <p class="fine">Estimated from ${fmt(r.N, 0)} stratified random sample points; each map unit is split by its component percentages. Sources: ${srcBits.join("; ")}.</p>
      <div class="area-actions"><button class="btn" id="areaCsv">Download CSV</button><button class="btn ghost" id="areaClear">Clear area</button></div>`;
    $("#areaCsv").onclick = csv;
    $("#areaClear").onclick = clear;
  }
  function status(html) { $("#areaResults").innerHTML = `<p class="fine area-status">${html}</p>`; }
  function fail(msg) { status(esc(msg)); toast(msg, 6000); }

  function csv() {
    const c = current, r = c.result, n = r.N || 1, validAc = c.acres * r.count.valid / n;
    const wegTot = Object.values(r.weg).reduce((a, b) => a + b, 0) || 1, riskTot = r.risk.reduce((a, b) => a + b, 0) || 1;
    const lines = [`# WindGuard TX area analysis: ${c.name}`, `# total_acres,${c.acres.toFixed(1)}`, `# analysed_acres,${validAc.toFixed(1)}`,
      ...["building", "road", "water", "outside", "nodata"].map(k => `# ${k}_acres,${(c.acres * r.count[k] / n).toFixed(2)}`),
      `# sample_points,${r.N}`, "", "category,class,share_pct",
      ...WEG_ORDER.filter(k => r.weg[k]).map(k => `WEG,${k},${(100 * r.weg[k] / wegTot).toFixed(2)}`),
      ...RISK.map((k, i) => `E class,${k.name} (${k.range} t/ac/yr),${(100 * r.risk[i] / riskTot).toFixed(2)}`),
      "", "mukey,musym,muname,weg_dominant,climatic_factor_C,share_of_analysed_pct",
      ...r.mu.map(u => [u.mukey, u.musym, `"${(u.muname || "").replace(/"/g, '""')}"`, u.weg || "", u.C || "", (100 * u.n / Math.max(r.count.valid, 1)).toFixed(2)].join(","))];
    download(`windguard-area-${c.name.replace(/[^\w-]+/g, "_").slice(0, 40)}.csv`, lines.join("\n"), "text/csv");
  }

  function clear() {
    seq++;
    current = null;
    layer.clearLayers();
    $("#areaResults").innerHTML = "";
  }

  /* ---------------- drawing ---------------- */
  let drawing = false, verts = [], drawLayer = null, rubber = null;
  function startDraw() {
    drawing = true;
    verts = [];
    drawLayer = L.layerGroup().addTo(map);
    map.doubleClickZoom.disable();
    map.getContainer().classList.add("drawing");
    $("#areaSheet").hidden = true;
    $("#drawBar").hidden = false;
    updateDraw();
  }
  function endDraw() {
    drawing = false;
    verts = [];
    if (drawLayer) map.removeLayer(drawLayer);
    drawLayer = rubber = null;
    map.doubleClickZoom.enable();
    map.getContainer().classList.remove("drawing");
    $("#drawBar").hidden = true;
    $("#areaSheet").hidden = false;
  }
  function updateDraw() {
    drawLayer.clearLayers();
    rubber = null;
    if (verts.length) L.polyline(verts, { color: "#facc15", weight: 3 }).addTo(drawLayer);
    if (verts.length > 2) L.polygon(verts, { color: "#facc15", weight: 0, fillOpacity: 0.15, interactive: false }).addTo(drawLayer);
    verts.forEach((v, i) => L.circleMarker(v, { radius: i ? 4 : 6, color: "#111", weight: 1.5, fillColor: "#facc15", fillOpacity: 1 }).addTo(drawLayer));
    $("#drawMsg").textContent = verts.length < 3 ? `Tap the map to add corners (${verts.length} so far)` : `${verts.length} corners · tap the first corner or Finish`;
    $("#drawFinish").disabled = verts.length < 3;
    $("#drawUndo").disabled = !verts.length;
  }
  function finishDraw() {
    if (!drawing || verts.length < 3) return;
    const ring = verts.map(v => [v.lng, v.lat]);
    ring.push(ring[0]);
    endDraw();
    analyse([[ring]], "Drawn area");
  }
  map.on("click", e => {
    if (!drawing) return;
    if (verts.length > 2) {
      const p0 = map.latLngToContainerPoint(verts[0]), p = map.latLngToContainerPoint(e.latlng);
      if (p0.distanceTo(p) < 14) return finishDraw();
    }
    verts.push(e.latlng);
    updateDraw();
  });
  map.on("dblclick", () => { if (drawing) finishDraw(); });
  map.on("mousemove", e => {
    if (!drawing || !verts.length) return;
    if (rubber) rubber.setLatLngs([verts[verts.length - 1], e.latlng]);
    else rubber = L.polyline([verts[verts.length - 1], e.latlng], { color: "#facc15", weight: 2, dashArray: "4 4", interactive: false }).addTo(drawLayer);
  });

  /* ---------------- uploads ---------------- */
  const loaded = {};
  const loadScript = url => loaded[url] || (loaded[url] = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = url; s.onload = res; s.onerror = () => rej(new Error("could not load " + url));
    document.head.appendChild(s);
  }));
  const readText = f => f.text();
  const readBuf = f => f.arrayBuffer();
  async function parseFiles(files) {
    const by = ext => files.find(f => f.name.toLowerCase().endsWith(ext));
    const name = files[0].name.replace(/\.[^.]+$/, "");
    if (by(".geojson") || by(".json")) return { gj: JSON.parse(await readText(by(".geojson") || by(".json"))), name };
    if (by(".kml")) {
      await loadScript(LIBS.kml);
      return { gj: toGeoJSON.kml(new DOMParser().parseFromString(await readText(by(".kml")), "text/xml")), name };
    }
    if (by(".kmz")) {
      await Promise.all([loadScript(LIBS.zip), loadScript(LIBS.kml)]);
      const z = await JSZip.loadAsync(await readBuf(by(".kmz")));
      const k = Object.values(z.files).find(f => /\.kml$/i.test(f.name));
      if (!k) throw new Error("the .kmz has no .kml inside");
      return { gj: toGeoJSON.kml(new DOMParser().parseFromString(await k.async("text"), "text/xml")), name };
    }
    if (by(".zip")) {
      await loadScript(LIBS.shp);
      return { gj: await shp(await readBuf(by(".zip"))), name };
    }
    if (by(".shp")) {
      await loadScript(LIBS.shp);
      const prj = by(".prj") ? await readText(by(".prj")) : undefined;
      const geoms = shp.parseShp(await readBuf(by(".shp")), prj);
      const gj = by(".dbf") ? shp.combine([geoms, shp.parseDbf(await readBuf(by(".dbf")))])
        : { type: "FeatureCollection", features: geoms.map(g => ({ type: "Feature", geometry: g, properties: {} })) };
      return { gj, name, noPrj: !prj };
    }
    throw new Error("use a .zip shapefile, .shp (+ .dbf, .prj), .kml, .kmz or .geojson file");
  }
  async function upload(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    status("Reading the boundary file…");
    try {
      const { gj, name, noPrj } = await parseFiles(files);
      const polys = geojsonPolys(gj);
      if (!polys.length) throw new Error("no polygons found in the file (lines and points can't bound an area)");
      const bb = bboxOf(polys.flat());
      if (!bb.every(Number.isFinite) || Math.max(Math.abs(bb[0]), Math.abs(bb[2])) > 180 || Math.max(Math.abs(bb[1]), Math.abs(bb[3])) > 90) {
        throw new Error(noPrj ? "the coordinates are projected; add the .prj file (or upload the whole .zip)" : "the coordinates are not latitude/longitude");
      }
      analyse(polys, name);
    } catch (e) {
      fail(`Could not read the boundary: ${e.message || e}`);
    }
  }

  /* ---------------- wiring ---------------- */
  const show = on => { $("#areaSheet").hidden = !on; document.body.classList.toggle("area-open", on); };
  const open = () => show(true);
  $("#areaBtn").addEventListener("click", () => show($("#areaSheet").hidden));
  $("#areaClose").addEventListener("click", () => show(false));
  $("#areaDraw").addEventListener("click", startDraw);
  $("#areaUpload").addEventListener("click", () => $("#areaFile").click());
  $("#areaFile").addEventListener("change", e => { upload(e.target.files); e.target.value = ""; });
  $("#drawUndo").addEventListener("click", () => { verts.pop(); updateDraw(); });
  $("#drawFinish").addEventListener("click", finishDraw);
  $("#drawCancel").addEventListener("click", endDraw);
  $("#areaSoils").addEventListener("change", drawLayers);
  $("#areaExclude").addEventListener("change", () => { if (current) analyse(current.polys, current.name); });
  document.addEventListener("keydown", e => {
    if (!drawing) return;
    if (e.key === "Escape") endDraw();
    else if (e.key === "Enter") finishDraw();
  });

  return { excludedAt, drawing: () => drawing, open, analyse };
})();
