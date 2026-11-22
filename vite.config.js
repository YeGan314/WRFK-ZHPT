import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";
import { governancePlugin } from "./server/governance.js";
import { fileURLToPath } from "node:url";

function moduleBaseRedirectPlugin(base) {
  const bareBase = base.replace(/\/+$/, "");
  const redirectBareBase = (req, res, next) => {
    const [pathname, query] = (req.url || "").split("?");
    if (pathname !== bareBase) return next();
    res.statusCode = 308;
    res.setHeader("Location", `${base}${query ? `?${query}` : ""}`);
    res.end();
  };
  return {
    name: `module-base-redirect-${bareBase.replace(/^\/+|\/+$/g, "") || "root"}`,
    configureServer(server) {
      server.middlewares.use(redirectBareBase);
    },
    configurePreviewServer(server) {
      server.middlewares.use(redirectBareBase);
    },
  };
}

function wrfxRoutePlugin(base) {
  const serveWrfx = (req, _res, next) => {
    const [pathname, query] = (req.url || "").split("?");
    if (
      (pathname === "/wrfx" || pathname.startsWith("/wrfx/")) &&
      !pathname.startsWith("/wrfx/api/") &&
      !pathname.startsWith("/wrfx/geoserver/")
    ) {
      req.url = `${base}wrfx.html${query ? `?${query}` : ""}`;
    }
    next();
  };
  return {
    name: "wrfx-route",
    configureServer(server) {
      server.middlewares.use(serveWrfx);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveWrfx);
    },
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function deepSeekProxyPlugin(env, base) {
  return {
    name: "deepseek-chat-proxy",
    configureServer(server) {
      server.middlewares.use(`${base}api/deepseek/chat`, async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ message: "Method Not Allowed" }));
          return;
        }

        try {
          const apiKey = (
            env.DEEPSEEK_API_KEY ||
            process.env.DEEPSEEK_API_KEY ||
            ""
          ).trim();
          const baseUrl =
            env.DEEPSEEK_BASE_URL ||
            process.env.DEEPSEEK_BASE_URL ||
            "https://api.deepseek.com";
          const model =
            env.DEEPSEEK_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-chat";

          if (!apiKey) {
            res.statusCode = 503;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                message:
                  "未配置 DEEPSEEK_API_KEY，请在 .env.local 中配置后重启服务。",
              }),
            );
            return;
          }

          if (
            apiKey.includes("填入") ||
            /[^\x20-\x7E]/.test(apiKey) ||
            /\s/.test(apiKey)
          ) {
            res.statusCode = 503;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                message:
                  "DEEPSEEK_API_KEY 格式不正确，请把 .env.local 中的示例文字替换为 DeepSeek 控制台生成的真实 API Key，且不要包含中文、空格或引号。",
              }),
            );
            return;
          }

          const payload = await readJsonBody(req);
          const messages = Array.isArray(payload.messages)
            ? payload.messages
            : [];
          const requestBody = {
            model,
            messages,
            stream: false,
            temperature: 0.3,
          };

          const upstream = await fetch(
            `${baseUrl.replace(/\/$/, "")}/chat/completions`,
            {
              method: "POST",
              signal: AbortSignal.timeout(60000),
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify(requestBody),
            },
          );

          const data = await upstream.json().catch(() => ({}));
          if (!upstream.ok) {
            res.statusCode = upstream.status;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                message: data?.error?.message || "DeepSeek 接口调用失败。",
              }),
            );
            return;
          }

          const content = data?.choices?.[0]?.message?.content || "";
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ content, raw: data }));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              message: error.message || "DeepSeek 代理服务异常。",
            }),
          );
        }
      });
    },
  };
}

