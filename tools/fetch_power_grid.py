"""Fetch NASA POWER monthly climatology (2001-2025, MERRA-2 ~0.5 x 0.625 deg) over Texas.

Writes raw/power_grid.json: {"lat,lon": {PARAM: {JAN..DEC, ANN}}}
"""
import json
import time
from pathlib import Path

import requests

PARAMS = ["WS2M", "WS10M", "WD10M", "PRECTOTCORR", "T2M", "T2M_MAX", "T2M_MIN", "TOA_SW_DWN"]
TILES = [  # (lat_min, lat_max, lon_min, lon_max) -- each <= 10 deg
    (25.5, 31.0, -106.75, -100.0),
    (25.5, 31.0, -100.0, -93.25),
    (31.0, 36.75, -106.75, -100.0),
    (31.0, 36.75, -100.0, -93.25),
]
URL = "https://power.larc.nasa.gov/api/temporal/climatology/regional"
OUT = Path(__file__).parent / "raw" / "power_grid.json"


def main():
    grid = json.loads(OUT.read_text()) if OUT.exists() else {}
    for p in PARAMS:
        for t in TILES:
            q = dict(parameters=p, community="AG", format="JSON",
                     **{"latitude-min": t[0], "latitude-max": t[1],
                        "longitude-min": t[2], "longitude-max": t[3]})
            for attempt in range(4):
                r = requests.get(URL, params=q, timeout=180)
                if r.ok:
                    break
                print("retry", p, t, r.status_code, r.text[:200])
                time.sleep(5 * (attempt + 1))
            r.raise_for_status()
            for f in r.json()["features"]:
                lon, lat = f["geometry"]["coordinates"][:2]
                key = f"{lat:.3f},{lon:.3f}"
                grid.setdefault(key, {})[p] = f["properties"]["parameter"][p]
            print(p, t, "ok", len(grid))
    OUT.write_text(json.dumps(grid))


if __name__ == "__main__":
    main()
