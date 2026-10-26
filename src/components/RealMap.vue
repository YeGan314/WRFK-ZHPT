<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  PhPlus,
  PhMinus,
  PhCrosshair,
  PhWarningCircle,
} from "@phosphor-icons/vue";
import Map from "ol/Map.js";
import View from "ol/View.js";
import GeoJSON from "ol/format/GeoJSON.js";
import VectorLayer from "ol/layer/Vector.js";
import TileLayer from "ol/layer/Tile.js";
import VectorSource from "ol/source/Vector.js";
import WMTS from "ol/source/WMTS.js";
import WMTSTileGrid from "ol/tilegrid/WMTS.js";
import { Fill, Icon, Stroke, Style } from "ol/style.js";
import { Point } from "ol/geom.js";
import Feature from "ol/Feature.js";
import { get as getProjection, transform } from "ol/proj.js";
import { register } from "ol/proj/proj4.js";
import proj4 from "proj4";
const props = defineProps({
  selectedPoint: Object,
  pickPointActive: Boolean,
  visible: Boolean,
});
const emit = defineEmits(["point-picked"]);
const mapEl = ref(null),
  errorMessage = ref(""),
  loading = ref(true);
let map,
  marker,
  resizeObserver,
  disposed = false;
const zone = {
  center: [112.71860003600005, 25.611383039500055],
  targetGeojson: `${import.meta.env.BASE_URL}rsfile/admin-api/infra/file/40/get/zoneJson/ZONE4310210002.json`,
};
const tiandituToken = "309242f368558a0c2bdefa0b7b16ff53";
function registerChinaProjection() {
  proj4.defs(
    "EPSG:4490",
    'GEOGCS["China Geodetic Coordinate System 2000",DATUM["China_2000",SPHEROID["CGCS2000",6378137,298.257222101,AUTHORITY["EPSG","1024"]],AUTHORITY["EPSG","1043"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.017453292519943295,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4490"]]',
  );
  register(proj4);
  const projection = getProjection("EPSG:4490");
  projection.setExtent([-180, -90, 180, 90]);
  return projection;
}

function createTiandituLayer(projection) {
  const projectionExtent = projection.getExtent();
  const size = projectionExtent[2] - projectionExtent[0];
  const resolutions = [];
  const matrixIds = [];

  for (let level = 1; level < 19; level += 1) {
    resolutions[level] = size / (256 * 2 ** level);
    matrixIds[level] = level;
  }

  return new TileLayer({
    source: new WMTS({
      url: `https://t6.tianditu.gov.cn/img_c/wmts?tk=${tiandituToken}`,
      layer: "img",
      matrixSet: "c",
      format: "tiles",
      projection,
      requestEncoding: "KVP",
      style: "default",
      tileGrid: new WMTSTileGrid({
        origin: [-180, 90],
        resolutions,
        matrixIds,
      }),
      crossOrigin: "anonymous",
    }),
  });
}

function createZoneStyle() {
  return new Style({
    fill: new Fill({ color: "rgba(32, 193, 168, 0.16)" }),
    stroke: new Stroke({ color: "#4cddc1", width: 3 }),
  });
}

function createMarkerLayer() {
  marker = new Feature({
    geometry: props.selectedPoint
      ? new Point(
          transform(
            [props.selectedPoint.longitude, props.selectedPoint.latitude],
            "EPSG:4326",
            "EPSG:4490",
          ),
        )
      : undefined,
  });

  marker.setStyle(
    new Style({
      image: new Icon({
        anchor: [0.5, 1],
        src:
          "data:image/svg+xml;utf8," +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="56" viewBox="0 0 44 56"><path d="M22 54S4 35.8 4 21.8C4 11.4 12.1 3 22 3s18 8.4 18 18.8C40 35.8 22 54 22 54Z" fill="#1b6bff" stroke="#fff" stroke-width="4"/><circle cx="22" cy="22" r="6" fill="#bff6ff"/></svg>',
          ),
      }),
    }),
  );

  return new VectorLayer({
    source: new VectorSource({ features: [marker] }),
    zIndex: 20,
  });
}

