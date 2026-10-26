const DEFAULT_LAYERS = {
  province: "HNS_NHS:hunan_province",
  city: "HNS_NHS:hunan_prefecture",
  county: "HNS_NHS:hunan_county",
};
const LAYER_FIELDS = {
  province: "province_code,province_name",
  city: "province_code,city_code,city_name",
  county: "city_code,county_code,county_name",
};

const baseUrl = (import.meta.env.VITE_GEOSERVER_URL || "/wrfx/geoserver").replace(/\/$/, "");
const cultivatedLayerCache = new Map();

function getProperty(properties, candidates, pattern) {
  for (const key of candidates) {
    const found = Object.keys(properties).find((item) => item.toLowerCase() === key.toLowerCase());
    if (found && properties[found] != null) return properties[found];
  }
  const key = Object.keys(properties).find((item) => pattern.test(item));
  return key ? properties[key] : "";
}

function normalizeFeature(feature, level) {
  const properties = feature.properties || {};
  const levelFields = {
    province: { name: "province_name", code: "province_code" },
    city: { name: "city_name", code: "city_code" },
    county: { name: "county_name", code: "county_code" },
  }[level];
  const name = String(getProperty(properties,
    [levelFields.name, "name", "NAME", "省", "市", "县", "区", "名称", "县级", "地名"],
    /name|名称|省名|市名|县名|区名/i,
  ) || "").trim();
  const code = String(getProperty(properties,
    [levelFields.code, "adcode", "行政区划代码", "区划代码", "code", "行政代码", "gb", "id"],
    /adcode|行政.*代码|区划.*码|(?:province|city|county)_code|^code$|^id$/i,
  ) || "").trim();
  return { ...feature, properties, _region: { level, name, code } };
}

async function fetchLayer(level) {
  const params = new URLSearchParams({
    service: "WFS", version: "1.1.0", request: "GetFeature",
    typeName: DEFAULT_LAYERS[level], outputFormat: "application/json", srsName: "EPSG:4326",
    maxFeatures: "2000",
    propertyName: LAYER_FIELDS[level],
  });
  const response = await fetch(`${baseUrl}/ows?${params}`);
  if (!response.ok) throw new Error(`${DEFAULT_LAYERS[level]} 请求失败（HTTP ${response.status}）`);
  const data = await response.json();
  if (!Array.isArray(data.features)) throw new Error(data.message || `${DEFAULT_LAYERS[level]} 未返回 GeoJSON 要素`);
  return data.features.map((feature) => normalizeFeature(feature, level)).filter((item) => item._region.name);
}

export async function loadAdministrativeBoundary(region) {
  const { level, code } = region?._region || {};
  if (level !== "county" || !code) throw new Error("所选区县缺少有效区划代码，无法加载边界。");
  const params = new URLSearchParams({
    service: "WFS", version: "1.1.0", request: "GetFeature",
    typeName: DEFAULT_LAYERS.county, outputFormat: "application/json", srsName: "EPSG:4326",
    maxFeatures: "1", CQL_FILTER: `county_code='${code.replace(/'/g, "''")}'`,
  });
  const response = await fetch(`${baseUrl}/ows?${params}`);
  if (!response.ok) throw new Error(`区县边界加载失败（HTTP ${response.status}）`);
  const data = await response.json();
  if (!data.features?.[0]?.geometry) throw new Error(`地图服务没有返回${region._region.name}的边界几何。`);
  return data.features[0];
}

export async function findCultivatedPlotLayer(region) {
  const code = region?._region?.code;
  if (!/^\d{6}$/.test(code || "")) throw new Error("所选区县没有有效的 6 位行政区编码。");
  if (cultivatedLayerCache.has(code)) return cultivatedLayerCache.get(code);
  const params = new URLSearchParams({ service: "WMS", version: "1.1.0", request: "GetCapabilities" });
  const response = await fetch(`${baseUrl}/HNS_NHS/wms?${params}`);
  if (!response.ok) throw new Error(`耕地图斑图层目录读取失败（HTTP ${response.status}）`);
  const xml = new DOMParser().parseFromString(await response.text(), "text/xml");
  if (xml.querySelector("parsererror")) throw new Error("GeoServer 返回的 WMS 图层目录无法解析。");
  const match = [...xml.getElementsByTagName("Name")]
    .map((node) => node.textContent.trim())
    .find((name) => name.startsWith(`${code}_`) && name.includes("耕地图斑"));
  cultivatedLayerCache.set(code, match || null);
  return match || null;
}

