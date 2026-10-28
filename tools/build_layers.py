"""Build statewide Texas map overlays for the app (run once; outputs go to ../data).

Inputs (tools/raw):
  wei.tif, weg_int.tif  - UC Davis SoilWeb 800 m CONUS grids derived from SSURGO
  power_grid.json       - NASA POWER monthly climatology 2001-2025 (fetch_power_grid.py)
  us_states_5m.json     - US Census 2010 state boundaries (5m generalization)

Outputs (data/):
  layer_susceptibility.png  WEQ bare-field potential  E = I * C/100  (t/ac/yr)
  layer_soil_weg.png        Wind Erodibility Group (SSURGO)
  layer_climate_c.png       Chepil wind-erosion climatic factor C (% of Garden City, KS)
  layers.js                 bounds + legends + C grid for click-time lookup
"""
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.features import geometry_mask, rasterize
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from scipy.interpolate import RegularGridInterpolator
from shapely.geometry import Point, mapping, shape
from shapely.ops import transform as shp_transform

HERE = Path(__file__).parent
RAW = HERE / "raw"
OUT = HERE.parent / "data"
OUT.mkdir(exist_ok=True)

RES = 1000.0  # metres, EPSG:3857
MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

to_merc = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
to_ll = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)


def texas_geometry():
    d = json.loads((RAW / "us_states_5m.json").read_text(encoding="latin-1"))
    tx = next(f for f in d["features"] if f["properties"]["NAME"] == "Texas")
    return shape(tx["geometry"])


def texas_counties():
    cc = json.loads((RAW / "county_c.json").read_text())
    d = json.loads((RAW / "us_counties_5m.json").read_text(encoding="latin-1"))
    out = []
    for f in d["features"]:
        p = f["properties"]
        if p["STATE"] != "48":
            continue
        fips = "48" + p["COUNTY"]
        out.append({"fips": fips, "name": p["NAME"], "geom": shape(f["geometry"]),
                    "C": (cc.get(fips) or {}).get("C")})
    return out


def chepil_c(rec):
    """Chepil et al. (1962) climatic factor, % of Garden City KS.

    C = 34.483 v^3 / PE^2, v = mean annual wind (mph) at 30 ft,
    PE = Thornthwaite precipitation-effectiveness index
       = sum_i 115 * (P_i / (T_i - 10))^(10/9), P inches/month, T deg F (T >= 28.4).
    """
    pe = 0.0
    for m, d in zip(MONTHS, DAYS):
        p_in = rec["PRECTOTCORR"][m] * d / 25.4
        t_f = max(rec["T2M"][m] * 9 / 5 + 32, 28.4)
        pe += 115 * (max(p_in, 0.5) / (t_f - 10)) ** (10 / 9)  # NAM: P floor 0.5 in
    pe = max(pe, 1.0)
    # 10 m -> 30 ft (9.14 m) with log profile, z0 = 3 cm
    v_mph = rec["WS10M"]["ANN"] * 2.23694 * math.log(9.144 / 0.03) / math.log(10 / 0.03)
    return 34.483 * v_mph ** 3 / pe ** 2, pe, v_mph


def climate_grid():
    g = json.loads((RAW / "power_grid.json").read_text())
    # TOA_SW_DWN comes on a coarser 1-degree grid; keep only full MERRA-2 records
    g = {k: v for k, v in g.items() if all(p in v for p in ("WS10M", "PRECTOTCORR", "T2M", "WD10M"))}
    lats = sorted({float(k.split(",")[0]) for k in g})
    lons = sorted({float(k.split(",")[1]) for k in g})
    C = np.full((len(lats), len(lons)), np.nan)
    WS = np.full_like(C, np.nan)
    pts = []
    for k, rec in g.items():
        la, lo = map(float, k.split(","))
        i, j = lats.index(la), lons.index(lo)
        c, pe, v = chepil_c(rec)
        C[i, j] = c
        WS[i, j] = rec["WS10M"]["ANN"]
        pts.append({"lat": la, "lon": lo, "C": round(c, 1), "PE": round(pe, 1),
                    "ws10": rec["WS10M"]["ANN"],
                    "ws10m": [rec["WS10M"][m] for m in MONTHS],
                    "wd10": rec["WD10M"]["ANN"],
                    "p": [round(rec["PRECTOTCORR"][m] * d, 1) for m, d in zip(MONTHS, DAYS)],
                    "t": [rec["T2M"][m] for m in MONTHS]})
    return np.array(lats), np.array(lons), C, WS, pts


