import test from 'node:test';
import assert from 'node:assert/strict';
import { causeReport } from '../src/wrfx/causeAnalysis.js';

test('cause report keeps contribution, annual flux and prediction scopes separate', () => {
  const result = causeReport({
    causeSum: [{ factorCode: 'Cd', data: { total: 120, other: 19, agr: 8, variety: 65, ph: 8 } }],
    inputSum: [
      { factorsCode: 'Cd', categoryCode: '1', rmean: 2 },
      { factorsCode: 'Cd', categoryCode: '2', rmean: .5 },
      { factorsCode: 'Cd', categoryCode: '3', rmean: .1 },
    ],
    outputSum: [5, 7, 8].map(categoryCode => ({ factorsCode: 'Cd', categoryCode: String(categoryCode), rmean: .2 })),
    soilTrend: [{ factorsCode: 'Cd', year: 2027, eval: .42 }, { factorsCode: 'Cd', year: 2026, eval: .41 }],
  }, 'Cd');
  assert.equal(result.modelSamples, 120);
  assert.equal(result.contributions[0].label, '水稻品种');
  assert.equal(result.inputs[0].label, '大气沉降');
  assert.equal(result.inputTotal, 2.6);
  assert.ok(Math.abs(result.net - 2) < 1e-10);
  assert.deepEqual(result.soilTrend.map(item => item.year), [2026, 2027]);
});

test('incomplete flux data does not imply an input-output balance', () => {
  const result = causeReport({ inputSum: [{ factorsCode: 'As', categoryCode: '1', rmean: 1 }] }, 'As');
  assert.equal(result.inputTotal, null);
  assert.equal(result.net, null);
});
