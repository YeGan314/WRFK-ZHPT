<script setup>
import { computed, onMounted, ref } from "vue";
import {
  PhPlant,
  PhMapPin,
  PhMagnifyingGlass,
  PhBuildings,
  PhHandshake,
  PhPolygon,
  PhArrowRight,
  PhArrowCounterClockwise,
  PhRuler,
  PhCrosshair,
  PhPlus,
  PhMinus,
  PhInfo,
  PhMapPinLine,
  PhCheckCircle,
  PhDatabase,
  PhSlidersHorizontal,
  PhMapTrifold,
} from "@phosphor-icons/vue";
import ScopeMap from "./components/ScopeMap.vue";
import { displayName, filterByParent, findCountyForPolygon, findCultivatedPlotLayer, geoserverEndpoint, loadAdministrativeBoundary, loadAdministrativeRegions } from "./geoServer.js";
import { normalizeLocations } from "../lib/analysis.js";

const mode = ref("administrative");
const province = ref("");
const city = ref("");
const county = ref("");
const township = ref("");
const village = ref("");
const administrativeSearchQuery = ref("");
const administrativeSearchOpen = ref(false);
const searchedVillage = ref(null);
const regionData = ref({ provinces: [], cities: [], counties: [], townships: [], villages: [] });
const regionsLoading = ref(true);
const regionsError = ref("");
const scopeLoading = ref(false);
const locationQuery = ref("");
const searchResults = ref([]);
const searching = ref(false);
const searchNotice = ref("");
const searchController = ref(null);
const selectedScope = ref(null);
const drawing = ref(false);
const mapRef = ref(null);
const notice = ref("");
const confirmed = ref(false);

const modes = [
  { id: "administrative", label: "行政区域", icon: PhBuildings },
  { id: "cooperative", label: "合作社点位", icon: PhHandshake },
  { id: "polygon", label: "地图圈选", icon: PhPolygon },
];
const provinceOptions = computed(() => regionData.value.provinces);
const cityOptions = computed(() => filterByParent(regionData.value.cities, selectedProvince.value));
const countyOptions = computed(() => filterByParent(regionData.value.counties, selectedCity.value));
const townshipOptions = computed(() => filterByParent(regionData.value.townships, selectedCounty.value));
const villageOptions = computed(() => {
  const options = filterByParent(regionData.value.villages, selectedTownship.value);
  if (searchedVillage.value && village.value === searchedVillage.value._region.key
    && !options.some((item) => item._region.key === searchedVillage.value._region.key)) {
    return [...options, searchedVillage.value];
  }
  return options;
});
const selectedProvince = computed(() => regionData.value.provinces.find((item) => displayName(item) === province.value));
const selectedCity = computed(() => cityOptions.value.find((item) => displayName(item) === city.value));
const selectedCounty = computed(() => countyOptions.value.find((item) => displayName(item) === county.value));
const selectedTownship = computed(() => townshipOptions.value.find((item) => item._region.code === township.value));
const selectedVillage = computed(() => villageOptions.value.find((item) => item._region.key === village.value)
  || (searchedVillage.value?._region.key === village.value ? searchedVillage.value : null));
const selectedArea = computed(() => selectedScope.value?.areaMu);
const administrativeMatches = computed(() => {
  const query = administrativeSearchQuery.value.trim().replace(/\s/g, "").toLocaleLowerCase();
  if (query.length < 2) return [];
  const candidates = [
    ...regionData.value.counties,
    ...regionData.value.townships,
    ...regionData.value.villages,
  ].filter((feature) => displayName(feature).replace(/\s/g, "").toLocaleLowerCase().includes(query));
  return candidates
    .map((feature) => ({ feature, path: administrativePath(feature) }))
    .sort((a, b) => Number(displayName(a.feature).replace(/\s/g, "").toLocaleLowerCase() !== query)
      - Number(displayName(b.feature).replace(/\s/g, "").toLocaleLowerCase() !== query))
    .slice(0, 12);
});
const areaText = computed(() => {
  const area = selectedArea.value;
  if (!Number.isFinite(area)) return "待确认";
  return area < 100 ? `${area.toFixed(2)} 亩` : `${(area / 10000).toFixed(2)} 公顷`;
});

