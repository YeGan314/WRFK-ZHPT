<script setup>
import { onBeforeUnmount, onMounted, watch } from "vue";
import Map from "ol/Map.js";
import View from "ol/View.js";
import TileLayer from "ol/layer/Tile.js";
import TileWMS from "ol/source/TileWMS.js";
import VectorLayer from "ol/layer/Vector.js";
import VectorSource from "ol/source/Vector.js";
import WMTS from "ol/source/WMTS.js";
import WMTSTileGrid from "ol/tilegrid/WMTS.js";
import Draw from "ol/interaction/Draw.js";
import GeoJSON from "ol/format/GeoJSON.js";
import Feature from "ol/Feature.js";
import Point from "ol/geom/Point.js";
import Polygon from "ol/geom/Polygon.js";
import { toLonLat } from "ol/proj.js";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style.js";
import { getArea } from "ol/sphere.js";
import { get as getProjection } from "ol/proj.js";
import { apply as applyTransform } from "ol/transform.js";
import { register } from "ol/proj/proj4.js";
import proj4 from "proj4";
import { geoserverEndpoint } from "../geoServer.js";

const props = defineProps({ drawing: Boolean, picking: Boolean });
const emit = defineEmits(["polygon-selected", "point-picked"]);
let map;
let drawInteraction;
let vectorSource;
let baseLayer;
let provinceBoundaryLayer;
let cityBoundaryLayer;
let countyBoundaryLayer;
let townshipBoundaryLayer;
let villageBoundaryLayer;
let scopeLayer;
let pointSource;
let pointLayer;
let maskSource;
let maskLayer;
let scopeMaskCoordinates = null;
let cultivatedPlotLayer;
let cultivatedPlotSource;
let resizeObserver;
const token = "309242f368558a0c2bdefa0b7b16ff53";
const projection = "EPSG:4490";

