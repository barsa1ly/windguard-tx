/* Model-ready soil and weather files for one location. Every writer takes the same two structures:
   soil    { id, name, source, lat, lon, elev, slope, hydgrp, drainage, albedo, u, drainRate, cn, texture, family,
             layers: [{ top, bot (cm), sand, silt, clay, om, oc (%), bd (g/cm³), ll, dul, sat (cm³/cm³), awc (cm/cm),
                        ksat (mm/h), ph, cec (cmol/kg), caco3 (%), cfWt, cfVol (%), ec (dS/m), kw, srgf, ni (%) }] }
   weather { source, lat, lon, elev, days (epoch days), prcp (mm), tmax, tmin (°C), srad (MJ/m²/d), rh, rhmax,
             rhmin (%), tdew (°C), vp (kPa), wind10, wind2 (m/s), et0 (mm) }; weather read from a user's file also has
             columns { quantity: the header it was read from } and notes [what was read in a way worth saying]
   Writers return [{ name, text }]; the data sheet zips them with a README. Model files always use each model's
   own units, whatever the display units are. */
WG.models = (function () {
  const { num } = WG.util;
  const S = WG.soil, Wd = WG.wind;
  const r = (v, d) => (v === null || v === undefined || !Number.isFinite(v) ? null : +v.toFixed(d));

  /* ---------- soil ---------- */
  const fragVol = (w, bd) => (w === null || w <= 0 ? 0 : (100 * w / 2.65) / (w / 2.65 + (100 - w) / (bd || 1.45)));
  /* the survey's component (dominant unless cokey) as the common soil structure */
  function surveySoil(state, cokey) {
    const s = state.soil;
    if (!s || s.error || !s.dominant) return null;
    const comp = (cokey && s.components.find(c => String(c.cokey) === String(cokey))) || s.dominant;
    const isDom = comp === s.dominant, surf = isDom ? WG.currentSurface() : null;
    const edits = isDom && state.edits ? { sand: surf.sand, silt: surf.silt, clay: surf.clay, om: surf.om, ph: surf.ph, caco3: surf.caco3 } : null;
    const layers = S.profileLayers(comp, edits), site = S.siteParams(s, comp, isDom ? surf : null);
    const e = state.elev;
    return {
      id: `${s.mukey}`, mukey: s.mukey, cokey: comp.cokey, name: comp.compname, source: `USDA-NRCS SSURGO map unit ${s.mukey} (${s.mapunit.areasymbol || ""}), component ${comp.compname} ${comp.comppct_r}%${edits ? ", surface edited" : ""}`,
      edited: !!edits, lat: state.site.lat, lon: state.site.lon, elev: e ? e.z : num(comp.elev_r), slope: site.slope, hydgrp: site.hydgrp, drainage: site.drainage,
      albedo: site.albedo, u: site.u, drainRate: site.drainRate, cn: site.cn, depth: site.depth, texture: layers[0] ? layers[0].texture : "",
      family: comp.taxclname || "", order: comp.taxorder || "", tfact: site.tfact,
      layers: layers.map((l, i) => {
        const h = comp.horizons[i] || {}, fv = num(h.fragvoltot_r);
        // > 2 mm by weight of the whole soil: cobbles and stones (frag3to10, fraggt10) plus the gravel the No. 10 sieve holds back
        const big = (num(h.frag3to10_r) ?? 0) + (num(h.fraggt10_r) ?? 0), pass = num(h.sieveno10_r);
        const cfWt = pass === null ? big : Math.min(100, big + (100 - big) * Math.max(0, 100 - pass) / 100);
        return { top: l.top, bot: l.bot, hz: l.hz, texture: l.texture, sand: l.sand, silt: l.silt, clay: l.clay, om: l.om, oc: l.oc, bd: l.bd,
          ll: l.ll, dul: l.dul, sat: l.sat, awc: l.awc, ksat: l.ksat === null ? null : l.ksat * 10, ph: l.ph, cec: l.cec, caco3: l.caco3,
          cfWt: r(cfWt, 1), cfVol: fv !== null ? fv : r(fragVol(cfWt, l.bd), 1), ec: l.ec, kw: l.kw, kf: num(h.kffact), srgf: l.srgf, ni: l.ni, sar: l.sar,
          noBd: num(h.dbthirdbar_r) === null && !(edits && i === 0) };
      }),
    };
  }
  /* rows the user typed (or uploaded): missing water retention, bulk density and Ksat from Saxton & Rawls (2006).
     Water contents are for the whole soil, as the survey gives them; Saxton & Rawls estimates are for the fine earth,
     so they are scaled by the share of fine earth when coarse fragments are given. A blank top is the bottom of the
     layer above. Curve number and drainage rate follow the hydrologic group, slope and drainage class, as for the survey. */
  function userSoil(rows, site) {
    const R = rows.filter(x => num(x.bot) !== null && num(x.sand) !== null && num(x.clay) !== null).sort((a, b) => num(a.bot) - num(b.bot));
    const over = R.find(x => num(x.sand) + num(x.clay) > 101 || num(x.sand) < 0 || num(x.clay) < 0);
    if (over) throw new Error(`The layer down to ${num(over.bot)} cm has sand ${num(over.sand)} % and clay ${num(over.clay)} %: they must be in percent and add up to at most 100.`);
    const layers = R.map((x, i) => {
      const top = num(x.top) ?? (i ? num(R[i - 1].bot) : 0), bot = num(x.bot);
      const sand = num(x.sand), clay = num(x.clay), silt = num(x.silt) ?? Math.max(0, 100 - sand - clay);
      const om = num(x.om) ?? (num(x.oc) !== null ? num(x.oc) * 1.724 : 1);
      const sr = S.saxtonRawls(sand, clay, om) || {}, cfVol = num(x.cfVol) ?? 0, fine = 1 - Math.min(cfVol, 90) / 100;
      // an estimate that is not a finite number counts as missing
      const sv = k => (Number.isFinite(sr[k]) ? sr[k] : null), est = k => (sv(k) === null ? null : sv(k) * fine);
      const bd = num(x.bd) ?? sv("bd"), ll = num(x.ll) ?? est("ll"), dul = num(x.dul) ?? est("dul");
      let sat = num(x.sat) ?? est("sat") ?? (bd ? 1 - bd / 2.65 : null);
      if (sat !== null && dul !== null) sat = Math.max(sat, dul + 0.01);
      const mid = (top + bot) / 2;
      return { top, bot, hz: x.hz || "", sand, silt, clay, om, oc: om / 1.724, bd, ll, dul, sat,
        awc: dul !== null && ll !== null ? dul - ll : null, ksat: num(x.ksat) ?? sv("ksat"), ph: num(x.ph), cec: num(x.cec),
        caco3: num(x.caco3) ?? 0, cfVol, cfWt: cfVol && bd ? r((100 * cfVol * 2.65) / (cfVol * 2.65 + (100 - cfVol) * bd), 1) : 0,
        ec: num(x.ec), kw: num(x.kw), srgf: bot <= 15 ? 1 : Math.exp(-0.02 * mid), ni: Math.min(om / 1.724 / 10, 0.5), sar: null };
    });
    const slope = num(site.slope) ?? 1, hydgrp = site.hydgrp || "B", drainage = site.drainage || "Well drained", l0 = layers[0];
    return { id: site.id || "USER", name: site.name || "My soil", source: "entered by the user" + (site.note ? ` (${site.note})` : ""),
      lat: site.lat, lon: site.lon, elev: num(site.elev), slope, hydgrp, drainage, albedo: num(site.albedo) ?? 0.13,
      u: num(site.u) ?? S.slu1(l0 && S.textureClass(l0.sand, l0.silt, l0.clay)),
      // soil.js's rate for the drainage class (well drained 0.6 /day)
      drainRate: num(site.drainRate) ?? S.DRAIN?.[drainage.toLowerCase()] ?? 0.6, cn: num(site.cn) ?? S.curveNumber(hydgrp, slope),
      depth: layers.length ? layers[layers.length - 1].bot : null, texture: site.texture || "", family: site.family || "", order: "", tfact: null, layers };
  }
  /* ---------- layers on chosen depths ---------- */
  const NUM_KEYS = ["sand", "silt", "clay", "om", "oc", "bd", "ll", "dul", "sat", "awc", "ksat", "ph", "cec", "caco3", "cfWt", "cfVol", "ec", "kw", "kf", "ni", "sar"];
  const fin = v => v !== null && v !== undefined && Number.isFinite(v);
  /* layers with the given bottoms (cm) from horizons H: each takes the thickness-weighted mean of the horizons it
     overlaps (harmonic mean for Ksat) and the name list, texture and flags of the thickest; a layer that overlaps no
     horizon takes the nearest one and is marked extended */
  function relayerLayers(H, bottoms, top0 = 0) {
    const B = [...new Set(bottoms.filter(v => Number.isFinite(v) && v > top0))].sort((a, b) => a - b), out = [];
    let top = top0;
    for (const bot of B) {
      const mid = (top + bot) / 2;
      let parts = H.map(h => ({ h, w: Math.min(bot, h.bot) - Math.max(top, h.top) })).filter(p => p.w > 1e-9);
      const extended = !parts.length;
      if (extended) parts = [{ h: H.reduce((a, h) => (Math.abs((h.top + h.bot) / 2 - mid) < Math.abs((a.top + a.bot) / 2 - mid) ? h : a)), w: bot - top }];
      const dom = parts.reduce((a, p) => (p.w > a.w ? p : a)).h;
      const l = { ...dom, top, bot, hz: [...new Set(parts.map(p => p.h.hz).filter(Boolean))].join("+"), extended };
      NUM_KEYS.forEach(k => {
        const P = parts.filter(p => fin(p.h[k])), w = P.reduce((a, p) => a + p.w, 0);
        l[k] = !P.length ? null : k === "ksat" ? w / P.reduce((a, p) => a + p.w / Math.max(p.h[k], 1e-6), 0) : P.reduce((a, p) => a + p.h[k] * p.w, 0) / w;
      });
      l.srgf = dom.srgf === 0 ? 0 : bot <= 15 ? 1 : Math.exp(-0.02 * mid);
      out.push(l);
      top = bot;
    }
    return out;
  }
  /* the soil on the user's layer bottoms (cm). The profile ends at the first horizon without water retention or bulk
     density (bedrock, a cemented pan), so deeper bottoms are cut there; a profile that simply stops is extended with
     its deepest horizon. */
  function relayer(soil, bottoms) {
    const all = soil.layers.filter(l => fin(l.top) && fin(l.bot) && l.bot > l.top).sort((a, b) => a.top - b.top);
    const H = [];
    for (const l of all) { if (fin(l.ll) && fin(l.dul) && fin(l.bd)) H.push(l); else if (H.length) break; }
    const B = [...new Set(bottoms.filter(v => Number.isFinite(v) && v > 0))].sort((a, b) => a - b);
    const info = { asked: B, cut: null, extendedBelow: null };
    if (!H.length || !B.length) return { ...soil, layers: [], layering: "custom", relayer: info };
    const deepest = H[H.length - 1].bot, blocked = all.indexOf(H[H.length - 1]) < all.length - 1;
    let use = B;
    if (blocked && B[B.length - 1] > deepest) { use = B.filter(v => v < deepest).concat(deepest); info.cut = deepest; }
    const layers = relayerLayers(H, use, 0);
    if (!blocked && B[B.length - 1] > deepest) info.extendedBelow = deepest;
    return { ...soil, layers, depth: layers.length ? layers[layers.length - 1].bot : null, layering: "custom", relayer: info };
  }
  const SOIL_COLS = [["top", "Top (cm)"], ["bot", "Bottom (cm)"], ["sand", "Sand (%)"], ["silt", "Silt (%)"], ["clay", "Clay (%)"], ["om", "Organic matter (%)"],
    ["bd", "Bulk density (g/cm3)"], ["ll", "Wilting point (cm3/cm3)"], ["dul", "Field capacity (cm3/cm3)"], ["sat", "Saturation (cm3/cm3)"],
    ["ksat", "Ksat (mm/h)"], ["ph", "pH (1:1 water)"], ["cec", "CEC (cmol/kg)"], ["caco3", "CaCO3 (%)"], ["cfVol", "Coarse fragments (% volume)"], ["ec", "EC (dS/m)"]];
  const soilTemplateCSV = soil => WG.export.csv(SOIL_COLS.map(c => c[1]), (soil ? soil.layers : [{ top: 0, bot: 15 }, { top: 15, bot: 30 }])
    .map(l => SOIL_COLS.map(([k]) => (l[k] === null || l[k] === undefined ? "" : typeof l[k] === "number" ? +l[k].toFixed(k === "ll" || k === "dul" || k === "sat" ? 3 : 2) : l[k]))));
  // a column header in lower case and in words ("TmaxF" reads "tmax f", "ObsDate" "obs date"), without its units and notes in brackets
  const colName = h => h.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[([].*?[)\]]/g, " ").replace(/[^a-z0-9.]+|\.(?!\d)/g, " ").replace(/\s+/g, " ").trim();
  const inBrackets = h => (h.match(/[([].*?[)\]]/g) || []).join(" ").toLowerCase();
  /* each soil column by name: the words of the header before any bracket, run together without those that say nothing
     (units, "total", "soil" ...), must be one of these. So "Sand_pct", "Total sand" and "SandPct" are sand, but "Fine
     sand" and "Sandy" are not; "Sat. paste EC" is EC, not saturation, and "Base saturation", "Phosphorus" and "ECEC" are
     none of them. "LL" is the lower limit only next to a DUL column; elsewhere it is the liquid limit (SSURGO ll_r). */
  const SOIL_DROP = /^(total|tot|pct|percent|perc|per|cent|cm|mm|in|inch|inches|ft|m|g|kg|cm3|m3|mg|cmol|meq|d|s|h|hr|um|ds|of|the|at|by|r|rv|soil|horizon|layer|avg|mean|average|value|val|content|weight|wt|dry|lab|measured|basis|whole|volume|vol|water|retention)$/;
  const soilKey = h => {
    const k = colName((h.split(/[([]/)[0] || h).replace(/pH/g, "ph")).split(" ").filter(w => !SOIL_DROP.test(w)).join("").replace(/\./g, "");
    return k.replace(/(pct|percent|perc|cm|mm)$/, "") || k;
  };
  const SOIL_NAMES = {
    top: ["top", "topdepth", "depthtop", "upper", "upperdepth", "depthupper", "upperboundary", "from", "depthfrom", "hzdept"],
    bot: ["bottom", "bot", "bottomdepth", "depthbottom", "lower", "lowerdepth", "depthlower", "lowerboundary", "to", "depthto", "hzdepb"],
    sand: ["sand", "sandtotal"], silt: ["silt", "silttotal"], clay: ["clay", "claytotal"],
    om: ["organicmatter", "om", "som"], oc: ["organiccarbon", "oc", "soc", "orgc"], bd: ["bulkdensity", "bd", "db", "sbdm", "dbthirdbar", "rhob"],
    ll: ["wiltingpoint", "wp", "pwp", "permanentwiltingpoint", "lowerlimit", "slll", "ll15", "15bar", "1500kpa", "wfifteenbar"],
    dul: ["fieldcapacity", "fc", "dul", "sdul", "drainedupperlimit", "13bar", "033bar", "33kpa", "wthirdbar"],
    sat: ["saturation", "saturated", "sat", "ssat", "thetas", "wsatiated"],
    ksat: ["ksat", "ks", "ssks", "saturatedhydraulicconductivity", "sathydraulicconductivity", "hydraulicconductivity"],
    ph: ["ph", "phw", "phwater", "phh2o", "ph11", "ph12", "ph15", "ph1to1", "ph1to1h2o"], cec: ["cec", "cec7", "cecph7", "cationexchangecapacity"],
    caco3: ["caco3", "caco3e", "caco3eq", "caco3equiv", "caco3equivalent", "calciumcarbonate", "calciumcarbonateequivalent", "cce", "carbonate", "carbonates"],
    cfVol: ["coarsefragments", "coarsefragment", "rockfragments", "rockfragment", "fragments", "gravel", "cf", "fragvoltot"],
    ec: ["ec", "ece", "ecse", "ecsat", "ec11", "ec12", "ec15", "electricalconductivity", "satpasteec", "satextec", "ecsatpaste"],
  };
  // other measurements under the same name, by the whole header: pH in CaCl2, fragments by weight
  const SOIL_NOT = { ph: /cacl|kcl|naf|buffer|smp|bph/, cfVol: /weight|\bwt\b|mass/, sat: /\bpercent|\bbase\b/ };
  // [column, unit in the header, factor to the column's own unit]: lab tables say cm/h, g/kg, inches ...
  const MASS = [[/g ?\/ ?kg/, 0.1]], SOIL_UNITS = { top: [[/\bmm\b/, 0.1], [/\b(in|inch|inches)\b/, 2.54], [/\b(ft|feet)\b/, 30.48], [/\bm\b/, 100]],
    sand: MASS, silt: MASS, clay: MASS, om: MASS, oc: MASS, caco3: MASS, bd: [[/kg ?\/ ?m/, 0.001]],
    ksat: [[/cm ?\/ ?(h|hr)\b/, 10], [/cm ?\/ ?d/, 10 / 24], [/mm ?\/ ?d/, 1 / 24], [/\bm ?\/ ?d/, 1000 / 24], [/(um|µm|μm) ?\/ ?s/, 3.6], [/\bin(ch|ches)? ?\/ ?(h|hr)\b/, 25.4], [/\bin(ch|ches)? ?\/ ?d/, 25.4 / 24], [/\bm ?\/ ?s/, 3.6e6]],
    ec: [[/(us|µs|μs) ?\/ ?cm/, 0.001], [/\bms ?\/ ?m\b/, 0.01]] };
  SOIL_UNITS.bot = SOIL_UNITS.top;
  /* rows of strings or numbers in the units of the editor; rows.notes says what was read in a way worth saying */
  function parseSoilCSV(text) {
    const rows = csvRows(text);
    if (rows.length < 2) throw new Error("The soil file needs a header row and at least one layer.");
    const needed = keys => ["bot", "sand", "clay"].every(k => keys.some(x => SOIL_NAMES[k].includes(x)));
    const hi = Math.max(0, rows.slice(0, 30).findIndex(x => needed(x.map(soilKey)))), head = rows[hi], keys = head.map(soilKey), low = head.map(h => h.toLowerCase().replace(/_/g, " "));
    const idx = {}, taken = new Set(), find = (k, names) => keys.findIndex((x, i) => names.includes(x) && !taken.has(i) && !(SOIL_NOT[k] && SOIL_NOT[k].test(low[i])));
    Object.keys(SOIL_NAMES).forEach(k => { idx[k] = find(k, SOIL_NAMES[k]); if (idx[k] >= 0) taken.add(idx[k]); });
    if (idx.ll < 0 && keys.some(x => x === "dul" || x === "sdul")) { idx.ll = find("ll", ["ll"]); if (idx.ll >= 0) taken.add(idx.ll); }
    if (idx.bot < 0 || idx.sand < 0 || idx.clay < 0) throw new Error("Columns needed: Bottom (cm), Sand (%), Clay (%) — download the template to see the layout.");
    const body = rows.slice(hi + 1).filter(x => x.some(c => c.trim() !== "")), notes = [];
    const col = k => (idx[k] < 0 ? [] : body.map(x => num(x[idx[k]])).filter(v => v !== null));
    const factor = k => {
      if (idx[k] < 0) return 1;
      if (k === "ksat" && /^ksat r$/.test(low[idx[k]])) return 3.6; // SSURGO's ksat_r is in micrometres per second
      return ((SOIL_UNITS[k] || []).find(([re]) => re.test(low[idx[k]])) || [0, 1])[1];
    };
    const f = Object.fromEntries(Object.keys(SOIL_NAMES).map(k => [k, factor(k)]));
    // water contents above 1 can only be percent; sand and clay of at most 1 can only be fractions
    ["ll", "dul", "sat"].forEach(k => { if (col(k).some(v => v > 1)) { f[k] = 0.01; notes.push(`${head[idx[k]]} is above 1, so it was read as percent and divided by 100.`); } });
    const ss = col("sand").concat(col("clay"));
    if (ss.length && ss.every(v => v <= 1) && ss.some(v => v > 0)) ["sand", "silt", "clay"].forEach(k => { if (f[k] === 1) f[k] = 100; }), notes.push("Sand and clay are all 1 or less, so they were read as fractions and multiplied by 100.");
    Object.keys(f).forEach(k => { if (f[k] !== 1 && !["ll", "dul", "sat"].includes(k) && !(f[k] === 100 && ["sand", "silt", "clay"].includes(k))) notes.push(`${head[idx[k]]} was converted from the unit in its header.`); });
    const out = body.map((x, r) => {
      const v = k => { const c = idx[k] >= 0 ? x[idx[k]] ?? "" : "", n = num(c); return n === null || f[k] === 1 ? c : +(n * f[k]).toFixed(6); };
      const row = Object.fromEntries(SOIL_COLS.map(([k]) => [k, v(k)]));
      const oc = num(v("oc"));
      if (num(row.om) === null && oc !== null) row.om = +(oc * 1.724).toFixed(3);
      const sa = num(row.sand), cl = num(row.clay);
      if (sa !== null && cl !== null && (sa < 0 || cl < 0 || sa + cl > 101)) throw new Error(`Layer ${r + 1}: sand ${sa} % and clay ${cl} % do not fit. Give them in percent, or say g/kg in the header.`);
      return row;
    });
    if (idx.om < 0 && idx.oc >= 0) notes.push(`Organic matter comes from ${head[idx.oc]}, × 1.724.`);
    const unused = head.filter((h, i) => h && !taken.has(i));
    if (unused.length) notes.push(`Not used: ${unused.join(", ")}.`);
    out.notes = notes;
    return out;
  }

  /* ---------- weather from a file ---------- */
  /* durations in a header: a day's says nothing ("Precip 24 Hour Total" is the day's rain); a shorter one makes the
     column a second choice ("Rain_60min" gives way to "Rain") */
  const DAY_SPAN = /\b(24 ?(hours?|hrs?|h)|hrs? ?24|1 ?days?|1 ?d|1440 ?(minutes?|mins?))\b/g, SHORT_SPAN = /\b\d+ ?(minutes?|mins?|hours?|hrs?|h)\b/g;
  /* a header's name for matching, with a lone extreme or mean in brackets kept ("Temp (max)", but not "Wind (min 0.5 m/s)") */
  const wxName = h => {
    const m = h.match(/[([]\s*(max|maximum|high|min|minimum|low|mean|avg|average)\s*[,;)\]]/i);
    return `${colName(h)}${m ? ` ${m[1].toLowerCase()}` : ""}`.trim().replace(DAY_SPAN, " ").replace(/\s+/g, " ").trim();
  };
  const WX_ALIASES = {
    year: ["year", "yr", "yyyy"], doy: ["doy", "jday", "julian", "julian day", "jul", "yday", "dayofyear", "day of year"], month: ["month", "mo", "mon", "mm"], dom: ["dom", "dd", "dy", "day of month"],
    prcp: ["prcp", "precip", "precipitation", "prec", "rain", "rainfall", "ppt", "pcp", "pr", "pp", "tp"],
    tmax: ["tmax", "tmx", "tx", "tx2m", "mx", "mx2t", "high", "hi", "max temp", "maximum temperature", "t max", "maxt", "max t", "t2m max"],
    tmin: ["tmin", "tmn", "tn", "tn2m", "mn", "mn2t", "low", "lo", "min temp", "minimum temperature", "t min", "mint", "min t", "t2m min"],
    srad: ["srad", "solar", "radiation", "rs", "rad", "slr", "radn", "sr", "ssrd", "atot", "allsky sfc sw dwn"],
    rh: ["rh", "rhum", "r h", "rel hum", "relative humidity", "humidity", "rhmean", "rh mean", "rh2m", "havg"], rhmax: ["rhmax", "rh max", "max rh", "hmax"], rhmin: ["rhmin", "rh min", "min rh", "hmin"],
    tdew: ["tdew", "dewpoint", "dew point", "dewp", "dew pt", "td", "tdp", "t2mdew", "d2m"],
    wind: ["wind", "wind speed", "ws", "u", "u2", "u10", "u2m", "windspeed", "wnd", "wspd", "awnd", "ua", "ws2m", "ws10m"],
    et0: ["et0", "eto", "etos", "et o", "et 0", "reference et", "ref et", "refet"],
  };
  // a word of each list anywhere in the name, in either order
  const both = (a, b) => new RegExp(`\\b(${a})\\b.*\\b(${b})\\b|\\b(${b})\\b.*\\b(${a})\\b`);
  const HI = "max|maximum|mx|high|highest|hi", LO = "min|minimum|mn|low|lowest|lo", AIR = "t|ta|tc|tf|temp|temps|temperature|tmp|air|airt|airtc|airtf|airtemp|tair|t2m|t2";
  const HUM = "rh|rhum|hum|humid|humidity", WIND = "wind|wnd|ws|wspd|windspd|windspeed|speed|ws2m|ws10m", MEAN = "avg|mean|average|ave";
  /* the patterns of a quantity, on the name: "AirTC_Max" and "Max T" are Tmax, also run together ("TmaxF", "MaxT2m") */
  const WX_PAT = {
    prcp: [/\brain|prec(ip|tot)|\bprcp|\bppt|\bpcp|\bp daily\b/], srad: [/\brad|\bsrad|solar|\bslr|short ?wave|\bsw\b|irradiance|pyrano|\bmj\b/],
    tmax: [both(AIR, HI), /\bt(a|air|2m|2)?(max|mx)|\b(max(imum)?|mx)(2m?)?(t|ta|tair|airt|air|temp|temperature|tmp)(f|c|2m|2)?\b|\b(hi|high)(temp|tmp|air)/],
    tmin: [both(AIR, LO), /\bt(a|air|2m|2)?(min(?!ute)|mn)|\b(min(imum)?|mn)(2m?)?(t|ta|tair|airt|air|temp|temperature|tmp)(f|c|2m|2)?\b|\b(lo|low)(temp|tmp|air)/],
    tdew: [/dew|\btdp?\b/], rhmax: [both(HUM, HI), /\brh ?max|\bmax ?rh/], rhmin: [both(HUM, LO), /\brh ?min|\bmin ?rh/], rh: [/\brh|humid|\brel ?hum|\bhum\b/],
    wind: [/\bwind|\bwnd\b|\bws(\d|\b)|\bwsd\b|\bwsp|\bu2\b|\bu10\b|\bu2m\b|\bawnd\b/, both(WIND, MEAN)],
    et0: [/\bet ?(0|o|os)\b|\bet0|\beto\b|\betos\b|\bref(erence)?\b.*\b(et|evapotranspiration)\b|\bgrass ref/],
  };
  const MEAN_WIND = both(WIND, MEAN);
  /* other measurements under those words, by the name (not by notes in brackets, as "Tmax (data logger)" and "Rain (since
     9 am)" are fine): battery, panel, soil and other temperatures; rain rates, intensities and other periods; net, clear-
     sky and other radiation; wind directions, gusts and extremes; alfalfa-reference, pan or potential ET */
  const NOT_AIR = /batt|volt|panel|\bp ?temp|logger|soil|water|skin|surface|\bsur\b|leaf|canopy|dew|wet|chill|heat|feel|apparent|index|press|humid|\bhum\b|\brh\b|speed|wind|solar|\brad|rain|\bin ?temp|indoor|inside|enclosure|climo|normal|record|depart|forecast|\bqc\b|flag/;
  const WX_NOT = {
    prcp: /rate\b|\bmax|maximum|peak|\bduration|\bdur\b|hour|\bhrs?\b|type|prob|chance|intens|freq|\bdays\b|count|flag|\bqc\b|normal|depart|climo|\btemp|event|storm|week|month|year|annual|season|ytd|forecast|snow/,
    srad: /\bnet\b|long|\blw\b|clear|\bclr|rso|\bmax|maximum|\bmin\b|minimum|peak|\bhi\b|high|\bpar\b|ppfd|\buv|reflect|albedo|diffuse|direct|extra|\btoa\b|\btemp|volt|panel|batt|charg|solar ?v\b|dose|index|radar|radius|radio|\bqc\b|flag|hours?\b|duration/,
    tmax: NOT_AIR, tmin: NOT_AIR, tdew: /\bmax|maximum|\bmin\b|minimum|high|low|depress|deficit|\bqc\b|flag/,
    rhmax: /spec|abs|\bin\b|indoor|\bqc\b|flag/, rhmin: /spec|abs|\bin\b|indoor|\bqc\b|flag/, rh: /spec|abs|\bmax|maximum|\bmin\b|minimum|high|low|\bin\b|indoor|\bqc\b|flag/,
    wind: /\bdir\b|direction|winddir|drct|gust|\bmax|maximum|\bmin\b|minimum|peak|\brun\b|\bsd\b|\bstd|\bdev\b|\bhi\b|high|\bwsf|\brange\b|chill|fastest|sustain|window|index|power|energy|\bqc\b|flag/,
    et0: /\betr|alfalfa|tall|\bpan\b|\bpet\b|potential|\betc\b|\beta\b|actual|\bkc\b|\bqc\b|flag/,
  };
  // the few notes in brackets that do change what a column is ("Temp Max (soil)", "Reference ET (tall)")
  const NOT_AIR_NOTE = /soil|panel|batt|water temp|indoor|wet.?bulb/, WX_NOTE_NOT = { tmax: NOT_AIR_NOTE, tmin: NOT_AIR_NOTE, wind: /fastest|gust|peak|sustain/, et0: /tall|alfalfa|\betr|\brs\b/ };
  const WHEN = /\btime\b|.\btm[xn]\b/; // the time of a maximum or minimum ("Time of max temp", "WS_ms_TMx")
  // a name that may hold the date; which column does is seen from the rows (dateLayout)
  const DATE_NAMES = ["date", "datetime", "date time", "timestamp", "yyyymmdd", "valid", "day", "time"];
  const DATE_LIKE = /date|time|stamp|period|\bday\b|\bdatum\b|\bfecha\b|\bdia\b/, NOT_DATE = /\bmax|maximum|\bmin\b|minimum|\btm[xn]\b|gust|peak|high|low|\bsun|duration|update/;
  /* the columns a header row names (index, or -1) and how sure each is: an exact name 4, a mean wind speed 3.5, a pattern
     3; two less for a column that may not be the day's value (a shorter duration, an accumulation). The best rank wins
     and then the first column, each column used once. dates: the columns named like a date; others: the rest. */
  function wxColumns(row) {
    const head = row.map(wxName), notes = row.map(inBrackets), C = { rank: {} }, cand = [], Q = Object.keys(WX_ALIASES);
    Q.forEach(k => head.forEach((h, i) => {
      if (!h) return;
      const bare = h.replace(SHORT_SPAN, " ").replace(/\s+/g, " ").trim();
      if ((WX_NOT[k] && WX_NOT[k].test(bare)) || (WX_NOTE_NOT[k] && WX_NOTE_NOT[k].test(notes[i])) || WHEN.test(bare)) return;
      const exact = WX_ALIASES[k].includes(bare);
      if (!exact && !(WX_PAT[k] && WX_PAT[k].some(re => re.test(bare)))) return;
      const doubt = bare !== h || (k === "prcp" && /accum|cumul|since/.test(bare));
      cand.push([(exact ? 4 : k === "wind" && MEAN_WIND.test(bare) ? 3.5 : 3) - (doubt ? 2 : 0), i, k]);
    }));
    cand.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    const used = new Set();
    cand.forEach(([r, i, k]) => { if (C[k] === undefined && !used.has(i)) { C[k] = i; C.rank[k] = r; used.add(i); } });
    Q.forEach(k => { if (C[k] === undefined) C[k] = -1; });
    const named = DATE_NAMES.flatMap(n => head.flatMap((h, i) => (h === n ? [i] : [])));
    const like = head.flatMap((h, i) => (DATE_LIKE.test(h) && !NOT_DATE.test(h) ? [i] : []));
    C.dates = [...new Set(named.concat(like))].filter(i => !used.has(i));
    C.others = head.flatMap((_, i) => (used.has(i) || C.dates.includes(i) ? [] : [i]));
    C.day = head.findIndex((h, i) => h === "day" && !used.has(i));
    return C;
  }
  // the day of YYYY-MM-DD, YYYYMMDD (a time may follow, also run on: YYYYMMDDHHMM) or M/D/YYYY (D/M/YYYY in a file that
  // needs it), of year, month, day, or of year and day of year; null if that is not a real day
  const calDay = (y, mo, d) => (y >= 1800 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && new Date(Date.UTC(y, mo - 1, d)).getUTCMonth() === mo - 1 ? Wd.epochDay(y, mo - 1, d) : null);
  const yearDay = (y, j) => (y >= 1800 && y <= 2200 && j >= 1 && new Date(Date.UTC(y, 0, j)).getUTCFullYear() === y ? Wd.epochDay(y, 0, j) : null);
  const US_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?!\d)/;
  function fullDate(s, dayFirst) {
    const t = s || "", m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/) || t.match(/^(\d{4})(\d{2})(\d{2})(\d{2}){0,3}(?!\d)/);
    if (m) return calDay(+m[1], +m[2], +m[3]);
    const u = t.match(US_DATE);
    return !u ? null : dayFirst ? calDay(+u[3], +u[2], +u[1]) : calDay(+u[3], +u[1], +u[2]);
  }
  const int = s => (/^\d{1,4}(\.0*)?$/.test(s || "") ? +s : null);
  /* how the rows under the header give the day, judged on the first of them: a column of full dates first, in the order
     of C.dates ("Day" holds the dates when "Time" holds clock times), else year, month and day, else year and day of
     the year, else any other column of full dates; a way counts when it gives a real day in at least half the rows that
     fill its columns. Dates read D/M/YYYY when some first number in the column is above 12. */
  function dateLayout(C, sample, all) {
    // "day" is the day of the month in a file with a month column, else the day of the year
    const dom = C.dom >= 0 ? C.dom : C.day, doy = C.doy >= 0 ? C.doy : C.month < 0 ? C.day : -1;
    const dated = i => {
      const dayFirst = all.some(x => { const u = (x[i] || "").match(US_DATE); return u && +u[1] > 12; });
      return { cols: { date: i }, dayFirst, day: x => fullDate(x[i], dayFirst) };
    };
    const ways = C.dates.map(dated);
    if (C.year >= 0 && C.month >= 0 && dom >= 0) ways.push({ cols: { year: C.year, month: C.month, dom }, day: x => calDay(int(x[C.year]), int(x[C.month]), int(x[dom])) });
    if (C.year >= 0 && doy >= 0) ways.push({ cols: { year: C.year, doy }, day: x => yearDay(int(x[C.year]), int(x[doy])) });
    ways.push(...C.others.map(dated));
    return ways.find(w => {
      const filled = sample.filter(x => Object.values(w.cols).some(i => (x[i] || "") !== "")), good = filled.filter(x => w.day(x) !== null).length;
      return good > 0 && 2 * good >= filled.length;
    }) || null;
  }
  /* the file's delimiter: of tab, semicolon and comma the one that makes the most columns on a line among the first lines
     (quotes aside), tab and then semicolon on a tie, so a semicolon inside a comma file stays in its cell */
  function delimiter(text) {
    const lines = text.split(/\r?\n/, 100).map(l => l.replace(/"[^"]*"/g, "x"));
    const most = d => Math.max(...lines.map(l => l.split(d).length));
    return ["\t", ";", ","].reduce((a, d) => (most(d) > most(a) ? d : a));
  }
  function csvRows(text) {
    const out = [], sep = delimiter(text);
    let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
      if (c === '"') q = true;
      else if (c === sep) { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); out.push(row); row = []; cell = ""; }
      else cell += c;
    }
    if (cell !== "" || row.length) { row.push(cell); out.push(row); }
    // a decimal comma, where the comma is not the delimiter
    const dec = s => (sep !== "," && /^-?\d+,\d+$/.test(s) ? s.replace(",", ".") : s);
    return out.map(x => x.map(s => dec(s.replace(/^\ufeff/, "").trim()))).filter(x => x.length && !(x.length === 1 && x[0] === "") && !/^#/.test(x[0]));
  }
  /* columns by name (units in brackets ignored); u: { temp: "C"|"F", prcp: "mm"|"in", srad: "MJ"|"W"|"ly"|"kWh", wind: "ms"|"mph"|"kmh"|"kn", windHeight: m }.
     ET0 is read only from a grass-reference column (et0, ETo, ETos, reference ET), in the rain unit. */
  function parseWeatherCSV(text, u, lat, lon, elev) {
    const rows = csvRows(text);
    if (rows.length < 3) throw new Error("The weather file needs a header row and daily rows.");
    // the header is the first row that names a date, Tmax, Tmin and rain: NASA POWER, Open-Meteo and Campbell TOA5 files have lines above it
    const dated = C => C.dates.length > 0 || C.year >= 0, full = C => C.tmax >= 0 && C.tmin >= 0 && C.prcp >= 0;
    const cols = rows.slice(0, 100).map(wxColumns), named = cols.findIndex(c => dated(c) && full(c)), hi = Math.max(0, named >= 0 ? named : cols.findIndex(full)), C = cols[hi];
    if (!full(C)) throw new Error(dated(C) ? "Columns needed: tmax, tmin and prcp (rain); optional srad, rh, rhmax, rhmin, tdew, wind, et0." : "No date column found: use 'date' (YYYY-MM-DD), or 'year' with 'doy', or year, month and day.");
    const L = dateLayout(C, rows.slice(hi + 1, hi + 41), rows.slice(hi + 1));
    if (!L) throw new Error(dated(C) ? "No daily rows could be read; check the date format." : "No date column found: use 'date' (YYYY-MM-DD), or 'year' with 'doy', or year, month and day.");
    // a Campbell TOA5 table stamps each record at the end of its interval: a daily record at 2024-07-02 00:00 holds 1 July
    const toa5 = /^toa5$/i.test(rows[0][0]) && L.cols.date !== undefined, midnight = s => /^\S+[ T]0?0:00(:00)?(\.0+)?(?![\d.:])/.test(s || "");
    const temp = v => (v === null ? null : u.temp === "F" ? (v - 32) / 1.8 : v);
    const pr = v => (v === null ? null : u.prcp === "in" ? v * 25.4 : v);
    const sr = v => (v === null ? null : u.srad === "W" ? v * 0.0864 : u.srad === "ly" ? v * 0.04184 : u.srad === "kWh" ? v * 3.6 : v);
    const wk = { ms: 1, mph: 0.44704, kmh: 1 / 3.6, kn: 0.514444 }[u.wind || "ms"];
    const zh = +u.windHeight || 2, to10 = Math.log(10 / 0.03) / Math.log(zh / 0.03), to2 = Math.log(2 / 0.03) / Math.log(zh / 0.03); // log law, open ground z0 = 0.03 m
    // blank, text (NA, M) and codes of -99 or below (-99.9, -996, -9999) are missing; "T" (a trace) of rain is 0
    const nv = (x, k) => {
      if (C[k] < 0) return null;
      const v = (x[C[k]] || "").trim(), n = v === "" ? NaN : +v;
      if (k === "prcp" && /^t(race)?$/i.test(v)) return 0;
      return Number.isFinite(n) && n > -99 ? n : null;
    };
    const byDay = new Map(), seen = { moved: null, dup: new Set(), trace: 0, lost: 0, lostAt: "" };
    for (const x of rows.slice(hi + 1)) {
      let d = L.day(x);
      if (d === null) {
        // a row with weather but no readable date (units and other text lines have no numbers)
        if (["tmax", "tmin", "prcp"].some(k => nv(x, k) !== null)) { seen.lost++; seen.lostAt = seen.lostAt || Object.values(L.cols).map(i => x[i] || "").join(" "); }
        continue;
      }
      if (toa5 && midnight(x[L.cols.date])) { d--; seen.moved = seen.moved || `${x[L.cols.date]} → ${Wd.isoDay(d)}`; }
      if (byDay.has(d)) seen.dup.add(d);
      if (C.prcp >= 0 && /^t(race)?$/i.test(x[C.prcp] || "")) seen.trace++;
      const w = nv(x, "wind"), e0 = pr(nv(x, "et0"));
      byDay.set(d, { prcp: pr(nv(x, "prcp")), tmax: temp(nv(x, "tmax")), tmin: temp(nv(x, "tmin")), srad: sr(nv(x, "srad")), rh: nv(x, "rh"),
        rhmax: nv(x, "rhmax"), rhmin: nv(x, "rhmin"), tdew: temp(nv(x, "tdew")), wind10: w === null ? null : w * wk * to10, wind2: w === null ? null : w * wk * to2,
        et0: e0 !== null && e0 >= 0 ? e0 : null }); // a negative ET0 is not a value
    }
    if (!byDay.size) throw new Error("No daily rows could be read; check the date format.");
    const ds = [...byDay.keys()].sort((a, b) => a - b), d0 = ds[0], d1 = ds[ds.length - 1];
    // the header each quantity was read from, so a wrong match can be seen, and what was read in a way worth saying
    const at = { ...C, ...L.cols }, name = i => `"${rows[hi][i]}"`;
    const keys = [...Object.keys(L.cols), "tmax", "tmin", "prcp", "srad", "rh", "rhmax", "rhmin", "tdew", "wind", "et0"];
    const notes = [], plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
    const unread = L.cols.date === undefined ? C.dates.filter(i => /date/.test(colName(rows[hi][i]))) : [];
    if (L.dayFirst) notes.push(`${name(L.cols.date)} is read as day/month/year, as it has first numbers above 12.`);
    if (unread.length) notes.push(`The ${name(unread[0])} column could not be read as dates (YYYY-MM-DD or M/D/YYYY), so the days come from ${Object.values(L.cols).map(name).join(", ")}.`);
    if (seen.moved) notes.push(`Campbell TOA5 file: each daily record is stamped at midnight at the end of its day, so it is dated the day before (${seen.moved}).`);
    if (seen.lost) notes.push(`${plural(seen.lost, "row with weather values was", "rows with weather values were")} left out for want of a readable date (first: "${seen.lostAt}").`);
    if (seen.dup.size) notes.push(`${plural(seen.dup.size, "day appears", "days appear")} more than once (is this a daily file?); the last row of each is used.`);
    // rain that may not be each day's amount: a second-choice column, or one that only ever rises (a running total)
    if (C.rank.prcp <= 2) notes.push(`${name(C.prcp)} is read as each day's rain.`);
    const rain = ds.map(k => byDay.get(k).prcp).filter(v => v !== null);
    let up = 0, down = 0;
    rain.forEach((v, i) => { if (i && v > rain[i - 1]) up++; else if (i && v < rain[i - 1]) down++; });
    if (up >= 5 && !down) notes.push(`${name(C.prcp)} only ever rises, so it looks like a running total, not each day's rain: use a column of daily amounts, or the day-to-day differences.`);
    if (seen.trace) notes.push(`Trace rain ("T") on ${plural(seen.trace, "day", "days")} is read as 0.`);
    const out = { source: "file", lat, lon, elev, columns: Object.fromEntries(keys.filter(k => at[k] >= 0).map(k => [k, rows[hi][at[k]]])), notes,
      days: [], prcp: [], tmax: [], tmin: [], srad: [], rh: [], rhmax: [], rhmin: [], tdew: [], vp: [], wind10: [], wind2: [], et0: [] };
    for (let d = d0; d <= d1; d++) {
      const v = byDay.get(d) || {};
      out.days.push(d);
      ["prcp", "tmax", "tmin", "srad", "rhmax", "rhmin", "wind10", "wind2"].forEach(k => out[k].push(v[k] ?? null));
      const has = x => x !== null && x !== undefined, es = T => 0.6108 * Math.exp((17.27 * T) / (T + 237.3));
      const esm = has(v.tmax) && has(v.tmin) ? (es(v.tmax) + es(v.tmin)) / 2 : null; // saturation vapour pressure (FAO-56 Eq. 12)
      let rh = has(v.rh) ? v.rh : has(v.rhmax) && has(v.rhmin) ? (v.rhmax + v.rhmin) / 2 : null;
      // vapour pressure (kPa) from the dew point, else from RHmax and RHmin (FAO-56 Eq. 17), else from mean RH (Eq. 19)
      let vp = has(v.tdew) ? es(v.tdew) : null;
      if (vp === null && esm !== null) {
        if (has(v.rhmax) && has(v.rhmin)) vp = (es(v.tmin) * v.rhmax / 100 + es(v.tmax) * v.rhmin / 100) / 2;
        else if (has(rh)) vp = (rh / 100) * esm;
      }
      // mean RH from the dew point when the file gives no RH (Eq. 19 the other way), at most 100 %
      if (rh === null && vp !== null && esm !== null) rh = Math.min(100, (100 * vp) / esm);
      out.rh.push(rh);
      out.vp.push(vp);
      out.tdew.push(has(v.tdew) ? v.tdew : vp > 0 ? (237.3 * Math.log(vp / 0.6108)) / (17.27 - Math.log(vp / 0.6108)) : null);
      out.et0.push(v.et0 ?? null);
    }
    return out;
  }
  /* fill gaps of a user series from another series on the same days (e.g. gridMET); counts what was filled. ET0 is
     not taken over: days without the file's own ET0 get FAO-56 from the filled series, so the user's weather sets it. */
  function fillGaps(wx, from) {
    const ix = new Map(from.days.map((d, k) => [d, k])), filled = {};
    ["prcp", "tmax", "tmin", "srad", "rh", "rhmax", "rhmin", "tdew", "vp", "wind10", "wind2"].forEach(key => {
      wx[key] = wx[key].map((v, k) => {
        if (v !== null && v !== undefined) return v;
        const j = ix.get(wx.days[k]);
        const f = j === undefined ? null : from[key][j];
        if (f !== null && f !== undefined) filled[key] = (filled[key] || 0) + 1;
        return f ?? null;
      });
    });
    return filled;
  }
  const weatherTemplateCSV = () => WG.export.csv(["date", "tmax (C)", "tmin (C)", "prcp (mm)", "srad (MJ/m2/d)", "rh (%)", "wind (m/s)"],
    [["2024-01-01", 12.5, -3.1, 0, 11.8, 62, 3.4], ["2024-01-02", 14.2, -1.0, 2.5, 9.6, 71, 4.1]]);

  /* ---------- zip ---------- */
  const JSZIP = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
  let zipLib = null;
  function loadZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return zipLib || (zipLib = new Promise((res, rej) => {
      const s = document.createElement("script");
      // a failed load is forgotten, so the next download tries the CDN again
      const fail = () => { zipLib = null; s.remove(); rej(new Error("Could not load the zip library")); };
      s.src = JSZIP; s.onload = () => (window.JSZip ? res(window.JSZip) : fail()); s.onerror = fail;
      document.head.appendChild(s);
    }));
  }
  async function zip(files) {
    const Z = await loadZip(), z = new Z();
    files.forEach(f => z.file(f.name, f.text));
    return z.generateAsync({ type: "blob", compression: "DEFLATE" });
  }

  return { surveySoil, userSoil, SOIL_COLS, soilTemplateCSV, parseSoilCSV, csvRows, parseWeatherCSV, fillGaps, weatherTemplateCSV, relayer, relayerLayers, zip, writers: {}, r };
})();
