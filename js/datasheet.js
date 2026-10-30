/* The data sheet: model-ready soil and weather files, tables and series for the selected location.
   Weather from gridMET, NASA POWER or the user's own daily file; soil from the survey (any component) or the
   user's own layers. Writers live in WG.models.writers. */
WG.datasheet = (function () {
  const { $, $$, esc, fmt, toast, num } = WG.util;
  const UN = WG.units, X = WG.export, Wd = WG.wind, M = WG.models, D = WG.downloads;
  const state = WG.state;
  // the user's weather file: its text, read again at Download with the units chosen then, and the parse made on loading
  let userWxSrc = null, userWx = null;
  // the user's own soil layers and the location they were made for
  let userSoilRows = null, userSoilSite = null;
  // the download in progress: its location's token and status line, shown again when the sheet is re-rendered
  let running = null;
  let gmLast = null, gmAsked = false; // gridMET's last day, once read

  const MODELS = [
    ["dssat", "DSSAT 4.8", "Weather .WTH (one file per year) and soil WG.SOL"],
    ["swatplus", "SWAT+", "Weather station files (pcp, tmp, slr, hmd, wnd and .cli lists), soils.sol and a user soil table"],
    ["epic", "EPIC", "Daily weather .DLY, monthly statistics .WP1, wind .WND and soil .SOL"],
    ["apex", "APEX", "Daily weather .DLY, monthly statistics .WP1, wind .WND and soil .SOL"],
    ["apsim", "APSIM", "Weather .met (with CO₂) and soil .apsimx"],
    ["aquacrop", "AquaCrop 7", "Climate .CLI with temperature, rain and ET₀ files, soil .SOL, and an AquaCrop-OSPy weather file"],
    ["csv", "Plain CSV", "Daily weather and soil layers with units, for any model"],
  ];
  const SERIES = [
    ["hourly", "Hourly wind (the series in use)"], ["daily", "Daily weather (the range above)"], ["monthly", "Monthly summary"],
    ["annual", "Annual summary"], ["soil", "Soil horizons"],
  ];
  const MODEL_NAME = Object.fromEntries(MODELS), SERIES_NAME = Object.fromEntries(SERIES);
  const TABLE = { hourly: "hourly_wind", daily: "daily_weather", monthly: "monthly_summary", annual: "annual_summary", soil: "soil_layers" };

  // common sets of layer bottoms (cm) for the custom-depth box
  const DEPTH_SETS = [["SoilGrids", [5, 15, 30, 60, 100, 200]], ["DSSAT", [5, 15, 30, 45, 60, 90, 120, 150, 180, 210]], ["10 cm steps to 1 m", [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]]];
  // inches need 2 decimals to come back to the same 0.1 cm (78.74 in = 200.0 cm; 78.7 in would be 199.9)
  const depthText = cm => cm.map(v => +UN.conv("depth", v).toFixed({ in: 2, cm: 1, mm: 0 }[UN.sym("depth")] ?? 1)).join(", ");
  /* the layer bottoms typed in the depth unit of the units table, as cm */
  function depthsCm() {
    const raw = ($("#dlDepths").value || "").split(/[,;\s]+/).filter(Boolean);
    if (!raw.length) return { error: "Type the bottom depth of each layer, for example 5, 15, 30, 60, 100." };
    const v = raw.map(x => UN.back("depth", +x));
    if (v.some(x => x === null || !(x > 0))) return { error: "Layer depths must be positive numbers separated by commas." };
    const B = [...new Set(v.map(x => Math.round(x * 10) / 10))].sort((a, b) => a - b);
    if (B.length > 50) return { error: "At most 50 layers." };
    if (B[B.length - 1] > 1000) return { error: "The deepest layer must end above 10 m." };
    return { B };
  }
  /* what the chosen layering gives for the chosen soil, under the layer controls */
  function layerInfo() {
    const box = $("#dlLayerInfo");
    if (!box) return;
    checkStale();
    const mode = $("#dlLayers").value;
    $("#dlDepthBox").hidden = mode !== "custom";
    if (mode === "model") { box.textContent = "DSSAT splits the horizons at 5, 15, 30, 45, 60, 90 … cm and APSIM uses 15, 15, 30, 30 … cm layers; AquaCrop merges them to 5, APEX to 10 and EPIC to 15; SWAT+ and the tables keep the horizons."; return; }
    let soil, L;
    try { soil = chosenSoil(); L = soil ? usableRows(soil) : []; } catch (e) { box.textContent = e.message; return; }
    if (!L.length) { box.textContent = "No layers to write."; return; }
    const z = v => UN.num("depth", v), u = UN.sym("depth"), rl = soil.relayer;
    box.textContent = `${L.length} layer${L.length > 1 ? "s" : ""} (${u}): ${L.map(l => `${z(l.top)}–${z(l.bot)}`).join(", ")}.`
      + (rl && rl.cut !== null ? ` The profile ends at ${z(rl.cut)} ${u} (bedrock or a cemented layer).` : "")
      + (rl && rl.extendedBelow !== null ? ` Below ${z(rl.extendedBelow)} ${u} the survey has no horizons, so the deepest one is repeated.` : "")
      + (L.length > 5 ? ` AquaCrop takes at most 5 layers${L.length > 10 ? ", APEX 10" : ""}${L.length > 15 ? ", EPIC 15" : ""}${L.length > 20 ? ", DSSAT 20" : ""}; those files merge the thinnest neighbours.` : "");
  }

  /* the layers the model files can use, or a plain message when the soil has none (urban land, rock outcrop) */
  function usableRows(soil) {
    try { return WG.writerUtil.soilRows(soil); }
    catch (e) { throw new Error(`The survey gives no water retention or bulk density for ${soil.name}, so no model soil can be made from it: choose another component, or “My own soil profile…”.`); }
  }

  /* the sheet's choices, kept when it is closed (for example to change the depth unit) and opened again */
  let form = null;
  const siteKey = () => `${state.site.lat},${state.site.lon}`;
  function keepForm() {
    if (!$("#dlLayers") || !state.site) return;
    const d = $("#dlLayers").value === "custom" ? depthsCm() : null;
    form = { site: $("#dlFrom").dataset.site || siteKey(), wx: $("#dlWx").value, from: $("#dlFrom").value, to: $("#dlTo").value,
      soil: $("#dlSoil").value, layers: $("#dlLayers").value, depths: d && d.B ? d.B : form ? form.depths : null,
      models: $$("input[name=dlModel]:checked").map(i => i.value), series: $$("input[name=dlSeries]:checked").map(i => i.value),
      u: Object.fromEntries(["uT", "uP", "uS", "uW", "uWh"].map(k => [k, $("#" + k).value])), fill: $("#uFill").checked };
  }

  /* ---------- the days each weather source can give ---------- */
  const POWER_FIRST = Wd.epochDay(1981, 0, 1);
  const span = r => `${Wd.dayLabel(r.first)} – ${Wd.dayLabel(r.last)}`;
  /* { first, last, name, what } of a source's record: gridMET from 1979 to its last day (about 2 days behind), NASA POWER
     from 1981 to about 8 days ago, a file its own days (and gridMET's too when gaps are filled from it); null without a file */
  function wxRange(src, fill, file) {
    const gm = { first: Wd.GM_DAY0, last: gmLast ?? Wd.today() - 3, name: "gridMET", what: "gridMET's record" };
    if (src === "gridmet") return gm;
    if (src === "power") return { first: POWER_FIRST, last: Wd.today() - 8, name: "NASA POWER", what: "NASA POWER's record" };
    if (!file) return null;
    const f = file.days[0], l = file.days[file.days.length - 1];
    return fill ? { first: Math.min(f, gm.first), last: Math.max(l, gm.last), name: `${file.name} and gridMET`, what: `${file.name} and gridMET's record` }
      : { first: f, last: l, name: file.name, what: `the days in ${file.name}` };
  }
  const loadedFile = () => (userWx ? { days: userWx.days, name: userWxSrc.name } : null);
  /* the date inputs take the chosen source's range; Download moves dates outside it inside and says so */
  function dateLimits() {
    const r = wxRange($("#dlWx").value, $("#uFill").checked, loadedFile());
    $("#dlRange").textContent = r ? `${r.name}: ${span(r)}` : "";
    ["#dlFrom", "#dlTo"].forEach(s => { $(s).min = r ? Wd.isoDay(r.first) : ""; $(s).max = r ? Wd.isoDay(r.last) : ""; });
  }
  const fileDates = () => { $("#dlFrom").value = Wd.isoDay(userWx.days[0]); $("#dlTo").value = Wd.isoDay(userWx.days[userWx.days.length - 1]); };

  /* survey components with horizons; while the survey loads, or where it has none, a placeholder comes first so that
     "My own soil profile…" is never chosen on the user's behalf */
  function soilOptions() {
    const s = state.soil;
    const comps = s && !s.error && s.components ? s.components.filter(c => c.horizons && c.horizons.length) : [];
    const none = comps.length ? "" : `<option value="" selected>${!s ? "Soil survey still loading…" : s.error ? "The soil survey could not be read" : "No survey soil here"}</option>`;
    return none + comps.map(c => `<option value="${esc(c.cokey)}" ${s.dominant && c.cokey === s.dominant.cokey ? "selected" : ""}>${esc(c.compname)} · ${fmt(c.comppct_r, 0)}% of map unit${s.dominant && c.cokey === s.dominant.cokey ? " (dominant)" : ""}</option>`).join("")
      + `<option value="user">My own soil profile…</option>`;
  }
  function render() {
    const P = state.windPeriod || Wd.resolvePeriod(state.period, state.gridModel);
    $("#dataBody").innerHTML = `
      <p class="fine">Files for ${esc(state.place || "this location")} (${state.site.lat.toFixed(4)}, ${state.site.lon.toFixed(4)}). Model files use each model's own units; tables use the units chosen in the units table.</p>
      <section class="data-sec"><h4>1 · Weather and dates</h4>
        <div class="form-grid">
          <label>Weather from<select id="dlWx">
            <option value="gridmet">gridMET, 4 km (1979 on)</option>
            <option value="power">NASA POWER, 0.5° (1981 on)</option>
            <option value="file">My own daily weather file…</option></select></label>
          <label>From<input type="date" id="dlFrom" value="${P.from}" data-site="${siteKey()}"></label>
          <label>To<input type="date" id="dlTo" value="${P.to}"></label>
        </div>
        <p class="fine" id="dlRange"></p>
        <div id="dlWxFile" hidden>
          <p class="fine">A CSV, text or Excel file with one row per day: <b>date</b> (YYYY-MM-DD, or year and doy), <b>tmax</b>, <b>tmin</b>, <b>prcp</b>; optional <b>srad</b>, <b>rh</b> (or rhmax and rhmin), <b>tdew</b>, <b>wind</b>. <button class="link" id="dlWxTpl">Download a template</button></p>
          <div class="form-grid">
            <label>File<input type="file" id="dlWxIn" accept=".csv,.txt,.tsv,.xlsx,.xls"></label>
            <label>Temperature<select id="uT"><option value="C">°C</option><option value="F">°F</option></select></label>
            <label>Rain<select id="uP"><option value="mm">mm</option><option value="in">in</option></select></label>
            <label>Solar radiation<select id="uS"><option value="MJ">MJ/m²/day</option><option value="W">W/m² (daily mean)</option><option value="ly">langley/day</option><option value="kWh">kWh/m²/day</option></select></label>
            <label>Wind<select id="uW"><option value="ms">m/s</option><option value="mph">mph</option><option value="kmh">km/h</option><option value="kn">kn</option></select></label>
            <label>Wind measured at (m)<input type="number" id="uWh" value="2" min="0.5" max="50" step="0.5"></label>
            <label class="check"><input type="checkbox" id="uFill" checked> Fill gaps from gridMET</label>
          </div>
          <p class="fine dl-status" id="dlWxStatus"></p>
        </div>
      </section>
      <section class="data-sec"><h4>2 · Soil</h4>
        <div class="form-grid"><label>Soil profile<select id="dlSoil">${soilOptions()}</select></label>
          <label>Layers<select id="dlLayers"><option value="model">Each model's usual layers</option><option value="survey">The horizons as they are</option><option value="custom">Custom depths…</option></select></label></div>
        <div id="dlDepthBox" hidden>
          <div class="form-grid"><label>Bottom of each layer (${esc(UN.sym("depth"))})<input id="dlDepths" inputmode="decimal" value="${depthText(DEPTH_SETS[0][1])}"></label></div>
          <p class="fine">Separate the depths with commas; the last one is the profile depth. Each layer takes the thickness-weighted mean of the horizons it covers.
            Quick fill: ${DEPTH_SETS.map(([n, d]) => `<button class="link" data-depths="${d.join(",")}">${esc(n)} (${depthText(d)})</button>`).join(" · ")}</p>
        </div>
        <p class="fine dl-status" id="dlLayerInfo"></p>
        <div id="dlSoilEdit" hidden></div>
      </section>
      <section class="data-sec"><h4>3 · Files</h4>
        <div class="model-grid">${MODELS.map(([k, n, d]) => `<label><input type="checkbox" name="dlModel" value="${k}" ${k === "dssat" ? "checked" : ""}><span>${esc(n)}<small>${esc(d)}</small></span></label>`).join("")}</div>
        <h4>Tables and series (CSV)</h4>
        <div class="model-grid">${SERIES.map(([k, n]) => `<label><input type="checkbox" name="dlSeries" value="${k}"><span>${esc(n)}</span></label>`).join("")}</div>
      </section>
      <div class="area-actions"><button class="btn" id="dlPv">Preview</button><button class="btn primary" id="dlGo">Download</button><span class="fine dl-status" id="dlStatus"></span></div>
      <section class="data-sec" id="dlPvSec" hidden><h4>Preview: what the download will hold</h4>
        <p class="fine dl-status" id="dlPvStale" hidden>You changed something since this preview. <button class="link" id="dlPvAgain">Preview again</button></p>
        <div id="dlPvBox"></div>
        <div class="area-actions"><button class="btn primary" id="dlGo2">Download these files</button></div>
      </section>`;
    // switching to the file takes its dates; the units are applied when the files are made, so they need no re-read here
    $("#dlWx").addEventListener("change", e => { const f = e.target.value === "file"; $("#dlWxFile").hidden = !f; if (f && userWx) fileDates(); dateLimits(); });
    $("#uFill").addEventListener("change", dateLimits);
    $("#dlWxTpl").addEventListener("click", () => X.save(M.weatherTemplateCSV(), "weather_template.csv", "text/csv;charset=utf-8"));
    $("#dlWxIn").addEventListener("change", readWxFile);
    $("#dlSoil").addEventListener("change", e => { if (e.target.value === "user") editSoil(); else $("#dlSoilEdit").hidden = true; layerInfo(); });
    $("#dlLayers").addEventListener("change", layerInfo);
    $("#dlDepths").addEventListener("input", layerInfo);
    $$("[data-depths]").forEach(b => b.addEventListener("click", () => { $("#dlDepths").value = depthText(b.dataset.depths.split(",").map(Number)); layerInfo(); keepForm(); }));
    ["#dlGo", "#dlGo2"].forEach(s => $(s).addEventListener("click", () => run(build)));
    ["#dlPv", "#dlPvAgain"].forEach(s => $(s).addEventListener("click", () => run(preview)));
    // put back what the user chose last time; dates and soil only for the same location
    const same = !!form && form.site === siteKey();
    if (form) {
      $$("input[name=dlModel]").forEach(i => { i.checked = form.models.includes(i.value); });
      $$("input[name=dlSeries]").forEach(i => { i.checked = form.series.includes(i.value); });
      Object.entries(form.u || {}).forEach(([k, v]) => { $("#" + k).value = v; });
      $("#uFill").checked = form.fill;
      $("#dlLayers").value = form.layers;
      if (form.depths) $("#dlDepths").value = depthText(form.depths);
      if (same) { $("#dlFrom").value = form.from; $("#dlTo").value = form.to; }
    }
    const wxChoice = form ? form.wx : userWx ? "file" : "gridmet";
    $("#dlWx").value = wxChoice;
    $("#dlWxFile").hidden = wxChoice !== "file";
    if (userWx) $("#dlWxStatus").textContent = wxSummary(userWx, userWxSrc.name);
    if (!same && wxChoice === "file" && userWx) fileDates();
    if (same && [...$("#dlSoil").options].some(o => o.value === form.soil)) $("#dlSoil").value = form.soil;
    if ($("#dlSoil").value === "user") editSoil();
    dateLimits();
    if (!gmAsked) { gmAsked = true; Wd.gridmetLast().then(v => { gmLast = v; dateLimits(); }).catch(() => {}); }
    layerInfo();
    if (running) {
      busy(true);
      $("#dlStatus").textContent = running.tok === state.token ? running.text : "Finishing the download for the previous location: it stops without saving.";
    }
    // the last preview stays until another location is chosen
    if (previewed && previewed.tok !== state.token) { previewed = null; WG.preview.clear(); }
    if (previewed) showPreview();
  }
  const busy = on => ["#dlGo", "#dlGo2", "#dlPv", "#dlPvAgain"].forEach(s => { if ($(s)) $(s).disabled = on; });

  /* ---------- the preview ---------- */
  let previewed = null; // { tok, key, job } of the preview on show
  // everything that changes what a download holds
  const formKey = () => JSON.stringify([$$("input[name=dlModel]:checked").map(i => i.value), $$("input[name=dlSeries]:checked").map(i => i.value),
    $("#dlWx").value, $("#dlFrom").value, $("#dlTo").value, $("#dlSoil").value, $("#dlLayers").value, $("#dlLayers").value === "custom" ? $("#dlDepths").value : "",
    ...(userWxSrc && $("#dlWx").value === "file" ? [userWxSrc.name, userWxSrc.text.length, wxUnits(), $("#uFill").checked] : []),
    ...($("#dlSoil").value === "user" ? [userSoilRows, userSoilRows && userSoilRows.meta] : []),
    UN.all()]);
  // the wind series a preview drew, if it drew any, is still the one in use
  const sameWind = j => !(j.series.some(k => ["hourly", "monthly", "annual"].includes(k)) || j.models.some(m => m === "epic" || m === "apex")) || j.ctx.analysis === windNow().analysis;
  function checkStale() {
    if (previewed && $("#dlPvStale")) $("#dlPvStale").hidden = previewed.key === formKey() && sameWind(previewed.job);
  }
  function showPreview(scroll) {
    if (!$("#dlPvSec")) return;
    $("#dlPvSec").hidden = false;
    WG.preview.show($("#dlPvBox"), previewed.job);
    checkStale();
    if (scroll) $("#dlPvSec").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- the user's weather ---------- */
  /* text of a CSV/TXT file, or of the first sheet of an Excel workbook (.xlsx/.xls, recognised by content) */
  const XLSX_LIB = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
  let xlsxLib = null;
  // a failed load is forgotten, so the next file tries again
  const loadXlsx = () => xlsxLib || (xlsxLib = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = XLSX_LIB; s.onload = res;
    s.onerror = () => { xlsxLib = null; s.remove(); rej(new Error("could not load the Excel reader; check the connection and try again")); };
    document.head.appendChild(s);
  }));
  const two = n => String(n).padStart(2, "0");
  /* an Excel cell as stored, not as displayed: dates as YYYY-MM-DD, numbers in full, percentages as 0-100 */
  function xlsxCell(c, d1904) {
    if (!c || c.v === undefined || c.v === null || c.t === "e" || c.t === "z") return "";
    if (c.v instanceof Date) return `${c.v.getFullYear()}-${two(c.v.getMonth() + 1)}-${two(c.v.getDate())}`;
    if (c.t !== "n") return String(c.v);
    const f = String(c.z || ""), bare = f.replace(/"[^"]*"|\\./g, "");
    const isDate = XLSX.SSF && XLSX.SSF.is_date ? XLSX.SSF.is_date(f) : /[dmyh]/i.test(bare.replace(/\[[^\]]*\]/g, ""));
    if (isDate) return Wd.isoDay(Math.floor(c.v + 1e-6) - 25569 + (d1904 ? 1462 : 0)); // Excel day number (1900 or 1904 system) to epoch day
    return String(/%/.test(bare) ? c.v * 100 : c.v);
  }
  async function fileText(f) {
    const buf = new Uint8Array(await f.arrayBuffer());
    const zipOrOle = (buf[0] === 0x50 && buf[1] === 0x4b) || (buf[0] === 0xd0 && buf[1] === 0xcf);
    if (!zipOrOle && !/\.xlsx?$/i.test(f.name)) return new TextDecoder().decode(buf);
    if (!window.XLSX) await loadXlsx();
    const wb = XLSX.read(buf, { type: "array", cellNF: true, cellText: false }), ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws || !ws["!ref"]) throw new Error("the first sheet is empty");
    const R = XLSX.utils.decode_range(ws["!ref"]), d1904 = !!(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904), out = [];
    for (let r = R.s.r; r <= R.e.r; r++) {
      const row = [];
      for (let c = R.s.c; c <= R.e.c; c++) row.push(xlsxCell(ws[XLSX.utils.encode_cell({ r, c })], d1904));
      if (row.some(v => v !== "")) out.push(row.map(v => (/[",;\t\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(","));
    }
    return out.join("\n");
  }
  // the header each quantity was read from (a wrong match shows here), then what the reader noted about the file
  const COL_NAME = { date: "date", year: "year", month: "month", dom: "day", doy: "day of year", tmax: "Tmax", tmin: "Tmin", prcp: "rain", srad: "solar",
    rh: "humidity", rhmax: "RHmax", rhmin: "RHmin", tdew: "dew point", wind: "wind", et0: "ET0" };
  const readLines = w => {
    const c = Object.entries(w.columns || {});
    return [c.length ? `Read: ${c.map(([k, h]) => `${COL_NAME[k] || k} from ${h}`).join(", ")}.` : "", ...(Array.isArray(w.notes) ? w.notes : [])].filter(Boolean);
  };
  const wxSummary = (w, name) => {
    const miss = k => w[k].filter(v => v === null).length;
    return [`${name}: ${w.days.length.toLocaleString()} days, ${Wd.dayLabel(w.days[0])} – ${Wd.dayLabel(w.days[w.days.length - 1])}. Missing: Tmax ${miss("tmax")}, Tmin ${miss("tmin")}, rain ${miss("prcp")}, solar ${miss("srad")}, humidity ${miss("rh")}, wind ${miss("wind10")} days.`,
      ...readLines(w)].join(" ");
  };
  const wxUnits = () => ({ temp: $("#uT").value, prcp: $("#uP").value, srad: $("#uS").value, wind: $("#uW").value, windHeight: +$("#uWh").value });
  async function readWxFile() {
    const f = $("#dlWxIn").files[0];
    if (!f) return;
    try {
      const text = await fileText(f);
      userWx = M.parseWeatherCSV(text, wxUnits(), state.site.lat, state.site.lon, state.elev ? state.elev.z : null);
      userWxSrc = { name: f.name, text };
      fileDates();
      $("#dlWxStatus").textContent = wxSummary(userWx, f.name);
    } catch (e) { userWx = null; userWxSrc = null; $("#dlWxStatus").textContent = `Could not read ${f.name}: ${e.message}`; }
    dateLimits();
    keepForm(); // the dates were set after the input's change event saved the form
  }
  /* the file read again with the units chosen now, at the download's location */
  function fileWeather(site, elev) {
    if (!userWxSrc) throw new Error("Choose your weather file first.");
    const h = $("#uWh").value;
    if (h !== "" && !(+h >= 0.5 && +h <= 50)) throw new Error("Give the height the wind was measured at, between 0.5 and 50 m.");
    return M.parseWeatherCSV(userWxSrc.text, wxUnits(), site.lat, site.lon, elev);
  }

  /* ---------- the user's soil ---------- */
  /* the user's layers belong to the location they were made for: elsewhere they start again from that location's
     survey, and the name, hydrologic group, slope and albedo always come from the same source as the layers */
  function editSoil() {
    if (userSoilRows && userSoilSite !== siteKey()) { userSoilRows = null; toast("Your own profile was made for another location, so this one starts from this location's survey."); }
    if (!userSoilRows) {
      const base = M.surveySoil(state);
      let rows = base ? base.layers : null;
      try { if (base) rows = WG.writerUtil.soilRows(base); } catch (e) { /* no horizon with water retention: all of them */ }
      // the horizons the model files would use: down to bedrock or a cemented layer, not the horizons below it
      userSoilRows = rows ? rows.map(l => ({ ...l })) : [{ top: 0, bot: 15 }, { top: 15, bot: 45 }, { top: 45, bot: 100 }];
      userSoilRows.meta = { usName: base ? base.name : "My soil", usHg: (base && base.hydgrp) || "B",
        usSlope: base && base.slope !== null ? base.slope : 1, usAlb: base && base.albedo !== null ? base.albedo : 0.13 };
      userSoilSite = siteKey();
    }
    const box = $("#dlSoilEdit"), meta = userSoilRows.meta;
    box.hidden = false;
    const cell = (i, k) => { const v = userSoilRows[i][k]; return `<td><input data-r="${i}" data-k="${k}" inputmode="decimal" value="${v === null || v === undefined ? "" : typeof v === "number" ? +v.toFixed(["ll", "dul", "sat"].includes(k) ? 3 : 2) : esc(v)}"></td>`; };
    box.innerHTML = `<p class="fine">Starts from the survey's dominant soil, down to any bedrock or cemented layer; change any value, add or remove layers, or load your own lab results. Blank water retention, bulk density and Ksat are estimated from sand, clay and organic matter (Saxton &amp; Rawls 2006). Depths in cm, Ksat in mm/h. Water contents are for the whole soil, as the survey gives them: if yours are lab values for the fine earth and the layer has coarse fragments, multiply them by (1 − fragments % ÷ 100).</p>
      <div class="table-wrap"><table class="grid soil-edit"><thead><tr>${M.SOIL_COLS.map(([, l]) => `<th>${esc(l)}</th>`).join("")}<th></th></tr></thead>
      <tbody>${userSoilRows.map((_, i) => `<tr>${M.SOIL_COLS.map(([k]) => cell(i, k)).join("")}<td><button class="link" data-del="${i}" aria-label="Remove layer">✕</button></td></tr>`).join("")}</tbody></table></div>
      ${userSoilRows.notes && userSoilRows.notes.length ? `<p class="fine">${esc(userSoilRows.notes.join(" "))}</p>` : ""}
      <div class="form-grid">
        <label>Soil name<input id="usName" value="${esc(meta.usName)}"></label>
        <label>Hydrologic group<select id="usHg">${["A", "B", "C", "D"].map(g => `<option ${String(meta.usHg).startsWith(g) ? "selected" : ""}>${g}</option>`).join("")}</select></label>
        <label>Slope (%)<input id="usSlope" inputmode="decimal" value="${esc(meta.usSlope)}"></label>
        <label>Dry albedo<input id="usAlb" inputmode="decimal" value="${esc(meta.usAlb)}"></label>
      </div>
      <div class="area-actions"><button class="btn small" id="usAdd">Add layer</button><button class="btn small" id="usTpl">Download as CSV</button><label class="btn small">Load CSV<input type="file" id="usIn" accept=".csv,.txt" hidden></label><button class="btn small" id="usReset">Back to the survey</button></div>`;
    box.querySelectorAll("input[data-r]").forEach(inp => inp.addEventListener("change", e => { userSoilRows[+e.target.dataset.r][e.target.dataset.k] = e.target.value; layerInfo(); }));
    ["usName", "usHg", "usSlope", "usAlb"].forEach(id => $("#" + id).addEventListener("change", e => { meta[id] = e.target.value; if (id === "usName") meta.named = true; }));
    box.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", e => { userSoilRows.splice(+e.target.dataset.del, 1); editSoil(); }));
    $("#usAdd").addEventListener("click", () => { const l = userSoilRows[userSoilRows.length - 1]; userSoilRows.push({ top: l ? num(l.bot) : 0, bot: l ? num(l.bot) + 30 : 30 }); editSoil(); });
    $("#usTpl").addEventListener("click", () => X.save(M.soilTemplateCSV({ layers: userSoilRows.map(x => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, num(v) ?? v]))) }), "soil_profile.csv", "text/csv;charset=utf-8"));
    $("#usIn").addEventListener("change", async e => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const rows = M.parseSoilCSV(await f.text());
        rows.meta = { ...meta, usName: meta.named ? meta.usName : "My soil" }; // the file has layers only: the site values stay, the survey's name goes
        userSoilRows = rows;
        editSoil();
        toast(`${rows.length} layers loaded from ${f.name}.`);
      } catch (err) { toast(err.message); }
    });
    $("#usReset").addEventListener("click", () => { userSoilRows = null; editSoil(); });
    layerInfo();
  }
  /* the chosen soil on the chosen layers: layering "model" (each model's own), "survey" (as they are) or "custom" */
  function chosenSoil() {
    const v = $("#dlSoil").value, e = state.elev;
    let soil;
    if (v === "user") {
      soil = M.userSoil(userSoilRows || [], { name: $("#usName") ? $("#usName").value : "My soil", hydgrp: $("#usHg") ? $("#usHg").value : "B", slope: $("#usSlope") ? $("#usSlope").value : 1,
        albedo: $("#usAlb") ? $("#usAlb").value : 0.13, lat: state.site.lat, lon: state.site.lon, elev: e ? e.z : null, id: "USER" });
    } else {
      soil = M.surveySoil(state, v || null); // "" (the placeholder): the dominant component, if the survey has come in since
      if (!soil) throw new Error(!state.soil ? "The soil survey is still loading: try again in a moment, or choose “My own soil profile…”." : "The survey has no soil profile here: choose “My own soil profile…”.");
    }
    const mode = $("#dlLayers").value;
    if (mode !== "custom") return { ...soil, layering: mode };
    const d = depthsCm();
    if (d.error) throw new Error(d.error);
    return M.relayer(soil, d.B);
  }

  /* ---------- building the files ---------- */
  /* the hourly wind series in use and its analysis, each null with the reason when there is none: the hourly table and
     the EPIC/APEX .WND need only hours in the series' period (also when no month has enough of them for an analysis),
     the monthly and annual summaries an analysis with usable months. A reload (new period or model) clears both, so
     no series is used while state.wind is null. */
  function windNow() {
    const w = state.wind;
    if (!w) { const why = "the wind analysis was still loading (a new period or model)"; return { raw: null, rawWhy: why, analysis: null, why }; }
    const raw = state.windRaw, H = raw && raw.hourly, P = raw && raw.period;
    const hours = !!H && H.t.some((t, i) => Number.isFinite(H.ws[i]) && (!P || (t >= P.t0 && t < P.t1)));
    return { raw: hours ? raw : null, rawWhy: !raw ? `no hourly wind series is loaded${w.error ? ` (${w.error})` : ""}` : "the wind series has no hourly values in its period",
      analysis: w.error ? null : w, why: !w.error ? "" : w.insufficient ? `the wind analysis has no usable month (${w.error})` : `the wind analysis has no result (${w.error})` };
  }
  async function chosenWeather(job, status) {
    const { src, site, elev, d0, d1 } = job;
    if (src !== "file") {
      status(`Reading ${src === "gridmet" ? "gridMET" : "NASA POWER"} daily weather…`);
      return Wd.dailyWeather(site.lat, site.lon, d0, d1, src, elev);
    }
    const u = job.file, ix = new Map(u.days.map((d, k) => [d, k])), w = { ...u, days: [] }, keys = ["prcp", "tmax", "tmin", "srad", "rh", "rhmax", "rhmin", "tdew", "vp", "wind10", "wind2", "et0"];
    keys.forEach(k => { w[k] = []; });
    for (let d = d0; d <= d1; d++) {
      const k = ix.get(d);
      w.days.push(d);
      keys.forEach(key => w[key].push(k === undefined || !u[key] ? null : u[key][k] ?? null));
    }
    if (job.fill) {
      status("Filling gaps from gridMET…");
      try {
        const g = await Wd.dailyWeather(site.lat, site.lon, d0, d1, "gridmet", elev);
        w.filled = M.fillGaps(w, g);
      } catch (e) { w.fillError = e.message; }
    }
    w.et0Made = fileEt0(w, site.lat, elev);
    w.source = `file ${job.name}`;
    return w;
  }
  /* grass ET0 by FAO-56 from a file's own columns (after any gap filling) on the days with Tmax and Tmin that the file
     gives none for, as the model writers make it: values no station reports left out first, a Tmax below Tmin swapped,
     solar radiation from the temperature range (FAO-56 Eq. 50) where it is missing, and Hargreaves (Eq. 52) on days
     without humidity or wind. Counts the file's own days, the days made, those by Hargreaves and those with Eq. 50. */
  function fileEt0(w, lat, elev) {
    const U = WG.writerUtil, c = U.clean(w), phi = (lat * Math.PI) / 180, n = { own: 0, made: 0, hs: 0, solar: 0 };
    const v = (k, i) => (U.ok(c[k][i]) ? c[k][i] : null);
    w.et0 = w.et0.map((e, i) => {
      if (U.ok(e)) { n.own++; return e; }
      const tx = v("tmax", i), tn = v("tmin", i);
      if (tx === null || tn === null) return null;
      const td = v("tdew", i), u2 = v("wind2", i), pm = td !== null && u2 !== null;
      let rs = v("srad", i);
      if (rs === null && pm) { rs = 0.16 * Math.sqrt(Math.abs(tx - tn)) * U.ra(w.days[i], lat); n.solar++; }
      n.made++;
      if (!pm) n.hs++;
      return Wd.fao56(U.doyOf(w.days[i]), phi, elev ?? 0, Math.max(tx, tn), Math.min(tx, tn), td, u2, rs);
    });
    return n;
  }

  /* the last weather and climate reads: Download after Preview reads nothing twice. Writers never change them. */
  let wxKept = null, climKept = null;
  async function keptWeather(job, status) {
    const key = JSON.stringify([job.src, job.fill, job.file ? wxUnits() : null, job.site.lat, job.site.lon, job.elev, job.d0, job.d1]);
    if (wxKept && wxKept.key === key && wxKept.file === (job.file ? userWxSrc : null)) return wxKept.wx;
    const wx = await chosenWeather(job, status);
    wxKept = wx.fillError ? null : { key, file: job.file ? userWxSrc : null, wx }; // a failed fill may work next time
    return wx;
  }

  const STOPPED = new Error("stopped");
  const notWritten = (what, why, more) => `${what} could not be made: ${String(why).replace(/\.$/, "")}.\r\n${more ? `${more}\r\n` : ""}The other files in this zip are complete; README.txt lists them.\r\n`;
  // a Preview or a Download, with the sheet's choices at this moment
  async function run(action) {
    if (running) return;
    const models = $$("input[name=dlModel]:checked").map(i => i.value), series = $$("input[name=dlSeries]:checked").map(i => i.value);
    if (!models.length && !series.length) return toast("Tick at least one model or table.");
    const a = $("#dlFrom").value, b = $("#dlTo").value;
    if (!a || !b || a > b) return toast("Choose a start date before the end date.");
    running = { tok: state.token, text: "" };
    busy(true);
    const status = t => { running.text = t; $("#dlStatus").textContent = t; };
    status("Working…"); // not the last download's result
    let msg;
    try { msg = await action(models, series, a, b, status); }
    catch (e) {
      if (e !== STOPPED) console.error(e);
      msg = e === STOPPED ? "Stopped: another location was chosen while the files were being made, so nothing was saved." : `Could not make the files: ${e.message || e}`;
    }
    running = null;
    busy(false);
    $("#dlStatus").textContent = msg;
    if ($("#dataSheet").hidden) toast(msg, 6000);
  }
  /* everything the files need, up to packing them, for a Preview and a Download alike. It is all read before the first
     await, so closing the sheet, opening it again or choosing another location cannot leak into it; another location
     stops it */
  async function prepare(models, series, a, b, status) {
    const tok = state.token, live = () => { if (state.token !== tok) throw STOPPED; };
    const site = { lat: state.site.lat, lon: state.site.lon, name: state.place || "WindGuard site" }, place = state.place, elev = state.elev ? state.elev.z : null;
    const src = $("#dlWx").value, fill = src === "file" && $("#uFill").checked, windHeight = +$("#uWh").value || 2;
    const needWx = models.length > 0 || series.includes("daily"), needSoil = models.length > 0 || series.includes("soil");
    const soil = needSoil ? chosenSoil() : null;
    if (soil && !soil.layers.length) throw new Error(soil.mukey ? `The survey has no usable layers for ${soil.name}: choose another component, or “My own soil profile…”.` : "Your profile has no complete layer: each needs a bottom depth, sand and clay.");
    if (soil && models.some(m => m !== "csv")) usableRows(soil);
    const file = needWx && src === "file" ? fileWeather(site, elev) : null;
    // dates outside the source's record are left out; none inside it is an error
    let d0 = Wd.parseDay(a), d1 = Wd.parseDay(b), moved = null;
    if (needWx) {
      const r = wxRange(src, fill, file && { days: file.days, name: userWxSrc.name });
      if (d1 < r.first || d0 > r.last) throw new Error(`These dates are outside ${r.what} (${span(r)}).`);
      if (d0 < r.first || d1 > r.last) {
        d0 = Math.max(d0, r.first); d1 = Math.min(d1, r.last);
        moved = `Dates outside ${r.what} (${span(r)}) were left out: the files cover ${Wd.dayLabel(d0)} – ${Wd.dayLabel(d1)}`;
        $("#dlFrom").value = Wd.isoDay(d0); $("#dlTo").value = Wd.isoDay(d1);
        keepForm();
      }
    }
    const wind = windNow(), failed = [], noted = new Map();
    // the hourly series (hourly table, EPIC/APEX .WND) and its analysis (monthly and annual summaries), or why there is none
    const ctx = { wx: null, soil, climWx: null, site: { ...site, elev }, wind: wind.raw ? { raw: wind.raw } : null, windWhy: wind.rawWhy, analysis: wind.analysis, analysisWhy: wind.why, d0, d1 };
    // the wind tables come from the series in use now
    const windTables = series.filter(k => ["hourly", "monthly", "annual"].includes(k)).map(k => tableFile(k, ctx, failed));

    const wx = needWx ? await keptWeather({ src, fill, file, name: userWxSrc && userWxSrc.name, site, elev, d0, d1 }, status) : null;
    live();
    // days without Tmax and Tmin at either end: the models that cannot read gaps leave them out (their READMEs give the dates)
    let edge = null;
    if (wx) {
      const both = k => Number.isFinite(wx.tmax[k]) && Number.isFinite(wx.tmin[k]), N = wx.days.length;
      let i0 = 0, i1 = N - 1;
      while (i0 < N && !both(i0)) i0++;
      while (i1 > i0 && !both(i1)) i1--;
      if (i0 < N && (i0 > 0 || i1 < N - 1)) edge = `The weather has Tmax and Tmin only from ${Wd.dayLabel(wx.days[i0])} to ${Wd.dayLabel(wx.days[i1])}`;
    }
    const gapless = models.filter(m => ["dssat", "apsim", "aquacrop"].includes(m)).map(m => MODEL_NAME[m]);
    // TAV and AMP (DSSAT, APSIM) need Tmax and Tmin on 20 or more days of every month, and each group of weather-
    // generator statistics (EPIC, APEX, SWAT+) its variables: when the weather lacks them (dates short of a month, a
    // file without solar radiation, NASA POWER before its solar record), 10 complete years of the same source (gridMET
    // for a file) are read, with every variable when a generator needs them
    const U = WG.writerUtil, by = list => (wx ? models.filter(m => list.includes(m)).map(m => MODEL_NAME[m]) : []);
    const tavBy = by(["dssat", "apsim"]), genBy = by(["epic", "apex", "swatplus"]);
    const tav = tavBy.length > 0 && !U.tavAmp(wx, false), gaps = genBy.length ? U.statGaps(wx) : [];
    let climWx = null, climError = null, clim = null;
    if (tav || gaps.length) {
      const cs = src === "power" ? "power" : "gridmet", per = new Array(12).fill(0);
      wx.days.forEach(d => per[new Date(d * 864e5).getUTCMonth()]++);
      const short = per.some(x => x < 20), genWhat = gaps.length ? `the weather-generator statistics${short ? "" : ` of ${and(gaps)}`}` : ""; // short: every group lacks those months
      clim = { src: cs === "power" ? "NASA POWER" : "gridMET", tav, gaps, tavBy, genBy, genWhat, what: and([tav && "TAV and AMP", genWhat].filter(Boolean)),
        why: short ? "the chosen dates do not cover every month" : `the weather has fewer than 20 days of ${and(gaps.length ? gaps : ["Tmax and Tmin"])} in some months` };
      status(`${cap(clim.why)}: reading 10 complete years of ${clim.src} for ${clim.what}…`);
      try {
        const y1 = new Date((cs === "gridmet" ? await Wd.gridmetLast() : Wd.today() - 10) * 864e5).getUTCFullYear() - 1, some = cs === "gridmet" && !gaps.length;
        clim.years = `${y1 - 9}–${y1}`;
        const key = JSON.stringify([cs, some, site.lat, site.lon, elev, y1]);
        climWx = climKept && climKept.key === key ? climKept.wx : await Wd.dailyWeather(site.lat, site.lon, Wd.epochDay(y1 - 9, 0, 1), Wd.epochDay(y1, 11, 31), cs, elev, some ? ["tmmx", "tmmn"] : null);
        climKept = { key, wx: climWx };
      } catch (e) { console.warn("climate statistics", e); climError = e.message || String(e); }
      live();
    }
    Object.assign(ctx, { wx, climWx, site: { ...site, elev: elev ?? (wx ? wx.elev : null) } });
    const files = [];
    for (const m of models) {
      status(`Writing ${MODEL_NAME[m]} files…`);
      try {
        const w = M.writers[m];
        if (!w) throw new Error("its writer is not available yet");
        const out = await w(ctx);
        out.forEach(f => files.push({ ...f, name: `${m}/${f.name}` }));
        (Array.isArray(out.notes) ? out.notes : []).forEach(n => noted.set(n, [...(noted.get(n) || []), MODEL_NAME[m]]));
      } catch (e) {
        console.error(e);
        // the reason without the model's own name in front ("EPIC: the .WP1 ..."), as it is filed under that name
        const why = String(e.message || e).replace(new RegExp(`^${MODEL_NAME[m].split(" ")[0].replace(/\+/g, "\\+")}: `), "");
        failed.push({ what: MODEL_NAME[m], why });
        // a generator whose missing statistics the failed climate read was to supply: a later download may get them
        const more = climError && clim.gaps.length && clim.genBy.includes(MODEL_NAME[m]) ? `Reading 10 complete years of ${clim.src} for ${clim.what} failed (${climError}); downloading again may get them.` : "";
        files.push({ name: `${m}/NOT_WRITTEN.txt`, text: notWritten(`The ${MODEL_NAME[m]} files`, why, more) });
      }
    }
    files.push(...windTables, ...series.filter(k => k === "daily" || k === "soil").map(k => tableFile(k, ctx, failed)));
    // the same reason, or note, once for all it concerns
    const why = [...new Set(failed.map(f => f.why))].map(r => `${and(failed.filter(f => f.why === r).map(f => f.what))}: ${r.replace(/\.$/, "")}`).join("; ");
    const notes = [...noted].map(([t, ms]) => `${and(ms)}: ${t}`), n = files.filter(f => !/NOT_WRITTEN/.test(f.name)).length;
    // nothing to save: a failed climate read is then the reason a second try may work
    if (!n) throw new Error(`${why || "there was nothing to write"}${climError ? `. Reading 10 complete years of ${clim.src} for ${clim.what} failed (${climError}); downloading again may get them` : ""}`);
    files.push({ name: "README.txt", text: readme(ctx, { models, series, moved, edge, clim, climError, notes, failed, windHeight, file }) });
    const warn = [moved && `${moved}.`, edge && gapless.length && `${edge}: the ${and(gapless)} files leave out the other days.`,
      climWx && `${cap(clim.what)} come from 10 complete years of ${clim.src} (${clim.years}), because ${clim.why}.`,
      climError && `${cap(clim.why)}, and reading 10 complete years of ${clim.src} for ${clim.what} failed (${climError}).`,
      wx && wx.fillError && `Gaps could not be filled from gridMET (${wx.fillError}).`, failed.length && `Not written: ${why}.`,
      notes.length && `${notes.length} note${notes.length > 1 ? "s" : ""} from the model files.`].filter(Boolean);
    return { tok, live, ctx, files, n, models, series, notes, failed, site, place, d0, d1, warn, names: MODEL_NAME };
  }
  async function build(models, series, a, b, status) {
    const p = await prepare(models, series, a, b, status);
    status("Packing…");
    const blob = await M.zip(p.files);
    p.live();
    X.save(blob, `${D.baseName(`${Wd.isoDay(p.d0)}_${Wd.isoDay(p.d1)}`, p.site, p.place)}.zip`, "application/zip");
    return `Done: ${p.n} file${p.n === 1 ? "" : "s"}.${p.warn.length ? ` ${p.warn.join(" ")} See README.txt.` : ""}`;
  }
  async function preview(models, series, a, b, status) {
    const key = formKey(), p = await prepare(models, series, a, b, status);
    p.live();
    previewed = { tok: p.tok, key, job: p };
    showPreview(true);
    return `Nothing is saved yet: this is what the ${p.files.length} file${p.files.length === 1 ? "" : "s"} will hold.${p.warn.length ? ` ${p.warn.join(" ")}` : ""}`;
  }
  const and = a => (a.length > 1 ? `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}` : a[0]);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  /* one table, or a note saying why it is missing */
  function tableFile(k, ctx, failed) {
    try { return seriesFile(k, ctx); }
    catch (e) {
      failed.push({ what: SERIES_NAME[k], why: String(e.message || e) });
      return { name: `tables/${TABLE[k]}_NOT_WRITTEN.txt`, text: notWritten(SERIES_NAME[k], e.message || e) };
    }
  }
  const rd = (v, d) => (Number.isFinite(v) ? +v.toFixed(d) : null); // null for missing, NaN or Infinity
  function seriesFile(k, ctx) {
    const ws = UN.sym("wind"), cw = v => rd(UN.conv("wind", v), 2), name = `tables/${TABLE[k]}.csv`;
    if (k === "monthly" || k === "annual") {
      if (!ctx.analysis) throw new Error(ctx.analysisWhy);
      const t = D.summary(k, ctx.analysis);
      return { name, text: X.csv(t.header, t.rows) };
    }
    if (k === "hourly") {
      if (!ctx.wind) throw new Error(ctx.windWhy);
      const raw = ctx.wind.raw, off = raw.offset || 0, P = raw.period, rows = [];
      raw.hourly.t.forEach((t, i) => { if (P && (t < P.t0 || t >= P.t1)) return; const d = new Date((t + off) * 1000); rows.push([new Date(t * 1000).toISOString().slice(0, 16) + "Z", d.toISOString().slice(0, 16).replace("T", " "), cw(raw.hourly.ws[i]), rd(raw.hourly.wd[i], 0)]); });
      return { name, text: X.csv(["Time (UTC)", "Local standard time (CST)", `Wind speed at 10 m (${ws})`, "Direction from (deg)"], rows) };
    }
    if (k === "daily") {
      const w = WG.writerUtil.clean(ctx.wx), U2 = q => v => rd(UN.conv(q, v), 2); // values no station reports are blank, as in the model files
      const p = U2("precip"), t = U2("temp"), sr = U2("solar");
      return { name, text: X.csv(["Date", `Precipitation (${UN.sym("precip")})`, `Tmax (${UN.sym("temp")})`, `Tmin (${UN.sym("temp")})`, `Solar radiation (${UN.sym("solar")})`,
        "Relative humidity (%)", `Dew point (${UN.sym("temp")})`, `Wind at 10 m (${ws})`, `Grass ET0 (${UN.sym("precip")})`],
        w.days.map((d, i) => [Wd.isoDay(d), p(w.prcp[i]), t(w.tmax[i]), t(w.tmin[i]), sr(w.srad[i]), rd(w.rh[i], 1), t(w.tdew[i]), cw(w.wind10[i]), p(w.et0[i])])) };
    }
    // every value rounded, and blank when missing (null, NaN): Ksat mm/h to the table's unit only when present, as
    // null / 3.6 would be 0, impermeable
    const s = ctx.soil, dz = v => rd(UN.conv("depth", v), 1), ks = v => (Number.isFinite(v) ? rd(UN.conv("ksat", v / 3.6), 3) : null);
    return { name, text: X.csv([`Top (${UN.sym("depth")})`, `Bottom (${UN.sym("depth")})`, "Horizon", "Sand (%)", "Silt (%)", "Clay (%)", "Organic matter (%)", "Organic carbon (%)",
      "Bulk density (g/cm3)", "Wilting point (cm3/cm3)", "Field capacity (cm3/cm3)", "Saturation (cm3/cm3)", `Ksat (${UN.sym("ksat")})`, "pH", "CEC (cmol/kg)", "CaCO3 (%)", "Coarse fragments (% volume)", "EC (dS/m)"],
      s.layers.map(l => [dz(l.top), dz(l.bot), l.hz, rd(l.sand, 2), rd(l.silt, 2), rd(l.clay, 2), rd(l.om, 2), rd(l.oc, 2), rd(l.bd, 2), rd(l.ll, 3), rd(l.dul, 3), rd(l.sat, 3), ks(l.ksat),
        rd(l.ph, 2), rd(l.cec, 2), rd(l.caco3, 2), rd(l.cfVol, 1), rd(l.ec, 2)])) };
  }

  /* how the files' wind was made, by source */
  function windText(w, o) {
    const has = a => Array.isArray(a) && a.some(v => v !== null && v !== undefined);
    const gm = w.filled && w.filled.wind10 ? ` ${w.filled.wind10} days come from gridMET's 10 m wind (2 m = 0.748 × 10 m).` : "";
    const how = w.source === "gridmet" ? "gridMET daily mean wind at 10 m; the 2 m wind is 0.748 × the 10 m value (FAO-56 Eq. 47)."
      : w.source === "power" ? "NASA POWER daily mean wind at 10 m (WS10M) and at 2 m (WS2M), each used as it is."
        : has(o.file && o.file.wind10) ? `your file's wind, measured at ${o.windHeight} m and moved to 10 m and 2 m with the log law (roughness 0.03 m).${gm}`
          : `your file has none.${gm || " The model files leave it out or mark it missing."}`;
    return `Wind: ${how} Each model file states its height.`;
  }
  /* the soil the model files start from: its horizons (or your layers, or the custom layers) with water retention and
     bulk density. The models split or merge them, so each model folder's README gives the layers its file has. */
  function soilText(s, o) {
    const lay = s.layering === "custom" ? "custom depths" : s.layering === "survey" ? "the horizons as they are" : "each model's usual layers";
    const made = o.models.some(m => !o.failed.some(f => f.what === MODEL_NAME[m])), c = v => +v.toFixed(1);
    // only tables in this zip: no model files to tell about
    if (!made) return [`Soil: ${s.name}, ${s.source}. The soil table lists its ${s.layers.length} layers, ${c(s.layers[0].top)} to ${c(s.layers[s.layers.length - 1].bot)} cm.`];
    const L = [`Soil: ${s.name}, ${s.source}. Layers: ${lay}.`];
    let use = null;
    try { use = WG.writerUtil.soilRows(s); } catch (e) { /* no layer with water retention and bulk density */ }
    if (!use) return [...L, "  No layer has water retention and bulk density; only the plain CSV and the soil table describe it."];
    const n = use.length, end = use[n - 1].bot, rest = s.layers.filter(l => l.top >= end), rl = s.relayer, pl = n > 1 ? "s" : "";
    const from = s.layering === "custom" ? `${n} layer${pl} on your depths (bottoms ${use.map(l => c(l.bot)).join(", ")} cm)`
      : `${n} ${s.mukey ? "horizon" : "layer"}${pl} with water retention and bulk density`;
    L.push(`  The model files start from ${from}, ${c(use[0].top)} to ${c(end)} cm.`
      + (rl && rl.cut !== null ? ` The profile ends at ${c(rl.cut)} cm (bedrock or a cemented layer).`
        : rest.length ? ` Below ${c(end)} cm ${s.mukey ? "the survey gives no water retention or bulk density (bedrock or a cemented layer)" : "the layers have no water retention or bulk density"}, so the profile ends there.` : "")
      + (rl && rl.extendedBelow !== null ? ` Below ${c(rl.extendedBelow)} cm the survey has no horizons, so the deepest one is repeated.` : "")
      + (s.layering === "model" ? " Each model splits or merges them its own way."
        : n > 5 ? ` The models that take fewer layers (AquaCrop at most 5${n > 10 ? ", APEX 10" : ""}${n > 15 ? ", EPIC 15" : ""}${n > 20 ? ", DSSAT 20" : ""}) merge the thinnest neighbours.` : "")
      + " Each model folder's README gives the layers that model's file has.");
    if (rest.length && (o.series.includes("soil") || o.models.includes("csv"))) L.push(`  The soil table and the plain CSV list all ${s.layers.length} layers, to ${c(s.layers[s.layers.length - 1].bot)} cm, as ${s.mukey ? "the survey gives" : "you entered"} them.`);
    return L;
  }
  /* where a file's grass ET0 came from, by day */
  function et0Text(w) {
    const e = w.et0Made, none = w.days.length - e.own - e.made, after = w.filled ? " after the gap filling" : "", pm = e.made - e.hs;
    const days = x => `${x.toLocaleString()} day${x === 1 ? "" : "s"}`;
    return `Grass ET0: ${and([e.own && `${days(e.own)} from your file's own column`,
      pm && `${days(pm)} by FAO-56 Penman-Monteith from the file's columns${after}${e.solar ? ` (solar radiation from the temperature range, FAO-56 Eq. 50, on ${days(e.solar)})` : ""}`,
      e.hs && `${days(e.hs)} by Hargreaves (FAO-56 Eq. 52) from Tmax and Tmin${after}, for want of humidity or wind`,
      none && `none on ${days(none)} without Tmax and Tmin`].filter(Boolean))}.`
      + (w.filled ? " gridMET's ET0 is not copied in, as it would not match your weather." : "");
  }
  function readme(ctx, o) {
    const w = ctx.wx, s = ctx.soil, c = o.clim;
    const L = [`WindGuard TX data for ${ctx.site.name} (${ctx.site.lat.toFixed(5)}, ${ctx.site.lon.toFixed(5)})`, `Made ${new Date().toISOString().slice(0, 10)} with ${location.origin}${location.pathname}`, ""];
    if (w) {
      L.push(`Weather: ${w.source === "gridmet" ? "gridMET 4 km daily (University of Idaho; Abatzoglou 2013), cell " + w.lat.toFixed(4) + ", " + w.lon.toFixed(4) : w.source === "power" ? "NASA POWER daily (MERRA-2 based, 0.5°)" : w.source}`);
      if (o.file) L.push(...readLines(o.file));
      L.push(`Dates: ${Wd.isoDay(ctx.d0)} to ${Wd.isoDay(ctx.d1)} (${w.days.length} days). DSSAT, APSIM and AquaCrop cannot read gaps: each folder's README says how their files deal with them. The other files use the model's missing-value code.`);
      if (o.moved) L.push(`${o.moved}.`);
      if (o.edge) L.push(`${o.edge}. DSSAT, APSIM and AquaCrop leave out the days without them (their READMEs give the dates).`);
      if (w.filled) L.push(`Gaps filled from gridMET: ${Object.entries(w.filled).map(([k, n]) => `${k} ${n} days`).join(", ") || "none needed"}.`);
      if (w.fillError) L.push(`Gaps could not be filled: ${w.fillError}`);
      if (w.et0Made) L.push(et0Text(w));
      L.push(windText(w, o), "");
    }
    // why 10 complete years were read, for which models' statistics, and what they did when the read failed
    if (c && ctx.climWx) L.push(`Climate statistics: ${and([c.tav && `TAV and AMP (${and(c.tavBy)})`, c.gaps.length && `${c.genWhat} (${and(c.genBy)})`].filter(Boolean))} come from 10 complete years of ${c.src}, `
      + `${Wd.isoDay(ctx.climWx.days[0])} to ${Wd.isoDay(ctx.climWx.days[ctx.climWx.days.length - 1])}, because ${c.why}. Each model folder's README says which of its statistics use them.`, "");
    else if (c && o.climError) L.push(`Climate statistics: ${c.why}, and reading 10 complete years of ${c.src} for ${c.what} failed (${o.climError}).`
      + (c.tav ? ` ${and(c.tavBy)} ${c.tavBy.length > 1 ? "take" : "takes"} TAV and AMP from the months the dates have instead, marked approximate.` : "")
      + (c.gaps.length ? ` For ${and(c.genBy)}, the folder's README says where the generator statistics came from, or a NOT_WRITTEN.txt in its place says why the files could not be made.` : ""), "");
    if (s) L.push(...soilText(s, o), "");
    const wnd = o.models.filter(m => m === "epic" || m === "apex").map(m => MODEL_NAME[m]).filter(n => !o.failed.some(f => f.what === n));
    if (!ctx.wind && wnd.length) L.push(`${and(wnd)} wind file (.WND): ${ctx.windWhy}, so it uses daily mean wind, with directions spread evenly (the folder's README says from which days).`, "");
    if (o.notes.length) L.push("Notes from the model files:", ...o.notes.map(n => `  ${n}`), "");
    if (o.failed.length) L.push("Not written (a NOT_WRITTEN.txt in its place says why):", ...o.failed.map(f => `  ${f.what}: ${f.why}`), "");
    const made = what => !o.failed.some(f => f.what === what);
    L.push(`Models: ${o.models.filter(m => made(MODEL_NAME[m])).map(m => `${MODEL_NAME[m]} (${m}/)`).join(", ") || "none"}. Tables: ${o.series.filter(k => made(SERIES_NAME[k])).map(k => `tables/${TABLE[k]}.csv`).join(", ") || "none"}.`,
      "See the README inside each model folder, where present, for how to load the files.");
    return L.join("\r\n") + "\r\n";
  }

  // the form is saved as it is filled in, in the units of that moment, so a later change of units converts it correctly
  ["input", "change"].forEach(t => $("#dataBody").addEventListener(t, () => { keepForm(); checkStale(); }));
  $("#dataBtn").addEventListener("click", () => {
    if (!state.site) return toast("Pick a location on the map first.");
    render();
    D.open("dataSheet");
  });
  return { render };
})();