/** Fetch only cultivated plot features intersecting the selected polygon. */
export async function loadCultivatedPlots(layerName, ring) {
  if (!layerName || !Array.isArray(ring) || ring.length < 4) {
    throw new Error("耕地图斑查询参数无效，请重新绘制范围。");
  }
  const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring
    : [...ring, ring[0]];
  // GeoServer's WFS CQL parser expects EPSG:4326 axis order (lat, lon).
  const points = closed.map(([longitude, latitude]) => `${latitude} ${longitude}`).join(",");
  const params = new URLSearchParams({
    service: "WFS", version: "1.1.0", request: "GetFeature",
    typeName: layerName, outputFormat: "application/json", srsName: "EPSG:4326",
    maxFeatures: "10000",
    CQL_FILTER: `INTERSECTS(wkb_geometry,POLYGON((${points})))`,
  });
  const response = await fetch(`${baseUrl}/ows?${params}`);
  if (!response.ok) throw new Error(`耕地图斑查询失败（HTTP ${response.status}）。`);
  const data = await response.json();
  if (!Array.isArray(data.features)) throw new Error(data.message || "GeoServer 未返回耕地图斑要素。");
  return { features: data.features.filter((feature) => feature.geometry), truncated: data.features.length >= 10000 };
}

/** Find a single county containing the entire drawn polygon. */
export async function findCountyForPolygon(ring) {
  if (!Array.isArray(ring) || ring.length < 4) throw new Error("圈选范围无效，请重新绘制。");
  const closed = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring : [...ring, ring[0]];
  // This GeoServer publishes EPSG:4326 and interprets CQL WKT coordinates
  // in latitude/longitude axis order (verified against its WFS endpoint).
  const points = closed.map(([longitude, latitude]) => `${latitude} ${longitude}`).join(",");
  const polygon = `POLYGON((${points}))`;
  const query = async (predicate) => {
    const params = new URLSearchParams({
      service: "WFS", version: "1.1.0", request: "GetFeature", typeName: DEFAULT_LAYERS.county,
      outputFormat: "application/json", srsName: "EPSG:4326", maxFeatures: "10",
      CQL_FILTER: `${predicate}(geom,${polygon})`,
    });
    const response = await fetch(`${baseUrl}/ows?${params}`);
    if (!response.ok) throw new Error(`圈选范围对应区县查询失败（HTTP ${response.status}）。`);
    const data = await response.json();
    return data.features || [];
  };
  const containing = await query("CONTAINS");
  if (containing.length === 1) return normalizeFeature(containing[0], "county");
  const intersecting = await query("INTERSECTS");
  const names = [...new Set(intersecting.map((feature) => feature.properties?.county_name).filter(Boolean))];
  if (names.length > 1) throw new Error("圈选范围跨越了多个区县。请将范围缩小到单个区县内后重新绘制。");
  if (names.length === 1) throw new Error(`圈选范围没有完全位于${names[0]}区县内。请缩小范围，并与区县边界保持距离后重新绘制。`);
  throw new Error("圈选范围没有落在湖南省的区县范围内，请调整位置后重新绘制。");
}

export async function loadAdministrativeRegions() {
  try {
    const [provinces, cities, counties] = await Promise.all([
      fetchLayer("province"), fetchLayer("city"), fetchLayer("county"),
    ]);
    if (!provinces.length || !cities.length || !counties.length) {
      throw new Error("地图服务的行政区图层为空，请检查 GeoServer 中的湖南省行政区图层发布状态。");
    }
    return { provinces, cities, counties };
  } catch (error) {
    const hint = error instanceof TypeError
      ? "无法连接地图服务。请确认本机 GeoServer 已启动，并已发布 HNS_NHS:hunan_province、hunan_prefecture、hunan_county 图层。"
      : error.message;
    throw new Error(hint);
  }
}

export function filterByParent(features, parent) {
  if (!parent) return features;
  const parentCode = parent._region.code.replace(/\D/g, "");
  if (parentCode) {
    const matches = features.filter(({ _region }) => _region.code.replace(/\D/g, "").startsWith(parentCode.slice(0, parent._region.level === "province" ? 2 : 4)));
    if (matches.length) return matches;
  }
  const parentName = parent._region.name.replace(/省|市|自治州|地区|盟/g, "");
  return features.filter(({ properties }) => Object.values(properties).some((value) =>
    typeof value === "string" && value.replace(/省|市|自治州|地区|盟/g, "").includes(parentName),
  ));
}

export function displayName(feature) {
  return feature?._region.name || "";
}

export function geoserverEndpoint() {
  return baseUrl;
}
