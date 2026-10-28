/* App controller: map, layers, search, site analysis, panel rendering. */
(function () {
  const U = WG.util, S = WG.soil, Wd = WG.wind, Ch = WG.charts;
  const { $, $$, esc, fmt, num } = U;
  const LAYERS = window.WE_LAYERS;
  const app = $("#app");

  const state = {
    site: null,          // {lat, lon}
    token: 0,            // guards against out-of-order async results
    soil: null,          // fetched SSURGO profile
    edits: null,         // user surface overrides {sand, silt, clay, om, caco3, ph}
    windRaw: null,
    windSets: null,      // {model, cal, station} raw series
    windStation: null,   // nearest-station data used for calibration
    windSource: "cal",   // preferred source: cal | station | model
    windKey: null,       // source actually shown
    windAll: null,       // analyses of every available source
    windCompare: null,   // reanalysis vs station statistics
    wind: null,
    units: "mph",
    thr: 8,
    period: 10,
    nlcd: null,
    place: null,
    elev: null,
    landUse: null,
    answers: {},
  };
  WG.state = state;

  /* ============ MAP ============ */
  const map = L.map("map", { zoomControl: false, preferCanvas: true, worldCopyJump: false, tap: true })
    .setView([32.2, -100.6], 6);
  WG.map = map;
  if (window.matchMedia("(min-width: 768px)").matches) L.control.zoom({ position: "bottomright" }).addTo(map);
  L.control.scale({ imperial: true, metric: true, position: "bottomright" }).addTo(map);

  const esri = p => `https://server.arcgisonline.com/ArcGIS/rest/services/${p}/MapServer/tile/{z}/{y}/{x}`;
  const usgs = p => `https://basemap.nationalmap.gov/arcgis/rest/services/${p}/MapServer/tile/{z}/{y}/{x}`;

  const bases = {
    sat: { name: "Satellite", thumb: "#3d4a3a",
      layer: L.tileLayer(esri("World_Imagery"), { maxZoom: 19, maxNativeZoom: 19, attribution: "Imagery © Esri, Maxar, USDA FSA, USGS" }),
      labels: true },
    usgsimg: { name: "USGS imagery + topo", thumb: "#56604a",
      layer: L.tileLayer(usgs("USGSImageryTopo"), { maxZoom: 19, maxNativeZoom: 16, attribution: "USGS The National Map" }),
      labels: false },
    streets: { name: "Streets", thumb: "#e9e5dc",
      layer: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }),
      labels: false },
    topo: { name: "Topographic", thumb: "#dfe3cf",
      layer: L.tileLayer(usgs("USGSTopo"), { maxZoom: 19, maxNativeZoom: 16, attribution: "USGS The National Map" }),
      labels: false },
  };

  map.createPane("thematic").style.zIndex = 350;
  map.createPane("refs").style.zIndex = 420;
  map.createPane("labels").style.zIndex = 450;
  map.getPane("labels").style.pointerEvents = "none";
  map.getPane("refs").style.pointerEvents = "none";

  const refs = {
    labels: { name: "Place, river and county names", sub: "towns, rivers, lakes, landmarks",
      layer: L.tileLayer(esri("Reference/World_Reference_Overlay"), { pane: "labels", maxZoom: 19, attribution: "Labels © Esri" }), on: true },
    roads: { name: "Roads and street names", sub: "highways, county roads, streets",
      layer: L.tileLayer(esri("Reference/World_Transportation"), { pane: "refs", maxZoom: 19, opacity: 0.95 }), on: true },
    hydro: { name: "Rivers, streams, lakes", sub: "USGS National Hydrography lines",
      layer: L.tileLayer(usgs("USGSHydroCached"), { pane: "refs", maxZoom: 19, maxNativeZoom: 16, opacity: 0.9 }), on: true },
    counties: { name: "County lines", sub: "with NRCS climatic factor C",
      layer: L.geoJSON(LAYERS.counties, {
        pane: "refs", interactive: false,
        style: { color: "#ffffff", weight: 1, opacity: 0.55, fill: false, dashArray: "3 3" },
      }), on: false },
  };

  const imgOpts = { pane: "thematic", opacity: 0.6, className: "thematic-img", interactive: false };
  const themes = {
    susceptibility: { layer: L.imageOverlay(LAYERS.layers.susceptibility.file, LAYERS.bounds, imgOpts), meta: LAYERS.layers.susceptibility, on: true },
    weg: { layer: L.imageOverlay(LAYERS.layers.weg.file, LAYERS.bounds, imgOpts), meta: LAYERS.layers.weg, on: false },
    climate: { layer: L.imageOverlay(LAYERS.layers.climate.file, LAYERS.bounds, imgOpts), meta: LAYERS.layers.climate, on: false },
    wind: { layer: L.imageOverlay(LAYERS.layers.wind.file, LAYERS.bounds, imgOpts), meta: LAYERS.layers.wind, on: false,
      extra: windArrows() },
  };

  /* Downwind arrows for the spring wind layer (direction soil is carried), length by speed. */
  function windArrows() {
    const g = L.layerGroup();
    (LAYERS.windArrows || []).forEach(([lat, lon, from, mph]) => {
      const len = 10 + Math.max(0, mph - 8) * 3.2;
      const svg = `<svg width="2" height="2" viewBox="-1 -1 2 2"><g transform="rotate(${(from + 180) % 360})">
        <line x1="0" y1="${len / 2}" x2="0" y2="${-len / 2}" stroke="#16324f" stroke-width="2"/>
        <path d="M0,${-len / 2 - 5} L-4,${-len / 2 + 2} L4,${-len / 2 + 2} Z" fill="#16324f"/></g></svg>`;
      L.marker([lat, lon], { pane: "refs", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "wind-arrow", html: svg, iconSize: [2, 2], iconAnchor: [1, 1] }) }).addTo(g);
    });
    return g;
  }

  const soilLayers = {
    nlcd: { name: "Land cover (NLCD 2021)", sub: "cropland, rangeland, shrubland…",
      layer: L.tileLayer.wms("https://www.mrlc.gov/geoserver/mrlc_display/wms", {
        layers: "NLCD_2021_Land_Cover_L48", format: "image/png", transparent: true, pane: "thematic", opacity: 0.6,
        attribution: "NLCD / MRLC" }), on: false },
    ssurgo: { name: "Soil map units (SSURGO)", sub: "polygon lines and map symbols, zoom 13+",
      layer: L.tileLayer.wms("https://SDMDataAccess.sc.egov.usda.gov/Spatial/SDM.wms", {
        layers: "mapunitpoly", format: "image/png", transparent: true, pane: "refs", minZoom: 13, maxZoom: 19, opacity: 0.85,
        attribution: "USDA-NRCS SSURGO" }), on: true },
  };

  let baseKey = "sat";
  bases.sat.layer.addTo(map);
  Object.values(refs).forEach(r => r.on && r.layer.addTo(map));
  Object.values(themes).forEach(t => t.on && t.layer.addTo(map));
  Object.values(soilLayers).forEach(t => t.on && t.layer.addTo(map));
  L.geoJSON(LAYERS.texas, { pane: "refs", interactive: false, style: { color: "#fff", weight: 2, opacity: 0.9, fill: false } }).addTo(map);

  /* ---------- layer sheet ---------- */
  function buildLayerSheet() {
    $("#baseGrid").innerHTML = Object.entries(bases).map(([k, b]) =>
      `<button data-base="${k}" class="${k === baseKey ? "on" : ""}"><i style="background:${b.thumb}"></i>${esc(b.name)}</button>`).join("");
    const toggle = (group, key, item, swatch) => `<label class="toggle"><input type="checkbox" data-group="${group}" data-key="${key}" ${item.on ? "checked" : ""}>
      <span>${esc(item.name || item.meta.title)}<small>${esc(item.sub || (item.meta && item.meta.unit) || "")}</small></span>${swatch || ""}</label>`;
    $("#refToggles").innerHTML = Object.entries(refs).map(([k, r]) => toggle("refs", k, r)).join("");
    $("#themeToggles").innerHTML = Object.entries(themes).map(([k, t]) => toggle("themes", k, t,
      `<i class="sw2" style="background:linear-gradient(90deg,${(t.meta.legend || []).map(l => l.color).join(",")})"></i>`)).join("");
    $("#soilToggles").innerHTML = Object.entries(soilLayers).map(([k, r]) => toggle("soilLayers", k, r)).join("");
  }
  const groups = { refs, themes, soilLayers };

  function setBase(k) {
    map.removeLayer(bases[baseKey].layer);
    baseKey = k;
    bases[k].layer.addTo(map);
    bases[k].layer.bringToBack();
    // name overlays are tuned for imagery; bases with built-in names don't need them
    ["labels"].forEach(n => {
      const lab = refs[n];
      if (!bases[k].labels && lab.on) { map.removeLayer(lab.layer); lab.on = false; }
      if (bases[k].labels && !lab.on) { lab.layer.addTo(map); lab.on = true; }
    });
    buildLayerSheet();
  }

  function setToggle(group, key, on) {
    const item = groups[group][key];
    item.on = on;
    const show = (it, v) => { [it.layer, it.extra].filter(Boolean).forEach(l => (v ? l.addTo(map) : map.removeLayer(l))); };
    show(item, on);
    if (group === "themes" && on) {
      // one thematic overlay at a time keeps the map readable
      Object.entries(themes).forEach(([k, t]) => { if (k !== key && t.on) { t.on = false; show(t, false); } });
      buildLayerSheet();
      applyOpacity();
    }
    renderLegend();
  }

  $("#layerSheet").addEventListener("click", e => {
    const b = e.target.closest("[data-base]");
    if (b) setBase(b.dataset.base);
  });
  $("#layerSheet").addEventListener("change", e => {
    const i = e.target;
    if (i.dataset.group) setToggle(i.dataset.group, i.dataset.key, i.checked);
  });
  /* Statewide overlays are 1 km grids: fade them as you zoom in so imagery, roads and soil lines read through. */
  let userOpacity = 0.6;
  function applyOpacity() {
    const z = map.getZoom();
    const f = z >= 14 ? 0 : z >= 12 ? 0.4 : z >= 10 ? 0.75 : 1;
    Object.values(themes).forEach(t => t.layer.setOpacity(userOpacity * f));
    soilLayers.nlcd.layer.setOpacity(Math.min(1, userOpacity * (z >= 12 ? 0.8 : 1)));
  }
  $("#opacityRange").addEventListener("input", e => { userOpacity = +e.target.value; applyOpacity(); });
  map.on("zoomend", applyOpacity);
  applyOpacity();
  const openSheet = open => { $("#layerSheet").hidden = !open; $("#sheetBackdrop").hidden = !open; };
  $("#layersBtn").addEventListener("click", () => { buildLayerSheet(); openSheet(true); });
  $("#sheetClose").addEventListener("click", () => openSheet(false));
  $("#sheetBackdrop").addEventListener("click", () => openSheet(false));

  /* ---------- legend ---------- */
  let legendMin = window.matchMedia("(max-width: 767px)").matches;
  function renderLegend() {
    const active = Object.values(themes).find(t => t.on);
    const el = $("#legend");
    if (!active) { el.hidden = true; return; }
    const m = active.meta;
    el.hidden = false;
    el.classList.toggle("min", legendMin);
    el.innerHTML = `<h5><span>${esc(m.title)}${m.unit ? ` <small style="font-weight:400;color:#69716a">(${esc(m.unit)})</small>` : ""}</span>
      <button id="legendMin">${legendMin ? "show" : "hide"}</button></h5>
      <div class="rows">${m.legend.map(l => `<div class="row"><i class="sw" style="background:${l.color}"></i>${esc(l.label)}</div>`).join("")}</div>
      <p class="lnote">${esc(m.note)}</p>`;
    $("#legendMin").onclick = () => { legendMin = !legendMin; renderLegend(); };
  }
  renderLegend();

  /* ============ SEARCH / COORDINATES ============ */
  const input = $("#searchInput"), results = $("#searchResults");
  let searchSeq = 0;

  async function geocode(q) {
    const params = new URLSearchParams({ q, format: "jsonv2", limit: "6", countrycodes: "us", addressdetails: "1",
      viewbox: "-106.7,36.6,-93.4,25.8", bounded: "0" });
    return U.fetchJSON(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { "Accept-Language": "en" } }, 12000);
  }

  function showResults(items) {
    if (!items.length) { results.innerHTML = `<button disabled>No matches</button>`; results.hidden = false; return; }
    results.innerHTML = items.map((r, i) =>
      `<button data-i="${i}" role="option"><b>${esc(r.title)}</b><small>${esc(r.sub)}</small></button>`).join("");
    results.hidden = false;
    results.onclick = e => {
      const b = e.target.closest("button[data-i]");
      if (!b) return;
      const r = items[+b.dataset.i];
      results.hidden = true;
      input.value = r.title;
      input.blur();
      selectSite(r.lat, r.lon, { zoom: r.zoom || 14, place: r.title });
    };
  }

  async function runSearch(q) {
    const c = U.parseCoords(q);
    if (c) {
      showResults([{ title: `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`, sub: "Go to coordinates", lat: c.lat, lon: c.lon, zoom: 14 }]);
      return;
    }
    if (q.trim().length < 3) { results.hidden = true; return; }
    const seq = ++searchSeq;
    try {
      const rows = await geocode(q);
      if (seq !== searchSeq) return;
      showResults(rows.map(r => ({
        title: r.name || r.display_name.split(",")[0],
        sub: r.display_name.split(",").slice(1, 4).join(",").trim(),
        lat: +r.lat, lon: +r.lon,
        zoom: r.type === "county" || r.addresstype === "county" ? 10 : r.place_rank < 16 ? 11 : 14,
      })));
    } catch (e) {
      if (seq === searchSeq) showResults([]);
    }
  }
  input.addEventListener("input", U.debounce(() => runSearch(input.value), 450));
  $("#searchForm").addEventListener("submit", e => {
    e.preventDefault();
    const c = U.parseCoords(input.value);
    if (c) { results.hidden = true; input.blur(); selectSite(c.lat, c.lon, { zoom: 14 }); return; }
    runSearch(input.value);
  });
  document.addEventListener("click", e => {
    if (!e.target.closest("#searchForm")) { results.hidden = true; $("#coordForm").hidden = true; }
  });
  $("#coordBtn").addEventListener("click", () => {
    const f = $("#coordForm");
    f.hidden = !f.hidden;
    results.hidden = true;
    if (!f.hidden) {
      if (state.site) { $("#latInput").value = state.site.lat.toFixed(5); $("#lonInput").value = state.site.lon.toFixed(5); }
      $("#latInput").focus();
    }
  });
  function goCoords() {
    const lat = U.parseCoords($("#latInput").value + " " + $("#lonInput").value)
      || { lat: parseFloat($("#latInput").value), lon: parseFloat($("#lonInput").value) };
    if (!Number.isFinite(lat.lat) || !Number.isFinite(lat.lon) || Math.abs(lat.lat) > 90 || Math.abs(lat.lon) > 180) {
      U.toast("Enter latitude and longitude in decimal degrees, e.g. 32.7357 and -101.955");
      return;
    }
    $("#coordForm").hidden = true;
    selectSite(lat.lat, lat.lon, { zoom: 14 });
  }
  $("#coordGo").addEventListener("click", goCoords);
  $$("#coordForm input").forEach(i => i.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); goCoords(); } }));

  $("#locateBtn").addEventListener("click", () => {
    if (!navigator.geolocation) return U.toast("Location is not available in this browser");
    const b = $("#locateBtn");
    b.classList.add("busy");
    navigator.geolocation.getCurrentPosition(p => {
      b.classList.remove("busy");
      selectSite(p.coords.latitude, p.coords.longitude, { zoom: 15 });
    }, err => {
      b.classList.remove("busy");
      U.toast("Couldn't get your location: " + err.message);
    }, { enableHighAccuracy: true, timeout: 15000 });
  });

  /* ============ LAYOUT ============ */
  function setLayout(mode) {
    // mode: 'none' | 'split' | 'mapbig'
    app.classList.toggle("has-site", mode !== "none");
    app.classList.toggle("map-big", mode === "mapbig");
    $("#mapToggle").hidden = mode !== "mapbig";
    // follow the grid transition, then settle (timers rather than rAF so background tabs still settle)
    // the map container animates; a ResizeObserver settles it once the size stops changing
    setTimeout(() => { if (pendingView) settleMap(); }, 1200); // fallback if the size never changed
  }
  let pendingView = null;
  function settleMap() {
    map.invalidateSize({ pan: false });
    if (pendingView) { map.setView(pendingView.ll, pendingView.z, { animate: false }); pendingView = null; }
    else if (state.site) keepPinVisible();
    Ch.resizeAll();
  }
  const settleSoon = U.debounce(settleMap, 140);
  new ResizeObserver(() => { map.invalidateSize({ pan: false }); settleSoon(); }).observe($(".map-pane"));
  function keepPinVisible() {
    const p = L.latLng(state.site.lat, state.site.lon);
    if (!map.getBounds().pad(-0.15).contains(p)) map.panTo(p, { animate: true });
  }
  $("#expandMapBtn").addEventListener("click", () => setLayout("mapbig"));
  $("#mapToggle").addEventListener("click", () => { if (state.site) pendingView = { ll: L.latLng(state.site.lat, state.site.lon), z: map.getZoom() }; setLayout("split"); });
  $("#closePanelBtn").addEventListener("click", () => {
    setLayout("none");
    if (marker) { map.removeLayer(marker); marker = null; }
    state.site = null;
  });
  window.addEventListener("resize", U.debounce(() => { map.invalidateSize(); Ch.resizeAll(); }, 150));

  /* ---------- tabs ---------- */
  function showTab(name) {
    $$(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
    $$(".tab").forEach(t => { t.hidden = t.id !== "tab-" + name; });
    $("#panelBody").scrollTop = 0;
    if (name === "wind" && state.wind) setTimeout(renderWindCharts, 0);
  }
  $(".tabs").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab); });
  $("#panel").addEventListener("click", e => { const g = e.target.closest("[data-goto]"); if (g) showTab(g.dataset.goto); });

  /* ============ SITE SELECTION ============ */
  let marker = null;
  map.on("click", e => selectSite(e.latlng.lat, e.latlng.lng, { keepZoom: true }));

  function selectSite(lat, lon, opts = {}) {
    const inTexasish = lat > 25.5 && lat < 36.8 && lon > -106.9 && lon < -93.3;
    if (!inTexasish) U.toast("This tool is built for Texas — results outside Texas may be incomplete.");
    state.site = { lat, lon };
    state.token++;
    state.soil = null; state.edits = null; state.wind = null; state.windRaw = null; state.windSets = null; state.windStation = null; state.nlcd = null; state.elev = null;
    state.place = opts.place || null;

    const ll = L.latLng(lat, lon);
    if (!marker) {
      marker = L.marker(ll, { draggable: true, icon: L.divIcon({ className: "", html: '<div class="pin"></div>', iconSize: [30, 30], iconAnchor: [15, 30] }) }).addTo(map);
      marker.on("dragend", () => { const p = marker.getLatLng(); selectSite(p.lat, p.lng, { keepZoom: true }); });
    } else marker.setLatLng(ll);

    const wasOpen = app.classList.contains("has-site") && !app.classList.contains("map-big");
    const z = opts.keepZoom ? Math.max(map.getZoom(), 9) : opts.zoom || Math.max(map.getZoom(), 12);
    if (wasOpen) map.setView(ll, z, { animate: true });
    else { pendingView = { ll, z }; setLayout("split"); }

    try { history.replaceState(null, "", `?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`); } catch (e) { /* file:// */ }
    renderHeader();
    resetPanels();
    showTab("overview");
    analyzeSite(state.token);
  }

  function renderHeader() {
    const { lat, lon } = state.site;
    $("#siteName").textContent = state.place || "Selected location";
    $("#siteCoords").textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    $("#siteElev").textContent = state.elev ? `${fmt(state.elev.z * 3.28084, 0)} ft elev · ${fmt(state.elev.slope, 1)}% slope (DEM)` : "";
  }

  function resetPanels() {
    const rc = $("#riskCard");
    rc.className = "risk-card loading";
    $("#riskLevel").textContent = "Analyzing…";
    $("#riskText").textContent = `Fetching the soil survey and ${state.period} years of hourly wind for this point…`;
    Ch.gauge($("#riskGauge"), null);
    ["stWind", "stHours", "stDir", "stWeg", "stC", "stLc"].forEach(id => { $("#" + id).innerHTML = '<span class="skeleton" style="width:70%"></span>'; });
    $("#monthStrip").innerHTML = U.MONTHS.map(m => `<div class="m"><i class="skeleton" style="height:28px"></i>${m[0]}</div>`).join("");
    $("#ovSoil").innerHTML = '<span class="skeleton"></span><span class="skeleton" style="width:60%"></span>';
    $("#soilSummary").innerHTML = '<span class="skeleton"></span><span class="skeleton" style="width:60%"></span>';
    $("#profileDetail").innerHTML = "";
    $("#soilDerived").innerHTML = "";
    $$("#soilEdit input").forEach(i => { i.value = ""; i.classList.remove("edited"); });
    $("#resetSoilBtn").hidden = true;
    $("#windIdx").innerHTML = "";
    $("#roseBox").innerHTML = "";
    $("#planBox").innerHTML = "";
    renderPractices();
  }

  async function analyzeSite(tok) {
    const { lat, lon } = state.site;
    const live = () => tok === state.token;

    const jobs = [
      reverseGeocode(lat, lon).then(p => { if (live() && p && !state.place) { state.place = p; renderHeader(); } }).catch(() => {}),
      fetchElevation(lat, lon).then(e => { if (live()) { state.elev = e; renderHeader(); renderSoilDetail(); } }).catch(() => {}),
      fetchNLCD(lat, lon).then(n => { if (live()) { state.nlcd = n; renderStats(); renderPractices(); } }).catch(() => { if (live()) { state.nlcd = { code: null }; renderStats(); } }),
      S.fetchSoil(lat, lon).then(s => {
        if (!live()) return;
        state.soil = s;
        renderSoil(); renderRisk(); renderStats(); renderPractices();
      }).catch(err => {
        if (!live()) return;
        state.soil = { error: err.message || String(err) };
        renderSoil(); renderRisk(); renderStats();
      }),
      loadWind(tok),
    ];
    await Promise.allSettled(jobs);
  }

  async function loadWind(tok) {
    const { lat, lon } = state.site;
    const live = () => tok === state.token;
    try {
      // nearest airport station loads in parallel; the reanalysis shows first, calibration follows
      state.windStationChoice = null;
      const stationJob = findStationRetry(lat, lon, tok);
      state.windStationPending = true;
      let raw;
      try {
        raw = await Wd.fetchWind(lat, lon, state.period);
      } catch (e) {
        console.warn("Open-Meteo failed, falling back to NASA POWER", e);
        raw = await Wd.fetchPower(lat, lon, state.period);
      }
      if (!live()) return;
      state.windSets = { model: raw };
      state.windStation = null;
      chooseWind();
      renderWind(); renderRisk(); renderStats(); renderPractices();
      applyStation(await stationJob, tok);
    } catch (err) {
      if (!live()) return;
      state.windStationPending = false;
      state.wind = { error: err.message || String(err) };
      renderWind(); renderRisk(); renderStats();
    }
  }

  /* Station lookup; on an Open-Meteo per-minute quota error wait a minute and try once more. */
  async function findStationRetry(lat, lon, tok) {
    try {
      return await Wd.findStation(lat, lon, state.period);
    } catch (e) {
      if (!/limit/i.test(e.message || "")) { console.warn("station lookup failed", e); return null; }
      state.windStationRetry = true;
      if (tok === state.token && state.windSets) renderWind();
      await new Promise(r => setTimeout(r, 65000));
      state.windStationRetry = false;
      if (tok !== state.token) return null;
      return Wd.findStation(lat, lon, state.period).catch(() => null);
    }
  }

  function applyStation(st, tok) {
    if (tok !== state.token || !state.windSets) return;
    state.windStationPending = false;
    const raw = state.windSets.model;
    state.windSets = { model: raw };
    state.windStation = st;
    if (st) {
      state.windSets.station = Wd.stationRaw(raw, st);
      if (!raw.dailyOnly) state.windSets.cal = Wd.calibrate(raw, st);
    }
    chooseWind();
    renderWind(); renderRisk(); renderStats(); renderPractices();
  }

  /* User picked another calibration station. */
  $("#stnSel").addEventListener("change", async e => {
    const tok = state.token, id = e.target.value;
    if (!state.site || !state.windSets) return;
    state.windStationChoice = id;
    state.windStationPending = true;
    renderWind();
    const st = await Wd.findStation(state.site.lat, state.site.lon, state.period, id).catch(() => null);
    if (!st) U.toast(`No usable data at ${id} for this period.`);
    applyStation(st || state.windStation, tok);
  });

  /* Pick the preferred available wind series and analyze every source for the comparison card. */
  function chooseWind() {
    const sets = state.windSets || {};
    const pref = state.windSource;
    const key = sets[pref] ? pref : sets.cal ? "cal" : sets.station && sets.model && sets.model.dailyOnly ? "station" : "model";
    state.windKey = key;
    state.windRaw = sets[key];
    state.windAll = Object.fromEntries(Object.entries(sets).map(([k, r]) => [k, Wd.analyze(r, state.thr)]));
    state.wind = state.windAll[key];
    state.windCompare = state.windStation ? Wd.compare(state.windStation, state.thr) : null;
  }

  async function reverseGeocode(lat, lon) {
    const j = await U.fetchJSON(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=12&addressdetails=1`,
      { headers: { "Accept-Language": "en" } }, 10000);
    const a = j.address || {};
    const town = a.city || a.town || a.village || a.hamlet || a.locality;
    const county = a.county;
    if (town && county) return `Near ${town}, ${county}`;
    return county ? `${county}, ${a.state || ""}`.replace(/, $/, "") : (j.name || null);
  }

  async function fetchElevation(lat, lon) {
    const d = 0.0009, dl = d / Math.cos(lat * Math.PI / 180);
    const lats = [lat, lat + d, lat - d, lat, lat], lons = [lon, lon, lon, lon + dl, lon - dl];
    const j = await U.fetchJSON(`https://api.open-meteo.com/v1/elevation?latitude=${lats.map(v => v.toFixed(5)).join(",")}&longitude=${lons.map(v => v.toFixed(5)).join(",")}`, {}, 10000);
    const [z, zn, zs, ze, zw] = j.elevation;
    const dy = 2 * d * 111320, dx = 2 * dl * 111320 * Math.cos(lat * Math.PI / 180);
    const gx = (ze - zw) / dx, gy = (zn - zs) / dy;
    const slope = Math.hypot(gx, gy) * 100;
    const aspect = (Math.atan2(-gx, -gy) * 180 / Math.PI + 360) % 360;
    return { z, slope, aspect };
  }

  const NLCD = {
    11: "Open water", 12: "Perennial ice/snow", 21: "Developed, open space", 22: "Developed, low intensity",
    23: "Developed, medium intensity", 24: "Developed, high intensity", 31: "Barren land", 41: "Deciduous forest",
    42: "Evergreen forest", 43: "Mixed forest", 52: "Shrub/scrub", 71: "Grassland/herbaceous", 81: "Pasture/hay",
    82: "Cultivated crops", 90: "Woody wetlands", 95: "Emergent herbaceous wetlands",
  };
  async function fetchNLCD(lat, lon) {
    const d = 0.0005;
    const q = new URLSearchParams({ service: "WMS", version: "1.1.1", request: "GetFeatureInfo", layers: "NLCD_2021_Land_Cover_L48",
      query_layers: "NLCD_2021_Land_Cover_L48", srs: "EPSG:4326", bbox: `${lon - d},${lat - d},${lon + d},${lat + d}`,
      width: "3", height: "3", x: "1", y: "1", info_format: "application/json" });
    const j = await U.fetchJSON(`https://www.mrlc.gov/geoserver/mrlc_display/wms?${q}`, {}, 12000);
    const f = j.features && j.features[0];
    const code = f ? num(f.properties.PALETTE_INDEX ?? f.properties.GRAY_INDEX) : null;
    return { code, name: NLCD[code] || null };
  }

  /* ============ RISK ============ */
  /* Bare-soil potential E = I × C/100 (t/ac/yr), C from SSURGO (official) else local estimate. */
  function currentSurface() {
    const s = state.soil && state.soil.surface;
    if (!s) return null;
    if (!state.edits) return { ...s, calc: null };
    const e = { ...s, ...state.edits };
    const code = S.refineCode(S.textureClass(e.sand, e.silt, e.clay), s.texCode);
    e.texCode = code;
    e.texName = S.TEX[code] || code;
    const w = S.wegFromSurface(e);
    e.weg = w.weg; e.wei = w.I; e.calc = w;
    return e;
  }
  WG.currentSurface = currentSurface;

  function cFactor() {
    if (state.soil && state.soil.cFactor) return { C: state.soil.cFactor, src: "NRCS (SSURGO climate-factor area)" };
    if (state.wind && !state.wind.error) {
      // local estimate from reanalysis: scale FAO monthly-sum C to Chepil-type C (rough)
      return { C: Math.round(Math.min(200, state.wind.faoC * 0.9)), src: "estimated from reanalysis wind" };
    }
    return null;
  }

  function riskModel() {
    const surf = currentSurface();
    const cf = cFactor();
    if (!surf || surf.wei === null || surf.wei === undefined || !cf) return null;
    const E = (surf.wei * cf.C) / 100;
    const T = state.soil.dominant ? num(state.soil.dominant.tfact) : null;
    const EI = T ? E / T : null;
    const level = E < 10 ? 1 : E < 40 ? 2 : E < 80 ? 3 : E < 150 ? 4 : 5;
    const frac = level + Math.min(0.49, Math.max(-0.49,
      level === 1 ? E / 10 - 0.5 : level === 2 ? (E - 10) / 30 - 0.5 : level === 3 ? (E - 40) / 40 - 0.5 : level === 4 ? (E - 80) / 70 - 0.5 : (E - 150) / 150 - 0.5));
    return { E, EI, T, level, frac, C: cf.C, cSrc: cf.src, I: surf.wei, weg: surf.weg };
  }
  WG.riskModel = riskModel;

  const LEVEL_NAME = ["", "Low", "Moderate", "High", "Very high", "Extreme"];
  function renderRisk() {
    const rc = $("#riskCard");
    const r = riskModel();
    const w = state.wind;
    if (!r) {
      if (state.soil && (state.soil.error || !state.soil.surface)) {
        rc.className = "risk-card";
        $("#riskLevel").textContent = "Soil data unavailable";
        $("#riskText").textContent = state.soil.error ? `Soil survey request failed (${state.soil.error}). Try again or enter your soil test on the Soil tab.`
          : "No soil survey component with texture data here (water, urban or rock?). Enter your soil test on the Soil tab.";
      }
      return;
    }
    rc.className = `risk-card r${r.level}`;
    $("#riskLevel").textContent = `${LEVEL_NAME[r.level]} · ${fmt(r.E, 0)} t/ac/yr`;
    Ch.gauge($("#riskGauge"), r.frac);
    const peak = w && !w.error && w.riskMonths.length ? monthsText(w.riskMonths) : null;
    const ei = r.EI ? ` Erodibility index C·I/T = ${fmt(r.EI, 1)}${r.EI >= 8 ? " (≥ 8: highly erodible land by NRCS wind criteria)" : ""}.` : "";
    $("#riskText").innerHTML = `Potential loss from a bare, smooth, unsheltered field here (WEQ: soil index I = ${fmt(r.I, 0)} × climate C = ${fmt(r.C, 0)}).${esc(ei)}`
      + (peak ? ` Highest-risk window: <b>${esc(peak)}</b>.` : "")
      + ` Cover, residue, roughness and barriers can cut this by 80–99%.`;
  }

  function monthsText(idx) {
    if (!idx.length) return "";
    const s = [...idx].sort((a, b) => a - b);
    // group contiguous (wrap Dec→Jan)
    const runs = [];
    s.forEach(i => { const last = runs[runs.length - 1]; if (last && last[last.length - 1] === i - 1) last.push(i); else runs.push([i]); });
    if (runs.length > 1 && runs[0][0] === 0 && runs[runs.length - 1].slice(-1)[0] === 11) runs[0] = runs.pop().concat(runs[0]);
    return runs.map(r => r.length === 1 ? U.MONTHS[r[0]] : `${U.MONTHS[r[0]]}–${U.MONTHS[r[r.length - 1]]}`).join(", ");
  }
  WG.monthsText = monthsText;

  function speedTxt(ms, d = 1) { return state.units === "mph" ? `${fmt(U.msToMph(ms), d)} <small>mph</small>` : `${fmt(ms, d)} <small>m/s</small>`; }

  function renderStats() {
    const w = state.wind, s = state.soil;
    const surf = currentSurface();
    if (w && !w.error) {
      $("#stWind").innerHTML = speedTxt(w.meanSpeed);
      $("#stHours").innerHTML = `${fmt(w.eroHours, 0)} <small>h ≥ ${state.units === "mph" ? fmt(U.msToMph(w.thr), 0) + " mph" : w.thr + " m/s"}</small>`;
      $("#stDir").innerHTML = `${U.compass(w.prevailing)} <small>from ${fmt(w.prevailing, 0)}°</small>`;
      $("#monthStrip").innerHTML = w.months.map((m, i) => `<div class="m ${m.level}" title="${U.MONTHS_LONG[i]}: ${(m.share * 100).toFixed(0)}% of annual risk"><i></i>${U.MONTHS[i][0]}</div>`).join("");
      const stn = state.windStation && state.windStation.meta;
      const via = state.windKey === "cal" ? ` Wind calibrated to ${stn.name.replace(/,.*$/, "")} (${stn.id}) airport records.`
        : state.windKey === "station" ? ` From ${stn.id} airport records.` : state.windStationPending ? " Calibrating to the nearest airport…" : " Uncalibrated reanalysis.";
      $("#monthStripNote").textContent = (w.riskMonths.length
        ? `High-risk: ${monthsText(w.riskMonths)}. Red months carry ≥ 10% of the year's erosive wind energy under dry conditions — keep the soil covered or rough then.`
        : "Erosive wind is spread evenly across the year here.") + via;
    } else if (w && w.error) {
      ["stWind", "stHours", "stDir"].forEach(id => { $("#" + id).textContent = "n/a"; });
      $("#monthStrip").innerHTML = `<p class="fine" style="grid-column:1/-1">Wind history unavailable: ${esc(w.error)}</p>`;
    }
    if (surf) {
      $("#stWeg").innerHTML = surf.weg ? `WEG ${esc(surf.weg)} <small>I = ${fmt(surf.wei, 0)}</small>` : "—";
    } else if (s) $("#stWeg").textContent = "n/a";
    const cf = cFactor();
    if (cf) $("#stC").innerHTML = `${fmt(cf.C, 0)} <small>${cf.src.startsWith("NRCS") ? "NRCS" : "est."}</small>`;
    else if (s && w) $("#stC").textContent = "—";
    if (state.nlcd) $("#stLc").textContent = state.nlcd.name || "n/a";
  }

  /* ============ WIND TAB ============ */
  function renderWind() {
    const w = state.wind;
    if (!w) return;
    if (w.error) {
      $("#windSource").textContent = "Wind history could not be loaded: " + w.error;
      return;
    }
    $("#thrVal").textContent = state.units === "mph" ? `${fmt(U.msToMph(state.thr), 0)} mph` : `${state.thr} m/s`;
    const stn = state.windStation && state.windStation.meta;
    const key = state.windKey;
    $("#windSrcTag").textContent = key === "cal" ? `calibrated to ${stn.id} · ${w.start}–${w.end}`
      : key === "station" ? `${stn.id} station · ${w.start}–${w.end}`
        : state.windStationRetry ? "model · data limit, retrying in 1 min" : state.windStationPending ? "model · calibrating…" : w.dailyOnly ? "daily (fallback)" : `model · ${w.start}–${w.end}`;
    const sel = $("#srcSel");
    const sets = state.windSets || {};
    [...sel.options].forEach(o => { o.disabled = !sets[o.value]; });
    sel.value = key;
    if (!$("#tab-wind").hidden) renderWindCharts();
    renderCalibration();
    const yrs = `${w.start}–${w.end}`;
    const t = w.trend;
    $("#trendTag").textContent = t ? `${t.slope >= 0 ? "+" : ""}${fmt(t.slope * 10, 0)} h/decade` : "";
    $("#trendNote").textContent = t
      ? `Erosive-wind hours per year, ${yrs}. Linear trend ${t.slope >= 0 ? "+" : ""}${fmt(t.slope * 10, 0)} hours per decade (${t.significant ? "statistically significant at 95%" : "not statistically significant"} over ${w.annual.length} years). Red bars: ≥ 15% above average; gray: ≥ 15% below.`
      : "";
    const fmtS = v => state.units === "mph" ? `${fmt(U.msToMph(v), 1)} mph` : `${fmt(v, 1)} m/s`;
    const dpClass = w.dp === null ? "" : w.dp < 200 ? "low energy" : w.dp < 400 ? "intermediate" : "high energy";
    $("#windIdx").innerHTML = [
      ["Mean wind speed (10 m)", fmtS(w.meanSpeed)],
      ["Erosive-wind hours per year", `${fmt(w.eroHours, 0)} h (${fmt(w.eroHours / 87.6, 1)}% of time)`],
      ["Days per year with gusts ≥ 40 mph", fmt(w.gustDays, 0)],
      ["Prevailing erosive wind (from)", `${U.compass(w.prevailing)} (${fmt(w.prevailing, 0)}°)`],
      ["Resultant soil-transport direction (toward)", `${U.compass(w.rdd)} (${fmt(w.rdd, 0)}°)`],
      ["Best barrier / strip orientation", `${orientation(w)}`],
      ...(w.dp !== null ? [
        ["Sand drift potential DP (Fryberger & Dean)", `${fmt(w.dp, 0)} VU · ${dpClass}`],
        ["Resultant drift RDP / direction", `${fmt(w.rdp, 0)} VU toward ${U.compass(w.rddF)}; RDP/DP ${fmt(w.rdp / Math.max(w.dp, 1e-9), 2)} (${w.rdp / Math.max(w.dp, 1e-9) < 0.3 ? "multidirectional" : w.rdp / Math.max(w.dp, 1e-9) < 0.8 ? "intermediate" : "unidirectional"})`],
      ] : []),
      ["FAO wind-erosion climatic index (annual)", fmt(w.faoC, 0)],
      ["Annual precipitation / ET₀", `${fmt(w.precip / 25.4, 1)} in / ${fmt(w.et0 / 25.4, 1)} in (P/ET₀ = ${fmt(w.aridity, 2)})`],
    ].map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`).join("")
      + `<span class="d">${esc(sourceCaveat())}</span>`;
    const OM = `<a href="https://open-meteo.com/en/docs/historical-weather-api" target="_blank" rel="noopener">Open-Meteo</a>`;
    const IEMa = `<a href="https://mesonet.agron.iastate.edu/request/download.phtml" target="_blank" rel="noopener">Iowa Environmental Mesonet</a>`;
    const model = state.windSets && state.windSets.model;
    const reanalysis = model && model.dailyOnly
      ? "NASA POWER daily (MERRA-2, ~50 km)"
      : `ECMWF IFS 9 km analysis (2017 on) and ERA5 0.25° reanalysis (before 2017) via ${OM}, grid cell ${fmt(model ? model.lat : w.gridLat, 3)}, ${fmt(model ? model.lon : w.gridLon, 3)}`;
    $("#windSource").innerHTML = key === "cal"
      ? `Source: hourly 10 m wind from ${reanalysis}, calibrated month by month (quantile mapping) to hourly observations at ${esc(stn.name)} (${stn.id}, ${fmt(stn.km, 0)} km away, ${fmt(stn.coverage * 100, 0)}% of hours) from the ${IEMa}. Precipitation and FAO-56 ET₀ from the reanalysis. ${yrs}.`
      : key === "station"
        ? `Source: hourly airport observations (2-minute mean wind at 10 m) at ${esc(stn.name)} (${stn.id}, ${fmt(stn.km, 0)} km away, ${fmt(stn.coverage * 100, 0)}% of hours) from the ${IEMa}. Precipitation and ET₀ from ${reanalysis}. ${yrs}.`
        : `Source: hourly 10 m wind, precipitation and FAO-56 ET₀ from ${reanalysis}, ${yrs}. Not calibrated.`;
  }

  function sourceCaveat() {
    const stn = state.windStation && state.windStation.meta;
    if (state.windKey === "cal") return `Speeds follow the measured distribution at ${stn.id} for each month; timing and direction come from the reanalysis at this point. Airport winds are measured on open ground, so sheltered sites blow less.`;
    if (state.windKey === "station") return `Measured at the ${stn.id} airport, ${fmt(stn.km, 0)} km away; local terrain and surface can differ from this field.`;
    return state.windStationPending ? "Calibrating to the nearest airport station…"
      : "Uncalibrated reanalysis: at Lubbock and Midland it caught only ~40–45% of erosive hours and shifted the peak months earlier. No airport station with enough data within 150 km.";
  }

  function renderCalibration() {
    const card = $("#calCard");
    const c = state.windCompare, st = state.windStation, all = state.windAll || {};
    if (!st || !c) {
      card.hidden = !state.windStationPending;
      $("#calKv").innerHTML = `<span class="k">Looking for the nearest airport station…</span><span class="v"></span>`;
      return;
    }
    card.hidden = false;
    const m = st.meta;
    const cands = Wd.nearestStations(state.site.lat, state.site.lon, Wd.yearsFor(state.period).start);
    $("#stnSel").innerHTML = cands.map(c => `<option value="${esc(c.id)}" ${c.id === m.id ? "selected" : ""}>${esc(c.id)} · ${esc(c.name.replace(/,.*$/, ""))} · ${fmt(c.km, 0)} km${c.awos ? " · AWOS" : ""}</option>`).join("");
    const sp = v => state.units === "mph" ? `${fmt(U.msToMph(v), 1)} mph` : `${fmt(v, 2)} m/s`;
    const tm = a => a ? WG.monthsText(a.riskMonths) || "—" : "—";
    $("#calKv").innerHTML = [
      ["Station", `${m.name} (${m.id}${m.awos ? ", AWOS" : ""})`],
      ["Distance · data coverage", `${fmt(m.km, 0)} km · ${fmt(m.coverage * 100, 0)}% of hours`],
      ["Mean wind: station vs model", `${sp(c.meanObs)} vs ${sp(c.meanMod)} (${c.bias >= 0 ? "+" : ""}${fmt((c.bias / c.meanObs) * 100, 0)}%)`],
      ["Hourly agreement", `r = ${fmt(c.r, 2)}, RMSE ${sp(c.rmse)}`],
      ["Erosive hours caught by model", `${fmt((c.freqMod / Math.max(c.freqObs, 1e-9)) * 100, 0)}% (${fmt(c.freqMod * 100, 1)}% vs ${fmt(c.freqObs * 100, 1)}% of hours)`],
      ["High-risk months: station / model / calibrated", `${tm(all.station)} / ${tm(all.model)} / ${tm(all.cal)}`],
    ].map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`).join("");
    if (!$("#tab-wind").hidden) Ch.calib(all);
  }

  function orientation(w) {
    // barriers/strips should run perpendicular to the prevailing erosive wind
    const perp = (w.prevailing + 90) % 180;
    const a = U.compass(perp), b = U.compass(perp + 180);
    return `${a}–${b} rows (perpendicular to ${U.compass(w.prevailing)} winds)`;
  }
  WG.orientation = orientation;

  function renderWindCharts() {
    const w = state.wind;
    if (!w || w.error) return;
    Ch.season(w, state.units);
    Ch.speeds(w, state.units);
    Ch.water(w);
    Ch.trend(w);
    Ch.rose($("#roseBox"), w, state.units);
    if (state.windAll && state.windAll.station) Ch.calib(state.windAll);
    const tot = w.rose.reduce((a, r) => a + r.bins.reduce((x, y) => x + y, 0), 0);
    $("#roseNote").textContent = `Erosive winds blow ${fmt(tot, 1)}% of the time, mostly from the ${U.compass(w.prevailing)}. Soil moves toward the ${U.compass(w.rdd)}.`;
  }

  $("#unitSel").addEventListener("change", e => { state.units = e.target.value; renderWind(); renderStats(); });
  $("#thrRange").addEventListener("input", U.debounce(e => {
    state.thr = +e.target.value;
    if (state.windSets) { chooseWind(); renderWind(); renderStats(); renderRisk(); renderPractices(); }
    $("#thrVal").textContent = state.units === "mph" ? `${fmt(U.msToMph(state.thr), 0)} mph` : `${state.thr} m/s`;
  }, 120));
  $("#srcSel").addEventListener("change", e => {
    state.windSource = e.target.value;
    if (state.windSets) { chooseWind(); renderWind(); renderStats(); renderRisk(); renderPractices(); }
  });
  $("#periodSel").addEventListener("change", e => {
    state.period = +e.target.value;
    if (!state.site) return;
    state.wind = null;
    $("#windSrcTag").textContent = "loading…";
    loadWind(state.token);
  });

  /* ============ SOIL TAB ============ */
  function renderSoil() {
    const s = state.soil;
    if (!s || s.error) {
      const msg = s && s.error ? `Soil survey request failed: ${esc(s.error)}` : "No soil survey map unit at this point.";
      $("#soilSummary").innerHTML = `<p class="fine">${msg}</p>`;
      $("#ovSoil").innerHTML = `<p class="fine">${msg}</p>`;
      return;
    }
    const d = s.dominant;
    if (!d) { $("#soilSummary").innerHTML = `<p class="fine">Map unit ${esc(s.mapunit.muname)} has no component data.</p>`; return; }
    const surf = s.surface;
    if (surf) {
      $("#inSand").value = surf.sand ?? "";
      $("#inSilt").value = surf.silt ?? "";
      $("#inClay").value = surf.clay ?? "";
      $("#inOm").value = surf.om ?? "";
      $("#inCaco3").value = surf.caco3 ?? 0;
      $("#inPh").value = surf.ph ?? "";
    }
    renderSoilSummary();
    renderSoilDetail();
  }

  function renderSoilSummary() {
    const s = state.soil;
    if (!s || s.error || !s.dominant) return;
    const d = s.dominant, surf = currentSurface();
    const site = S.siteParams(s, d, surf);
    const others = s.components.filter(c => c.cokey !== d.cokey && c.comppct_r >= 5);
    const tex = surf ? (surf.texName || S.TEX[surf.texCode] || surf.texCode) : "—";
    const chips = [
      surf && surf.weg ? `<span class="chip ${S.WEG_RISK[surf.weg] >= 4 ? "warn" : S.WEG_RISK[surf.weg] <= 1 ? "ok" : ""}">WEG ${esc(surf.weg)} · I ${fmt(surf.wei, 0)} t/ac/yr${surf.calc ? " (from your values)" : ""}</span>` : "",
      tex ? `<span class="chip">Surface: ${esc(tex)}</span>` : "",
      site.slope !== null ? `<span class="chip">Slope ${fmt(site.slope, 1)}%</span>` : "",
      site.drainage ? `<span class="chip">${esc(site.drainage)}</span>` : "",
      site.hydgrp ? `<span class="chip">Hydrologic group ${esc(site.hydgrp)}</span>` : "",
      site.depth ? `<span class="chip">${site.restriction ? `${esc(site.restriction.kind)} at ${fmt(site.restriction.depth, 0)} cm` : `Deep (> ${fmt(site.depth, 0)} cm)`}</span>` : "",
      d.eco ? `<span class="chip">${esc(d.eco.ecoclassname)}</span>` : "",
      s.mlra ? `<span class="chip">MLRA ${esc(s.mlra.sym)} · ${esc(s.mlra.name)}</span>` : "",
    ].join("");
    const html = `<div><div class="nm">${esc(d.compname)} <span style="font-weight:500;color:#69716a;font-size:13px">${fmt(d.comppct_r, 0)}% of map unit</span></div>
      <div class="sub">${esc(s.mapunit.muname || "")}</div>
      <div class="sub">${esc(d.taxclname || "")}</div></div>
      <div class="chips">${chips}</div>
      ${!s.dominantIsTop ? `<p class="fine">Largest component (${esc(s.components[0].compname)}) has no horizon data; showing the largest soil component.</p>` : ""}
      ${others.length ? `<p class="fine">Also in this map unit: ${others.map(c => `${esc(c.compname)} ${fmt(c.comppct_r, 0)}%`).join(" · ")}</p>` : ""}`;
    $("#soilSummary").innerHTML = html;
    $("#ovSoil").innerHTML = `<div class="nm">${esc(d.compname)} ${tex ? "· " + esc(tex) : ""}</div><div class="sub">${esc(s.mapunit.muname || "")}</div><div class="chips">${chips}</div>`;
    $("#soilSrcTag").textContent = `SSURGO · ${s.mapunit.areasymbol || ""}`;
    $("#soilSource").innerHTML = `Source: USDA-NRCS Soil Survey Geographic Database (SSURGO) via <a href="https://sdmdataaccess.nrcs.usda.gov/" target="_blank" rel="noopener">Soil Data Access</a>, map unit key ${s.mukey}, ${esc(s.mapunit.areaname || "")}${s.mapunit.saverest ? `, survey dated ${esc(String(s.mapunit.saverest).slice(0, 10))}` : ""}. Elevation/slope: Copernicus 90 m DEM via Open-Meteo. Water retention for edited layers: Saxton &amp; Rawls (2006).`;
    renderDerived();
  }

  function renderDerived() {
    const s = state.soil;
    if (!s || !s.surface) return;
    const surf = currentSurface(), base = s.surface;
    // survey water retention for the mapped soil; Saxton & Rawls only once the user edits texture/OM
    const hz0 = s.dominant.horizons[0] || {};
    const surveyed = !state.edits && num(hz0.wfifteenbar_r) !== null && num(hz0.wthirdbar_r) !== null;
    const sr = surveyed
      ? { ll: num(hz0.wfifteenbar_r) / 100, dul: num(hz0.wthirdbar_r) / 100,
          awc: num(hz0.awc_r) ?? (num(hz0.wthirdbar_r) - num(hz0.wfifteenbar_r)) / 100,
          ksat: num(hz0.ksat_r) !== null ? num(hz0.ksat_r) * 3.6 : null }
      : S.saxtonRawls(surf.sand, surf.clay, surf.om);
    const ch = (a, b) => (state.edits && a !== b ? "chg" : "");
    const cells = [
      ["Texture class", surf.texName || S.TEX[surf.texCode] || "—", ch(surf.texCode, base.texCode)],
      ["Wind erodibility group", surf.weg || "—", ch(surf.weg, base.weg)],
      ["Erodibility index I", surf.wei !== null ? `${fmt(surf.wei, 0)} t/ac/yr` : "—", ch(surf.wei, base.wei)],
      ["Organic carbon", surf.om !== null ? `${fmt(surf.om / 1.724, 2)}%` : "—", ""],
      ["Wilting point (15 bar)", sr ? `${fmt(sr.ll, 3)} cm³/cm³` : "—", ""],
      ["Field capacity (⅓ bar)", sr ? `${fmt(sr.dul, 3)} cm³/cm³` : "—", ""],
      ["Plant-available water", sr ? `${fmt(sr.awc * 12, 2)} in/ft` : "—", ""],
      ["Sat. conductivity", sr && sr.ksat !== null ? `${fmt(sr.ksat / 25.4, 2)} in/h` : "—", ""],
    ];
    $("#soilDerived").innerHTML = cells.map(([k, v, c]) => `<div><span>${esc(k)}</span><b class="${c}">${esc(v)}</b></div>`).join("")
      + (surf.calc ? `<div style="grid-column:1/-1"><span>WEG rule applied</span><b>${esc(surf.calc.why)}</b></div>` : "");
  }

  function onSoilEdit(e) {
    const s = state.soil;
    if (!s || !s.surface) return;
    const g = id => { const v = $("#" + id).value; return v === "" ? null : +v; };
    let sand = g("inSand"), silt = g("inSilt"), clay = g("inClay");
    if (e && (e.target.id === "inSand" || e.target.id === "inClay") && sand !== null && clay !== null) {
      silt = Math.max(0, +(100 - sand - clay).toFixed(1));
      $("#inSilt").value = silt;
    }
    if (sand !== null && clay !== null && silt !== null && Math.abs(sand + silt + clay - 100) > 1.5) {
      U.toast(`Sand + silt + clay = ${fmt(sand + silt + clay, 0)}%. Adjust so they add to 100.`);
    }
    const ed = { sand, silt, clay, om: g("inOm"), caco3: g("inCaco3") ?? 0, ph: g("inPh") };
    const b = s.surface;
    const same = ["sand", "silt", "clay", "om", "caco3", "ph"].every(k => (ed[k] ?? null) === (b[k] ?? (k === "caco3" ? 0 : null)));
    state.edits = same ? null : ed;
    $$("#soilEdit input").forEach(i => {
      const k = { inSand: "sand", inSilt: "silt", inClay: "clay", inOm: "om", inCaco3: "caco3", inPh: "ph" }[i.id];
      i.classList.toggle("edited", !!state.edits && (ed[k] ?? null) !== (b[k] ?? (k === "caco3" ? 0 : null)));
    });
    $("#resetSoilBtn").hidden = !state.edits;
    renderSoilSummary(); renderSoilDetail(); renderRisk(); renderStats(); renderPractices();
  }
  $$("#soilEdit input").forEach(i => i.addEventListener("change", onSoilEdit));
  $("#resetSoilBtn").addEventListener("click", () => { state.edits = null; renderSoil(); onSoilEdit(); });

  $("#profileToggle").addEventListener("click", () => {
    const b = $("#profileToggle"), open = b.getAttribute("aria-expanded") !== "true";
    b.setAttribute("aria-expanded", open);
    $("#profileDetail").hidden = !open;
    if (open) renderSoilDetail();
  });

  function renderSoilDetail() {
    const s = state.soil;
    const box = $("#profileDetail");
    if (box.hidden || !s || s.error || !s.dominant) return;
    const d = s.dominant, surf = currentSurface();
    const layers = S.profileLayers(d, state.edits ? { sand: surf.sand, silt: surf.silt, clay: surf.clay, om: surf.om, ph: surf.ph, caco3: surf.caco3 } : null);
    const site = S.siteParams(s, d, surf);
    const f = (v, n) => (v === null || v === undefined ? "—" : fmt(v, n));
    const cols = [
      ["Horizon", l => esc(l.hz) + (l.edited ? " ✎" : ""), ""], ["Depth", l => `${f(l.top, 0)}–${f(l.bot, 0)}`, "cm"],
      ["Texture", l => esc(l.texture), ""], ["Sand", l => f(l.sand, 1), "%"], ["Silt", l => f(l.silt, 1), "%"],
      ["Clay", l => f(l.clay, 1), "%"], ["V.f. sand", l => f(l.vfs, 1), "%"], ["OM", l => f(l.om, 2), "%"],
      ["Org. C", l => f(l.oc, 2), "%"], ["Bulk dens.", l => f(l.bd, 2), "g/cm³"], ["LL 15 bar", l => f(l.ll, 3), "cm³/cm³"],
      ["DUL ⅓ bar", l => f(l.dul, 3), "cm³/cm³"], ["Saturation", l => f(l.sat, 3), "cm³/cm³"], ["AWC", l => f(l.awc, 3), "cm/cm"],
      ["Ksat", l => f(l.ksat, 2), "cm/h"], ["pH", l => f(l.ph, 1), "1:1 H₂O"], ["CEC", l => f(l.cec, 1), "cmol/kg"],
      ["CaCO₃", l => f(l.caco3, 0), "%"], ["Gypsum", l => f(l.gypsum, 0), "%"], ["EC", l => f(l.ec, 1), "dS/m"],
      ["SAR", l => f(l.sar, 0), ""], ["Coarse frag.", l => f(l.cf, 0), "%"], ["Kw", l => f(l.kw, 2), ""],
      ["Root growth", l => f(l.srgf, 2), "factor"], ["Total N est.", l => f(l.ni, 3), "%"],
    ];
    const table = `<div class="table-wrap"><table class="grid"><thead><tr>${cols.map(c => `<th>${c[0]}${c[2] ? `<small>${c[2]}</small>` : ""}</th>`).join("")}</tr></thead>
      <tbody>${layers.map(l => `<tr>${cols.map((c, i) => `<td class="${i === 2 ? "l" : ""}">${c[1](l)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    const P = (k, v) => `<div><span>${esc(k)}</span><b>${v}</b></div>`;
    const e = state.elev;
    const params = [
      P("Soil order", esc(d.taxorder || "—")), P("Great group", esc(d.taxgrtgroup || "—")), P("Subgroup", esc(d.taxsubgrp || "—")),
      P("Particle-size class", esc(d.taxpartsize || "—")), P("Temperature regime", esc(d.taxtempregime || "—")), P("Moisture subclass", esc(d.taxmoistscl || "—")),
      P("Slope (survey)", site.slope !== null ? `${fmt(site.slope, 1)}% (${f(site.slopeRange[0], 0)}–${f(site.slopeRange[1], 0)})` : "—"),
      P("Slope (90 m DEM)", e ? `${fmt(e.slope, 1)}%, facing ${U.compass(e.aspect)}` : "—"),
      P("Elevation", e ? `${fmt(e.z, 0)} m (${fmt(e.z * 3.28084, 0)} ft)` : (d.elev_r ? `${fmt(d.elev_r, 0)} m` : "—")),
      P("Soil depth", site.depth ? `${fmt(site.depth, 0)} cm` : "—"),
      P("Restrictive layer", site.restriction ? `${esc(site.restriction.kind)} at ${fmt(site.restriction.depth, 0)} cm` : "none reported"),
      P("Drainage class", esc(site.drainage || "—")), P("Hydrologic group", esc(site.hydgrp || "—")), P("Surface runoff", esc(site.runoff || "—")),
      P("Dry albedo", f(site.albedo, 2)), P("Stage-1 evaporation limit", `${f(site.u, 0)} mm`), P("Drainage rate", site.drainRate !== null ? `${f(site.drainRate, 2)} /day` : "—"),
      P("Runoff curve number", f(site.cn, 0)), P("Avail. water 0–150 cm", site.aws150 !== null ? `${fmt(site.aws150, 1)} cm` : "—"),
      P("T factor (tolerable loss)", site.tfact !== null ? `${fmt(site.tfact, 0)} t/ac/yr` : "—"), P("Kw (surface)", f(site.kw, 2)),
      P("WEG / I", surf ? `${esc(surf.weg || "—")} / ${f(surf.wei, 0)}` : "—"),
      P("Capability class (dry / irr.)", `${esc(site.lcc || "—")} / ${esc(site.lccIrr || "—")}`),
      P("Climatic factor C", s.cFactor ? fmt(s.cFactor, 0) : "—"), P("Rainfall factor R", s.rFactor ? fmt(s.rFactor, 0) : "—"),
      P("Mean annual precip", site.map ? `${fmt(site.map / 25.4, 0)} in` : "—"), P("Mean annual air temp", site.airtemp ? `${fmt(site.airtemp, 1)} °C` : "—"),
      P("Frost-free days", site.ffd ? fmt(site.ffd, 0) : "—"),
      P("Range production (normal yr)", site.rsprod ? `${fmt(site.rsprod, 0)} lb/ac` : "—"),
      P("Ecological site", d.eco ? `<a href="https://edit.jornada.nmsu.edu/catalogs/esd/${esc(d.eco.ecoclassid.slice(1, 5))}/${esc(d.eco.ecoclassid)}" target="_blank" rel="noopener">${esc(d.eco.ecoclassid)}</a>` : "—"),
      P("MLRA", s.mlra ? `${esc(s.mlra.sym)}` : "—"), P("Survey area", esc(s.mapunit.areasymbol || "—")), P("Map unit key", esc(String(s.mukey))),
    ].join("");
    const yields = d.yields.length ? `<div><h4>Typical yields (survey estimates)</h4><div class="table-wrap"><table class="grid"><thead><tr><th>Crop</th><th>Dryland</th><th>Irrigated</th><th>Units</th></tr></thead>
      <tbody>${d.yields.map(y => `<tr><td>${esc(y.cropname)}</td><td>${f(num(y.nonirryield_r), 0)}</td><td>${f(num(y.irryield_r), 0)}</td><td>${esc(y.yldunits || "")}</td></tr>`).join("")}</tbody></table></div></div>` : "";
    const plants = d.plants.filter(p => p.plantsciname).slice(0, 12);
    const plantTbl = plants.length ? `<div><h4>Reference native plant community (% of production)</h4><div class="table-wrap"><table class="grid"><thead><tr><th>Plant</th><th>Scientific name</th><th>%</th></tr></thead>
      <tbody>${plants.map(p => `<tr><td>${esc(p.plantcomname || p.plantsym)}</td><td class="l"><i>${esc(p.plantsciname)}</i></td><td>${f(num(p.rangeprod), 0)}</td></tr>`).join("")}</tbody></table></div></div>` : "";
    const comps = `<div><h4>Components in this map unit</h4><div class="table-wrap"><table class="grid"><thead><tr><th>Component</th><th>%</th><th>WEG</th><th>I</th><th>Slope</th><th>Drainage</th><th>Ecological site</th></tr></thead>
      <tbody>${s.components.map(c => `<tr><td>${esc(c.compname)}${c.cokey === d.cokey ? " ★" : ""}</td><td>${f(c.comppct_r, 0)}</td><td>${esc(c.weg || "—")}</td><td>${f(num(c.wei), 0)}</td><td>${f(num(c.slope_r), 1)}</td><td class="l">${esc(c.drainagecl || "—")}</td><td class="l">${esc(c.eco ? c.eco.ecoclassname : "—")}</td></tr>`).join("")}</tbody></table></div></div>`;
    box.innerHTML = `<div><h4>Horizons — ${esc(d.compname)}</h4>${table}<p class="fine">Water retention, conductivity and bulk density come from the survey; rows marked ✎ use your edited values with Saxton &amp; Rawls (2006). Root growth factor = exp(−0.02 × mid-depth) below 15 cm, 0 below a restrictive layer. Total N estimated as organic C ÷ 10.</p></div>
      <div><h4>Site and classification</h4><div class="param-grid">${params}</div></div>
      ${comps}${yields}${plantTbl}
      <div class="export-row"><button class="btn small" id="dlCsv">Download CSV</button><button class="btn small" id="dlSol">Download crop-model .SOL</button></div>`;
    $("#dlCsv").onclick = () => U.download(`soil_${s.mukey}_${d.compname.replace(/\W+/g, "_")}.csv`, S.toCSV(s, layers, site), "text/csv");
    $("#dlSol").onclick = () => U.download(`WG${s.mukey}.SOL`, S.toSOL(s, layers, site, s.mukey % 1e8));
  }

  /* ============ PRACTICES TAB ============ */
  function renderPractices() {
    if (!WG.practices) return;
    WG.practices.render({
      grid: $("#luGrid"), qWrap: $("#luQuestions"), qBox: $("#qBox"), plan: $("#planBox"), suggestTag: $("#lcSuggest"),
      state, surface: currentSurface(), risk: riskModel(), onChange: () => renderPractices(),
    });
  }

  /* first paint */
  buildLayerSheet();
  const params = new URLSearchParams(location.search);
  if (params.get("lat") && params.get("lon")) selectSite(+params.get("lat"), +params.get("lon"), { zoom: 13 });
})();
