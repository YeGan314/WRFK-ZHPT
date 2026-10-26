import test from "node:test";
import assert from "node:assert/strict";
import {
  numeric,
  normalizePoint,
  normalizeLocations,
  normalizeScheme,
  recommend,
  reportMarkdown,
  routes,
} from "../src/lib/analysis.js";
import { extractContext } from "../server/governance.js";
const metrics = {
  soilCd: 0.48,
  soilAs: 14.75,
  ph: 4.81,
  som: 37.52,
  cec: 14.11,
  riceCd: 0.28608,
  riceAs: 0.198,
};
const risk = { targetCd: 0.2, targetAs: 0.35 };
const context = {
  planCostYuan: 40,
  dataYear: 2025,
  expectedComplianceRate: 100,
  factorsMap: {
    Cd: {
      totalRate: 34,
      planMap: {
        a: {
          statusCode: 9,
          isExecute: true,
          planInfoModel: { planName: "石灰技术", planType: "1" },
          planResult: "石灰用量100kg/亩",
          costYuan: 40,
        },
        b: {
          statusCode: 9,
          isExecute: true,
          planInfoModel: { planName: "判断节点", planType: "0" },
        },
      },
    },
    As: { totalRate: 0, planMap: {} },
  },
};
const normalized = () => normalizeScheme(routes[1], context, metrics, risk);
test("missing values remain unknown, while a measured zero remains zero", () => {
  assert.equal(numeric(null), null);
  assert.equal(numeric(""), null);
  assert.equal(numeric(false), null);
  assert.equal(numeric(0), 0);
  assert.equal(normalizePoint({}).metrics.riceCd, null);
});
test("point values and provenance stay paired", () => {
  const p = normalizePoint({
    predictedSoil: {
      ok: true,
      data: {
        ph: 4.81,
        predictResult: metrics,
        sourceMeta: { soilCd: "CONFIG" },
      },
    },
    fluxData: { ok: false },
  });
  assert.equal(p.sources.soilCd, "CONFIG");
  assert.equal(p.metrics.soilCd, 0.48);
  assert.equal(p.partial, true);
});
test("invalid location results are not selectable", () =>
  assert.equal(
    normalizeLocations([
      { lon: null, lat: null },
      { lon: "112.6", lat: "28.5", name: "test" },
      { lon: 181, lat: 10 },
    ]).length,
    1,
  ));
test("real model result supplies reportable measures, not routing nodes", () => {
  const s = normalized();
  assert.equal(s.technologies.length, 1);
  assert.equal(s.cost, 40);
  assert.equal(s.canGenerate, true);
  assert.equal(s.meetsTarget, true);
  assert.ok(Math.abs(s.cdAfter - 0.1888128) < 1e-8);
});
test("missing As prediction cannot imply full compliance", () => {
  const s = normalizeScheme(
    routes[1],
    { ...context, factorsMap: { Cd: context.factorsMap.Cd } },
    metrics,
    risk,
  );
  assert.equal(s.asAfter, null);
  assert.equal(s.meetsTarget, null);
});
test("natural repair does not claim rice compliance", () => {
  const s = normalizeScheme(routes[3], context, metrics, risk);
  assert.equal(s.meetsTarget, null);
  assert.equal(s.effectLabel, "土壤镉");
  assert.equal(recommend([s]), null);
  assert.equal(recommend([s], "longterm").id, "natural");
});
test("unresolved implementation parameters stay visible and are marked for confirmation", () => {
  const c = structuredClone(context);
  c.factorsMap.Cd.planMap.a.planResult = "石灰用量{x}kg";
  const plan = normalizeScheme(routes[1], c, metrics, risk);
  assert.equal(plan.canGenerate, true);
  assert.equal(plan.technologies[0].incomplete, true);
  assert.match(plan.technologies[0].detail, /农技人员确认/);
});
test("recommendation respects missing costs and no-variety constraint", () => {
  const p = normalized();
  assert.equal(recommend([{ ...p, cost: null }]), null);
  assert.equal(recommend([{ ...p, changeVariety: true }], "cost", true), null);
  assert.equal(recommend([{ ...p, status: "loading" }]), null);
  assert.equal(recommend([p, { ...p, id: "expensive", cost: 80 }]).id, p.id);
});
test("report is built from the selected plan and user area", () => {
  const p = normalized();
  const md = reportMarkdown({
    point: { name: "测试点", longitude: 112, latitude: 28 },
    plan: p,
    metrics,
    risk,
    area: 10,
    createdAt: "test",
    notes: "测试备注",
  });
  assert.match(md, /100kg\/亩/);
  assert.match(md, /400 元/);
  assert.match(md, /测试备注/);
  assert.doesNotMatch(md, /186.4/);
});
test("websocket envelopes retain context IDs for isolation", () => {
  assert.equal(
    extractContext(
      JSON.stringify({
        content: JSON.stringify({ context: { contextCode: "specific-run" } }),
      }),
    ).contextCode,
    "specific-run",
  );
  assert.equal(extractContext({ type: "heartbeat" }), undefined);
});
test("switching crops never claims rice compliance and respects no-change preference", () => {
  const c = structuredClone(context);
  c.factorsMap.Cd.planMap.a.planInfoModel.planName = "种植结构调整";
  c.factorsMap.Cd.planMap.a.planResult = "种植类型为玉米。";
  const s = normalizeScheme(routes[1], c, metrics, risk);
  assert.equal(s.changesCrop, true);
  assert.equal(s.meetsTarget, null);
  assert.equal(s.cdAfter, null);
  assert.equal(s.changeVariety, true);
  assert.equal(recommend([s]), null);
});