function administrativePath(feature) {
  const { level, code, parentCode } = feature._region;
  const digits = String(code || "").replace(/\D/g, "");
  const provinceFor = (cityFeature) => regionData.value.provinces.find((item) =>
    item._region.code === cityFeature?.properties?.province_code,
  ) || regionData.value.provinces.find((item) =>
    String(cityFeature?.properties?.province_code || "").startsWith(item._region.code.slice(0, 2)),
  );
  const cityFor = (countyFeature) => regionData.value.cities.find((item) =>
    item._region.code === countyFeature?.properties?.city_code,
  );
  if (level === "county") {
    const cityFeature = cityFor(feature);
    return { province: provinceFor(cityFeature), city: cityFeature, county: feature };
  }
  if (level === "township") {
    const countyFeature = regionData.value.counties.find((item) => item._region.code === digits.slice(0, 6));
    const cityFeature = cityFor(countyFeature);
    return { province: provinceFor(cityFeature), city: cityFeature, county: countyFeature, township: feature };
  }
  if (level === "village") {
    const villageParent = String(parentCode || "").replace(/\D/g, "");
    const countyFeature = regionData.value.counties.find((item) => item._region.code === villageParent.slice(0, 6));
    const cityFeature = cityFor(countyFeature);
    const townshipFeature = regionData.value.townships.find((item) => item._region.code.replace(/\D/g, "").startsWith(villageParent.slice(0, 9)))
      || regionData.value.townships.find((item) => item._region.code.replace(/\D/g, "").startsWith(villageParent.slice(0, 6))
        && displayName(item) === feature.properties?.XZXZQMC);
    return { province: provinceFor(cityFeature), city: cityFeature, county: countyFeature, township: townshipFeature, village: feature };
  }
  return {};
}

function administrativePathName(path) {
  return [path.province, path.city, path.county, path.township, path.village]
    .filter(Boolean).map(displayName).join(" · ");
}

function chooseAdministrativeMatch(match) {
  const path = match.path;
  administrativeSearchOpen.value = false;
  searchedVillage.value = path.village || null;
  province.value = displayName(path.province);
  city.value = displayName(path.city);
  county.value = displayName(path.county);
  township.value = path.township?._region.code || "";
  village.value = path.village?._region.key || "";
  administrativeSearchQuery.value = displayName(match.feature);
  selectedScope.value = null;
  confirmed.value = false;
  notice.value = "搜索结果已回填，正在自动定位并加载对应边界和耕地图斑…";
  mapRef.value?.clearAdministrativeBoundary();
  mapRef.value?.clearPickedPoint();
  mapRef.value?.setCultivatedPlotLayer(null);
  mapRef.value?.setScopeMask(null);
  mapRef.value?.setAdministrativeContext({
    province: path.province, city: path.city, county: path.county, township: path.township, village: path.village,
  });
  void selectAdministrativeScope();
}

function searchAdministrative() {
  if (administrativeSearchQuery.value.trim().length < 2) {
    notice.value = "请输入至少两个字，再搜索区县、乡镇或村名。";
    return;
  }
  administrativeSearchOpen.value = true;
  if (administrativeMatches.value.length === 1) chooseAdministrativeMatch(administrativeMatches.value[0]);
  else if (!administrativeMatches.value.length) notice.value = "没有找到匹配的行政区名称，请检查输入或尝试简称。";
}

function chooseMode(nextMode) {
  mode.value = nextMode;
  notice.value = "";
  confirmed.value = false;
  if (nextMode !== "polygon") {
    drawing.value = false;
    mapRef.value?.stopDrawing();
  }
  if (nextMode !== "cooperative") {
    searchResults.value = [];
  } else {
    notice.value = "输入合作社名称或地址搜索，也可直接点击右侧地图选择位置。";
  }
  if (nextMode === "polygon") notice.value = "点击“开始圈选”，在地图上依次绘制范围边界，双击结束。";
}

