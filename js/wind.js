/* Wind: hourly reanalysis (Open-Meteo: ECMWF IFS 9 km from 2017, ERA5 before), calibrated to the
   nearest airport station (ASOS/AWOS via Iowa Environmental Mesonet), and erosion-climate analysis. */
WG.wind = (function () {
  const { fetchJSON, linreg } = WG.util;
  const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
  const POWER = "https://power.larc.nasa.gov/api/temporal/daily/point";
  const DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const GUST_EVENT = 17.9; // m/s (40 mph) daily max gust ~ blowing-dust days

  function yearsFor(n) {
    const end = new Date().getFullYear() - 1; // last complete year
    return { start: end - n + 1, end };
  }

  async function fetchArchive(lat, lon, y0, y1) {
    const q = new URLSearchParams({
      latitude: lat.toFixed(4), longitude: lon.toFixed(4),
      start_date: `${y0}-01-01`, end_date: `${y1}-12-31`,
      hourly: "wind_speed_10m,wind_direction_10m",
      daily: "precipitation_sum,et0_fao_evapotranspiration,wind_gusts_10m_max",
      wind_speed_unit: "ms", timezone: "America/Chicago", timeformat: "unixtime",
    });
    return fetchJSON(`${ARCHIVE}?${q}`, {}, 90000);
  }

  /* Split long periods into parallel chunks to cut wall-clock time. */
  async function fetchWind(lat, lon, nYears) {
    const { start, end } = yearsFor(nYears);
    const chunk = nYears > 6 ? Math.ceil(nYears / 2) : nYears;
    const spans = [];
    for (let y = start; y <= end; y += chunk) spans.push([y, Math.min(end, y + chunk - 1)]);
    const parts = await Promise.all(spans.map(([a, b]) => fetchArchive(lat, lon, a, b)));
    const cat = (k, sect) => parts.flatMap(p => p[sect][k]);
    const off = parts[0].utc_offset_seconds;
    const hourly = { t: cat("time", "hourly"), ws: cat("wind_speed_10m", "hourly"), wd: cat("wind_direction_10m", "hourly") };
    const dt = cat("time", "daily");
    return {
      source: "open-meteo",
      lat: parts[0].latitude, lon: parts[0].longitude, elevation: parts[0].elevation,
      offset: off,
      start, end,
      hourly,
      daily: {
        t: dt, p: cat("precipitation_sum", "daily"), et0: cat("et0_fao_evapotranspiration", "daily"),
        gust: cat("wind_gusts_10m_max", "daily"), wmax: dailyMaxFromHourly(hourly.t, hourly.ws, off, dt), tmean: dt.map(() => null),
      },
    };
  }

  /* Fallback: NASA POWER daily point data (MERRA-2, ~50 km). No hourly → daily mean wind, no direction rose detail. */
  async function fetchPower(lat, lon, nYears) {
    const { start, end } = yearsFor(nYears);
    const q = new URLSearchParams({
      parameters: "WS10M,WS10M_MAX,WD10M,PRECTOTCORR,T2M,T2M_MAX,T2M_MIN", community: "AG",
      longitude: lon.toFixed(4), latitude: lat.toFixed(4), start: `${start}0101`, end: `${end}1231`, format: "JSON",
    });
    const j = await fetchJSON(`${POWER}?${q}`, {}, 90000);
    const P = j.properties.parameter;
    const keys = Object.keys(P.WS10M);
    const t = keys.map(k => Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8)) / 1000);
    const fill = v => (v === -999 ? null : v);
    // Hargreaves–Samani ET0 with FAO-56 extraterrestrial radiation
    const phi = lat * Math.PI / 180;
    const hargreaves = (k, i) => {
      const tx = fill(P.T2M_MAX[k]), tn = fill(P.T2M_MIN[k]), tm = fill(P.T2M[k]);
      if (tx === null || tn === null || tm === null) return null;
      const J = Math.floor((t[i] * 1000 - Date.UTC(+k.slice(0, 4), 0, 0)) / 864e5);
      const dr = 1 + 0.033 * Math.cos(2 * Math.PI * J / 365), dec = 0.409 * Math.sin(2 * Math.PI * J / 365 - 1.39);
      const ws = Math.acos(Math.max(-1, Math.min(1, -Math.tan(phi) * Math.tan(dec))));
      const Ra = (24 * 60 / Math.PI) * 0.082 * dr * (ws * Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.sin(ws));
      return Math.max(0, 0.0023 * (Ra / 2.45) * (tm + 17.8) * Math.sqrt(Math.max(tx - tn, 0)));
    };
    return {
      source: "nasa-power", lat, lon, elevation: j.geometry.coordinates[2], offset: 0, start, end,
      hourly: { t, ws: keys.map(k => fill(P.WS10M[k])), wd: keys.map(k => fill(P.WD10M[k])) },
      daily: {
        t, p: keys.map(k => fill(P.PRECTOTCORR[k])),
        et0: keys.map(hargreaves),
        gust: keys.map(k => fill(P.WS10M_MAX[k]) * 1.4), wmax: keys.map(k => fill(P.WS10M_MAX[k])), tmean: keys.map(k => fill(P.T2M[k])),
      },
      dailyOnly: true,
    };
  }

  /* ------------ analysis ------------ */
  function analyze(raw, thr) {
    const H = raw.hourly, D = raw.daily, off = raw.offset || 0;
    const nYears = raw.end - raw.start + 1;
    const hoursPer = raw.dailyOnly ? 24 : 1; // each record represents this many hours
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
      const dry = ET > 0 ? Math.min(1, Math.max(0, (ET - P) / ET)) : 0;
      const mean = M.n ? M.sum / M.n : 0;
      const u2 = mean * 0.748; // FAO-56 log-law 10 m -> 2 m
      // per-year values scaled by data coverage (station records have gaps)
      const energy = M.n ? (M.energy / M.n) * (DAYS[i] * 24) / hoursPer : 0;
      return {
        mean,
        eroHours: M.n ? (M.ero / M.n) * DAYS[i] * 24 : 0,
        eroPct: M.n ? (100 * M.ero) / M.n : 0,
        energy,
        index: energy * dry,
        dry, precip: P, et0: ET,
        meanDailyMax: X.nw ? X.wmax / X.nw : 0,
        meanDailyGust: X.ng ? X.gmax / X.ng : 0,
        gustDays: X.ng ? (X.gustDays / X.ng) * DAYS[i] : 0,
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
      thr, nYears, start: raw.start, end: raw.end, source: raw.source, dailyOnly: !!raw.dailyOnly, station: raw.station || null,
      gridLat: raw.lat, gridLon: raw.lon, elevation: raw.elevation,
      months, rose: roseOut, prevailing, rdd, rdpRatio,
      annual, trend, trendSpeed,
      meanSpeed: annMean,
      eroHours: months.reduce((a, b) => a + b.eroHours, 0),
      gustDays: months.reduce((a, b) => a + b.gustDays, 0),
      faoC: months.reduce((a, b) => a + b.faoC, 0),
      dp: raw.dailyOnly ? null : dpSum / nAll, // Fryberger & Dean (1979) drift potential, vector units
      rdp: raw.dailyOnly ? null : Math.hypot(fx, fy) / nAll,
      rddF: (Math.atan2(fx, fy) * 180 / Math.PI + 360) % 360,
      precip: P, et0: ET, aridity: ET > 0 ? P / ET : null,
      riskMonths: months.map((M, i) => (M.level === "hi" ? i : -1)).filter(i => i >= 0),
    };
  }

  /* ------------ nearest airport station (ASOS/AWOS, Iowa Environmental Mesonet) ------------ */
  const IEM = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py";
  const KT = 0.514444;
  const MAX_WS = 40, MAX_GUST = 55; // m/s plausibility limits for 2-min mean wind and gusts

  function km(la1, lo1, la2, lo2) {
    const r = Math.PI / 180;
    const a = Math.sin((la2 - la1) * r / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin((lo2 - lo1) * r / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
  }

  /* Candidates within maxKm with data for the period. NWS/FAA ASOS sites rank ahead of AWOS by a 100 km
     handicap: in West Texas several AWOS anemometers read 40-60% fewer erosive hours than nearby ASOS. */
  function nearestStations(lat, lon, startYear, maxKm = 150, n = 6) {
    return (window.WE_STATIONS || [])
      .map(s => ({ id: s[0], name: s[1], lat: s[2], lon: s[3], begin: s[4], awos: !!s[5], km: km(lat, lon, s[2], s[3]) }))
      .filter(s => s.km <= maxKm && s.begin <= startYear)
      .sort((a, b) => (a.km + (a.awos ? 100 : 0)) - (b.km + (b.awos ? 100 : 0)))
      .slice(0, n);
  }

  /* Routine hourly METARs (2-min mean wind at 10 m), rounded to the nearest hour, UTC unix seconds. */
  async function fetchStationObs(st, y0, y1) {
    const q = `station=${encodeURIComponent(st.id)}&data=sknt&data=drct&data=gust&year1=${y0}&month1=1&day1=1&year2=${y1 + 1}` +
      "&month2=1&day2=1&tz=Etc/UTC&format=onlycomma&latlon=no&missing=null&trace=null&direct=no&report_type=3";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let text;
    try {
      const r = await fetch(`${IEM}?${q}`, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`station ${st.id}: ${r.status}`);
      text = await r.text();
    } finally {
      clearTimeout(timer);
    }
    const seen = new Map();
    const lines = text.split("\n");
    for (let i = 1; i < lines.length; i++) {
      const f = lines[i].split(",");
      if (f.length < 5 || f[2] === "null" || f[2] === "") continue;
      const v = f[1];
      const ts = Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10), +v.slice(11, 13), +v.slice(14, 16)) / 1000;
      const t = Math.round(ts / 3600) * 3600;
      if (seen.has(t)) continue;
      const ws = +f[2] * KT;
      if (!(ws >= 0 && ws <= MAX_WS)) continue; // QC: garbled METARs (e.g. 250 kt) would swamp cubic energy sums
      const wd = f[3] === "null" || ws === 0 ? null : +f[3];
      let gust = f[4] && f[4].trim() !== "null" ? +f[4] * KT : null;
      if (gust !== null && (gust > MAX_GUST || gust < ws)) gust = null;
      seen.set(t, [ws, wd, gust]);
    }
    const t = [...seen.keys()].sort((a, b) => a - b);
    const expected = (Date.UTC(y1 + 1, 0, 1) - Date.UTC(y0, 0, 1)) / 3.6e6;
    return {
      t, ws: t.map(k => seen.get(k)[0]), wd: t.map(k => seen.get(k)[1]), gust: t.map(k => seen.get(k)[2]),
      coverage: t.length / expected,
    };
  }

  /* Reanalysis at the station's location, used only to train the calibration (light request). */
  async function fetchModelAt(lat, lon, y0, y1) {
    const q = new URLSearchParams({
      latitude: lat.toFixed(4), longitude: lon.toFixed(4), start_date: `${y0}-01-01`, end_date: `${y1}-12-31`,
      hourly: "wind_speed_10m", daily: "wind_gusts_10m_max", wind_speed_unit: "ms",
      timezone: "America/Chicago", timeformat: "unixtime",
    });
    const j = await fetchJSON(`${ARCHIVE}?${q}`, {}, 90000);
    return { t: j.hourly.time, ws: j.hourly.wind_speed_10m, dt: j.daily.time, gust: j.daily.wind_gusts_10m_max };
  }

  /* First usable candidate, or the station the user picked (onlyId). */
  async function findStation(lat, lon, nYears, onlyId) {
    const { start, end } = yearsFor(nYears);
    const cands = nearestStations(lat, lon, start).filter(s => !onlyId || s.id === onlyId);
    for (const st of cands) {
      try {
        const [obs, mod] = await Promise.all([fetchStationObs(st, start, end), fetchModelAt(st.lat, st.lon, start, end)]);
        if (obs.coverage < (onlyId ? 0.2 : 0.6)) continue; // too gappy (e.g. part-time AWOS)
        return { meta: { ...st, coverage: obs.coverage }, obs, mod };
      } catch (e) {
        if (/limit/i.test(e.message || "")) throw e; // API quota: retrying other stations won't help
        console.warn("station skipped", st.id, e);
      }
    }
    return null;
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
  const monthOf = (t, off) => new Date((t + off) * 1000).getUTCMonth();
  const dayKey = (t, off) => Math.floor((t + off) / 86400);

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
    st.mod.dt.forEach((t, i) => {
      const r = sd.get(dayKey(t, off)), x = st.mod.gust[i];
      if (!r || x === null || x === undefined) return;
      const m = monthOf(t, off);
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
    return {
      ...raw, source: "calibrated", station: st.meta,
      hourly: { ...raw.hourly, ws },
      daily: {
        ...raw.daily,
        wmax: dailyMaxFromHourly(raw.hourly.t, ws, off, raw.daily.t),
        gust: raw.daily.gust.map((g, i) => (g === null || g === undefined ? g : M.gust[monthOf(raw.daily.t[i], off)](g))),
      },
    };
  }

  /* Station observations alone (moisture still from the reanalysis at the site). */
  function stationRaw(raw, st) {
    const off = raw.offset || 0;
    const sd = stationDaily(st.obs, off);
    return {
      ...raw, source: "station", station: st.meta, lat: st.meta.lat, lon: st.meta.lon, dailyOnly: false,
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

  return { fetchWind, fetchPower, analyze, yearsFor, findStation, calibrate, stationRaw, compare, nearestStations };
})();

