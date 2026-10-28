# Methods: formulas and data used by WindGuard TX

This file lists every calculation the app makes, with its source. `docs/RESEARCH.md` holds the practice-by-practice evidence behind the recommendations. The same tables are in the app's Methods sheet (page icon on the map).

## 0. Data sources

"Direct" means the app downloads from the agency that produces the data. Every default source is direct; Open-Meteo is only a backup (hourly wind after 20 s without an answer from NASA POWER, daily weather when gridMET and NASA POWER both fail, elevation when USGS fails) or the ECMWF option.

| Data | Producer | How the app reads it | Resolution · period | If it fails |
|---|---|---|---|---|
| Hourly 10 m wind (default) | NASA GMAO MERRA-2 | NASA POWER hourly API, direct | 0.5° × 0.625°, 2001 on | ECMWF via Open-Meteo, after 20 s without an answer |
| Hourly 10 m wind (backup or option) | ECMWF IFS analysis; ERA5 (Copernicus C3S) | Open-Meteo archive, a copy. ECMWF/CDS need a personal key and queued jobs, which a web page can't use. | 9 km (2017 on); 0.25° (before) | NASA MERRA-2 |
| Daily max gust | ECMWF IFS / ERA5 only | Open-Meteo, with ECMWF wind | as above | MERRA-2 has none; calibration maps daily max wind to station gusts |
| Airport observations | NWS/FAA ASOS/AWOS, archived in NOAA NCEI GHCNh (ISD stopped Aug 2025) | NCEI Access Data Service, direct; wind columns, one request per year | routine hourly METAR | Iowa Environmental Mesonet ASOS archive |
| Precipitation, grass ET₀, Tmax/Tmin | gridMET, University of Idaho (Abatzoglou 2013) | THREDDS OPeNDAP, direct; packing read from the file | 4 km daily, 1979 on | NASA POWER daily, direct, with FAO-56 Penman–Monteith ET₀ computed in the app; then ECMWF daily via Open-Meteo |
| Soil profile, WEG, I, T, MLRA, C | USDA-NRCS SSURGO | Soil Data Access, direct | 1:12k–1:24k map units | none |
| Elevation, slope, aspect | USGS 3DEP | Elevation Point Query Service, direct | 1–10 m | Copernicus GLO-90 via Open-Meteo |
| Land cover | USGS/MRLC NLCD 2021 | MRLC WMS, direct (MRLC currently refuses browser requests) | 30 m | Sentinel-2 10 m land cover, latest year (Impact Observatory, Microsoft, Esri) |
| Statewide maps | SSURGO via UC Davis SoilWeb; NRCS county C; NASA POWER climatology | pre-built (`tools/`) | 1 km | — |

**Checks, 2016–2025:**
- **NOAA GHCNh vs the Iowa Mesonet:** at Lubbock (LBB) the two give 1,322 and 1,321 erosive h/yr. At Hobbs (HOB) GHCNh covers 97% of hours against 68% for the Iowa Mesonet routine reports. On shared hours the erosive share agrees (10.9% vs 10.8%), but the missing Iowa Mesonet hours were mostly calm, so its annual total read high (959 vs 820 h/yr).
- **NASA MERRA-2 vs LBB:** hourly r = 0.71, RMSE 1.96 m/s, mean 4.94 vs 5.24 m/s, 8.7% vs 15.1% erosive hours. ECMWF: r = 0.80, RMSE 1.85 m/s, mean 4.41 m/s, 5.3%. After calibration both give the same months and direction: at Lubbock 1,295 h/yr with MERRA-2 and 1,291 with ECMWF (Feb–Apr, WSW); at a Gaines County test site 823 and 784 h/yr (Jan–Apr, WSW). MERRA-2 is the default because it comes straight from NASA.
- **NASA POWER Penman–Monteith ET₀ vs gridMET** (Lubbock, 2016–2025): 1,984 vs 1,886 mm/yr (+5%), same monthly pattern; rain 428 vs 447 mm/yr.

## 1. Bare-soil wind-erosion potential (Overview risk card, statewide map)

The app computes Wind Erosion Equation (WEQ) step E3 for a bare, smooth (K = 1), wide, unsheltered field:

**E = I × C / 100** (t/ac/yr)

