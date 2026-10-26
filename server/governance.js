import { randomUUID } from "node:crypto";

export const ROUTES = [
  { id: "variety", name: "品种优先", type: 2, bizType: 1 },
  { id: "benefit", name: "效益优先", type: 3, bizType: 1 },
  { id: "ecology", name: "生态优先", type: 4, bizType: 1 },
  { id: "natural", name: "自然修复", type: 49, bizType: 49 },
];

export async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error("请求内容过长");
  }
  return body ? JSON.parse(body) : {};
}

function json(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function validPoint(data) {
  const lon = Number(data.lon ?? data.longitude);
  const lat = Number(data.lat ?? data.latitude);
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    lon < -180 ||
    lon > 180 ||
    lat < -90 ||
    lat > 90
  ) {
    throw new Error("请选择有效的地图位置");
  }
  return { lon, lat };
}

const inputFields = [
  "soilCd",
  "soilAs",
  "ph",
  "som",
  "cec",
  "riceCd",
  "riceAs",
  "availableCd",
  "availableAs",
];
export function pointInput(data) {
  const point = validPoint(data);
  for (const key of inputFields) {
    if (
      data[key] !== null &&
      data[key] !== "" &&
      data[key] !== undefined &&
      Number.isFinite(Number(data[key]))
    )
      // Original PointAnalysisMap: ue() -> b(value) -> Et(value, 2).
      // Keep coordinates and flux precision; only model soil/rice inputs round.
      point[key] = Number(Number(data[key]).toFixed(2));
  }
  // Models expect an area. One mu is the explicit calculation basis, not a claimed field area.
  point.areaMu = 1;
  point.fluxData =
    data.fluxData && typeof data.fluxData === "object" ? data.fluxData : {};
  return point;
}

export function extractContext(message) {
  const outer = typeof message === "string" ? JSON.parse(message) : message;
  const content =
    typeof outer.content === "string"
      ? JSON.parse(outer.content)
      : outer.content;
  return content?.context;
}

