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
    windStation: null,   // station data used for calibration: an airport, or a West Texas Mesonet tower when on
    windAirport: null,   // airport data: gusts for a tower calibration and the "station only" series
    windTower: null,     // tower that ranks ahead of every airport, while its records load
    windSkipped: [],     // towers read but not used: they read low against the airport (probably sheltered)
    windSource: "cal",   // preferred source: cal | station | model
    gridModel: "merra2", // gridded wind: merra2 (NASA POWER, direct) | ecmwf (IFS/ERA5 via Open-Meteo, the backup)
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
  const KEEP_Q = Wd.wtmTrial ? "&wtm=1" : ""; // a local mesonet test survives a reload (the public site ignores ?wtm=1)

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

  /* County lines drawn by the Census TIGERweb map service for each tile. Its county layers 1–13 each cover a range of
     map scales, so asking for all of them gives the right detail at every zoom. */
  const TIGER_COUNTIES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/export";
  const CensusCounties = L.TileLayer.extend({
    getTileUrl(c) {
      const a = L.CRS.EPSG3857.project(this._map.unproject([c.x * 256, c.y * 256], c.z));
      const b = L.CRS.EPSG3857.project(this._map.unproject([(c.x + 1) * 256, (c.y + 1) * 256], c.z));
      return `${this._url}?bbox=${a.x},${b.y},${b.x},${a.y}&bboxSR=3857&imageSR=3857&size=256,256`
        + "&layers=show:1,3,5,7,9,11,13&format=png32&transparent=true&f=image";
    },
  });

  const refs = {
    labels: { name: "Place, river and county names", sub: "towns, rivers, lakes, landmarks",
      layer: L.tileLayer(esri("Reference/World_Reference_Overlay"), { pane: "labels", maxZoom: 19, attribution: "Labels © Esri" }), on: true },
    roads: { name: "Roads and street names", sub: "highways, county roads, streets",
      layer: L.tileLayer(esri("Reference/World_Transportation"), { pane: "refs", maxZoom: 19, opacity: 0.95 }), on: true },
    hydro: { name: "Rivers, streams, lakes", sub: "USGS National Hydrography lines",
      layer: L.tileLayer(usgs("USGSHydroCached"), { pane: "refs", maxZoom: 19, maxNativeZoom: 16, opacity: 0.9 }), on: true },
    counties: { name: "County lines", sub: "U.S. Census TIGER, exact at every zoom",
      layer: new CensusCounties(TIGER_COUNTIES, { pane: "refs", maxZoom: 19, opacity: 0.85, className: "county-lines", attribution: "Counties: U.S. Census TIGER" }),
      on: true },
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
        attribution: "USDA-NRCS SSURGO" }), on: false },
  };

  let baseKey = "sat";
  bases.sat.layer.addTo(map);
  Object.values(refs).forEach(r => r.on && r.layer.addTo(map));
  Object.values(themes).forEach(t => t.on && t.layer.addTo(map));
  Object.values(soilLayers).forEach(t => t.on && t.layer.addTo(map));
  /* ---------- region: only the chosen state is shown ----------
     Everything outside it is covered and the map can't be panned or zoomed away from it. Texas is the only state with
     data so far; the picker lists the others for later, and setRegion takes a list so states can be combined. */
  const REGION_GEO = { TX: LAYERS.texas };
  map.createPane("mask").style.zIndex = 460; // above every tile and overlay pane, below pins and tooltips
  map.getPane("mask").style.pointerEvents = "none";
  const maskRenderer = L.svg({ pane: "mask", padding: 1 }); // wide padding: no uncovered edge while dragging
  map.options.maxBoundsViscosity = 0.9;
  let regionLayer = null, regionBounds = null;
  function setRegion(codes) {
    const geos = codes.map(c => REGION_GEO[c]).filter(Boolean);
    if (!geos.length) return;
    if (regionLayer) map.removeLayer(regionLayer);
    const gc = { type: "GeometryCollection", geometries: geos };
    const holes = geos.flatMap(g => (g.type === "MultiPolygon" ? g.coordinates : [g.coordinates]).map(p => p[0].map(([x, y]) => [y, x])));
    const world = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#f3f1ea";
    regionLayer = L.layerGroup([
      L.polygon([world, ...holes], { renderer: maskRenderer, stroke: false, fillColor: bg, fillOpacity: 1, interactive: false }),
      L.geoJSON(gc, { renderer: maskRenderer, interactive: false, style: { color: "#33403a", weight: 2, fill: false } }),
    ]).addTo(map);
    regionBounds = L.geoJSON(gc).getBounds();
    map.setMaxBounds(regionBounds.pad(0.2));
    fitMinZoom();
    map.fitBounds(regionBounds, { animate: false });
    state.region = codes;
    const sel = $("#regionSel");
    $("#regionLabel").textContent = codes.length > 1 ? `${codes.length} states` : sel.selectedOptions[0].textContent;
    $("#regionLabel").dataset.short = codes.length > 1 ? `${codes.length}` : codes[0];
  }
  function fitMinZoom() { // no zooming out past the whole state
    if (regionBounds) map.setMinZoom(Math.max(3, map.getBoundsZoom(regionBounds.pad(0.05))));
  }
  map.on("resize", fitMinZoom);
  $("#regionSel").addEventListener("change", e => setRegion([e.target.value]));
  setRegion(["TX"]);

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
  const openSheet = open => {
    $("#layerSheet").hidden = !open;
    $("#sheetBackdrop").hidden = !open;
    if (!open) $("#methodsSheet").hidden = true;
  };
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
    if (!items.length) { results.innerHTML = `<button disabled>No matches in Texas</button>`; results.hidden = false; return; }
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
      showResults(rows.filter(r => inTexas(+r.lat, +r.lon)).map(r => ({
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
      selectSite(p.coords.latitude, p.coords.longitude, { zoom: 15, why: "Your location is outside Texas. WindGuard TX covers Texas only." });
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
  map.on("click", e => { if (!(WG.area && WG.area.drawing())) pickSite(e.latlng.lat, e.latlng.lng, { keepZoom: true }); });
  // not-allowed cursor outside the outline, so the limit shows before a click
  map.on("mousemove", e => map.getContainer().classList.toggle("off-tx", !inTexas(e.latlng.lat, e.latlng.lng)));
  map.on("mouseout", () => map.getContainer().classList.remove("off-tx"));

  /* Even-odd ray test against the drawn Texas outline (Census 1:5M, mainland and islands). */
  const TX_POLYS = LAYERS.texas.coordinates.map(poly => {
    const xs = poly[0].map(c => c[0]), ys = poly[0].map(c => c[1]);
    return { rings: poly, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  });
  function inTexas(lat, lon) {
    return TX_POLYS.some(({ rings, box }) => {
      if (lon < box[0] || lon > box[2] || lat < box[1] || lat > box[3]) return false;
      let inside = false;
      rings.forEach(r => {
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
          const [xi, yi] = r[i], [xj, yj] = r[j];
          if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
        }
      });
      return inside;
    });
  }

  WG.inTexas = inTexas;

  /* Map clicks and pin drags: refuse points on a building, road or water body (area.js asks USA Structures, Census
     TIGER and USGS NHD; if they are slow the point is accepted). */
  let pickSeq = 0;
  async function pickSite(lat, lon, opts) {
    if (!inTexas(lat, lon) || !WG.area) return selectSite(lat, lon, opts);
    const my = ++pickSeq, el = map.getContainer();
    el.classList.add("checking");
    const hit = await WG.area.excludedAt(lat, lon);
    if (my !== pickSeq) return;
    el.classList.remove("checking");
    if (!hit) return selectSite(lat, lon, opts);
    U.toast(`That spot is ${hit.label} according to ${hit.src}. Pick a point on open land.`, 4500);
    if (marker && state.site) marker.setLatLng([state.site.lat, state.site.lon]);
  }

  function selectSite(lat, lon, opts = {}) {
    if (!inTexas(lat, lon)) {
      U.toast(opts.why || "WindGuard TX covers Texas only. Pick a point inside the white outline.");
      if (marker && state.site) marker.setLatLng([state.site.lat, state.site.lon]); // undo a drag across the line
      return;
    }
    state.site = { lat, lon };
    state.token++;
    state.soil = null; state.edits = null; state.wind = null; state.windRaw = null; state.windSets = null; state.windStation = null; state.windAirport = null; state.windTower = null; state.windSkipped = []; state.nlcd = null; state.elev = null;
    state.place = opts.place || null;

    const ll = L.latLng(lat, lon);
    if (!marker) {
      marker = L.marker(ll, { draggable: true, icon: L.divIcon({ className: "", html: '<div class="pin"></div>', iconSize: [30, 30], iconAnchor: [15, 30] }) }).addTo(map);
      marker.on("dragend", () => { const p = marker.getLatLng(); pickSite(p.lat, p.lng, { keepZoom: true }); });
    } else marker.setLatLng(ll);

    const wasOpen = app.classList.contains("has-site") && !app.classList.contains("map-big");
    const z = opts.keepZoom ? Math.max(map.getZoom(), 9) : opts.zoom || Math.max(map.getZoom(), 12);
    if (wasOpen) map.setView(ll, z, { animate: true });
    else { pendingView = { ll, z }; setLayout("split"); }

    try { history.replaceState(null, "", `?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}${KEEP_Q}`); } catch (e) { /* file:// */ }
    renderHeader();
    resetPanels();
    showTab("overview");
    analyzeSite(state.token);
  }

  function renderHeader() {
    const { lat, lon } = state.site;
    $("#siteName").textContent = state.place || "Selected location";
    $("#siteCoords").textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    $("#siteElev").textContent = state.elev ? `${fmt(state.elev.z * 3.28084, 0)} ft elev · ${fmt(state.elev.slope, 1)}% slope (${state.elev.src.replace(/ \d+ m.*$/, "")})` : "";
  }

  function resetPanels() {
    const rc = $("#riskCard");
    rc.className = "risk-card loading";
    $("#riskLevel").textContent = "Analyzing…";
    $("#riskText").textContent = `Fetching the soil survey and ${state.period} years of hourly wind for this point…`;
    Ch.gauge($("#riskGauge"), null);
    renderRiskScale(0);
    $("#riskUnit").textContent = "";
    ["stWind", "stHours", "stDir", "stWeg", "stC", "stLc"].forEach(id => {
      $("#" + id).innerHTML = '<span class="skeleton" style="width:70%"></span>';
      $("#" + id + "S").textContent = "";
    });
    renderWegTable(null);
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
      fetchElevation(lat, lon).then(e => { if (live()) { state.elev = e; renderHeader(); renderSoilSummary(); renderSoilDetail(); } }).catch(() => {}),
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

  let windSeq = 0, stnSeq = 0; // a newer period/model request supersedes an older one; a newer station pick an older pick
  async function loadWind(tok) {
    const { lat, lon } = state.site;
    const seq = ++windSeq;
    stnSeq++;
    const live = () => tok === state.token && seq === windSeq;
    let failed = false;
    const towerLive = () => !failed && live() && !state.windStationChoice; // a pick, a newer load or a failed load stops the tower read
    try {
      // airport observations download in parallel; the gridded model shows first, calibration follows. A West Texas
      // Mesonet tower that ranks ahead of every airport (mesonet on) loads alongside and replaces the airport's speed
      // calibration if it passes the exposure check; gusts stay with the airport.
      state.windStationChoice = null;
      state.windStationPending = true;
      state.windTower = Wd.towerFirst(lat, lon, state.period);
      const tried = []; // every tower read, so a second try never reads one again
      const onTry = s => { tried.push(s.id); if (towerLive()) { state.windTower = s; renderWind(); } };
      const stationJob = Wd.findStation(lat, lon, state.period).catch(e => { console.warn("station lookup failed", e); return null; });
      let job = state.windTower ? Wd.findStation(lat, lon, state.period, null, { towers: true, live: towerLive, onTry })
        .catch(e => { console.warn("tower lookup failed", e); return null; }) : null;
      const raw = await Wd.fetchWind(lat, lon, state.period, state.gridModel);
      if (!live()) return;
      state.windSets = { model: raw };
      state.windStation = null;
      state.windAirport = null; // reset with the sets: the old "station only" series and its airport go together
      state.windSkipped = [];
      chooseWind();
      renderWind(); renderRisk(); renderStats(); renderPractices();
      const st = await withModel(await stationJob, raw, live);
      if (!live()) return;
      applyStation(st, tok);
      // a tower is used if it passes the exposure check against the airport, or unchecked when no airport was found.
      // One that reads low (probably sheltered) or cannot be compared is skipped: one more is checked, then the airport stays.
      while (job) {
        const tw = await withModel(await job, raw, towerLive);
        if (!towerLive()) return;
        if (!tw || !tw.mod) break;
        const x = towerExposure(tw);
        if (x ? x.ero >= Wd.EXPOSURE_MIN : !state.windAirport) { state.windTower = null; applyStation(tw, tok); return; }
        state.windSkipped.push(tw.meta);
        job = state.windSkipped.length < 2 && Wd.towerFirst(lat, lon, state.period, tried)
          ? Wd.findStation(lat, lon, state.period, null, { towers: true, live: towerLive, skip: tried, onTry }).catch(() => null) : null;
      }
      state.windTower = null;
      renderWind(); renderStats(); // no usable tower: the airport calibration stays
    } catch (err) {
      failed = true;
      if (!live()) return;
      state.windStationPending = false;
      state.windTower = null;
      state.wind = { error: err.message || String(err) };
      renderWind(); renderRisk(); renderStats();
    }
  }

  /* Tower vs the current airport, each relative to the model: {mean, ero} ratios, null without an airport. */
  function towerExposure(tw) {
    const ap = state.windAirport;
    tw.meta.exposure = ap && ap.mod ? Wd.exposure(tw, ap) : null;
    tw.meta.expAp = ap ? ap.meta.id : null;
    return tw.meta.exposure;
  }

  /* Add the site's gridded model at the station to train the calibration; on an Open-Meteo per-minute
     quota error wait a minute and try once more. Without it the station series is still usable. */
  async function withModel(st, raw, live) {
    if (!st) return null;
    const get = () => Wd.fetchModelAt(raw.model, st.meta.lat, st.meta.lon, st.meta.y0, st.meta.y1);
    try {
      st.mod = await get();
    } catch (e) {
      if (!/limit/i.test(e.message || "")) { console.warn("model at station failed", e); return st; }
      state.windStationRetry = true;
      if (live()) renderWind();
      await new Promise(r => setTimeout(r, 65000));
      state.windStationRetry = false;
      if (!live()) return null;
      st.mod = await get().catch(() => null);
    }
    return st;
  }

  function applyStation(st, tok) {
    if (tok !== state.token || !state.windSets) return;
    state.windStationPending = false;
    const raw = state.windSets.model;
    state.windSets = { model: raw };
    state.windStation = st;
    if (st && !st.meta.tower) state.windAirport = st;
    const ap = state.windAirport;
    if (ap) state.windSets.station = Wd.stationRaw(raw, ap); // "station only" is always an airport (towers cover only their latest years)
    if (st && st.mod) state.windSets.cal = Wd.calibrate(raw, st, st.meta.tower ? ap : st);
    chooseWind();
    renderWind(); renderRisk(); renderStats(); renderPractices();
  }

  /* User picked another calibration station; a newer pick or a new load supersedes it (and stops a tower read). */
  $("#stnSel").addEventListener("change", async e => {
    const tok = state.token, seq = windSeq, my = ++stnSeq, id = e.target.value;
    if (!state.site || !state.windSets) return;
    const live = () => tok === state.token && seq === windSeq && my === stnSeq;
    state.windStationChoice = id;
    state.windStationPending = true;
    state.windTower = null;
    renderWind();
    const st = await Wd.findStation(state.site.lat, state.site.lon, state.period, id, { live }).catch(() => null);
    if (!live()) return;
    if (!st) U.toast(`No usable data at ${id} for this period.`);
    const withMod = st ? await withModel(st, state.windSets.model, live) : null;
    if (!live()) return;
    if (withMod && withMod.meta.tower && withMod.mod) towerExposure(withMod); // shown, not enforced: the user chose it
    applyStation(withMod || state.windStation, tok);
  });

  /* Pick the preferred available wind series and analyze every source for the comparison card. */
  function chooseWind() {
    const sets = state.windSets || {};
    const pref = state.windSource;
    const key = sets[pref] ? pref : sets.cal ? "cal" : "model";
    state.windKey = key;
    state.windRaw = sets[key];
    state.windAll = Object.fromEntries(Object.entries(sets).map(([k, r]) => [k, Wd.analyze(r, state.thr)]));
    state.wind = state.windAll[key];
    state.windCompare = state.windStation && state.windStation.mod ? Wd.compare(state.windStation, state.thr) : null;
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

  /* Elevation, slope and aspect from 5 points ~100 m apart: USGS 3DEP (1–10 m lidar/DEM) from the Elevation
     Point Query Service, else the Copernicus 90 m DEM via Open-Meteo. */
  async function fetchElevation(lat, lon) {
    const d = 0.0009, dl = d / Math.cos(lat * Math.PI / 180);
    const lats = [lat, lat + d, lat - d, lat, lat], lons = [lon, lon, lon, lon + dl, lon - dl];
    let pts, src;
    try {
      const js = await Promise.all(lats.map((y, k) => U.fetchJSON(`https://epqs.nationalmap.gov/v1/json?x=${lons[k].toFixed(6)}&y=${y.toFixed(6)}&wkid=4326&units=Meters&includeDate=false`, {}, 15000)));
      pts = js.map(j => num(j.value));
      if (pts.some(v => v === null || v < -1000)) throw new Error("no 3DEP coverage");
      src = `USGS 3DEP ${fmt(js[0].resolution, 0)} m`;
    } catch (e) {
      console.warn("USGS 3DEP unavailable, using Copernicus DEM", e);
      const j = await U.fetchJSON(`https://api.open-meteo.com/v1/elevation?latitude=${lats.map(v => v.toFixed(5)).join(",")}&longitude=${lons.map(v => v.toFixed(5)).join(",")}`, {}, 10000);
      pts = j.elevation;
      src = "Copernicus 90 m DEM";
    }
    const [z, zn, zs, ze, zw] = pts;
    const dy = 2 * d * 111320, dx = 2 * dl * 111320 * Math.cos(lat * Math.PI / 180);
    const gx = (ze - zw) / dx, gy = (zn - zs) / dy;
    const slope = Math.hypot(gx, gy) * 100;
    const aspect = (Math.atan2(-gx, -gy) * 180 / Math.PI + 360) % 360;
    return { z, slope, aspect, src };
  }

  const NLCD = {
    11: "Open water", 12: "Perennial ice/snow", 21: "Developed, open space", 22: "Developed, low intensity",
    23: "Developed, medium intensity", 24: "Developed, high intensity", 31: "Barren land", 41: "Deciduous forest",
    42: "Evergreen forest", 43: "Mixed forest", 52: "Shrub/scrub", 71: "Grassland/herbaceous", 81: "Pasture/hay",
    82: "Cultivated crops", 90: "Woody wetlands", 95: "Emergent herbaceous wetlands",
  };
  /* Impact Observatory / Esri Sentinel-2 10 m classes, with the NLCD code the practice suggestions understand. */
  const IO_LULC = { 1: ["Water", 11], 2: ["Trees", 41], 4: ["Flooded vegetation", 95], 5: ["Crops", 82], 7: ["Built area", 22],
    8: ["Bare ground", 31], 9: ["Snow/ice", 12], 10: ["Clouds", null], 11: ["Rangeland", 71] };

  /* NLCD 2021 from the MRLC WMS; MRLC currently refuses cross-site requests, so the Sentinel-2 10 m land cover
     (Impact Observatory, Microsoft, Esri; latest year) answers instead. */
  async function fetchNLCD(lat, lon) {
    try {
      const d = 0.0005;
      const q = new URLSearchParams({ service: "WMS", version: "1.1.1", request: "GetFeatureInfo", layers: "NLCD_2021_Land_Cover_L48",
        query_layers: "NLCD_2021_Land_Cover_L48", srs: "EPSG:4326", bbox: `${lon - d},${lat - d},${lon + d},${lat + d}`,
        width: "3", height: "3", x: "1", y: "1", info_format: "application/json" });
      const j = await U.fetchJSON(`https://www.mrlc.gov/geoserver/mrlc_display/wms?${q}`, {}, 8000);
      const f = j.features && j.features[0];
      const code = f ? num(f.properties.PALETTE_INDEX ?? f.properties.GRAY_INDEX) : null;
      if (NLCD[code]) return { code, name: NLCD[code], src: "nlcd" };
    } catch (e) {
      console.warn("NLCD unavailable, using Sentinel-2 land cover", e);
    }
    const g = encodeURIComponent(JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }));
    const j = await U.fetchJSON(`https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer/identify?geometry=${g}&geometryType=esriGeometryPoint&returnGeometry=false&returnCatalogItems=false&f=json`, {}, 12000);
    const c = IO_LULC[num(j.value)];
    return { code: c ? c[1] : null, name: c ? c[0] : null, src: "io" };
  }

  /* ============ RISK ============ */
  /* Bare-soil potential E = I × C/100 (t/ac/yr), C from SSURGO (official) else local estimate. */
  function currentSurface() {
    const s = state.soil && state.soil.surface;
    if (!s) return null;
    if (!state.edits) return { ...s, calc: null };
    const e = { ...s, ...state.edits };
    const texOf = v => S.refineCode(S.textureClass(v.sand, v.silt, v.clay), s.texCode);
    // unchanged sand/silt/clay keep the survey's own texture label (its RV fractions can classify differently)
    const sameTex = e.sand === s.sand && e.silt === s.silt && e.clay === s.clay;
    if (!sameTex) { e.texCode = texOf(e); e.texName = S.TEX[e.texCode] || e.texCode; }
    const w = S.wegFromSurface(e);
    // keep the survey's group unless the edit changes what the texture rules give (both worked out the same way):
    // a pH edit must not move Pullman clay loam (survey WEG 7) to the rules' 6, or a very stony Ector loam from 8 to 6
    const base = S.wegFromSurface(sameTex ? s : { ...s, texCode: texOf(s) });
    if (s.weg && w.weg === base.weg) { e.calc = null; e.kept = true; }
    else { e.weg = w.weg; e.wei = w.I; e.calc = w; }
    return e;
  }
  WG.currentSurface = currentSurface;

  function cFactor() {
    if (state.soil && state.soil.cFactor) return { C: state.soil.cFactor, src: "NRCS (SSURGO climate-factor area)" };
    if (state.wind && !state.wind.error) {
      // local estimate from reanalysis: scale FAO monthly-sum C to Chepil-type C (rough), kept within the published Texas range
      return { C: Math.round(Math.min(150, state.wind.faoC * 0.9)), src: "estimated from reanalysis wind" };
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
    const Er = Math.round(E); // classify what the headline shows, so the number and the lit class agree at the edges
    const level = Er < 10 ? 1 : Er < 40 ? 2 : Er < 80 ? 3 : Er < 150 ? 4 : 5;
    const frac = level + Math.min(0.49, Math.max(-0.49,
      level === 1 ? E / 10 - 0.5 : level === 2 ? (E - 10) / 30 - 0.5 : level === 3 ? (E - 40) / 40 - 0.5 : level === 4 ? (E - 80) / 70 - 0.5 : (E - 150) / 150 - 0.5));
    return { E, EI, T, level, frac, C: cf.C, cSrc: cf.src, I: surf.wei, weg: surf.weg };
  }
  WG.riskModel = riskModel;

  const LEVEL_NAME = ["", "Low", "Moderate", "High", "Very high", "Extreme"];
  const LEVEL_RANGE = ["", "< 10", "10–40", "40–80", "80–150", "≥ 150"];
  const LEVEL_COLOR = ["", "#3f9a66", "#9bbf55", "#efc24a", "#ef8a3c", "#d8402f"]; // the gauge's colours
  const C_RANGE = LAYERS.stats && LAYERS.stats.C_range ? LAYERS.stats.C_range.map(v => fmt(v, 0)).join("–") : null;

  /* The five classes under the headline, with this site's class lit, so the number has a scale. */
  function renderRiskScale(level) {
    const tx = (LAYERS.stats && LAYERS.stats.E_pct_by_class) || [];
    $("#riskScale").innerHTML = LEVEL_NAME.slice(1).map((n, i) =>
      `<div role="listitem" class="${i + 1 === level ? "on" : ""}"${i + 1 === level ? ' aria-current="true"' : ""} style="--c:${LEVEL_COLOR[i + 1]}" title="${n}: ${LEVEL_RANGE[i + 1]} t/ac/yr${tx[i] !== undefined ? ` · ${fmt(tx[i], 0)}% of rated Texas land` : ""}"><b>${n}</b><span>${LEVEL_RANGE[i + 1]}</span></div>`).join("");
  }

  function renderRisk() {
    const rc = $("#riskCard");
    const r = riskModel();
    const w = state.wind;
    if (!r) {
      const surf = currentSurface();
      const noGroup = !!surf && (surf.wei === null || surf.wei === undefined);
      if (state.soil && (state.soil.error || !state.soil.surface || noGroup)) {
        rc.className = "risk-card";
        Ch.gauge($("#riskGauge"), null);
        renderRiskScale(0);
        $("#riskUnit").textContent = "";
        $("#riskLevel").textContent = noGroup ? "No erodibility group" : "Soil data unavailable";
        $("#riskText").textContent = state.soil.error ? `Soil survey request failed (${state.soil.error}). Try again or enter your soil test on the Soil tab.`
          : !noGroup ? "No soil survey component with texture data here (water, urban or rock?). Enter your soil test on the Soil tab."
          : state.edits ? "These surface values don't place the soil in a Wind Erodibility Group. Enter sand, silt and clay on the Soil tab, or reset to the survey."
          : "The soil survey gives no Wind Erodibility Group for this soil (rock outcrop, urban land or water?). Enter your soil test on the Soil tab.";
      } else if (surf) { // a group but no climatic factor C yet: clear any older message
        rc.className = state.wind ? "risk-card" : "risk-card loading";
        Ch.gauge($("#riskGauge"), null);
        renderRiskScale(0);
        $("#riskUnit").textContent = "";
        $("#riskLevel").textContent = state.wind ? "Climatic factor unavailable" : "Analyzing…";
        $("#riskText").textContent = state.wind ? "NRCS gives no climatic factor C for this map unit, and the wind history could not be used to estimate one."
          : `Fetching ${state.period} years of hourly wind for this point…`;
      }
      return;
    }
    rc.className = `risk-card r${r.level}`;
    $("#riskLevel").textContent = `${LEVEL_NAME[r.level]} · ${fmt(r.E, 0)} t/ac/yr`;
    Ch.gauge($("#riskGauge"), r.frac);
    renderRiskScale(r.level);
    $("#riskUnit").textContent = `Tons of soil per acre per year that bare, smooth, unsheltered ground here could lose: an amount, not a score out of 100. `
      + (r.T ? `For scale, NRCS rates this soil's tolerable loss (T) at ${fmt(r.T, 0)} t/ac/yr.` : "For scale, NRCS tolerable losses (T) are 1–5 t/ac/yr.");
    const peak = w && !w.error && w.riskMonths.length ? monthsText(w.riskMonths) : null;
    const est = !r.cSrc.startsWith("NRCS");
    const ei = !r.EI ? "" : est ? ` Erodibility index C·I/T ≈ ${fmt(r.EI, 1)} with the estimated C; the NRCS test for highly erodible land (8 or more) uses NRCS's own C.`
      : r.EI >= 8 ? ` Erodibility index C·I/T = ${fmt(r.EI, 1)}: meets the NRCS wind test for highly erodible land (8 or more) with these inputs; official determinations use NRCS's 1990 factors.`
        : ` Erodibility index C·I/T = ${fmt(r.EI, 1)}; the NRCS wind test for highly erodible land starts at 8.`;
    $("#riskText").innerHTML = `E = I × C / 100: soil erodibility I = ${fmt(r.I, 0)} t/ac/yr (range 0–310) × climatic factor C ${est ? "≈" : "="} ${fmt(r.C, 0)}`
      + ` (${est ? "estimated; " : ""}Garden City, KS = 100${C_RANGE ? `; Texas ${C_RANGE}` : ""}).${esc(ei)}`
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
      const share = w.eroHours / 87.6; // % of the 8,760 hours in a year
      $("#stWind").innerHTML = speedTxt(w.meanSpeed);
      $("#stWindS").textContent = `10 m height, ${w.start}–${w.end} average`;
      $("#stHours").innerHTML = `${fmt(w.eroHours, 0)} <small>h ≥ ${state.units === "mph" ? fmt(U.msToMph(w.thr), 0) + " mph" : w.thr + " m/s"}</small>`;
      $("#stHoursS").textContent = `${fmt(share, share < 10 ? 1 : 0)}% of the 8,760 hours in a year`;
      $("#stDir").innerHTML = `${U.compass(w.prevailing)} <small>from ${fmt(w.prevailing, 0)}°</small>`;
      $("#stDirS").textContent = "where most soil-moving wind comes from";
      $("#monthStrip").innerHTML = w.months.map((m, i) => `<div class="m ${m.level}" title="${U.MONTHS_LONG[i]}: ${(m.share * 100).toFixed(0)}% of annual risk"><i></i>${U.MONTHS[i][0]}</div>`).join("");
      const stn = state.windStation && state.windStation.meta, ap = airportMeta();
      const via = state.windKey === "cal" ? ` Wind calibrated to ${stn.name.replace(/,.*$/, "")} (${stn.id}) ${stn.tower ? "mesonet tower" : "airport"} records.`
        : state.windKey === "station" ? ` From ${ap.id} airport records.` : state.windStationPending ? " Calibrating to the nearest airport…" : " Uncalibrated reanalysis.";
      $("#monthStripNote").textContent = (w.riskMonths.length
        ? `High-risk: ${monthsText(w.riskMonths)}. Red months carry ≥ 10% of the year's erosive wind energy under dry conditions — keep the soil covered or rough then.`
        : "Erosive wind is spread evenly across the year here.") + via;
    } else if (w && w.error) {
      ["stWind", "stHours", "stDir"].forEach(id => { $("#" + id).textContent = "n/a"; $("#" + id + "S").textContent = ""; });
      $("#monthStrip").innerHTML = `<p class="fine" style="grid-column:1/-1">Wind history unavailable: ${esc(w.error)}</p>`;
    }
    if (surf) {
      $("#stWeg").innerHTML = surf.weg ? `${esc(surf.weg)} <small>· I = ${fmt(surf.wei, 0)} t/ac/yr</small>` : "—";
      $("#stWegS").innerHTML = surf.weg ? `${wegStrip(surf.weg)}<span class="weg-ends"><span>1 most erodible</span><span>8 not erodible</span></span>`
        + "I ranges from 0 to 310 t/ac/yr" : "no group for this soil";
    } else if (s) { $("#stWeg").textContent = "n/a"; $("#stWegS").textContent = ""; }
    const cf = cFactor();
    if (cf) {
      $("#stC").innerHTML = `${fmt(cf.C, 0)} <small>${cf.src.startsWith("NRCS") ? "NRCS" : "est."}</small>`;
      $("#stCS").textContent = `% of Garden City, KS (= 100)${C_RANGE ? `; Texas ${C_RANGE}` : ""}`;
    } else if (s && w) { $("#stC").textContent = "—"; $("#stCS").textContent = ""; }
    if (state.nlcd) {
      $("#stLc").textContent = state.nlcd.name || "n/a";
      $("#stLcS").textContent = { nlcd: "NLCD 2021, 30 m", io: "Sentinel-2 land cover, 10 m" }[state.nlcd.src] || "land-cover services did not answer";
    }
  }

  /* 1 2 3 4 4L 5 6 7 8 with this soil's group lit: the WEG scale in one line. */
  const wegStrip = g => `<span class="weg-strip" aria-hidden="true">${S.WEG_INFO.map(w => `<i class="${w.g === g ? "on" : ""}">${w.g}</i>`).join("")}</span>`;

  /* ============ WIND TAB ============ */
  function renderWind() {
    const w = state.wind;
    if (!w) return;
    if (w.error) {
      $("#windSource").textContent = "Wind history could not be loaded: " + w.error;
      return;
    }
    $("#thrVal").textContent = state.units === "mph" ? `${fmt(U.msToMph(state.thr), 0)} mph` : `${state.thr} m/s`;
    const stn = state.windStation && state.windStation.meta, ap = airportMeta();
    const key = state.windKey;
    const mShort = (MODEL[w.model] || MODEL.merra2).short;
    const busy = state.windTower ? ` · reading ${state.windTower.id} tower…` : state.windStationPending && state.windStationChoice ? ` · loading ${state.windStationChoice}…` : "";
    $("#windSrcTag").textContent = key === "cal" ? `calibrated to ${stn.id} · ${w.start}–${w.end}${busy}`
      : key === "station" ? `${ap.id} station · ${w.start}–${w.end}${busy}`
        : state.windStationRetry ? `${mShort} · data limit, retrying in 1 min` : state.windStationPending ? `${mShort} · calibrating…` : `${mShort} · ${w.start}–${w.end}`;
    $("#moistTag").textContent = { gridmet: "gridMET 4 km", "nasa-power": "NASA POWER (fallback)", "open-meteo": "Open-Meteo (fallback)" }[(w.moisture || {}).source] || "";
    $("#modelSel").value = (state.windSets.model || {}).model || state.gridModel;
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
      ["Days per year with gusts ≥ 40 mph", w.gustDays !== null ? fmt(w.gustDays, 0)
        : key === "cal" ? "n/a (the tower records no gusts and no airport could supply them)" : "n/a (MERRA-2 has no gusts)"],
      ["Prevailing erosive wind (from)", `${U.compass(w.prevailing)} (${fmt(w.prevailing, 0)}°)`],
      ["Resultant soil-transport direction (toward)", `${U.compass(w.rdd)} (${fmt(w.rdd, 0)}°)`],
      ["Best barrier / strip orientation", `${orientation(w)}`],
      ...(w.dp !== null ? [
        ["Sand drift potential DP (Fryberger & Dean)", `${fmt(w.dp, 0)} VU · ${dpClass}`],
        ["Resultant drift RDP / direction", `${fmt(w.rdp, 0)} VU toward ${U.compass(w.rddF)}; RDP/DP ${fmt(w.rdp / Math.max(w.dp, 1e-9), 2)} (${w.rdp / Math.max(w.dp, 1e-9) < 0.3 ? "multidirectional" : w.rdp / Math.max(w.dp, 1e-9) < 0.8 ? "intermediate" : "unidirectional"})`],
      ] : []),
      ["FAO wind-erosion climatic index (annual)", `${fmt(w.faoC, 0)} (no fixed top; higher = windier and drier)`],
      ["Annual precipitation / ET₀", `${fmt(w.precip / 25.4, 1)} in / ${fmt(w.et0 / 25.4, 1)} in (P/ET₀ = ${fmt(w.aridity, 2)})`],
    ].map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`).join("")
      + `<span class="d">${esc(sourceCaveat())}</span>`;
    $("#windSource").innerHTML = `Source: ${windSourceText()} ${yrs}. <button class="link" data-methods="m-site">All sources and equations →</button>`;
  }

  /* ---- provenance: what supplied each piece of data for this site ---- */
  const A = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  const MODEL = {
    ecmwf: { short: "ECMWF", name: "ECMWF IFS 9 km analysis (2017 on) and ERA5 0.25° reanalysis (before 2017)",
      via: `the ${A("https://open-meteo.com/en/docs/historical-weather-api", "Open-Meteo archive")} (a copy of the ECMWF data)` },
    merra2: { short: "MERRA-2", name: "NASA MERRA-2 reanalysis (0.5° × 0.625°)",
      via: `${A("https://power.larc.nasa.gov/docs/services/api/temporal/hourly/", "NASA POWER")} (direct)` },
  };
  const MOIST = {
    gridmet: `gridMET 4 km (University of Idaho), read directly from its ${A("https://www.climatologylab.org/gridmet.html", "THREDDS server")}`,
    "nasa-power": `NASA POWER daily (MERRA-2 weather) with FAO-56 Penman–Monteith ET₀ computed in the app, direct (gridMET did not respond)`,
    "open-meteo": `ECMWF IFS/ERA5 via ${A("https://open-meteo.com/en/docs/historical-weather-api", "Open-Meteo")} (gridMET and NASA POWER did not respond)`,
  };
  const OBS = {
    ncei: `NOAA NCEI ${A("https://www.ncei.noaa.gov/products/global-historical-climatology-network-hourly", "GHCNh")} (direct)`,
    iem: `the ${A("https://mesonet.agron.iastate.edu/request/download.phtml", "Iowa Environmental Mesonet")} ASOS archive`,
    iemhads: `NWS Lubbock's hourly SHEF reports, archived by the ${A("https://mesonet.agron.iastate.edu/request/dcp/fe.phtml", "Iowa Environmental Mesonet")}`,
  };
  const WTM = A("https://www.mesonet.ttu.edu/", "West Texas Mesonet");
  // the airport behind "Airport station only" (the calibration station if no airport is recorded)
  const airportMeta = () => (state.windAirport || state.windStation || {}).meta;
  // "Lubbock Intl Airport, TX (LBB, 21 km away, 99% of hours)"; towers add their years and network
  const stationTxt = s => `${esc(s.name)} (${s.id}, ${fmt(s.km, 0)} km away, ${fmt(s.coverage * 100, 0)}% of hours${s.tower ? ` ${s.y0}–${s.y1}` : ""})`
    + `${s.tower ? `, a ${WTM} 10 m tower (Texas Tech),` : ""} from ${OBS[s.obsSource]}`;

  function windSourceText() {
    const model = state.windSets && state.windSets.model, stn = state.windStation && state.windStation.meta, key = state.windKey;
    const ap = airportMeta();
    if (!model) return "";
    const M = MODEL[model.model];
    const grid = `${M.name} via ${M.via}, grid cell ${fmt(model.lat, 3)}, ${fmt(model.lon, 3)}${model.fellBack ? " (the other model did not respond)" : ""}`;
    const moist = `Precipitation, grass reference ET₀ and temperature: ${MOIST[model.moisture.source]}.`;
    if (key === "cal") {
      const g = state.windRaw.gustStation;
      const gust = !stn.tower ? "" : g ? `; daily gusts calibrated to ${esc(g.name)} (${g.id}, ${fmt(g.km, 0)} km away), because the tower records no gusts` : "; no gusts (the tower records none and no airport could supply them)";
      return `hourly 10 m wind from ${grid}, calibrated month by month (quantile mapping) to hourly observations at ${stationTxt(stn)}${gust}. ${moist}`;
    }
    if (key === "station") return `hourly airport observations (2-minute mean wind at 10 m) at ${stationTxt(ap)}. ${moist}`;
    return `hourly 10 m wind from ${grid}. Not calibrated. ${moist}`;
  }

  /* Rows for the "This location" table of the Methods sheet. */
  function siteSources() {
    const s = state.soil, model = state.windSets && state.windSets.model, stn = state.windStation && state.windStation.meta;
    const cf = cFactor(), e = state.elev;
    const rows = [];
    if (model) {
      const M = MODEL[model.model];
      rows.push(["Hourly wind (gridded)", `${M.name}, cell ${fmt(model.lat, 3)}, ${fmt(model.lon, 3)}`, M.via + (model.fellBack ? "; automatic fallback" : "")]);
      const ap = state.windAirport && state.windAirport.meta, tw = stn && stn.tower ? stn : null;
      rows.push(["Airport observations", ap ? `${esc(ap.name)} (${ap.id}), ${fmt(ap.km, 0)} km, ${fmt(ap.coverage * 100, 0)}% of hours` : state.windStationPending ? "loading…" : "none within 150 km", ap ? OBS[ap.obsSource] : ""]);
      if (tw || state.windTower) rows.push(["West Texas Mesonet tower", tw ? `${esc(tw.name)} (${tw.id}), ${fmt(tw.km, 0)} km, ${fmt(tw.coverage * 100, 0)}% of hours ${tw.y0}–${tw.y1}; ${checkTxt(tw)}` : "loading…",
        tw ? `${OBS[tw.obsSource]}; ${WTM} data policy: public use needs the mesonet's permission` : ""]);
      const skipped = state.windSkipped.filter(s => !stn || s.id !== stn.id), g = (state.windSets.cal || {}).gustStation;
      if (skipped.length) rows.push(["Towers not used", skipped.map(s => `${esc(s.name)} (${s.id}), ${fmt(s.km, 0)} km: ${skipTxt(s)}`).join("; "), "exposure check"]);
      rows.push(["Wind used for results", { cal: tw ? (g ? `Calibrated to the tower (gusts to ${g.id})` : "Calibrated to the tower (no gusts)") : "Calibrated to the airport", station: "Airport station only", model: "Gridded model only" }[state.windKey] || "—", ""]);
      rows.push(["Precipitation, ET₀, temperature", `${{ gridmet: "gridMET 4 km", "open-meteo": "ECMWF IFS/ERA5", "nasa-power": "NASA POWER MERRA-2" }[model.moisture.source]}, cell ${fmt(model.moisture.lat, 3)}, ${fmt(model.moisture.lon, 3)}`, MOIST[model.moisture.source]]);
    }
    if (s && !s.error) rows.push(["Soil profile, WEG, I, T", `SSURGO map unit ${esc(String(s.mukey))}${s.dominant ? `, ${esc(s.dominant.compname)}` : ""} (${esc(s.mapunit.areasymbol || "")})`, `USDA-NRCS ${A("https://sdmdataaccess.nrcs.usda.gov/", "Soil Data Access")} (direct)`]);
    if (cf) rows.push(["Climatic factor C", `${fmt(cf.C, 0)}`, cf.src.startsWith("NRCS") ? "NRCS climate-factor area in SSURGO (direct)" : "estimated from the wind series"]);
    if (e) rows.push(["Elevation and slope", `${fmt(e.z, 0)} m, ${fmt(e.slope, 1)}% slope`, e.src.startsWith("USGS") ? `${e.src}, ${A("https://apps.nationalmap.gov/epqs/", "Elevation Point Query Service")} (direct)` : `${e.src} via Open-Meteo (USGS did not respond)`]);
    if (state.nlcd) rows.push(["Land cover", state.nlcd.name || "no answer", state.nlcd.src === "nlcd" ? `NLCD 2021, ${A("https://www.mrlc.gov/", "MRLC")} WMS (direct)`
      : state.nlcd.src === "io" ? `Sentinel-2 10 m land cover, ${A("https://livingatlas.arcgis.com/landcover/", "Impact Observatory, Microsoft, Esri")} (NLCD server refuses browser requests)`
        : "neither NLCD nor the Sentinel-2 land-cover service answered"]);
    return rows;
  }
  WG.siteSources = siteSources;

  function sourceCaveat() {
    const stn = state.windStation && state.windStation.meta;
    const ap = airportMeta(), x = stn && stn.tower && stn.exposure;
    const ground = !stn || !stn.tower ? "Airport winds are measured on open ground, so sheltered sites blow less."
      : !x ? "The tower was not checked against an airport, and sheltered towers read low."
        : x.ero < Wd.EXPOSURE_MIN ? "This tower reads low against the airport and may be sheltered, so these values may be low."
          : "The tower reads like the airport, on open ground, so sheltered sites blow less.";
    if (state.windKey === "cal") return `Speeds follow the measured distribution at ${stn.id} for each month; timing and direction come from the reanalysis at this point. ${ground}`;
    if (state.windKey === "station") return `Measured at the ${ap.id} airport, ${fmt(ap.km, 0)} km away; local terrain and surface can differ from this field.`;
    if (state.windStationPending) return "Calibrating to the nearest airport station…";
    const merra = state.windSets && state.windSets.model && state.windSets.model.model === "merra2";
    return (merra ? "Uncalibrated MERRA-2: at Lubbock it caught ~58% of the airport's erosive hours." : "Uncalibrated ECMWF: at Lubbock and Midland it caught only ~35–45% of erosive hours and shifted the peak months earlier.")
      + (state.windStation ? "" : " No airport station with enough data within 150 km.");
  }

  function renderCalibration() {
    const card = $("#calCard");
    const c = state.windCompare, st = state.windStation, all = state.windAll || {};
    const tw = state.windTower;
    if (!st || !c) {
      card.hidden = !state.windStationPending && !tw;
      $("#calKv").innerHTML = `<span class="k">${tw && !state.windStationPending ? `Reading the ${esc(tw.id)} mesonet tower…` : "Looking for the nearest airport station…"}</span><span class="v"></span>`;
      return;
    }
    card.hidden = false;
    const m = st.meta, ap = state.windAirport && state.windAirport.meta, g = (state.windSets.cal || {}).gustStation;
    const skipped = state.windSkipped.filter(s => s.id !== m.id); // a skipped tower the user then picked is the station
    const cands = Wd.nearestStations(state.site.lat, state.site.lon, state.period);
    const want = state.windStationPending && state.windStationChoice ? cands.find(c => c.id === state.windStationChoice) : null; // picked, still loading
    $("#stnSel").innerHTML = cands.map(c => `<option value="${esc(c.id)}" ${c.id === (want || m).id ? "selected" : ""}>${esc(c.id)} · ${esc(c.name.replace(/,.*$/, ""))} · ${fmt(c.km, 0)} km${c.awos ? " · AWOS" : c.tower ? " · mesonet tower" : ""}</option>`).join("");
    const sp = v => state.units === "mph" ? `${fmt(U.msToMph(v), 1)} mph` : `${fmt(v, 2)} m/s`;
    const tm = a => a ? WG.monthsText(a.riskMonths) || "—" : "—";
    $("#calKv").innerHTML = [
      ["Station", `${m.name} (${m.id}${m.awos ? ", AWOS" : ""})${m.tower ? " · West Texas Mesonet 10 m tower" : ""}`],
      ["Distance · data coverage", `${fmt(m.km, 0)} km · ${fmt(m.coverage * 100, 0)}% of hours${m.tower ? `, ${m.y0}–${m.y1}` : ""}`],
      ...(m.tower ? [["Gusts", g ? `from ${g.name.replace(/,.*$/, "")} (${g.id}), ${fmt(g.km, 0)} km: the tower records none`
        : ap ? `none: the tower records none and ${ap.id} has no model series to map them` : "none: the tower records none and no airport within 150 km has them"]] : []),
      ...(m.tower ? [["Exposure vs airport", checkTxt(m)]] : []),
      ...(skipped.length ? [["Towers not used", skipped.map(s => `${s.id}, ${fmt(s.km, 0)} km: ${skipTxt(s)}`).join("; ")]] : []),
      ...(tw ? [["Mesonet tower ranked ahead", `${tw.id}, ${fmt(tw.km, 0)} km: reading its last ${Wd.TOWER_YEARS} years (about a minute)`]] : []),
      ...(want ? [["Loading", `${want.id}, ${fmt(want.km, 0)} km${want.tower ? `: reading its last ${Wd.TOWER_YEARS} years (about a minute)` : "…"}`]] : []),
      ["Mean wind: station vs model", `${sp(c.meanObs)} vs ${sp(c.meanMod)} (${c.bias >= 0 ? "+" : ""}${fmt((c.bias / c.meanObs) * 100, 0)}%)`],
      ["Hourly agreement", `r = ${fmt(c.r, 2)}, RMSE ${sp(c.rmse)}`],
      ["Erosive hours caught by model", `${fmt((c.freqMod / Math.max(c.freqObs, 1e-9)) * 100, 0)}% (${fmt(c.freqMod * 100, 1)}% vs ${fmt(c.freqObs * 100, 1)}% of hours)`],
      [`High-risk months: ${ap ? `${ap.id} airport` : "station"} / model / calibrated`, `${tm(all.station)} / ${tm(all.model)} / ${tm(all.cal)}`],
    ].map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`).join("");
    if (!$("#tab-wind").hidden) Ch.calib(all, ap && `${ap.id} airport`);
  }

  const pctOff = x => `${x >= 1 ? "+" : "−"}${fmt(Math.abs(x - 1) * 100, 0)}%`; // 0.79 -> "−21%"
  // "−49% erosive hours, −21% mean wind against LBB, relative to the model"
  const expTxt = s => `${pctOff(s.exposure.ero)} erosive hours, ${pctOff(s.exposure.mean)} mean wind against ${s.expAp}, relative to the model`;
  const checkTxt = s => s.exposure ? `${expTxt(s)}${s.exposure.ero < Wd.EXPOSURE_MIN ? ": reads low, probably sheltered" : ""}`
    : s.expAp ? `not checked: could not be compared with ${s.expAp}` : "not checked: no airport within 150 km";
  const skipTxt = s => s.exposure ? `${expTxt(s)} (probably sheltered)` : `could not be compared with ${s.expAp}`;

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
    if (state.windAll && (state.windAll.station || state.windCompare)) Ch.calib(state.windAll, state.windAirport && `${state.windAirport.meta.id} airport`);
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
  $("#modelSel").addEventListener("change", e => {
    state.gridModel = e.target.value;
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
      surf && surf.weg ? `<span class="chip ${surf.wei >= 86 ? "warn" : surf.wei <= 38 ? "ok" : ""}" title="Wind Erodibility Group: nine classes from 1 (most erodible) to 8 (not erodible), with 4L between 4 and 5">WEG ${esc(surf.weg)} · I ${fmt(surf.wei, 0)} t/ac/yr${surf.calc ? " (from your values)" : ""}</span>` : "",
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
    renderWegTable(surf);
    const e = state.elev;
    $("#soilSource").innerHTML = `Source: USDA-NRCS Soil Survey Geographic Database (SSURGO) via <a href="https://sdmdataaccess.nrcs.usda.gov/" target="_blank" rel="noopener">Soil Data Access</a>, map unit key ${s.mukey}, ${esc(s.mapunit.areaname || "")}${s.mapunit.saverest ? `, survey dated ${esc(String(s.mapunit.saverest).slice(0, 10))}` : ""}. Elevation/slope: ${e ? esc(e.src) + (e.src.startsWith("USGS") ? " (Elevation Point Query Service)" : " via Open-Meteo") : "loading"}. Water retention for edited layers: Saxton &amp; Rawls (2006). <button class="link" data-methods="m-erod">Equations →</button>`;
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
      ["Wind erodibility group (1 most – 8 least)", surf.weg || "—", ch(surf.weg, base.weg)],
      ["Erodibility index I (0–310)", surf.wei !== null ? `${fmt(surf.wei, 0)} t/ac/yr` : "—", ch(surf.wei, base.wei)],
      ["Organic carbon", surf.om !== null ? `${fmt(surf.om / 1.724, 2)}%` : "—", ""],
      ["Wilting point (15 bar)", sr ? `${fmt(sr.ll, 3)} cm³/cm³` : "—", ""],
      ["Field capacity (⅓ bar)", sr ? `${fmt(sr.dul, 3)} cm³/cm³` : "—", ""],
      ["Plant-available water", sr ? `${fmt(sr.awc * 12, 2)} in/ft` : "—", ""],
      ["Sat. conductivity", sr && sr.ksat !== null ? `${fmt(sr.ksat / 25.4, 2)} in/h` : "—", ""],
    ];
    const rw = S.rweq(surf), rw0 = S.rweq(base);
    if (rw) cells.push(
      ["RWEQ erodible fraction EF", `${fmt(rw.ef * 100, 0)}% < 0.84 mm${rw.inRange ? "" : " *"}`, ch(rw.ef.toFixed(3), rw0 && rw0.ef.toFixed(3))],
      ["RWEQ crust factor SCF (0–1, lower = firmer crust)", `${fmt(rw.scf, 2)}${rw.inRange ? "" : " *"}`, ch(rw.scf.toFixed(3), rw0 && rw0.scf.toFixed(3))]);
    $("#soilDerived").innerHTML = cells.map(([k, v, c]) => `<div><span>${esc(k)}</span><b class="${c}">${esc(v)}</b></div>`).join("")
      + (surf.calc ? `<div style="grid-column:1/-1"><span>WEG rule applied</span><b>${esc(surf.calc.why)}</b></div>` : "")
      + (surf.kept ? `<div style="grid-column:1/-1"><span>Wind erodibility group</span><b>The survey's group is kept: your values give the same texture-rule result as the survey's.</b></div>` : "")
      + (rw && !rw.inRange ? `<div style="grid-column:1/-1"><span>* RWEQ check</span><b>This soil is outside the range of soils the RWEQ equations were fitted to; read EF and SCF as rough.</b></div>` : "");
  }

  /* All nine groups with this soil's row marked (surf null: the plain table). */
  function renderWegTable(surf) {
    const g = surf && surf.weg;
    $("#wegTag").textContent = g ? `this soil: WEG ${g}` : "";
    const here = g ? `<span class="here">this soil${surf.texName ? `: ${esc(surf.texName)}` : ""}</span>` : "";
    $("#wegTable").innerHTML = `<thead><tr><th>WEG</th><th class="l">Texture guide</th><th>I<small>t/ac/yr</small></th></tr></thead><tbody>`
      + S.WEG_INFO.map(w => `<tr class="${w.g === g ? "on" : ""}"><td><b>${w.g}</b></td><td class="l"><b>${esc(w.name)}</b>${w.g === g ? ` ${here}` : ""}<span class="def">${esc(w.def)}</span></td><td>${w.I}</td></tr>`).join("")
      + "</tbody>";
  }

  $("#wegFull").addEventListener("click", e => {
    const full = $("#wegTable").classList.toggle("full");
    e.target.textContent = !full ? "Show all definitions" : $("#wegTable tr.on") ? "Show only this soil's definition" : "Hide definitions";
  });

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
      P("Slope (DEM, ±100 m)", e ? `${fmt(e.slope, 1)}%, facing ${U.compass(e.aspect)} · ${esc(e.src)}` : "—"),
      P("Elevation", e ? `${fmt(e.z, 0)} m (${fmt(e.z * 3.28084, 0)} ft)` : (d.elev_r ? `${fmt(d.elev_r, 0)} m` : "—")),
      P("Soil depth", site.depth ? `${fmt(site.depth, 0)} cm` : "—"),
      P("Restrictive layer", site.restriction ? `${esc(site.restriction.kind)} at ${fmt(site.restriction.depth, 0)} cm` : "none reported"),
      P("Drainage class", esc(site.drainage || "—")), P("Hydrologic group", esc(site.hydgrp || "—")), P("Surface runoff", esc(site.runoff || "—")),
      P("Dry albedo", f(site.albedo, 2)), P("Stage-1 evaporation limit", `${f(site.u, 0)} mm`), P("Drainage rate", site.drainRate !== null ? `${f(site.drainRate, 2)} /day` : "—"),
      P("Runoff curve number", f(site.cn, 0)), P("Avail. water 0–150 cm", site.aws150 !== null ? `${fmt(site.aws150, 1)} cm` : "—"),
      P("T factor (tolerable loss)", site.tfact !== null ? `${fmt(site.tfact, 0)} t/ac/yr` : "—"), P("Kw (surface)", f(site.kw, 2)),
      P("WEG / I (0–310)", surf ? `${esc(surf.weg || "—")} / ${f(surf.wei, 0)} t/ac/yr` : "—"),
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
    const comps = `<div><h4>Components in this map unit</h4><div class="table-wrap"><table class="grid"><thead><tr><th>Component</th><th>%</th><th>WEG</th><th>I<small>t/ac/yr</small></th><th>Slope<small>%</small></th><th>Drainage</th><th>Ecological site</th></tr></thead>
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
