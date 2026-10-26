export const routes = [
  {
    id: "variety",
    name: "品种优先",
    category: "风险管控",
    caption: "优先评估品种调整",
    type: 2,
  },
  {
    id: "benefit",
    name: "效益优先",
    category: "风险管控",
    caption: "优先评估经济可行性",
    type: 3,
  },
  {
    id: "ecology",
    name: "生态优先",
    category: "风险管控",
    caption: "评估组合治理措施",
    type: 4,
  },
  {
    id: "natural",
    name: "自然修复",
    category: "土壤修复",
    caption: "评估土壤长期改善",
    type: 49,
  },
];
export const metricDefs = [
  ["ph", "酸碱度 pH", "", ["ph", "pH"]],
  ["soilCd", "土壤镉", "mg/kg", ["soilCd"]],
  ["soilAs", "土壤砷", "mg/kg", ["soilAs"]],
  ["som", "有机质", "g/kg", ["som", "SOM"]],
  ["cec", "阳离子交换量", "cmol/kg", ["cec", "CEC"]],
  ["availableCd", "有效态镉", "mg/kg", ["availableCd", "soilACd"]],
  ["availableAs", "有效态砷", "mg/kg", ["availableAs", "soilAAs"]],
  ["riceCd", "稻米镉", "mg/kg", ["riceCd"]],
  ["riceAs", "稻米砷", "mg/kg", ["riceAs"]],
];
export function numeric(value) {
  if (
    value === "" ||
    value === null ||
    value === undefined ||
    typeof value === "boolean"
  )
    return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function format(value, digits = 3) {
  const n = numeric(value);
  return n === null
    ? "待补充"
    : n.toLocaleString("zh-CN", { maximumFractionDigits: digits });
}
export function textOnly(value) {
  return String(value ?? "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/@/g, "\n")
    .trim();
}
export function normalizePoint(data) {
  const soil = data.predictedSoil?.ok ? data.predictedSoil.data || {} : {};
  const fields = { ...soil, ...soil.predictResult };
  const metrics = Object.fromEntries(
    metricDefs.map(([key, , , aliases]) => [
      key,
      numeric(
        aliases
          .map((k) => fields[k])
          .find((v) => v !== undefined && v !== null),
      ),
    ]),
  );
  const sources = soil.sourceMeta || {};
  return {
    metrics,
    sources,
    flux: data.fluxData?.ok ? data.fluxData.data || {} : {},
    sourceDate: soil.dataYear || soil.dataTime || null,
    dkCode: soil.dkCode || data.reverseGeocode?.data?.dkCode || null,
    address: data.reverseGeocode?.data?.address,
    partial: !data.predictedSoil?.ok || !data.fluxData?.ok,
  };
}
export function sourceLabel(value) {
  return (
    {
      CONFIG: "平台默认值",
      TIF: "栅格估算",
      DDPA: "模型推算",
      GROWER: "大户档案",
      MEASURED: "实测数据",
    }[value] || "来源待核实"
  );
}
export function metricReference(key, { targetCd, targetAs } = {}) {
  if (key === "riceCd" && numeric(targetCd) !== null)
    return `≤ ${format(targetCd)} mg/kg（平台目标）`;
  if (key === "riceAs" && numeric(targetAs) !== null)
    return `≤ ${format(targetAs)} mg/kg（平台目标）`;
  if (key === "soilCd" || key === "soilAs") return "按点位风险评估判级";
  return "暂无统一参考范围";
}
export function metricDeviation(key, value, { targetCd, targetAs } = {}) {
  const current = numeric(value);
  const target =
    key === "riceCd"
      ? numeric(targetCd)
      : key === "riceAs"
        ? numeric(targetAs)
        : null;
  if (current === null) return { tone: "neutral", icon: "—", label: "待补充" };
  if (target === null)
    return { tone: "neutral", icon: "—", label: "参考值未配置" };
  if (current <= target)
    return { tone: "normal", icon: "✓", label: "未超过目标" };
  const ratio = current / target;
  return ratio <= 1.2
    ? { tone: "warning", icon: "⬆", label: "略高于目标" }
    : { tone: "danger", icon: "⬆", label: "明显高于目标" };
}
export function buildFlux(flux) {
  const groups = [
    ["Cd", "镉"],
    ["As", "砷"],
  ];
  const labels = {
    1: "大气沉降",
    2: "灌溉水",
    3: "农业投入品",
    8: "秸秆离田",
    7: "作物收获",
    5: "地表径流",
    6: "其他输出",
  };
  return groups.map(([key, name]) => {
    const rows = (ids) =>
      ids
        .map((id) => ({
          label: labels[id],
          value: numeric(flux[`flux_${id}_${key}`]),
        }))
        .filter((x) => x.value !== null)
        .map((x) => ({ ...x, value: (x.value * 1000) / 15 }));
    const inputs = rows([1, 2, 3]),
      outputs = rows([8, 7, 5, 6]);
    const sum = (list) => list.reduce((a, b) => a + b.value, 0);
    return {
      name,
      inputs,
      outputs,
      net: inputs.length && outputs.length ? sum(inputs) - sum(outputs) : null,
    };
  });
}
export function normalizeScheme(route, context, metrics, risk) {
  const factors = context.factorsMap || {};
  const technologies = [];
  for (const factor of Object.values(factors))
    for (const plan of Object.values(factor.planMap || {})) {
      const info = plan.planInfoModel;
      if (
        Number(plan.statusCode) === 9 &&
        info &&
        String(info.planType) !== "0" &&
        plan.isExecute !== false
      ) {
        const name = textOnly(info.planName);
        const rawDetail = textOnly(plan.planResult);
        const incomplete = !rawDetail || /\{[^}]+\}/.test(rawDetail);
        const detail = incomplete
          ? "后台未返回完整实施参数，执行前需由农技人员确认。"
          : rawDetail;
        if (!technologies.some((t) => t.name === name))
          technologies.push({
            name,
            detail,
            incomplete,
            cost: numeric(plan.costYuan),
          });
      }
    }
  const natural = route.id === "natural";
  const changesCrop = technologies.some((t) =>
    /种植结构|改种|种植类型为/.test(t.name + " " + t.detail),
  );
  const cdRate = numeric((factors.Cd || factors.cd)?.totalRate);
  const asRate = numeric((factors.As || factors.as)?.totalRate);
  const predict = (n, rate) =>
    numeric(n) !== null && rate !== null && rate >= 0 && rate <= 100
      ? n * (1 - rate / 100)
      : null;
  const cdBefore = natural ? metrics.soilCd : metrics.riceCd;
  const cdAfter = changesCrop ? null : predict(cdBefore, cdRate);
  const asAfter =
    natural || changesCrop ? null : predict(metrics.riceAs, asRate);
  const targetCd = numeric(risk.targetCd),
    targetAs = numeric(risk.targetAs);
  const meetsTarget =
    !natural &&
    cdAfter !== null &&
    asAfter !== null &&
    targetCd !== null &&
    targetAs !== null
      ? cdAfter <= targetCd && asAfter <= targetAs
      : null;
  const cost = numeric(context.planCostYuan);
  const years = numeric((factors.Cd || factors.cd)?.repairYears);
  return {
    ...route,
    status: "done",
    technologies,
    title: technologies.map((t) => t.name).join(" + ") || route.name,
    description: textOnly(
      context.solutionDesc || context.proposalDesc || context.msg,
    ).replace(/用户所选的/g, "后台默认的"),
    cost,
    cdRate,
    asRate,
    cdBefore,
    cdAfter,
    asAfter,
    meetsTarget,
    effectLabel: natural ? "土壤镉" : "稻米镉",
    year: context.dataYear || null,
    expectedRate: numeric(context.expectedComplianceRate),
    cycle:
      years !== null && years > 0
        ? `${format(years)} 年（模型返回）`
        : "模型未提供周期",
    cycleYears: years !== null && years > 0 ? years : null,
    changesCrop,
    changeVariety: changesCrop || technologies.some((t) => /品种/.test(t.name)),
    constraints: changesCrop
      ? "包含作物调整，需先确认是否接受改种"
      : technologies.length
        ? technologies.some((t) => t.incomplete)
          ? "部分实施参数待确认，方案可先作核对稿"
          : "具体农事安排需结合当地种植条件确认"
        : "模型未返回具体实施措施",
    canGenerate: technologies.length > 0,
  };
}
export function recommend(schemes, preference = "balanced", noVariety = false) {
  let candidates = schemes.filter(
    (s) =>
      s.status === "done" && s.canGenerate && (!noVariety || !s.changeVariety),
  );
  // Long-term soil improvement is a separate objective and need not satisfy
  // an immediate rice-grain target in the same model run.
  if (preference === "longterm") {
    const ecological = candidates.find((s) => s.id === "ecology");
    if (ecological) return ecological;
    return candidates.find(
      (s) => s.id === "natural" && s.cdAfter !== null && s.cdAfter < s.cdBefore,
    ) || null;
  }
  candidates = candidates.filter((s) => s.meetsTarget === true);
  if (preference === "balanced" || preference === "cost")
    candidates = candidates.filter((s) => s.cost !== null);
  if (preference === "simple")
    candidates.sort(
      (a, b) =>
        a.technologies.length - b.technologies.length ||
        (a.cost ?? Infinity) - (b.cost ?? Infinity),
    );
  else if (preference === "effect")
    candidates.sort(
      (a, b) => (a.cdAfter ?? Infinity) - (b.cdAfter ?? Infinity),
    );
  else
    candidates.sort(
      (a, b) =>
        (a.cost ?? Infinity) - (b.cost ?? Infinity) ||
        a.technologies.length - b.technologies.length,
    );
  return candidates[0] || null;
}
export function recommendationReason(plan, preference, partial) {
  if (!plan)
    return "当前结果不足以确认哪项方案能满足你的目标。可查看已返回措施，或调整偏好继续比较。";
  const reason =
    preference === "longterm"
      ? "已将生态优先路线排在首位；土壤长期改善效果仍需结合后续土壤复测确认。"
      : preference === "simple"
        ? "在预计达到稻米目标的方案中，需要执行的措施较少。"
        : preference === "effect"
          ? "在预计达到稻米目标的方案中，稻米镉预测值更低。"
          : "在预计达到稻米目标且有成本数据的方案中，每亩投入较低。";
  return `${partial ? "基于当前已完成结果：" : ""}${reason}实际效果以复测为准。`;
}
export function normalizeLocations(result) {
  const source = Array.isArray(result)
    ? result
    : result?.list || result?.results || [];
  return source
    .map((x) => ({
      ...x,
      longitude: numeric(x.lon ?? x.longitude),
      latitude: numeric(x.lat ?? x.latitude),
      name: x.name || x.growerName || x.address || "地图位置",
    }))
    .filter(
      (x) =>
        x.longitude !== null &&
        x.latitude !== null &&
        Math.abs(x.longitude) <= 180 &&
        Math.abs(x.latitude) <= 90,
    );
}
function reportTechnologyGuidance(tech) {
  const t = `${tech.name} ${tech.detail || ""}`;
  if (/石灰|调酸|碱性.*调理/.test(t))
    return `${tech.detail ? `模型措施参数：${tech.detail}。` : ""}当季第一季水稻移栽前或秋冬闲田/冬作物播前施用；翻耕前均匀撒施并混入耕层。按土壤pH、质地、产品有效成分和检测结果核量，不照搬未经核实的亩用量；pH≤5.5可分次施用并复测。使用重金属含量达标的合规材料。`;
  if (/叶面|喷施|阻控剂/.test(t))
    return "常见时期为分蘖末期/盛期及抽穗灌浆初期。选择适用的合规产品，按标签确定浓度、亩用量和天气条件，避开高温、大风、降雨。";
  if (/低积累|品种|改种/.test(t))
    return "下一季播种/育秧前确认适宜本地、经镉低积累验证的审定品种，按本地农时采购合格种子。";
  if (/水分|灌溉|排水|淹水/.test(t))
    return "按本地农技方案与水稻生育期安排灌排。镉砷复合污染地块不可直接套用单一控镉水分模式，须先核实砷风险与水源条件。";
  if (/有机肥|有机物|秸秆|培肥/.test(t))
    return "整地/翻耕前按土壤检测和产品登记说明安排。先核实物料重金属指标；污染等级和秸秆安全性不清时不直接确定还田与剂量。";
  if (/钝化|调理剂/.test(t))
    return "整地前按污染类型、土壤pH及产品登记范围选材，翻耕时均匀施用并混入耕层；实际剂量以土壤检测和本地农技方案为准。";
  return tech.detail || "具体用量和日期需按产品说明、检测结果及本地农技方案确认。";
}
export function reportMarkdown(report) {
  const { point, plan, metrics, risk, area, createdAt, notes } = report;
  return `# 农田治理实施方案\n\n${point.name || point.address || "地图选点"}\n\n生成时间：${createdAt}\n分析范围：点位及其关联数据，未确认整块田边界。\n坐标：${point.longitude}，${point.latitude}\n\n## 选定方案\n\n${plan.name}：${plan.title}\n\n## 基础情况\n\n${metricDefs.map(([k, n, u]) => `- ${n}：${format(metrics[k])} ${u}`).join("\n")}\n\n## 具体措施与农时\n\n${plan.technologies.map((t, i) => `${i + 1}. ${t.name}\n   ${reportTechnologyGuidance(t)}`).join("\n\n")}\n\n## 预期效果与投入\n\n- ${plan.changesCrop ? "该方案涉及改种，稻米预测口径不适用，需要确认新作物评价目标。" : `${plan.effectLabel}：${format(plan.cdBefore)} → ${format(plan.cdAfter)} mg/kg（模型预测）`}\n- 稻米目标：镉 ${format(risk.targetCd)} mg/kg，砷 ${format(risk.targetAs)} mg/kg（后台配置）\n- 每亩投入：${format(plan.cost, 2)} 元，按 1 亩模型计算\n- 面积：${area ? format(area, 2) + " 亩（用户补充）" : "未填写"}\n- 总投入：${area && plan.cost !== null ? format(area * plan.cost, 2) + " 元（按每亩费用估算）" : "未估算"}\n- 周期：${plan.cycle}\n\n## 执行与复测\n\n- 实施前：核实地块范围、种植条件及材料用量。\n- 实施中：按选定措施执行，记录投入和农事操作。\n- 实施后：由农技人员确定复测时间和采样安排，以检测结果核验效果。\n\n## 数据说明\n\n使用平台点位预测、默认配置及通量数据，不等同于现场检测。模型配置年份：${plan.year || "未返回"}。缺失的周期、人工及后续维护成本未作推测。期望达标率是模型目标参数，不是达标保证。\n\n${notes ? "## 我的备注\n\n" + notes : ""}`;
}
