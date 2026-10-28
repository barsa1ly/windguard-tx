"""Official NRCS WEQ climatic factor C per Texas county, from SSURGO land-area overlaps.

Writes raw/county_c.json: {"48115": {"name": "Dawson", "C": 70.0, "values": {"70": 812}}}
"""
import json
from collections import defaultdict
from pathlib import Path

import requests

SDA = "https://SDMDataAccess.sc.egov.usda.gov/Tabular/post.rest"
OUT = Path(__file__).parent / "raw" / "county_c.json"

Q = """
SELECT cty.areasymbol AS county, cty.areaname, cf.areasymbol AS cfact, COUNT(*) AS n
FROM muaoverlap m1
JOIN laoverlap cty ON cty.lareaovkey = m1.lareaovkey AND cty.areatypename = 'County or Parish'
JOIN muaoverlap m2 ON m2.mukey = m1.mukey
JOIN laoverlap cf ON cf.lareaovkey = m2.lareaovkey AND cf.areatypename LIKE 'Climate Factor%'
WHERE cty.areasymbol LIKE 'TX%'
GROUP BY cty.areasymbol, cty.areaname, cf.areasymbol
"""


def main():
    r = requests.post(SDA, json={"query": Q, "format": "JSON"}, timeout=300)
    r.raise_for_status()
    rows = r.json()["Table"]
    out = defaultdict(lambda: {"name": "", "values": {}})
    for county, name, cfact, n in rows:
        fips = "48" + county[2:]
        out[fips]["name"] = name
        out[fips]["values"][cfact] = int(n)
    for fips, rec in out.items():
        vals = {float(k): v for k, v in rec["values"].items() if k.replace(".", "").isdigit()}
        tot = sum(vals.values())
        rec["C"] = round(sum(k * v for k, v in vals.items()) / tot, 1) if tot else None
    OUT.write_text(json.dumps(out, indent=1))
    print(len(out), "counties;", sorted((v["C"] for v in out.values() if v["C"] is not None))[::25])


if __name__ == "__main__":
    main()