onMounted(async () => {
  regionsLoading.value = true;
  try {
    regionData.value = await loadAdministrativeRegions();
    regionsError.value = "";
  } catch (error) {
    regionsError.value = error.message;
  } finally {
    regionsLoading.value = false;
  }
});

function updateCityOptions() {
  city.value = "";
  county.value = "";
  township.value = "";
  village.value = "";
  searchedVillage.value = null;
  selectedScope.value = null;
  confirmed.value = false;
  mapRef.value?.clearAdministrativeBoundary();
  mapRef.value?.clearPickedPoint();
  mapRef.value?.setCultivatedPlotLayer(null);
  mapRef.value?.setScopeMask(null);
  mapRef.value?.setAdministrativeContext({ province: selectedProvince.value });
}

function updateCountyOptions() {
  county.value = "";
  township.value = "";
  village.value = "";
  searchedVillage.value = null;
  selectedScope.value = null;
  confirmed.value = false;
  mapRef.value?.clearAdministrativeBoundary();
  mapRef.value?.clearPickedPoint();
  mapRef.value?.setCultivatedPlotLayer(null);
  mapRef.value?.setScopeMask(null);
  mapRef.value?.setAdministrativeContext({ province: selectedProvince.value, city: selectedCity.value });
}

function updateTownshipOptions() {
  township.value = "";
  village.value = "";
  searchedVillage.value = null;
  selectedScope.value = null;
  confirmed.value = false;
  mapRef.value?.clearAdministrativeBoundary();
  mapRef.value?.setCultivatedPlotLayer(null);
  mapRef.value?.setScopeMask(null);
  mapRef.value?.setAdministrativeContext({ province: selectedProvince.value, city: selectedCity.value, county: selectedCounty.value });
  if (selectedCounty.value) void selectAdministrativeScope();
}

function updateVillageOptions() {
  village.value = "";
  searchedVillage.value = null;
  selectedScope.value = null;
  confirmed.value = false;
  mapRef.value?.clearAdministrativeBoundary();
  mapRef.value?.setScopeMask(null);
  mapRef.value?.setAdministrativeContext({ province: selectedProvince.value, city: selectedCity.value, county: selectedCounty.value, township: selectedTownship.value });
  if (selectedTownship.value) void selectAdministrativeScope();
}

function updateVillageSelection() {
  searchedVillage.value = null;
  selectedScope.value = null;
  confirmed.value = false;
  mapRef.value?.clearAdministrativeBoundary();
  mapRef.value?.setCultivatedPlotLayer(null);
  mapRef.value?.setScopeMask(null);
  mapRef.value?.setAdministrativeContext({
    province: selectedProvince.value, city: selectedCity.value, county: selectedCounty.value,
    township: selectedTownship.value,
  });
  if (selectedVillage.value) void selectAdministrativeScope();
}

