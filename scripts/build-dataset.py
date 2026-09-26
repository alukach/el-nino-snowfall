#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "cdsapi>=0.7.2",
#     "h5netcdf",
#     "h5py",
#     "numpy",
#     "xarray>=2025.1",
#     "zarr>=3",
# ]
# ///
"""
Rebuild NOAA Climate.gov's "Snowfall during moderate-to-strong El Nino winters"
from ERA5 monthly means and write a GeoZarr (Zarr v3) store readable by
deck.gl-raster's ZarrLayer.

Run:   uv run scripts/build-dataset.py   (from the repo root; RAW and OUT are relative paths)
Auth:  CDS account + ~/.cdsapirc (licence for ERA5 accepted on the dataset page)

Output variables (all EPSG:4326, 0.25 deg, pixel-registered):
  anomaly        (latitude, longitude)        float32  mm w.e., event-mean JFM anomaly  [left panel]
  below_count    (latitude, longitude)        uint8    events with anomaly < 0, 0..N   [right panel]
  winter_anomaly (winter, latitude, longitude) float32 detrended JFM anomaly, every winter [timeline]
  roni_djf       (winter)                     float32  CPC Relative Oceanic Nino Index, DJF
  jfm_snowfall   (winter, latitude, longitude) float32 mm w.e., JFM total for every winter [click chart]
"""

import urllib.request
import zipfile
from pathlib import Path

import cdsapi
import numpy as np
import xarray as xr

YEARS = range(1959, 2025)
BASE = slice(1991, 2020)
# JFM of moderate-to-strong El Nino winters, by the year the winter ends. The blog says it used 13 such
# winters since 1959 but doesn't list them; these 13 are a reconstruction (see README caveats).
# 2024 is the 2023-24 event (RONI peak 1.42, OND), added after the blog was published.
EVENTS = [1964, 1966, 1969, 1973, 1983, 1987, 1988, 1992, 1995, 1998, 2003, 2010, 2016, 2024]
AREA = [85, -170, 10, -50]  # N, W, S, E
RES = 0.25
MASK_OCEAN = True     # ERA5 lsm > 0.5
MIN_CLIM_MM = 1.0     # mask cells with negligible 1991-2020 JFM snowfall; set 0 to disable
COUNT_FILL = 255
SERIES_BLOCK = 8  # jfm_snowfall chunk = all winters x 8 x 8 cells, so a click fetches one small object

# CDS always zips this request: sf and lsm come back as separate NetCDFs (different stepType).
RAW = Path(f"era5_sf_lsm_jfm_{YEARS[0]}_{YEARS[-1]}.zip")
OUT = Path("el-nino-snowfall.zarr")
RONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt"

CONVENTIONS = [
    {
        "schema_url": "https://raw.githubusercontent.com/zarr-conventions/proj/refs/tags/v0.1/schema.json",
        "spec_url": "https://github.com/zarr-conventions/proj/blob/v0.1/README.md",
        "uuid": "f17cb550-5864-4468-aeb7-f3180cfb622f",
        "name": "proj",
        "description": "Coordinate reference system information for geospatial data",
    },
    {
        "schema_url": "https://raw.githubusercontent.com/zarr-conventions/spatial/refs/tags/v0.1/schema.json",
        "spec_url": "https://github.com/zarr-conventions/spatial/blob/v0.1/README.md",
        "uuid": "689b58e2-cf7b-45e0-9fff-9cfc0883d6b4",
        "name": "spatial",
        "description": "Spatial coordinate information",
    },
]


def download() -> None:
    if RAW.exists():
        return
    cdsapi.Client().retrieve(
        "reanalysis-era5-single-levels-monthly-means",
        {
            "product_type": ["monthly_averaged_reanalysis"],
            "variable": ["snowfall", "land_sea_mask"],
            "year": [str(y) for y in YEARS],
            "month": ["01", "02", "03"],
            "time": ["00:00"],
            "area": AREA,
            "data_format": "netcdf",
            "download_format": "zip",
        },
        str(RAW),
    )


def roni_djf(years: list[int]) -> xr.DataArray:
    rows = (line.split() for line in urllib.request.urlopen(RONI_URL).read().decode().splitlines()[1:])
    djf = {int(yr): float(v) for season, yr, v in rows if season == "DJF"}
    return xr.DataArray(
        np.array([djf[y] for y in years], dtype="float32"), dims="winter", coords={"winter": years},
        attrs={"units": "degC", "long_name": "Relative Oceanic Nino Index, Dec-Feb", "source": RONI_URL},
    )


