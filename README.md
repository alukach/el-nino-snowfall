# El Niño snowfall

A gridded reconstruction of NOAA Climate.gov's
[*Snowfall during moderate-to-strong El Niño winters*](https://www.usgs.gov/media/images/snowfall-during-moderate-strong-el-nino-winters)
map, published as GeoZarr, with a web viewer.

The original map comes from the ENSO Blog post
[*S(no)w pain, S(no)w gain*](https://www.climate.gov/news-features/blogs/snow-pain-snow-gain-how-does-el-nino-affect-snowfall-over-north-america)
by Michelle L'Heureux and Brian Brettschneider (Oct 2023). NOAA did not publish the underlying grid or its list of event years, so this dataset rebuilds it from ERA5, following the method as far as the post describes it.

- **Mean anomaly (left panel of the original):** the average January–March snowfall anomaly across moderate-to-strong El Niño winters.
- **Below-average count (right panel):** how many of those winters had below-average snowfall at each location.

The dataset is published on Source Cooperative at `https://data.source.coop/alukach/el-nino-snowfall` (see https://source.coop/alukach/el-nino-snowfall).

## Terms

- **JFM**: January–March. Each winter's snowfall is the total over these three months.
- **mm w.e.**: millimetres of water equivalent, the depth of liquid water the snow would produce if melted. The underlying variable is ERA5's `snowfall`, which counts only precipitation that fell as snow; rain is never included. Fresh snow is typically around 10× deeper than its water equivalent, but the ratio varies widely.
- **Anomaly**: the difference from the 1991–2020 average, after removing each grid cell's long-term linear trend.
- **ONI / RONI**: NOAA CPC's Oceanic Niño Index is a 3-month running mean of sea-surface temperature anomalies in the Niño-3.4 region of the tropical Pacific, in °C. The *Relative* ONI subtracts the tropical-mean anomaly, so warming of the whole tropics isn't read as El Niño. ≥ +0.5 is El Niño, ≥ +1.0 moderate and ≥ +1.5 strong.
- **DJF**: December–February, the season used for the RONI value stored for each winter.

## How the dataset is generated

Everything is done by [`scripts/build-dataset.py`](scripts/build-dataset.py), a self-contained [PEP 723](https://peps.python.org/pep-0723/) script.

### 1. Inputs

| Source | Variables | Coverage |
|---|---|---|
| [ERA5 monthly averaged reanalysis on single levels](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels-monthly-means) (ECMWF, via Copernicus CDS) | `snowfall` (`sf`), `land_sea_mask` (`lsm`) | Jan, Feb, Mar of 1959–2024; 0.25° grid; 10–85°N, 170–50°W |
| [CPC Relative Oceanic Niño Index](https://www.cpc.ncep.noaa.gov/data/indices/RONI.ascii.txt) | DJF RONI | Every winter, 1959–2024 |

ERA5 monthly means are used rather than hourly data. They give the same monthly totals from a download of about 60 MB, where hourly data would mean hundreds of GB.

CDS returns the request as a zip holding two NetCDF files, one per variable, because `sf` and `lsm` have different step types. Their time stamps also differ (`sf` at 06:00, `lsm` at 00:00). The script therefore reads the two files separately instead of merging them on time. The land-sea mask doesn't change over time, so only its first time step is used.

### 2. January–March snowfall totals

ERA5 stores monthly-mean accumulations as the *average daily* total, in metres of water equivalent. Each month is converted to a monthly total and the three months are added up:

```
JFM_total[year] = Σ over Jan, Feb, Mar of (sf × days_in_month) × 1000    → mm w.e.
```

`days_in_month` accounts for leap-year Februaries.

### 3. Detrending and anomalies

For each grid cell:

1. Fit a straight line to the 1959–2024 JFM totals and subtract it. This removes long-term change (e.g. from warming) so that it isn't mistaken for an El Niño signal.
2. Subtract the 1991–2020 mean of the detrended series. The result is the anomaly for each winter.

### 4. Event selection

Composites use JFM of these 14 moderate-to-strong El Niño winters, listed by the year the winter ends:

```
1964 1966 1969 1973 1983 1987 1988 1992 1995 1998 2003 2010 2016 2024
```

The post says it used the 13 moderate-to-strong El Niño winters since 1959 but doesn't list them or the index threshold, so the first 13 years here are a reconstruction (see [Caveats](#caveats-and-open-questions)). 2024 (the 2023–24 El Niño, RONI peak +1.42) happened after the post was published and was added here.

### 5. Masking

Cells are set to no-data where either:

- the cell is mostly ocean (`lsm ≤ 0.5`), or
- the 1991–2020 mean JFM snowfall is below 1 mm w.e., where the anomalies would be meaningless.

Both masks are choices made here, not NOAA's documented method. The original count map shows cells with no snowfall in black instead of hiding them. They can be changed with `MASK_OCEAN` and `MIN_CLIM_MM` at the top of the script.

### 6. Outputs

- **`anomaly`**: the mean of the event-year anomalies.
- **`below_count`**: the number of event years with an anomaly below 0.
- **`winter_anomaly`**: the anomaly for every winter, El Niño or not. Its `colorbar_limit` attribute (98th percentile of |anomaly| across all winters) gives one colour scale for the whole series.
- **`roni_djf`**: the DJF RONI for every winter, fetched from CPC at build time.
- **`jfm_snowfall`**: every cell's JFM total for all 66 winters (before detrending), for the viewer's click chart.

## Output format

`el-nino-snowfall.zarr` is a Zarr v3 store (zstd-compressed, no consolidated metadata) on a 301 × 481 grid in EPSG:4326 at 0.25°.

| Variable | Dims | Type | Fill | Units | Meaning |
|---|---|---|---|---|---|
| `anomaly` | latitude, longitude | float32 | NaN | mm w.e. | Mean JFM anomaly across the event winters |
| `below_count` | latitude, longitude | uint8 | 255 | count | Number of event winters with below-average JFM snowfall (0–14) |
| `winter_anomaly` | winter, latitude, longitude | float32 | NaN | mm w.e. | JFM anomaly for every winter 1959–2024 |
| `roni_djf` | winter | float32 | NaN | °C | DJF Relative Oceanic Niño Index for every winter |
| `jfm_snowfall` | winter, latitude, longitude | float32 | NaN | mm w.e. | JFM snowfall total for every winter 1959–2024, not detrended, same mask |
| `winter`, `latitude`, `longitude` | | | | | Coordinates: `winter` is the JFM year (1959–2024); latitude runs north to south |

The El Niño winters are listed in the group attribute `events_jfm`.

Chunking: `anomaly` and `below_count` are one chunk each, and `winter_anomaly` has one chunk per winter, so the viewer fetches a single object per map. `jfm_snowfall` is chunked as all winters × 8 × 8 cells (about 16 KB each), so reading one cell's history fetches one small object. Chunks that would be entirely no-data (open ocean) aren't written, and readers return NaN for them.

### GeoZarr metadata

The group and each 2-D/3-D array carry attributes following the
[`proj`](https://github.com/zarr-conventions/proj) and
[`spatial`](https://github.com/zarr-conventions/spatial) Zarr conventions (v0.1), declared in `zarr_conventions`:

```json
"proj:code": "EPSG:4326",
"spatial:dimensions": ["latitude", "longitude"],
"spatial:transform": [0.25, 0.0, -170.125, 0.0, -0.25, 85.125],
"spatial:shape": [301, 481],
"spatial:bbox": [-170.125, 9.875, -49.875, 85.125],
"spatial:registration": "pixel"
```

ERA5 coordinates mark cell centres. The transform origin is therefore shifted half a cell (0.125°) north-west so that pixels cover their true footprint.

The group attributes also record provenance: `source`, `reference`, `events_jfm`, `baseline` (`1991-2020`) and `detrend` (`linear, per cell, 1959-2024`).

## Reproducing it

1. Create a free [Copernicus CDS](https://cds.climate.copernicus.eu) account and put your Personal Access Token from your [profile page](https://cds.climate.copernicus.eu/profile) in `~/.cdsapirc`:
   ```
   url: https://cds.climate.copernicus.eu/api
   key: <PERSONAL-ACCESS-TOKEN>
   ```
2. Accept the licence under "Terms of use" on the
   [ERA5 monthly means download page](https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels-monthly-means?tab=download).
3. From the repository root, run:
   ```sh
   uv run scripts/build-dataset.py
   ```

The raw download is cached as `era5_sf_lsm_jfm_<first>_<last>.zip`, and changing `YEARS` triggers a fresh download. The CDS queue usually takes a few minutes. The script prints a suggested symmetric colour range for `anomaly` (the 98th percentile of |anomaly|).

## Caveats and open questions

- **Event years.** The post doesn't list its 13 winters, and neither of CPC's current indices reproduces this list exactly. Using each winter's peak between Sep–Nov and Dec–Feb, with a threshold of 1.0:
  - **ONI** gives 12 winters. It excludes 1969 (0.98) and 1995 (0.97), and includes 2018–19 (1.05).
  - **RONI** gives all 13 years here plus 1977 (1.08) and 1978 (1.10). No threshold separates those two from 1964 (1.11).

  CPC revises its index values over time, so the exact list is unresolved.
- **Units.** The post's maps appear to be in inches: its trend map is labelled "inches per decade", and the authors describe their snow amounts in inches. A reader asked whether that meant inches of snow or of water equivalent, and the question went unanswered. This dataset uses mm w.e. of the JFM total. The count map's caption says "January-March average". An average rather than a total would shrink the anomalies by about a factor of 3 but wouldn't change their sign or the counts.
- **Detrending.** Assumed to be linear. Adding 2024 extended the trend fit to 1959–2024, so all anomalies differ slightly from a 1959–2023 build.
- **Snowfall vs snowpack.** `snowfall` is what fell as snow in the ERA5 model. It says nothing about melt or depth on the ground, and the rain/snow split near freezing depends on the model's physics.
- **Resolution.** At 0.25° (~25 km), mountain ranges are smoothed. Individual ski areas can differ a lot from their grid cell.

## Viewer

`index.html` and `src/` hold a Vite + TypeScript web map that reads the store with deck.gl-raster's `ZarrLayer` on a MapLibre globe:

```sh
npm install
npm run dev
```

The side panel switches between the El Niño composite, the below-average count and single winters, and shows the value under the cursor.

The timeline at the bottom has:

- a scrubber through all 66 winters, with El Niño winters ticked in orange;
- buttons to step one winter back or forward, or to jump to the previous or next El Niño;
- a label showing whether the winter is El Niño, plus its RONI.

Clicking a map cell or ski resort charts its JFM snowfall for every winter. The chart shows El Niño winters as orange dots sized by RONI, plus the 1991–2020 mean and the linear trend. Clicking any point on the chart maps that winter. It reads from Source Cooperative by default. To use another copy, set `VITE_ZARR_URL` to an absolute URL, e.g. a local server hosting `el-nino-snowfall.zarr`.

`scripts/build-ski-resorts.py` builds `public/ski-resorts.geojson`: operating downhill ski areas in the US, Canada and Mexico from [OpenSkiMap](https://openskimap.org) (© OpenStreetMap contributors, ODbL).

## License and attribution

- ERA5: Hersbach et al. (2020), Copernicus Climate Change Service. Generated using Copernicus Climate Change Service information; neither the European Commission nor ECMWF is responsible for any use of this information.
- RONI: NOAA Climate Prediction Center.
- The method follows L'Heureux and Brettschneider, NOAA Climate.gov ENSO Blog (2023). This dataset is an independent reconstruction, not NOAA's data.
