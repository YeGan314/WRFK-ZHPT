import test from "node:test";
import assert from "node:assert/strict";
import { createGovernanceRunner, pointInput, ROUTES } from "../server/governance.js";

test("model precision matches original platform without changing raw data, coordinates or flux", () => {
  const raw = { lon: 112.611344, lat: 28.502317, soilCd: 0.584,
    riceCd: 0.254, availableAs: 0.504, fluxData: { flux_1_Cd: 5.5395 } };
  const input = pointInput(raw);
  assert.equal(input.soilCd, 0.58);
  assert.equal(input.riceCd, 0.25);
  assert.equal(input.availableAs, 0.5);
  assert.equal(input.lon, raw.lon);
  assert.equal(input.lat, raw.lat);
  assert.deepEqual(input.fluxData, raw.fluxData);
  assert.equal(raw.riceCd, 0.254);
});

function setup() {
  const sockets = [],
    requests = [];
  class Socket extends EventTarget {
    readyState = 0;
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
    result(context) {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ content: JSON.stringify({ context }) }),
        }),
      );
    }
  }
  const runner = createGovernanceRunner(
    {
      getAccessToken: async () => "test",
      request: async (path, { body, params }) => {
        assert.equal(params, undefined, "governance POST must use JSON body, not query parameters");
        assert.ok(body?.contextCode);
        requests.push(body);
        return { data: {} };
      },
    },
    {},
    Socket,
  );
  return { runner, sockets, requests };
}
const assessment = { riskControlLevel: 1, naturalRepairLevel: 1 };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("four concurrent routes share one connection and match out-of-order results", async () => {
  const { runner, sockets, requests } = setup();
  try {
    const jobs = ROUTES.map((route) =>
      runner.run({ lon: 112, lat: 28 }, route, assessment),
    );
    await flush();
    assert.equal(sockets.length, 1);
    assert.equal(requests.length, 4);
    for (const req of [...requests].reverse())
      sockets[0].result({
        contextCode: req.contextCode,
        code: 1,
        msg: "完成",
        value: req.controlPlanType,
      });
    const results = await Promise.all(jobs);
    assert.deepEqual(
      results.map((r) => r.value),
      ROUTES.map((r) => r.type),
    );
  } finally {
    runner.close();
  }
});

test("canceling one route does not cancel other pending routes", async () => {
  const { runner, sockets, requests } = setup();
  try {
    const abort = new AbortController();
    const canceled = runner.run({}, ROUTES[0], assessment, abort.signal);
    const check = assert.rejects(canceled, /取消/);
    const other = runner.run({}, ROUTES[1], assessment);
    await flush();
    abort.abort();
    await check;
    sockets[0].result({
      contextCode: requests[0].contextCode,
      code: 1,
      msg: "过期结果",
    });
    sockets[0].result({
      contextCode: requests[1].contextCode,
      code: 1,
      msg: "有效结果",
    });
    assert.equal((await other).msg, "有效结果");
  } finally {
    runner.close();
  }
});
