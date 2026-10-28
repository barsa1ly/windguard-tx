/* Wind and moisture data, read from the producers first; Open-Meteo's copy is only a fallback:
   - hourly 10 m wind: NASA MERRA-2 directly from NASA POWER; ECMWF IFS 9 km (2017 on) / ERA5 0.25° (before) through
     Open-Meteo when NASA fails or is chosen (ECMWF and the Copernicus CDS need an account key and queued jobs);
   - daily precipitation, grass reference ET and temperature: gridMET 4 km from the University of Idaho THREDDS server,
     then NASA POWER daily (Penman–Monteith ET0 computed here), then Open-Meteo;
   - airport observations: NOAA NCEI GHCNh (official archive), else the Iowa Environmental Mesonet ASOS archive.
   The gridded wind is calibrated to the nearest airport station, then analyzed for erosive wind climate. */
WG.wind = (function () {
  const { fetchJSON, fetchText, pool, linreg } = WG.util;
  const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
  const POWER_H = "https://power.larc.nasa.gov/api/temporal/hourly/point";
  const POWER_D = "https://power.larc.nasa.gov/api/temporal/daily/point";
  const GRIDMET = "https://thredds.northwestknowledge.net/thredds/dodsC/agg_met_";
  const CST = -6 * 3600; // fixed local offset for days and months of the NASA series
  const DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const GUST_EVENT = 17.9; // m/s (40 mph) daily max gust ~ blowing-dust days

  const epochDay = (y, m, d) => Date.UTC(y, m, d) / 864e5;
  const monthOf = (t, off) => new Date((t + off) * 1000).getUTCMonth();
  const dayKey = (t, off) => Math.floor((t + off) / 86400);
  const stampDay = (t, off) => Math.round((t + off) / 86400); // local-midnight stamps, robust to DST

  function yearsFor(n) {
    const end = new Date().getFullYear() - 1; // last complete year
    return { start: end - n + 1, end };
  }

  /* ---- hourly gridded wind ---- */
  /* headerMs: how long to wait for the server to start answering (fetchWind uses 20 s before switching models;
     a download that has started may still run to 90 s). */
  async function ecmwfWind(lat, lon, y0, y1, headerMs = 90000) {
    const n = y1 - y0 + 1, chunk = n > 6 ? Math.ceil(n / 2) : n, spans = [];
    for (let y = y0; y <= y1; y += chunk) spans.push([y, Math.min(y1, y + chunk - 1)]); // parallel chunks cut wall-clock time
    const parts = await Promise.all(spans.map(([a, b]) => fetchJSON(`${ARCHIVE}?${new URLSearchParams({
      latitude: lat.toFixed(4), longitude: lon.toFixed(4), start_date: `${a}-01-01`, end_date: `${b}-12-31`,
      hourly: "wind_speed_10m,wind_direction_10m", daily: "wind_gusts_10m_max",
      wind_speed_unit: "ms", timezone: "America/Chicago", timeformat: "unixtime",
    })}`, {}, 90000, headerMs)));
    const cat = (k, sect) => parts.flatMap(p => p[sect][k]);
    const off = parts[0].utc_offset_seconds, dt = cat("time", "daily"), g = cat("wind_gusts_10m_max", "daily");
    return {
      model: "ecmwf", lat: parts[0].latitude, lon: parts[0].longitude, elevation: parts[0].elevation, offset: off,
      hourly: { t: cat("time", "hourly"), ws: cat("wind_speed_10m", "hourly"), wd: cat("wind_direction_10m", "hourly") },
      gust: new Map(dt.map((t, i) => [stampDay(t, off), g[i]])),
    };
  }

  async function powerHourly(lat, lon, y0, y1, headerMs) {
    const q = new URLSearchParams({ parameters: "WS10M,WD10M", community: "AG", longitude: lon.toFixed(4), latitude: lat.toFixed(4),
      start: `${y0}0101`, end: `${y1}1231`, format: "CSV", "time-standard": "UTC" });
    const [head, body = ""] = (await fetchText(`${POWER_H}?${q}`, 90000, headerMs)).split("-END HEADER-");
    const elev = +((head.match(/= *(-?[\d.]+) *meters/) || [])[1]);
    const t = [], ws = [], wd = [];
    body.trim().split("\n").slice(1).forEach(l => {
      const f = l.split(",");
      if (f.length < 6) return;
      t.push(Date.UTC(+f[0], +f[1] - 1, +f[2], +f[3]) / 1000);
      ws.push(+f[4] < 0 ? null : +f[4]);
      wd.push(+f[5] < 0 ? null : +f[5]);
    });
    if (!t.length) throw new Error("NASA POWER returned no hourly data");
    return { t, ws, wd, elevation: Number.isFinite(elev) ? elev : null };
  }

  /* NASA MERRA-2 has no gust variable; gust stays empty and calibration maps daily max wind to station gusts. */
  async function merraWind(lat, lon, y0, y1, headerMs = 90000) {
    const n = y1 - y0 + 1, h = Math.floor(n / 2);
    const spans = n > 10 ? [[y0, y0 + h - 1], [y0 + h, y1]] : [[y0, y1]];
    const parts = await Promise.all(spans.map(([a, b]) => powerHourly(lat, lon, a, b, headerMs)));
    const cat = k => parts.flatMap(p => p[k]);
    return {
      model: "merra2", lat: Math.round(lat / 0.5) * 0.5, lon: Math.round(lon / 0.625) * 0.625, elevation: parts[0].elevation,
      offset: CST, hourly: { t: cat("t"), ws: cat("ws"), wd: cat("wd") }, gust: null,
    };
  }

  /* ---- daily precipitation, reference ET and temperature ---- */
  const GM = {
    pr: "precipitation_amount", pet: "daily_mean_reference_evapotranspiration_grass",
    tmmx: "daily_maximum_temperature", tmmn: "daily_minimum_temperature",
  };
  const GM_DAY0 = epochDay(1979, 0, 1);

  /* One gridMET variable at one cell over OPeNDAP; packing (scale, offset, fill) read from the dataset attributes. */
  async function gridmetVar(v, j, i, d0, d1) {
    const name = GM[v], url = `${GRIDMET}${v}_1979_CurrentYear_CONUS.nc`;
    const [das, txt] = await Promise.all([
      fetchText(`${url}.das`, 20000),
      fetchText(`${url}.ascii?${name}[${d0 - GM_DAY0}:1:${d1 - GM_DAY0}][${j}:1:${j}][${i}:1:${i}]`, 45000),
    ]);
    const k0 = das.indexOf(`${name} {`), block = das.slice(k0, das.indexOf("}", k0));
    const att = (k, dflt) => { const m = block.match(new RegExp(`${k} (-?[\\d.eE+-]+);`)); return m ? +m[1] : dflt; };
    const scale = att("scale_factor", 1), add = att("add_offset", 0), fill = att("_FillValue", 32767);
    const out = [];
    for (const m of txt.matchAll(/^\[(\d+)\]\[0\], (-?\d+(?:\.\d+)?)/gm)) out[+m[1]] = +m[2] === fill ? null : +m[2] * scale + add;
    return out;
  }

  /* Day-aligned series d0..d0+n-1 from (epoch day, value) pairs. */
  function align(source, d0, n, days, cols, lat, lon) {
    const ix = new Map(days.map((d, k) => [d, k]));
    const pick = a => Array.from({ length: n }, (_, k) => { const i = ix.get(d0 + k); return i === undefined ? null : a[i] ?? null; });
    return { source, d0, p: pick(cols.p), et0: pick(cols.et0), tmean: pick(cols.tmean), lat, lon };
  }

  /* Producers first: gridMET, then NASA POWER daily; Open-Meteo's ECMWF daily only if both fail. */
  async function fetchMoisture(lat, lon, y0, y1) {
    const d0 = epochDay(y0, 0, 1), n = epochDay(y1, 11, 31) - d0 + 1;
    try {
      const j = Math.round((49.4 - lat) * 24), i = Math.round((lon + 124.7666666333) * 24); // 1/24° grid from 49.4N, 124.767W
      if (j < 0 || j > 584 || i < 0 || i > 1385) throw new Error("outside the gridMET domain");
      const d1 = Math.min(d0 + n - 1, Math.floor(Date.now() / 864e5) - 4); // gridMET lags a few days
      const [p, et0, tx, tn] = await Promise.all(["pr", "pet", "tmmx", "tmmn"].map(v => gridmetVar(v, j, i, d0, d1)));
      const days = Array.from({ length: d1 - d0 + 1 }, (_, k) => d0 + k);
      if (p.filter(v => v !== null && v !== undefined).length < n * 0.8) throw new Error("gridMET has no data at this point");
      const tmean = days.map((_, k) => (tx[k] == null || tn[k] == null ? null : (tx[k] + tn[k]) / 2 - 273.15));
      return align("gridmet", d0, n, days, { p, et0, tmean }, 49.4 - j / 24, -124.7666666333 + i / 24);
    } catch (e) {
      console.warn("gridMET unavailable, trying NASA POWER daily", e);
    }
    try {
      return await powerDaily(lat, lon, y0, y1, d0, n);
    } catch (e) {
      console.warn("NASA POWER daily unavailable, trying Open-Meteo daily", e);
    }
    const j = await fetchJSON(`${ARCHIVE}?${new URLSearchParams({
      latitude: lat.toFixed(4), longitude: lon.toFixed(4), start_date: `${y0}-01-01`, end_date: `${y1}-12-31`,
      daily: "precipitation_sum,et0_fao_evapotranspiration,temperature_2m_mean", timezone: "America/Chicago", timeformat: "unixtime",
    })}`, {}, 90000);
    const D = j.daily;
    return align("open-meteo", d0, n, D.time.map(t => stampDay(t, j.utc_offset_seconds)),
      { p: D.precipitation_sum, et0: D.et0_fao_evapotranspiration, tmean: D.temperature_2m_mean }, j.latitude, j.longitude);
  }

  /* FAO-56 daily grass reference ET0 (Allen et al. 1998, Eqs. 6–21, 37–40) from NASA POWER weather, which has
     no ET0 of its own. Days missing radiation, dew point or wind use Hargreaves–Samani (Eq. 52) instead. */
  function fao56(J, phi, z, tx, tn, td, u2, rs) {
    const es0 = T => 0.6108 * Math.exp((17.27 * T) / (T + 237.3));
    const dr = 1 + 0.033 * Math.cos(2 * Math.PI * J / 365), dec = 0.409 * Math.sin(2 * Math.PI * J / 365 - 1.39);
    const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(dec))));
    const Ra = (24 * 60 / Math.PI) * 0.082 * dr * (ws * Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.sin(ws));
    const T = (tx + tn) / 2;
    if (td === null || u2 === null || rs === null) return Math.max(0, 0.0023 * (Ra / 2.45) * (T + 17.8) * Math.sqrt(Math.max(tx - tn, 0)));
    const delta = (4098 * es0(T)) / (T + 237.3) ** 2;
    const gamma = 0.000665 * 101.3 * ((293 - 0.0065 * z) / 293) ** 5.26;
    const es = (es0(tx) + es0(tn)) / 2, ea = Math.min(es0(td), es);
    const rso = (0.75 + 2e-5 * z) * Ra;
    const rnl = 4.903e-9 * (((tx + 273.16) ** 4 + (tn + 273.16) ** 4) / 2) * (0.34 - 0.14 * Math.sqrt(ea))
      * (1.35 * Math.min(1, rso > 0 ? rs / rso : 1) - 0.35);
    const rn = 0.77 * rs - rnl; // albedo 0.23, soil heat flux G = 0 for daily steps
    return Math.max(0, (0.408 * delta * rn + gamma * (900 / (T + 273)) * u2 * (es - ea)) / (delta + gamma * (1 + 0.34 * u2)));
  }

  async function powerDaily(lat, lon, y0, y1, d0, n) {
    const q = new URLSearchParams({ parameters: "PRECTOTCORR,T2M,T2M_MAX,T2M_MIN,T2MDEW,WS2M,ALLSKY_SFC_SW_DWN", community: "AG",
      longitude: lon.toFixed(4), latitude: lat.toFixed(4), start: `${y0}0101`, end: `${y1}1231`, format: "JSON" });
    const res = await fetchJSON(`${POWER_D}?${q}`, {}, 90000, 20000);
    const P = res.properties.parameter, z = (res.geometry && res.geometry.coordinates[2]) || 0;
    const keys = Object.keys(P.T2M), fill = v => (v === undefined || v === -999 ? null : v);
    const days = keys.map(k => epochDay(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8)));
    const phi = lat * Math.PI / 180;
    const et0 = keys.map((k, i) => {
      const tx = fill(P.T2M_MAX[k]), tn = fill(P.T2M_MIN[k]);
      if (tx === null || tn === null) return null;
      const J = days[i] - epochDay(+k.slice(0, 4), 0, 1) + 1;
      return fao56(J, phi, z, tx, tn, fill(P.T2MDEW[k]), fill(P.WS2M[k]), fill(P.ALLSKY_SFC_SW_DWN[k]));
    });
    if (et0.filter(v => v !== null).length < n * 0.8) throw new Error("NASA POWER has too few days at this point");
    return align("nasa-power", d0, n, days, { p: keys.map(k => fill(P.PRECTOTCORR[k])), et0, tmean: keys.map(k => fill(P.T2M[k])) }, lat, lon);
  }

  /* Hourly wind from the chosen model plus daily moisture, on one local-day axis. If the chosen model errors or
     has not started answering within 20 s, the other one is used (NASA direct by default, Open-Meteo as backup). */
  async function fetchWind(lat, lon, nYears, model = "merra2") {
    const { start, end } = yearsFor(nYears);
    const moisture = fetchMoisture(lat, lon, start, end);
    const order = model === "merra2" ? [merraWind, ecmwfWind] : [ecmwfWind, merraWind];
    let w;
    try {
      w = await order[0](lat, lon, start, end, 20000);
    } catch (e) {
      console.warn(`${model} wind unavailable, trying the other model`, e);
      w = await order[1](lat, lon, start, end);
      w.fellBack = true;
    }
    const m = await moisture;
    const off = w.offset, t = m.p.map((_, k) => (m.d0 + k) * 86400 - off);
    return {
      source: "model", model: w.model, fellBack: !!w.fellBack,
      lat: w.lat, lon: w.lon, elevation: w.elevation, offset: off, start, end,
      hourly: w.hourly,
      moisture: { source: m.source, lat: m.lat, lon: m.lon },
      daily: {
        t, p: m.p, et0: m.et0, tmean: m.tmean,
        gust: t.map((_, k) => (w.gust ? w.gust.get(m.d0 + k) ?? null : null)),
        wmax: dailyMaxFromHourly(w.hourly.t, w.hourly.ws, off, t),
      },
    };
  }

  /* ------------ analysis ------------ */
  function analyze(raw, thr) {
    const H = raw.hourly, D = raw.daily, off = raw.offset || 0;
    const nYears = raw.end - raw.start + 1;
    const m = Array.from({ length: 12 }, () => ({ n: 0, sum: 0, ero: 0, energy: 0 }));
    const years = {};
    const rose = Array.from({ length: 16 }, () => [0, 0, 0, 0]); // all-winds count, then erosive bins
    const roseE = new Array(16).fill(0); // erosive energy by sector
    let dx = 0, dy = 0, totalE = 0, nAll = 0, dpSum = 0, fx = 0, fy = 0;
    const vt = 12; // knots, Fryberger threshold
    for (let i = 0; i < H.t.length; i++) {
      const u = H.ws[i], dir = H.wd[i];
      if (u === null || u === undefined) continue;
      const dt = new Date((H.t[i] + off) * 1000);
      const mo = dt.getUTCMonth(), yr = dt.getUTCFullYear();
      const M = m[mo];
      M.n++; M.sum += u; nAll++;
      const Y = years[yr] || (years[yr] = { n: 0, sum: 0, ero: 0, energy: 0 });
      Y.n++; Y.sum += u;
      const kn = u * 1.94384;
      if (kn > vt) {
        const q = kn * kn * (kn - vt);
        dpSum += q;
        if (dir !== null) { const r = (dir + 180) * Math.PI / 180; fx += q * Math.sin(r); fy += q * Math.cos(r); }
      }
      const sec = dir === null ? -1 : Math.round(dir / 22.5) % 16;
      if (sec >= 0) rose[sec][0]++;
      if (u >= thr) {
        const e = u * u * (u - thr);
        M.ero++; M.energy += e; Y.ero++; Y.energy += e; totalE += e;
        if (sec >= 0) {
          rose[sec][u < thr + 2 ? 1 : u < thr + 4 ? 2 : 3]++;
          roseE[sec] += e;
          // resultant transport toward the downwind direction
          const rad = (dir + 180) * Math.PI / 180;
          dx += e * Math.sin(rad); dy += e * Math.cos(rad);
        }
      }
    }

    // daily: moisture, gusts
    const dm = Array.from({ length: 12 }, () => ({ p: 0, et0: 0, gustDays: 0, wmax: 0, gmax: 0, nd: 0, nw: 0, ng: 0, t: 0 }));
    const yp = {};
    for (let i = 0; i < D.t.length; i++) {
      const dt = new Date((D.t[i] + off) * 1000);
      const mo = dt.getUTCMonth(), yr = dt.getUTCFullYear();
      const X = dm[mo];
      X.nd++;
      X.p += D.p[i] ?? 0; X.et0 += D.et0[i] ?? 0;
      X.t += D.tmean[i] ?? 0;
      if (D.wmax[i] !== null && D.wmax[i] !== undefined) { X.wmax += D.wmax[i]; X.nw++; }
      if (D.gust[i] !== null && D.gust[i] !== undefined) { X.gmax += D.gust[i]; X.ng++; if (D.gust[i] >= GUST_EVENT) X.gustDays++; }
      yp[yr] = yp[yr] || { p: 0, et0: 0 };
      yp[yr].p += D.p[i] ?? 0; yp[yr].et0 += D.et0[i] ?? 0;
    }

    const months = m.map((M, i) => {
      const X = dm[i];
      const P = X.p / nYears, ET = X.et0 / nYears;
      const dry = ET > 0 ? Math.min(1, Math.max(0, (ET - P) / ET)) : 1; // no moisture data: rank by wind energy alone
      const mean = M.n ? M.sum / M.n : 0;
      const u2 = mean * 0.748; // FAO-56 log-law 10 m -> 2 m
      // per-year values scaled by data coverage (station records have gaps)
      const energy = M.n ? (M.energy / M.n) * (DAYS[i] * 24) : 0;
      return {
        mean,
        eroHours: M.n ? (M.ero / M.n) * DAYS[i] * 24 : 0,
        eroPct: M.n ? (100 * M.ero) / M.n : 0,
        energy,
        index: energy * dry,
        dry, precip: P, et0: ET,
        meanDailyMax: X.nw ? X.wmax / X.nw : 0,
        meanDailyGust: X.ng ? X.gmax / X.ng : null,
        gustDays: X.ng ? (X.gustDays / X.ng) * DAYS[i] : null,
        tmean: X.nd ? X.t / X.nd : null,
        faoC: (u2 ** 3 * dry * DAYS[i]) / 100,
      };
    });
    const idxSum = months.reduce((a, b) => a + b.index, 0) || 1;
    months.forEach(M => {
      M.share = M.index / idxSum;
      M.level = M.share >= 0.1 ? "hi" : M.share >= 0.0667 ? "mid" : "lo";
    });

    // rose normalized to % of all hours
    const roseOut = rose.map((r, i) => ({
      dir: i * 22.5, all: (100 * r[0]) / Math.max(nAll, 1),
      bins: [r[1], r[2], r[3]].map(v => (100 * v) / Math.max(nAll, 1)),
    }));
    // prevailing erosive direction = sector carrying the most erosive energy, smoothed over neighbors
    let prevailing = 0, best = -1;
    roseE.forEach((_, i) => {
      const e3 = roseE[(i + 15) % 16] * 0.5 + roseE[i] + roseE[(i + 1) % 16] * 0.5;
      if (e3 > best) { best = e3; prevailing = i * 22.5; }
    });
    const rdd = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    const rdpRatio = totalE > 0 ? Math.hypot(dx, dy) / totalE : 0;

    const yrs = Object.keys(years).map(Number).sort();
    const annual = yrs.map(y => ({
      year: y, mean: years[y].sum / years[y].n, eroHours: (years[y].ero / years[y].n) * 8766,
      precip: yp[y] ? yp[y].p : null, et0: yp[y] ? yp[y].et0 : null,
    }));
    const trend = linreg(annual.map(a => a.year), annual.map(a => a.eroHours));
    const trendSpeed = linreg(annual.map(a => a.year), annual.map(a => a.mean));

    const annMean = nAll ? months.reduce((a, M, i) => a + M.mean * m[i].n, 0) / nAll : 0;
    const P = months.reduce((a, b) => a + b.precip, 0), ET = months.reduce((a, b) => a + b.et0, 0);
    return {
      thr, nYears, start: raw.start, end: raw.end, source: raw.source, model: raw.model, moisture: raw.moisture, station: raw.station || null,
      gridLat: raw.lat, gridLon: raw.lon, elevation: raw.elevation,
      months, rose: roseOut, prevailing, rdd, rdpRatio,
      annual, trend, trendSpeed,
      meanSpeed: annMean,
      eroHours: months.reduce((a, b) => a + b.eroHours, 0),
      gustDays: months.some(M => M.gustDays !== null) ? months.reduce((a, b) => a + (b.gustDays ?? 0), 0) : null,
      faoC: months.reduce((a, b) => a + b.faoC, 0),
      dp: dpSum / Math.max(nAll, 1), // Fryberger & Dean (1979) drift potential, vector units
      rdp: Math.hypot(fx, fy) / Math.max(nAll, 1),
      rddF: (Math.atan2(fx, fy) * 180 / Math.PI + 360) % 360,
      precip: P, et0: ET, aridity: ET > 0 ? P / ET : null,
      riskMonths: months.map((M, i) => (M.level === "hi" ? i : -1)).filter(i => i >= 0),
    };
  }

  /* ------------ nearest airport station (ASOS/AWOS) ------------ */
  const GHCNH = "https://www.ncei.noaa.gov/access/services/data/v1?dataset=global-historical-climatology-network-hourly";
  const IEM = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";
  const KT = 0.514444;
  const MAX_WS = 40, MAX_GUST = 55; // m/s plausibility limits for 2-min mean wind and gusts
  const BAD_QC = new Set(["2", "3", "6", "7"]); // NCEI quality codes: suspect or erroneous

  function km(la1, lo1, la2, lo2) {
    const r = Math.PI / 180;
    const a = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
  }

  /* Candidates within maxKm with data for the period. NWS/FAA ASOS sites rank ahead of AWOS by a 100 km
     handicap: in West Texas several AWOS anemometers read 40-60% fewer erosive hours than nearby ASOS. */
  function nearestStations(lat, lon, startYear, maxKm = 150, n = 6) {
    return (window.WE_STATIONS || [])
      .map(s => ({ id: s[0], name: s[1], lat: s[2], lon: s[3], begin: s[4], awos: !!s[5], ghcnh: s[6] || "", km: km(lat, lon, s[2], s[3]) }))
      .filter(s => s.km <= maxKm && s.begin <= startYear)
      .sort((a, b) => (a.km + (a.awos ? 100 : 0)) - (b.km + (b.awos ? 100 : 0)))
      .slice(0, n);
  }

  /* Hourly series from reports [unix s, ws, wd, gust]: the routine report nearest each whole hour, after QC. */
  function toHourly(rows, y0, y1) {
    const best = new Map();
    for (const [ts, ws, wd, gust] of rows) {
      if (!(ws >= 0 && ws <= MAX_WS)) continue; // garbled METARs (e.g. 250 kt) would swamp cubic energy sums
      const h = Math.round(ts / 3600) * 3600, dev = Math.abs(ts - h), cur = best.get(h);
      if (cur && cur[0] <= dev) continue;
      best.set(h, [dev, ws, ws === 0 || wd === null || wd > 360 ? null : wd, gust !== null && (gust > MAX_GUST || gust < ws) ? null : gust]);
    }
    const t = [...best.keys()].sort((a, b) => a - b);
    const expected = (Date.UTC(y1 + 1, 0, 1) - Date.UTC(y0, 0, 1)) / 3.6e6;
    return { t, ws: t.map(k => best.get(k)[1]), wd: t.map(k => best.get(k)[2]), gust: t.map(k => best.get(k)[3]), coverage: t.length / expected };
  }

  /* NOAA NCEI Global Historical Climatology Network hourly: routine METARs (FM-15), one request per year. */
  async function ghcnhObs(st, y0, y1) {
    const years = Array.from({ length: y1 - y0 + 1 }, (_, k) => y0 + k);
    const texts = await pool(years, 6, y => fetchText(`${GHCNH}&stations=${st.ghcnh}&startDate=${y}-01-01&endDate=${y}-12-31` +
      "&dataTypes=Year,Month,Day,Hour,Minute,wind_speed,wind_direction,wind_gust,wind_speed_Quality_Code,wind_gust_Quality_Code," +
      "wind_speed_Report_Type&format=csv", 60000));
    const rows = [];
    for (const text of texts) {
      const lines = text.split("\n"), h = lines[0].replace(/"/g, "").split(",");
      const I = Object.fromEntries(h.map((k, i) => [k.trim(), i]));
      for (let k = 1; k < lines.length; k++) {
        const f = lines[k].replace(/"/g, "").split(",");
        if (f.length < h.length || f[I.wind_speed] === "" || f[I.wind_speed_Report_Type] !== "FM15" || BAD_QC.has(f[I.wind_speed_Quality_Code])) continue;
        const g = f[I.wind_gust] === "" || BAD_QC.has(f[I.wind_gust_Quality_Code]) ? null : +f[I.wind_gust];
        rows.push([Date.UTC(+f[I.Year], +f[I.Month] - 1, +f[I.Day], +f[I.Hour], +f[I.Minute]) / 1000,
          +f[I.wind_speed], f[I.wind_direction] === "" ? null : +f[I.wind_direction], g]);
      }
    }
    return { ...toHourly(rows, y0, y1), source: "ncei" };
  }

  /* Iowa Environmental Mesonet ASOS archive (NWS METAR feed): routine reports, knots. */
  async function iemObs(st, y0, y1) {
    const q = `station=${encodeURIComponent(st.id)}&data=sknt&data=drct&data=gust&year1=${y0}&month1=1&day1=1&year2=${y1 + 1}` +
      "&month2=1&day2=1&tz=Etc/UTC&format=onlycomma&latlon=no&missing=null&trace=null&direct=no&report_type=3";
    const rows = [];
    (await fetchText(`${IEM}?${q}`, 60000)).split("\n").slice(1).forEach(l => {
      const f = l.split(",");
      if (f.length < 5 || f[2] === "null" || f[2] === "") return;
      const v = f[1];
      rows.push([Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10), +v.slice(11, 13), +v.slice(14, 16)) / 1000,
        +f[2] * KT, f[3] === "null" ? null : +f[3], f[4] && f[4].trim() !== "null" ? +f[4] * KT : null]);
    });
    return { ...toHourly(rows, y0, y1), source: "iem" };
  }

  async function fetchStationObs(st, y0, y1, minCov) {
    if (st.ghcnh) {
      try {
        const o = await ghcnhObs(st, y0, y1);
        if (o.coverage >= minCov) return o;
        console.warn(`GHCNh ${st.ghcnh} covers ${Math.round(o.coverage * 100)}% of hours, trying IEM`);
      } catch (e) {
        console.warn("GHCNh unavailable, trying IEM", st.id, e);
      }
    }
    return iemObs(st, y0, y1);
  }

  /* First candidate with enough data, or the station the user picked (onlyId). Observations only. */
  async function findStation(lat, lon, nYears, onlyId) {
    const { start, end } = yearsFor(nYears);
    const minCov = onlyId ? 0.2 : 0.6; // part-time AWOS records are too gappy unless picked
    const cands = nearestStations(lat, lon, start).filter(s => !onlyId || s.id === onlyId);
    for (const st of cands) {
      try {
        const obs = await fetchStationObs(st, start, end, minCov);
        if (obs.coverage < minCov) continue;
        return { meta: { ...st, coverage: obs.coverage, obsSource: obs.source }, obs };
      } catch (e) {
        console.warn("station skipped", st.id, e);
      }
    }
    return null;
  }

  /* The site's gridded model at the station, to train the calibration (light request).
     days are local epoch days; for MERRA-2 the daily "gust" is the daily max hourly wind. */
  async function fetchModelAt(model, lat, lon, y0, y1) {
    if (model === "merra2") {
      const w = await merraWind(lat, lon, y0, y1), mx = new Map();
      w.hourly.t.forEach((t, i) => {
        const u = w.hourly.ws[i];
        if (u !== null) mx.set(dayKey(t, CST), Math.max(mx.get(dayKey(t, CST)) ?? 0, u));
      });
      return { t: w.hourly.t, ws: w.hourly.ws, days: [...mx.keys()], gust: [...mx.values()] };
    }
    const j = await fetchJSON(`${ARCHIVE}?${new URLSearchParams({
      latitude: lat.toFixed(4), longitude: lon.toFixed(4), start_date: `${y0}-01-01`, end_date: `${y1}-12-31`,
      hourly: "wind_speed_10m", daily: "wind_gusts_10m_max", wind_speed_unit: "ms",
      timezone: "America/Chicago", timeformat: "unixtime",
    })}`, {}, 90000);
    return { t: j.hourly.time, ws: j.hourly.wind_speed_10m, days: j.daily.time.map(t => stampDay(t, j.utc_offset_seconds)), gust: j.daily.wind_gusts_10m_max };
  }

  /* ---- monthly empirical quantile mapping: reanalysis at the station -> station observations ----
     Quantiles span 0.1-99.9% so single bad reports can't set the tails; beyond them the end ratio is used. */
  const QN = 101, QLO = 0.001, QHI = 0.999;
  function quantiles(arr) {
    const s = arr.filter(v => v !== null && v !== undefined).sort((a, b) => a - b);
    if (s.length < 50) return null;
    return Array.from({ length: QN }, (_, k) => {
      const p = (QLO + (k / (QN - 1)) * (QHI - QLO)) * (s.length - 1), i = Math.floor(p), f = p - i;
      return s[i] + (i + 1 < s.length ? (s[i + 1] - s[i]) * f : 0);
    });
  }
  function mapper(qm, qo) {
    if (!qm || !qo) return x => x;
    return x => {
      if (x === null || x === undefined) return x;
      if (x <= qm[0]) return qm[0] > 0 ? (x * qo[0]) / qm[0] : qo[0];
      if (x >= qm[QN - 1]) return qm[QN - 1] > 0 ? (x * qo[QN - 1]) / qm[QN - 1] : x;
      let lo = 0, hi = QN - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (qm[mid] <= x) lo = mid; else hi = mid; }
      const span = qm[hi] - qm[lo];
      return qo[lo] + (span > 0 ? (x - qm[lo]) / span : 0.5) * (qo[hi] - qo[lo]);
    };
  }
  /* Daily maxima of station observations keyed by local day; days with < 18 reports are skipped. */
  function stationDaily(obs, off) {
    const d = new Map();
    obs.t.forEach((t, i) => {
      const k = dayKey(t, off);
      const r = d.get(k) || { n: 0, wmax: 0, gmax: 0 };
      r.n++;
      r.wmax = Math.max(r.wmax, obs.ws[i]);
      r.gmax = Math.max(r.gmax, obs.gust[i] ?? obs.ws[i]);
      d.set(k, r);
    });
    for (const [k, r] of d) if (r.n < 18) d.delete(k);
    return d;
  }

  function trainMappers(st, off) {
    const modByT = new Map(st.mod.t.map((t, i) => [t, st.mod.ws[i]]));
    const mm = Array.from({ length: 12 }, () => []), mo = Array.from({ length: 12 }, () => []);
    st.obs.t.forEach((t, i) => {
      const x = modByT.get(t);
      if (x === null || x === undefined) return;
      const m = monthOf(t, off);
      mm[m].push(x);
      mo[m].push(st.obs.ws[i]);
    });
    const sd = stationDaily(st.obs, off);
    const gm = Array.from({ length: 12 }, () => []), go = Array.from({ length: 12 }, () => []);
    st.mod.days.forEach((d, i) => {
      const r = sd.get(d), x = st.mod.gust[i];
      if (!r || x === null || x === undefined) return;
      const m = new Date(d * 864e5).getUTCMonth();
      gm[m].push(x);
      go[m].push(r.gmax);
    });
    return {
      hourly: mm.map((a, m) => mapper(quantiles(a), quantiles(mo[m]))),
      gust: gm.map((a, m) => mapper(quantiles(a), quantiles(go[m]))),
    };
  }

  function dailyMaxFromHourly(t, ws, off, dailyT) {
    const mx = new Map();
    t.forEach((tt, i) => {
      if (ws[i] === null || ws[i] === undefined) return;
      const k = dayKey(tt, off);
      mx.set(k, Math.max(mx.get(k) ?? 0, ws[i]));
    });
    return dailyT.map(d => mx.get(dayKey(d, off)) ?? null);
  }

  /* Site series with the station's monthly speed distribution and the reanalysis timing and direction.
     Mappers are trained on reanalysis at the station vs. the station, then applied to reanalysis at the site,
     so the model's site-vs-station difference is kept. */
  function calibrate(raw, st) {
    const off = raw.offset || 0;
    const M = trainMappers(st, off);
    const ws = raw.hourly.ws.map((u, i) => (u === null || u === undefined ? u : M.hourly[monthOf(raw.hourly.t[i], off)](u)));
    const g0 = raw.model === "merra2" ? raw.daily.wmax : raw.daily.gust; // MERRA-2: daily max wind stands in for gusts
    return {
      ...raw, source: "calibrated", station: st.meta,
      hourly: { ...raw.hourly, ws },
      daily: {
        ...raw.daily,
        wmax: dailyMaxFromHourly(raw.hourly.t, ws, off, raw.daily.t),
        gust: g0.map((g, i) => (g === null || g === undefined ? g : M.gust[monthOf(raw.daily.t[i], off)](g))),
      },
    };
  }

  /* Station observations alone (daily moisture still from gridMET or its fallback at the site). */
  function stationRaw(raw, st) {
    const off = raw.offset || 0;
    const sd = stationDaily(st.obs, off);
    return {
      ...raw, source: "station", station: st.meta, lat: st.meta.lat, lon: st.meta.lon,
      hourly: { t: st.obs.t, ws: st.obs.ws, wd: st.obs.wd },
      daily: {
        ...raw.daily,
        wmax: raw.daily.t.map(d => (sd.get(dayKey(d, off)) || {}).wmax ?? null),
        gust: raw.daily.t.map(d => (sd.get(dayKey(d, off)) || {}).gmax ?? null),
      },
    };
  }

  /* Reanalysis vs. station at the station location, same hours. */
  function compare(st, thr) {
    const modByT = new Map(st.mod.t.map((t, i) => [t, st.mod.ws[i]]));
    let n = 0, so = 0, sm = 0, soo = 0, smm = 0, som = 0, se = 0, eo = 0, em = 0;
    st.obs.t.forEach((t, i) => {
      const x = modByT.get(t);
      if (x === null || x === undefined) return;
      const y = st.obs.ws[i];
      n++; so += y; sm += x; soo += y * y; smm += x * x; som += x * y; se += (x - y) ** 2;
      if (y >= thr) eo++;
      if (x >= thr) em++;
    });
    if (!n) return null;
    const mo = so / n, mm = sm / n;
    const r = (som / n - mo * mm) / Math.sqrt((soo / n - mo * mo) * (smm / n - mm * mm));
    return { n, meanObs: mo, meanMod: mm, bias: mm - mo, rmse: Math.sqrt(se / n), r, freqObs: eo / n, freqMod: em / n };
  }

  return { fetchWind, analyze, yearsFor, findStation, fetchModelAt, calibrate, stationRaw, compare, nearestStations };
})();