- **I**, soil erodibility index, comes from SSURGO `component.weg` / `component.wei` (NSSH Part 618, §618.93). When an edit to the surface layer changes what the NSSH texture rules give, the app uses the rules' group (§2); otherwise it keeps the survey's.
- **C**, climatic factor, is the official NRCS value from the SSURGO "Climate Factor" land-area overlap for the map unit. For example: Dawson 70, Lubbock 70, Potter 90, Gaines 80, Ward 130, El Paso 130, Harris 10.
  - The definition is C = 34.483 v³ / PE² (Chepil et al. 1962). v is the mean annual wind in mph at 30 ft. PE is the Thornthwaite P–E index, Σ 115 [P/(T−10)]^(10/9), with P in inches (minimum 0.5) and T in °F (minimum 28.4). Garden City, KS = 100.
- **Erodibility index** = C·I/T. T is the SSURGO tolerable soil loss. A value ≥ 8 meets the USDA highly-erodible-land wind criterion (7 CFR 12.21), with C applied as a fraction.

**Risk classes** (t/ac/yr):

| Low | Moderate | High | Very high | Extreme |
|---|---|---|---|---|
| < 10 | 10–40 | 40–80 | 80–150 | ≥ 150 |

The class edges correspond to roughly 2, 8, 16 and 30 times T = 5. They are app conventions, not NRCS classes. The risk card shows all five classes under the headline with the site's class lit, and says that E is an amount (t/ac/yr), not a score.

**Scales of the other numbers on screen** (each is shown next to its value):

| Number | Scale | Meaning |
|---|---|---|
| Wind Erodibility Group (WEG) | 1, 2, 3, 4, 4L, 5, 6, 7, 8 | 1 is the most erodible, 8 is not erodible; 3, 4 and 4L share I = 86, and 4L holds calcareous (limy) loamy soils (§2) |
| Wind erodibility index I | 0–310 t/ac/yr | set by the WEG: the yearly loss from a wide, bare, smooth field in the climate of Garden City, KS |
| Climatic factor C | % of Garden City, KS (= 100); Texas counties 4–150 | higher is windier or drier |
| Tolerable soil loss T | 1–5 t/ac/yr | the most a soil can lose each year without losing productivity |
| Erodibility index EI | 0 and up; ≥ 8 is highly erodible land | C·I/T |
| Erosive wind hours | 0–8,760 h/yr | hours with 10 m wind at or above the threshold |

**Statewide map** (`tools/build_layers.py`): SoilWeb's 800 m WEI grid, which is derived from SSURGO, multiplied by the county NRCS C. The result is reprojected to Web Mercator at 1 km resolution and clipped to Texas.

## 2. Wind Erodibility Groups

**NRCS's texture guide to the groups** (National Soil Survey Handbook, Part 618 Subpart B, §618.93, amended August 2024). The Soil tab shows this table with the site's group marked; the Methods sheet shows it in full.

| WEG | Surface layer | I (t/ac/yr) |
|---|---|---|
| 1 | Very fine sand, fine sand, sand, coarse sand | 160 (coarse sand) to 310 (very fine sand); 220 on average |
| 2 | Loamy very fine sand, loamy fine sand, loamy sand, loamy coarse sand; very fine sandy loam and silt loam with ≤ 5% clay; sapric material (except Folists) | 134 |
| 3 | Very fine sandy loam (not WEG 2), fine sandy loam, sandy loam, coarse sandy loam; noncalcareous silt loam with 20 to < 50% very fine sand and 5 to < 12% clay | 86 |
| 4 | Clay, silty clay; noncalcareous clay loam and silty clay loam with > 35% clay; none with sesquic, parasesquic, ferritic, ferruginous or kaolinitic (iron-rich) mineralogy | 86 |
| 4L | Calcareous loam, silt loam, silt, sandy clay, sandy clay loam, clay loam, silty clay loam | 86 |
| 5 | Noncalcareous loam with < 20% clay; noncalcareous silt loam with 5 to < 20% clay (not WEG 3); noncalcareous sandy clay loam and sandy clay; hemic material | 56 |
| 6 | Noncalcareous loam and silt loam with ≥ 20% clay; noncalcareous clay loam and silty clay loam with ≤ 35% clay; iron-rich silt loam | 48 |
| 7 | Noncalcareous silt; iron-rich noncalcareous silty clay, silty clay loam and clay in Oxisols or Ultisols; fibric material | 38 |
| 8 | Not susceptible to wind erosion because of rock or pararock fragments at the surface and/or wetness; Folists | 0 |

