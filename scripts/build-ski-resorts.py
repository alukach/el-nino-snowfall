#!/usr/bin/env python3
"""
Extract operating downhill ski areas in the US, Canada and Mexico from OpenSkiMap
(OpenStreetMap + skimap.org, ODbL) into a small point GeoJSON for the viewer.

Run:  python3 scripts/build-ski-resorts.py  (from the repo root)
"""

import json
import urllib.request
from pathlib import Path

SRC = "https://tiles.openskimap.org/geojson/ski_areas.geojson"  # ~20 MB, worldwide
OUT = Path("public/ski-resorts.geojson")
COUNTRIES = {"US", "CA", "MX"}

# The server 403s Python's default User-Agent.
req = urllib.request.Request(SRC, headers={"User-Agent": "el-nino-snowfall/1.0"})
with urllib.request.urlopen(req) as r:
    features = json.load(r)["features"]

out = []
for f in features:
    p = f["properties"]
    if (
        p.get("status") == "operating"
        and "downhill" in (p.get("activities") or [])
        and any(pl.get("iso3166_1Alpha2") in COUNTRIES for pl in p.get("places") or [])
    ):
        lon, lat = p["viewportHint"]["center"]  # polygons too; one dot per resort
        stats = p.get("statistics") or {}
        top, base = stats.get("maxElevation"), stats.get("minElevation")
        out.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(lon, 4), round(lat, 4)]},
            "properties": {
                "name": p.get("name") or "Unnamed ski area",
                "vertical_m": round(top - base) if top is not None and base is not None else None,
                "website": (p.get("websites") or [None])[0],
            },
        })

assert out, "no resorts matched; did the OpenSkiMap schema change?"
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps({
    "type": "FeatureCollection",
    "attribution": "© OpenSkiMap.org, © OpenStreetMap contributors (ODbL)",
    "features": out,
}, separators=(",", ":")))
print(f"wrote {OUT}: {len(out)} ski areas")
