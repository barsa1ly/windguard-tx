/* The area grid: the area tool's boundary as a grid of cells, from 20 cm up, square, turned or hexagonal, or the user's own
   grid file, each cell holding the soil at chosen depths and the weather. Finer cells line up with other grids; they add
   no detail, as the soil survey is mapped at 1:12,000-1:24,000 and the weather comes in cells of 4 km or more. Geometry and
   file formats are in WG.gridfiles. */
WG.grid = (function () {
  const { $, $$, esc, fmt, toast, num } = WG.util;
  const UN = WG.units, X = WG.export, Wd = WG.wind, M = WG.models, D = WG.downloads, G = WG.gridfiles, U = WG.writerUtil, A = WG.area, ok = U.ok, NO = G.NODATA;
  // the most a browser can hold: window cells (three arrays), cells x columns in a GeoTIFF, cells worked out one by one, and in each polygon or text file
  const MAX = { window: 50e6, values: 1.5e9, sampled: 200e3, shp: 500e3, geojson: 100e3, csv: 1e6, wxCells: 80, fields: 240 };
  const SIZE_UNIT = { cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048 };
  const QUICK = [[20, "cm"], [1, "m"], [10, "m"], [30, "m"], [100, "m"], [1, "km"]];
  const COVER = ["outside", "open land", "building", "road", "water", "no soil data"];
  /* soil columns: [key, name, short name, unit, or q and per for the units table], for each chosen layer */
  const SOIL = [["sand", "Sand", "SAND", "%"], ["silt", "Silt", "SILT", "%"], ["clay", "Clay", "CLAY", "%"], ["om", "Organic matter", "OM", "%"], ["bd", "Bulk density", "BD", "g/cm3"],
    ["ll", "Wilting point", "LL", "cm3/cm3"], ["dul", "Field capacity", "DUL", "cm3/cm3"], ["sat", "Saturation", "SAT", "cm3/cm3"], ["ksat", "Ksat", "KSAT", null, "ksat", 1 / 3.6],
    ["ph", "pH", "PH", ""], ["cec", "CEC", "CEC", "cmol/kg"], ["caco3", "CaCO3", "CACO", "%"], ["cfVol", "Coarse fragments", "CF", "% volume"], ["ec", "EC", "EC", "dS/m"]];
  const SOIL_ON = ["sand", "silt", "clay", "om", "bd", "ll", "dul", "ksat"];
  /* one column each: the map unit, its erodibility */
  const SITE = [["mukey", "Soil map unit key", "MUKEY"], ["weg", "Wind Erodibility Group (4L = 41)", "WEG"], ["wei", "Wind erodibility index I", "I"], ["cf", "Climatic factor C", "C"], ["e", "Bare-soil potential E", "E"]];
  const WX = [["prcp", "Rain", "RAIN", "precip", true], ["tmax", "Mean Tmax", "TMAX", "temp"], ["tmin", "Mean Tmin", "TMIN", "temp"], ["srad", "Mean solar radiation", "SRAD", "solar"],
    ["rh", "Mean relative humidity", "RH", null], ["wind10", "Mean wind at 10 m", "WIND", "wind"], ["et0", "Grass ET0", "ET0", "precip", true]];
  /* the weather sources' grids, for telling which of their cells a grid cell falls in */
  const WX_GRID = { gridmet: { name: "gridMET", res: "4 km", dLat: 1 / 24, dLon: 1 / 24, lat0: 49.4, lon0: -124.7666666333 },
    power: { name: "NASA POWER", res: "0.5°", dLat: 0.5, dLon: 0.625, lat0: 0, lon0: 0 } };

  let area = null, job = null, busy = false, own = null;
  const soilKept = new Map(), wxKept = new Map();
  const breathe = () => new Promise(r => setTimeout(r));
  const short = (s, n) => String(s).replace(/[^\w]+/g, "_").slice(0, n);

  /* ---------- the sheet ---------- */
  function open(a) {
    if (!a || !a.result) return toast("Draw or upload a boundary in the area tool first, and wait for its analysis.");
    if (!area || area.polys !== a.polys) { job = null; own = null; }
    area = a;
    render();
    D.open("gridSheet");
    estimate();
  }
  const checks = (name, list, on, label = x => x[1]) => list.map(x => `<label><input type="checkbox" name="${name}" value="${x[0]}" ${on(x) ? "checked" : ""}> ${esc(label(x))}</label>`).join("");
  function render() {
    const y = new Date().getUTCFullYear() - 1, depth = UN.sym("depth"), dv = v => +UN.conv("depth", v).toFixed({ in: 2, cm: 1, mm: 0 }[depth] ?? 1);
    $("#gridBody").innerHTML = `
      <p class="fine"><b>${esc(area.name)}</b>. A grid of cells with the soil and weather in each, as a raster or as polygons, ready for a GIS.
        Finer cells do not add detail: the soil survey is mapped at 1:12,000–1:24,000 and the weather comes in cells of 4 km or more, so a 20 cm grid repeats the same values. Use it to line up with a grid you already have.</p>
      <section class="data-sec"><h4>1 · The grid</h4>
        <div class="form-grid">
          <label>Cell size<input type="number" id="gSize" value="30" min="0" step="any"></label>
          <label>Unit<select id="gUnit">${Object.keys(SIZE_UNIT).map(u => `<option ${u === "m" ? "selected" : ""}>${u}</option>`).join("")}</select></label>
          <label>Shape<select id="gShape"><option value="square">Square, north up (most common)</option><option value="turned">Square, turned by an angle</option><option value="hex">Hexagons, points up</option><option value="hexflat">Hexagons, flat side up</option><option value="own">My own grid file…</option></select></label>
          <label id="gAngleBox" hidden>Angle, clockwise (degrees)<input type="number" id="gAngle" value="0" step="any"></label>
          <label id="gCrsBox">Coordinates<select id="gCrs"><option value="utm">UTM zone of this area (metres)</option><option value="albers">CONUS Albers, EPSG:5070 (as NLCD and CDL)</option></select></label>
        </div>
        <p class="fine">Quick size: ${QUICK.map(([v, u]) => `<button class="link" data-quick="${v},${u}">${v} ${u}</button>`).join(" · ")}. A hexagon's size is its width across the flat sides.</p>
        <div id="gOwnBox" hidden><div class="form-grid"><label>Your grid (polygons: zipped shapefile, .kml, .kmz or .geojson)<input type="file" id="gOwnFile" accept=".zip,.shp,.dbf,.prj,.shx,.kml,.kmz,.geojson,.json" multiple></label></div><p class="fine dl-status" id="gOwnInfo"></p></div>
        <div id="gLineBox"><label class="pv-vars"><span><input type="checkbox" id="gLine"> Line up with a corner of a grid I have</span></label>
          <div class="form-grid" id="gLineXY" hidden><label>X of that corner (m)<input type="number" id="gOx" value="0" step="any"></label><label>Y of that corner (m)<input type="number" id="gOy" value="0" step="any"></label></div></div>
        <div class="form-grid"><label>A cell's value<select id="gRule"><option value="centre">What lies at its centre</option><option value="area">Weighted by what covers it (slower; ${(MAX.sampled / 1000).toFixed(0)},000 cells at most)</option></select></label></div>
        <p class="fine dl-status" id="gEstimate"></p>
      </section>
      <section class="data-sec"><h4>2 · Soil</h4>
        <div class="pv-vars">${checks("gSite", SITE, x => ["mukey", "weg"].includes(x[0]))}</div>
        <p class="fine">For each layer below:</p>
        <div class="pv-vars">${checks("gSoil", SOIL, x => SOIL_ON.includes(x[0]))}</div>
        <div class="form-grid"><label>Bottom of each layer (${esc(depth)})<input id="gDepths" inputmode="decimal" value="${[15, 30, 60, 100].map(dv).join(", ")}"></label>
          <label>Within a map unit<select id="gComp"><option value="dominant">The main soil</option><option value="weighted">All its soils, weighted by their %</option></select></label></div>
        <p class="fine">A map unit mixes soils without showing where each one lies, so a cell takes its main soil or a weighted mean. A layer below the end of a profile is left blank.</p>
      </section>
      <section class="data-sec"><h4>3 · Weather</h4>
        <label class="pv-vars"><span><input type="checkbox" id="gWxOn"> Add weather</span></label>
        <div id="gWxBox" hidden>
          <div class="form-grid"><label>From<select id="gWxSrc">${Object.entries(WX_GRID).map(([k, g]) => `<option value="${k}">${esc(g.name)}, ${esc(g.res)}</option>`).join("")}</select></label>
            <label>First day<input type="date" id="gFrom" value="${y - 9}-01-01"></label><label>Last day<input type="date" id="gTo" value="${y}-12-31"></label></div>
          <div class="pv-vars">${checks("gWx", WX, x => ["prcp", "tmax", "tmin"].includes(x[0]))}</div>
          <div class="pv-vars"><label><input type="checkbox" id="gMonthly"> Also each calendar month's value</label><label><input type="checkbox" id="gDaily" checked> Daily weather tables, one for each weather cell</label></div>
          <p class="fine">Each grid cell holds the period's means and a number that points to its weather cell, because a daily series for every grid cell would be far too large.</p>
        </div>
      </section>
      <section class="data-sec"><h4>4 · Files</h4>
        <div class="pv-vars" id="gFiles"></div>
        <p class="fine">A GeoTIFF holds square cells only. Some GIS software ignores a raster's turn, so a turned grid also comes well as polygons; hexagons can only be polygons.</p>
      </section>
      <div class="area-actions"><button class="btn" id="gBuild">Build and preview</button><button class="btn primary" id="gSave" disabled>Download</button><span class="fine dl-status" id="gStatus"></span></div>
      <section class="data-sec" id="gPvSec" hidden><h4>Preview</h4>
        <div class="pv-tools"><label class="pv-lab">Show <select id="gBand"></select></label></div>
        <canvas id="gCanvas" class="grid-canvas"></canvas><div id="gLegend" class="grid-legend"></div>
        <div class="table-wrap"><table class="grid pv-table" id="gStats"></table></div>
      </section>`;
    wire();
    shape();
  }
  function wire() {
    const body = $("#gridBody");
    body.onchange = body.oninput = e => { if (["gBand", "gOwnFile"].includes(e.target.id)) return; stale(); estimate(); };
    body.onclick = e => {
      const q = e.target.closest("[data-quick]");
      if (q) { const [v, u] = q.dataset.quick.split(","); $("#gSize").value = v; $("#gUnit").value = u; stale(); estimate(); }
    };
    $("#gShape").addEventListener("change", shape);
    $("#gLine").addEventListener("change", () => { $("#gLineXY").hidden = !$("#gLine").checked; });
    $("#gWxOn").addEventListener("change", () => { $("#gWxBox").hidden = !$("#gWxOn").checked; });
    $("#gOwnFile").addEventListener("change", loadOwn);
    $("#gBuild").addEventListener("click", build);
    $("#gSave").addEventListener("click", save);
    $("#gBand").addEventListener("change", preview);
  }
  function shape() {
    const v = $("#gShape").value, mine = v === "own";
    $("#gAngleBox").hidden = v === "square" || mine;
    $("#gOwnBox").hidden = !mine;
    $("#gLineBox").hidden = mine;
    $("#gSize").disabled = $("#gUnit").disabled = mine;
    if (mine) $("#gRule").value = $("#gRule").value;
  }
  function stale() {
    if (!job) return;
    job = null;
    $("#gSave").disabled = true;
    $("#gPvSec").hidden = true;
    $("#gStatus").textContent = "You changed something: build it again.";
  }
  const ticks = name => $$(`input[name=${name}]:checked`).map(i => i.value);
  function depths() {
    const raw = ($("#gDepths").value || "").split(/[,;\s]+/).filter(Boolean);
    const v = raw.map(x => UN.back("depth", +x));
    if (raw.length && v.some(x => x === null || !(x > 0))) return null;
    return [...new Set(v.map(x => Math.round(x * 10) / 10))].sort((a, b) => a - b);
  }
  function options() {
    const v = $("#gShape").value;
    return { size: +$("#gSize").value * SIZE_UNIT[$("#gUnit").value], shape: v, angle: v === "square" || v === "own" ? 0 : +$("#gAngle").value || 0, crs: $("#gCrs").value,
      line: $("#gLine").checked && v !== "own", ox: +$("#gOx").value || 0, oy: +$("#gOy").value || 0, rule: v === "own" ? "area" : $("#gRule").value,
      site: ticks("gSite"), soil: ticks("gSoil"), depths: depths(), comp: $("#gComp").value,
      wx: $("#gWxOn").checked, src: $("#gWxSrc").value, from: $("#gFrom").value, to: $("#gTo").value, wxVars: ticks("gWx"), monthly: $("#gMonthly").checked, daily: $("#gDaily").checked,
      files: ticks("gFile") };
  }
  /* the projection, and the lattice and its window, of the choices made */
  function setup(o) {
    const bb = area.bb, cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2, P = o.crs === "albers" ? G.ALBERS : G.utm(G.zoneOf(cx));
    const rings = area.polys.map(poly => poly.map(r => r.map(([x, y]) => P.fwd(x, y))));
    if (o.shape === "own") return { P, rings };
    let ox = 0, oy = 0;
    if (o.line) { ox = o.ox; oy = o.oy; } else if (o.angle) { const [E, N] = P.fwd(cx, cy); ox = Math.round(E / o.size) * o.size; oy = Math.round(N / o.size) * o.size; } // turned about a point near the area
    const L = G.lattice({ kind: o.shape.startsWith("hex") ? "hex" : "square", size: o.size, angle: o.angle, ox, oy, flat: o.shape === "hexflat" });
    return { P, rings, L, W: G.windowOf(L, rings.flat()) };
  }
  const areaM2 = () => area.acres * 4046.8564;
  const nCols = o => o.site.length + o.soil.length * (o.depths ? o.depths.length : 0) + (o.wx ? o.wxVars.length * (o.monthly ? 13 : 1) + 1 : 0) + 1;
  const wordy = n => (n >= 1e9 ? `${fmt(n / 1e9, 1)} billion` : n >= 1e6 ? `${fmt(n / 1e6, 1)} million` : Math.round(n).toLocaleString());
  /* what these choices come to, and which files they allow */
  function estimate() {
    const o = options(), box = $("#gEstimate"), mine = o.shape === "own";
    let cells, say = "", S = null;
    if (mine) {
      cells = own ? own.polys.length : 0;
      say = own ? `${cells.toLocaleString()} cells in ${own.name}.` : "Choose your grid file. Cells whose centres lie inside the boundary are kept.";
    } else {
      if (!(o.size >= 0.2)) { box.textContent = "The smallest cell is 20 cm."; return buttons(0, o, null); }
      S = setup(o);
      cells = areaM2() / S.L.area;
      const need = Math.sqrt(areaM2() / MAX.window) * 1.2;
      say = `About ${wordy(cells)} cells of ${fmt(S.L.area, S.L.area < 1 ? 2 : 0)} m².`;
      if (S.W.count > MAX.window) say += ` That is more than a browser can hold (${wordy(MAX.window)}): for this area use cells of ${need < 1 ? `${Math.ceil(need * 100)} cm` : `${Math.ceil(need)} m`} or more, or a smaller area.`;
      if (o.rule === "area" && cells > MAX.sampled) say += ` Weighing what covers each cell works up to ${wordy(MAX.sampled)} cells; use what lies at the centre, or larger cells.`;
    }
    box.textContent = say;
    buttons(cells, o, S);
  }
  /* the file choices these cells allow; a tick survives while its file stays possible */
  function buttons(cells, o, S) {
    const was = new Set(ticks("gFile")), first = !$("#gFiles input"), hex = o.shape.startsWith("hex"), mine = o.shape === "own";
    const list = [["tif", `GeoTIFF, one band per column${hex || mine ? " (square cells only)" : ""}`, !hex && !mine && (S ? S.W.count <= MAX.window && cells * nCols(o) <= MAX.values : false)],
      ["shp", `Shapefile of the cells (up to ${wordy(MAX.shp)})`, cells <= MAX.shp], ["geojson", `GeoJSON of the cells (up to ${wordy(MAX.geojson)})`, cells <= MAX.geojson], ["csv", `CSV, one row per cell (up to ${wordy(MAX.csv)})`, cells <= MAX.csv]];
    const pick = k => { if (first) return k === "tif" ? !hex && !mine : (hex || mine) && k === "shp"; return was.has(k); };
    $("#gFiles").innerHTML = list.map(([k, n, can]) => `<label class="${can ? "" : "off"}"><input type="checkbox" name="gFile" value="${k}" ${can && pick(k) ? "checked" : ""} ${can ? "" : "disabled"}> ${esc(n)}</label>`).join("");
  }
  async function loadOwn() {
    const f = $("#gOwnFile").files;
    if (!f.length) return;
    try {
      const { gj, name } = await A.parseFiles([...f]), feats = gj.features || (Array.isArray(gj) ? gj.flatMap(x => x.features || []) : []);
      const polys = [];
      feats.forEach(ft => A.geojsonPolys(ft).forEach(p => polys.push({ rings: p, props: ft.properties || {} })));
      if (!polys.length) throw new Error("it has no polygons");
      if (polys.length > MAX.sampled) throw new Error(`it has ${polys.length.toLocaleString()} cells, and ${MAX.sampled.toLocaleString()} is the most`);
      const bb = A.bboxOf(polys[0].rings);
      if (Math.abs(bb[0]) > 180 || Math.abs(bb[1]) > 90) throw new Error("its coordinates are projected: add its .prj file, or upload the whole .zip");
      own = { polys, name };
      $("#gOwnInfo").textContent = "";
      stale(); estimate();
    } catch (e) { own = null; $("#gOwnInfo").textContent = `Could not read it: ${e.message || e}`; estimate(); }
  }

  /* ---------- soil: a value per map unit ---------- */
  const inList = a => a.map(k => +k).join(",");
  async function soilTables(keys, status) {
    const need = keys.filter(k => !soilKept.has(k));
    for (let n = 0; n < need.length; n += 100) {
      status(`Reading soil horizons for ${need.length} map units…`);
      const part = inList(need.slice(n, n + 100));
      const [comps, hz, restr] = await Promise.all([
        A.sda(`SELECT mukey, cokey, compname, comppct_r, weg, wei FROM component WHERE mukey IN (${part}) ORDER BY mukey, comppct_r DESC`),
        A.sda(`SELECT ch.cokey, ch.hzname, ch.hzdept_r, ch.hzdepb_r, ch.sandtotal_r, ch.silttotal_r, ch.claytotal_r, ch.om_r, ch.dbthirdbar_r, ch.wthirdbar_r, ch.wfifteenbar_r, ch.wsatiated_r, ch.awc_r, ch.ksat_r, ch.ph1to1h2o_r, ch.cec7_r, ch.ecec_r, ch.caco3_r, ch.ec_r, ch.sar_r, ch.kwfact, ch.kffact, ch.sieveno10_r, ch.frag3to10_r, ch.fraggt10_r, ch.fragvoltot_r
          FROM chorizon ch WHERE ch.cokey IN (SELECT cokey FROM component WHERE mukey IN (${part})) ORDER BY ch.cokey, ch.hzdept_r`),
        A.sda(`SELECT cokey, reskind, resdept_r FROM corestrictions WHERE cokey IN (SELECT cokey FROM component WHERE mukey IN (${part}))`),
      ]);
      const hzBy = new Map(), reBy = new Map(), by = new Map();
      hz.forEach(h => { if (num(h.hzdepb_r) !== null) hzBy.set(h.cokey, [...(hzBy.get(h.cokey) || []), h]); });
      restr.forEach(r => reBy.set(r.cokey, [...(reBy.get(r.cokey) || []), r]));
      comps.forEach(c => by.set(String(c.mukey), [...(by.get(String(c.mukey)) || []), { ...c, comppct_r: num(c.comppct_r) || 0, horizons: hzBy.get(c.cokey) || [], restrictions: (reBy.get(c.cokey) || []).sort((a, b) => num(a.resdept_r) - num(b.resdept_r)) }]));
      need.slice(n, n + 100).forEach(k => soilKept.set(k, by.get(k) || []));
      await breathe();
    }
  }
  /* a component's layers on the chosen bottoms, or null past the end of its profile: nothing is repeated here */
  function compLayers(comp, B) {
    const base = M.surveyLayers(comp).filter(l => ok(l.top) && ok(l.bot) && l.bot > l.top);
    if (!base.length) return B.map(() => null);
    const s = M.relayer({ layers: base }, B);
    return B.map((_, i) => { const l = s.layers[i]; return l && !l.extended ? l : null; });
  }
  /* one number for a map unit from its components: the main one that has it, or the mean weighted by their % */
  function mix(comps, valueOf, how) {
    if (how === "dominant") { for (const c of comps) { const v = valueOf(c); if (ok(v)) return v; } return null; }
    let s = 0, w = 0;
    comps.forEach(c => { const v = valueOf(c); if (ok(v) && c.comppct_r > 0) { s += v * c.comppct_r; w += c.comppct_r; } });
    return w ? s / w : null;
  }
  const depthTag = v => String(+UN.conv("depth", v).toFixed(UN.sym("depth") === "in" ? 1 : 0)).replace(".", "p");
  /* the columns of the soil, each with its value for every map unit: lut[id] */
  function soilBands(o, ids, units) {
    const bands = [], n = ids.length + 1, comps = ids.map(k => soilKept.get(k) || []), B = o.depths || [];
    const wegCode = w => (w === "4L" ? 41 : num(w));
    o.site.forEach(k => {
      const d = SITE.find(x => x[0] === k), lut = new Float32Array(n).fill(NO);
      ids.forEach((id, a) => {
        const u = units[id], list = comps[a], cf = u && u.C ? +u.C : null, iOf = c => num(c.wei) ?? (c.weg ? WG.soil.WEG_I[c.weg] : null);
        const v = k === "mukey" ? +id : k === "weg" ? mix(list, c => wegCode(c.weg), "dominant") : k === "cf" ? cf
          : k === "wei" ? (ok(mix(list, iOf, o.comp)) ? UN.conv("soilLoss", mix(list, iOf, o.comp)) : null)
            : cf !== null && ok(mix(list, iOf, o.comp)) ? UN.conv("soilLoss", (mix(list, iOf, o.comp) * cf) / 100) : null;
        if (ok(v)) lut[a + 1] = v;
      });
      bands.push({ name: k, short: d[2], label: d[1], unit: k === "wei" || k === "e" ? UN.sym("soilLoss") : "", by: "soil", lut, cat: k === "mukey" || k === "weg" });
    });
    B.forEach((bot, b) => {
      const top = b ? B[b - 1] : 0, tag = `${depthTag(top)}_${depthTag(bot)}`, layers = comps.map(list => list.map(c => compLayers(c, B)[b]));
      o.soil.forEach(k => {
        const d = SOIL.find(x => x[0] === k), lut = new Float32Array(n).fill(NO);
        ids.forEach((id, a) => {
          const v = mix(comps[a].map((c, i) => ({ ...c, l: layers[a][i] })), c => (c.l ? c.l[k] : null), o.comp);
          if (ok(v)) lut[a + 1] = d[4] ? UN.conv(d[4], v * d[5]) : v;
        });
        bands.push({ name: `${k}_${tag}`, short: `${d[2]}${tag.replace(/_/g, "")}`, label: `${d[1]}, ${fmt(UN.conv("depth", top), 0)}–${fmt(UN.conv("depth", bot), 0)} ${UN.sym("depth")}`, unit: d[4] ? UN.sym(d[4]) : d[3], by: "soil", lut });
      });
    });
    return bands;
  }

  /* ---------- weather: a value per weather cell ---------- */
  const wxIndex = (g, lon, lat) => [Math.round((lat - g.lat0) / g.dLat), Math.round((lon - g.lon0) / g.dLon)];
  const wxCentre = (g, j, i) => [g.lon0 + i * g.dLon, g.lat0 + j * g.dLat];
  async function wxSeries(o, cells, status) {
    const d0 = Wd.parseDay(o.from), d1 = Wd.parseDay(o.to), out = [];
    let done = 0;
    await Promise.all([0, 1, 2].map(async () => {
      while (done < cells.length) {
        const k = done++, c = cells[k], key = [o.src, o.from, o.to, c.lon.toFixed(4), c.lat.toFixed(4)].join();
        status(`Reading weather, cell ${Math.min(done, cells.length)} of ${cells.length}…`);
        if (!wxKept.has(key)) wxKept.set(key, await Wd.dailyWeather(c.lat, c.lon, d0, d1, o.src, null));
        out[k] = U.clean(wxKept.get(key));
      }
    }));
    return out;
  }
  /* the columns of the weather, each with its value for every weather cell. Rain and ET0 per year, or per calendar
     month, from the days with data, scaled to whole periods; the rest as means. */
  function wxBands(o, series) {
    const bands = [], n = series.length + 1;
    const add = (name, short2, label, unit, value) => {
      const lut = new Float32Array(n).fill(NO);
      series.forEach((w, a) => { const v = value(w); if (ok(v)) lut[a + 1] = v; });
      bands.push({ name, short: short2, label, unit, by: "wx", lut });
    };
    add("wx_cell", "WXCELL", "Weather cell (see weather/cells.csv)", "", (() => { let a = 0; return () => ++a; })());
    bands[0].cat = true;
    const cv = (q, v) => (ok(v) ? (q ? UN.conv(q, v) : v) : null);
    o.wxVars.forEach(k => {
      const d = WX.find(x => x[0] === k), q = d[3], sum = !!d[4], unit = q ? UN.sym(q) : "%";
      const meanOf = (w, month) => {
        let s = 0, c = 0;
        w.days.forEach((day, i) => { const v = w[k] && w[k][i]; if (ok(v) && (month === null || new Date(day * 864e5).getUTCMonth() === month)) { s += v; c++; } });
        return c ? s / c : null;
      };
      add(k, d[2], `${d[1]}${sum ? " per year" : ""}`, sum ? `${unit}/yr` : unit, w => { const m = meanOf(w, null); return m === null ? null : cv(q, sum ? m * 365.25 : m); });
      if (o.monthly) [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].forEach((days, m) => {
        const tag = String(m + 1).padStart(2, "0");
        add(`${k}_m${tag}`, `${d[2].slice(0, 6)}M${tag}`, `${d[1]}, ${WG.util.MONTHS[m]}`, sum ? `${unit}/month` : unit, w => { const v = meanOf(w, m); return v === null ? null : cv(q, sum ? v * days : v); });
      });
    });
    return bands;
  }

  /* ---------- filling the cells ---------- */
  /* an index of polygons for finding what lies at a point */
  function polyIndex(items, bb) {
    const nx = 128, cw = Math.max(bb[2] - bb[0], 1) / nx, ch = Math.max(bb[3] - bb[1], 1) / nx, cells = Array.from({ length: nx * nx }, () => []), cl = (v, m) => Math.max(0, Math.min(nx - 1, Math.floor(v / m)));
    items.forEach(it => {
      const b = A.bboxOf(it.rings);
      for (let i = cl(b[0] - bb[0], cw); i <= cl(b[2] - bb[0], cw); i++) for (let j = cl(b[1] - bb[1], ch); j <= cl(b[3] - bb[1], ch); j++) cells[j * nx + i].push(it);
    });
    return (E, N) => cells[cl(N - bb[1], ch) * nx + cl(E - bb[0], cw)].find(it => A.inRings(E, N, it.rings)) || null;
  }
  const roadBands = (ex, P) => ex.roads.flatMap(r => {
    const half = A.roadHalf(r.props.MTFCC), p = r.line.map(([x, y]) => P.fwd(x, y)), out = [];
    for (let k = 0; k + 1 < p.length; k++) out.push(G.bandRing(p[k][0], p[k][1], p[k + 1][0], p[k + 1][1], half));
    return out;
  });
  const projPolys = (list, P) => list.map(p => p.rings.map(r => r.map(([x, y]) => P.fwd(x, y))));

  /* by the cell's centre: polygons painted on the lattice, so any number of cells costs little */
  async function byCentre(o, S, ctx, status) {
    const { W, P } = S, mask = new Uint8Array(W.count), soilIdx = new Uint16Array(W.count), wxIdx = o.wx ? new Uint16Array(W.count) : null, r = area.result, ex = r.ex;
    status("Laying out the cells…");
    S.rings.forEach(rg => G.paint(W, rg, k => { mask[k] = 1; }));
    await breathe();
    const onto = v => k => { if (mask[k] === 1) mask[k] = v; };
    if (ex) {
      status("Marking buildings, roads and water…");
      projPolys(ex.water, P).forEach(rg => G.paint(W, rg, onto(4)));
      roadBands(ex, P).forEach(q => G.paint(W, [q], onto(3)));
      projPolys(ex.buildings, P).forEach(rg => G.paint(W, rg, onto(2)));
      await breathe();
    }
    status("Placing the soil map units…");
    const idOf = new Map(ctx.ids.map((k, a) => [k, a + 1]));
    r.soil.parts.forEach(p => {
      const rg = p.rings.map(q => q.map(([x, y]) => P.fwd(x, y))), id = idOf.get(String(p.mukey)), water = r.soil.units[p.mukey] && r.soil.units[p.mukey].water;
      G.paint(W, rg, water ? onto(4) : k => { if (mask[k] === 1) soilIdx[k] = id; });
    });
    await breathe();
    if (o.wx) {
      const g = WX_GRID[o.src], bb = area.bb, [j0, i0] = wxIndex(g, bb[0], bb[1]), [j1, i1] = wxIndex(g, bb[2], bb[3]);
      const cells = [];
      for (let j = Math.min(j0, j1); j <= Math.max(j0, j1); j++) for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) {
        const [lon, lat] = wxCentre(g, j, i), hx = g.dLon / 2, hy = g.dLat / 2, c = { j, i, lon, lat, n: 0 }, id = cells.length + 1;
        G.paint(W, [[[lon - hx, lat - hy], [lon - hx, lat + hy], [lon + hx, lat + hy], [lon + hx, lat - hy], [lon - hx, lat - hy]].map(([x, y]) => P.fwd(x, y))], k => { if (mask[k]) { wxIdx[k] = id; c.n++; } });
        cells.push(c);
      }
      // only the weather cells some grid cell falls in
      const used = cells.filter(c => c.n), renum = new Uint16Array(cells.length + 1);
      cells.forEach((c, a) => { if (c.n) renum[a + 1] = used.indexOf(c) + 1; });
      for (let k = 0; k < wxIdx.length; k++) if (wxIdx[k]) wxIdx[k] = renum[wxIdx[k]];
      ctx.wxCells = used;
    }
    let count = 0;
    const cover = [0, 0, 0, 0, 0, 0], sN = new Float64Array(ctx.ids.length + 1), wN = new Float64Array(ctx.wxCells ? ctx.wxCells.length + 1 : 1);
    for (let k = 0; k < W.count; k++) {
      if (!mask[k]) continue;
      if (mask[k] === 1 && !soilIdx[k]) mask[k] = 5;
      count++; cover[mask[k]]++; sN[soilIdx[k]]++;
      if (wxIdx) wN[wxIdx[k]]++;
    }
    return { mode: "centre", S, W, L: S.L, P, mask, soilIdx, wxIdx, count, cover, sN, wN };
  }
  /* by what covers the cell: points in each cell looked up one by one, for any cells, the user's own too */
  async function bySampling(o, S, ctx, status) {
    const { P } = S, r = area.result, ex = r.ex, bb = A.bboxOf(S.rings.flat()), pad = 50, box = [bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad], K = 5;
    const list = [];
    if (o.shape === "own") {
      own.polys.forEach((p, n) => {
        const rg = p.rings.map(q => q.map(([x, y]) => P.fwd(x, y))), b = A.bboxOf(rg), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
        if (S.rings.some(a => A.inRings(cx, cy, a))) list.push({ rings: rg, cx, cy, b, n, props: p.props, lonlat: p.rings });
      });
      if (!list.length) throw new Error("None of your grid's cells has its centre inside this boundary");
    } else {
      const { W, L } = S, mask = new Uint8Array(W.count);
      S.rings.forEach(rg => G.paint(W, rg, k => { mask[k] = 1; }));
      for (let j = W.j1; j >= W.j0; j--) for (let i = W.i0; i <= W.i1; i++) {
        if (!mask[G.indexOf(W, i, j)]) continue;
        const [cx, cy] = L.centre(i, j), rg = [L.ring(i, j)];
        list.push({ rings: rg, cx, cy, b: A.bboxOf(rg), i, j, k: G.indexOf(W, i, j) });
      }
    }
    if (list.length > MAX.sampled) throw new Error(`That is ${list.length.toLocaleString()} cells, and weighing what covers each works up to ${MAX.sampled.toLocaleString()}: use what lies at the centre, or larger cells`);
    const idOf = new Map(ctx.ids.map((k, a) => [k, a + 1]));
    const soilAt = polyIndex(r.soil.parts.map(p => ({ rings: p.rings.map(q => q.map(([x, y]) => P.fwd(x, y))), id: idOf.get(String(p.mukey)), water: r.soil.units[p.mukey] && r.soil.units[p.mukey].water })), box);
    const exAt = ex ? polyIndex([...projPolys(ex.water, P).map(rings => ({ rings, v: 4 })), ...roadBands(ex, P).map(q => ({ rings: [q], v: 3 })), ...projPolys(ex.buildings, P).map(rings => ({ rings, v: 2 }))], box) : null;
    const g = o.wx ? WX_GRID[o.src] : null, wxMap = new Map(), weights = new Array(list.length), covers = new Uint8Array(list.length);
    for (let c = 0; c < list.length; c++) {
      const cell = list[c], [x0, y0, x1, y1] = cell.b, soil = new Map(), wx = new Map(), cov = [0, 0, 0, 0, 0, 0];
      for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) {
        const E = x0 + ((a + 0.5) / K) * (x1 - x0), N = y0 + ((b + 0.5) / K) * (y1 - y0);
        if (!A.inRings(E, N, cell.rings)) continue;
        if (g) {
          const [lon, lat] = P.inv(E, N), [j, i] = wxIndex(g, lon, lat), key = `${j},${i}`;
          if (!wxMap.has(key)) { const [clon, clat] = wxCentre(g, j, i); wxMap.set(key, { j, i, lon: clon, lat: clat, n: 0, id: wxMap.size + 1 }); }
          const w = wxMap.get(key); w.n++;
          wx.set(w.id, (wx.get(w.id) || 0) + 1);
        }
        const hit = exAt && exAt(E, N);
        if (hit) { cov[hit.v]++; continue; }
        const s = soilAt(E, N);
        if (s && s.water) { cov[4]++; continue; }
        if (!s) { cov[5]++; continue; }
        cov[1]++;
        soil.set(s.id, (soil.get(s.id) || 0) + 1);
      }
      weights[c] = { soil, wx };
      covers[c] = cov.indexOf(Math.max(...cov.slice(1)), 1);
      if (c % 2000 === 0) { status(`Weighing the cells: ${c.toLocaleString()} of ${list.length.toLocaleString()}…`); await breathe(); }
    }
    ctx.wxCells = g ? [...wxMap.values()] : null;
    const cover = [0, 0, 0, 0, 0, 0];
    covers.forEach(v => { cover[v]++; });
    let at = null;
    if (S.W) { at = new Int32Array(S.W.count); list.forEach((c, n) => { at[c.k] = n + 1; }); }
    return { mode: "area", S, W: S.W || null, L: S.L || null, P, list, weights, covers, at, count: list.length, cover };
  }
  /* in the weighed mode each column has one value per cell: a mean of what covers it, or for a code the largest share */
  function weigh(res, bands) {
    bands.forEach(b => {
      if (b.by === "mask") return;
      const vals = new Float32Array(res.count).fill(NO), key = b.by === "soil" ? "soil" : "wx";
      res.weights.forEach((w, c) => {
        let s = 0, t = 0, top = 0, best = NO;
        w[key].forEach((n, id) => { const v = b.lut[id]; if (v === NO) return; s += v * n; t += n; if (n > top) { top = n; best = v; } });
        if (t) vals[c] = b.cat ? best : s / t;
      });
      b.vals = vals;
    });
  }

  /* ---------- build ---------- */
  async function build() {
    if (busy) return;
    const o = options(), status = t => { $("#gStatus").textContent = t; };
    if (o.shape !== "own" && !(o.size >= 0.2)) return toast("The smallest cell is 20 cm.");
    if (o.shape === "own" && !own) return toast("Choose your grid file first.");
    if (!o.depths && o.soil.length) return toast("Layer bottoms must be positive numbers separated by commas.");
    if (o.wx && !o.wxVars.length) return toast("Tick at least one weather column, or leave out the weather.");
    if (o.wx && !(o.from && o.to && o.from <= o.to)) return toast("Choose a first day before the last day.");
    if (!o.site.length && !o.soil.length && !o.wx) return toast("Tick at least one soil or weather column.");
    busy = true;
    $("#gBuild").disabled = $("#gSave").disabled = true;
    const S = setup(o);
    try {
      if (S.W && S.W.count > MAX.window) throw new Error(`That is more cells than a browser can hold (${wordy(S.W.count)} in the area's bounding box)`);
      const units = area.result.soil.units, ids = Object.keys(units), ctx = { ids };
      if (o.site.length || o.soil.length) await soilTables(ids, status);
      const res = o.rule === "area" || o.shape === "own" ? await bySampling(o, S, ctx, status) : await byCentre(o, S, ctx, status);
      let series = [];
      if (o.wx) {
        if (ctx.wxCells.length > MAX.wxCells) throw new Error(`The area crosses ${ctx.wxCells.length} weather cells, and ${MAX.wxCells} is the most to read`);
        series = await wxSeries(o, ctx.wxCells, status);
      }
      status("Working out the columns…");
      await breathe();
      const bands = [{ name: "cover", short: "COVER", label: "What covers the cell (1 open land, 2 building, 3 road, 4 water, 5 no soil data)", unit: "", by: "mask", cat: true, lut: Float32Array.from([NO, 1, 2, 3, 4, 5]) },
        ...(o.site.length || o.soil.length ? soilBands(o, ids, units) : []), ...(o.wx ? wxBands(o, series) : [])];
      const seen = new Set();
      bands.forEach(b => { let s = b.short.slice(0, 10).toUpperCase(), n = 1; while (seen.has(s)) s = `${b.short.slice(0, 8).toUpperCase()}${n++}`; seen.add(s); b.short = s; });
      if (res.mode === "area") weigh(res, bands);
      job = { o, res, bands, series, ids, units, wxCells: ctx.wxCells };
      stats();
      $("#gBand").innerHTML = bands.map((b, i) => `<option value="${i}">${esc(b.label)}${b.unit ? ` (${esc(b.unit)})` : ""}</option>`).join("");
      $("#gBand").value = bands.length > 1 ? "1" : "0";
      $("#gPvSec").hidden = false;
      preview();
      $("#gPvSec").scrollIntoView({ behavior: "smooth", block: "start" });
      const c = res.cover, left = [2, 3, 4, 5].filter(k => c[k]).map(k => `${COVER[k]} ${c[k].toLocaleString()}`).join(", ");
      status(`${res.count.toLocaleString()} cells, ${bands.length} columns${left ? `; ${left}` : ""}. Nothing is saved yet.`);
      $("#gSave").disabled = false;
    } catch (e) {
      console.error(e);
      job = null;
      status(`Could not build it: ${e.message || e}.`);
    }
    busy = false;
    $("#gBuild").disabled = false;
  }
  /* one cell's value: index in the window for lattice cells, or place in the list */
  const valueAt = (J, b, k) => {
    const r = J.res;
    if (r.mode === "centre") return b.lut[(b.by === "soil" ? r.soilIdx : b.by === "wx" ? r.wxIdx : r.mask)[k]];
    const n = r.at ? r.at[k] : k + 1;
    if (!n) return NO;
    return b.by === "mask" ? r.covers[n - 1] || NO : b.vals[n - 1];
  };
  function stats() {
    const { res, bands } = job;
    const rows = bands.map(b => {
      let lo = Infinity, hi = -Infinity, s = 0, c = 0;
      if (res.mode === "centre") {
        const N = b.by === "soil" ? res.sN : b.by === "wx" ? res.wN : res.cover;
        b.lut.forEach((v, a) => { if (v !== NO && N[a]) { if (v < lo) lo = v; if (v > hi) hi = v; s += v * N[a]; c += N[a]; } });
      } else if (b.vals) {
        b.vals.forEach(v => { if (v !== NO) { if (v < lo) lo = v; if (v > hi) hi = v; s += v; c++; } });
      } else res.covers.forEach(v => { if (v) { if (v < lo) lo = v; if (v > hi) hi = v; s += v; c++; } });
      b.lo = lo; b.hi = hi;
      const f = v => (c ? fmt(v, Math.abs(v) >= 100 ? 1 : 2) : "–");
      return `<tr><td>${esc(b.name)}</td><td class="l">${esc(b.label)}</td><td>${esc(b.unit)}</td><td>${b.cat ? "–" : f(lo)}</td><td>${b.cat ? "–" : f(s / (c || 1))}</td><td>${b.cat ? "–" : f(hi)}</td><td>${c.toLocaleString()}</td></tr>`;
    });
    $("#gStats").innerHTML = `<thead><tr><th>Column</th><th class="l">What it holds</th><th>Unit</th><th>Lowest</th><th>Mean</th><th>Highest</th><th>Cells with a value</th></tr></thead><tbody>${rows.join("")}</tbody>`;
  }

  /* ---------- preview ---------- */
  const RAMP = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
  const CATS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac", "#86bc86", "#d4a6c8"];
  const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  function preview() {
    if (!job) return;
    const b = job.bands[+$("#gBand").value], c = $("#gCanvas"), { res } = job, { P, L, W } = res;
    const w = Math.max(240, Math.min(c.parentElement.clientWidth - 2, 860)), rings = res.S.rings.flat(), bb = A.bboxOf(rings), ar = (bb[3] - bb[1]) / Math.max(bb[2] - bb[0], 1), h = Math.max(160, Math.min(480, Math.round(w * ar)));
    const ratio = window.devicePixelRatio || 1, pw = Math.round(w * ratio), ph = Math.round(h * ratio);
    c.width = pw; c.height = ph; c.style.width = `${w}px`; c.style.height = `${h}px`;
    const x = c.getContext("2d"), sc = Math.max((bb[2] - bb[0]) / pw, (bb[3] - bb[1]) / ph) * 1.02, cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    const toE = px => cx + (px - pw / 2) * sc, toN = py => cy - (py - ph / 2) * sc, toPx = (E, N) => [pw / 2 + (E - cx) / sc, ph / 2 - (N - cy) / sc];
    // the colour of a value
    const cats = new Map();
    const colour = v => {
      if (b.cat) { if (!cats.has(v)) cats.set(v, hexRgb(CATS[cats.size % CATS.length])); return cats.get(v); }
      const t = b.hi > b.lo ? Math.min(1, Math.max(0, (v - b.lo) / (b.hi - b.lo))) : 0.5, s = t * (RAMP.length - 1), a = Math.min(RAMP.length - 2, Math.floor(s)), f = s - a;
      return RAMP[a].map((q, i) => q + (RAMP[a + 1][i] - q) * f);
    };
    x.clearRect(0, 0, pw, ph);
    if (L) {
      const img = x.createImageData(pw, ph), d = img.data, cols = W.cols;
      for (let py = 0; py < ph; py++) for (let px = 0; px < pw; px++) {
        const [u, vv] = L.toUV(toE(px + 0.5), toN(py + 0.5));
        let i, j;
        if (!L.hex) { i = Math.floor(u / L.du); j = Math.floor(vv / L.dv); } else {
          // the nearest centre of the three rows around
          let best = Infinity;
          const j0 = Math.round(vv / L.dv);
          for (let q = j0 - 1; q <= j0 + 1; q++) { const ii = Math.round(u / L.du - L.shift(q)), du = (ii + L.shift(q)) * L.du - u, dv = q * L.dv - vv, e = du * du + dv * dv; if (e < best) { best = e; i = ii; j = q; } }
        }
        if (i < W.i0 || i > W.i1 || j < W.j0 || j > W.j1) continue;
        const k = (W.j1 - j) * cols + i - W.i0;
        if (res.mode === "centre" ? !res.mask[k] : !res.at[k]) continue;
        const v = valueAt(job, b, k);
        const q = (py * pw + px) * 4;
        if (v === NO) { d[q] = d[q + 1] = d[q + 2] = 222; d[q + 3] = 255; continue; }
        const rgb = colour(v);
        d[q] = rgb[0]; d[q + 1] = rgb[1]; d[q + 2] = rgb[2]; d[q + 3] = 255;
      }
      x.putImageData(img, 0, 0);
      // the cells themselves, when they are large enough to see
      const cellPx = L.size / sc;
      if (cellPx >= 7 * ratio && res.count <= 6000) {
        x.strokeStyle = "rgba(255,255,255,.65)"; x.lineWidth = ratio * 0.6; x.beginPath();
        for (let j = W.j0; j <= W.j1; j++) for (let i = W.i0; i <= W.i1; i++) {
          const k = (W.j1 - j) * cols + i - W.i0;
          if (res.mode === "centre" ? !res.mask[k] : !res.at[k]) continue;
          L.ring(i, j).forEach(([E, N], t) => { const [a, bb2] = toPx(E, N); if (t) x.lineTo(a, bb2); else x.moveTo(a, bb2); });
        }
        x.stroke();
      }
    } else {
      res.list.forEach((cell, n) => {
        const v = b.by === "mask" ? res.covers[n] : b.vals[n], rgb = v === NO ? [222, 222, 222] : colour(v);
        x.fillStyle = `rgb(${rgb.map(Math.round).join(",")})`; x.strokeStyle = "rgba(255,255,255,.6)"; x.lineWidth = ratio * 0.5; x.beginPath();
        cell.rings.forEach(rg => rg.forEach(([E, N], t) => { const [a, bb2] = toPx(E, N); if (t) x.lineTo(a, bb2); else x.moveTo(a, bb2); }));
        x.fill("evenodd"); x.stroke();
      });
    }
    // the boundary
    x.strokeStyle = "#111"; x.lineWidth = 1.5 * ratio; x.beginPath();
    rings.forEach(r => r.forEach(([E, N], t) => { const [a, bb2] = toPx(E, N); if (t) x.lineTo(a, bb2); else x.moveTo(a, bb2); }));
    x.stroke();
    void P;
    const bar = RAMP.map(q => `rgb(${q.join(",")})`).join(",");
    const name = v => (b.by === "mask" ? COVER[v] : b.name === "weg" && v === 41 ? "4L" : fmt(v, 0));
    $("#gLegend").innerHTML = b.cat ? [...cats].slice(0, 24).map(([v, rgb]) => `<span><i style="background:rgb(${rgb.join(",")})"></i>${esc(name(v))}</span>`).join("") + (cats.size > 24 ? `<span>+${cats.size - 24} more</span>` : "")
      : `<span>${fmt(b.lo, 2)}</span><i class="grid-ramp" style="background:linear-gradient(90deg,${bar})"></i><span>${fmt(b.hi, 2)} ${esc(b.unit)}</span><span><i style="background:#dedede"></i>no value</span>`;
  }

  /* ---------- files ---------- */
  const NOTE = "Values are NoData (-9999) where the source has none.";
  function readme(J) {
    const { o, res, bands } = J, P = res.P, L = res.L, shapeTxt = { square: "square, north up", turned: `square, turned ${o.angle}° clockwise`, hex: `hexagons, points up${o.angle ? `, turned ${o.angle}°` : ""}`, hexflat: `hexagons, flat side up${o.angle ? `, turned ${o.angle}°` : ""}`, own: `your grid, ${own ? own.name : ""}` }[o.shape];
    const lines = [`WindGuard TX area grid: ${area.name}`, `Made ${new Date().toISOString().slice(0, 10)} with ${location.origin}${location.pathname}`, "",
      `Cells: ${res.count.toLocaleString()}, ${shapeTxt}${L ? `, size ${o.size} m (${fmt(L.area, L.area < 1 ? 3 : 1)} m2 each; a hexagon's size is its width across the flats)` : ""}.`,
      `Coordinates: ${P.name}.${L ? ` Origin of the lattice: ${L.ox}, ${L.oy}. Rows and columns are whole steps from it, so two grids of one size and origin line up.` : ""}`,
      o.rule === "area" || o.shape === "own" ? "A cell's value: weighted by what covers it, from 25 points in the cell's box; a code (map unit, group, weather cell) is the one covering the most." : "A cell's value: what lies at its centre. A cell is in the grid when its centre is inside the boundary.", "",
      "How much detail this holds: finer cells line up with other grids but add no information. The soil survey is mapped at 1:12,000 to 1:24,000 and each map unit mixes soils without showing where each one lies; the weather comes in cells of 4 km or more.", "",
      `Soil: USDA-NRCS SSURGO through Soil Data Access; within a map unit ${o.comp === "dominant" ? "the main soil that has the value" : "all its soils, weighted by their %"}. A layer below the end of a profile is left blank.`,
      area.result.ex ? "Buildings (FEMA/ORNL USA Structures), roads (Census TIGER, widened by road class) and water (USGS NHD, and SSURGO Water map units) are marked in the cover column, and such cells have no soil values." : "Buildings and roads were not marked; SSURGO Water map units are.",
      o.wx ? `Weather: ${WX_GRID[o.src].name}, ${o.from} to ${o.to}, values no station reports left out. Each grid cell gives the means of its weather cell (wx_cell); weather/cells.csv lists them${o.daily ? " and weather/ has their daily tables" : ""}.` : "Weather: not asked for.",
      "", NOTE, "bands.csv lists every column with its unit; soil_units.csv lists the map units.", "Files:", ...(o.files.includes("tif") ? ["  grid.tif: GeoTIFF, Float32, Deflate, one band per column, named as in bands.csv."] : []),
      ...(o.files.includes("shp") ? ["  cells.shp (.shx, .dbf, .prj, .cpg): one polygon per cell; field names are the short names in bands.csv."] : []),
      ...(o.files.includes("geojson") ? ["  cells.geojson: one polygon per cell, in longitude and latitude."] : []), ...(o.files.includes("csv") ? ["  cells.csv: one row per cell, with its centre."] : []),
      "", "Bands:", ...bands.map((b, i) => `  ${i + 1}. ${b.name} (${b.short}): ${b.label}${b.unit ? `, ${b.unit}` : ""}`)];
    return lines.join("\r\n") + "\r\n";
  }
  /* the cells of a polygon or table file, in order: where they are, and how to read a column */
  function cellList(J) {
    const r = J.res;
    if (r.mode === "area") return r.list.map((c, n) => ({ n, c, k: c.k }));
    const out = [], W = r.W;
    for (let k = 0; k < W.count; k++) if (r.mask[k]) { const row = Math.floor(k / W.cols); out.push({ k, i: W.i0 + (k - row * W.cols), j: W.j1 - row }); }
    return out;
  }
  async function save() {
    if (!job || busy) return;
    const J = job, { o, res, bands } = J, status = t => { $("#gStatus").textContent = t; }, files = [];
    busy = true;
    $("#gBuild").disabled = $("#gSave").disabled = true;
    try {
      const num4 = v => (v === NO ? "" : +v.toFixed(4));
      files.push({ name: "README.txt", text: readme(J) });
      files.push({ name: "bands.csv", text: X.csv(["Band", "Column", "Short name (shapefile)", "What it holds", "Unit"], bands.map((b, i) => [i + 1, b.name, b.short, b.label, b.unit])) });
      if (J.ids.length) files.push({ name: "soil_units.csv", text: X.csv(["mukey", "Symbol", "Map unit", "WEG of its main soil", "Climatic factor C", "Soils (% of the map unit)"], J.ids.map(k => { const u = J.units[k]; return [k, u.musym, u.muname, u.weg, u.C, (u.comps || []).map(c => `${c.name} ${c.pct}%`).join("; ")]; })) });
      if (o.wx) {
        const wxb = bands.filter(b => b.by === "wx");
        files.push({ name: "weather/cells.csv", text: X.csv(["wx_cell", "Longitude of its centre", "Latitude of its centre", "Source", ...wxb.slice(1).map(b => `${b.name}${b.unit ? ` (${b.unit})` : ""}`)], J.wxCells.map((c, a) => [a + 1, +c.lon.toFixed(5), +c.lat.toFixed(5), WX_GRID[o.src].name, ...wxb.slice(1).map(b => num4(b.lut[a + 1]))])) });
        if (o.daily) J.series.forEach((w, a) => {
          const v = (q, x) => (ok(x) ? +(q ? UN.conv(q, x) : x).toFixed(2) : "");
          files.push({ name: `weather/daily_cell_${String(a + 1).padStart(3, "0")}.csv`, text: X.csv(["Date", `Rain (${UN.sym("precip")})`, `Tmax (${UN.sym("temp")})`, `Tmin (${UN.sym("temp")})`, `Solar radiation (${UN.sym("solar")})`, "Relative humidity (%)", `Wind at 10 m (${UN.sym("wind")})`, `Grass ET0 (${UN.sym("precip")})`],
            w.days.map((d, i) => [Wd.isoDay(d), v("precip", w.prcp[i]), v("temp", w.tmax[i]), v("temp", w.tmin[i]), v("solar", w.srad[i]), v(null, w.rh[i]), v("wind", w.wind10[i]), v("precip", w.et0 && w.et0[i])])) });
        });
      }
      const L = res.L, W = res.W, P = res.P;
      if (o.files.includes("tif") && L && !L.hex) {
        status("Writing the GeoTIFF: 0%");
        const [x0, y0] = L.fromUV(W.i0 * L.du, (W.j1 + 1) * L.dv);
        const arrays = bands.map(b => (res.mode === "centre" ? (b.by === "soil" ? res.soilIdx : b.by === "wx" ? res.wxIdx : res.mask) : null));
        const blob = await G.geotiff({ width: W.cols, height: W.rows, names: bands.map(b => b.name), epsg: P.epsg, x0, y0, size: L.size, angle: L.angle,
          progress: f => status(`Writing the GeoTIFF: ${Math.round(f * 100)}%`),
          fill(n, row, out) {
            const b = bands[n], s = row * W.cols;
            if (arrays[n]) { const a = arrays[n], lut = b.lut; for (let c = 0; c < W.cols; c++) out[c] = lut[a[s + c]]; } else for (let c = 0; c < W.cols; c++) out[c] = valueAt(J, b, s + c);
          } });
        files.push({ name: "grid.tif", blob });
      }
      const wantPoly = o.files.includes("shp") || o.files.includes("geojson") || o.files.includes("csv");
      if (wantPoly) {
        status("Writing the cells…");
        await breathe();
        const list = cellList(J), own2 = res.mode === "area" && !L;
        const ringsOf = c => (own2 ? c.c.rings : [L.ring(c.i ?? c.c.i, c.j ?? c.c.j)]);
        const val = (c, b) => { const v = own2 ? (b.by === "mask" ? res.covers[c.n] : b.vals[c.n]) : valueAt(J, b, c.k); return v === NO || v === 0 && b.by === "mask" ? null : v; };
        const centre = c => { if (own2) return [c.c.cx, c.c.cy]; return L.centre(c.i ?? c.c.i, c.j ?? c.c.j); };
        const ownId = c => { const p = c.c && c.c.props; if (!p) return null; const key = Object.keys(p).find(x => /^(id|cell|grid_?id|gid|fid|objectid)$/i.test(x)) || Object.keys(p)[0]; return key ? p[key] : null; };
        if (o.files.includes("shp")) {
          if (bands.length > MAX.fields) throw new Error(`A shapefile holds ${MAX.fields} columns at most, and this has ${bands.length}`);
          const fields = [{ name: "CELL", type: "N", width: 10, dec: 0 }, ...(own2 ? [{ name: "OWN_ID", type: "C", width: 30 }] : [{ name: "COL", type: "N", width: 9, dec: 0 }, { name: "ROW", type: "N", width: 9, dec: 0 }]),
            ...bands.map(b => ({ name: b.short, type: "N", width: b.cat ? 10 : 14, dec: b.cat ? 0 : 4, band: b }))];
          const value = (n, f) => { const c = list[n]; if (f.name === "CELL") return n + 1; if (f.name === "OWN_ID") return ownId(c); if (f.name === "COL") return c.i ?? c.c.i; if (f.name === "ROW") return c.j ?? c.c.j; return val(c, f.band); };
          G.shapefile("cells", list.length, n => ringsOf(list[n]), fields, value, P.prj).forEach(f => files.push(f));
        }
        if (o.files.includes("geojson")) {
          const blob = G.geojson(list.length, n => ringsOf(list[n]).map(r => r.map(([E, N]) => P.inv(E, N))), n => {
            const c = list[n], q = { cell: n + 1 };
            if (own2) { const id = ownId(c); if (id !== null) q.own_id = id; }
            bands.forEach(b => { const v = val(c, b); q[b.name] = v === null ? null : +v.toFixed(4); });
            return q;
          });
          files.push({ name: "cells.geojson", blob });
        }
        if (o.files.includes("csv")) {
          const parts = [`﻿${["cell", own2 ? "own_id" : "col", ...(own2 ? [] : ["row"]), "x", "y", "lon", "lat", ...bands.map(b => b.name)].join(",")}\r\n`];
          list.forEach((c, n) => {
            const [E, N] = centre(c), [lon, lat] = P.inv(E, N);
            parts.push(`${[n + 1, own2 ? JSON.stringify(ownId(c) ?? "") : c.i ?? c.c.i, ...(own2 ? [] : [c.j ?? c.c.j]), +E.toFixed(3), +N.toFixed(3), +lon.toFixed(7), +lat.toFixed(7), ...bands.map(b => { const v = val(c, b); return v === null ? "" : +v.toFixed(4); })].join(",")}\r\n`);
          });
          files.push({ name: "cells.csv", blob: new Blob(parts, { type: "text/csv" }) });
        }
      }
      status("Packing…");
      const zip = await M.zip(files);
      X.save(zip, `WindGuard_grid_${short(area.name, 30)}_${o.shape === "own" ? "own" : `${o.size}m_${o.shape}`}.zip`, "application/zip");
      const sized = zip.size >= 1e6 ? `${fmt(zip.size / 1e6, 1)} MB` : `${fmt(zip.size / 1e3, 0)} kB`;
      status(`Saved: ${files.length} files, ${sized}.`);
    } catch (e) {
      console.error(e);
      status(`Could not make the files: ${e.message || e}.`);
    }
    busy = false;
    $("#gBuild").disabled = false;
    $("#gSave").disabled = !job;
  }
  return { open };
})();
