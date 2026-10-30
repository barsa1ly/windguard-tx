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
| Mesonet towers (switched off) | West Texas Mesonet, Texas Tech: 10 m towers, relayed hourly by NWS Lubbock (SHEF) | Iowa Environmental Mesonet DCP archive (`hads.py`), one request per year, one at a time | hourly value at :00, whole mph, Dec 2010 on | the airport calibration stays |
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

The class edges correspond to roughly 2, 8, 16 and 30 times T = 5. They are app conventions, not NRCS classes. The risk card shows all five classes under the headline with the site's class lit, and says that E is an amount (t/ac/yr), not a score. The exact E is classed in every display unit; where rounding would carry a value across an edge it is shown with one more decimal (39.56 t/ac/yr reads 39.6, Moderate, not 40). In t/ha/yr the edges read 22.4, 90, 179.3 and 336.3: an edge label is a whole number unless rounding would lower it.

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

**Period:** the last 5, 10 or 20 complete calendar years, or your own dates. MERRA-2 runs from 2001 and ECMWF from 1979, both up to a few days ago (about 8 and 3 days). Your own dates need 30 days or more inside the chosen model's record, with 20 or more of them in one calendar month; dates partly outside the record are cut to it, with a message, and fewer than 30 days inside it are refused. A shared or typed link whose dates cannot be analysed says why and shows the last 10 years; dates that only the other model holds switch to it. A day runs midnight to midnight CST (UTC−6). Months are averaged by weight, so an uneven period does not tilt the year: a month needs 480 hours or more to count, yearly totals are shown only when all 12 months are covered, a calendar year counts as complete at 90% of its hours, and the trend needs 5 complete years. Calibration trains on at least 3 years around the period, inside the model's record (widened forward when the record starts too late). The page address keeps the period (`&from=YYYY-MM-DD&to=YYYY-MM-DD`, or `&period=5` or `20`) and, when the model is not MERRA-2, `&model=ecmwf`, so a shared link redoes the same analysis.

**If the chosen model fails,** the other one analyses the same dates when its record holds them. Otherwise a preset period is worked out again for it (and the airport looked up again), and custom dates are cut to its record; with fewer than 30 days left, or no month with 20 days, the first model's error is shown.

**Data:** for the chosen period:
- **Hourly 10 m wind speed and direction.** You choose the gridded model on the Wind tab, and each model is the other's automatic fallback: when the chosen source returns an error or has not started answering within 20 s (both normally answer in 1–3 s), the app switches; once data is arriving, a slow download is allowed up to 90 s.
  - **NASA MERRA-2 (default):** the NASA POWER hourly API, direct, UTC, at 0.5° × 0.625°. It has no gust variable.
  - **ECMWF (backup or option):** the Open-Meteo archive `best_match`, which is ECMWF IFS analysis at 9 km from 2017 on and ERA5 at 0.25° (~28 km) before 2017. ERA5-Land does not supply wind here. Daily max gust comes with it.
- **Daily precipitation, grass reference ET₀ (ASCE Penman–Monteith) and Tmax/Tmin:** gridMET over OPeNDAP, one 4 km cell. Scale factor, offset and fill value are read from the dataset attributes. The first fallback is NASA POWER daily (direct): precipitation, temperature, dew point, 2 m wind and all-sky solar radiation, from which the app computes FAO-56 Penman–Monteith ET₀ (Allen et al. 1998, Eqs. 6–21 and 37–40; albedo 0.23, G = 0; Hargreaves on days missing an input). The last fallback is Open-Meteo daily precipitation, FAO-56 ET₀ and mean temperature.
- **Daily max wind** comes from the hourly series.
- **Open-Meteo cost:** the default lookup makes no Open-Meteo calls. If you pick ECMWF, a 10-year lookup costs about 130 Open-Meteo "calls" (78 at the site plus 52 at the station), against free limits of 600 per minute and 10,000 per day per IP.

