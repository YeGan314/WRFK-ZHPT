<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
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
  PhFileArrowUp,
  PhMapPinArea,
  PhGridFour,
  PhFileXls,
} from "@phosphor-icons/vue";
import ScopeMap from "./components/ScopeMap.vue";
import { displayName, filterByParent, findCountyForPolygon, findCountiesIntersectingRing, findCultivatedPlotLayer, geoserverEndpoint, loadAdministrativeBoundary, loadAdministrativeRegions, loadCultivatedPlots, loadCultivatedPlotsInBoundary } from "./geoServer.js";
import { normalizeLocations } from "../lib/analysis.js";
import { comparePoints, readSupplementPoints } from "./pointComparison.js";
import { pointsInsideBoundary, pollutionMetrics, summarizeMetric, withSupplementPoints } from "./pollutionAnalysis.js";
import { saveSurveySnapshot as persistSurveySnapshot } from "./surveyCache.js";

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
const workspaceRef = ref(null);
const sidebarWidth = ref(null);
const workspaceWidth = ref(window.innerWidth - 24);
const optimalSidebarWidth = computed(() => Math.round(workspaceWidth.value * 0.275));
const draggingDivider = ref(false);
const notice = ref("");
const confirmed = ref(false);
const stage = ref(1);
const confirmedData = ref(null);
const sidebarScrollRef = ref(null);
const questionnaireIndex = ref(-1);
const surveyComplete = ref(false);
const surveyCacheSaving = ref(false);
const surveyCacheError = ref('');
const questionnaireAnswers = ref({});
const questionRefs = ref([]);
const surveyFiles = ref({});
const customBoundaryInput = ref(null);
const customPlotsInput = ref(null);
const customBoundary = ref(null);
const customPlotFeatures = ref(null);
const dataSource = ref('latest');
const sourceChecked = ref(true);
const userSupplementData = ref(false);
const supplementFileInput = ref(null);
const supplementFile = ref(null);
const dataCheckNotice = ref('');
const pointComparison = ref(null);
const comparingPoints = ref(false);
const uploadedPoints = ref(null);
const analysisPoints = ref([]);
const analysisMetric = ref('ntCd');
const analysisLoading = ref(false);
const analysisError = ref('');
const remoteSummaries = ref(null);
const analysisYear = computed(() => dataSource.value === 'baseline' ? '2025' : questionnaireAnswers.value.surveyYear || String(new Date().getFullYear()));
const activeMetric = computed(() => pollutionMetrics.find(metric => metric.key === analysisMetric.value) || pollutionMetrics[2]);
const activeMetricSummary = computed(() => summarizeMetric(analysisPoints.value, analysisMetric.value));
const metricSummary = key => summarizeMetric(analysisPoints.value, key);
const formatAnalysisValue = (value, digits = 2) => value == null ? '—' : Number(value).toFixed(digits);
const analysisSourceName = computed(() => ({ latest: '最新调查数据', baseline: '内置基础底数', supplement: '用户补充数据' })[dataSource.value]);
const activeDistribution = computed(() => {
  const key = { soilSph: 'soilPh', soilSom: 'soilSom', soilStcd: 'soilCd', soilStas: 'soilAs', ntCd: 'riceCd', naAs: 'riceAs' }[analysisMetric.value];
  const original = remoteSummaries.value?.[key];
  if (dataSource.value !== 'supplement' && Array.isArray(original) && original.length && original.reduce((sum, item) => sum + Number(item.total || 0), 0) === activeMetricSummary.value.count)
    return original.map(item => ({ label: item.rangeName, count: Number(item.total) || 0 }));
  return activeMetricSummary.value.bins.map((bin, index) => ({
    label: index === 0 ? `< ${formatAnalysisValue(bin.end)}` : index === 3 ? `≥ ${formatAnalysisValue(bin.start)}` : `${formatAnalysisValue(bin.start)}–${formatAnalysisValue(bin.end)}`,
    count: bin.count,
  }));
});
const analysisBoundaries = computed(() => {
  const key = { soilSph: 'soilPh', soilSom: 'soilSom', soilStcd: 'soilCd', soilStas: 'soilAs', ntCd: 'riceCd', naAs: 'riceAs' }[analysisMetric.value];
  const original = remoteSummaries.value?.[key];
  if (dataSource.value !== 'supplement' && Array.isArray(original) && original.length === 4 && original.reduce((sum, item) => sum + Number(item.total || 0), 0) === activeMetricSummary.value.count)
    return original.slice(0, 3).map(item => Number(item.rightRange));
  return activeMetricSummary.value.boundaries || [];
});
function metricText(value) {
  if (value.original === null || value.supplement === null) return '缺少数据';
  const format = number => Number(number).toLocaleString('zh-CN', { maximumFractionDigits: 9 });
  const difference = value.difference === Infinity ? '原值为 0' : `${value.difference.toFixed(1)}%`;
  return `${format(value.original)} → ${format(value.supplement)} · ${difference}`;
}
const comparisonSummary = computed(() => {
  const result = pointComparison.value;
  if (!result) return '上传 Excel 后，将按序号逐点核对三项指标。';
  const base = `已匹配 ${result.matched} / ${result.totalUpload} 条 Excel 记录（接口 ${result.totalApi} 条）。`;
  if (!result.matched) return `${base}未找到可核对的同点记录。`;
  const missing = result.incomplete ? `另有 ${result.incomplete} 条缺少指标，无法完整判断偏差。` : '';
  if (!result.changed && result.incomplete) return `${base}${missing}下表展示 3 条待核对记录。`;
  if (!result.changed) return `${base}土壤镉、水稻镉和土壤砷均无偏差；下表展示 3 条样例。`;
  if (!result.significant) return `${base}有 ${result.changed} 条存在数值变化，但没有超过 20% 的偏差；下表展示差异最大的 3 条。${missing}`;
  return `${base}${result.significant} 条至少一项指标偏差超过 20%，已按最大偏差从大到小排列。${missing}`;
});
const answeredSummary = computed(() => [
  { label: '所属区域', value: confirmedData.value?.scope.name || '自动识别中' },
  ...questions.value.map(question => ({ label: question.label, value: questionnaireAnswers.value[question.key] || question.recommendation || '待调研' })),
]);
async function saveSurveySnapshot() {
  const snapshot = {
    savedAt: new Date().toISOString(),
    scope: confirmedData.value?.scope,
    boundary: confirmedData.value?.boundary,
    plots: confirmedData.value?.plots || [],
    answers: questionnaireAnswers.value,
    answersSummary: answeredSummary.value,
    sources: { dataSource: dataSource.value, sourceChecked: sourceChecked.value, userSupplementData: userSupplementData.value, supplementFileName: supplementFile.value?.name || '' },
  };
  await persistSurveySnapshot(JSON.parse(JSON.stringify(snapshot)));
}
async function enterDataCheck() {
  if (surveyCacheSaving.value) return;
  surveyCacheSaving.value = true;
  surveyCacheError.value = '';
  try {
    await saveSurveySnapshot();
    stage.value = 3;
    dataCheckNotice.value = '范围边界、耕地图斑和调查信息已缓存到本机浏览器。';
    nextTick(() => sidebarScrollRef.value?.scrollTo({ top: 0, behavior: 'smooth' }));
  } catch (error) {
    surveyCacheError.value = `无法缓存分析资料：${error.message || '浏览器存储不可用'}。请检查浏览器存储空间后重试。`;
  } finally { surveyCacheSaving.value = false; }
}
function returnToSurvey() { stage.value = 2; surveyComplete.value = true; }
async function confirmDataSource() {
  if (analysisLoading.value) return;
  if (dataSource.value === 'supplement' && !uploadedPoints.value) {
    dataCheckNotice.value = '请先上传并核对 Excel 点位数据。';
    return;
  }
  try { await saveSurveySnapshot(); }
  catch (error) { dataCheckNotice.value = error.message; return; }
  stage.value = 4;
  analysisPoints.value = [];
  remoteSummaries.value = null;
  analysisError.value = '';
  analysisLoading.value = true;
  nextTick(() => sidebarScrollRef.value?.scrollTo({ top: 0 }));
  try {
    const scope = confirmedData.value?.scope;
    const countyCode = String(scope?.countyCode || (scope?.name?.includes('衡南') ? '430422' : ''));
    if (countyCode !== '430422') throw new Error('当前污染现状接口仅已接入衡南基地；该范围暂无法读取原系统点位。');
    const zoneCode = 'ZONE4304220001';
    const year = analysisYear.value;
    const pointParams = new URLSearchParams({ zoneCode, surveyYear: year });
    const summaryParams = new URLSearchParams({ zoneCode, dataYear: year });
    const [pointResponse, summaryResponse] = await Promise.all([
      fetch(`/wrfx/api/data-check/points?${pointParams}`),
      fetch(`/wrfx/api/pollution/summary?${summaryParams}`),
    ]);
    const pointResult = await pointResponse.json();
    if (!pointResponse.ok) throw new Error(pointResult.message || '原系统点位读取失败。');
    if (!pointResult.data?.length) throw new Error(`${year} 年暂无可用点位数据，请返回数据核对选择其他来源。`);
    analysisPoints.value = withSupplementPoints(pointsInsideBoundary(pointResult.data, confirmedData.value?.boundary), dataSource.value === 'supplement' ? uploadedPoints.value : null);
    if (!analysisPoints.value.length) throw new Error('所选边界内没有对应年度的采样点，无法生成污染现状统计。');
    if (summaryResponse.ok) remoteSummaries.value = (await summaryResponse.json()).data;
  } catch (error) { analysisError.value = error.message || '污染现状数据加载失败。'; }
  finally { analysisLoading.value = false; }
}
function selectDataSource(source) {
  dataSource.value = source;
  userSupplementData.value = source === 'supplement';
  if (source !== 'supplement') { supplementFile.value = null; pointComparison.value = null; uploadedPoints.value = null; }
  dataCheckNotice.value = source === 'supplement' && supplementFile.value
    ? `已选择用户补充数据：${supplementFile.value.name}`
    : `当前选择：${source === 'latest' ? '最新调查数据' : source === 'baseline' ? '内置基础底数' : '用户补充数据'}。`;
}
async function onSupplementFileChange(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (!/\.(xlsx?|csv)$/i.test(file.name)) {
    dataCheckNotice.value = '文件格式暂不支持，请选择 Excel（.xls、.xlsx）或 CSV 文件。';
    return;
  }
  comparingPoints.value = true;
  pointComparison.value = null;
  uploadedPoints.value = null;
  dataCheckNotice.value = `正在核对 ${file.name} 的点位数据…`;
  try {
    const uploaded = await readSupplementPoints(file);
    const countyCode = [...uploaded.countyCodes][0];
    if (uploaded.countyCodes.size !== 1 || countyCode !== '430422') {
      throw new Error('当前已接入衡南基地点位接口；请上传行政区编码为 430422 的衡南数据。');
    }
    const scope = confirmedData.value?.scope;
    if (scope?.countyCode && String(scope.countyCode) !== countyCode) {
      throw new Error('Excel 行政区编码与当前分析范围不一致。');
    }
    const surveyYear = questionnaireAnswers.value.surveyYear || String(new Date().getFullYear());
    const params = new URLSearchParams({ zoneCode: 'ZONE4304220001', surveyYear });
    const response = await fetch(`/wrfx/api/data-check/points?${params}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '点位接口读取失败。');
    if (!Array.isArray(result.data) || !result.data.length) throw new Error('原系统未返回该年度的点位数据，无法完成核对。');
    const comparison = comparePoints(result.data, uploaded.points);
    if (!comparison.matched) throw new Error('Excel 序号与原系统点位未能匹配，请核对文件和调查年度。');
    pointComparison.value = comparison;
    uploadedPoints.value = uploaded.points;
    supplementFile.value = file;
    userSupplementData.value = true;
    dataCheckNotice.value = `已完成 ${file.name} 与原系统点位的逐条核对。`;
  } catch (error) {
    supplementFile.value = null;
    uploadedPoints.value = null;
    dataCheckNotice.value = error.message || 'Excel 点位核对失败。';
  } finally { comparingPoints.value = false; }
}
const questionGroups = [
  { title: '生产条件', questions: [
    ['riceLevel','水稻级别',['早稻','中稻','晚稻','再生头季','再生后季'],'中稻','原系统默认值：中稻。请按实际种植情况确认。'],
    ['fieldFeature','地块特征',['洼地','陇田','台地'],'陇田','原系统默认值：陇田。'],
    ['fieldPosition','田块位置',['不明','高岸田','垅田','低洼田'],'垅田','原系统默认值：垅田。'],
    ['waterSource','灌溉水源',['不明','池塘水','水库水','江河水','山泉水'],'水库水','原系统默认值：水库水。'],
    ['soil','土壤地质',['不明','砂土','壤土','粘土'],'壤土','原系统默认值：壤土。'],
    ['terrain','地形特征',['山区','丘陵','盆地','平原'],'丘陵','原系统默认值：丘陵。'],
    ['parentMaterial','成土母质',['花岗岩类','板页岩类','砂砾岩类','紫色砂页岩类','石灰岩类','第四纪红土','河湖冲沉积物','风积沙','原生黄土','黄土状物质（次生黄土）'],'石灰岩类','原系统默认值：石灰岩类。'],
    ['variety','水稻品种',['籼稻','粳稻','晚稻','再生稻'],'粳稻','原系统默认值：粳稻。'],
    ['transplant','移栽方式',['移栽','机插','抛秧','直播'],'机插','原系统默认值：机插。'],
    ['tillage','耕作方式',['不明','翻耕+插秧','翻耕+抛秧','旋耕+插秧','旋耕+抛秧','免耕/直播'],'翻耕+抛秧','原系统默认值：翻耕+抛秧。'],
    ['waterManagement','水分管理',['不明','淹水灌溉','间歇灌溉','湿润灌溉'],'间歇灌溉','原系统默认值：间歇灌溉。'],
    ['fertilizer','肥料类型',['不明','碱性肥料','常规肥料','酸性肥料'],'常规肥料','如有施肥记录，建议据记录确认。'],
  ]},
  { title: '污染源与管理', questions: [
    ['enterpriseCount','片区内污染企业数量',['0','1','2','3','4','5'],'0','原系统默认值：0 家。'],
    ['enterpriseType','污染企业类型',['采选','采选冶炼','冶炼'],'冶炼','原系统默认值：冶炼。'],
    ['locationFeature','区位特征',['工矿区','养殖区','城郊区','一般农区'],'养殖区','原系统默认值：养殖区。'],
    ['organicFertilizer','是否使用有机肥',['施用','不施用'],'不施用','原系统默认值：不施用。'],
    ['strawReturn','稻草还田方式',['不明','全量还田','高桩还田','秸秆离田'],'全量还田','原系统默认值：全量还田。'],
    ['industry5km','周边5km工矿企业',['不明','冶炼企业','工业园区','采矿企业','养殖企业','历史遗留场地','无'],'工业园区','原系统默认值：工业园区。'],
    ['living3km','周边3km生活区',['不明','县级以上城镇','乡镇','农村生活区','无'],'乡镇','原系统默认值：乡镇。'],
    ['road1km','周边1km交通道路',['不明','国道','高速','省道','县道','乡村公路','无'],'县道','原系统默认值：县道。'],
    ['sourceMonitoring','污染源监测',['无','有'],'无','原系统默认值：无。'],
  ]},
  { title: '调查资料', questions: [
    ['demoType','示范区类型',['政府','科研机构','企业','农户'],'科研机构','原系统默认值：科研机构。'],
    ['surveyYear','调查年度',Array.from({length:5},(_,index)=>String(new Date().getFullYear()-index)),String(new Date().getFullYear()),'选择调查资料对应的年度；列表按从近到远排列。'],
  ]},
];
const questions = computed(() => questionGroups.flatMap(group => group.questions.map(([key,label,options,recommendation,reason]) => ({ key,label,options,recommendation,reason,group:group.title }))));
const questionCount = computed(() => questions.value.length);
const currentQuestion = computed(() => questions.value[questionnaireIndex.value]);
const answeredCount = computed(() => questions.value.filter(q => questionnaireAnswers.value[q.key] || surveyFiles.value[q.key]?.length).length);
const scopeAreaSqm = computed(() => confirmedData.value?.plots?.reduce((sum, feature) => sum + geometryAreaSqm(feature.geometry), 0) || 0);
function ringAreaSqm(ring) {
  let area = 0; const radius = 6378137;
  for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const [lon1,lat1]=ring[j], [lon2,lat2]=ring[i];
    area += (lon2-lon1)*Math.PI/180*(2+Math.sin(lat1*Math.PI/180)+Math.sin(lat2*Math.PI/180));
  }
  return Math.abs(area*radius*radius/2);
}
function geometryAreaSqm(geometry) {
  if (!geometry) return 0;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.reduce((total, polygon) => total + polygon.reduce((a, ring, i) => a + (i ? -1 : 1)*ringAreaSqm(ring), 0), 0);
}
const formattedArea = computed(() => scopeAreaSqm.value ? `${scopeAreaSqm.value.toLocaleString('zh-CN',{maximumFractionDigits:0})} m²` : '暂无有效耕地图斑面积');
function selectAnswer(value) {
  questionnaireAnswers.value = { ...questionnaireAnswers.value, [currentQuestion.value.key]: value };
  if (questionnaireIndex.value < questions.value.length - 1) {
    questionnaireIndex.value += 1;
    nextTick(() => { questionRefs.value[questionnaireIndex.value]?.scrollIntoView({ behavior:'smooth', block:'start' }); });
  } else surveyComplete.value = true;
}
function selectOption(value) {
  questionnaireAnswers.value = { ...questionnaireAnswers.value, [currentQuestion.value.key]: value };
  if (currentQuestion.value.key === 'sourceMonitoring' && value === '有') return;
  selectAnswer(value);
}
function advanceQuestion() {
  questionnaireAnswers.value = { ...questionnaireAnswers.value, [currentQuestion.value.key]: questionnaireAnswers.value[currentQuestion.value.key] || '已跳过' };
  if (questionnaireIndex.value < questions.value.length - 1) {
    questionnaireIndex.value += 1;
    nextTick(() => { questionRefs.value[questionnaireIndex.value]?.scrollIntoView({ behavior:'smooth', block:'start' }); });
  } else surveyComplete.value = true;
}
function backQuestion() { questionnaireIndex.value = Math.max(0, questionnaireIndex.value - 1); }
function onSurveyFiles(event, key) { surveyFiles.value[key] = [...event.target.files || []]; }
function parseGeoJsonFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const features = data.type === 'FeatureCollection' ? data.features : data.type === 'Feature' ? [data] : [];
        if (!features.length || features.some(feature => !feature.geometry || !['Polygon','MultiPolygon'].includes(feature.geometry.type))) throw new Error('文件需为包含 Polygon 或 MultiPolygon 的 GeoJSON。');
        resolve({ ...data, type: 'FeatureCollection', features });
      } catch (error) { reject(error); }
    };
    reader.onerror = () => reject(new Error('无法读取所选文件。'));
    reader.readAsText(file);
  });
}
function featureCollectionGeometry(fc) {
  const features = fc.features;
  const coordinates = features.flatMap(feature => feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates);
  return { type: 'MultiPolygon', coordinates };
}
function geoJsonLabel(fc, fallback) {
  const props = fc.features[0]?.properties || {};
  return props.name || props.NAME || props.名称 || props.县名 || props.区县名称 || fallback;
}
async function onCustomBoundaryFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const data = await parseGeoJsonFile(file);
    customBoundary.value = data;
    const name = geoJsonLabel(data, file.name.replace(/\.json$/i, ''));
    const geometry = featureCollectionGeometry(data);
    selectedScope.value = { type: 'customGeojson', name, source: `自定义边界文件：${file.name}`, geometry };
    confirmed.value = false;
    confirmedData.value = null;
    mapRef.value?.clearDrawing();
    mapRef.value?.showAdministrativeBoundary(data, 16);
    mapRef.value?.setScopeMask(null);
    if (customPlotFeatures.value) mapRef.value?.setCultivatedPlotFeatures(customPlotFeatures.value);
    notice.value = `已加载自定义边界 ${name}，${data.features.length} 个面要素。${customPlotFeatures.value ? `已载入 ${customPlotFeatures.value.length} 个自定义耕地图斑。` : '可继续上传耕地图斑，或直接确认范围查询系统数据。'}`;
  } catch (error) { notice.value = error.message || '边界文件加载失败。'; }
}
async function onCustomPlotsFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const data = await parseGeoJsonFile(file);
    customPlotFeatures.value = data.features;
    if (selectedScope.value?.type === 'customGeojson') mapRef.value?.setCultivatedPlotFeatures(data.features);
    notice.value = `已加载 ${data.features.length} 个自定义耕地图斑（${file.name}）。`;
  } catch (error) { notice.value = error.message || '耕地图斑文件加载失败。'; }
}
let scopeSelectionId = 0;
const MIN_MAP_WIDTH = 420;

function clampSidebarWidth(width) {
  const available = workspaceRef.value?.clientWidth || workspaceWidth.value;
  return Math.min(available - MIN_MAP_WIDTH - 10, Math.max(optimalSidebarWidth.value * 0.5, width));
}

function moveDivider(event) {
  if (!draggingDivider.value || !workspaceRef.value) return;
  sidebarWidth.value = clampSidebarWidth(event.clientX - workspaceRef.value.getBoundingClientRect().left);
}

function stopDividerDrag() {
  if (!draggingDivider.value) return;
  draggingDivider.value = false;
  document.body.classList.remove("wrfx-resizing");
  window.removeEventListener("pointermove", moveDivider);
  window.removeEventListener("pointerup", stopDividerDrag);
  window.removeEventListener("pointercancel", stopDividerDrag);
  if (sidebarWidth.value != null) localStorage.setItem("wrfx-sidebar-width", String(sidebarWidth.value));
}

function startDividerDrag(event) {
  event.preventDefault();
  draggingDivider.value = true;
  document.body.classList.add("wrfx-resizing");
  window.addEventListener("pointermove", moveDivider);
  window.addEventListener("pointerup", stopDividerDrag);
  window.addEventListener("pointercancel", stopDividerDrag);
}

function resizeDividerByKeyboard(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const current = sidebarWidth.value ?? workspaceRef.value?.querySelector(".wrfx-sidebar")?.getBoundingClientRect().width ?? 355;
  sidebarWidth.value = clampSidebarWidth(current + (event.key === "ArrowRight" ? 20 : -20));
  localStorage.setItem("wrfx-sidebar-width", String(sidebarWidth.value));
}

function keepDividerInBounds() {
  const workspace = workspaceRef.value;
  if (workspace) {
    const style = getComputedStyle(workspace);
    workspaceWidth.value = workspace.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  } else workspaceWidth.value = window.innerWidth - 24;
  if (sidebarWidth.value != null) sidebarWidth.value = clampSidebarWidth(sidebarWidth.value);
}

onBeforeUnmount(() => {
  stopDividerDrag();
  window.removeEventListener("resize", keepDividerInBounds);
});

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
const normalizeRegionQuery = (value) => String(value || "").replace(/[\s,，·、/]+/g, "").toLocaleLowerCase();
function matchAdministrativePath(query, feature, path) {
  const leaf = normalizeRegionQuery(displayName(feature));
  let remaining = query;
  let matchedParents = 0;
  for (const ancestor of [path.province, path.city, path.county, path.township]) {
    if (!ancestor || ancestor === feature) continue;
    const name = normalizeRegionQuery(displayName(ancestor));
    const shortName = name.replace(/(?:管理区|街道|自治县|自治州|地区|省|市|县|区|乡|镇)$/, "");
    const token = [name, shortName].find((item) => item.length >= 2
      && remaining.startsWith(item) && remaining.length - item.length >= 2);
    if (token) {
      remaining = remaining.replace(token, "");
      matchedParents += 1;
    }
  }
  if (!remaining || !leaf.includes(remaining)) return null;
  return matchedParents * 10 + Number(leaf === remaining) * 5;
}
const administrativeMatches = computed(() => {
  const query = normalizeRegionQuery(administrativeSearchQuery.value.trim());
  if (query.length < 2) return [];
  const candidates = [
    ...regionData.value.counties,
    ...regionData.value.townships,
    ...regionData.value.villages,
  ].filter((feature) => {
    const leaf = normalizeRegionQuery(displayName(feature));
    return query.includes(leaf) || leaf.includes(query) || leaf.includes(query.slice(-2));
  });
  return candidates
    .map((feature) => {
      const path = administrativePath(feature);
      return { feature, path, score: matchAdministrativePath(query, feature, path) };
    })
    .filter((match) => match.score !== null)
    .sort((a, b) => b.score - a.score);
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
  customBoundary.value = null;
  customPlotFeatures.value = null;
  confirmed.value = false;
  notice.value = "搜索结果已回填，正在自动定位并加载对应边界和耕地图斑…";
  mapRef.value?.clearAdministrativeBoundary();
  mapRef.value?.clearPickedPoint();
  mapRef.value?.setCultivatedPlotLayer(null);
  mapRef.value?.setCultivatedPlotFeatures(null);
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
  if (nextMode !== "cooperative") cooperativeSelectionId += 1;
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
  window.addEventListener("resize", keepDividerInBounds);
  keepDividerInBounds();
  const savedWidth = Number(localStorage.getItem("wrfx-sidebar-width"));
  if (Number.isFinite(savedWidth) && savedWidth > 0) sidebarWidth.value = clampSidebarWidth(savedWidth);
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
    mapRef.value?.setCultivatedPlotFeatures(null);
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
  const requestId = ++scopeSelectionId;
  notice.value = `正在定位${displayName(targetRegion)}并加载边界和耕地图斑…`;
  try {
    const feature = await loadAdministrativeBoundary(targetRegion);
    if (requestId !== scopeSelectionId) return;
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
      if (requestId !== scopeSelectionId) return;
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
    if (requestId === scopeSelectionId) notice.value = error.message;
  } finally {
    if (requestId === scopeSelectionId) scopeLoading.value = false;
  }
}

async function searchCooperative() {
  const keyword = locationQuery.value.trim();
  if (!keyword) {
    searchNotice.value = "请输入合作社名称或地址。";
    searchResults.value = [];
    return;
  }
  if (mode.value !== "cooperative") chooseMode("cooperative");
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

let cooperativeSelectionId = 0;
function pointBufferRing(longitude, latitude, radiusMeters = 200) {
  const latRadians = latitude * Math.PI / 180;
  return Array.from({ length: 49 }, (_, index) => {
    const angle = index * Math.PI * 2 / 48;
    return [longitude + Math.cos(angle) * radiusMeters / (111320 * Math.cos(latRadians)),
      latitude + Math.sin(angle) * radiusMeters / 111320];
  });
}

async function selectCooperativePoint(point, source = "合作社/地址检索") {
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
  const selectionId = ++cooperativeSelectionId;
  scopeLoading.value = true;
  notice.value = `已选择${name}，正在查询周边 200 米内的耕地图斑…`;
  try {
    const ring = pointBufferRing(longitude, latitude);
    const counties = await findCountiesIntersectingRing(ring);
    if (!counties.length) throw new Error("点位周边未匹配到湖南省区县，无法确定耕地图层。");
    const layers = (await Promise.all(counties.map(findCultivatedPlotLayer))).filter(Boolean);
    if (!layers.length) throw new Error("点位周边区县没有对应的耕地图斑图层。");
    const results = await Promise.all(layers.map((layer) => loadCultivatedPlots(layer, ring)));
    if (selectionId !== cooperativeSelectionId) return;
    const plots = results.flatMap((result) => result.features);
    mapRef.value?.setCultivatedPlotFeatures(plots);
    notice.value = plots.length
      ? `已显示${name}周边 200 米内相交的 ${plots.length} 个完整耕地图斑。`
      : `已完成${name}周边 200 米查询，范围内没有匹配的耕地图斑。`;
  } catch (error) {
    if (selectionId === cooperativeSelectionId) notice.value = error.message || "周边耕地图斑查询失败。";
  } finally {
    if (selectionId === cooperativeSelectionId) scopeLoading.value = false;
  }
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
  const requestId = ++scopeSelectionId;
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
    if (requestId !== scopeSelectionId) return;
    const countyLayer = await findCultivatedPlotLayer(countyFeature);
    if (requestId !== scopeSelectionId) return;
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
    if (requestId === scopeSelectionId) {
      selectedScope.value = null;
      mapRef.value?.clearDrawing();
      notice.value = error.message;
    }
  } finally {
    if (requestId === scopeSelectionId) scopeLoading.value = false;
  }
}

function clearScope() {
  scopeSelectionId += 1;
  cooperativeSelectionId += 1;
  searchController.value?.abort();
  searchController.value = null;
  searching.value = false;
  scopeLoading.value = false;
  selectedScope.value = null;
  confirmed.value = false;
  confirmedData.value = null;
  customBoundary.value = null;
  customPlotFeatures.value = null;
  questionnaireAnswers.value = {};
  surveyFiles.value = {};
  questionnaireIndex.value = -1;
  surveyComplete.value = false;
  stage.value = 1;
  province.value = "";
  city.value = "";
  county.value = "";
  township.value = "";
  village.value = "";
  searchedVillage.value = null;
  administrativeSearchQuery.value = "";
  administrativeSearchOpen.value = false;
  locationQuery.value = "";
  searchResults.value = [];
  searchNotice.value = "";
  drawing.value = false;
  mapRef.value?.setCultivatedPlotLayer(null);
  mapRef.value?.setCultivatedPlotFeatures(null);
  mapRef.value?.setScopeMask(null);
  mapRef.value?.setAdministrativeContext({});
  notice.value = mode.value === "polygon" ? "范围已清除，可重新绘制。" : "已清除当前范围。";
  mapRef.value?.clearDrawing();
  mapRef.value?.clearAdministrativeBoundary();
  mapRef.value?.clearPickedPoint();
}

async function confirmScope() {
  if (!selectedScope.value) {
    notice.value = "请先选择一个分析范围。";
    return;
  }
  if (scopeLoading.value) return;
  scopeLoading.value = true;
  try {
    let boundary;
    let plots;
    const scope = selectedScope.value;
    if (scope.type === 'customGeojson') {
      boundary = customBoundary.value || { type: 'Feature', geometry: scope.geometry, properties: { name: scope.name } };
      if (customPlotFeatures.value?.length) plots = { features: customPlotFeatures.value, truncated: false };
      else {
        const ring = scope.geometry.type === 'Polygon' ? scope.geometry.coordinates[0] : scope.geometry.coordinates[0][0];
        const countyFeature = await findCountyForPolygon(ring);
        const layer = await findCultivatedPlotLayer(countyFeature);
        plots = await loadCultivatedPlotsInBoundary(layer, boundary);
      }
    } else if (scope.type === 'administrative') {
      const region = selectedVillage.value || selectedTownship.value || selectedCounty.value || selectedCity.value || selectedProvince.value;
      boundary = await loadAdministrativeBoundary(region);
      if (!selectedCounty.value) throw new Error('请至少选择到区县级，才能取得对应耕地图斑。');
      const layer = await findCultivatedPlotLayer(selectedCounty.value);
      if (!layer) throw new Error('所选区县没有对应的耕地图斑图层。');
      plots = customPlotFeatures.value?.length ? { features: customPlotFeatures.value, truncated: false } : await loadCultivatedPlotsInBoundary(layer, boundary);
    } else if (scope.type === 'polygon') {
      boundary = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [scope.coordinates] }, properties: {} };
      const countyFeature = await findCountyForPolygon(scope.coordinates);
      const layer = await findCultivatedPlotLayer(countyFeature);
      plots = customPlotFeatures.value?.length ? { features: customPlotFeatures.value, truncated: false } : await loadCultivatedPlots(layer, scope.coordinates);
    } else {
      const ring = pointBufferRing(scope.longitude, scope.latitude);
      const counties = await findCountiesIntersectingRing(ring);
      const layers = (await Promise.all(counties.map(findCultivatedPlotLayer))).filter(Boolean);
      const results = await Promise.all(layers.map(layer => loadCultivatedPlots(layer, ring)));
      plots = customPlotFeatures.value?.length ? { features: customPlotFeatures.value, truncated: false } : { features: results.flatMap(result => result.features), truncated: results.some(result => result.truncated) };
      if (!plots.features.length) throw new Error('该点位周边没有耕地图斑，无法形成分析范围。');
      const points = [];
      const collectPoints = coordinates => {
        if (!Array.isArray(coordinates)) return;
        if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') points.push(coordinates);
        else coordinates.forEach(collectPoints);
      };
      plots.features.forEach(feature => collectPoints(feature.geometry?.coordinates));
      if (!points.length) throw new Error('耕地图斑没有有效坐标，无法形成范围边界。');
      const xs = points.map(point => point[0]);
      const ys = points.map(point => point[1]);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      boundary = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[minX,minY],[maxX,minY],[maxX,maxY],[minX,maxY],[minX,minY]]] }, properties: {} };
    }
    if (plots.truncated) throw new Error('当前范围耕地图斑超过单次查询上限，请缩小范围后重试，避免遗漏数据。');
    if (confirmedData.value?.scope.name !== scope.name) {
      questionnaireAnswers.value = {};
      surveyFiles.value = {};
      surveyComplete.value = false;
    }
    confirmedData.value = { scope: { ...scope }, boundary, plots: plots.features };
    confirmed.value = true;
    stage.value = 2;
    questionnaireAnswers.value = {
      ...Object.fromEntries(questions.value.filter(question => question.recommendation && question.options?.includes(question.recommendation)).map(question => [question.key, question.recommendation])),
      ...questionnaireAnswers.value,
    };
    questionnaireIndex.value = 0;
    surveyComplete.value = false;
    notice.value = `已获取分析边界和 ${plots.features.length} 个耕地图斑，开始客户问卷调研。`;
    mapRef.value?.showAdministrativeBoundary(boundary, scope.type === 'customGeojson' ? 16 : 14);
    mapRef.value?.setCultivatedPlotFeatures(plots.features);
    await nextTick();
    sidebarScrollRef.value?.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    notice.value = error.message || '分析范围数据获取失败，请重试。';
  } finally { scopeLoading.value = false; }
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
        <span :class="{ active: stage === 1, completed: stage > 1 }"><b>01</b> 范围选择</span>
        <i></i><span :class="{ active: stage === 2, completed: stage > 2 }"><b>02</b> 生产条件</span>
        <i></i><span :class="{ active: stage === 3, completed: stage > 3 }"><b>03</b> 数据核对</span>
        <i></i><span :class="{ active: stage === 4 }"><b>04</b> 污染分析</span>
        <i></i><span><b>05</b> 风险与方案</span>
        <i></i><span><b>06</b> 分析报告</span>
      </nav>

      <div class="wrfx-top-status"><span class="status-light"></span>独立模块 <b>/wrfx</b></div>
    </header>

    <section ref="workspaceRef" class="wrfx-workspace" :style="{ '--wrfx-optimal-sidebar-width': `${optimalSidebarWidth}px`, ...(sidebarWidth == null ? {} : { '--wrfx-sidebar-width': `${sidebarWidth}px` }) }">
      <aside class="wrfx-sidebar tech-frame">
        <div class="wrfx-sidebar-head">
          <div class="wrfx-sidebar-head-inner">
          <span class="wrfx-head-icon"><PhMapTrifold weight="duotone" /></span>
          <div><h1>{{ stage === 2 ? '客户问卷调研' : stage === 3 ? '数据核对' : stage === 4 ? '污染现状分析' : '分析范围选择' }}</h1><p>{{ stage === 2 ? '逐项确认片区生产与污染源信息' : stage === 3 ? '核对数据来源与点位指标差异' : stage === 4 ? '查看采样点分布与指标统计' : '先确定区域，再查看污染状况' }}</p></div>
          <span class="wrfx-live-dot" title="模块已就绪"></span>
          </div>
        </div>

        <div ref="sidebarScrollRef" class="wrfx-sidebar-scroll">
          <div class="wrfx-sidebar-content">
          <template v-if="stage === 4">
            <div class="wrfx-intro-label"><span></span>第四步 · 污染分析</div>
            <h2>片区污染现状</h2>
            <p class="wrfx-intro-copy">基于已确认的数据来源，查看采样点指标及其空间分布。</p>
            <div class="wrfx-analysis-context"><strong><PhMapPin />{{ confirmedData?.scope.name }}</strong><span>{{ analysisSourceName }} · {{ analysisYear }} 年 · {{ analysisPoints.length }} 个点位</span></div>
            <div v-if="analysisLoading" class="wrfx-analysis-message">正在读取原系统点位和指标汇总…</div>
            <div v-else-if="analysisError" class="wrfx-analysis-message error">{{ analysisError }}</div>
            <template v-else-if="analysisPoints.length">
              <div class="wrfx-analysis-section-title">重金属指标 <small>选择指标后同步更新地图</small></div>
              <div class="wrfx-analysis-metric-tabs">
                <button v-for="metric in pollutionMetrics.filter(item => item.group === 'soil' || item.group === 'rice')" :key="metric.key" type="button" :class="{ active: analysisMetric === metric.key }" @click="analysisMetric = metric.key">{{ metric.label }}</button>
              </div>
              <div class="wrfx-analysis-stat-grid">
                <div><small>有效样本</small><strong>{{ activeMetricSummary.count }}</strong><span>个点位</span></div>
                <div><small>平均值</small><strong>{{ formatAnalysisValue(activeMetricSummary.mean) }}</strong><span>{{ activeMetric.unit }}</span></div>
                <div><small>范围</small><strong>{{ formatAnalysisValue(activeMetricSummary.min) }}–{{ formatAnalysisValue(activeMetricSummary.max) }}</strong><span>{{ activeMetric.unit }}</span></div>
                <div><small>标准差</small><strong>{{ formatAnalysisValue(activeMetricSummary.stddev) }}</strong><span>{{ activeMetric.unit }}</span></div>
              </div>
              <div class="wrfx-analysis-section-title">{{ activeMetric.label }}含量分布 <small>{{ dataSource === 'supplement' || !remoteSummaries ? '按样本值分组' : '原系统区间统计' }}</small></div>
              <div class="wrfx-analysis-bars"><div v-for="(bin, index) in activeDistribution" :key="`${analysisMetric}-${index}`"><span>{{ bin.label }}</span><i><b :style="{ width: `${activeMetricSummary.count ? bin.count / activeMetricSummary.count * 100 : 0}%`, '--bar-color': ['#43dc4a','#eae940','#ff9d32','#d83ade'][index % 4] }"></b></i><strong>{{ bin.count }}</strong></div></div>
              <p class="wrfx-analysis-method">颜色按样本含量区间分组，用于查看空间分布；不代表法定超标或风险等级。</p>
              <div class="wrfx-analysis-section-title">土壤性质 <small>同批点位记录</small></div>
              <div class="wrfx-soil-properties"><button v-for="metric in pollutionMetrics.filter(item => item.group === 'property')" :key="metric.key" type="button" :class="{ active: analysisMetric === metric.key }" @click="analysisMetric = metric.key"><span>{{ metric.label }}</span><strong>{{ formatAnalysisValue(metricSummary(metric.key).mean) }}</strong><small>{{ metric.unit || '平均值' }}</small></button></div>
              <div class="wrfx-analysis-note"><PhInfo />点位来自原系统；区间统计优先使用原系统接口，范围不一致或接口无结果时按当前点位计算。超标率和污染来源需对应标准与模型结果。</div>
            </template>
            <button class="wrfx-back-button" @click="stage = 3">上一步　返回数据核对</button>
          </template>
          <template v-else-if="stage === 3">
            <div class="wrfx-intro-label"><span></span>第三步 · 数据核对</div>
            <h2>核对区域数据来源</h2>
            <p class="wrfx-intro-copy">请选择本次分析采用的数据。上传 Excel 后，系统按点位序号对比三项指标并提示差异。</p>
            <div class="wrfx-check-context"><b><PhMapPin />{{ confirmedData?.scope.name }}</b><span>{{ formattedArea }} · {{ confirmedData?.plots.length || 0 }} 个耕地图斑</span><small><PhCheckCircle />{{ dataCheckNotice || '边界、耕地图斑和调查信息已缓存到本机浏览器。' }}</small></div>
            <div class="wrfx-ai-note"><PhDatabase /><span><b>数据核对助手</b><small>上传补充数据后，按点位序号核对原系统的土壤镉、水稻镉和土壤砷。</small></span></div>
            <h3 class="wrfx-check-title">数据来源选择（按优先级）</h3>
            <div class="wrfx-source-options">
              <button type="button" role="radio" :aria-checked="dataSource==='latest'" :class="{ selected: dataSource==='latest' }" @click="selectDataSource('latest')"><b>1</b><span><strong>最新调查数据</strong><small>优先采用 · {{ questionnaireAnswers.surveyYear || '当前年度' }}年调查</small></span><i>{{ dataSource==='latest' ? '●' : '○' }}</i></button>
              <button type="button" role="radio" :aria-checked="dataSource==='baseline'" :class="{ selected: dataSource==='baseline' }" @click="selectDataSource('baseline')"><b>2</b><span><strong>内置基础底数</strong><small>基准对照 · 数据年份：2025 年</small></span><i>{{ dataSource==='baseline' ? '●' : '○' }}</i></button>
              <div class="wrfx-source-supplement" :class="{ selected: dataSource==='supplement' }">
                <button type="button" role="radio" :aria-checked="dataSource==='supplement'" @click="selectDataSource('supplement')"><b>3</b><span><strong>用户补充数据</strong><small>上传 Excel 表格作为本次分析数据</small></span><i>{{ dataSource==='supplement' ? '●' : '○' }}</i></button>
                <div v-if="dataSource==='supplement'" class="wrfx-excel-upload">
                  <input ref="supplementFileInput" type="file" accept=".xls,.xlsx,.csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" @change="onSupplementFileChange" />
                  <button type="button" :disabled="comparingPoints" @click="supplementFileInput?.click()"><PhFileXls /><span>{{ comparingPoints ? '正在核对点位…' : supplementFile ? '更换 Excel 文件' : '选择 Excel 文件' }}</span><PhFileArrowUp /></button>
                  <small v-if="supplementFile" class="wrfx-excel-filename"><PhCheckCircle />{{ supplementFile.name }}</small>
                  <small v-else class="wrfx-excel-hint">支持 .xls、.xlsx、.csv 格式</small>
                </div>
              </div>
            </div>
            <h3 class="wrfx-check-title">点位数据对比 <small>原系统与上传 Excel，按序号匹配</small></h3>
            <p class="wrfx-comparison-summary">{{ comparisonSummary }}</p>
            <div v-if="pointComparison?.rows.length" class="wrfx-comparison-wrap"><table class="wrfx-comparison wrfx-point-comparison"><thead><tr><th>序号</th><th>土壤镉<br>(mg/kg)</th><th>水稻镉<br>(mg/kg)</th><th>土壤砷<br>(mg/kg)</th><th>最大偏差</th></tr></thead><tbody><tr v-for="row in pointComparison.rows" :key="row.code"><th>{{ row.serial }}</th><td v-for="(value,index) in row.values" :key="index" :class="value.difference > 20 ? 'warn' : 'ok'">{{ metricText(value) }}</td><td :class="row.maxDifference > 20 ? 'warn' : 'ok'">{{ row.incomplete ? '部分缺失' : row.maxDifference === Infinity ? '原值为 0' : `${row.maxDifference.toFixed(1)}%` }}</td></tr></tbody></table></div>
            <div class="wrfx-check-rule"><b><PhInfo />核对口径</b><span>偏差 = |上传值 − 原系统值| ÷ |原系统值| × 100%。任一指标超过 20% 即列为较大差异；无较大差异时展示 3 条记录。原系统值为 0 且上传值非 0 时标记为无法计算。</span></div>
            <h3 class="wrfx-check-title">确认分析采用的数据</h3>
            <div class="wrfx-confirm-data-card"><label><input v-model="sourceChecked" type="checkbox" />主管人员补充 / 确认数据 <small>如有补充数据或现场说明，请勾选并上传</small></label><button class="wrfx-next-button" @click="confirmDataSource"><PhArrowRight />确认数据来源，开始分析</button></div>
            <div class="wrfx-check-summary"><h3>已缓存的调查信息 <small>{{ answeredSummary.length }} 项</small></h3><p v-for="item in answeredSummary" :key="item.label"><span>{{ item.label }}</span><b>{{ item.value }}</b></p></div>
            <button class="wrfx-back-button" @click="returnToSurvey">上一步　修改问卷信息</button>
          </template>
          <template v-else-if="stage === 2">
            <div class="wrfx-intro-label"><span></span>第二步 · 客户问卷调研</div>
            <h2>一起核实片区情况</h2>
            <p class="wrfx-intro-copy">预计 {{ questionCount }} 项，约 3–5 分钟。系统建议仅作参考；不确定的内容可选“待调研”，无需猜测。</p>
            <div class="wrfx-survey-scope"><small>已自动识别分析范围</small><strong>{{ confirmedData?.scope.name }}</strong><span>耕地面积 {{ formattedArea }} · {{ confirmedData?.plots.length || 0 }} 个图斑</span></div>
            <div class="wrfx-survey-progress"><span>已确认 {{ answeredCount }} / {{ questionCount }} 项</span><i><b :style="{width:`${Math.round(answeredCount/questionCount*100)}%`}" /></i></div>
            <section class="wrfx-question-group">
              <h3>{{ currentQuestion?.group }}</h3>
              <article v-if="currentQuestion" :key="currentQuestion.key" :ref="el => { if (el) questionRefs[questionnaireIndex] = el }" class="wrfx-question-card wrfx-current-question">
                <div class="wrfx-question-title"><span class="wrfx-question-mark">?</span><small>问题　{{ questionnaireIndex+1 }} / {{ questionCount }}</small></div>
                <h2 class="wrfx-prompt-title">{{ currentQuestion.label }}</h2>
                <p class="wrfx-recommendation">{{ currentQuestion.reason }}</p>
                <template v-if="currentQuestion.options">
                  <div class="wrfx-answer-options"><button v-for="(option,index) in currentQuestion.options" :key="option" type="button" :class="{ active: questionnaireAnswers[currentQuestion.key]===option, recommended: currentQuestion.recommendation===option }" @click="selectOption(option)"><span class="wrfx-option-number">{{ index + 1 }}</span><span>{{ option }}</span><small v-if="currentQuestion.recommendation===option">推荐</small><PhArrowRight class="wrfx-option-arrow" /></button><button type="button" :class="{ active: questionnaireAnswers[currentQuestion.key]==='待调研' }" @click="selectOption('待调研')"><span class="wrfx-option-number">{{ currentQuestion.options.length + 1 }}</span><span>暂时不确定</span><PhArrowRight class="wrfx-option-arrow" /></button></div>
                </template>
                <template v-else>
                  <div class="wrfx-answer-options"><button type="button" class="recommended" @click="selectAnswer(currentQuestion.recommendation)"><span class="wrfx-option-number">1</span><span>{{ currentQuestion.recommendation }}</span><small>自动识别</small><PhArrowRight class="wrfx-option-arrow" /></button></div>
                </template>
              </article>
              <div class="wrfx-question-nav"><button :disabled="questionnaireIndex<=0" @click="backQuestion">← 上一题</button><span>答题后自动进入下一题，也可返回修改</span></div>
            </section>
            <div v-if="surveyComplete" class="wrfx-survey-complete"><PhCheckCircle />问卷已完成，已记录 {{ answeredCount }} 项。您仍可点击下方任意答案进行修改。</div>
            <section class="wrfx-answered-list"><h3>已确认内容</h3><button v-for="(q,index) in questions.slice(0,questionnaireIndex)" :key="q.key" @click="questionnaireIndex=index"><span>{{ q.label }}</span><b>{{ surveyFiles[q.key]?.map(file=>file.name).join('、') || questionnaireAnswers[q.key] || '已跳过' }}</b><small>修改</small></button></section>
            <div v-if="surveyComplete" class="wrfx-survey-actions"><button class="wrfx-prev-button" @click="stage=1; questionnaireIndex=-1">← 上一步　修改分析范围</button><button class="wrfx-next-button" :disabled="surveyCacheSaving" @click="enterDataCheck">{{ surveyCacheSaving ? '正在缓存资料…' : '下一步　数据核对' }} <PhArrowRight /></button></div>
            <div v-if="surveyCacheError && surveyComplete" class="wrfx-notice">{{ surveyCacheError }}</div>
          </template>
          <template v-else>
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
            <label class="wrfx-field"><span>搜索区县、乡镇或村名</span><div class="wrfx-search-field"><PhMagnifyingGlass /><input v-model="administrativeSearchQuery" placeholder="如：常德市幸福村、汉寿县幸福村" @input="administrativeSearchOpen = true" @keydown.enter.prevent="searchAdministrative" /><button type="button" aria-label="搜索行政区" :disabled="regionsLoading || !!regionsError" @click="searchAdministrative"><PhArrowRight /></button></div></label>
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
            <label class="wrfx-field"><span>乡镇（街道）</span><select v-model="township" :disabled="!county || !regionData.townships.length || !!regionsError || scopeLoading" @change="updateVillageOptions"><option value="">{{ !regionData.townships.length ? 'GeoServer 尚未发布乡镇图层' : county ? '请选择乡镇（街道）' : '请先选择县（区）' }}</option><option v-for="item in townshipOptions" :key="item._region.code" :value="item._region.code">{{ displayName(item) }}</option></select></label>
            <label class="wrfx-field"><span>村</span><select v-model="village" :disabled="!regionData.villages.length || ((!township && !searchedVillage) || !!regionsError || scopeLoading)" @change="updateVillageSelection"><option value="">{{ !regionData.villages.length ? 'GeoServer 尚未发布村界图层' : township ? '请选择村' : searchedVillage ? '搜索村名已回填' : '请先选择乡镇（街道）' }}</option><option v-for="item in villageOptions" :key="item._region.key" :value="item._region.key">{{ displayName(item) }}</option></select></label>
            <p v-if="regionsLoading" class="wrfx-field-note"><PhInfo /> 正在从 GeoServer 读取湖南省、市、区县、乡镇和村界图层。</p>
            <p v-else-if="regionsError" class="wrfx-field-note error"><PhInfo /> {{ regionsError }} 服务地址：{{ geoserverEndpoint() }}</p>
            <p v-else-if="scopeLoading" class="wrfx-field-note"><PhInfo /> 正在自动定位并加载对应边界和耕地图斑…</p>
            <p v-else-if="!regionData.townships.length || !regionData.villages.length" class="wrfx-field-note"><PhInfo /> 当前 GeoServer 尚未发布乡镇和村界图层；省、市、县及耕地图斑可正常选择。</p>
            <p v-else class="wrfx-field-note"><PhInfo /> 选择县、乡镇或村后会自动定位并加载对应边界及耕地图斑。</p>
          </section>

          <section v-else-if="mode === 'cooperative'" class="wrfx-selection-panel">
            <div class="wrfx-panel-title"><PhHandshake />按合作社点位选择</div>
            <p class="wrfx-field-note"><PhMapPinLine /> 在下方输入合作社名称或地址搜索，也可点击右侧地图选点。</p>
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
            <div class="wrfx-import-box">
              <div class="wrfx-import-heading"><strong><PhDatabase />导入空间数据</strong><span>支持 GeoJSON / JSON</span></div>
              <button type="button" class="wrfx-import-row" @click="customBoundaryInput?.click()">
                <span class="wrfx-import-icon"><PhMapPinArea /></span><span class="wrfx-import-copy"><b>分析范围边界</b><small>上传区域边界文件，用于定位并确定分析范围</small></span>
                <span class="wrfx-import-action"><template v-if="customBoundary">已加载 <PhCheckCircle /></template><template v-else><PhFileArrowUp />上传</template></span>
                <input ref="customBoundaryInput" type="file" accept=".json,.geojson,application/geo+json,application/json" @change="onCustomBoundaryFile" />
              </button>
              <button type="button" class="wrfx-import-row" @click="customPlotsInput?.click()">
                <span class="wrfx-import-icon plots"><PhGridFour /></span><span class="wrfx-import-copy"><b>范围内耕地图斑</b><small>上传该边界内的耕地图斑，在地图上叠加展示</small></span>
                <span class="wrfx-import-action"><template v-if="customPlotFeatures">{{ customPlotFeatures.length }} 个图斑 <PhCheckCircle /></template><template v-else><PhFileArrowUp />上传</template></span>
                <input ref="customPlotsInput" type="file" accept=".json,.geojson,application/geo+json,application/json" @change="onCustomPlotsFile" />
              </button>
            </div>
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
          <p class="wrfx-next-hint"><PhSlidersHorizontal /> 下一步：逐题核实区域生产与污染源信息</p>
          </template>
          </div>
        </div>
        <form class="wrfx-composer" @submit.prevent="searchCooperative">
          <div class="wrfx-composer-inner">
          <div class="wrfx-composer-box">
            <textarea v-model="locationQuery" rows="2" placeholder="输入地名、地址或合作社名称…" aria-label="输入地名、地址或合作社名称" @keydown.enter.exact.prevent="searchCooperative"></textarea>
            <div class="wrfx-composer-actions">
              <button type="button" class="wrfx-composer-pick" @click="chooseMode('cooperative')"><PhMapPinLine />地图选点</button>
              <button type="submit" class="wrfx-composer-submit" aria-label="搜索位置" :disabled="searching || !locationQuery.trim()"><PhMagnifyingGlass v-if="!searching" /><span v-else class="wrfx-search-spinner"></span></button>
            </div>
          </div>
          <p>输入位置后搜索，或点击地图选点 · 搜索结果在左侧显示</p>
          </div>
        </form>
      </aside>

      <div class="wrfx-divider" role="separator" aria-label="调整左侧对话栏和地图宽度" aria-orientation="vertical" tabindex="0" :aria-valuenow="Math.round(sidebarWidth ?? 355)" @pointerdown="startDividerDrag" @keydown="resizeDividerByKeyboard"><span></span></div>

      <section class="wrfx-map-panel" :class="{ 'data-check-map': stage === 3 }">
        <div class="wrfx-map-toolbar">
          <div class="wrfx-map-tabs"><span class="active"><PhMapTrifold />区域地图</span><span><PhDatabase />数据覆盖</span></div>
          <div class="wrfx-map-source"><span class="status-light"></span>天地图影像 <b>CGCS2000</b></div>
        </div>
        <ScopeMap ref="mapRef" :drawing="drawing" :picking="stage === 1 && mode === 'cooperative'" :analysis-points="analysisPoints" :analysis-metric="analysisMetric" :analysis-boundaries="analysisBoundaries" :show-analysis="stage === 4" @polygon-selected="onPolygonSelected" @point-picked="onMapPointPicked" />
        <div v-if="stage !== 4" class="wrfx-map-search">
          <PhMagnifyingGlass />
          <input v-model="locationQuery" :placeholder="mode === 'cooperative' ? '搜索合作社名称、地名或地址' : '搜索地名或地址'" @keydown.enter.prevent="searchCooperative" />
          <button aria-label="搜索地点" :disabled="searching" @click="searchCooperative"><PhArrowRight /></button>
        </div>
        <div v-if="stage !== 4" class="wrfx-map-tip"><span class="wrfx-tip-icon"><PhMapPin /></span><div><strong>{{ mode === 'cooperative' ? '点击地图选择合作社位置' : '选择分析范围' }}</strong><small>{{ mode === 'polygon' ? '点击“开始圈选”，在地图上绘制多边形边界' : mode === 'cooperative' ? '也可在左侧搜索合作社名称、地名或地址' : '可在左侧选择行政区或切换至地图圈选' }}</small></div></div>
        <div v-if="stage === 4 && analysisPoints.length" class="wrfx-analysis-map-legend"><strong>{{ activeMetric.label }} · {{ analysisYear }} 年</strong><span v-for="(bin, index) in activeDistribution" :key="index"><i :style="{ background: ['#43dc4a','#eae940','#ff9d32','#d83ade'][index % 4] }"></i>{{ bin.label }} <b>{{ bin.count }}</b></span><small>分组展示，不代表超标等级</small></div>
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
