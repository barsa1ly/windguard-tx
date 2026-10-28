/* Soil: SSURGO (USDA Soil Data Access) query, texture/WEG logic, pedotransfer, exports. */
WG.soil = (function () {
  const { num, fetchJSON } = WG.util;
  const SDA = "https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest";

  const TEX = {
    COS: "coarse sand", S: "sand", FS: "fine sand", VFS: "very fine sand",
    LCOS: "loamy coarse sand", LS: "loamy sand", LFS: "loamy fine sand", LVFS: "loamy very fine sand",
    COSL: "coarse sandy loam", SL: "sandy loam", FSL: "fine sandy loam", VFSL: "very fine sandy loam",
    L: "loam", SIL: "silt loam", SI: "silt", SCL: "sandy clay loam", CL: "clay loam", SICL: "silty clay loam",
    SC: "sandy clay", SIC: "silty clay", C: "clay",
    MUCK: "muck", PEAT: "peat", MPT: "mucky peat", MUCK_: "muck",
    BR: "bedrock", WB: "weathered bedrock", UWB: "unweathered bedrock", CEM: "cemented", IND: "indurated",
    GYP: "gypsiferous material", VAR: "variable", SPM: "slightly decomposed plant material",
    HPM: "moderately decomposed plant material", MPM: "highly decomposed plant material",
  };
  const FAMILY = {
    COS: "sand", S: "sand", FS: "sand", VFS: "sand",
    LCOS: "loamy sand", LS: "loamy sand", LFS: "loamy sand", LVFS: "loamy sand",
    COSL: "sandy loam", SL: "sandy loam", FSL: "sandy loam", VFSL: "sandy loam",
    L: "L", SIL: "SIL", SI: "SI", SCL: "SCL", CL: "CL", SICL: "SICL", SC: "SC", SIC: "SIC", C: "C",
  };
  const ROCKY = /^(VST|XST|VBY|XBY|XCB|XFL|XCN)$/; // very/extremely stony or bouldery surfaces

  /* ---------------- SDA ---------------- */
  async function sda(query) {
    const j = await fetchJSON(SDA, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, format: "JSON+COLUMNNAME" }),
    }, 40000);
    const t = j.Table || [];
    if (!t.length) return [];
    const cols = t[0];
    return t.slice(1).map(r => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
  }

  async function fetchSoil(lat, lon) {
    const pt = `point(${lon.toFixed(6)} ${lat.toFixed(6)})`;
    const mk = await sda(`SELECT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('${pt}')`);
    if (!mk.length) return null;
    const mukey = parseInt(mk[0].mukey, 10);
    const inMu = `IN (SELECT cokey FROM component WHERE mukey = ${mukey})`;

    const [mu, comps, hz, areas, eco, ylds, plants, restr] = await Promise.all([
      sda(`SELECT mu.mukey, mu.musym, mu.muname, mu.mukind, l.areasymbol, l.areaname, sc.saverest,
             ma.slopegraddcp, ma.slopegradwta, ma.brockdepmin, ma.wtdepannmin, ma.flodfreqdcd, ma.drclassdcd,
             ma.hydgrpdcd, ma.aws0150wta, ma.niccdcd, ma.iccdcd, ma.wtdepaprjunmin
           FROM mapunit mu JOIN legend l ON l.lkey = mu.lkey LEFT JOIN muaggatt ma ON ma.mukey = mu.mukey
           LEFT JOIN sacatalog sc ON sc.areasymbol = l.areasymbol
           WHERE mu.mukey = ${mukey}`),
      sda(`SELECT cokey, compname, comppct_r, majcompflag, compkind, localphase, taxclname, taxorder, taxsuborder,
             taxgrtgroup, taxsubgrp, taxpartsize, taxtempregime, taxmoistscl, drainagecl, hydgrp, slope_l, slope_r,
             slope_h, slopelenusle_r, weg, wei, tfact, albedodry_r, runoff, elev_r, nirrcapcl, nirrcapscl, irrcapcl,
             irrcapscl, rsprod_r, geomdesc, map_r, airtempa_r, ffd_r, erocl, hydricrating
           FROM component WHERE mukey = ${mukey} ORDER BY comppct_r DESC`),
      sda(`SELECT ch.cokey, ch.chkey, ch.hzname, ch.hzdept_r, ch.hzdepb_r, ch.sandtotal_r, ch.silttotal_r,
             ch.claytotal_r, ch.sandvf_r, ch.sandfine_r, ch.sandmed_r, ch.sandco_r, ch.sandvc_r, ch.om_r,
             ch.dbthirdbar_r, ch.wthirdbar_r, ch.wfifteenbar_r, ch.wsatiated_r, ch.awc_r, ch.ksat_r,
             ch.ph1to1h2o_r, ch.cec7_r, ch.ecec_r, ch.caco3_r, ch.gypsum_r, ch.ec_r, ch.sar_r, ch.kwfact, ch.kffact,
             ch.sieveno10_r, ch.frag3to10_r, ch.fraggt10_r, ch.lep_r, ch.partdensity, tg.texture, tg.texdesc
           FROM chorizon ch LEFT JOIN chtexturegrp tg ON tg.chkey = ch.chkey AND tg.rvindicator = 'Yes'
           WHERE ch.cokey ${inMu} ORDER BY ch.cokey, ch.hzdept_r`),
      sda(`SELECT la.areasymbol, la.areaname, la.areatypename FROM muaoverlap mo
           JOIN laoverlap la ON la.lareaovkey = mo.lareaovkey WHERE mo.mukey = ${mukey}`),
      sda(`SELECT cokey, ecoclassid, ecoclassname, ecoclasstypename FROM coecoclass WHERE cokey ${inMu}`),
      sda(`SELECT cokey, cropname, yldunits, nonirryield_r, irryield_r FROM cocropyld WHERE cokey ${inMu}`),
      sda(`SELECT cokey, plantsym, plantsciname, plantcomname, rangeprod FROM coeplants WHERE cokey ${inMu}`),
      sda(`SELECT cokey, reskind, reshard, resdept_r, resdepb_r FROM corestrictions WHERE cokey ${inMu}`),
    ]);
    return assemble({ lat, lon, mukey, mu: mu[0] || {}, comps, hz, areas, eco, ylds, plants, restr });
  }

  function assemble(raw) {
    const hzBy = groupBy(raw.hz, "cokey");
    const comps = raw.comps.map(c => ({
      ...c,
      comppct_r: num(c.comppct_r),
      horizons: (hzBy[c.cokey] || []).filter(h => num(h.hzdepb_r) !== null),
      eco: raw.eco.find(e => e.cokey === c.cokey && /ecological site/i.test(e.ecoclasstypename || "Ecological Site"))
        || raw.eco.find(e => e.cokey === c.cokey) || null,
      restrictions: raw.restr.filter(r => r.cokey === c.cokey).sort((a, b) => num(a.resdept_r) - num(b.resdept_r)),
      yields: raw.ylds.filter(y => y.cokey === c.cokey),
      plants: raw.plants.filter(p => p.cokey === c.cokey && num(p.rangeprod) > 0)
        .sort((a, b) => num(b.rangeprod) - num(a.rangeprod)),
    }));
    // dominant soil = largest component that actually has horizon data
    const withHz = comps.filter(c => c.horizons.some(h => num(h.sandtotal_r) !== null || num(h.claytotal_r) !== null));
    const dom = withHz[0] || comps[0] || null;
    const area = t => raw.areas.find(a => (a.areatypename || "").toLowerCase().startsWith(t));
    const mlra = area("mlra");
    const cf = area("climate factor");
    const county = area("county");
    const surface = dom ? surfaceLayer(dom) : null;
    return {
      source: "SSURGO",
      lat: raw.lat, lon: raw.lon,
      mukey: raw.mukey,
      mapunit: raw.mu,
      county: county ? county.areaname : null,
      mlra: mlra ? { sym: mlra.areasymbol, name: mlra.areaname } : null,
      cFactor: cf ? num(cf.areasymbol) : null,
      rFactor: num((area("rainfall factor") || {}).areasymbol),
      components: comps,
      dominant: dom,
      dominantIsTop: dom && comps[0] && dom.cokey === comps[0].cokey,
      surface,
    };
  }

  function groupBy(arr, k) {
    return arr.reduce((o, r) => ((o[r[k]] = o[r[k]] || []).push(r), o), {});
  }

  function parseTexture(tex) {
    if (!tex) return { code: null, base: null, mods: [] };
    const parts = String(tex).toUpperCase().split(/[-\s]+/).filter(Boolean);
    const base = parts.reverse().find(p => TEX[p]) || parts[0];
    return { code: tex, base, mods: parts.filter(p => p !== base) };
  }

  function surfaceLayer(comp) {
    const hz = comp.horizons.find(h => num(h.sandtotal_r) !== null || num(h.claytotal_r) !== null) || comp.horizons[0];
    if (!hz) return null;
    const tex = parseTexture(hz.texture);
    const sand = num(hz.sandtotal_r), clay = num(hz.claytotal_r);
    let silt = num(hz.silttotal_r);
    if (silt === null && sand !== null && clay !== null) silt = 100 - sand - clay;
    return {
      hzname: hz.hzname,
      depthTop: num(hz.hzdept_r), depthBot: num(hz.hzdepb_r),
      sand, silt, clay,
      vfs: num(hz.sandvf_r),
      om: num(hz.om_r),
      caco3: num(hz.caco3_r) ?? 0,
      ph: num(hz.ph1to1h2o_r),
      bd: num(hz.dbthirdbar_r),
      texCode: tex.base,
      texMods: tex.mods,
      texName: hz.texdesc ? hz.texdesc.toLowerCase() : (TEX[tex.base] || null),
      weg: comp.weg ? String(comp.weg).trim() : null,
      wei: num(comp.wei),
      rocky: tex.mods.some(m => ROCKY.test(m)),
      cf: num(hz.sieveno10_r) !== null ? Math.max(0, 100 - num(hz.sieveno10_r)) : (num(hz.frag3to10_r) ?? 0) + (num(hz.fraggt10_r) ?? 0),
    };
  }

  /* ---------------- texture class (USDA triangle) ---------------- */
  function textureClass(sand, silt, clay) {
    if ([sand, silt, clay].some(v => v === null || isNaN(v))) return null;
    if (silt + 1.5 * clay < 15) return "S";
    if (silt + 1.5 * clay >= 15 && silt + 2 * clay < 30) return "LS";
    if ((clay >= 7 && clay < 20 && sand > 52 && silt + 2 * clay >= 30) || (clay < 7 && silt < 50 && silt + 2 * clay >= 30)) return "SL";
    if (clay >= 7 && clay < 27 && silt >= 28 && silt < 50 && sand <= 52) return "L";
    if ((silt >= 50 && clay >= 12 && clay < 27) || (silt >= 50 && silt < 80 && clay < 12)) return "SIL";
    if (silt >= 80 && clay < 12) return "SI";
    if (clay >= 20 && clay < 35 && silt < 28 && sand > 45) return "SCL";
    if (clay >= 27 && clay < 40 && sand > 20 && sand <= 45) return "CL";
    if (clay >= 27 && clay < 40 && sand <= 20) return "SICL";
    if (clay >= 35 && sand > 45) return "SC";
    if (clay >= 40 && silt >= 40) return "SIC";
    return "C";
  }

  /* Keep the sand-size modifier from the survey (e.g. FSL) when the family is unchanged. */
  function refineCode(computed, surveyCode) {
    if (!surveyCode || !computed) return computed;
    const fam = c => ({ S: "sand", LS: "loamy sand", SL: "sandy loam" }[c] || FAMILY[c]);
    return fam(computed) === FAMILY[surveyCode] ? surveyCode : computed;
  }

  /* ---------------- Wind Erodibility Group (NRCS NSSH Part 618.95, 2019) ----------------
     Surface-layer texture classes. "Calcareous" in the NSSH means strong or violent effervescence
     with cold 1N HCl; there is no CaCO3 threshold, so CaCO3 >= 5% is used as the proxy.
     Coarse fragments (footnote 1) move the group toward less erodible. Returns { weg, I, why }. */
  const WEG_I = { "1": 220, "2": 134, "3": 86, "4": 86, "4L": 86, "5": 56, "6": 48, "7": 38, "8": 0 };
  const WEG1_I = { VFS: 310, FS: 250, S: 220, COS: 160 };

  function wegFromSurface(s) {
    const code = s.texCode;
    const clay = s.clay ?? 0;
    const calc = (s.caco3 ?? 0) >= 5;
    const fam = FAMILY[code] || ({ S: "sand", LS: "loamy sand", SL: "sandy loam" }[code]);
    let weg, why;
    if (s.rocky) { weg = "8"; why = "very stony/bouldery surface armors the soil"; }
    else if ((s.om ?? 0) >= 20) { weg = "2"; why = "organic (sapric) surface"; }
    else if (fam === "sand") { weg = "1"; why = "sand textures"; }
    else if (fam === "loamy sand") { weg = "2"; why = "loamy sand textures"; }
    else if (code === "VFSL" && clay <= 5) { weg = "2"; why = "very fine sandy loam with ≤ 5% clay"; }
    else if (fam === "sandy loam") { weg = "3"; why = "sandy loam textures"; }
    else if (code === "SIL" && clay <= 5) { weg = "2"; why = "silt loam with ≤ 5% clay"; }
    else if (code === "C" || code === "SIC") { weg = "4"; why = "clay or silty clay"; }
    else if (calc && ["L", "SIL", "SI", "CL", "SICL", "SCL", "SC"].includes(code)) { weg = "4L"; why = "calcareous loamy surface (CaCO₃ ≥ 5%)"; }
    else if ((code === "CL" || code === "SICL") && clay > 35) { weg = "4"; why = "clay loam with > 35% clay"; }
    else if (code === "SIL" && clay >= 5 && clay < 12 && (s.vfs ?? 0) >= 20) { weg = "3"; why = "silt loam, 5–12% clay, high very fine sand"; }
    else if ((code === "L" || code === "SIL") && clay < 20) { weg = "5"; why = "noncalcareous loam/silt loam < 20% clay"; }
    else if (code === "SCL" || code === "SC") { weg = "5"; why = "noncalcareous sandy clay loam / sandy clay"; }
    else if ((code === "L" || code === "SIL") && clay >= 20) { weg = "6"; why = "noncalcareous loam/silt loam ≥ 20% clay"; }
    else if (code === "CL" || code === "SICL") { weg = "6"; why = "noncalcareous clay loam / silty clay loam ≤ 35% clay"; }
    else if (code === "SI") { weg = "7"; why = "noncalcareous silt"; }
    else { weg = null; why = "texture not classified"; }
    let I = weg === "1" ? (WEG1_I[code] ?? 220) : (weg ? WEG_I[weg] : null);
    // coarse-fragment adjustment (volume % > 2 mm), NSSH 618.95 footnote 1
    const cf = s.cf ?? 0;
    if (weg && weg !== "8" && cf >= 15) {
      const sandy = weg === "1" || weg === "2";
      const steps = cf > 60 ? (sandy ? 3 : 99) : cf >= 35 ? (sandy ? 1 : 2) : (sandy ? 0 : 1);
      if (steps > 0) {
        const ORDER = ["1", "2", "3", "4L", "5", "6", "7", "8"];
        const at = ORDER.indexOf(weg === "4" ? "4L" : weg);
        const nw = ORDER[Math.min(ORDER.length - 1, at + steps)];
        why += `; ${Math.round(cf)}% rock fragments → WEG ${nw}`;
        weg = nw;
        I = WEG_I[nw];
      }
    }
    return { weg, I, why };
  }

  const WEG_RISK = { "1": 5, "2": 5, "3": 4, "4": 3, "4L": 3, "5": 2, "6": 2, "7": 1, "8": 0 };

  /* ---------------- Saxton & Rawls (2006) ----------------
     sand, clay in %, om in % (capped at 8). Returns volumetric fractions, g/cm3, mm/h. */
  function saxtonRawls(sandPct, clayPct, omPct) {
    if (sandPct === null || clayPct === null) return null;
    const S = sandPct / 100, C = clayPct / 100, OM = Math.min(Math.max(omPct ?? 1, 0), 8);
    const t1500t = -0.024 * S + 0.487 * C + 0.006 * OM + 0.005 * S * OM - 0.013 * C * OM + 0.068 * S * C + 0.031;
    const t1500 = t1500t + (0.14 * t1500t - 0.02);
    const t33t = -0.251 * S + 0.195 * C + 0.011 * OM + 0.006 * S * OM - 0.027 * C * OM + 0.452 * S * C + 0.299;
    const t33 = t33t + (1.283 * t33t * t33t - 0.374 * t33t - 0.015);
    const ts33t = 0.278 * S + 0.034 * C + 0.022 * OM - 0.018 * S * OM - 0.027 * C * OM - 0.584 * S * C + 0.078;
    const ts33 = ts33t + (0.636 * ts33t - 0.107);
    const ts = t33 + ts33 - 0.097 * S + 0.043;
    const bd = (1 - ts) * 2.65;
    const B = (Math.log(1500) - Math.log(33)) / (Math.log(t33) - Math.log(t1500));
    const ks = 1930 * Math.pow(Math.max(ts - t33, 0), 3 - 1 / B);
    return { ll: t1500, dul: t33, sat: ts, bd, ksat: ks, awc: t33 - t1500 };
  }

  /* ---------------- crop-model site parameters ---------------- */
  const DRAIN = {
    "excessively drained": 0.85, "somewhat excessively drained": 0.75, "well drained": 0.6,
    "moderately well drained": 0.4, "somewhat poorly drained": 0.25, "poorly drained": 0.05,
    "very poorly drained": 0.01,
  };
  const CN = { A: [61, 64, 68, 71], B: [73, 76, 80, 83], C: [81, 84, 88, 91], D: [84, 87, 91, 94] };

  function curveNumber(hydgrp, slope) {
    // dual groups (A/D, B/D, C/D): second letter is the undrained (natural) condition
    const g = String(hydgrp || "B").split("/").pop().trim().charAt(0).toUpperCase();
    const row = CN[g] || CN.B;
    const s = slope ?? 1;
    return row[s < 2 ? 0 : s < 5 ? 1 : s < 10 ? 2 : 3];
  }

  /* Build the layer table used in the detailed profile and exports. */
  function profileLayers(comp, surfaceOverride) {
    const restr = comp.restrictions.find(r => num(r.resdept_r) !== null);
    const resDepth = restr ? num(restr.resdept_r) : null;
    return comp.horizons.map((h, i) => {
      const top = num(h.hzdept_r), bot = num(h.hzdepb_r);
      let sand = num(h.sandtotal_r), clay = num(h.claytotal_r), silt = num(h.silttotal_r), om = num(h.om_r);
      let ph = num(h.ph1to1h2o_r), caco3 = num(h.caco3_r), bd = num(h.dbthirdbar_r);
      const isTop = i === 0 && surfaceOverride;
      if (isTop) {
        ({ sand, silt, clay, om, ph, caco3 } = { ...{ sand, silt, clay, om, ph, caco3 }, ...surfaceOverride });
      }
      if (silt === null && sand !== null && clay !== null) silt = 100 - sand - clay;
      const sr = saxtonRawls(sand, clay, om);
      let ll = num(h.wfifteenbar_r), dul = num(h.wthirdbar_r), sat = num(h.wsatiated_r);
      ll = ll !== null && !isTop ? ll / 100 : sr ? sr.ll : null;
      dul = dul !== null && !isTop ? dul / 100 : sr ? sr.dul : null;
      if (bd === null || isTop) bd = isTop && sr ? sr.bd : bd ?? (sr ? sr.bd : null);
      sat = sat !== null && !isTop ? sat / 100 : sr ? sr.sat : bd ? 1 - bd / 2.65 : null;
      if (sat !== null && dul !== null) sat = Math.max(sat, dul + 0.01); // DSSAT requires SAT > DUL
      const ksatUm = num(h.ksat_r);
      const ksat = ksatUm !== null && !isTop ? ksatUm * 0.36 : sr ? sr.ksat / 10 : null; // cm/h
      const mid = top !== null && bot !== null ? (top + bot) / 2 : null;
      let srgf = mid === null ? null : bot <= 15 ? 1 : Math.exp(-0.02 * mid);
      if (resDepth !== null && top !== null && top >= resDepth) srgf = 0;
      const sieve = num(h.sieveno10_r);
      const cf = sieve !== null ? Math.max(0, 100 - sieve) : (num(h.frag3to10_r) ?? 0) + (num(h.fraggt10_r) ?? 0);
      const oc = om !== null ? om / 1.724 : null;
      return {
        hz: h.hzname || "", top, bot, texture: h.texture || "", texdesc: h.texdesc || "",
        sand, silt, clay, vfs: num(h.sandvf_r), om, oc, bd, ll, dul, sat,
        awc: num(h.awc_r) ?? (dul !== null && ll !== null ? dul - ll : null),
        ksat, ph, cec: num(h.cec7_r) ?? num(h.ecec_r), caco3, gypsum: num(h.gypsum_r), ec: num(h.ec_r), sar: num(h.sar_r),
        kw: num(h.kwfact), cf, srgf, ni: oc !== null ? Math.min(oc / 10, 0.5) : null, lep: num(h.lep_r),
        edited: !!isTop,
      };
    });
  }

  function siteParams(soil, comp, surface) {
    const slope = num(comp.slope_r) ?? num(soil.mapunit.slopegraddcp);
    const restr = comp.restrictions.find(r => num(r.resdept_r) !== null);
    const layers = comp.horizons;
    const depth = layers.length ? num(layers[layers.length - 1].hzdepb_r) : null;
    return {
      albedo: num(comp.albedodry_r),
      u: Math.min(9.9, 5 + 0.15 * ((surface?.clay ?? 10) + 2)),
      drainRate: DRAIN[(comp.drainagecl || "").toLowerCase()] ?? null,
      cn: curveNumber(comp.hydgrp, slope),
      slope,
      slopeRange: [num(comp.slope_l), num(comp.slope_h)],
      depth,
      restriction: restr ? { kind: restr.reskind, depth: num(restr.resdept_r), hard: restr.reshard } : null,
      hydgrp: comp.hydgrp,
      drainage: comp.drainagecl,
      tfact: num(comp.tfact),
      kw: layers[0] ? num(layers[0].kwfact) : null,
      lcc: comp.nirrcapcl ? comp.nirrcapcl + (comp.nirrcapscl || "") : null,
      lccIrr: comp.irrcapcl ? comp.irrcapcl + (comp.irrcapscl || "") : null,
      runoff: comp.runoff,
      rsprod: num(comp.rsprod_r),
      map: num(comp.map_r),
      airtemp: num(comp.airtempa_r),
      ffd: num(comp.ffd_r),
      aws150: num(soil.mapunit.aws0150wta),
      family: comp.taxclname,
    };
  }

  /* ---------------- exports ---------------- */
  function toCSV(soil, layers, site) {
    const head = ["horizon", "top_cm", "bottom_cm", "texture", "sand_pct", "silt_pct", "clay_pct", "vfs_pct",
      "om_pct", "oc_pct", "bulk_density_g_cm3", "ll15_cm3_cm3", "dul33_cm3_cm3", "sat_cm3_cm3", "awc_cm3_cm3",
      "ksat_cm_h", "ph_h2o", "cec_cmol_kg", "caco3_pct", "gypsum_pct", "ec_dS_m", "sar", "kw", "coarse_frag_pct",
      "root_growth_factor", "total_n_pct_est", "edited_by_user"];
    const r = v => (v === null || v === undefined ? "" : typeof v === "number" ? +v.toFixed(4) : `"${String(v).replace(/"/g, '""')}"`);
    const meta = [
      `# WindGuard TX soil profile export`,
      `# location,${soil.lat.toFixed(5)},${soil.lon.toFixed(5)}`,
      `# map unit,"${soil.mapunit.muname || ""}",mukey ${soil.mukey},${soil.mapunit.areasymbol || ""}`,
      `# component,"${soil.dominant.compname}",${soil.dominant.comppct_r}% of map unit,"${site.family || ""}"`,
      `# slope_pct,${site.slope ?? ""},hydrologic_group,${site.hydgrp || ""},drainage,"${site.drainage || ""}"`,
      `# albedo,${site.albedo ?? ""},evap_limit_mm,${site.u},drainage_rate,${site.drainRate ?? ""},runoff_CN,${site.cn}`,
      `# WEG,${soil.surface?.weg || ""},WEI,${soil.surface?.wei ?? ""},T,${site.tfact ?? ""},C_factor,${soil.cFactor ?? ""},MLRA,${soil.mlra ? soil.mlra.sym : ""}`,
    ];
    const rows = layers.map(l => [l.hz, l.top, l.bot, l.texture, l.sand, l.silt, l.clay, l.vfs, l.om, l.oc, l.bd, l.ll,
      l.dul, l.sat, l.awc, l.ksat, l.ph, l.cec, l.caco3, l.gypsum, l.ec, l.sar, l.kw, l.cf, l.srgf, l.ni, l.edited ? "yes" : "no"].map(r).join(","));
    return meta.concat([head.join(",")], rows).join("\n");
  }

  function toSOL(soil, layers, site, idNum = 1) {
    const f = (v, w, d) => (v === null || v === undefined || isNaN(v) ? "-99" : Number(v).toFixed(d)).padStart(w);
    const s = (v, w) => String(v ?? "-99").slice(0, w).padStart(w);
    const id = ("WG" + String(idNum).padStart(8, "0")).slice(0, 10);
    const comp = soil.dominant;
    const tex = soil.surface?.texCode || "-99";
    const depth = site.depth ?? layers.reduce((m, l) => Math.max(m, l.bot || 0), 0);
    const desc = (soil.mapunit.muname || comp.compname || "").slice(0, 50);
    const siteName = (soil.county || soil.mapunit.areaname || "Texas").replace(/,.*$/, "").slice(0, 11);
    const out = [];
    out.push(`*${id}  ${"SSURGO".padEnd(11)} ${tex.padEnd(5)} ${f(depth, 5, 0)} ${desc}`);
    out.push(`@SITE        COUNTRY          LAT     LONG SCS FAMILY`);
    out.push(` ${siteName.padEnd(11)} ${"USA".padEnd(11)} ${f(soil.lat, 8, 3)} ${f(soil.lon, 8, 3)} ${(site.family || "").slice(0, 50)}`);
    out.push(`@ SCOM  SALB  SLU1  SLDR  SLRO  SLNF  SLPF  SMHB  SMPX  SMKE`);
    out.push(` ${s("-99", 5)} ${f(site.albedo, 5, 2)} ${f(site.u, 5, 1)} ${f(site.drainRate, 5, 2)} ${f(site.cn, 5, 0)} ${f(1, 5, 2)} ${f(1, 5, 2)} ${s("IB001", 5)} ${s("IB001", 5)} ${s("IB001", 5)}`);
    out.push(`@  SLB  SLMH  SLLL  SDUL  SSAT  SRGF  SSKS  SBDM  SLOC  SLCL  SLSI  SLCF  SLNI  SLHW  SLHB  SCEC  SADC`);
    layers.forEach(l => {
      out.push(` ${f(l.bot, 5, 0)} ${s((l.hz || "-99").slice(0, 5), 5)} ${f(l.ll, 5, 3)} ${f(l.dul, 5, 3)} ${f(l.sat, 5, 3)} ${f(l.srgf, 5, 3)} ${f(l.ksat, 5, 2)} ${f(l.bd, 5, 2)} ${f(l.oc, 5, 2)} ${f(l.clay, 5, 1)} ${f(l.silt, 5, 1)} ${f(l.cf, 5, 1)} ${f(l.ni, 5, 3)} ${f(l.ph, 5, 1)} ${s("-99", 5)} ${f(l.cec, 5, 1)} ${s("-99", 5)}`);
    });
    return `*SOILS: WindGuard TX export (${new Date().toISOString().slice(0, 10)})\n\n` + out.join("\n") + "\n";
  }

  /* RWEQ surface-soil factors (Fryrear et al. 1994, 1998): erodible fraction EF (dry aggregates < 0.84 mm) and soil
     crust factor SCF, from sand, silt, clay, OM and CaCO3 in %. inRange: inputs inside the 57 soils the equations were fitted to. */
  function rweq(sf) {
    if (!sf || sf.sand == null || sf.clay == null) return null;
    const Sa = sf.sand, Cl = sf.clay, Si = sf.silt ?? 100 - Sa - Cl, OM = sf.om ?? 1, Ca = sf.caco3 ?? 0;
    const ratio = Sa / Math.max(Cl, 0.5);
    const ef = (29.09 + 0.31 * Sa + 0.17 * Si + 0.33 * ratio - 2.59 * OM - 0.95 * Ca) / 100;
    const scf = 1 / (1 + 0.0066 * Cl * Cl + 0.021 * OM * OM);
    const inRange = Sa >= 5.5 && Sa <= 93.6 && Si >= 0.5 && Si <= 69.5 && Cl >= 5 && Cl <= 39.3 &&
      ratio >= 1.2 && ratio <= 53 && OM >= 0.18 && OM <= 4.79 && Ca <= 25.2;
    return { ef: Math.min(1, Math.max(0, ef)), scf, inRange };
  }

  return { fetchSoil, parseTexture, textureClass, refineCode, wegFromSurface, saxtonRawls, profileLayers, siteParams,
    rweq, toCSV, toSOL, TEX, FAMILY, WEG_I, WEG_RISK, curveNumber };
})();
