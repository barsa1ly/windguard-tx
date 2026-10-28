/* Shared helpers. All modules hang off window.WG. */
window.WG = window.WG || {};

WG.util = (function () {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December"];
  const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function fmt(v, d = 1, dash = "—") {
    const n = num(v);
    return n === null ? dash : n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const msToMph = v => v * 2.23694;
  const compass = deg => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

  async function fetchJSON(url, opts = {}, timeoutMs = 45000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      if (!r.ok) {
        let msg = r.status + " " + r.statusText;
        try { const j = await r.json(); msg = j.reason || j.message || msg; } catch (e) { /* not json */ }
        throw new Error(msg);
      }
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  /* Parse "32.7, -101.9", "32.7 N 101.9 W", or DMS "32°44'9\"N 101°57'18\"W". */
  function parseCoords(text) {
    if (!text) return null;
    const s = text.trim().toUpperCase().replace(/[′’']/g, "'").replace(/[″”"]/g, '"');
    const dms = /(-?\d+(?:\.\d+)?)\s*[°D\s]\s*(?:(\d+(?:\.\d+)?)\s*['M\s]\s*)?(?:(\d+(?:\.\d+)?)\s*["S]?\s*)?([NSEW])?/g;
    const parts = [];
    let m;
    while ((m = dms.exec(s)) && parts.length < 2) {
      if (m[0].trim() === "") { dms.lastIndex++; continue; }
      let v = Math.abs(parseFloat(m[1])) + (m[2] ? parseFloat(m[2]) / 60 : 0) + (m[3] ? parseFloat(m[3]) / 3600 : 0);
      if (m[1].startsWith("-")) v = -v;
      parts.push({ v, h: m[4] || null });
    }
    if (parts.length !== 2) {
      const plain = s.match(/(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/);
      if (!plain) return null;
      parts.length = 0;
      parts.push({ v: parseFloat(plain[1]), h: null }, { v: parseFloat(plain[2]), h: null });
    }
    let [a, b] = parts;
    // hemisphere letters decide order/sign
    if (a.h === "E" || a.h === "W") [a, b] = [b, a];
    let lat = a.v, lon = b.v;
    if (a.h === "S") lat = -Math.abs(lat);
    if (b.h === "W") lon = -Math.abs(lon);
    if (b.h === "E") lon = Math.abs(lon);
    // US users often omit the minus on longitude
    if (!b.h && lon > 60 && lon < 130 && lat > 15 && lat < 50) lon = -lon;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  function toast(msg, ms = 3500) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, ms);
  }

  function download(name, text, type = "text/plain") {
    const blob = new Blob([text], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* Ordinary least squares with a two-sided t-test on the slope. */
  function linreg(xs, ys) {
    const n = xs.length;
    if (n < 3) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2;
    }
    const slope = sxy / sxx;
    const icpt = my - slope * mx;
    const sse = Math.max(syy - slope * sxy, 0);
    const se = Math.sqrt(sse / (n - 2) / sxx);
    const t = se > 0 ? slope / se : 0;
    const TCRIT = [0, 12.71, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179,
      2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
    const tc = TCRIT[Math.min(n - 2, 30)] || 2.0;
    return { slope, icpt, t, significant: Math.abs(t) > tc, r2: syy > 0 ? (slope * sxy) / syy : 0 };
  }

  /* Small JSON cache in localStorage; failures are silently ignored. */
  const cache = {
    get(key) {
      try { const s = localStorage.getItem("wg:" + key); return s ? JSON.parse(s) : null; } catch (e) { return null; }
    },
    set(key, val) {
      try { localStorage.setItem("wg:" + key, JSON.stringify(val)); } catch (e) { /* quota/private mode */ }
    },
  };

  return { MONTHS, MONTHS_LONG, COMPASS, $, $$, esc, num, fmt, clamp, msToMph, compass, fetchJSON, debounce,
    parseCoords, toast, download, linreg, cache };
})();