For a named soil, NRCS uses the group recorded in the soil survey; the texture guide is for soils that are not identified (National Agronomy Manual, Part 502: "For most NRCS uses, the I value is assigned for named soils based on wind erodibility groups"). A soil's recorded group can differ from what its texture alone suggests. Pullman clay loam is WEG 7 in 40 of 45 Texas survey records, and Randall clay in playas is WEG 7 too, though by texture they would be 6 and 4. For a soil you have not edited, the app shows the survey's group. It labels a soil's group only by its number and I, never by a texture name; texture names appear only in the class table, as the guide.

**How the app assigns the group from edited values.** The app keeps the survey's group unless your values change what the texture rules below give, so a pH edit leaves Pullman clay loam in WEG 7. The texture class comes from the USDA triangle. The survey's sand-size modifier (e.g. FSL) is kept when the family is unchanged.

| WEG | Surface texture rule | I |
|---|---|---|
| 1 | VFS, FS, S, COS | 310 / 250 / 220 / 160 |
| 2 | Loamy sands; VFSL or SIL with ≤ 5% clay | 134 |
| 3 | Sandy loams; noncalcareous SIL with 20–50% very fine sand and 5–12% clay | 86 |
| 4 | C, SIC; noncalcareous CL/SICL > 35% clay | 86 |
| 4L | Calcareous L, SIL, SI, SC, SCL, CL, SICL | 86 |
| 5 | Noncalcareous L < 20% clay; SIL 5–20% clay; SCL; SC | 56 |
| 6 | Noncalcareous L/SIL ≥ 20% clay; CL/SICL ≤ 35% clay | 48 |
| 7 | Noncalcareous SI | 38 |
| 8 | Through the fragment rule: > 60% rock fragments by volume (not sands or loamy sands), or WEG 6 with ≥ 35% or WEG 7 with ≥ 15% (the next lower I after 48 and 38 is 0) | 0 |

- **RWEQ cross-checks** (Soil tab; Fryrear et al. 1994, 1998):
  - Erodible fraction: EF = (29.09 + 0.31 Sa + 0.17 Si + 0.33 Sa/Cl − 2.59 OM − 0.95 CaCO₃)/100, the fraction of dry aggregates < 0.84 mm.
  - Soil crust factor: SCF = 1/(1 + 0.0066 Cl² + 0.021 OM²).
  - All inputs are in %. Values are flagged when the soil is outside the fitted range: Sa 5.5–93.6, Si 0.5–69.5, Cl 5–39.3, Sa/Cl 1.2–53, OM 0.18–4.79, CaCO₃ 0–25.2.
  - The RWEQ weather factor and transport-capacity equations are listed in the Methods sheet for reference but not computed. They need field length, roughness and cover.
- "Calcareous" in the NSSH means strong or violent effervescence. The app uses CaCO₃ ≥ 5% as a proxy, because the NSSH gives no CaCO₃ threshold.
- Coarse fragments move the group toward less erodible: one group at 15–35% by volume, two groups at 35–60%, and I = 0 above 60%. Sands and loamy sands move fewer groups (none at 15–35%, one at 35–60%, three above 60%). One group means the next lower I (160 → 134, 86 → 56), so 3, 4 and 4L all move to 5.
  - The volume is SSURGO's `fragvoltot_r` when the survey gives it. Otherwise the app takes the whole-soil weight (`frag3to10_r` + `fraggt10_r` for cobbles and stones, plus 100 − % passing the No. 10 sieve for the rest of the soil) and converts it with the layer's bulk density and 2.65 g/cm³ for rock: 17% by weight is about 10% by volume.
  - A texture modifier sets a floor at the middle of its class: gravelly, cobbly, stony, bouldery, channery, flaggy or cherty 15–35%, "very" (e.g. STV) 35–60%, "extremely" (e.g. CBX) 60–90%.
- Not applied, because the survey's own group already covers them for an unedited soil: iron-rich mineralogy, andic material, wetness and Folists.

## 3. Wind climatology at the point (Wind tab)

