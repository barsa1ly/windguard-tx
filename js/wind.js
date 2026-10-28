/* Wind: historical hourly reanalysis (Open-Meteo / ERA5) and erosion-climate analysis. */
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
      daily: "precipitation_sum,et0_fao_evapotranspiration,wind_gusts_10m_max,wind_speed_10m_max,temperature_2m_mean",
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
    return {
      source: "open-meteo",
      lat: parts[0].latitude, lon: parts[0].longitude, elevation: parts[0].elevation,
      offset: parts[0].utc_offset_seconds,
      start, end,
      hourly: { t: cat("time", "hourly"), ws: cat("wind_speed_10m", "hourly"), wd: cat("wind_direction_10m", "hourly") },
      daily: {
        t: cat("time", "daily"), p: cat("precipitation_sum", "daily"), et0: cat("et0_fao_evapotranspiration", "daily"),
        gust: cat("wind_gusts_10m_max", "daily"), wmax: cat("wind_speed_10m_max", "daily"), tmean: cat("temperature_2m_mean", "daily"),
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
          // resultant transport toward the downwind direction
          const rad = (dir + 180) * Math.PI / 180;
          dx += e * Math.sin(rad); dy += e * Math.cos(rad);
        }
      }
    }

    // daily: moisture, gusts
    const dm = Array.from({ length: 12 }, () => ({ p: 0, et0: 0, gustDays: 0, wmax: 0, gmax: 0, nd: 0, t: 0 }));
    const yp = {};
    for (let i = 0; i < D.t.length; i++) {
      const dt = new Date((D.t[i] + off) * 1000);
      const mo = dt.getUTCMonth(), yr = dt.getUTCFullYear();
      const X = dm[mo];
      X.nd++;
      X.p += D.p[i] ?? 0; X.et0 += D.et0[i] ?? 0;
      X.wmax += D.wmax[i] ?? 0; X.gmax += D.gust[i] ?? 0; X.t += D.tmean[i] ?? 0;
      if ((D.gust[i] ?? 0) >= GUST_EVENT) X.gustDays++;
      yp[yr] = yp[yr] || { p: 0, et0: 0 };
      yp[yr].p += D.p[i] ?? 0; yp[yr].et0 += D.et0[i] ?? 0;
    }

    const months = m.map((M, i) => {
      const X = dm[i];
      const P = X.p / nYears, ET = X.et0 / nYears;
      const dry = ET > 0 ? Math.min(1, Math.max(0, (ET - P) / ET)) : 0;
      const mean = M.n ? M.sum / M.n : 0;
      const u2 = mean * 0.748; // FAO-56 log-law 10 m -> 2 m
      return {
        mean,
        eroHours: (M.ero * hoursPer) / nYears,
        eroPct: M.n ? (100 * M.ero) / M.n : 0,
        energy: M.energy / nYears,
        index: (M.energy / nYears) * dry,
        dry, precip: P, et0: ET,
        meanDailyMax: X.nd ? X.wmax / X.nd : 0,
        meanDailyGust: X.nd ? X.gmax / X.nd : 0,
        gustDays: X.gustDays / nYears,
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
    let prevailing = 0, best = -1;
    // prevailing erosive direction = sector with most erosive energy proxy (counts in high bins weighted)
    roseOut.forEach((r, i) => { const s = r.bins[0] + 2 * r.bins[1] + 3 * r.bins[2]; if (s > best) { best = s; prevailing = i * 22.5; } });
    const rdd = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
    const rdpRatio = totalE > 0 ? Math.hypot(dx, dy) / totalE : 0;

    const yrs = Object.keys(years).map(Number).sort();
    const annual = yrs.map(y => ({
      year: y, mean: years[y].sum / years[y].n, eroHours: years[y].ero * hoursPer,
      precip: yp[y] ? yp[y].p : null, et0: yp[y] ? yp[y].et0 : null,
    }));
    const trend = linreg(annual.map(a => a.year), annual.map(a => a.eroHours));
    const trendSpeed = linreg(annual.map(a => a.year), annual.map(a => a.mean));

    const annMean = nAll ? months.reduce((a, M, i) => a + M.mean * m[i].n, 0) / nAll : 0;
    const P = months.reduce((a, b) => a + b.precip, 0), ET = months.reduce((a, b) => a + b.et0, 0);
    return {
      thr, nYears, start: raw.start, end: raw.end, source: raw.source, dailyOnly: !!raw.dailyOnly,
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

  return { fetchWind, fetchPower, analyze, yearsFor };
})();