async function selectAdministrativeScope() {
  const targetRegion = selectedVillage.value || selectedTownship.value || selectedCounty.value || selectedCity.value || selectedProvince.value;
  if (!targetRegion) {
    notice.value = regionsError.value || "请至少选择一个行政区级别后再定位范围。";
    return;
  }
  scopeLoading.value = true;
  notice.value = `正在定位${displayName(targetRegion)}并加载边界和耕地图斑…`;
  try {
    const feature = await loadAdministrativeBoundary(targetRegion);
    const zoomByLevel = { province: 8, city: 10, county: 12, township: 14, village: 16 };
    mapRef.value?.clearPickedPoint();
    mapRef.value?.setScopeMask(null);
    mapRef.value?.showAdministrativeBoundary(feature, zoomByLevel[targetRegion._region.level]);
    mapRef.value?.setAdministrativeContext({ province: selectedProvince.value, city: selectedCity.value, county: selectedCounty.value, township: selectedTownship.value, village: selectedVillage.value });
    selectedScope.value = {
      type: "administrative",
      name: [province.value, city.value, county.value, selectedTownship.value && displayName(selectedTownship.value), selectedVillage.value && displayName(selectedVillage.value)].filter(Boolean).join(" "),
      areaMu: null,
      source: "本地 GeoServer 行政区边界与耕地图斑",
    };
    confirmed.value = false;
    if (selectedCounty.value) {
      const plotLayer = await findCultivatedPlotLayer(selectedCounty.value);
      if (plotLayer) {
        mapRef.value?.setCultivatedPlotLayer(plotLayer, feature);
        notice.value = `已定位到${displayName(targetRegion)}，耕地图斑已按所选边界裁切显示。`;
      } else {
        mapRef.value?.setCultivatedPlotLayer(null);
        notice.value = `已显示${displayName(targetRegion)}边界，但 GeoServer 中没有找到${county.value}对应的耕地图斑图层。`;
      }
    } else {
      mapRef.value?.setCultivatedPlotLayer(null);
      notice.value = `已定位并显示${displayName(targetRegion)}边界。`;
    }
  } catch (error) {
    notice.value = error.message;
  } finally {
    scopeLoading.value = false;
  }
}

async function searchCooperative() {
  const keyword = locationQuery.value.trim();
  if (!keyword) {
    searchNotice.value = "请输入合作社名称或地址。";
    searchResults.value = [];
    return;
  }
  searchController.value?.abort();
  const controller = new AbortController();
  searchController.value = controller;
  searching.value = true;
  searchNotice.value = "";
  searchResults.value = [];
  try {
    const configuredBase = import.meta.env.VITE_BASE_PATH || "/jsyy/";
    const apiBase = `${configuredBase.replace(/\/$/, "")}/api/assistant/locations`;
    const response = await fetch(`${apiBase}?keyword=${encodeURIComponent(keyword)}`, { signal: controller.signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || `查询失败（${response.status}）`);
    searchResults.value = normalizeLocations(result.data);

    // Cooperative records are searched through the original platform API;
    // if it has no match, resolve ordinary addresses through TianDiTu.
    if (!searchResults.value.length) {
      const postStr = JSON.stringify({ keyWord: keyword, level: 12, mapBound: "108.5,24.5,114.5,30.5", queryType: 7, start: 0, count: 8, show: 1 });
      const mapResponse = await fetch(`https://api.tianditu.gov.cn/v2/search?postStr=${encodeURIComponent(postStr)}&type=query&tk=309242f368558a0c2bdefa0b7b16ff53`, { signal: controller.signal });
      const mapData = await mapResponse.json().catch(() => ({}));
      const pois = mapData?.pois || mapData?.data?.pois || [];
      searchResults.value = normalizeLocations(pois.map((item) => {
        const [lon, lat] = String(item.lonlat || item.location || "").split(",").map(Number);
        return { ...item, lon, lat, name: item.name || item.address, address: item.address || item.name, source: "tianditu" };
      }));
    }
    searchNotice.value = searchResults.value.length ? "请选择一个搜索结果，或直接在地图上点选。" : "没有找到匹配位置，请换个关键词或在地图上点选。";
  } catch (error) {
    if (error.name !== "AbortError") searchNotice.value = error.message || "位置查询失败，请重试。";
  } finally {
    if (searchController.value === controller) searching.value = false;
  }
}

function selectCooperativePoint(point, source = "合作社/地址检索") {
  const longitude = Number(point.longitude);
  const latitude = Number(point.latitude);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    searchNotice.value = "该结果没有有效的经纬度，请选择其他结果。";
    return;
  }
  const name = point.name || point.address || "合作社点位";
  mode.value = "cooperative";
  selectedScope.value = { type: "cooperative", name, longitude, latitude, address: point.address || "", areaMu: null, source };
  confirmed.value = false;
  searchResults.value = [];
  searchNotice.value = "";
  mapRef.value?.clearAdministrativeBoundary();
  mapRef.value?.setCultivatedPlotLayer(null);
  mapRef.value?.setScopeMask(null);
  mapRef.value?.showPickedPoint({ longitude, latitude });
  notice.value = `已选择${name}（${longitude.toFixed(6)}, ${latitude.toFixed(6)}）。`;
}

