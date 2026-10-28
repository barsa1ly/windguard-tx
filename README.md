# WindGuard TX

Mobile-friendly web app that shows where Texas is most prone to wind erosion and builds a site-specific control plan for any point you pick.

Tap the map, search a place, use GPS, or type coordinates. The app then pulls the soil survey, 10 years of hourly wind and the land cover for that point. It shows the risk, the wind-prone months, the full soil profile, and practices matched to the land use you choose.

## Run it

It is a static site with no build step and no API keys. Serve the folder with any web server:

```bash
python -m http.server 8765
```

Then open <http://localhost:8765>. Opening `index.html` straight from disk also works in most browsers, but a server is more reliable. To link straight to a location, use `?lat=32.74&lon=-101.95`.

To put it on a phone, host the folder on any static host (GitHub Pages, Netlify, S3), open it on the phone, and choose "Add to Home Screen". Wrapping it as a store app later (Capacitor/Cordova) needs no code changes.

## What it shows

| Tab | Content |
|---|---|
| Map | Satellite imagery (Esri), with switchable USGS imagery+topo, OpenStreetMap streets and USGS topo bases. Overlays: place, river and county names; roads and street names; NHD rivers and streams; county lines; statewide susceptibility, soil Wind Erodibility Group and climatic factor C; NLCD 2021 land cover; SSURGO map-unit lines at zoom 13+. |
| Overview | Bare-soil risk (WEQ E = I × C/100), erodibility index C·I/T, mean wind, erosive-wind hours, prevailing erosive direction, WEG, NRCS C, land cover, and a 12-month risk strip (red = high-risk months). |
| Wind | Seasonal erosive-wind hours (red/amber/gray by risk), wind and gust climatology, gust days, erosive wind rose with the resultant soil-transport direction, precipitation vs ET₀, year-to-year trend with significance test, and indices (Fryberger drift potential, FAO climatic index, barrier orientation). You can change the period (5/10/20 yr), units and erosive threshold. |
| Soil | Dominant SSURGO component and map unit, and an editable surface layer (sand, silt, clay, OM, CaCO₃, pH) that recalculates texture class, WEG and I, and water properties (Saxton & Rawls 2006). The **+** expander opens the full profile: horizons with texture, bulk density, LL/DUL/SAT, AWC, Ksat, pH, CEC, CaCO₃, gypsum, EC, SAR, coarse fragments, root growth factor, estimated N; plus classification, slope (survey and 90 m DEM), restrictive layer, drainage rate, runoff curve number, albedo, evaporation limit, T and Kw factors, capability class, components, crop yields and the reference plant community. Exports to CSV and to a crop-model `.SOL` file. |
| Practices | Pick a land use (cropland, rangeland, shrubland, pasture/hay, CRP/go-back, disturbed land, bare sand) and answer 2–5 quick questions. You get a prioritized plan with NRCS practice codes, quantitative specs, a timing calendar against the local windy months, cover-crop and native-species tables for the region and soil group, and site notes. |

## Data sources (all open, no keys)

- **Soils:** USDA-NRCS SSURGO via Soil Data Access (`SDMDataAccess.sc.egov.usda.gov`), including the official WEQ climatic factor C from the SSURGO climate-factor areas. The statewide 800 m WEG/WEI grids come from UC Davis SoilWeb, which derives them from SSURGO.
- **Wind and moisture:** ERA5/ERA5-Land hourly reanalysis via the Open-Meteo Historical Weather API. NASA POWER (MERRA-2) daily data is the automatic fallback.
- **Land cover:** NLCD 2021 (MRLC WMS).
- **Elevation and slope:** Copernicus 90 m DEM via the Open-Meteo elevation API.
- **Geocoding:** OpenStreetMap Nominatim.
- **Basemaps:** Esri World Imagery and reference layers, USGS The National Map, OpenStreetMap.

## Rebuilding the statewide layers

`tools/` contains the scripts that produced `data/` (Python 3.11 with numpy, rasterio, shapely, pyproj, scipy, Pillow, requests):

```bash
python tools/fetch_power_grid.py
python tools/fetch_county_c.py
python tools/build_layers.py
```

The raw downloads (SoilWeb rasters, Census boundaries) go in `tools/raw/`. The URLs are listed in the script docstrings.

## Method notes and limits

- The bare-soil potential is WEQ E3 with K = 1: a bare, smooth, wide, unsheltered field. It ranks inherent susceptibility. It does not predict actual loss under current management.
- Reanalysis winds are averaged over a roughly 9–25 km cell and run lower than station anemometers. Erosive-hour counts and drift potential are therefore conservative, but the seasonal pattern and directions are reliable.
- "High-risk" months are those with at least 10% of the year's erosive wind energy (Σu²(u−uₜ) above the threshold) weighted by dryness (1 − P/ET₀).
- The recommendations are planning guidance drawn from NRCS standards and Texas research. `docs/RESEARCH.md` holds the full evidence report, and `docs/METHODS.md` lists every formula and threshold the app uses. Confirm designs and seeding rates with the local NRCS field office.
- A 10-year wind request counts as about 180 Open-Meteo calls against the free limit of 10,000 per day per IP, which is roughly 50 new locations a day. For heavier use, get an Open-Meteo API key or cache results server-side.
