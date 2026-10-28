/* Charts: Chart.js for series, hand-drawn SVG for the wind rose and risk gauge. */
WG.charts = (function () {
  const { MONTHS, msToMph, fmt } = WG.util;
  const C = {
    red: "#c8372d", amber: "#e7a33a", gray: "#c9cbc3", ink: "#1c2420", muted: "#69716a", line: "#ebe8df",
    blue: "#2f6f9f", sky: "#7fb0d6", orange: "#d9772f", green: "#3f8f5a",
  };
  const charts = {};

  if (window.Chart) {
    Chart.defaults.font.family = "Inter, system-ui, sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.color = C.muted;
    Chart.defaults.borderColor = C.line;
    Chart.defaults.plugins.legend.labels.boxWidth = 10;
    Chart.defaults.plugins.legend.labels.boxHeight = 10;
    Chart.defaults.plugins.tooltip.backgroundColor = "rgba(28,36,32,.92)";
    Chart.defaults.plugins.tooltip.padding = 8;
    Chart.defaults.animation.duration = 350;
  }

  function draw(id, config) {
    if (charts[id]) charts[id].destroy();
    const el = document.getElementById(id);
    if (!el || !window.Chart) return;
    charts[id] = new Chart(el, config);
  }

  const conv = units => (units === "mph" ? msToMph : v => v);
  const levelColor = l => (l === "hi" ? C.red : l === "mid" ? C.amber : C.gray);

  function season(a, units) {
    const cv = conv(units);
    draw("chSeason", {
      data: {
        labels: MONTHS,
        datasets: [
          { type: "bar", label: "Erosive wind hours", data: a.months.map(m => +m.eroHours.toFixed(1)),
            backgroundColor: a.months.map(m => levelColor(m.level)), borderRadius: 5, yAxisID: "y", order: 2 },
          { type: "line", label: `Mean wind (${units})`, data: a.months.map(m => +cv(m.mean).toFixed(1)),
            borderColor: C.ink, backgroundColor: C.ink, borderWidth: 2, pointRadius: 2.5, tension: .35, yAxisID: "y1", order: 1 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              afterBody: items => {
                const m = a.months[items[0].dataIndex];
                return [`Share of annual risk: ${(m.share * 100).toFixed(0)}%`, `Dryness (1 − P/ET₀): ${m.dry.toFixed(2)}`];
              },
            },
          },
        },
        scales: {
          y: { beginAtZero: true, title: { display: true, text: "hours / yr ≥ threshold" }, grid: { color: C.line } },
          y1: { position: "right", beginAtZero: true, grid: { display: false }, title: { display: true, text: units } },
          x: { grid: { display: false } },
        },
      },
    });
  }

  function speeds(a, units) {
    const cv = conv(units);
    draw("chSpeed", {
      data: {
        labels: MONTHS,
        datasets: [
          { type: "line", label: "Mean daily max gust", data: a.months.map(m => +cv(m.meanDailyGust).toFixed(1)),
            borderColor: C.red, backgroundColor: C.red, borderWidth: 2, pointRadius: 2, tension: .35, yAxisID: "y" },
          { type: "line", label: "Mean daily max wind", data: a.months.map(m => +cv(m.meanDailyMax).toFixed(1)),
            borderColor: C.orange, backgroundColor: C.orange, borderWidth: 2, pointRadius: 2, tension: .35, yAxisID: "y" },
          { type: "line", label: "Mean wind", data: a.months.map(m => +cv(m.mean).toFixed(1)),
            borderColor: C.ink, backgroundColor: C.ink, borderWidth: 2, pointRadius: 2, tension: .35, yAxisID: "y" },
          { type: "bar", label: "Days with gusts ≥ 40 mph", data: a.months.map(m => +m.gustDays.toFixed(1)),
            backgroundColor: "rgba(200,55,45,.16)", borderRadius: 4, yAxisID: "y1" },
        ],
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "bottom" } },
        scales: {
          y: { beginAtZero: true, title: { display: true, text: units } },
          y1: { position: "right", beginAtZero: true, grid: { display: false }, title: { display: true, text: "gust days / month" } },
          x: { grid: { display: false } },
        },
      },
    });
  }

  function water(a) {
    draw("chWater", {
      type: "bar",
      data: {
        labels: MONTHS.map(m => m[0]),
        datasets: [
          { label: "Precip (in)", data: a.months.map(m => +(m.precip / 25.4).toFixed(2)), backgroundColor: C.sky, borderRadius: 3 },
          { label: "ET₀ (in)", data: a.months.map(m => +(m.et0 / 25.4).toFixed(2)), backgroundColor: "rgba(217,119,47,.75)", borderRadius: 3 },
        ],
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: { y: { beginAtZero: true, title: { display: true, text: "inches / month" } }, x: { grid: { display: false } } },
      },
    });
  }

  function trend(a) {
    const xs = a.annual.map(r => r.year);
    const t = a.trend;
    draw("chTrend", {
      data: {
        labels: xs,
        datasets: [
          { type: "bar", label: "Erosive wind hours", data: a.annual.map(r => Math.round(r.eroHours)),
            backgroundColor: a.annual.map(r => (r.eroHours >= a.eroHours * 1.15 ? C.red : r.eroHours <= a.eroHours * 0.85 ? C.gray : C.amber)),
            borderRadius: 4 },
          ...(t ? [{ type: "line", label: "Linear trend", data: xs.map(x => +(t.icpt + t.slope * x).toFixed(1)),
            borderColor: C.ink, borderDash: [5, 4], borderWidth: 2, pointRadius: 0 }] : []),
        ],
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false },
          tooltip: { callbacks: { afterBody: items => {
            const r = a.annual[items[0].dataIndex];
            return r && r.precip !== null ? [`Precip: ${(r.precip / 25.4).toFixed(1)} in`] : [];
          } } } },
        scales: { y: { beginAtZero: true, title: { display: true, text: "hours / yr ≥ threshold" } }, x: { grid: { display: false } } },
      },
    });
  }

  /* SVG wind rose: erosive winds by direction (where wind comes FROM), stacked by speed above threshold. */
  function rose(el, a, units) {
    const cv = conv(units);
    const size = 300, cx = 150, cy = 150, R = 112;
    const tot = a.rose.map(r => r.bins.reduce((x, y) => x + y, 0));
    const max = Math.max(...tot, 0.01);
    const nice = [0.25, 0.5, 1, 2, 2.5, 5, 10, 20].find(v => v * 4 >= max) || Math.ceil(max / 4);
    const scaleMax = nice * 4;
    const cols = ["#f0c25a", "#e0742c", "#b3261e"];
    const thr = a.thr;
    const lab = v => `${fmt(cv(v), 0)}`;
    let s = `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="Erosive wind rose">`;
    for (let k = 1; k <= 4; k++) {
      const r = (R * k) / 4;
      s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e4e1d7" stroke-width="1"/>`;
      s += `<text x="${cx + 3}" y="${cy - r + 10}" font-size="9" fill="#8a918b">${+(nice * k).toFixed(2)}%</text>`;
    }
    for (let i = 0; i < 16; i++) {
      const ang = (i * 22.5 - 90) * Math.PI / 180;
      s += `<line x1="${cx}" y1="${cy}" x2="${cx + R * Math.cos(ang)}" y2="${cy + R * Math.sin(ang)}" stroke="#efece4" stroke-width="1"/>`;
    }
    const wedge = (i, r0, r1) => {
      const a0 = (i * 22.5 - 90 - 9.5) * Math.PI / 180, a1 = (i * 22.5 - 90 + 9.5) * Math.PI / 180;
      const p = (r, t) => `${(cx + r * Math.cos(t)).toFixed(1)},${(cy + r * Math.sin(t)).toFixed(1)}`;
      return `M${p(r0, a0)} L${p(r1, a0)} A${r1},${r1} 0 0 1 ${p(r1, a1)} L${p(r0, a1)} A${r0},${r0} 0 0 0 ${p(r0, a0)} Z`;
    };
    a.rose.forEach((r, i) => {
      let acc = 0;
      r.bins.forEach((v, b) => {
        if (v <= 0) return;
        const r0 = (R * acc) / scaleMax, r1 = (R * (acc + v)) / scaleMax;
        s += `<path d="${wedge(i, r0, r1)}" fill="${cols[b]}" stroke="#fff" stroke-width=".6"><title>${WG.util.COMPASS[i]}: ${v.toFixed(2)}% of hours</title></path>`;
        acc += v;
      });
    });
    // resultant transport arrow (downwind)
    if (a.rdpRatio > 0.05) {
      const t = (a.rdd - 90) * Math.PI / 180, L = R * 0.92;
      const x2 = cx + L * Math.cos(t), y2 = cy + L * Math.sin(t);
      s += `<line x1="${cx}" y1="${cy}" x2="${x2}" y2="${y2}" stroke="#1c2420" stroke-width="2.5" stroke-dasharray="4 3"/>`;
      const h1 = t + 2.7, h2 = t - 2.7;
      s += `<path d="M${x2},${y2} L${x2 + 9 * Math.cos(h1)},${y2 + 9 * Math.sin(h1)} L${x2 + 9 * Math.cos(h2)},${y2 + 9 * Math.sin(h2)} Z" fill="#1c2420"/>`;
    }
    [["N", 0], ["E", 90], ["S", 180], ["W", 270]].forEach(([t, d]) => {
      const ang = (d - 90) * Math.PI / 180;
      s += `<text x="${cx + (R + 16) * Math.cos(ang)}" y="${cy + (R + 16) * Math.sin(ang) + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="#39423c">${t}</text>`;
    });
    // legend
    const u = units;
    const bins = [`${lab(thr)}–${lab(thr + 2)}`, `${lab(thr + 2)}–${lab(thr + 4)}`, `> ${lab(thr + 4)}`];
    s += `<g transform="translate(6,${size - 40})" font-size="9.5" fill="#39423c">`;
    bins.forEach((b, i) => { s += `<rect x="${i * 76}" y="0" width="10" height="10" rx="2" fill="${cols[i]}"/><text x="${i * 76 + 14}" y="9">${b} ${u}</text>`; });
    s += `<line x1="0" y1="24" x2="18" y2="24" stroke="#1c2420" stroke-width="2.5" stroke-dasharray="4 3"/><text x="22" y="27">resultant soil-transport direction</text></g>`;
    s += `</svg>`;
    el.innerHTML = s;
  }

  /* Semicircular gauge with five classes and a needle at level 1..5 (fractional allowed). */
  function gauge(el, level) {
    const cols = ["#3f9a66", "#9bbf55", "#efc24a", "#ef8a3c", "#d8402f"];
    const cx = 50, cy = 52, r = 38;
    let s = `<svg viewBox="0 0 100 62">`;
    for (let i = 0; i < 5; i++) {
      const a0 = Math.PI + (i * Math.PI) / 5 + 0.03, a1 = Math.PI + ((i + 1) * Math.PI) / 5 - 0.03;
      s += `<path d="M${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 0 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)}" stroke="${cols[i]}" stroke-width="10" fill="none"/>`;
    }
    if (level) {
      const t = Math.PI + ((Math.min(Math.max(level, 0.5), 5.5) - 0.5) / 5) * Math.PI;
      s += `<line x1="${cx}" y1="${cy}" x2="${cx + (r - 4) * Math.cos(t)}" y2="${cy + (r - 4) * Math.sin(t)}" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`;
      s += `<circle cx="${cx}" cy="${cy}" r="4.5" fill="#fff"/>`;
    }
    el.innerHTML = s + `</svg>`;
  }

  /* Monthly erosive hours by source: airport station, raw reanalysis, calibrated. */
  function calib(all) {
    const ds = [];
    if (all.station) ds.push({ type: "bar", label: "Airport station", data: all.station.months.map(m => +m.eroHours.toFixed(1)), backgroundColor: "rgba(47,111,159,.35)", borderRadius: 4, order: 3 });
    if (all.cal) ds.push({ type: "line", label: "Calibrated (this point)", data: all.cal.months.map(m => +m.eroHours.toFixed(1)), borderColor: C.red, backgroundColor: C.red, borderWidth: 2.5, pointRadius: 2.5, tension: .3, order: 1 });
    if (all.model) ds.push({ type: "line", label: "Reanalysis only", data: all.model.months.map(m => +m.eroHours.toFixed(1)), borderColor: C.muted, backgroundColor: C.muted, borderDash: [5, 4], borderWidth: 2, pointRadius: 0, tension: .3, order: 2 });
    draw("chCal", {
      data: { labels: MONTHS, datasets: ds },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "bottom" } },
        scales: { y: { beginAtZero: true, title: { display: true, text: "erosive hours / yr" } }, x: { grid: { display: false } } },
      },
    });
  }

  function resizeAll() { Object.values(charts).forEach(c => c.resize()); }

  return { season, speeds, water, trend, rose, gauge, calib, resizeAll, C };
})();