function createImageryLayer() {
  const proj = getProjection(projection);
  const extent = proj.getExtent();
  const size = extent[2] - extent[0];
  const resolutions = [];
  const matrixIds = [];
  for (let level = 1; level < 19; level += 1) {
    resolutions[level] = size / (256 * 2 ** level);
    matrixIds[level] = level;
  }
  return new TileLayer({
    source: new WMTS({
      url: `https://t6.tianditu.gov.cn/img_c/wmts?tk=${token}`,
      layer: "img",
      matrixSet: "c",
      format: "tiles",
      projection: proj,
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

function beginDraw() {
  if (!map || drawInteraction) return;
  vectorSource.clear();
  drawInteraction = new Draw({ source: vectorSource, type: "Polygon" });
  map.addInteraction(drawInteraction);
  drawInteraction.on("drawend", (event) => {
    const geometry = event.feature.getGeometry();
    const areaMu = getArea(geometry, { projection }) / 666.6666667;
    const coordinates = geometry.getCoordinates()[0];
    emit("polygon-selected", { areaMu, coordinates });
    window.setTimeout(() => stopDraw(), 0);
  });
}

function stopDraw() {
  if (map && drawInteraction) map.removeInteraction(drawInteraction);
  drawInteraction = null;
}

function clearDrawing() {
  stopDraw();
  vectorSource?.clear();
}

function showAdministrativeBoundary(feature, maxZoom = 12) {
  if (!map || !vectorSource || (!feature?.geometry && feature?.type !== "FeatureCollection")) return;
  stopDraw();
  vectorSource.clear();
  const format = new GeoJSON();
  const boundaries = feature.type === "FeatureCollection"
    ? format.readFeatures(feature, { dataProjection: "EPSG:4326", featureProjection: projection })
    : [format.readFeature(feature, {
    dataProjection: "EPSG:4326",
    featureProjection: projection,
  })];
  boundaries.forEach((boundary) => boundary.set("administrativeBoundary", true));
  vectorSource.addFeatures(boundaries);
  const extent = vectorSource.getExtent();
  map.getView().fit(extent, { padding: [80, 80, 80, 80], duration: 500, maxZoom });
}

function setAdministrativeContext({ province, city, county, township, village } = {}) {
  const code = (value) => String(value?._region.code || "").replace(/'/g, "''");
  const exact = (field, value) => value ? `${field}='${code(value)}'` : "INCLUDE";
  const startsWith = (field, value, length) => value?._region.code
    ? `\"${field}\" LIKE '${code(value).slice(0, length)}%'`
    : "INCLUDE";
  provinceBoundaryLayer?.getSource().updateParams({ CQL_FILTER: exact("province_code", province) });
  cityBoundaryLayer?.getSource().updateParams({ CQL_FILTER: city ? exact("city_code", city) : exact("province_code", province) });
  countyBoundaryLayer?.getSource().updateParams({ CQL_FILTER: county ? exact("county_code", county) : exact("city_code", city) });
  townshipBoundaryLayer?.getSource().updateParams({
    CQL_FILTER: township ? exact('"乡镇码"', township) : startsWith("乡镇码", county || city, county ? 6 : 4),
  });
  const villageFilter = village
    ? `CJDCQDM='${code(village)}' AND XZXZQDM='${String(village._region.parentCode || "").replace(/'/g, "''")}'`
    : township
      ? `(XZXZQDM LIKE '${code(township).slice(0, 9)}%' OR (XZXZQMC='${String(township._region.name).replace(/'/g, "''")}' AND XZXZQDM LIKE '${code(township).slice(0, 6)}%'))`
      : startsWith("XZXZQDM", county || city, county ? 6 : 4);
  villageBoundaryLayer?.getSource().updateParams({ CQL_FILTER: villageFilter });
  cityBoundaryLayer?.setVisible(Boolean(province));
  countyBoundaryLayer?.setVisible(Boolean(city));
  townshipBoundaryLayer?.setVisible(Boolean(county));
  villageBoundaryLayer?.setVisible(Boolean(township));
}

function removeCultivatedPlotLayer() {
  if (cultivatedPlotLayer && map) map.removeLayer(cultivatedPlotLayer);
  cultivatedPlotLayer = null;
  cultivatedPlotSource = null;
}

function readClipGeometries(clipBoundary) {
  if (!clipBoundary) return [];
  if (typeof clipBoundary.getType === "function") return [clipBoundary];
  const format = new GeoJSON();
  const dataProjection = clipBoundary.dataProjection || "EPSG:4326";
  if (clipBoundary.type === "FeatureCollection" || clipBoundary.type === "Feature") {
    return format.readFeatures(clipBoundary, { dataProjection, featureProjection: projection })
      .map((feature) => feature.getGeometry()).filter(Boolean);
  }
  return [format.readGeometry(clipBoundary, { dataProjection, featureProjection: projection })];
}

function polygonRings(geometry) {
  if (geometry.getType() === "Polygon") return geometry.getCoordinates();
  if (geometry.getType() === "MultiPolygon") return geometry.getCoordinates().flat();
  if (geometry.getType() === "GeometryCollection") return geometry.getGeometries().flatMap(polygonRings);
  return [];
}

function clipRenderedLayer(layer, geometries) {
  if (!geometries.length) return;
  layer.on("prerender", (event) => {
    const context = event.context;
    if (!context?.beginPath || !context?.clip) return;
    context.save();
    context.beginPath();
    for (const geometry of geometries) {
      for (const ring of polygonRings(geometry)) {
        ring.forEach((coordinate, index) => {
          const mapPixel = map.getPixelFromCoordinate(coordinate);
          if (!mapPixel) return;
          const pixel = applyTransform(event.inversePixelTransform, mapPixel);
          if (index === 0) context.moveTo(pixel[0], pixel[1]);
          else context.lineTo(pixel[0], pixel[1]);
        });
        context.closePath();
      }
    }
    context.clip("evenodd");
  });
  layer.on("postrender", (event) => event.context?.restore?.());
}

function setCultivatedPlotLayer(layerName, clipBoundary = null) {
  removeCultivatedPlotLayer();
  if (!map || !layerName) return;
  const clipGeometries = readClipGeometries(clipBoundary);
  cultivatedPlotLayer = new TileLayer({
    opacity: 0.92,
    source: new TileWMS({
      url: `${geoserverEndpoint()}/HNS_NHS/wms`,
      params: { LAYERS: layerName, STYLES: "", FORMAT: "image/png", TRANSPARENT: true, VERSION: "1.1.0" },
      serverType: "geoserver",
      transition: 0,
    }),
  });
  clipRenderedLayer(cultivatedPlotLayer, clipGeometries);
  const layers = map.getLayers();
  layers.insertAt(Math.max(0, layers.getLength() - 1), cultivatedPlotLayer);
  if (scopeMaskCoordinates) layers.insertAt(Math.max(0, layers.getLength() - 1), maskLayer);
}

function setCultivatedPlotFeatures(features = []) {
  removeCultivatedPlotLayer();
  if (!map || !features?.length) return;
  cultivatedPlotSource = new VectorSource({
    features: new GeoJSON().readFeatures({ type: "FeatureCollection", features }, {
      dataProjection: "EPSG:4326",
      featureProjection: projection,
    }),
  });
  cultivatedPlotLayer = new VectorLayer({
    source: cultivatedPlotSource,
    style: new Style({
      fill: new Fill({ color: "rgba(154, 255, 66, 0.42)" }),
      stroke: new Stroke({ color: "#c9ff55", width: 1.25 }),
    }),
  });
  const layers = map.getLayers();
  layers.insertAt(Math.max(0, layers.getLength() - 1), cultivatedPlotLayer);
  if (scopeMaskCoordinates) layers.insertAt(Math.max(0, layers.getLength() - 1), maskLayer);
}

function updateScopeMask() {
  if (!map || !maskSource || !scopeMaskCoordinates) return;
  const extent = map.getView().calculateExtent(map.getSize());
  const [minX, minY, maxX, maxY] = extent;
  const outer = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]];
  const ring = scopeMaskCoordinates;
  const inner = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring : [...ring, ring[0]];
  maskSource.clear();
  maskSource.addFeature(new Feature(new Polygon([outer, inner])));
}

function setScopeMask(coordinates = null) {
  scopeMaskCoordinates = coordinates;
  maskSource?.clear();
  if (!coordinates || !coordinates.length) return;
  updateScopeMask();
  if (map && !map.getLayers().getArray().includes(maskLayer)) {
    map.getLayers().insertAt(Math.max(0, map.getLayers().getLength() - 1), maskLayer);
  }
}

function clearAdministrativeBoundary() {
  vectorSource?.clear();
}

function zoom(delta) {
  const view = map?.getView();
  if (view) view.animate({ zoom: Math.max(3, Math.min(17, view.getZoom() + delta)), duration: 180 });
}

function resetView() {
  map?.getView().animate({ center: [112.8, 27.3], zoom: 8, duration: 260 });
}

function showPickedPoint({ longitude, latitude }) {
  if (!map || !pointSource || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
  pointSource.clear();
  pointSource.addFeature(new Feature(new Point([longitude, latitude])));
  map.getView().animate({ center: [longitude, latitude], zoom: Math.max(map.getView().getZoom(), 13), duration: 450 });
}

function clearPickedPoint() {
  pointSource?.clear();
}

watch(() => props.drawing, (drawing) => drawing ? beginDraw() : stopDraw());

onMounted(() => {
  proj4.defs(
    projection,
    'GEOGCS["China Geodetic Coordinate System 2000",DATUM["China_2000",SPHEROID["CGCS2000",6378137,298.257222101,AUTHORITY["EPSG","1024"]],AUTHORITY["EPSG","1043"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.017453292519943295,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4490"]]',
  );
  register(proj4);
  getProjection(projection).setExtent([-180, -90, 180, 90]);
  vectorSource = new VectorSource();
  scopeLayer = new VectorLayer({
    source: vectorSource,
    style: (feature) => new Style({
      fill: new Fill({ color: feature.get("administrativeBoundary") ? "rgba(0, 0, 0, 0)" : "rgba(0, 218, 236, 0.16)" }),
      stroke: new Stroke({ color: "#28f2ef", width: 3 }),
    }),
  });
  pointSource = new VectorSource();
  pointLayer = new VectorLayer({
    source: pointSource,
    style: new Style({
      image: new CircleStyle({
        radius: 8,
        fill: new Fill({ color: "#06dce8" }),
        stroke: new Stroke({ color: "#e2ffff", width: 3 }),
      }),
    }),
  });
  maskSource = new VectorSource();
  maskLayer = new VectorLayer({
    source: maskSource,
    style: new Style({ fill: new Fill({ color: "rgba(3, 18, 27, 0.72)" }) }),
  });
  const wmsLayer = (layer, opacity, visible) => new TileLayer({
    opacity,
    visible,
    source: new TileWMS({
      url: `${geoserverEndpoint()}/HNS_NHS/wms`,
      params: { LAYERS: `HNS_NHS:hunan_${layer}`, STYLES: "", FORMAT: "image/png", TRANSPARENT: true, VERSION: "1.1.0" },
      serverType: "geoserver",
      transition: 0,
    }),
  });
  provinceBoundaryLayer = wmsLayer("province", 0.92, true);
  cityBoundaryLayer = wmsLayer("prefecture", 0.72, false);
  countyBoundaryLayer = wmsLayer("county", 0.56, false);
  townshipBoundaryLayer = wmsLayer("township", 0.8, false);
  villageBoundaryLayer = wmsLayer("village", 0.9, false);
  baseLayer = createImageryLayer();
  map = new Map({
    target: "wrfx-map-canvas",
    layers: [baseLayer, provinceBoundaryLayer, cityBoundaryLayer, countyBoundaryLayer, townshipBoundaryLayer, villageBoundaryLayer, scopeLayer, pointLayer],
    view: new View({ projection, center: [112.8, 27.3], zoom: 8, minZoom: 3, maxZoom: 18 }),
    controls: [],
  });
  map.on("singleclick", (event) => {
    if (!props.picking || drawInteraction) return;
    const [longitude, latitude] = toLonLat(event.coordinate, projection);
    emit("point-picked", { longitude, latitude });
  });
  map.on("moveend", updateScopeMask);
  resizeObserver = new ResizeObserver(() => map?.updateSize());
  resizeObserver.observe(document.querySelector(".wrfx-map-panel"));
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  map?.setTarget(undefined);
  map = null;
});

defineExpose({ startDrawing: beginDraw, stopDrawing: stopDraw, clearDrawing, showAdministrativeBoundary, clearAdministrativeBoundary, setAdministrativeContext, setCultivatedPlotLayer, setCultivatedPlotFeatures, setScopeMask, showPickedPoint, clearPickedPoint, zoom, resetView });
</script>

<template><div id="wrfx-map-canvas" class="wrfx-map-canvas" :class="{ 'point-pick-active': picking }"></div></template>