function onMapPointPicked(point) {
  if (mode.value !== "cooperative") return;
  selectCooperativePoint({ ...point, name: "地图点选位置" }, "地图点选");
}

function startDrawing() {
  if (mode.value !== "polygon") chooseMode("polygon");
  drawing.value = true;
  notice.value = "请在地图上逐点绘制边界，双击完成圈选。";
  mapRef.value?.startDrawing();
}

async function onPolygonSelected(selection) {
  drawing.value = false;
  selectedScope.value = {
    type: "polygon",
    name: "自定义地图范围",
    areaMu: selection.areaMu,
    source: "地图圈选范围；耕地图斑按圈选边界裁切显示",
    coordinates: selection.coordinates,
  };
  confirmed.value = false;
  mapRef.value?.clearPickedPoint();
  mapRef.value?.setCultivatedPlotLayer(null);
  mapRef.value?.setScopeMask(null);
  scopeLoading.value = true;
  notice.value = "正在识别所属区县并按圈选边界裁切耕地图斑…";
  try {
    const countyFeature = await findCountyForPolygon(selection.coordinates);
    const countyLayer = await findCultivatedPlotLayer(countyFeature);
    if (!countyLayer) {
      notice.value = `已确认圈选范围位于${countyFeature._region.name}，但没有找到编码 ${countyFeature._region.code} 对应的耕地图斑图层。`;
      return;
    }
    mapRef.value?.setCultivatedPlotLayer(countyLayer, {
      type: "Feature",
      dataProjection: "EPSG:4490",
      geometry: { type: "Polygon", coordinates: [selection.coordinates] },
      properties: {},
    });
    mapRef.value?.setScopeMask(selection.coordinates);
    selectedScope.value = { ...selectedScope.value, countyName: countyFeature._region.name, countyCode: countyFeature._region.code };
    notice.value = `已识别为${countyFeature._region.name}（${countyFeature._region.code}），耕地图斑已按圈选边界裁切显示。`;
  } catch (error) {
    selectedScope.value = null;
    mapRef.value?.clearDrawing();
    notice.value = error.message;
  } finally {
    scopeLoading.value = false;
  }
}

function clearScope() {
  selectedScope.value = null;
  confirmed.value = false;
  mapRef.value?.setCultivatedPlotLayer(null);
  mapRef.value?.setScopeMask(null);
  notice.value = mode.value === "polygon" ? "范围已清除，可重新绘制。" : "已清除当前范围。";
  mapRef.value?.clearDrawing();
  mapRef.value?.clearPickedPoint();
}

function confirmScope() {
  if (!selectedScope.value) {
    notice.value = "请先选择一个分析范围。";
    return;
  }
  confirmed.value = true;
  notice.value = "分析范围已确认。生产条件、数据目录及分析接口将在后续页面接入。";
}
</script>