export function createGovernanceRunner(client, env, Socket = WebSocket) {
  let socket = null,
    connection = null,
    idleTimer = null;
  const pending = new Map();
  function rejectPending(error) {
    for (const finish of [...pending.values()]) finish(error);
  }
  function idleClose() {
    clearTimeout(idleTimer);
    if (!pending.size)
      idleTimer = setTimeout(() => {
        if (!pending.size && socket) {
          const old = socket;
          socket = null;
          old.close();
        }
      }, 1000);
  }
  function connect() {
    clearTimeout(idleTimer);
    if (socket?.readyState === 1) return Promise.resolve(socket);
    if (connection) return connection;
    connection = (async () => {
      const token = await client.getAccessToken();
      const base =
        env.CPHMP_API_BASE_URL ||
        process.env.CPHMP_API_BASE_URL ||
        "http://113.240.240.3:8099/dev-api";
      const url = new URL("/infra/ws", base);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("token", token);
      const ws = new Socket(url);
      socket = ws;
      ws.addEventListener("message", (event) => {
        try {
          const context = extractContext(event.data);
          const finish = pending.get(context?.contextCode);
          if (!finish) return;
          if (Number(context.code) === -1)
            return finish(new Error(context.msg || "该治理路线暂不可用"));
          if (
            (context.solutionDesc || context.proposalDesc || context.msg) &&
            (Number(context.code) === 1 || Number(context.status) === 9)
          )
            finish(null, context);
        } catch {
          /* Non-workflow messages are not part of this analysis. */
        }
      });
      ws.addEventListener("close", () => {
        if (socket === ws) {
          socket = null;
          rejectPending(new Error("方案结果连接中断，请重试"));
        }
      });
      ws.addEventListener("error", () =>
        rejectPending(new Error("方案结果连接失败，请稍后重试")),
      );
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("方案结果连接超时"));
          ws.close();
        }, 15000);
        const done = (callback) => (event) => {
          clearTimeout(timer);
          callback(event);
        };
        ws.addEventListener("open", done(resolve), { once: true });
        ws.addEventListener(
          "error",
          done(() => reject(new Error("方案结果连接失败"))),
          { once: true },
        );
        ws.addEventListener(
          "close",
          done(() => reject(new Error("方案结果连接中断"))),
          { once: true },
        );
      });
      return ws;
    })().finally(() => {
      connection = null;
    });
    return connection;
  }
  async function run(input, route, assessment, signal) {
    if (signal?.aborted) throw new Error("分析已取消");
    const level =
      route.bizType === 49
        ? assessment?.naturalRepairLevel
        : assessment?.riskControlLevel;
    if (level === null || level === undefined)
      throw new Error("风险分析未返回此路线所需的治理单元，暂不能计算");
    await connect();
    if (signal?.aborted) {
      idleClose();
      throw new Error("分析已取消");
    }
    const contextCode = `POINT_${randomUUID()}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => finish(new Error("该路线计算超时，请稍后单独重试")),
        30000,
      );
      const abort = () => finish(new Error("分析已取消"));
      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(contextCode);
        signal?.removeEventListener("abort", abort);
        idleClose();
        error ? reject(error) : resolve(result);
      }
      pending.set(contextCode, finish);
      signal?.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => {
          if (settled || signal?.aborted) return;
          return client.request(
            "/repaire/point-analysis/start-interactive-governance",
            {
              method: "POST",
              // The original beforeRequestHook moves POST params into JSON data.
              body: {
                ...input,
                riskLevel: assessment.riskLevel,
                riskControlLevel: assessment.riskControlLevel,
                naturalRepairLevel: assessment.naturalRepairLevel,
                unitLevel: level,
                controlPlanType: route.type,
                bizType: route.bizType,
                contextCode,
                isAutoMode: true,
              },
            },
          );
        })
        .then((result) => {
          const data = result?.data ?? result;
          if (
            data?.contextCode === contextCode &&
            (Number(data.code) === 1 || Number(data.status) === 9)
          )
            finish(null, data);
        })
        .catch(finish);
    });
  }
  function close() {
    clearTimeout(idleTimer);
    rejectPending(new Error("分析服务已重启"));
    clearTimeout(idleTimer);
    if (socket) {
      const old = socket;
      socket = null;
      old.close();
    }
  }
  return { run, close };
}

function slimContext(context) {
  const factorsMap = Object.fromEntries(
    Object.entries(context.factorsMap || {}).map(([key, f]) => [
      key,
      {
        totalRate: f.totalRate,
        repairYears: f.repairYears,
        planMap: Object.fromEntries(
          Object.entries(f.planMap || {}).map(([id, p]) => [
            id,
            {
              statusCode: p.statusCode,
              isExecute: p.isExecute,
              planResult: p.planResult,
              costYuan: p.costYuan,
              planInfoModel: p.planInfoModel
                ? {
                    planName: p.planInfoModel.planName,
                    planType: p.planInfoModel.planType,
                  }
                : null,
            },
          ]),
        ),
      },
    ]),
  );
  return {
    solutionDesc: context.solutionDesc,
    proposalDesc: context.proposalDesc,
    msg: context.msg,
    status: context.status,
    planCostYuan: context.planCostYuan,
    dataYear: context.dataYear,
    expectedComplianceRate: context.expectedComplianceRate,
    factorsMap,
  };
}

export function userFacingError(error) {
  const message = String(error?.message || "后台服务暂时不可用，请重试");
  if (/workflow not found/i.test(message))
    return "该位置尚未配置这条治理路线，请查看其他方案";
  if (error?.name === "TimeoutError" || /timeout|timed out/i.test(message))
    return "后台服务响应超时，请稍后重试";
  if (/fetch failed|ECONN|network/i.test(message))
    return "暂时无法连接分析服务，请稍后重试";
  return message;
}

export function governancePlugin(env, client, base = "/") {
  const runner = createGovernanceRunner(client, env);
  return {
    name: "soil-decision-workflow",
    configureServer(server) {
      server.httpServer?.once("close", () => runner.close());
      server.middlewares.use(`${base}api/assistant`, async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        const abort = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) abort.abort();
        });
        try {
          if (url.pathname === "/locations" && req.method === "GET") {
            const keyword = (url.searchParams.get("keyword") || "").trim();
            if (!keyword || keyword.length > 100)
              return json(res, { message: "请输入地址或合作社名称" }, 400);
            const result = await client.request(
              "/repaire/point-analysis/search-address",
              { params: { keyword, limit: 8 } },
            );
            return json(res, { data: result.data ?? result });
          }
          if (req.method !== "POST")
            return json(res, { message: "不支持的请求" }, 405);
          const body = await readBody(req);
          if (url.pathname === "/risk") {
            const result = await client.request(
              "/repaire/point-analysis/analyze",
              { method: "POST", body: pointInput(body) },
            );
            return json(res, { data: result.data ?? result });
          }
          if (url.pathname === "/governance") {
            const route = ROUTES.find((r) => r.id === body.routeId);
            if (!route) return json(res, { message: "未识别的治理路线" }, 400);
            const analysisInput = pointInput(body.input);
            const result = await runner.run(
              analysisInput,
              route,
              body.assessment || {},
              abort.signal,
            );
            return json(res, { data: slimContext(result), analysisInput });
          }
          return json(res, { message: "未找到该功能" }, 404);
        } catch (error) {
          if (!res.destroyed)
            json(
              res,
              {
                message: userFacingError(error),
              },
              502,
            );
        }
      });
    },
  };
}