**Calibration to the nearest station (default):**
- **Station data:** routine hourly METARs (FM-15: 2-minute mean wind at 10 m, plus gusts) from NOAA NCEI GHCNh, one request per year. The report nearest each whole hour is kept, and NCEI quality codes 2, 3, 6 and 7 (suspect or erroneous) are dropped. Stations without a GHCNh id, or with GHCNh coverage below the threshold, use the Iowa Environmental Mesonet ASOS archive.
- **Quality control:** sustained wind > 40 m/s or gust > 55 m/s is dropped. Hobbs, for example, has 250-kt garbled reports that otherwise dominate cubic energy sums.
- **Station choice:** the nearest airport within 150 km with ≥ 60% of hours over its training window and over the period. NWS/FAA ASOS sites rank ahead of AWOS by a 100 km handicap, because in West Texas several AWOS anemometers (Seminole, Andrews, Snyder, Pecos) read 40–60% fewer erosive hours than nearby ASOS. You can pick another station in the Wind tab.
- **Method:** monthly empirical quantile mapping. It is trained on the same gridded model at the station's grid cell versus the station on the same hours, using 101 quantiles between 0.1% and 99.9%, with end ratios beyond those. It is then applied to reanalysis at the site, so the model's site-vs-station difference is kept. Daily max gusts are mapped the same way against station daily max gusts; with MERRA-2, which has no gusts, the model's daily max hourly wind is mapped onto station gusts. Direction and timing stay from the model.
- **Other sources you can select:** "Airport station only" (rain and ET₀ still from gridMET) and "Gridded model only".
- **Check, Lubbock 2016–2025:** reanalysis vs LBB mean wind 4.41 vs 5.24 m/s, hourly r = 0.80, RMSE 1.85 m/s. Erosive hours (≥ 8 m/s) were 5.3% vs 15.1%.
  - Calibrated: 1,304 erosive h/yr vs the station's 1,321 (reanalysis 451).
  - High-risk months: Feb–May calibrated and station, Jan–Apr reanalysis.
  - Drift potential: 553 VU calibrated vs 153 VU reanalysis.

With gridMET moisture, the Lubbock calibrated high-risk months are Feb–Apr. May falls just under the cutoff (9.3% of annual risk), because gridMET records more May rain (77 mm) than the ECMWF model did.

**West Texas Mesonet towers (switched off).** Built in, but off because the mesonet's data policy forbids public use without its permission. `ENABLE_WTM` in `js/wind.js` turns them on. For a local test, `?wtm=1` turns them on when the page is served from the same computer (localhost or a file); the public site ignores it. When on:
- **Data:** the hourly NWS SHEF reports (WFO Lubbock product RR5LUB) archived by the Iowa Environmental Mesonet, read with `hads.py`, one station-year per request, one request at a time (IEM refuses a `hads.py` request that starts within about a second of another from the same address; failed IEM requests, including the airport fallback, are retried twice). Speed is column `USIRZZ` (from October 2021 `USIRZZZ`) in whole mph, direction `UDIRZZ`/`UDIRZZZ`; values are stamped at :00 UTC. The feed has no gusts and no QC flags. Tower names and positions come from the NWS station list that IEM publishes; the mesonet's own site list only tells which stations are its towers.
- **Years:** the latest 5 complete years (one year takes about 11 s; the archive starts in December 2010). A tower therefore needs 5 complete years in the archive (132 of the 189 towers in 2026), and it can calibrate the 20-year period too.
- **QC:** speed 0–40 m/s; runs of 6+ hours at one non-zero speed (stuck sensor) and 3+ calm hours in a row (iced cups; the towers are calm 0.2–0.9% of hours) are dropped; ≥ 60% of hours, or 20% for a station you pick. Towers with too little data are passed over.
- **Ranking:** distance + 0 km for ASOS, + 20 km for a tower, + 100 km for AWOS. So a tower ranks ahead of an ASOS airport when it is more than 20 km closer, and ahead of an AWOS airport unless it is more than 80 km farther. The airport result appears first. When a tower ranks ahead of every airport, it loads alongside, and about a minute later its speed calibration replaces the airport's if it passes the exposure check. Daily gusts stay mapped to the airport; with no airport within 150 km, or none with a model series, they are n/a. "Airport station only" stays the airport, because a tower covers only 5 years.
- **Exposure check:** airports and towers should both stand on open ground. Over the tower's 5 years the app compares the tower with the airport it found, each relative to the model at its own cell: the ratio of hours ≥ 8 m/s and of mean wind. A tower with less than 0.85 times the airport's erosive hours is taken as sheltered and skipped, and so is a tower that cannot be compared (the airport has no model series, or too few shared hours). A tower is used without the check only when no airport was found. After a skip the app checks one more tower that still ranks ahead of the airport, then keeps the airport calibration. A station you pick yourself is used anyway, and the card shows its check. The check trusts the airport, so it is weaker when that airport is an AWOS. In the app, Plainview 1S (PVST2) against LBB, 2021–2025, gave 0.51 of the erosive hours and 0.79 of the mean wind and was skipped; Aiken (AIKT2) then gave 0.89 and 0.95 and was used.
- **Survey, 2024:** 16 towers within 60 km of an NWS (ASOS) airport, every fifth by longitude, against that airport, each relative to MERRA-2 at its own cell. Median ratio 0.93 for mean wind and 0.89 for erosive hours; 7 of 16 fall below 0.85. Four of the 16 (PTXT2, BDGT2, SHXT2, JLNN5) began after 2021, so the app cannot use them yet anyway.

  | Tower / airport | km | Mean wind | Hours ≥ 8 m/s | Passes the check |
  |---|---|---|---|---|
  | Fort Chadbourne (FCBT2) / DYS | 56 | 0.68 | 0.15 | no |
  | New Home (NEHT2) / LBB | 39 | 0.83 | 0.53 | no |
  | Memphis (MEST2) / CDS | 40 | 0.73 | 0.59 | no |
  | Amarillo 9NNE (AMNT2) / AMA | 16 | 0.83 | 0.72 | no |
  | Pantex 1ESE (PTXT2) / AMA | 18 | 0.91 | 0.75 | no |
  | Belding Williams Ranch (BDGT2) / FST | 14 | 0.90 | 0.75 | no |
  | Floydada (FLST2) / LBB | 59 | 0.93 | 0.76 | no |
  | Abernathy (ARST2) / LBB | 24 | 0.94 | 0.89 | yes |
  | Olton (ONST2) / LBB | 55 | 0.97 | 0.89 | yes |
  | Shallowater (SHXT2) / LBB | 16 | 0.95 | 0.94 | yes |
  | Jal Antelope Ridge (JLNN5) / HOB | 55 | 1.02 | 0.95 | yes |
  | Lomax (LOXT2) / MAF | 57 | 0.90 | 0.96 | yes |
  | Levelland (LDST2) / LBB | 52 | 0.99 | 1.07 | yes |
  | Friona (FAST2) / CVN | 44 | 1.01 | 1.17 | yes |
  | Goodlett (GDST2) / CDS | 33 | 1.01 | 1.18 | yes |
  | Turkey (TUST2) / CDS | 59 | 1.05 | 1.41 | yes |