async function loadZoneLayer() {
  try {
    let boundaryData,
      lastError = null;
    for (let attempt = 0; attempt < 3 && !boundaryData; attempt += 1) {
      try {
        const response = await fetch(zone.targetGeojson, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("示范区参考边界暂不可用");
        boundaryData = await response.json();
      } catch (error) {
        lastError = error;
        if (attempt < 2)
          await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
      }
    }
    if (!boundaryData)
      throw lastError || new Error("示范区参考边界暂不可用");
    const features = new GeoJSON().readFeatures(boundaryData, {
      dataProjection: "EPSG:4326",
      featureProjection: "EPSG:4490",
    });
    if (disposed) return;
    const source = new VectorSource({ features });
    map.addLayer(
      new VectorLayer({ source, style: createZoneStyle(), zIndex: 10 }),
    );
    if (!props.selectedPoint && features.length)
      map
        .getView()
        .fit(source.getExtent(), {
          padding: [120, 80, 100, 80],
          duration: 0,
          maxZoom: 15,
        });
  } catch (e) {
    if (!disposed) errorMessage.value = e.message;
  } finally {
    loading.value = false;
  }
}
function handleMapClick(event) {
  if (!props.pickPointActive) return;
  const [longitude, latitude] = transform(
    event.coordinate,
    "EPSG:4490",
    "EPSG:4326",
  );
  emit("point-picked", { longitude, latitude });
}
function centerOnPoint() {
  if (!map) return;
  const coords = props.selectedPoint
    ? [props.selectedPoint.longitude, props.selectedPoint.latitude]
    : zone.center;
  map
    .getView()
    .animate({
      center: transform(coords, "EPSG:4326", "EPSG:4490"),
      zoom: 15,
      duration: 300,
    });
}
function updatePoint() {
  if (!marker) return;
  if (props.selectedPoint) {
    marker.setGeometry(
      new Point(
        transform(
          [props.selectedPoint.longitude, props.selectedPoint.latitude],
          "EPSG:4326",
          "EPSG:4490",
        ),
      ),
    );
    centerOnPoint();
  } else marker.setGeometry(undefined);
}
function zoom(delta) {
  if (map)
    map
      .getView()
      .animate({ zoom: map.getView().getZoom() + delta, duration: 200 });
}
onMounted(() => {
  const projection = registerChinaProjection();
  map = new Map({
    target: mapEl.value,
    layers: [createTiandituLayer(projection), createMarkerLayer()],
    view: new View({
      projection,
      center: transform(zone.center, "EPSG:4326", "EPSG:4490"),
      zoom: 13,
      minZoom: 4,
      maxZoom: 18,
    }),
    controls: [],
  });
  map.on("singleclick", handleMapClick);
  resizeObserver = new ResizeObserver(() => map?.updateSize());
  resizeObserver.observe(mapEl.value);
  updatePoint();
  loadZoneLayer();
});
watch(() => props.selectedPoint, updatePoint);
watch(
  () => props.visible,
  async (v) => {
    if (v) {
      await nextTick();
      map?.updateSize();
    }
  },
);
onBeforeUnmount(() => {
  disposed = true;
  resizeObserver?.disconnect();
  map?.un("singleclick", handleMapClick);
  map?.setTarget(undefined);
});
</script>
<template>
  <div class="real-map-container">
    <div
      ref="mapEl"
      class="real-map"
      :class="{ 'point-pick-active': pickPointActive }"
    ></div>
    <div class="map-controls">
      <button aria-label="放大地图" @click="zoom(1)">
        <PhPlus :size="19" /></button
      ><button aria-label="缩小地图" @click="zoom(-1)">
        <PhMinus :size="19" /></button
      ><button aria-label="回到分析位置" @click="centerOnPoint">
        <PhCrosshair :size="20" />
      </button>
    </div>
    <span class="map-attribution">影像 © 天地图 · CGCS2000</span>
    <div v-if="loading" class="map-status">正在载入参考边界…</div>
    <div v-else-if="errorMessage" class="map-status">
      <PhWarningCircle :size="15" />{{ errorMessage }}；仍可地图选点
    </div>
  </div>
</template>