def to_png(rgba, path):
    Image.fromarray(rgba, "RGBA").save(path, optimize=True)
    print("wrote", path.name, path.stat().st_size // 1024, "KB")


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def classify(arr, breaks, colors, valid):
    """breaks: upper bounds (len n-1) for n colors."""
    rgba = np.zeros(arr.shape + (4,), np.uint8)
    idx = np.digitize(arr, breaks)
    for k, col in enumerate(colors):
        m = valid & (idx == k)
        rgba[m, :3] = hex_rgb(col)
        rgba[m, 3] = 255
    return rgba


def ramp(arr, vmin, vmax, stops, valid, steps=24):
    """Stepped continuous ramp (keeps PNG small, reads as smooth)."""
    t = np.clip((arr - vmin) / (vmax - vmin), 0, 1)
    t = np.floor(t * (steps - 1) + 0.5) / (steps - 1)
    cols = np.array([hex_rgb(s) for s in stops], float)
    pos = np.linspace(0, 1, len(stops))
    rgba = np.zeros(arr.shape + (4,), np.uint8)
    for ch in range(3):
        rgba[..., ch] = np.interp(t, pos, cols[:, ch]).astype(np.uint8)
    rgba[..., 3] = np.where(valid, 255, 0)
    return rgba


def main():
    tx = texas_geometry()
    tx_m = shp_transform(lambda x, y, z=None: to_merc.transform(x, y), tx)
    minx, miny, maxx, maxy = tx_m.bounds
    minx, miny = math.floor(minx / RES) * RES - RES, math.floor(miny / RES) * RES - RES
    maxx, maxy = math.ceil(maxx / RES) * RES + RES, math.ceil(maxy / RES) * RES + RES
    W, H = int((maxx - minx) / RES), int((maxy - miny) / RES)
    dst_tf = from_origin(minx, maxy, RES, RES)
    print("grid", W, H)

    inside = geometry_mask([mapping(tx_m)], (H, W), dst_tf, invert=True)

    def warp(path, resampling, dtype):
        with rasterio.open(path) as src:
            out = np.full((H, W), src.nodata if src.nodata is not None else 0, dtype)
            reproject(rasterio.band(src, 1), out, dst_transform=dst_tf, dst_crs="EPSG:3857",
                      resampling=resampling, dst_nodata=src.nodata)
            return out, src.nodata

    wei, wei_nd = warp(RAW / "wei.tif", Resampling.nearest, np.float32)
    weg, _ = warp(RAW / "weg_int.tif", Resampling.nearest, np.uint8)
    wei_ok = inside & (wei != wei_nd) & np.isfinite(wei) & (wei >= 0)

    # climate factor on the same grid: official NRCS county C (SSURGO overlaps),
    # NASA POWER-derived Chepil C only where a county value is missing
    lats, lons, Cg, WSg, pts = climate_grid()
    Cg = np.where(np.isnan(Cg), np.nanmean(Cg), Cg)
    interp = RegularGridInterpolator((lats, lons), Cg, bounds_error=False, fill_value=None)
    xs = minx + (np.arange(W) + 0.5) * RES
    ys = maxy - (np.arange(H) + 0.5) * RES
    XX, YY = np.meshgrid(xs, ys)
    LON, LAT = to_ll.transform(XX, YY)
    C_power = interp(np.stack([LAT.ravel(), LON.ravel()], -1)).reshape(H, W)
    counties = texas_counties()
    shapes = [(mapping(shp_transform(lambda x, y, z=None: to_merc.transform(x, y), c["geom"])), c["C"])
              for c in counties if c["C"] is not None]
    C = rasterize(shapes, out_shape=(H, W), transform=dst_tf, fill=-1, dtype="float32")
    C = np.where(C < 0, C_power, C)

    # spring (Feb-May) mean 10 m wind speed, mph, interpolated from the POWER grid
    g = json.loads((RAW / "power_grid.json").read_text())
    g = {k: v for k, v in g.items() if "WS10M" in v and "WD10M" in v}
    SPR = ["FEB", "MAR", "APR", "MAY"]
    Wg = np.full((len(lats), len(lons)), np.nan)
    arrows = []
    for k, rec in g.items():
        la, lo = map(float, k.split(","))
        if la not in lats or lo not in lons:
            continue
        ws = float(np.mean([rec["WS10M"][m] for m in SPR])) * 2.23694
        Wg[list(lats).index(la), list(lons).index(lo)] = ws
        # vector-mean spring direction (wind FROM), weighted by speed
        u = sum(-rec["WS10M"][m] * math.sin(math.radians(rec["WD10M"][m])) for m in SPR)
        v = sum(-rec["WS10M"][m] * math.cos(math.radians(rec["WD10M"][m])) for m in SPR)
        dir_from = (math.degrees(math.atan2(-u, -v)) + 360) % 360
        if tx.buffer(0.3).contains(Point(lo, la)):
            arrows.append([la, lo, round(dir_from), round(ws, 1)])
    Wg = np.where(np.isnan(Wg), np.nanmean(Wg), Wg)
    w_interp = RegularGridInterpolator((lats, lons), Wg, bounds_error=False, fill_value=None)
    WS = w_interp(np.stack([LAT.ravel(), LON.ravel()], -1)).reshape(H, W)

    E = wei * C / 100.0  # t/ac/yr, bare smooth unsheltered field (WEQ E3 with K=1)

    # --- susceptibility classes (multiples of T = 5 t/ac/yr: EI = C*I/T) ---
    sus_breaks = [10, 40, 80, 150]
    sus_colors = ["#2f8f5b", "#a3c45a", "#f2c84b", "#e8772e", "#b3261e"]
    to_png(classify(E, sus_breaks, sus_colors, wei_ok), OUT / "layer_susceptibility.png")

    # --- WEG classes (weg_int: 1..9 = 1,2,3,4,4L,5,6,7,8) ---
    weg_colors = ["#7f1d1d", "#c2410c", "#ea8a2e", "#e7b549", "#d9c46a", "#9cbf6b", "#5fa36a", "#2e7d5b", "#64748b"]
    weg_ok = inside & (weg >= 1) & (weg <= 9)
    to_png(classify(weg.astype(float), [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5], weg_colors, weg_ok),
           OUT / "layer_soil_weg.png")

    # --- climatic factor classes ---
    c_breaks = [20, 40, 60, 80, 100, 120]
    c_colors = ["#f4efe1", "#f1dc9c", "#ecbd68", "#e3934a", "#cf6334", "#a83a26", "#6f1d1b"]
    to_png(classify(C, c_breaks, c_colors, inside), OUT / "layer_climate_c.png")

    # --- spring wind speed classes ---
    w_breaks = [9, 10, 11, 12, 13, 14]
    w_colors = ["#e8f1f2", "#c6dde3", "#93c0cf", "#5f9cba", "#3b76a3", "#2b4f86", "#23306a"]
    to_png(classify(WS, w_breaks, w_colors, inside), OUT / "layer_wind_spring.png")

    # bounds in lat/lon of the mercator image corners
    lon0, lat0 = to_ll.transform(minx, miny)
    lon1, lat1 = to_ll.transform(maxx, maxy)
    bounds = [[round(lat0, 6), round(lon0, 6)], [round(lat1, 6), round(lon1, 6)]]

    # simplified Texas outline for drawing
    tx_s = tx.simplify(0.01, preserve_topology=True)

    stats = {
        "E_pct_by_class": [round(float(((np.digitize(E, sus_breaks) == k) & wei_ok).sum() / wei_ok.sum() * 100), 1)
                           for k in range(5)],
        "C_range": [round(float(np.nanmin(C[inside])), 1), round(float(np.nanmax(C[inside])), 1)],
    }
    print(stats)

    meta = {
        "bounds": bounds,
        "layers": {
            "susceptibility": {
                "file": "data/layer_susceptibility.png",
                "title": "Wind erosion susceptibility (bare-soil potential)",
                "unit": "t/ac/yr",
                "legend": [{"label": "< 10  Low", "color": sus_colors[0]},
                           {"label": "10–40  Moderate", "color": sus_colors[1]},
                           {"label": "40–80  High", "color": sus_colors[2]},
                           {"label": "80–150  Very high", "color": sus_colors[3]},
                           {"label": "> 150  Extreme", "color": sus_colors[4]}],
                "note": "Potential annual loss from a bare, smooth, wide, unsheltered field: E = I × C/100 "
                        "(SSURGO Wind Erodibility Index × Chepil climatic factor). 40 t/ac/yr ≈ Erodibility "
                        "Index 8 for a soil with T = 5.",
            },
            "weg": {
                "file": "data/layer_soil_weg.png",
                "title": "Soil Wind Erodibility Group (SSURGO)",
                "legend": [{"label": l, "color": c} for l, c in zip(
                    ["1 · sands (I 160–310)", "2 · loamy sands (I 134)", "3 · sandy loams (I 86)",
                     "4 · clays (I 86)", "4L · calcareous loams (I 86)", "5 · (I 56)", "6 · (I 48)",
                     "7 · (I 38)", "8 · not erodible (I 0)"], weg_colors)],
                "note": "Dominant-condition WEG of the surface layer, 800 m grid (UC Davis SoilWeb from SSURGO).",
            },
            "wind": {
                "file": "data/layer_wind_spring.png",
                "title": "Spring wind speed and direction (Feb–May)",
                "unit": "mph at 10 m",
                "legend": [{"label": l, "color": c} for l, c in zip(
                    ["< 9", "9–10", "10–11", "11–12", "12–13", "13–14", "≥ 14"], w_colors)],
                "note": "Mean 10 m wind speed for the windy season, NASA POWER (MERRA-2) 2001–2025 climatology; "
                        "arrows point downwind (where soil is carried), length scaled by speed.",
            },
            "climate": {
                "file": "data/layer_climate_c.png",
                "title": "Wind erosion climatic factor C",
                "unit": "% of Garden City, KS",
                "legend": [{"label": l, "color": c} for l, c in zip(
                    ["< 20", "20–40", "40–60", "60–80", "80–100", "100–120", "≥ 120"], c_colors)],
                "note": "Official NRCS Wind Erosion Equation climatic factor by county (SSURGO climate-factor "
                        "areas). C = 34.483 v³ / PE² (Chepil 1962), relative to Garden City, KS = 100.",
            },
        },
        "stats": stats,
        "windArrows": arrows,
        "texas": mapping(tx_s),
        "counties": {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"name": c["name"], "fips": c["fips"], "C": c["C"]},
             "geometry": mapping(c["geom"].simplify(0.008, preserve_topology=True))} for c in counties]},
    }
    js = "/* generated by tools/build_layers.py */\nwindow.WE_LAYERS = " + json.dumps(meta, separators=(",", ":")) + ";\n"
    (OUT / "layers.js").write_text(js, encoding="utf-8")
    print("wrote layers.js", len(js) // 1024, "KB")


if __name__ == "__main__":
    main()