<template>
  <main class="wrfx-shell">
    <header class="wrfx-topbar">
      <div class="wrfx-brand">
        <span class="wrfx-brand-mark"><PhPlant weight="duotone" /></span>
        <div>
          <small>产地重金属污染防控智慧平台</small>
          <strong>污染状况智能分析</strong>
        </div>
      </div>

      <nav class="wrfx-steps" aria-label="分析流程">
        <span class="active"><b>01</b> 范围选择</span>
        <i></i><span><b>02</b> 生产条件</span>
        <i></i><span><b>03</b> 数据核对</span>
        <i></i><span><b>04</b> 污染分析</span>
        <i></i><span><b>05</b> 风险与方案</span>
        <i></i><span><b>06</b> 分析报告</span>
      </nav>

      <div class="wrfx-top-status"><span class="status-light"></span>独立模块 <b>/wrfx</b></div>
    </header>

    <section class="wrfx-workspace">
      <aside class="wrfx-sidebar tech-frame">
        <div class="wrfx-sidebar-head">
          <span class="wrfx-head-icon"><PhMapTrifold weight="duotone" /></span>
          <div><h1>分析范围选择</h1><p>先确定区域，再查看污染状况</p></div>
          <span class="wrfx-live-dot" title="模块已就绪"></span>
        </div>

        <div class="wrfx-sidebar-scroll">
          <div class="wrfx-intro-label"><span></span>第一步 · 确定分析范围</div>
          <h2>从哪里开始分析？</h2>
          <p class="wrfx-intro-copy">选择一个行政区域、合作社点位，或直接在地图上圈定范围。系统将按已授权范围汇总可用数据。</p>

          <div class="wrfx-mode-switch" role="tablist" aria-label="范围选择方式">
            <button v-for="item in modes" :key="item.id" :class="{ active: mode === item.id }" @click="chooseMode(item.id)">
              <component :is="item.icon" weight="bold" />{{ item.label }}
            </button>
          </div>

          <section v-if="mode === 'administrative'" class="wrfx-selection-panel">
            <div class="wrfx-panel-title"><PhBuildings />按行政区选择 <small>逐级定位</small></div>
            <label class="wrfx-field"><span>搜索区县、乡镇或村名</span><div class="wrfx-search-field"><PhMagnifyingGlass /><input v-model="administrativeSearchQuery" placeholder="输入名称，如：衡阳县、井头镇、龙桥村" @input="administrativeSearchOpen = true" @keydown.enter.prevent="searchAdministrative" /><button type="button" aria-label="搜索行政区" :disabled="regionsLoading || !!regionsError" @click="searchAdministrative"><PhArrowRight /></button></div></label>
            <div v-if="administrativeSearchOpen && administrativeSearchQuery.trim().length >= 2 && administrativeMatches.length" class="wrfx-search-results">
              <button v-for="match in administrativeMatches" :key="`${match.feature._region.level}:${match.feature._region.key}`" class="wrfx-search-result" @click="chooseAdministrativeMatch(match)">
                <PhMapPin /><span><strong>{{ displayName(match.feature) }}</strong><small>{{ administrativePathName(match.path) || '无法匹配完整行政区路径' }}</small></span><PhArrowRight class="result-arrow" />
              </button>
            </div>
            <p v-else-if="administrativeSearchOpen && administrativeSearchQuery.trim().length >= 2 && !administrativeMatches.length" class="wrfx-search-message">没有找到匹配名称，请检查输入或尝试简称。</p>
            <p v-else-if="administrativeSearchQuery && administrativeSearchQuery.trim().length < 2" class="wrfx-field-note"><PhInfo /> 请输入至少两个字，可搜索区县、乡镇或村名。</p>
            <label class="wrfx-field"><span>省级区域</span><select v-model="province" :disabled="regionsLoading || !!regionsError" @change="updateCityOptions"><option value="">{{ regionsLoading ? '正在读取地图服务…' : '请选择省级区域' }}</option><option v-for="item in provinceOptions" :key="item._region.code || item._region.name" :value="displayName(item)">{{ displayName(item) }}</option></select></label>
            <label class="wrfx-field"><span>地市</span><select v-model="city" :disabled="!province || !!regionsError" @change="updateCountyOptions"><option value="">请选择地市</option><option v-for="item in cityOptions" :key="item._region.code || item._region.name" :value="displayName(item)">{{ displayName(item) }}</option></select></label>
            <label class="wrfx-field"><span>县（区）</span><select v-model="county" :disabled="!city || !!regionsError || scopeLoading" @change="updateTownshipOptions"><option value="">{{ city ? '请选择县（区）' : '请先选择地市' }}</option><option v-for="item in countyOptions" :key="item._region.code || item._region.name" :value="displayName(item)">{{ displayName(item) }}</option></select></label>
            <label class="wrfx-field"><span>乡镇（街道）</span><select v-model="township" :disabled="!county || !!regionsError || scopeLoading" @change="updateVillageOptions"><option value="">{{ county ? '请选择乡镇（街道）' : '请先选择县（区）' }}</option><option v-for="item in townshipOptions" :key="item._region.code" :value="item._region.code">{{ displayName(item) }}</option></select></label>
            <label class="wrfx-field"><span>村</span><select v-model="village" :disabled="(!township && !searchedVillage) || !!regionsError || scopeLoading" @change="updateVillageSelection"><option value="">{{ township ? '请选择村' : searchedVillage ? '搜索村名已回填' : '请先选择乡镇（街道）' }}</option><option v-for="item in villageOptions" :key="item._region.key" :value="item._region.key">{{ displayName(item) }}</option></select></label>
            <p v-if="regionsLoading" class="wrfx-field-note"><PhInfo /> 正在从本地地图服务读取湖南省、市、区县、乡镇和村界图层。</p>
            <p v-else-if="regionsError" class="wrfx-field-note error"><PhInfo /> {{ regionsError }} 服务地址：{{ geoserverEndpoint() }}</p>
            <p v-else-if="scopeLoading" class="wrfx-field-note"><PhInfo /> 正在自动定位并加载对应边界和耕地图斑…</p>
            <p v-else class="wrfx-field-note"><PhInfo /> 选择县、乡镇或村后会自动定位并加载对应边界及耕地图斑。</p>
          </section>

          <section v-else-if="mode === 'cooperative'" class="wrfx-selection-panel">
            <div class="wrfx-panel-title"><PhHandshake />按合作社点位选择</div>
            <label class="wrfx-search-field"><PhMagnifyingGlass /><input v-model="locationQuery" placeholder="输入合作社名称、地名或地址" @keydown.enter.prevent="searchCooperative" /><button aria-label="搜索" :disabled="searching" @click="searchCooperative"><PhArrowRight v-if="!searching" /><span v-else class="wrfx-search-spinner"></span></button></label>
            <p class="wrfx-field-note"><PhMapPinLine /> 点击右侧地图即可选点；也可搜索合作社名称或地址。</p>
            <p v-if="searchNotice" class="wrfx-search-message" :class="{ error: !searchResults.length && !searching }">{{ searching ? '正在搜索…' : searchNotice }}</p>
            <div v-if="searchResults.length" class="wrfx-search-results">
              <button v-for="(result, index) in searchResults" :key="`${result.longitude},${result.latitude},${index}`" class="wrfx-search-result" @click="selectCooperativePoint(result)">
                <PhMapPin /><span><strong>{{ result.name }}</strong><small>{{ result.address || `${result.longitude.toFixed(6)}, ${result.latitude.toFixed(6)}` }}</small></span><PhArrowRight class="result-arrow" />
              </button>
            </div>
          </section>

          <section v-else class="wrfx-selection-panel">
            <div class="wrfx-panel-title"><PhPolygon />地图自定义范围 <small>绘制多边形</small></div>
            <p class="wrfx-mode-description">在右侧地图中沿区域边界逐点绘制，双击结束。完成后显示地图估算面积。</p>
            <button class="wrfx-primary-button" :class="{ drawing }" @click="startDrawing"><PhPolygon />{{ drawing ? "正在地图上绘制…" : "开始圈选区域" }}<PhArrowRight /></button>
            <p class="wrfx-field-note"><PhInfo /> 圈选范围必须位于单个区县内；系统按区县编码查询并仅显示圈选范围内耕地图斑。</p>
          </section>

          <div class="wrfx-scope-card" :class="{ selected: selectedScope }">
            <div class="wrfx-scope-card-head">
              <span class="wrfx-scope-icon"><PhMapPin weight="fill" /></span>
              <div><small>当前分析范围</small><strong>{{ selectedScope?.name || "尚未确定" }}</strong></div>
              <button v-if="selectedScope" class="wrfx-clear-button" aria-label="清除范围" title="清除范围" @click="clearScope"><PhArrowCounterClockwise /></button>
            </div>
            <div class="wrfx-scope-metrics">
              <div><small>范围面积</small><strong>{{ areaText }}</strong></div>
              <div><small>覆盖点位</small><strong>待获取</strong></div>
              <div><small>可用数据</small><strong>待核对</strong></div>
            </div>
            <p class="wrfx-scope-source">{{ selectedScope?.source || "未选范围 · 请选择一种方式开始" }}</p>
          </div>

          <div v-if="notice" class="wrfx-notice" :class="{ success: confirmed }"><PhCheckCircle v-if="confirmed" /><PhInfo v-else />{{ notice }}</div>

          <div class="wrfx-data-hint">
            <PhDatabase />
            <div><strong>数据透明可追溯</strong><p>后续将展示基础底数、调查数据的来源、时间和空间覆盖。</p></div>
          </div>

          <button class="wrfx-confirm-button" :disabled="!selectedScope || scopeLoading" @click="confirmScope">
            <span>{{ confirmed ? "范围已确认" : "确认分析范围" }}</span><PhArrowRight />
          </button>
          <p class="wrfx-next-hint"><PhSlidersHorizontal /> 下一步：确认种植制度与农艺条件</p>
        </div>
      </aside>

      <section class="wrfx-map-panel">
        <div class="wrfx-map-toolbar">
          <div class="wrfx-map-tabs"><span class="active"><PhMapTrifold />区域地图</span><span><PhDatabase />数据覆盖</span></div>
          <div class="wrfx-map-source"><span class="status-light"></span>天地图影像 <b>CGCS2000</b></div>
        </div>
        <ScopeMap ref="mapRef" :drawing="drawing" :picking="mode === 'cooperative'" @polygon-selected="onPolygonSelected" @point-picked="onMapPointPicked" />
        <div class="wrfx-map-search">
          <PhMagnifyingGlass />
          <input v-model="locationQuery" :placeholder="mode === 'cooperative' ? '搜索合作社名称、地名或地址' : '搜索地名或地址'" @keydown.enter.prevent="searchCooperative" />
          <button aria-label="搜索地点" :disabled="searching" @click="searchCooperative"><PhArrowRight /></button>
        </div>
        <div class="wrfx-map-tip"><span class="wrfx-tip-icon"><PhMapPin /></span><div><strong>{{ mode === 'cooperative' ? '点击地图选择合作社位置' : '选择分析范围' }}</strong><small>{{ mode === 'polygon' ? '点击“开始圈选”，在地图上绘制多边形边界' : mode === 'cooperative' ? '也可在左侧搜索合作社名称、地名或地址' : '可在左侧选择行政区或切换至地图圈选' }}</small></div></div>
        <div class="wrfx-map-legend"><i></i>{{ selectedScope?.name || '自定义范围' }} <span></span>{{ selectedScope?.type === 'administrative' ? 'GeoServer 区县边界' : selectedScope?.type === 'cooperative' ? `${selectedScope.longitude.toFixed(5)}, ${selectedScope.latitude.toFixed(5)}` : '地图圈选' }}</div>
        <div class="wrfx-map-tools">
          <button title="放大" @click="mapRef?.zoom(1)"><PhPlus /></button>
          <button title="缩小" @click="mapRef?.zoom(-1)"><PhMinus /></button>
          <button title="定位湖南" @click="mapRef?.resetView()"><PhCrosshair /></button>
        </div>
        <div v-if="drawing" class="wrfx-draw-instruction"><PhPolygon />绘制中：沿边界逐点点击，双击结束</div>
        <div class="wrfx-coordinates">范围边界以原系统授权数据为准 · 地图仅用于定位与圈选</div>
      </section>
    </section>
  </main>
</template>
