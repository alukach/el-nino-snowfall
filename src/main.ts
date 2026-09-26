import { MapboxOverlay } from "@deck.gl/mapbox";
import type { MinimalTileData } from "@developmentseed/deck.gl-raster";
import { type GetTileDataOptions, ZarrLayer } from "@developmentseed/deck.gl-zarr";
import { Map as MaplibreMap, NavigationControl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Texture } from "@luma.gl/core";
import * as zarr from "zarrita";

// Override with VITE_ZARR_URL (absolute URL) to test a local build of the store.
const ZARR_URL = import.meta.env.VITE_ZARR_URL ?? "https://data.source.coop/alukach/el-nino-snowfall";
const COUNT_FILL = 255;

type Mode = "anomaly" | "below_count" | "winter_anomaly";
type Arr = zarr.Array<zarr.DataType, zarr.Readable>;
type Values = ArrayLike<number>;
type TileData = MinimalTileData & { texture: Texture };
type RGBA = [number, number, number, number];

// ColorBrewer BrBG: brown = less snow, teal = more snow.
const BRBG = ["#543005", "#8c510a", "#bf812d", "#dfc27d", "#f6e8c3", "#f5f5f5", "#c7eae5", "#80cdc1", "#35978f", "#01665e", "#003c30"].map(hex);

function hex(h: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function brbg(v: number, scale: number): RGBA | null {
  if (Number.isNaN(v)) return null;
  const t = Math.min(1, Math.max(0, (v / scale + 1) / 2)) * (BRBG.length - 1);
  const i = Math.min(Math.floor(t), BRBG.length - 2);
  const [a, b, f] = [BRBG[i]!, BRBG[i + 1]!, t - i];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, 255];
}

// Right panel of the original: gray below a majority of the n events, red once a majority were below average.
const majority = (n: number) => Math.floor(n / 2) + 1;
function countColor(v: number, n: number): RGBA | null {
  if (v === COUNT_FILL) return null;
  const m = majority(n);
  if (v < m) return [235 - (v / (m - 1)) * 108, 235 - (v / (m - 1)) * 108, 235 - (v / (m - 1)) * 108, 255];
  const k = (v - m) / (n - m);
  return [250 - k * 120, 150 - k * 150, 140 - k * 140, 255];
}

// ponytail: colormap on the CPU into ImageData; move to the GPU Colormap module if rescale becomes interactive.
function paint(values: Values, width: number, height: number, color: (v: number) => RGBA | null): ImageData {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const c = color(values[i]!);
    if (c) rgba.set(c, i * 4);
  }
  return new ImageData(rgba, width, height);
}

// 98th percentile of |v|, ignoring NaN: a symmetric scale that isn't dominated by outliers.
function symmetricScale(values: Values): number {
  const a = Float32Array.from(values, Math.abs).filter((x) => !Number.isNaN(x)).sort();
  return a[Math.floor(0.98 * (a.length - 1))] ?? 1;
}

