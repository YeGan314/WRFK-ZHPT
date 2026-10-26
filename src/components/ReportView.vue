<script setup>
import { computed, ref } from "vue";
import {
  PhDownloadSimple,
  PhPrinter,
  PhCheckCircle,
  PhArrowLeft,
} from "@phosphor-icons/vue";
import { format, metricDefs, reportMarkdown } from "../lib/analysis";
const props = defineProps({ report: Object });
const emit = defineEmits(["back"]);
const area = ref(props.report.area ? String(props.report.area) : "");
const notes = ref("");
const validArea = computed(
  () =>
    area.value !== "" &&
    Number(area.value) > 0 &&
    Number.isFinite(Number(area.value)),
);
const invalidArea = computed(() => area.value !== "" && !validArea.value);
const effectiveArea = computed(() => validArea.value ? Number(area.value) : props.report.area || null);
const snapshot = computed(() => ({
  ...props.report,
  area: effectiveArea.value,
  notes: notes.value,
}));
function download() {
  const file = new Blob([reportMarkdown(snapshot.value)], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = `农田治理实施方案-${props.report.plan.name}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function print() {
  window.print();
}
</script>
<template>
  <section class="report-view">
    <div class="report-toolbar no-print">
      <button class="text-button" @click="emit('back')">
        <PhArrowLeft :size="17" />返回方案对比
      </button>
      <div>
        <button class="secondary" :disabled="invalidArea" @click="download">
          <PhDownloadSimple :size="17" />下载文本方案</button
        ><button class="primary" :disabled="invalidArea" @click="print">
          <PhPrinter :size="17" />打印 / 存为 PDF
        </button>
      </div>
    </div>
    <article class="report-paper">
      <div class="report-eyebrow">
        FIELD MANAGEMENT PLAN
        <span><PhCheckCircle :size="16" />已选择方案</span>
      </div>
      <h1>农田治理实施方案</h1>
      <p class="report-location">
        {{ report.point.name || report.point.address || "地图选点" }}
      </p>
      <p class="muted small">生成于 {{ report.createdAt }} · 点位分析</p>
      <section class="report-highlight">
        <span>本次选定</span>
        <h2>{{ report.plan.title }}</h2>
        <p>
          {{ report.plan.name }} · {{ report.plan.technologies.length }} 项措施
        </p>
      </section>
      <h2 class="report-section-title">01 <span>这块地的基本情况</span></h2>
      <div class="report-metrics">
        <div v-for="[key, label, unit] in metricDefs" :key="key">
          <span>{{ label }}</span
          ><b
            >{{ format(report.metrics[key]) }} <small>{{ unit }}</small></b
          >
        </div>
      </div>
      <p class="report-note">
        位置：{{ format(report.point.longitude, 6) }}，{{
          format(report.point.latitude, 6)
        }}。数据为所选点位关联的预测与配置数据，尚未确认整块田边界。
      </p>
      <h2 class="report-section-title">02 <span>需要做哪些事</span></h2>
      <div
        v-for="(tech, i) in report.plan.technologies"
        :key="i"
        class="implementation-step"
      >
        <span>{{ String(i + 1).padStart(2, "0") }}</span>
        <div>
          <h3>{{ tech.name }}</h3>
          <p>{{ techGuidance(tech) }}</p>
        </div>
      </div>
      <h2 class="report-section-title">03 <span>预期效果和投入</span></h2>
      <dl class="report-facts">
        <div>
          <dt>
            {{
              report.plan.changesCrop
                ? "作物变更"
                : report.plan.effectLabel + "预测"
            }}
          </dt>
          <dd>
            {{
              report.plan.changesCrop
                ? "涉及改种，稻米预测口径不适用"
                : format(report.plan.cdBefore) +
                  " → " +
                  format(report.plan.cdAfter) +
                  " mg/kg"
            }}
          </dd>
        </div>
        <div>
          <dt>预计每亩投入</dt>
          <dd>{{ format(report.plan.cost, 2) }} 元 / 亩</dd>
        </div>
        <div>
          <dt>见效周期</dt>
          <dd>{{ report.plan.cycle }}</dd>
        </div>
        <div>
          <dt>本轮稻米指标目标</dt>
          <dd>
            镉 {{ format(report.risk.targetCd) }} / 砷
            {{ format(report.risk.targetAs) }} mg/kg
          </dd>
        </div>
      </dl>
      <div class="area-estimate">
        <label for="area">治理面积 <small>{{ effectiveArea ? "用于估算总投入" : "等待左侧对话输入面积" }}</small></label>
        <div>
          <input
            id="area"
            v-model="area"
            type="number"
            min="0.01"
            step="0.01"
            :placeholder="effectiveArea ? `本轮面积 ${effectiveArea} 亩` : '在左侧对话输入，例如：20亩'"
            :aria-invalid="invalidArea"
            :readonly="Boolean(report.area)"
          /><span>亩</span
          ><strong>{{
              effectiveArea && report.plan.cost !== null
              ? format(Number(effectiveArea) * report.plan.cost, 2) + " 元"
              : "总投入待估算"
          }}</strong>
        </div>
        <p v-if="effectiveArea && report.plan.cost !== null" class="small muted">按 {{ format(effectiveArea, 2) }} 亩 × {{ format(report.plan.cost, 2) }} 元/亩估算，未额外估算人工、运输及维护费用。</p>
        <p v-if="invalidArea" class="error-inline">请填写大于 0 的有效面积。</p>
        <p v-else-if="!effectiveArea" class="small muted">方案草案已生成；填写田块面积后，系统会自动计算总成本。</p>
      </div>
      <p class="report-note">
        总投入按后台每亩模型费用估算，未额外推测人工、运输及后续维护成本。面积由用户补充，不代表系统已识别地块范围。
      </p>
      <h2 class="report-section-title">04 <span>实施与复测安排</span></h2>
      <ol class="monitoring-list">
        <li><b>实施前</b> 核实地块范围、种植条件及材料用量。</li>
        <li><b>实施中</b> 按选定措施执行，记录投入和农事操作。</li>
        <li>
          <b>实施后</b> 由农技人员确定复测时间与采样安排，以检测结果核验效果。
        </li>
      </ol>
      <label class="notes-label" for="plan-notes">我的备注</label
      ><textarea
        id="plan-notes"
        v-model="notes"
        placeholder="可补充农事时间、负责人或实施安排…"
        rows="3"
      ></textarea>
      <footer class="report-footer">
        数据来源：原平台点位数据与治理模型 · 模型配置年份
        {{ report.plan.year || "未返回"
        }}<br />模型预测不等于现场检测；后台默认目标参数不代表实际达标保证。具体周期和未返回的费用需进一步核实。
      </footer>
    </article>
  </section>
</template>
<script>
function techGuidance(tech) {
  const t = `${tech.name} ${tech.detail || ""}`;
  if (/石灰|调酸|碱性.*调理/.test(t))
    return "安排在当季第一季水稻移栽前，或秋冬闲田/冬作物播前；翻耕前均匀撒施，再翻耕混入耕层。先测土壤 pH，按目标 pH、质地及产品有效成分核定用量，不直接照搬通用亩用量；pH≤5.5 可分批施用并复测。选用合规且重金属含量达标的材料。";
  if (/叶面|喷施|阻控剂/.test(t))
    return "常见时期为水稻分蘖末期/盛期、抽穗灌浆初期，按产品标签选用适用的合规产品，避开高温、大风和降雨；喷施浓度和亩用量按标签或本地农技方案，不能自行套用。";
  if (/低积累|品种|改种/.test(t))
    return "下一季播种/育秧前核实当地审定且适宜本区域、经镉低积累试验验证的品种，按当地农时采购合格种子并安排育秧、移栽。";
  if (/水分|灌溉|排水|淹水/.test(t))
    return "按当地水稻生育期方案调节灌排并确认灌溉条件。镉砷复合污染地块不应直接套用单一控镉水分模式；先核实砷风险、灌溉水质和当地农技意见，再制定水层安排。";
  if (/有机肥|有机物|秸秆|培肥/.test(t))
    return "在整地/翻耕前按测土结果及产品登记说明安排施用、与耕层混匀。先核实物料重金属和质量指标；污染等级及秸秆安全性未确认前，不直接确定用量或还田。";
  if (/钝化|调理剂/.test(t))
    return "整地前依据污染类型、土壤 pH 和产品登记适用范围选材；翻耕时均匀撒施并按说明混入耕层。核实材料重金属含量，剂量以土壤检测和本地农技方案为准。";
  return tech.detail || "按产品说明和当地农技方案执行；具体用量及日期需结合检测结果确认。";
}
</script>