**Data:** for the last 5, 10 or 20 complete years:
- **Hourly 10 m wind speed and direction.** You choose the gridded model on the Wind tab, and each model is the other's automatic fallback: when the chosen source returns an error or has not started answering within 20 s (both normally answer in 1–3 s), the app switches; once data is arriving, a slow download is allowed up to 90 s.
  - **NASA MERRA-2 (default):** the NASA POWER hourly API, direct, UTC, at 0.5° × 0.625°. It has no gust variable.
  - **ECMWF (backup or option):** the Open-Meteo archive `best_match`, which is ECMWF IFS analysis at 9 km from 2017 on and ERA5 at 0.25° (~28 km) before 2017. ERA5-Land does not supply wind here. Daily max gust comes with it.
- **Daily precipitation, grass reference ET₀ (ASCE Penman–Monteith) and Tmax/Tmin:** gridMET over OPeNDAP, one 4 km cell. Scale factor, offset and fill value are read from the dataset attributes. The first fallback is NASA POWER daily (direct): precipitation, temperature, dew point, 2 m wind and all-sky solar radiation, from which the app computes FAO-56 Penman–Monteith ET₀ (Allen et al. 1998, Eqs. 6–21 and 37–40; albedo 0.23, G = 0; Hargreaves on days missing an input). The last fallback is Open-Meteo daily precipitation, FAO-56 ET₀ and mean temperature.
- **Daily max wind** comes from the hourly series.
- **Open-Meteo cost:** the default lookup makes no Open-Meteo calls. If you pick ECMWF, a 10-year lookup costs about 130 Open-Meteo "calls" (78 at the site plus 52 at the station), against free limits of 600 per minute and 10,000 per day per IP.

**Calibration to the nearest airport station (default):**
- **Station data:** routine hourly METARs (FM-15: 2-minute mean wind at 10 m, plus gusts) from NOAA NCEI GHCNh, one request per year. The report nearest each whole hour is kept, and NCEI quality codes 2, 3, 6 and 7 (suspect or erroneous) are dropped. Stations without a GHCNh id, or with GHCNh coverage below the threshold, use the Iowa Environmental Mesonet ASOS archive.
- **Quality control:** sustained wind > 40 m/s or gust > 55 m/s is dropped. Hobbs, for example, has 250-kt garbled reports that otherwise dominate cubic energy sums.
- **Station choice:** the nearest station within 150 km with data from the start year and ≥ 60% of hours. NWS/FAA ASOS sites rank ahead of AWOS by a 100 km handicap, because in West Texas several AWOS anemometers (Seminole, Andrews, Snyder, Pecos) read 40–60% fewer erosive hours than nearby ASOS. You can pick another station in the Wind tab.
- **Method:** monthly empirical quantile mapping. It is trained on the same gridded model at the station's grid cell versus the station on the same hours, using 101 quantiles between 0.1% and 99.9%, with end ratios beyond those. It is then applied to reanalysis at the site, so the model's site-vs-station difference is kept. Daily max gusts are mapped the same way against station daily max gusts; with MERRA-2, which has no gusts, the model's daily max hourly wind is mapped onto station gusts. Direction and timing stay from the model.
- **Other sources you can select:** "Airport station only" (rain and ET₀ still from gridMET) and "Gridded model only".
- **Check, Lubbock 2016–2025:** reanalysis vs LBB mean wind 4.41 vs 5.24 m/s, hourly r = 0.80, RMSE 1.85 m/s. Erosive hours (≥ 8 m/s) were 5.3% vs 15.1%.
  - Calibrated: 1,304 erosive h/yr vs the station's 1,321 (reanalysis 451).
  - High-risk months: Feb–May calibrated and station, Jan–Apr reanalysis.
  - Drift potential: 553 VU calibrated vs 153 VU reanalysis.

With gridMET moisture, the Lubbock calibrated high-risk months are Feb–Apr. May falls just under the cutoff (9.3% of annual risk), because gridMET records more May rain (77 mm) than the ECMWF model did.

**Erosive threshold:** 8 m/s at 10 m by default. This is the NRCS figure of 13 mph at 1 ft, or about 18 mph at 30 ft (Lyles & Krauss 1971; NAM Part 502). You can change it from 5 to 12 m/s.

