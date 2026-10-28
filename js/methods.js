/* Methods sheet: where each value came from for the current site, the data-source catalog, and every equation the app uses. */
WG.methods = (function () {
  const { $, $$, esc } = WG.util;
  const A = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  const USED = '<span class="badge used">used</span>', CHECK = '<span class="badge check">cross-check</span>',
    REF = '<span class="badge ref">reference only</span>', FALLBACK = '<span class="badge ref">fallback</span>';

  /* [data, producer, how the app reads it, resolution · period, if it fails] */
  const SOURCES = [
    ["Hourly 10 m wind speed and direction (default)", "NASA GMAO MERRA-2 reanalysis",
      `<b>Direct:</b> ${A("https://power.larc.nasa.gov/docs/services/api/temporal/hourly/", "NASA POWER")} hourly API (about 1–3 s for 10–20 years)`,
      "0.5° × 0.625° (~50 km) hourly, 2001 on", "ECMWF via Open-Meteo, if NASA POWER errors or has not answered within 20 s"],
    ["Hourly 10 m wind speed and direction (backup, or when chosen)", "ECMWF: IFS operational analysis; ERA5 reanalysis by Copernicus C3S",
      `${A("https://open-meteo.com/en/docs/historical-weather-api", "Open-Meteo")} archive, a re-hosted copy. Copernicus's own data store needs each user's personal key and a queued job that takes minutes.`,
      "9 km hourly (2017 on); 0.25° (~28 km) hourly (before 2017)", "NASA MERRA-2"],
    ["Daily maximum gust (model)", "ECMWF IFS / ERA5 only", "Open-Meteo, with the ECMWF hourly wind", "as above",
      "MERRA-2 has no gust variable: calibration maps its daily max wind to airport gusts"],
    ["Airport wind observations (ASOS/AWOS)", `NWS/FAA stations, archived by NOAA NCEI in ${A("https://www.ncei.noaa.gov/products/global-historical-climatology-network-hourly", "GHCNh")} (successor to ISD, which stopped in Aug 2025)`,
      `<b>Direct:</b> ${A("https://www.ncei.noaa.gov/access/services/data/v1", "NCEI Access Data Service")}, wind columns only, one request per year`, "station, routine hourly METAR, decades",
      `${A("https://mesonet.agron.iastate.edu/request/download.phtml", "Iowa Environmental Mesonet")} ASOS archive (NWS METAR feed)`],
    ["Daily precipitation, grass reference ET₀, max/min temperature", `${A("https://www.climatologylab.org/gridmet.html", "gridMET")}, University of Idaho (Abatzoglou 2013): PRISM-based precipitation, NLDAS-2 meteorology, ASCE Penman–Monteith ET₀`,
      `<b>Direct:</b> ${A("https://thredds.northwestknowledge.net/thredds/reacch_climate_MET_aggregated_catalog.html", "THREDDS")} OPeNDAP, one cell, scale and offset read from the file`, "4 km (1/24°) daily, 1979 on", "NASA POWER daily, direct (Penman–Monteith ET₀ computed in the app), then ECMWF daily via Open-Meteo"],
    ["Soil profile, WEG, I, T, MLRA, climatic factor C", "USDA-NRCS Soil Survey Geographic Database (SSURGO)",
      `<b>Direct:</b> ${A("https://sdmdataaccess.nrcs.usda.gov/", "Soil Data Access")} REST queries`, "map units, 1:12,000–1:24,000", "none: enter a soil test on the Soil tab"],
    ["Elevation, slope, aspect", "USGS 3D Elevation Program (3DEP)", `<b>Direct:</b> ${A("https://apps.nationalmap.gov/epqs/", "Elevation Point Query Service")}, 5 points`, "1–10 m lidar/DEM", "Copernicus GLO-90 via Open-Meteo"],
    ["Land cover", "USGS / MRLC National Land Cover Database 2021", `<b>Direct:</b> ${A("https://www.mrlc.gov/", "MRLC")} WMS feature query (MRLC currently refuses browser requests)`, "30 m",
      `Sentinel-2 10 m land cover, latest year (${A("https://livingatlas.arcgis.com/landcover/", "Impact Observatory, Microsoft, Esri")}), direct`],
    ["Soil polygons inside a drawn or uploaded area", "USDA-NRCS SSURGO", `<b>Direct:</b> ${A("https://sdmdataaccess.nrcs.usda.gov/", "Soil Data Access")} spatial query: map-unit polygons clipped to the boundary, with component WEG, I and %`, "map units, 1:12,000–1:24,000", "none"],
    ["Building footprints (area tool; map clicks refused)", "FEMA / Oak Ridge National Laboratory USA Structures", `<b>Direct:</b> ${A("https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0", "USA Structures")} feature service`, "footprint polygons", "buildings not removed (the panel says so)"],
    ["Roads (area tool; map clicks refused)", "U.S. Census Bureau TIGER/Line", `<b>Direct:</b> ${A("https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer", "TIGERweb")} primary, secondary and local roads, widened by road class`, "road centrelines", "roads not removed (the panel says so)"],
    ["Water bodies (area tool; map clicks refused)", "USGS National Hydrography Dataset (NHD): lakes and ponds, reservoirs, swamps and marshes, estuaries (playas stay in)", `<b>Direct:</b> ${A("https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer", "NHD map service")}; SSURGO “Water” map units are always left out too`, "1:24,000 water-body polygons", `Esri's copy of NHD (${A("https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Detailed_Water_Bodies/FeatureServer/0", "USA Detailed Water Bodies")}): taken if NHD has not answered within 5 s (3 s for a click)`],
    ["Boundary files", "Your shapefile, KML/KMZ or GeoJSON", "Read in the browser with the open-source shpjs (with .prj reprojection), togeojson and JSZip libraries; nothing is uploaded to a server", "as drawn", "—"],
    ["Statewide susceptibility and WEG maps", "SSURGO, gridded by UC Davis SoilWeb (800 m WEI, WEG) × NRCS county C",
      "Pre-built 1 km PNGs (tools/build_layers.py)", "1 km", "direct alternative: gNATSGO rasters (multi-GB)"],
    ["Statewide windy-season map; C where a county value is missing", "NASA MERRA-2 climatology", "Pre-built from NASA POWER (tools/fetch_power_grid.py)", "0.5° × 0.625°, 2001–2025", "—"],
    ["Airport list and NOAA station ids", "IEM station networks; NOAA ISD history and GHCNh station list", "Pre-built data/stations.js (tools/fetch_stations.py)", "417 stations in TX, NM, OK, LA, AR", "—"],
    ["Imagery, labels, roads, rivers", "Esri World Imagery and Reference; USGS The National Map", "Map tiles, direct", "to ~0.5 m", "—"],
    ["Soil map-unit lines", "USDA-NRCS SSURGO", "Soil Data Access WMS, direct (zoom 13+)", "—", "—"],
    ["Place search and names", "OpenStreetMap contributors", "Nominatim, direct", "—", "—"],
    ["Practice recommendations", "NRCS Texas FOTG standards, Texas A&M AgriLife, TxDOT, WAFWA, published trials", "Encoded in js/practices.js from docs/RESEARCH.md", "—", "—"],
  ];

  /* [quantity, equation, terms and units, where the app uses it, source, status] */
  const EROD = [
    ["Bare-field potential soil loss (WEQ step E3)", "E = I × K × C / 100,&nbsp; K = 1",
      "E: t/ac/yr; I: soil erodibility index (t/ac/yr); K: ridge-roughness factor (1 = smooth); C: climatic factor (%). Wide, bare, unsheltered field.",
      "Overview risk card; statewide susceptibility map", "Woodruff &amp; Siddoway 1965; NRCS National Agronomy Manual Part 502", USED],
    ["Climatic factor", "C = 34.483 · v³ / PE²",
      "v: mean annual wind speed at 30 ft (mph); PE: Thornthwaite index. Garden City, KS = 100.",
      "Site C is NRCS's published value for the map unit; this equation fills statewide cells with no county value", "Chepil, Siddoway &amp; Armbrust 1962", USED],
    ["Thornthwaite precipitation-effectiveness index", "PE = Σ<sub>12 months</sub> 115 [ P / (T − 10) ]<sup>10/9</sup>",
      "P: monthly precipitation (in, minimum 0.5); T: monthly mean temperature (°F, minimum 28.4).", "Statewide C where a county value is missing", "Thornthwaite 1931; NAM Part 502", USED],
    ["Erodibility index (highly erodible land, wind)", "EI = C · I / T&nbsp; (C as a fraction)",
      "T: tolerable soil loss from SSURGO (t/ac/yr). EI ≥ 8 meets the wind criterion for highly erodible land.", "Overview risk card", "7 CFR 12.21; NRCS NFSAM", USED],
    ["Wind Erodibility Group and I from the surface layer", "WEG = f(texture, CaCO₃, coarse fragments) → I",
      "Texture guide: WEG 1 sands (I 160–310) · 2 loamy sands (134) · 3 sandy loams (86) · 4 clays (86) · 4L calcareous loams (86) · 5 noncalcareous loams (56) · 6 noncalcareous clayey loams (48) · 7 noncalcareous silts (38) · 8 rock-covered or wet (0); full definitions under Classes and scales. Not applied: iron-rich mineralogy, andic material, wetness, Folists. Calcareous = CaCO₃ ≥ 5% (app proxy for strong effervescence). Coarse fragments (% by volume: SSURGO's fragment volume, else its sieve weight % converted with the bulk density, at least the class of a modifier such as STV) 15–35% → one group less erodible (the next lower I, 86 → 56), 35–60% → two, > 60% → I = 0; sands and loamy sands move less.",
      "Soil tab, when an edit to the surface layer changes what these rules give (otherwise SSURGO's own WEG and I are kept)", "NRCS National Soil Survey Handbook, Part 618, §618.93 (2024)", USED],
    ["Texture class", "USDA texture triangle (sand, silt, clay %)", "Sand-size modifier (e.g. fine sandy loam) kept from the survey when the family is unchanged.",
      "Soil tab", "Soil Survey Manual (USDA Handbook 18, 2017)", USED],
    ["Risk classes", "E &lt; 10 Low · 10–40 Moderate · 40–80 High · 80–150 Very high · ≥ 150 Extreme",
      "t/ac/yr; roughly 2, 8, 16 and 30 times T = 5.", "Overview risk card; area analysis", "App convention, not NRCS classes", USED],
    ["Area share of a WEG or risk class", "share<sub>k</sub> = Σ<sub>points</sub> Σ<sub>components</sub> (pct / 100) · [class = k] &nbsp;/&nbsp; Σ<sub>points</sub> Σ<sub>components</sub> (pct / 100)",
      "About 20,000 stratified random points inside the boundary (seeded, so the same area gives the same answer). Points on a building, a road (within its class half-width) or water, outside Texas, or without soil data are left out; each map unit is split by its component percentages; components without a WEG are reported separately. Acres = share × analysed acres; mean I and E are weighted the same way, with E = I × C / 100 and C from each map unit's climatic-factor area.",
      "Field or area analysis", "App", USED],
    ["Road half-widths", "S1100 15 m · S1200 9 m · S1400 5 m · S1630 6 m · S1640 4 m · S1730/S1740/S1750 3 m · S1500 2 m · paths 1.5 m · other 4 m",
      "Census TIGER road class (MTFCC): pavement plus shoulders, measured from the centreline. A point closer than this to a road is “on the road”.", "Area analysis; map-click check", "App", USED],
    ["RWEQ erodible fraction", "EF = (29.09 + 0.31 Sa + 0.17 Si + 0.33 Sa/Cl − 2.59 OM − 0.95 CaCO₃) / 100",
      "Sa, Si, Cl: sand, silt, clay (%); OM, CaCO₃ (%). EF: fraction of dry aggregates &lt; 0.84 mm. Fitted on soils with Sa 5.5–93.6, Si 0.5–69.5, Cl 5–39.3, Sa/Cl 1.2–53, OM 0.18–4.79, CaCO₃ 0–25.2.",
      "Soil tab, as an independent check on WEG", "Fryrear et al. 1994; Fryrear et al. 1998 (RWEQ)", CHECK],
    ["RWEQ soil crust factor", "SCF = 1 / (1 + 0.0066 Cl² + 0.021 OM²)", "Cl: clay (%); OM (%). Lower SCF = stronger crust, less erosion.",
      "Soil tab", "Fryrear et al. 1998 (RWEQ)", CHECK],
    ["Flat cover and erosion", "SLR = e<sup>−0.0438 · SC</sup>",
      "SC: % of soil surface covered; SLR: soil-loss ratio vs bare. The app uses the extension table: 10% cover → 35% less erosion, 30% → 70%, 50% → 85%, 70% → 93%.",
      "Practices tab cover targets (≥ 60% on WEG 1–2, ≥ 40% on WEG 3–4L, ≥ 30% otherwise)", "Fryrear 1985; NebGuide G1537", USED],
    ["Residue needed for a target loss", "residue = E-table ratio × (site E / table E)",
      "NAM Exhibit 502-1 ratios for I 86, C 100, wide field, scaled to the site's E. Approximate.", "Practices tab residue table", "NRCS NAM Exhibit 502-1", USED],
    ["Barrier and ridge spacing", "barrier spacing ≤ 10 H · windbreak protects 10 H leeward + 2 H windward · ridge spacing ≤ 4 × ridge height",
      "H: barrier height. Barriers ≥ 1.5 ft tall, 40–50% porous; trap strips ≥ 15 ft wide.", "Practices tab", "NRCS Texas standards 603, 380, 588, 589C", USED],
    ["RWEQ weather factor", "WF = Wf · (ρ / g) · SW · SD,&nbsp; Wf = Σ U₂ (U₂ − Uₜ)² · N<sub>d</sub> / N",
      "U₂: wind at 2 m (m/s); Uₜ = 5 m/s; ρ: air density; g = 9.81 m/s²; SW: soil wetness; SD: snow-free fraction; N<sub>d</sub>: days in period; N: observations.",
      "Not computed. The app's monthly risk index uses the same idea: wind energy above threshold × dryness.", "Fryrear et al. 1998 (RWEQ)", REF],
    ["RWEQ transport capacity and field length", "Q<sub>max</sub> = 109.8 (WF · EF · SCF · K′ · COG) · s = 150.71 (WF · EF · SCF · K′ · COG)<sup>−0.3711</sup> · Q(x) = Q<sub>max</sub> [1 − e<sup>−(x/s)²</sup>]",
      "Q: kg/m; s: critical field length (m); K′: roughness; COG: crop and residue factors; x: distance downwind (m).",
      "Not computed: needs field length, roughness and cover. NRCS designs fields with WEPS.", "Fryrear et al. 1998 (RWEQ)", REF],
  ];

  const WIND = [
    ["Erosive threshold", "uₜ = 8 m/s at 10 m", "≈ 13 mph at 1 ft ≈ 18 mph at 30 ft. Adjustable 5–12 m/s on the Wind tab.", "All erosive-wind metrics", "Lyles &amp; Krauss 1971; NAM Part 502", USED],
    ["Erosive hours", "N<sub>m</sub> = (n<sub>u ≥ uₜ</sub> / n) × 24 × days<sub>m</sub>", "n: hours with data in month m (normalizes station gaps).", "Overview, Wind tab", "App", USED],
    ["Erosive wind energy", "E<sub>m</sub> = Σ u² (u − uₜ), scaled to a full month", "u: hourly 10 m wind (m/s).", "Risk index, rose, prevailing direction", "After Bagnold 1941 (cubic transport); app", USED],
    ["Dryness", "D = clamp( (ET₀ − P) / ET₀, 0, 1 )", "P: precipitation; ET₀: grass reference ET (mm/month), gridMET.", "Risk index", "App, after FAO 1979", USED],
    ["Monthly risk index and red months", "R<sub>m</sub> = E<sub>m</sub> × D<sub>m</sub>,&nbsp; share<sub>m</sub> = R<sub>m</sub> / Σ R", "Red: share ≥ 10% (8.3% if even); amber ≥ 6.7%.", "Month strip, seasonal chart", "App convention", USED],
    ["Gust days", "daily max gust ≥ 17.9 m/s (40 mph)", "Blowing-dust days.", "Wind tab", "App", USED],
    ["Log-law height conversion", "u₂ = u<sub>z</sub> · 4.87 / ln(67.8 z − 5.42) → u₂ = 0.748 u₁₀", "z: measurement height (m).", "FAO climatic index", "Allen et al. 1998, FAO-56 Eq. 47", USED],
    ["FAO wind-erosion climatic index", "C<sub>FAO</sub> = (1/100) Σ<sub>months</sub> u₂³ · (ET₀ − P)/ET₀ · d", "u₂: mean monthly wind at 2 m (m/s); d: days. Months with P &gt; ET₀ count as 0.", "Wind tab", "FAO 1979", USED],
    ["Sand drift potential", "DP = Σ V² (V − Vₜ) / N,&nbsp; Vₜ = 12 kt", "V: hourly wind at 10 m (knots); N: all hours. RDP: length of the vector sum; RDD: its direction. DP &lt; 200 low, 200–399 intermediate, ≥ 400 high (VU).",
      "Wind tab", "Fryberger &amp; Dean 1979", USED],
    ["Prevailing erosive direction", "sector k with max 0.5 E<sub>k−1</sub> + E<sub>k</sub> + 0.5 E<sub>k+1</sub>", "16 sectors of 22.5°. Barrier and strip rows run at that direction + 90°.", "Wind tab, Practices", "App", USED],
    ["Resultant transport direction", "atan2( Σ E sin(θ + 180°), Σ E cos(θ + 180°) )", "θ: direction the wind blows from.", "Wind tab", "App", USED],
    ["Trend", "b = Σ(x − x̄)(y − ȳ) / Σ(x − x̄)²,&nbsp; t = b / SE(b)", "y: erosive hours per year; x: year. Significant if |t| &gt; t<sub>0.975, n−2</sub>.", "Wind tab", "Ordinary least squares", USED],
    ["Calibration to the airport (quantile mapping)", "u′ = F<sup>−1</sup><sub>obs, m</sub>( F<sub>model, m</sub>(u) )",
      "F: empirical distribution for calendar month m, 101 quantiles 0.1–99.9%, trained on the model at the station's cell vs the station, same hours; beyond the ends u′ = u · q<sub>obs</sub>/q<sub>model</sub>. Applied to the model at the site. Gusts mapped the same way.",
      "Wind tab default", "Panofsky &amp; Brier 1968; Themeßl et al. 2011", USED],
    ["Station hourly series and QC", "report nearest each whole hour (routine METAR, FM-15)", "Dropped: u &gt; 40 m/s, gust &gt; 55 m/s or below u, NCEI quality codes 2, 3, 6, 7.", "Calibration, station-only option", "App", USED],
    ["Model vs station statistics", "bias = mean(u<sub>model</sub> − u<sub>obs</sub>) · RMSE = √mean((u<sub>model</sub> − u<sub>obs</sub>)²) · Pearson r", "Same hours at the station.", "Comparison card", "Standard", USED],
    ["Grass reference ET₀ (computed by gridMET)", "ET₀ = [0.408 Δ (R<sub>n</sub> − G) + γ (900 / (T + 273)) u₂ (e<sub>s</sub> − e<sub>a</sub>)] / [Δ + γ (1 + 0.34 u₂)]",
      "ASCE standardized Penman–Monteith, daily, short grass: Δ slope of vapor-pressure curve, R<sub>n</sub> net radiation, G soil heat flux, γ psychrometric constant, e<sub>s</sub> − e<sub>a</sub> vapor-pressure deficit.",
      "Dryness factor, moisture chart", "ASCE-EWRI 2005; Abatzoglou 2013", USED],
    ["Grass reference ET₀ from NASA POWER (computed in the app)", "same Penman–Monteith form, daily: R<sub>n</sub> = 0.77 R<sub>s</sub> − R<sub>nl</sub>; e<sub>a</sub> from dew point; γ from elevation",
      "FAO-56 Eqs. 6–21 and 37–40 with POWER T<sub>max</sub>, T<sub>min</sub>, dew point, 2 m wind and all-sky solar radiation R<sub>s</sub> (MJ m⁻² d⁻¹). At Lubbock it runs 5% above gridMET (1,984 vs 1,886 mm/yr) with the same monthly pattern.",
      "When gridMET fails", "Allen et al. 1998 (FAO-56)", FALLBACK],
    ["Hargreaves ET₀", "ET₀ = 0.0023 (R<sub>a</sub> / 2.45)(T + 17.8) √(T<sub>max</sub> − T<sub>min</sub>)", "R<sub>a</sub>: extraterrestrial radiation, FAO-56 Eq. 21; T in °C.",
      "Only for NASA POWER days missing radiation, dew point or wind", "Hargreaves &amp; Samani 1985", FALLBACK],
  ];

  const SOIL = [
    ["Wilting point (Saxton &amp; Rawls)", "θ₁₅₀₀ₜ = −0.024S + 0.487C + 0.006OM + 0.005 S·OM − 0.013 C·OM + 0.068 S·C + 0.031;&nbsp; θ₁₅₀₀ = θ₁₅₀₀ₜ + (0.14 θ₁₅₀₀ₜ − 0.02)",
      "S, C: sand and clay fractions; OM: % (capped at 8).", "Edited surface layer", "Saxton &amp; Rawls 2006", USED],
    ["Field capacity", "θ₃₃ₜ = −0.251S + 0.195C + 0.011OM + 0.006 S·OM − 0.027 C·OM + 0.452 S·C + 0.299;&nbsp; θ₃₃ = θ₃₃ₜ + (1.283 θ₃₃ₜ² − 0.374 θ₃₃ₜ − 0.015)", "", "Edited surface layer", "Saxton &amp; Rawls 2006", USED],
    ["Saturation", "θ<sub>S−33t</sub> = 0.278S + 0.034C + 0.022OM − 0.018 S·OM − 0.027 C·OM − 0.584 S·C + 0.078;&nbsp; θ<sub>S−33</sub> = θ<sub>S−33t</sub> + (0.636 θ<sub>S−33t</sub> − 0.107);&nbsp; θ<sub>S</sub> = θ₃₃ + θ<sub>S−33</sub> − 0.097S + 0.043", "", "Edited surface layer", "Saxton &amp; Rawls 2006", USED],
    ["Bulk density", "ρ<sub>B</sub> = (1 − θ<sub>S</sub>) × 2.65", "g/cm³.", "Edited surface layer", "Saxton &amp; Rawls 2006", USED],
    ["Saturated conductivity", "B = (ln 1500 − ln 33) / (ln θ₃₃ − ln θ₁₅₀₀);&nbsp; K<sub>s</sub> = 1930 (θ<sub>S</sub> − θ₃₃)<sup>3 − 1/B</sup>", "K<sub>s</sub> in mm/h.", "Edited surface layer", "Saxton &amp; Rawls 2006", USED],
    ["Plant-available water", "AWC = DUL − LL", "cm³/cm³; shown as in/ft.", "Soil tab", "—", USED],
    ["Organic carbon; total N", "OC = OM / 1.724;&nbsp; N ≈ OC / 10, at most 0.5%", "%.", "Soil profile, .SOL export", "Van Bemmelen factor; DSSAT convention", USED],
    ["Saturation check", "SAT = <code>wsatiated_r</code>/100, else Saxton–Rawls, else 1 − ρ<sub>B</sub>/2.65;&nbsp; SAT ≥ DUL + 0.01", "", "Soil profile", "DSSAT convention", USED],
    ["Unit conversions", "K<sub>sat</sub> (cm/h) = µm/s × 0.36 · coarse fragments = 100 − % passing #10 sieve", "", "Soil profile", "—", USED],
    ["Root growth factor", "SRGF = 1 (layer ending ≤ 15 cm), else exp(−0.02 × mid-depth); 0 below a restrictive layer", "Depth in cm.", "Soil profile, .SOL export", "DSSAT convention", USED],
    ["Stage-1 evaporation limit", "U = min(9.9, 5 + 0.15 (clay + 2))", "U in mm; clay %.", ".SOL export", "Ritchie; DSSAT tools", USED],
    ["Drainage rate", "very poorly 0.01 · poorly 0.05 · somewhat poorly 0.25 · moderately well 0.40 · well 0.60 · somewhat excessively 0.75 · excessively 0.85", "Fraction per day.", ".SOL export", "DSSAT convention", USED],
    ["Runoff curve number", "A 61/64/68/71 · B 73/76/80/83 · C 81/84/88/91 · D 84/87/91/94", "By hydrologic group (second letter of dual groups) and slope 0–2, 2–5, 5–10, &gt; 10%.", ".SOL export", "NRCS NEH Part 630; DSSAT", USED],
    ["Slope and aspect from the DEM", "slope = 100 √(g<sub>x</sub>² + g<sub>y</sub>²),&nbsp; g<sub>x</sub> = (z<sub>E</sub> − z<sub>W</sub>) / 2Δx,&nbsp; aspect = atan2(−g<sub>x</sub>, −g<sub>y</sub>)", "Elevations 100 m N, S, E and W of the point.", "Header, soil profile", "Finite differences", USED],
  ];

  /* [number on screen, its scale, what it means]: so no value reads as a score out of 100. */
  function scaleRows() {
    const st = (window.WE_LAYERS && WE_LAYERS.stats) || {};
    const tx = st.E_pct_by_class, c = st.C_range;
    const pct = v => Math.round(v);
    return [
      ["<b>Bare-soil potential E</b> (risk card, area tool)", "0 and up, t/ac/yr: &lt; 10 Low · 10–40 Moderate · 40–80 High · 80–150 Very high · ≥ 150 Extreme",
        `Tons of soil per acre per year a wide, bare, smooth, unsheltered field could lose: E = I × C / 100. An amount, not a score. The classes are this app's, not NRCS's${tx ? `; across Texas, ${pct(tx[0])}% of the rated land is Low, ${pct(tx[1])}% Moderate, ${pct(tx[2])}% High, ${pct(tx[3])}% Very high and ${pct(tx[4])}% Extreme` : ""}.`],
      ["<b>Wind Erodibility Group</b> (WEG)", "1, 2, 3, 4, 4L, 5, 6, 7, 8",
        "NRCS groups surface soils by how easily they blow: 1 is the most erodible, 8 is not erodible. Groups 3, 4 and 4L share I = 86; 4L holds calcareous (limy) loamy soils. Texture guide in the table below."],
      ["<b>Wind erodibility index I</b>", "0–310 t/ac/yr",
        "Set by the WEG: the yearly loss from a wide, bare, smooth field in the climate of Garden City, Kansas (C = 100)."],
      ["<b>Climatic factor C</b>", `percent of Garden City, KS (= 100)${c ? `; Texas ${Math.round(c[0])}–${Math.round(c[1])}` : ""}`,
        "How strongly wind speed and dryness drive erosion: C = 34.483 v³ / PE². Higher is windier or drier."],
      ["<b>Tolerable soil loss T</b>", "1–5 t/ac/yr", "The most a soil can lose each year without losing productivity (SSURGO); deep soils are 5."],
      ["<b>Erodibility index EI</b> = C·I/T", "0 and up; 8 or more = highly erodible land", "The USDA wind criterion for highly erodible land (7 CFR 12.21), with C as a fraction."],
      ["<b>Erosive wind hours</b>", "0–8,760 h/yr", "Hours a year with 10 m wind at or above the erosive threshold (18 mph by default, adjustable on the Wind tab)."],
      ["<b>Month strip</b> (Overview)", "share of the year's risk: red ≥ 10%, amber ≥ 6.7%", "Erosive wind energy × dryness in each month, as a share of the year's total."],
      ["<b>Sand drift potential DP</b> (Wind tab)", "vector units: &lt; 200 low · 200–399 intermediate · ≥ 400 high", "Fryberger &amp; Dean 1979; RDP/DP below 0.3 multidirectional, 0.3–0.8 intermediate, above 0.8 one direction."],
    ];
  }
  const wegRows = () => WG.soil.WEG_INFO.map(w => [`<b>${w.g}</b>`, `<b>${esc(w.name)}</b>: ${esc(w.def)}`, w.I]);

  function table(cols, rows, cls) {
    return `<div class="mtable-wrap"><table class="mtable ${cls || ""}"><thead><tr>${cols.map(c => `<th>${c}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map((v, i) => `<td data-label="${esc(cols[i])}">${v}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  const eqRows = rows => rows.map(([q, eq, terms, use, src, st]) => [`<b>${q}</b> ${st}`, `<span class="eq">${eq}</span>`, terms, use, src]);
  const EQ_COLS = ["Quantity", "Equation", "Terms and units", "Used for", "Source"];

  function siteHTML() {
    const rows = WG.siteSources ? WG.siteSources() : [];
    if (!WG.state.site) return '<p class="fine">Tap a location on the map to see which source supplied each value there.</p>';
    if (!rows.length) return '<p class="fine">Still loading data for this location…</p>';
    return table(["Data", "Value used here", "Source"], rows, "site");
  }

  function render() {
    $("#methodsBody").innerHTML = `
      <p class="fine">“Direct” means the app downloads from the agency that produces the data. Every default source is direct. Open-Meteo is only a backup: for hourly wind when NASA POWER errors or has not answered within 20 s, for daily weather when gridMET and NASA POWER both fail, and for elevation when USGS fails. You can still pick <b>ECMWF (Open-Meteo copy)</b> under Model on the Wind tab; Copernicus's own data store needs each user's personal key and a queued job that takes minutes. At Lubbock, ECMWF tracks the airport hour by hour slightly better (r = 0.80 against 0.71 for MERRA-2), and after calibration both give 1,291–1,295 erosive h/yr, Feb–Apr, from the WSW.</p>
      <section id="m-site"><h4>This location</h4>${siteHTML()}</section>
      <section id="m-scales"><h4>Classes and scales</h4>${table(["Number on screen", "Scale", "What it means"], scaleRows(), "scales")}
        <h4>Wind Erodibility Groups</h4>${table(["WEG", "Texture guide", "I, t/ac/yr"], wegRows(), "weg")}
        <p class="fine">For a named soil, NRCS uses the group recorded in the soil survey; the texture guide is for soils that are not identified (${A("https://efotg.sc.egov.usda.gov/references/public/TX/Wind_Erosion.pdf", "National Agronomy Manual, Part 502")}). So a soil's group can differ from what its texture suggests: Pullman clay loam, for example, is WEG 7. The app shows the survey's group, and uses the guide only when you edit the surface layer. Texture guide: USDA-NRCS ${A("https://directives.nrcs.usda.gov/sites/default/files2/1725389517/Part%20618%20Subpart%20B%20%E2%80%93%20Exhibits.pdf", "National Soil Survey Handbook, Part 618 Subpart B")}, §618.93 (amended August 2024). Calcareous: strong or violent fizzing of the fine earth in cold dilute (1N) HCl. Rock fragments move a soil to a less erodible group, meaning the next lower I (86 → 56): one group at 15–35% by volume, two at 35–60%, I = 0 above 60% (sands and loamy sands move less).</p></section>
      <section id="m-sources"><h4>Data sources</h4>${table(["Data", "Producer", "How the app reads it", "Resolution · period", "If it fails"], SOURCES, "sources")}</section>
      <section id="m-erod"><h4>Erodibility equations</h4>${table(EQ_COLS, eqRows(EROD), "eqs")}</section>
      <section id="m-wind"><h4>Wind and climate equations</h4>${table(EQ_COLS, eqRows(WIND), "eqs")}</section>
      <section id="m-soil"><h4>Soil water and profile equations</h4>${table(EQ_COLS, eqRows(SOIL), "eqs")}</section>
      <p class="fine">Full derivations and references: docs/METHODS.md and docs/RESEARCH.md in the ${A("https://github.com/barsa1ly/windguard-tx", "project repository")}.</p>`;
  }

  function open(section) {
    render();
    $("#methodsSheet").hidden = false;
    $("#sheetBackdrop").hidden = false;
    const target = section && $("#" + section);
    setTimeout(() => { $("#methodsBody").scrollTop = target ? target.offsetTop : 0; }, 0); // after the sheet has laid out
    $$("#methodsNav button").forEach(b => b.classList.toggle("on", b.dataset.sec === (section || "m-site")));
  }
  function close() {
    $("#methodsSheet").hidden = true;
    $("#sheetBackdrop").hidden = true;
  }

  $("#methodsBtn").addEventListener("click", () => open());
  $("#methodsClose").addEventListener("click", close);
  $("#methodsNav").addEventListener("click", e => {
    const b = e.target.closest("button[data-sec]");
    if (!b) return;
    const t = $("#" + b.dataset.sec);
    $("#methodsBody").scrollTo({ top: t.offsetTop, behavior: "smooth" });
    $$("#methodsNav button").forEach(x => x.classList.toggle("on", x === b));
  });
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-methods]");
    if (b) { e.preventDefault(); open(b.dataset.methods); }
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#methodsSheet").hidden) close(); });

  return { open, close };
})();