- **Other checks:** the :00 value against a 2-minute METAR mean changes erosive hours by about 3% (LBB 1-minute data, March–April 2022). Raw ratios against airports (whole years, not relative to the model):

  | Tower / airport | Distance | Mean wind | Hours ≥ 8 m/s | Energy above 8 m/s | r |
  |---|---|---|---|---|---|
  | Reese Center (REST2) / LBB, 2020 | 21 km | 0.99 | 1.03 | 0.95 | 0.82 |
  | Reese Center (REST2) / LBB, 2025 | 21 km | 0.99 | 1.00 | 0.96 | 0.84 |
  | Childress (CXST2) / CDS, 2024 | 9 km | 1.07 | 1.13 | 0.82 | 0.85 |
  | Levelland (LDST2) / LLN (AWOS), 2024 | 3 km | 0.99 | 1.07 | 0.92 | 0.89 |
  | San Angelo 7NW (SJST2) / SJT, 2020 | 22 km | 0.83 | 0.35 | 0.23 | 0.71 |

  San Angelo shows that single sites can differ. The two Reese Center rows were re-checked independently with the app's own rules.

**Other wind networks checked (October 2026).** Requirement: hourly wind for years, readable by a web page (CORS) without a key, comparable with a 10 m airport anemometer, and allowed for public use.

| Network | Readable from a web page | Comparable | Not used because |
|---|---|---|---|
| West Texas Mesonet via IEM | yes | where the exposure check passes (above) | data policy: public use needs the mesonet's permission |
| West Texas Mesonet website, TexMesonet (TWDB) API and archive, MADIS | no (CORS) | — | other websites are refused; TWDB data start in 2016 |
| RAWS (USFS FEMS, IEM), NRCS SCAN | yes | no | 6.1 m (RAWS) and about 3 m (SCAN) sensors at sheltered sites read 20–50% low after height correction; hours ≥ 8 m/s 1–31% of the reference (2 RAWS, 3 SCAN sites) |
| USCRN | yes | no | wind at 1.5 m |
| NOAA CO-OPS, NDBC, coastal GHCNh | partly | no | over-water exposure; the coast has airports |
| Synoptic Data / MesoWest | yes | — | paid key |
| Oklahoma Mesonet, TexasET (AgriLife) | Oklahoma yes, TexasET no | — | licensed or paid; TexasET at 2 m |
| TCEQ CAMS, EPA AQS | no / key | — | one site-day per page, a personal key (AQS API) or national zip files (AirData); urban sites |
| LCRA Hydromet, NMSU ZiaMet | no (CORS) | — | — |