**Monthly metrics:**
- Erosive hours: hours with u ≥ uₜ.
- Erosive energy: Σ u²(u − uₜ).
- Dryness: D = clamp((ET₀ − P)/ET₀, 0, 1), with P and ET₀ from gridMET. If no moisture data loads, D = 1 and months rank by wind energy alone.
- **Risk index** = energy × D. A month's **share** is its index divided by the annual total.
  - **Red** (high risk): share ≥ 10% (vs. 8.3% if spread evenly).
  - **Amber**: share ≥ 6.7%.
  - These cut-offs are an app convention.

**Gust days:** daily max gust ≥ 17.9 m/s (40 mph). Shown as n/a for uncalibrated MERRA-2.

**FAO climatic index:** (1/100) Σ u₂³ · D · days. u₂ = 0.748 u₁₀ (FAO-56 Eq. 47). Months with P > ET₀ are clamped to 0.

**Fryberger & Dean (1979) drift potential:** DP = Σ V²(V − 12)/N, with V in knots at 10 m over all hours N.
- RDP is the vector resultant of those terms in the downwind direction; RDD is its direction.
- DP classes: low < 200, intermediate 200–399, high ≥ 400 VU.
- RDP/DP: multidirectional < 0.3, intermediate < 0.8, unidirectional ≥ 0.8.

**Prevailing erosive wind** is the 22.5° sector carrying the most erosive energy Σu²(u − uₜ), smoothed with half weight on its neighbors. Barrier and strip orientation is that direction plus 90°.

**Trend:** ordinary least-squares slope of erosive hours per year, with a two-sided t-test at 95%.

Airport anemometers sit on open, mown ground, so calibrated values describe exposed fields. Sheltered sites blow less.

## 4. Soil profile (Soil tab and exports)

**Source:** SSURGO via Soil Data Access.
- Tables: mapunit, legend, sacatalog, muaggatt, component, chorizon, chtexturegrp (RV), corestrictions, coecoclass, cocropyld, coeplants, muaoverlap/laoverlap (MLRA, C, R).
- The "dominant soil" is the largest component that has horizon data.

**Crop-model parameters** (DSSAT conventions; Romero et al. 2012; DSSAT CSM `SOILDYN.for`):

| Parameter | Rule |
|---|---|
| LL, DUL | `wfifteenbar_r`/100, `wthirdbar_r`/100 |
| SAT | `wsatiated_r`/100, else Saxton–Rawls θS, else 1 − BD/2.65; always ≥ DUL + 0.01 |
| SSKS (cm/h) | `ksat_r` (µm/s) × 0.36 |
| SLOC | OM/1.724 |
| SLNI | SLOC/10, capped at 0.5% |
| SLCF | 100 − `sieveno10_r` |
| SRGF | 1 for layers ending ≤ 15 cm, else exp(−0.02 × mid-depth); 0 below a restrictive layer |
| SLDR | By drainage class: very poorly 0.01, poorly 0.05, somewhat poorly 0.25, moderately well 0.40, well 0.60, somewhat excessively 0.75, excessively 0.85 |
| SLRO | Curve number by hydrologic group (the second letter of a dual group) and slope class (0–2, 2–5, 5–10, > 10%): A 61/64/68/71, B 73/76/80/83, C 81/84/88/91, D 84/87/91/94 |
| SLU1 | min(9.9, 5 + 0.15 × (surface clay + 2)) mm (rcropmod; DSSAT default 6) |
| SALB | SSURGO `albedodry_r` |

**Edited surface layer:** water retention, bulk density and Ksat come from Saxton & Rawls (2006), using sand and clay fractions and OM % capped at 8.

**Slope and aspect** come from USGS 3DEP (1–10 m lidar/DEM) through the Elevation Point Query Service: elevation at 5 points about 100 m apart. slope = 100·√(gx² + gy²), aspect = atan2(−gx, −gy). Fallback: Copernicus 90 m DEM via Open-Meteo.

## 5. Field or area analysis (area tool) and the map-click check

**Boundary:** drawn on the map (tap the corners; tap the first corner, double-click or Finish to close) or uploaded. Zipped shapefiles and loose .shp/.dbf/.prj files are read with shpjs, which reprojects using the .prj; KML and KMZ with togeojson (and JSZip for KMZ); GeoJSON directly. Everything is read in the browser. Every polygon in the file counts; lines and points are ignored. Limit 500 km² (123,550 ac). Area is the spherical polygon area (WGS84 radius).

