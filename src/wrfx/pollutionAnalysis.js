import GeoJSON from "ol/format/GeoJSON.js";

export const pollutionMetrics = [
  { key: "soilStcd", label: "土壤镉", group: "soil", excel: "土壤总镉", unit: "mg/kg" },
  { key: "soilStas", label: "土壤砷", group: "soil", excel: "土壤总砷", unit: "mg/kg" },
  { key: "ntCd", label: "稻米镉", group: "rice", excel: "农产品总镉", unit: "mg/kg" },
  { key: "naAs", label: "稻米砷", group: "rice", excel: "农产品总砷", unit: "mg/kg" },
  { key: "soilSph", label: "土壤 pH", group: "property", excel: "土壤pH", unit: "" },
  { key: "soilSom", label: "土壤有机质", group: "property", excel: "土壤有机质", unit: "g/kg" },
];

export function pointsInsideBoundary(points, boundary) {
  if (!boundary) return points;
  const features = new GeoJSON().readFeatures(boundary, { dataProjection: "EPSG:4326", featureProjection: "EPSG:4326" });
  const geometries = features.map(feature => feature.getGeometry()).filter(Boolean);
  if (!geometries.length) return points;
  return points.filter(point => geometries.some(geometry => geometry.intersectsCoordinate([Number(point.lon), Number(point.lat)])));
}

export function withSupplementPoints(points, uploaded) {
  if (!uploaded) return points;
  return points.map(point => {
    const serial = Number(String(point.samplingPointsCode || "").slice(-5));
    const row = uploaded.get(serial);
    if (!row) return point;
    return Object.fromEntries([
      ...Object.entries(point),
      ...pollutionMetrics.filter(metric => row[metric.excel] !== "" && row[metric.excel] != null)
        .map(metric => [metric.key, row[metric.excel]]),
    ]);
  });
}

export function summarizeMetric(points, key) {
  const values = points.map(point => Number(point[key])).filter((value, index) =>
    points[index][key] !== "" && points[index][key] != null && Number.isFinite(value)).sort((a, b) => a - b);
  if (!values.length) return { count: 0, mean: null, min: null, max: null, stddev: null, bins: [] };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const stddev = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  const min = values[0];
  const max = values.at(-1);
  const boundaries = [0.25, 0.5, 0.75].map(ratio => values[Math.min(values.length - 1, Math.floor(values.length * ratio))]);
  const edges = [min, ...boundaries, max];
  const bins = [0, 1, 2, 3].map(index => ({
    start: edges[index], end: edges[index + 1],
    count: values.filter(value => index === 3 ? value >= edges[index] : value >= edges[index] && value < edges[index + 1]).length,
  }));
  return { count: values.length, mean, min, max, stddev, bins, boundaries };
}

export function metricBin(value, boundaries) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return -1;
  return boundaries.findIndex(boundary => Number(value) < boundary) === -1 ? 3
    : boundaries.findIndex(boundary => Number(value) < boundary);
}