function createRemoteApiClient(env) {
  const apiBaseUrl = (
    env.CPHMP_API_BASE_URL ||
    process.env.CPHMP_API_BASE_URL ||
    "http://113.240.240.3:8099/dev-api"
  ).replace(/\/$/, "");
  const username = env.CPHMP_USERNAME || process.env.CPHMP_USERNAME || "admin";
  const password = env.CPHMP_PASSWORD || process.env.CPHMP_PASSWORD || "";
  const tenantId = env.CPHMP_TENANT_ID || process.env.CPHMP_TENANT_ID || "1";
  const tokenCache = {
    accessToken: "",
    expiresAt: 0,
  };

  async function login() {
    if (!username || !password) {
      throw new Error(
        "未配置平台接口账号密码，请在 .env.local 中配置 CPHMP_USERNAME 和 CPHMP_PASSWORD 后重启服务。",
      );
    }

    const response = await fetch(`${apiBaseUrl}/system/auth/login`, {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json().catch(() => ({}));

    if (
      !response.ok ||
      (data.code !== undefined && data.code !== 0 && data.code !== 200)
    ) {
      throw new Error(
        data.msg || data.message || `平台登录失败：${response.status}`,
      );
    }

    const accessToken =
      data?.data?.accessToken ||
      data?.data?.access_token ||
      data?.accessToken ||
      data?.token;

    if (!accessToken) {
      throw new Error("平台登录成功但未返回 accessToken。");
    }

    tokenCache.accessToken = accessToken;
    tokenCache.expiresAt =
      Number(data?.data?.expiresTime) || Date.now() + 50 * 60 * 1000;
    return accessToken;
  }

  async function getAccessToken() {
    if (
      tokenCache.accessToken &&
      tokenCache.expiresAt - Date.now() > 60 * 1000
    ) {
      return tokenCache.accessToken;
    }
    return login();
  }

  async function request(path, options = {}) {
    const token = await getAccessToken();
    const url = new URL(`${apiBaseUrl}${path}`);
    Object.entries(options.params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    });

    const response = await fetch(url, {
      method: options.method || "GET",
      signal: AbortSignal.timeout(30000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "tenant-id": tenantId,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await response.json().catch(() => ({}));

    if (response.status === 401 && options.retry !== false) {
      tokenCache.accessToken = "";
      return request(path, { ...options, retry: false });
    }

    if (
      !response.ok ||
      (data.code !== undefined && data.code !== 0 && data.code !== 200)
    ) {
      throw new Error(
        data.msg || data.message || `${path} 调用失败：${response.status}`,
      );
    }

    return data;
  }

  return { request, getAccessToken };
}

function pointAnalysisProxyPlugin(env, base) {
  const client = createRemoteApiClient(env);

  return {
    name: "point-analysis-proxy",
    configureServer(server) {
      server.middlewares.use("/wrfx/api/pollution/summary", async (req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end(JSON.stringify({ message: "Method Not Allowed" }));
          return;
        }
        try {
          const url = new URL(req.url || "", "http://localhost");
          const zoneCode = url.searchParams.get("zoneCode") || "";
          const dataYear = url.searchParams.get("dataYear") || "";
          if (!/^ZONE\d{10}$/.test(zoneCode) || !/^\d{4}$/.test(dataYear)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ message: "示范区编码或年份无效。" }));
            return;
          }
          const tasks = [
            ["causeSum", "/cphmp/zone/getCauseSum", { zoneCode, dataYear }],
            ["inputSum", "/cphmp/sample-sum/list", { zoneCode, dataYear, sumClass: "1", sumType: 0 }],
            ["outputSum", "/cphmp/sample-sum/list", { zoneCode, dataYear, sumClass: "2", sumType: 0 }],
            ["soilTrend", "/cphmp/sample-sum/trendForecast", { zoneCode, dataYear, number: 10, sumType: 0 }],
            ["riceTrend", "/cphmp/sample-sum/trendForecast", { zoneCode, dataYear, number: 10, sumType: 0, subType: "Rice" }],
            ...[
              ["soilCd", "10", "Cd"], ["soilAs", "10", "As"],
              ["riceCd", "9", "Cd"], ["riceAs", "9", "As"],
              ["soilPh", "11", "pH"], ["soilSom", "11", "SOM"],
            ].map(([key, categoryCode, factorsCode]) => [key, "/cphmp/sample-sum/factorsRange", { zoneCode, dataYear, categoryCode, factorsCode }]),
          ];
          const settled = await Promise.allSettled(tasks.map(([, path, params]) => client.request(path, { params })));
          const results = Object.fromEntries(tasks.map(([key], index) => [key, settled[index].status === "fulfilled" ? settled[index].value.data : null]));
          res.end(JSON.stringify({ data: results }));
        } catch (error) {
          res.statusCode = 502;
          res.end(JSON.stringify({ message: error.message || "污染现状汇总接口读取失败。" }));
        }
      });
      server.middlewares.use("/wrfx/api/risk/summary", async (req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        if (req.method !== "GET") { res.statusCode = 405; res.end(JSON.stringify({ message: "Method Not Allowed" })); return; }
        try {
          const url = new URL(req.url || "", "http://localhost");
          const zoneCode = url.searchParams.get("zoneCode") || "";
          const dataYear = url.searchParams.get("dataYear") || "";
          if (!/^ZONE\d{10}$/.test(zoneCode) || !/^\d{4}$/.test(dataYear)) { res.statusCode = 400; res.end(JSON.stringify({ message: "示范区编码或年份无效。" })); return; }
          const tasks = ["riceCd", "riceAs", "soilCd", "soilAs", "governance"].flatMap(key => {
            const categoryCode = key === "governance" ? "27" : key.startsWith("rice") ? "9" : "10";
            const factorsCode = key === "governance" ? "Cd&As" : key.endsWith("Cd") ? "Cd" : "As";
            const params = { zoneCode, dataYear, categoryCode, factorsCode, evalutionType: 3, sumType: 0 };
            return [[`${key}Summary`, "/cphmp/risk-point/getFeildRiskSum", params], [`${key}Map`, "/cphmp/risk-point/getRiskMap", { zoneCode, dataYear, categoryCode, factorsCode, evalutionType: 3 }]];
          });
          tasks.push(["planUnitList", "/risk/planflow/getUnitList", { zoneCode, dataYear }]);
          const settled = await Promise.allSettled(tasks.map(([, path, params]) => client.request(path, { params })));
          const results = Object.fromEntries(tasks.map(([key], index) => [key, settled[index].status === "fulfilled" ? settled[index].value.data : null]));
          try {
            const zones = await client.request("/cphmp/zone/list", { params: { zoneCode } });
            const zone = Array.isArray(zones.data) ? zones.data.find(item => item.zoneCode === zoneCode) || null : null;
            results.zone = zone ? { zoneCode: zone.zoneCode, zoneName: zone.zoneName, zoneArea: zone.zoneArea } : null;
            const geometryPath = zone?.zoneTargetGeojson;
            if (typeof geometryPath === "string" && /^\/rsfile\/admin-api\/infra\/file\//.test(geometryPath)) {
              const apiBaseUrl = (env.CPHMP_API_BASE_URL || process.env.CPHMP_API_BASE_URL || "http://113.240.240.3:8099/dev-api");
              const geometryResponse = await fetch(new URL(geometryPath, apiBaseUrl), { signal: AbortSignal.timeout(15000) });
              const geometry = geometryResponse.ok ? await geometryResponse.json() : null;
              results.riskGeometry = geometry?.type === "FeatureCollection" && Array.isArray(geometry.features) ? geometry : null;
            }
          } catch { results.zone = null; results.riskGeometry = null; }
          res.end(JSON.stringify({ data: results }));
        } catch (error) { res.statusCode = 502; res.end(JSON.stringify({ message: error.message || "风险评估接口读取失败。" })); }
      });
      server.middlewares.use("/wrfx/api/data-check/points", async (req, res) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        if (req.method !== "GET") {
          res.statusCode = 405;
          res.end(JSON.stringify({ message: "Method Not Allowed" }));
          return;
        }
        try {
          const url = new URL(req.url || "", "http://localhost");
          const zoneCode = url.searchParams.get("zoneCode") || "";
          const surveyYear = url.searchParams.get("surveyYear") || "";
          if (!/^ZONE\d{10}$/.test(zoneCode) || !/^\d{4}$/.test(surveyYear)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ message: "示范区编码或调查年度无效。" }));
            return;
          }
          const result = await client.request("/risk/risk-front-table/list", {
            params: { zoneCode, surveyYear, categoryCode: "16", factorsCode: "Cd" },
          });
          res.end(JSON.stringify({ data: Array.isArray(result.data) ? result.data : [] }));
        } catch (error) {
          res.statusCode = 502;
          res.end(JSON.stringify({ message: error.message || "原系统点位数据获取失败。" }));
        }
      });
      server.middlewares.use(
        `${base}api/point-analysis/point-data`,
        async (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end(JSON.stringify({ message: "Method Not Allowed" }));
            return;
          }

          try {
            const payload = await readJsonBody(req);
            const lon = Number(payload.longitude);
            const lat = Number(payload.latitude);
            const countyCode = payload.countyCode || "";
            const growerId = payload.growerId || "";

            if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ message: "经纬度参数无效。" }));
              return;
            }

            const sharedParams = { lon, lat };
            const soilParams = countyCode
              ? { ...sharedParams, countyCode }
              : sharedParams;
            const [reverseGeocode, predictedSoil, fluxData] =
              await Promise.allSettled([
                client.request("/repaire/point-analysis/reverse-geocode", {
                  method: "POST",
                  body: sharedParams,
                }),
                client.request("/repaire/point-analysis/get-predicted-soil", {
                  method: "POST",
                  body: soilParams,
                }),
                client.request("/repaire/point-analysis/get-flux-data", {
                  method: "POST",
                  body: sharedParams,
                }),
              ]);
            const growerDetail = growerId
              ? await client
                  .request("/repaire/grower-point/detail", {
                    params: { id: growerId },
                  })
                  .then((result) => ({
                    status: "fulfilled",
                    value: result,
                  }))
                  .catch((reason) => ({ status: "rejected", reason }))
              : { status: "rejected", reason: new Error("不是大户档案点位") };

            const normalize = (result) =>
              result.status === "fulfilled"
                ? { ok: true, data: result.value?.data ?? result.value }
                : {
                    ok: false,
                    message: result.reason?.message || "接口调用失败",
                  };
            const normalizedPredicted = normalize(predictedSoil);
            const normalizedGrower = normalize(growerDetail);
            const growerData = normalizedGrower.ok
              ? normalizedGrower.data
              : null;
            const preferredSoil = growerData
              ? {
                  ...growerData,
                  sourceMeta: Object.fromEntries(
                    [
                      "soilCd",
                      "soilAs",
                      "ph",
                      "som",
                      "cec",
                      "availableCd",
                      "availableAs",
                      "riceCd",
                      "riceAs",
                    ].map((key) => [key, "GROWER"]),
                  ),
                }
              : normalizedPredicted.data;

            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                coordinate: { longitude: lon, latitude: lat, countyCode },
                reverseGeocode: normalize(reverseGeocode),
                predictedSoil: preferredSoil
                  ? { ok: true, data: preferredSoil }
                  : normalizedPredicted,
                fluxData: normalize(fluxData),
              }),
            );
          } catch (error) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                message: error.message || "点位数据代理服务异常。",
              }),
            );
          }
        },
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const configuredBase = env.VITE_BASE_PATH || "/jsyy/";
  const baseSegment = configuredBase.replace(/^\/+|\/+$/g, "");
  const base = baseSegment ? `/${baseSegment}/` : "/";

  return {
    base,
    plugins: [
      moduleBaseRedirectPlugin(base),
      moduleBaseRedirectPlugin("/wrfx/"),
      wrfxRoutePlugin(base),
      vue(),
      deepSeekProxyPlugin(env, base),
      pointAnalysisProxyPlugin(env, base),
      governancePlugin(env, createRemoteApiClient(env), base),
    ],
    server: {
      port: 5177,
      proxy: {
        "/wrfx/geoserver": {
          target: env.VITE_GEOSERVER_PROXY_TARGET || "http://localhost:18080",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/wrfx\/geoserver/, "/geoserver"),
        },
        [`${base}dev-api`]: {
          target: "http://113.240.240.3:8099",
          changeOrigin: true,
          rewrite: (path) => path.replace(base.slice(0, -1), ""),
        },
        [`${base}rsfile`]: {
          target: "http://113.240.240.3:8099",
          changeOrigin: true,
          rewrite: (path) => path.replace(base.slice(0, -1), ""),
        },
      },
    },
    build: {
      rollupOptions: {
        input: {
          jsyy: fileURLToPath(new URL("./index.html", import.meta.url)),
          wrfx: fileURLToPath(new URL("./wrfx.html", import.meta.url)),
        },
      },
    },
  };
});