def compute() -> xr.Dataset:
    # Don't merge: sf is stamped 06:00 and lsm 00:00, so their valid_time axes never align.
    with zipfile.ZipFile(RAW) as z:
        v = {}
        for n in z.namelist():
            v.update(xr.open_dataset(z.open(n), engine="h5netcdf").load().drop_vars(["number", "expver"], errors="ignore").data_vars)
    sf, lsm = v["sf"], v["lsm"].isel(valid_time=0, drop=True)  # lsm is static

    # Monthly-mean accumulations are mean daily totals (m w.e. per day).
    jfm = (sf * sf.valid_time.dt.days_in_month).groupby("valid_time.year").sum() * 1000.0

    # Remove linear trend per cell, then express relative to the 1991-2020 mean.
    coef = jfm.polyfit("year", deg=1).polyfit_coefficients
    resid = jfm - xr.polyval(jfm.year, coef)
    anom = resid - resid.sel(year=BASE).mean("year")

    mask = xr.ones_like(anom.isel(year=0, drop=True), dtype=bool)
    if MASK_OCEAN:
        mask &= lsm > 0.5
    if MIN_CLIM_MM > 0:
        mask &= jfm.sel(year=BASE).mean("year") >= MIN_CLIM_MM

    ev = anom.sel(year=EVENTS)
    composite = ev.mean("year").where(mask).astype("float32")
    below = (ev < 0).sum("year").where(mask).fillna(COUNT_FILL).astype("uint8")
    winter_anom = anom.rename(year="winter").where(mask).astype("float32")

    lat, lon = composite.latitude.values, composite.longitude.values
    assert lat[0] > lat[-1], "expected north-up latitude"
    west, north = float(lon[0]) - RES / 2, float(lat[0]) + RES / 2
    geo = {
        "zarr_conventions": CONVENTIONS,
        "proj:code": "EPSG:4326",
        "spatial:dimensions": ["latitude", "longitude"],
        "spatial:transform": [RES, 0.0, west, 0.0, -RES, north],
        "spatial:shape": [int(lat.size), int(lon.size)],
        "spatial:bbox": [west, float(lat[-1]) - RES / 2, float(lon[-1]) + RES / 2, north],
        "spatial:registration": "pixel",
    }

    out = xr.Dataset(
        {
            "anomaly": composite.assign_attrs(
                geo, units="mm w.e.",
                long_name="Detrended JFM snowfall anomaly vs 1991-2020, mean of moderate-to-strong El Nino winters",
            ),
            "below_count": below.assign_attrs(
                geo, units="count",
                long_name=f"Number of the {len(EVENTS)} events with below-average JFM snowfall",
            ),
            "winter_anomaly": winter_anom.assign_attrs(
                geo, units="mm w.e.", long_name="Detrended JFM snowfall anomaly vs 1991-2020, every winter",
                # Symmetric colour limit shared by all winters, so the scale doesn't jump while scrubbing.
                colorbar_limit=float(np.nanpercentile(np.abs(winter_anom.values), 98)),
            ),
            "roni_djf": roni_djf(list(YEARS)),
            "jfm_snowfall": jfm.rename(year="winter").where(mask).astype("float32").assign_attrs(
                geo, units="mm w.e.", long_name="JFM snowfall total (not detrended), every winter",
            ),
        },
        attrs={
            **geo,
            "title": "Snowfall during moderate-to-strong El Nino winters (ERA5 reconstruction)",
            "source": "ECMWF ERA5 monthly averaged reanalysis on single levels (Copernicus CDS)",
            "reference": "https://www.climate.gov/news-features/blogs/snow-pain-snow-gain-how-does-el-nino-affect-snowfall-over-north-america",
            "events_jfm": EVENTS,
            "baseline": "1991-2020",
            "detrend": f"linear, per cell, {YEARS[0]}-{YEARS[-1]}",
        },
    )
    return out


def write(out: xr.Dataset) -> None:
    ny, nx = out.sizes["latitude"], out.sizes["longitude"]
    encoding = {
        "anomaly": {"chunks": (ny, nx)},
        "below_count": {"chunks": (ny, nx), "_FillValue": COUNT_FILL},
        "winter_anomaly": {"chunks": (1, ny, nx)},
        "jfm_snowfall": {"chunks": (out.sizes["winter"], SERIES_BLOCK, SERIES_BLOCK)},
    }
    out.to_zarr(OUT, mode="w", zarr_format=3, consolidated=False, encoding=encoding)

    a = np.abs(out["anomaly"].values)
    print(f"wrote {OUT}  grid={ny}x{nx}")
    print(f"suggested symmetric rescale for anomaly: +/-{np.nanpercentile(a, 98):.1f} mm w.e.")
    print(f"winters: {int(out.winter[0])}-{int(out.winter[-1])}  El Nino events: {out.attrs['events_jfm']}")
    print(f"winter_anomaly colorbar_limit: +/-{out.winter_anomaly.attrs['colorbar_limit']:.1f} mm w.e.")


if __name__ == "__main__":
    download()
    write(compute())