**Erosive threshold:** 8 m/s at 10 m by default. This is the NRCS figure of 13 mph at 1 ft, or about 18 mph at 30 ft (Lyles & Krauss 1971; NAM Part 502). You can change it from 5 to 12 m/s.

**Monthly metrics:**
- Erosive hours: hours with u ≥ uₜ.
- Erosive energy: Σ u²(u − uₜ).
- Dryness: D = clamp((ET₀ − P)/ET₀, 0, 1), with P and ET₀ from gridMET. If no moisture data loads, D = 1 and months rank by wind energy alone.
- **Risk index** = energy × D. A month's **share** is its index divided by the annual total.
  - **Red** (high risk): share ≥ 10% (vs. 8.3% if spread evenly).
  - **Amber**: share ≥ 6.7%.
  - These cut-offs are an app convention.
  - Red, amber and high-risk months are given only for a period covering all 12 months. With fewer, the shares are of the months covered, no month is ranked (they show gray), and Practices uses the typical Feb–May windy season, labelled as such.

**Gust days:** daily max gust ≥ 17.9 m/s (40 mph). Shown as n/a for uncalibrated MERRA-2, and for a tower calibration with no airport within 150 km.

**FAO climatic index:** (1/100) Σ u₂³ · D · days. u₂ = 0.748 u₁₀ (FAO-56 Eq. 47). Months with P > ET₀ are clamped to 0.

**Fryberger & Dean (1979) drift potential:** DP = Σ V²(V − 12)/N, with V in knots at 10 m over all hours N.
- RDP is the vector resultant of those terms in the downwind direction; RDD is its direction.
- DP classes: low < 200, intermediate 200–399, high ≥ 400 VU.
- RDP/DP: multidirectional < 0.3, intermediate < 0.8, unidirectional ≥ 0.8.

**Prevailing erosive wind** is the 22.5° sector carrying the most erosive energy Σu²(u − uₜ), smoothed with half weight on its neighbors. Barrier and strip orientation is that direction plus 90°. There is none when no hour reaches the threshold.

**Trend:** ordinary least-squares slope of erosive hours per year, with a two-sided t-test at 95%.

