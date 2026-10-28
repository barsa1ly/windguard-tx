# Methods: formulas and data used by WindGuard TX

This file lists every calculation the app makes, with its source. `docs/RESEARCH.md` holds the practice-by-practice evidence behind the recommendations.

## 1. Bare-soil wind-erosion potential (Overview risk card, statewide map)

The app computes Wind Erosion Equation (WEQ) step E3 for a bare, smooth (K = 1), wide, unsheltered field:

**E = I × C / 100** (t/ac/yr)

- **I**, soil erodibility index, comes from SSURGO `component.weg` / `component.wei` (NSSH Part 618.95). When you edit the surface layer, the app reassigns the WEG with the NSSH texture rules (§2).
- **C**, climatic factor, is the official NRCS value from the SSURGO "Climate Factor" land-area overlap for the map unit. For example: Dawson 70, Lubbock 70, Potter 90, Gaines 80, Ward 130, El Paso 130, Harris 10.
  - The definition is C = 34.483 v³ / PE² (Chepil et al. 1962). v is the mean annual wind in mph at 30 ft. PE is the Thornthwaite P–E index, Σ 115 [P/(T−10)]^(10/9), with P in inches (minimum 0.5) and T in °F (minimum 28.4). Garden City, KS = 100.
- **Erodibility index** = C·I/T. T is the SSURGO tolerable soil loss. A value ≥ 8 meets the USDA highly-erodible-land wind criterion (7 CFR 12.21), with C applied as a fraction.

**Risk classes** (t/ac/yr):

| Low | Moderate | High | Very high | Extreme |
|---|---|---|---|---|
| < 10 | 10–40 | 40–80 | 80–150 | > 150 |

The class edges correspond to roughly 2, 8, 16 and 30 times T = 5. They are app conventions, not NRCS classes.

**Statewide map** (`tools/build_layers.py`): SoilWeb's 800 m WEI grid, which is derived from SSURGO, multiplied by the county NRCS C. The result is reprojected to Web Mercator at 1 km resolution and clipped to Texas.

## 2. Wind Erodibility Group from user-edited soil values

The texture class comes from the USDA triangle. The survey's sand-size modifier (e.g. FSL) is kept when the family is unchanged.

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
| 8 | Very stony or bouldery surface | 0 |

- "Calcareous" in the NSSH means strong or violent effervescence. The app uses CaCO₃ ≥ 5% as a proxy, because the NSSH gives no CaCO₃ threshold.
- Coarse fragments move the group toward less erodible: one group at 15–35%, two groups at 35–60%, and I = 0 above 60%. Sands and loamy sands move fewer groups.

## 3. Wind climatology at the point (Wind tab)

**Data:** hourly 10 m wind speed and direction, plus daily precipitation, FAO-56 ET₀ and daily max gust, from the Open-Meteo archive (`best_match`) for the last 5, 10 or 20 complete years, in local time.
- For wind, `best_match` is ECMWF IFS analysis at 9 km from 2017 on and ERA5 at 0.25° (~28 km) before 2017. I checked this against single-model requests; ERA5-Land does not supply wind here.
- Daily max wind is taken from the hourly series.
- A 10-year lookup costs about 180 Open-Meteo "calls" (130 at the site plus 52 at the station), against free limits of 600 per minute and 10,000 per day per IP.

**Calibration to the nearest airport station (default):**
- **Station data:** routine hourly METARs (2-minute mean wind at 10 m, plus gusts) from the Iowa Environmental Mesonet, for the same years.
- **Quality control:** sustained wind > 40 m/s or gust > 55 m/s is dropped. Hobbs, for example, has 250-kt garbled reports that otherwise dominate cubic energy sums.
- **Station choice:** the nearest station within 150 km with data from the start year and ≥ 60% of hours. NWS/FAA ASOS sites rank ahead of AWOS by a 100 km handicap, because in West Texas several AWOS anemometers (Seminole, Andrews, Snyder, Pecos) read 40–60% fewer erosive hours than nearby ASOS. You can pick another station in the Wind tab.
- **Method:** monthly empirical quantile mapping. It is trained on reanalysis at the station's grid cell versus the station on the same hours, using 101 quantiles between 0.1% and 99.9%, with end ratios beyond those. It is then applied to reanalysis at the site, so the model's site-vs-station difference is kept. Daily max gusts are mapped the same way against station daily max gusts. Direction and timing stay from the reanalysis.
- **Other sources you can select:** "Airport station only" (rain and ET₀ still from the reanalysis) and "Reanalysis only".
- **Check, Lubbock 2016–2025:** reanalysis vs LBB mean wind 4.41 vs 5.24 m/s, hourly r = 0.80, RMSE 1.85 m/s. Erosive hours (≥ 8 m/s) were 5.3% vs 15.1%.
  - Calibrated: 1,304 erosive h/yr vs the station's 1,321 (reanalysis 451).
  - High-risk months: Feb–May calibrated and station, Jan–Apr reanalysis.
  - Drift potential: 553 VU calibrated vs 153 VU reanalysis.

**Fallback:** NASA POWER daily data (MERRA-2, ~50 km), with Hargreaves ET₀ (Ra from FAO-56 Eq. 21).

**Erosive threshold:** 8 m/s at 10 m by default. This is the NRCS figure of 13 mph at 1 ft, or about 18 mph at 30 ft (Lyles & Krauss 1971; NAM Part 502). You can change it from 5 to 12 m/s.

**Monthly metrics:**
- Erosive hours: hours with u ≥ uₜ.
- Erosive energy: Σ u²(u − uₜ).
- Dryness: D = clamp((ET₀ − P)/ET₀, 0, 1).
- **Risk index** = energy × D. A month's **share** is its index divided by the annual total.
  - **Red** (high risk): share ≥ 10% (vs. 8.3% if spread evenly).
  - **Amber**: share ≥ 6.7%.
  - These cut-offs are an app convention.

**Gust days:** daily max gust ≥ 17.9 m/s (40 mph).

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

**Slope and aspect** also come from the Copernicus 90 m DEM: elevation at 5 points about 100 m apart, via the Open-Meteo elevation API.

## 5. Recommendations (Practices tab)

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