const signed = (v: number, digits: number) => `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const root = zarr.root(new zarr.FetchStore(ZARR_URL));
const open = (name: string) => zarr.open.v3(root.resolve(name), { kind: "array" }) as Promise<Arr>;
const group = await zarr.open.v3(root, { kind: "group" });
const [anomaly, below_count, winter_anomaly, winterArr, roniArr, series] = (await Promise.all(
  ["anomaly", "below_count", "winter_anomaly", "winter", "roni_djf", "jfm_snowfall"].map(open),
)) as [Arr, Arr, Arr, Arr, Arr, Arr];
const arrays: Record<Mode, Arr> = { anomaly, below_count, winter_anomaly };
const events = group.attrs.events_jfm as number[]; // El Niño winters, by JFM year
const winters = Array.from((await zarr.get(winterArr)).data as Values, Number); // int64 -> BigInt64Array
const roni = (await zarr.get(roniArr)).data as Values; // DJF Relative Oceanic Niño Index per winter
const eventIdx = winters.flatMap((w, i) => (events.includes(w) ? [i] : []));
const [a, , west, , e, north] = anomaly.attrs["spatial:transform"] as [number, number, number, number, number, number];
const [ny, nx] = anomaly.shape as [number, number];

// Full grids for the hover readout: the two composites, plus one slice per winter visited (580 KB each).
// ponytail: unbounded; scrubbing all 66 winters holds ~38 MB. Add LRU eviction if that matters.
const cache = new Map<string, Values>();
const cacheKey = (mode: Mode, w: number) => (mode === "winter_anomaly" ? `${mode}:${w}` : mode);
async function load(mode: Mode, w: number): Promise<Values> {
  const k = cacheKey(mode, w);
  const hit = cache.get(k);
  if (hit) return hit;
  const chunk = mode === "winter_anomaly" ? await zarr.get(arrays[mode], [w, null, null]) : await zarr.get(arrays[mode]);
  cache.set(k, chunk.data as Values);
  return chunk.data as Values;
}
const anomalyScale = symmetricScale(await load("anomaly", 0));
// One scale for all winters (computed by the build script), so colours don't shift while scrubbing.
const winterScale = (winter_anomaly.attrs.colorbar_limit as number | undefined) ?? anomalyScale * 3;

const map = new MaplibreMap({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  center: [-100, 50],
  zoom: 2.4,
});
const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
map.addControl(overlay);
map.addControl(new NavigationControl(), "top-right");
await map.once("load");
// MapLibre only does Mercator or globe; a globe centred on North America avoids Mercator's
// inflation of Alaska and northern Canada. ponytail: true conic (e.g. Lambert) needs a non-MapLibre renderer.
map.setProjection({ type: "globe" });
// Stack order: data < hillshade < borders < labels < ski resorts. The data is inserted under the hillshade.
const firstLabelId = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
for (const id of ["boundary_state", "boundary_country_inner"]) {
  map.moveLayer(id, firstLabelId);
  map.setPaintProperty(id, "line-color", "#444");
}
map.setLayerZoomRange("boundary_state", 0, 24); // Positron hides states below z4
// Subtle relief over the snowfall colours, from AWS's public Terrarium DEM tiles (no key, CORS enabled).
// maxzoom 12 overzooms beyond that; plenty for a light shade and keeps tile requests down.
map.addSource("dem", {
  type: "raster-dem",
  tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
  encoding: "terrarium",
  tileSize: 256,
  maxzoom: 12,
  attribution: "Elevation: Terrain Tiles (Mapzen, AWS Open Data)",
});
map.addLayer(
  {
    id: "hillshade",
    type: "hillshade",
    source: "dem",
    paint: {
      "hillshade-exaggeration": 0.3,
      "hillshade-shadow-color": "rgba(40, 30, 20, 0.35)",
      "hillshade-highlight-color": "rgba(255, 255, 255, 0.2)",
      "hillshade-accent-color": "rgba(40, 30, 20, 0.15)",
    },
  },
  "boundary_state",
);
map.addSource("ski-resorts", {
  type: "geojson",
  data: new URL("ski-resorts.geojson", location.href).href, // built by scripts/build-ski-resorts.py
  attribution: "Ski areas © OpenSkiMap.org, © OpenStreetMap contributors",
});
map.addLayer({
  id: "ski-resorts",
  type: "circle",
  source: "ski-resorts",
  layout: { visibility: "none" },
  paint: { "circle-radius": 3.5, "circle-color": "#1d4ed8", "circle-stroke-color": "#fff", "circle-stroke-width": 1 },
});
const skiInput = $<HTMLInputElement>("ski");
skiInput.addEventListener("change", () =>
  map.setLayoutProperty("ski-resorts", "visibility", skiInput.checked ? "visible" : "none"),
);

// `winter` is an index into `winters`.
const state = { mode: "anomaly" as Mode, winter: winters.length - 1 };

// --- Timeline -------------------------------------------------------------------------------------------------

const winterInput = $<HTMLInputElement>("winter");
winterInput.max = String(winters.length - 1);
// Orange ticks under the scrubber for El Niño winters. --thumb keeps them aligned with the range thumb's centre.
$("ticks").innerHTML = eventIdx
  .map((i) => `<span style="left: calc(var(--thumb) / 2 + (100% - var(--thumb)) * ${i / (winters.length - 1)})"></span>`)
  .join("");

function renderTimeline() {
  const i = state.winter;
  const w = winters[i]!;
  const nino = events.includes(w);
  winterInput.value = String(i);
  winterInput.setAttribute("aria-valuetext", `January to March ${w}, ${nino ? "El Niño" : "not El Niño"}`);
  $("winter-year").textContent = `Jan–Mar ${w}`;
  const badge = $("winter-badge");
  badge.textContent = nino ? "El Niño" : "Not El Niño";
  badge.classList.toggle("nino", nino);
  $("winter-roni").textContent = `RONI ${signed(roni[i]!, 2)} (Dec–Feb)`;
  $("timeline").classList.toggle("inactive", state.mode !== "winter_anomaly");
  $<HTMLButtonElement>("prev-year").disabled = i === 0;
  $<HTMLButtonElement>("next-year").disabled = i === winters.length - 1;
  $<HTMLButtonElement>("prev-nino").disabled = eventIdx.findLast((j) => j < i) === undefined;
  $<HTMLButtonElement>("next-nino").disabled = eventIdx.find((j) => j > i) === undefined;
}

// Show one winter's anomaly map; used by the timeline and the chart's dots.
function showWinter(i: number) {
  state.winter = Math.max(0, Math.min(winters.length - 1, i));
  state.mode = "winter_anomaly";
  document.querySelector<HTMLInputElement>('input[name=mode][value="winter_anomaly"]')!.checked = true;
  update();
}

winterInput.addEventListener("input", () => showWinter(Number(winterInput.value)));
$("prev-year").addEventListener("click", () => showWinter(state.winter - 1));
$("next-year").addEventListener("click", () => showWinter(state.winter + 1));
$("prev-nino").addEventListener("click", () => {
  const i = eventIdx.findLast((j) => j < state.winter);
  if (i !== undefined) showWinter(i);
});
$("next-nino").addEventListener("click", () => {
  const i = eventIdx.find((j) => j > state.winter);
  if (i !== undefined) showWinter(i);
});

// --- Map layer and legend -------------------------------------------------------------------------------------

function update() {
  const { mode, winter } = state;
  renderTimeline();
  drawChart();
  void load(mode, winter); // warm the hover cache

  const scale = mode === "winter_anomaly" ? winterScale : anomalyScale;
  const color = mode === "below_count" ? (v: number) => countColor(v, events.length) : (v: number) => brbg(v, scale);

  overlay.setProps({
    layers: [
      new ZarrLayer<zarr.Readable, zarr.DataType, TileData>({
        id: `${mode}-${mode === "winter_anomaly" ? winter : ""}`, // new id per slice = fresh tile cache
        node: arrays[mode],
        selection: mode === "winter_anomaly" ? { winter } : {},
        async getTileData(arr: Arr, opts: GetTileDataOptions) {
          const chunk = await zarr.get(arr, opts.sliceSpec, { signal: opts.signal });
          const { data } = paint(chunk.data as Values, opts.width, opts.height, color);
          // Build the texture ourselves: an ImageData `image` gets linear filtering, which blurs 0.25° cells.
          const texture = opts.device.createTexture({
            format: "rgba8unorm",
            width: opts.width,
            height: opts.height,
            data,
            sampler: { minFilter: "nearest", magFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" },
          });
          return { texture, width: opts.width, height: opts.height, byteLength: data.byteLength };
        },
        renderTile: (d: TileData) => ({ image: d.texture }),
        onTileUnload: (tile) => tile.content?.texture.destroy(),
        opacity: 0.85,
        // On the globe the raster is coplanar with MapLibre's sphere and z-fights; skip the depth test
        // (back faces are still culled). Same fix as deck.gl-raster's cog-globe example.
        parameters: { depthCompare: "always" },
        // @ts-expect-error beforeId is read by @deck.gl/mapbox in interleaved mode; not in LayerProps
        beforeId: "hillshade",
      }),
    ],
  });

  const labels = $("legend-labels");
  if (mode === "below_count") {
    const n = events.length;
    $("legend-bar").style.background = `linear-gradient(to right, ${Array.from({ length: n + 1 }, (_, v) => {
      const [r, g, b] = countColor(v, n)!;
      return `rgb(${r} ${g} ${b}) ${(v / (n + 1)) * 100}% ${((v + 1) / (n + 1)) * 100}%`;
    }).join(", ")})`;
    labels.innerHTML = `<span>0</span><span>${majority(n)} of ${n} events below average</span><span>${n}</span>`;
  } else {
    $("legend-bar").style.background = `linear-gradient(to right, ${BRBG.map((c) => `rgb(${c.join(" ")})`).join(", ")})`;
    labels.innerHTML = `<span>−${scale.toFixed(0)}</span><span>0 mm w.e.</span><span>+${scale.toFixed(0)}</span>`;
  }
}

document.querySelectorAll<HTMLInputElement>("input[name=mode]").forEach((el) =>
  el.addEventListener("change", () => {
    state.mode = el.value as Mode;
    update();
  }),
);

// --- Places ---------------------------------------------------------------------------------------------------

type LngLat = { lng: number; lat: number };
type Point = { x: number; y: number };

function cellAt({ lng, lat }: LngLat): [row: number, col: number] | null {
  const col = Math.floor((lng - west) / a);
  const row = Math.floor((lat - north) / e);
  return col < 0 || col >= nx || row < 0 || row >= ny ? null : [row, col];
}

// Resort dots are small; accept clicks/hovers within a few pixels.
function resortAt(point: Point) {
  if (!skiInput.checked) return undefined;
  const pad = 6;
  return map.queryRenderedFeatures(
    [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]],
    { layers: ["ski-resorts"] },
  )[0];
}

const resortLabel = (p: Record<string, unknown>) => `${p.name}${p.vertical_m ? ` (${p.vertical_m} m vertical)` : ""}`;

function placeName(lngLat: LngLat, point: Point): string {
  const resort = resortAt(point);
  return resort ? resortLabel(resort.properties) : `${lngLat.lat.toFixed(2)}°, ${lngLat.lng.toFixed(2)}°`;
}

// --- Chart ----------------------------------------------------------------------------------------------------

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const chart = { values: null as Values | null, place: "", subtitle: "" };

// Line chart of one cell's JFM snowfall for every winter. Every point is clickable (maps that winter); El Niño
// winters are orange dots sized by RONI. 1991–2020 mean dashed, linear trend thin, selected winter marked.
// Drawn at the panel's pixel width; redrawn on resize and winter change.
// Built from numbers only; place names go in via textContent (resort names come from OSM).
function drawChart() {
  const { values } = chart;
  if (!values) return;
  $("chart-place").textContent = chart.place;
  $("chart-place").hidden = !chart.place;
  $("chart-title").textContent = chart.subtitle;
  const svg = $("chart-svg");
  const W = svg.clientWidth || 600;
  const H = 200;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("height", String(H));
  const pts = winters.map((w, i) => ({ w, i, v: values[i]! })).filter((p) => !Number.isNaN(p.v));
  if (pts.length < 2) {
    svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">No snowfall data for this cell</text>`;
    svg.setAttribute("aria-label", "No snowfall data for this cell");
    return;
  }
  const [L, R, T, B] = [40, 10, 10, 20];
  const [w0, w1] = [winters[0]!, winters.at(-1)!];
  const vmax = Math.max(...pts.map((p) => p.v)) || 1;
  const x = (w: number) => L + ((w - w0) / (w1 - w0)) * (W - L - R);
  const y = (v: number) => T + (1 - v / vmax) * (H - T - B);

  const base = mean(pts.filter((p) => p.w >= 1991 && p.w <= 2020).map((p) => p.v));
  const [mw, mv] = [mean(pts.map((p) => p.w)), mean(pts.map((p) => p.v))];
  const slope = pts.reduce((s, p) => s + (p.w - mw) * (p.v - mv), 0) / pts.reduce((s, p) => s + (p.w - mw) ** 2, 0);
  const trend = (w: number) => mv + slope * (w - mw);
  const selected = state.mode === "winter_anomaly" ? state.winter : -1;
  const decades = Array.from({ length: Math.floor(w1 / 10) - Math.ceil(w0 / 10) + 1 }, (_, k) => (Math.ceil(w0 / 10) + k) * 10);

  const dot = ({ w, i, v }: (typeof pts)[number]) => {
    const nino = events.includes(w);
    const label = `${w}: ${v.toFixed(1)} mm w.e. · RONI ${signed(roni[i]!, 2)}${nino ? " · El Niño" : ""}`;
    const ring = i === selected ? `stroke="#111" stroke-width="2"` : `stroke="#fff" stroke-width="1"`;
    // El Niño dot area grows with RONI; they're also keyboard-focusable (the timeline covers the rest).
    return nino
      ? `<circle class="winter-dot" data-i="${i}" cx="${x(w)}" cy="${y(v)}" r="${2 + 2 * Math.max(0, roni[i]!)}" fill="#c2410c" fill-opacity="0.85" ${ring}
          tabindex="0" role="button" aria-label="Map ${label}"><title>${label} (click to map)</title></circle>`
      : `<circle class="winter-dot" data-i="${i}" cx="${x(w)}" cy="${y(v)}" r="${i === selected ? 4 : 2.5}" fill="#333" ${ring}><title>${label} (click to map)</title></circle>`;
  };

  svg.innerHTML = `
    ${[0, 0.5, 1].map((f) => `<line x1="${L}" y1="${y(vmax * f)}" x2="${W - R}" y2="${y(vmax * f)}" stroke="${f ? "#eee" : "#999"}" />
      <text x="${L - 6}" y="${y(vmax * f) + 4}" text-anchor="end">${(vmax * f).toFixed(0)}</text>`).join("")}
    ${decades.map((w) => `<text x="${x(w)}" y="${H - 4}" text-anchor="middle">${w}</text>`).join("")}
    ${selected >= 0 ? `<line x1="${x(winters[selected]!)}" y1="${T}" x2="${x(winters[selected]!)}" y2="${y(0)}" stroke="#111" stroke-dasharray="2 3" />` : ""}
    <line x1="${x(1991)}" y1="${y(base)}" x2="${x(2020)}" y2="${y(base)}" stroke="#1d4ed8" stroke-width="1.5" stroke-dasharray="5 4" />
    <line x1="${x(w0)}" y1="${y(trend(w0))}" x2="${x(w1)}" y2="${y(trend(w1))}" stroke="#888" />
    <polyline fill="none" stroke="#333" stroke-width="1.5" points="${pts.map((p) => `${x(p.w)},${y(p.v)}`).join(" ")}" />
    ${pts.filter((p) => !events.includes(p.w)).map(dot).join("")}
    ${pts.filter((p) => events.includes(p.w)).map(dot).join("")}`;
  svg.setAttribute(
    "aria-label",
    `JFM snowfall ${w0}–${w1}; 1991–2020 mean ${base.toFixed(0)} mm w.e.; trend ${(slope * 10).toFixed(1)} mm per decade`,
  );
}