**Soil polygons:** one Soil Data Access query clips the SSURGO map-unit polygons to the boundary (`mupolygongeo.STIntersection(boundary)`, with the boundary simplified to at most 600 vertices). Two more queries read each map unit's components (WEG, I, %) and its climatic-factor area (C).

**Left out** (when "Leave out buildings, roads and water" is ticked):
- **Buildings:** FEMA/ORNL USA Structures footprints.
- **Roads:** Census TIGER primary, secondary and local roads, as a band around the centreline. Half-widths by MTFCC class: S1100 15 m, S1200 9 m, S1400 5 m, S1630 6 m, S1640 4 m, S1730/S1740/S1750 3 m, S1500 2 m, paths 1.5 m, others 4 m.
- **Water:** USGS NHD water bodies of type lake/pond (390), reservoir (436), swamp/marsh (466) and estuary (493). Playas (361) stay in because most are farmed. Esri's copy of NHD is asked at the same time and used if NHD has not answered within 5 s. SSURGO map units named "Water" are always left out.
- Points outside the Texas outline or without soil data.

**Shares:** about 20,000 stratified random points (one per grid cell, seeded so the same area gives the same answer) are tested against the boundary, the left-out features and the soil polygons. Each kept point adds each component's percentage (÷ 100) to that component's WEG and to its risk class, with E = I × C / 100 using the map unit's C. Shares are of the open land in rated components; components without a WEG (rock outcrop, urban land, pits) are reported separately. Acres = share × analysed acres. The sampling error of a 20,000-point share is under ±0.7 percentage points.

**Checks:** a 157 ac field uploaded as GeoJSON, KML, KMZ, a zipped WGS84 shapefile, a zipped UTM 14N shapefile and loose UTM .shp/.dbf/.prj files gave 158 ac every time. A 2 km square on the edge of Shallowater: 826 ac, 77 ac of roads and 76 ac of buildings left out, 66% WEG 6. A 100 km² square in south Lubbock took 6 s.

**Map-click check:** before a clicked point (or a dragged pin) is analysed, the same three layers are read for a ~180 m box around it. If the point falls inside a building or water body, or within a road's half-width, it is refused with the reason. Typed coordinates, GPS and place search are not checked. If the services don't answer within 3.5 s the point is accepted.

## 6. Recommendations (Practices tab)

The rules are encoded in `js/practices.js` from `docs/RESEARCH.md`. Key thresholds:

- **Cover targets:** ≥ 60% surface cover on WEG 1–2, ≥ 40% on WEG 3–4L, ≥ 30% otherwise.
- **Flat-cover erosion reduction:** 10% → 35%, 30% → 70%, 50% → 85%, 70% → 93% (NebGuide G1537).
- **Residue table:** NAM Exhibit 502-1 E-table ratios (I 86, C 100, wide field), scaled to the site's E. This is approximate.
- **Cover crops:** 30 lb/ac rye or wheat on dryland; terminate 6–8 weeks before cotton (dryland) or 2–4 weeks (irrigated). Source: AgriLife Lamesa/Lubbock trials.
- **Barriers:** ≥ 1.5 ft tall, 40–50% porous, ≤ 10H apart (TX 603). Trap strips ≥ 15 ft wide (589C). Ridges ≤ 4× height apart (588). Windbreak protects 10H leeward and 2H windward (TX 380).
- **Grazing:** 25% harvest efficiency (≤ 33% in lesser prairie-chicken range). Drought checkpoints Apr 1, Jun 15, Jul 15, Aug 15, Nov 1 (TX 528).
- **Seeding:** Feb 1/15–May 15, or the monsoon in the Trans-Pecos. Drill rows ≤ 12 in, ¼–½ in deep. Defer grazing ≥ 1 growing season (TX 550). TxDOT 2024 Item 164 district mixes; University Lands Permian mix.
- **Shinnery and sand sagebrush:** tebuthiuron about 0.3 lb a.i./ac; treat ≤ 50% of the property per 2 years; 150-ft dune buffer; defer grazing 2 years (WAFWA).

## Known gaps

These items from `docs/RESEARCH.md` §11 are still unverified:
- Texas 585 strip widths by WEG.
- An SGe value for cotton stalks.
- Termination zone boundaries.
- Texas range-planting rate tables by MLRA.
- Current Railroad Commission restoration deadlines.

Final field designs are made by NRCS with WEPS.