Airport anemometers sit on open, mown ground (mesonet towers should too; the exposure check tests it), so calibrated values describe exposed fields. Sheltered sites blow less.

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
| SLCF | coarse fragments > 2 mm, % by weight of the whole soil: `frag3to10_r` + `fraggt10_r` plus the gravel the No. 10 sieve holds back |
| SRGF | 1 for layers ending ≤ 15 cm, else exp(−0.02 × mid-depth); 0 below a restrictive layer |
| SLDR | By drainage class: very poorly and subaqueous 0.01, poorly 0.05, somewhat poorly 0.25, moderately well 0.40, well 0.60, somewhat excessively 0.75, excessively 0.85 |
| SLRO | Curve number by hydrologic group (the second letter of a dual group) and slope class (0–2, 2–5, 5–10, > 10%): A 61/64/68/71, B 73/76/80/83, C 81/84/88/91, D 84/87/91/94 |
| SLU1 | 4 mm for sand and loamy sand, 8 for clay, silty clay and sandy clay, 6 for the other classes (the HC27 generic soils of the DSSAT SoilGrids profiles, Han et al. 2019; CSM's default is 6) |
| SALB | SSURGO `albedodry_r` |

**Edited surface layer, and blanks in your own soil:** water retention, bulk density and Ksat come from Saxton & Rawls (2006), using sand and clay fractions and OM % capped at 8. The estimates are kept physical for any input: wilting point ≥ 0.01 cm³/cm³, field capacity ≥ wilting point + 0.01, saturation ≥ field capacity + 0.01, with bulk density (1 − θS) × 2.65 and Ksat from the bounded values; sand and clay that add up to more than 100 % are scaled to 100 %.

The Soil tab's DSSAT download and the data sheet use the same writer (§7).

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

## 7. Model files and downloads (data sheet)

The data sheet writes files for one location and a chosen date range. Every layout below was checked against the model's manual, its official example files and the reading code of its source (DSSAT-CSM 4.8.6 `IPWTH`/`IPSOIL`; SWAT+ rev 62 `cli_*`/`soil_db_read`; WXPM3020 and the EPIC/APEX user manuals; ApsimX `ApsimTextFile`, `Weather` and `Soil.Check`; AquaCrop 7.3 `LoadClim`/`LoadProfile`). A test runs every writer on 20 years of Lubbock weather and a SSURGO profile under each layering choice and passes all those checks. None of the files has been run in the models here. A model or table that cannot be made is replaced by a `NOT_WRITTEN.txt` giving the reason, and the rest of the zip is kept.

**Weather sources.** Dates outside the chosen source's record are left out, and the status line and README say so: gridMET runs from 1979 to its last day (about 2 days ago), NASA POWER from 1981 to about 8 days ago, and your file covers its own days unless gaps are filled from gridMET.
- gridMET (default): 9 variables from THREDDS for the chosen days. T = K − 273.15; Rs (MJ/m²/day) = W/m² × 0.0864; vapour pressure from specific humidity, ea = q p / (0.622 + 0.378 q), with p from elevation (FAO-56 Eq. 7); u₂ = 0.748 u₁₀; ET₀ is gridMET's grass reference.
- NASA POWER daily: ET₀ by FAO-56 Penman–Monteith (Hargreaves, Eq. 52, on days without radiation, dew point or wind).
- Your file: CSV, text or the first sheet of an Excel workbook (read as stored values: real dates, full precision, percentages as 0–100). The delimiter is the file's own (comma, semicolon or tab, with decimal commas where the comma is not the delimiter). Lines above the header row (NASA POWER, Open-Meteo, Campbell TOA5, PRISM, Daymet) are skipped. Units °C/°F, mm/in, MJ/W/langley/kWh, m/s/mph/km/h/kn; wind at any height is moved to 10 and 2 m with the log law (z₀ = 0.03 m). Blank or text cells and codes of −99 or below are missing, and "T" (trace) rain is 0. Vapour pressure comes from the dew point, else from RHmax and RHmin (FAO-56 Eq. 17), else from mean RH (Eq. 19); the dew point follows from it. Gaps can be filled from gridMET for the same days (not ET₀, which would not match your weather). ET₀ is the file's own grass-reference column where it has one (et0, ETo, ETos, reference ET; never ETr or alfalfa-reference, pan evaporation or PET; in the rain unit), else FAO-56 Penman–Monteith from its columns after any filling, with solar radiation from the temperature range (Eq. 50) on days without it and Hargreaves (Eq. 52) on days without humidity or wind. The zip's README counts the days of each.
  - *Columns* are found by name, tried on the name without units and notes in brackets. An exact name beats a pattern, and either beats a second choice: a column with a duration shorter than a day ("Rain_60min" gives way to "Rain"; a day's, as in "Precip 24 Hour Total", says nothing) or rain named an accumulation or "since" a time. Other measurements under the same words are never read: battery, panel, soil, surface, dew-point and wet-bulb temperatures; times of extremes; rain rates, hourly or weekly amounts and normals; net, longwave and clear-sky radiation; wind directions, gusts, maxima and runs. The data sheet and the README list which header each quantity was read from, so a wrong match can be seen.
  - *Dates* are chosen from the rows: a column of full dates first (YYYY-MM-DD, YYYYMMDD, also with a time run on as YYYYMMDDHHMM, or M/D/YYYY; D/M/YYYY when a first number in the column is above 12), else year, month and day, else year and day of the year, else any other column of full dates. "Day" holds the dates when "Time" holds clock times. A Campbell TOA5 daily record stamped at 00:00 holds the day before (2024-07-02 00:00:00 is 1 July). Impossible dates (30 February, month 13) are left out and noted.
  - *Notes* on how the file was read appear in the sheet and the README: the TOA5 shift, rows left out, repeated days (the last row of each is used), trace rain, and rain that only ever rises, which looks like a running total.

**Gaps.** DSSAT, APSIM and AquaCrop stop on a missing value, so their files get a gap-free copy. It runs from the first to the last day with both Tmax and Tmin; when that is shorter than the chosen dates, the status line and READMEs give the dates. Values no station reports are taken as missing first, in every model file and table: rain, radiation, humidity, vapour pressure or wind below 0, radiation above 50 MJ/m², a temperature outside −60…60 °C, and Tmax = Tmin = 0 (an empty row). Then Tmax, Tmin and wind are linear between neighbouring days and reach up to 3 days past the first or last value; a longer run of wind at either end takes that calendar month's mean over the days written (the overall mean if the month has no wind), counted separately in the README. A column is left out only when the weather has none of it. Solar radiation is 0.16 √(Tmax − Tmin) Ra (FAO-56 Eq. 50), rain 0, vapour pressure from the dew point or Tmin, and ET₀ FAO-56 from the other columns; a Tmax below Tmin is swapped. Each README counts the filled days. SWAT+ (−99), EPIC (999) and APEX (blank or 9999) get their missing-value codes and generate those days.

**TAV and AMP.** Monthly means of (Tmax + Tmin)/2 need 20 or more days each. DSSAT pools all years (TAV = mean of the 12 means, AMP = warmest minus coldest month, as CSM, WEATHER.CDE and the official headers use it). APSIM averages the same two numbers over complete calendar years (its `tav_amp`). When the chosen dates do not cover every month, the app reads the last 10 complete years from the same source (gridMET for your own file). If that read fails, TAV and AMP come from the months the dates have and are marked approximate in the file and its README.

**Weather-generator statistics.** EPIC/APEX `.WP1` follow WXPM3020 (wet day > 0 mm; they match its output for the official TX1136 example within 0.001). SWAT+ `weather-wgn.cli`: wet day ≥ 0.1 mm; the maximum half-hour rain is a third of each month's largest daily rain, averaged over the years in which the month is complete (no sub-daily data). Each group of statistics (temperature, rain, solar radiation, humidity, wind) comes from the chosen dates when every calendar month has 20 or more days of it, pooled over the years; else from the 10 complete years (read whenever the dates lack a month or a variable) when they have 20 or more; else from the chosen dates with 10 or more days in every month; else from the 10 years with 10 or more, the last two with a note naming the variable and months. Otherwise the model's files are not written (`NOT_WRITTEN.txt` says why), rather than written with zeros. Monthly rain totals and wet days are per whole month, from the days with data.

**Wind height.** DSSAT and APSIM: 2 m (DSSAT WIND in km/day); SWAT+: 1.7 m, u₁₀ × 0.17^0.2; EPIC/APEX: 10 m. EPIC/APEX `.WND` take the monthly speed and 16-direction frequencies from the app's hourly wind; months it does not cover use the daily 10 m wind, with directions spread evenly.

**File names.** APSIM and AquaCrop files are named from the coordinates to 0.001° (about 100 m), e.g. `WG33578N101855W`, so nearby sites do not overwrite each other; EPIC and APEX want 8.3 names, so theirs are W + 7 letters and digits packed from the same coordinates. The DSSAT station code is a letter, a digit and two letters or digits made the same way.

**CO₂ (APSIM).** NOAA GML Mauna Loa annual means 1979–2025, then +2.5 ppm a year (AquaCrop's assumption). Without a co2 column APSIM Next Gen assumes 350 ppm. DSSAT and AquaCrop read their own Mauna Loa files.

**Your soil file** (CSV or text) is read by name in the same way, with lab spellings (Upper/Lower depth, From/To, Sand total, SandPct, pH water, pHw, pH 1:1, pH (H2O), EC 1:1, ECe, Sat. paste EC, CaCO3 equivalent, CCE, CEC7, WP, FC, 15 bar, 1/3 bar, −1500 kPa, −33 kPa, and SSURGO's `sandtotal_r`, `wthirdbar_r` and the like). Not read: pH in CaCl₂, KCl or buffer, fine-sand fractions, base saturation, ECEC, fragments by weight, and `LL` unless a `DUL` column stands next to it (elsewhere it is the liquid limit). The unit in a header is converted (depth in mm, in, ft or m; g/kg; Ksat in cm/h, cm/d, mm/d, m/d, µm/s or in/h; EC in µS/cm or mS/m); water contents above 1 are read as percent, and sand and clay of at most 1 as fractions. Organic carbon gives organic matter × 1.724 when there is no organic matter column. Sand and clay that do not fit (below 0, or above 100 % together) are refused with the layer named. The sheet names the columns it did not use.

**Soil.** The survey component's horizons (or your table) in the common structure of `js/models.js`. Horizons count from the first with water retention and bulk density to the first without (bedrock or a cemented pan ends the profile).
- *Layers:* "each model's usual" splits the horizons at DSSAT's standard depths (5, 15, 30, 45, 60, 90, 120, 150, 180, 210 cm, at most 20 layers) and APSoil's 150, 150, 300 … mm layers; AquaCrop takes at most 5 horizons, APEX 10, EPIC 15, merging the thinnest neighbours. "The horizons as they are" writes them unchanged. "Custom depths" re-layers the profile: each layer value = Σ wᵢxᵢ / Σ wᵢ over the horizons it overlaps by wᵢ cm, and Ksat = Σ wᵢ / Σ (wᵢ/Kᵢ). Depths past a profile that simply stops repeat the deepest horizon; depths past bedrock are cut there. The root growth factor is recomputed for each layer.
- *DSSAT `WG.SOL`:* soil ID WG + the 8-digit component key for an unedited survey soil on DSSAT's usual layers; any other layering, an edited surface or your own soil gets WG + 8 letters and digits made from the written soil table, so a profile with other layers or values never takes an earlier profile's ID (DSSAT uses the first profile in WG.SOL with a matching ID); columns as in §4, values right-aligned in 6-character slots of at most 5 characters (SSKS with fewer decimals when large); a second tier with CaCO₃ (g/kg) on the same rows.
- *APSIM `.apsimx`:* version 168 JSON; LL15, DUL, SAT from the survey with SAT ≤ 1 − BD/2.65 − 0.001; AirDry = 0.5 × LL15 in the top layer; KS = Ksat × 24 mm/day; Carbon = OM/1.724; crop KL 0.06 to 0.01 with depth, XF 1 (0 below a restrictive layer); SWCON 0.3; initial water at DUL; NO₃ 1 ppm, NH₄ 0.1 ppm; summer from 1 April in the northern hemisphere.
- *AquaCrop `.SOL`:* SAT, FC, WP in vol %; Ksat mm/day; CN by hydrologic group A 46, B 61, C 72, D 77 (Table 2.14d, 5% initial abstraction); REW = round(10 (FC − WP/2) × 0.04), 0–15; CRa and CRb from the soil class (Tables 2.24s-3, 2.24s-5); gravel 0 because the survey's water contents are for the whole soil; penetrability 100%, or 0 below a restrictive layer.
- *EPIC/APEX `.SOL`:* moist albedo = 0.625 × dry; field capacity and wilting point on a fine-earth basis, θ / (1 − fragment volume); blank pH as 7.
- *SWAT+ `soils.sol` and QSWAT+ table:* horizons without a survey bulk density are left out and named in a note, as in the official SWAT+ soil database (not custom layers, which are your depths and always have a weighted bulk density); depths in mm, carbon = OM/1.72, rock = % by weight > 2 mm, albedo = dry albedo, USLE K = the survey's rock-free K, or for your own layers K = f_csand f_cl-si f_orgc f_hisand (Williams 1995, SWAT theory 4:1.1); texture up to the 16 characters SWAT+ reads.

**Figures and tables.** Charts are redrawn off screen at the chosen size: pixels = inches × DPI, fonts in points (1 pt = DPI/72 px). PNG gets a pHYs chunk, JPEG its JFIF density, and TIFF is written in the app (baseline RGB, PackBits, resolution tags in inches). CSV files carry a UTF-8 byte-order mark and the units in the headers. The annual wind summary marks partial years ("Complete year", and "Hours with data in the period" as a % of the year); the monthly summary writes "not ranked (part of a year)" for the months of a period that does not cover all 12 and "no data" for months without data, and heads its shares "% of the year" or "% of the months with data". The plain CSV has a README too, giving the ET₀ source and the layers. Each model folder's README gives the layers its soil file has (count, depths, bottoms).

**Units.** `js/units.js` holds one table of quantities, each with a base unit, choices, factors and decimals, plus metric, US and default presets. Display values convert from the base; classes stay defined in their source units (E and I in t/ac/yr, NRCS specifications in US units) and their edges are converted for display; model files ignore it and use each model's units.

## Known gaps

These items from `docs/RESEARCH.md` §11 are still unverified:
- Texas 585 strip widths by WEG.
- An SGe value for cotton stalks.
- Termination zone boundaries.
- Texas range-planting rate tables by MLRA.
- Current Railroad Commission restoration deadlines.

Final field designs are made by NRCS with WEPS.