const svgEl = $("chart-svg");
const dotIndex = (t: EventTarget | null) => (t instanceof Element ? t.closest(".winter-dot")?.getAttribute("data-i") : null);
svgEl.addEventListener("click", (ev) => {
  const i = dotIndex(ev.target);
  if (i) showWinter(Number(i));
});
svgEl.addEventListener("keydown", (ev) => {
  const i = dotIndex(ev.target);
  if (i && (ev.key === "Enter" || ev.key === " ")) {
    ev.preventDefault();
    showWinter(Number(i));
  }
});
$("chart-close").addEventListener("click", () => {
  $("chart").hidden = true;
  chart.values = null;
});
window.addEventListener("resize", drawChart);

let clickSeq = 0;
map.on("click", async ({ lngLat, point }) => {
  const resort = resortAt(point);
  // A resort click charts the cell under the resort itself, not wherever the click landed.
  const at = resort?.geometry.type === "Point" ? { lng: resort.geometry.coordinates[0]!, lat: resort.geometry.coordinates[1]! } : lngLat;
  const cell = cellAt(at);
  if (!cell) return;
  const seq = ++clickSeq; // ignore responses from earlier, slower clicks
  const [cellLat, cellLng] = [north + (cell[0] + 0.5) * e, west + (cell[1] + 0.5) * a];
  const chunk = await zarr.get(series, [null, cell[0], cell[1]]);
  if (seq !== clickSeq) return;
  chart.values = chunk.data as Values;
  chart.place = resort ? resortLabel(resort.properties) : "";
  chart.subtitle = `JFM snowfall (mm w.e.) for the 0.25° grid cell centred on ${cellLat.toFixed(2)}°, ${cellLng.toFixed(2)}°`;
  $("chart").hidden = false;
  drawChart();
});

map.on("mousemove", ({ lngLat, point }) => {
  const cell = cellAt(lngLat);
  const readout = $("readout");
  if (!cell) return void (readout.textContent = "");
  const [row, col] = cell;
  const { mode, winter } = state;
  const values = cache.get(cacheKey(mode, winter));
  if (!values) return;
  const v = values[row * nx + col]!;
  const where = placeName(lngLat, point);
  if (mode === "below_count") {
    readout.textContent = v === COUNT_FILL ? `${where}: no data` : `${where}: ${v} of ${events.length} events below average`;
  } else {
    const when = mode === "winter_anomaly" ? ` in ${winters[winter]}` : "";
    readout.textContent = Number.isNaN(v) ? `${where}: no data` : `${where}: ${signed(v, 1)} mm w.e.${when}`;
  }
});

update();
