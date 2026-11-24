import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadedRowsToPoints } from '../src/wrfx/pointComparison.js';

test('custom drawn scope converts located Excel rows without county restrictions', () => {
  const rows = new Map([
    [1, { 经度: 112.7, 纬度: 26.9, 行政区编码: '431000', 土壤总镉: 0.4, 农产品总镉: 0.2 }],
    [2, { 经度: '', 纬度: 26.9, 土壤总镉: 0.5 }],
  ]);
  assert.deepEqual(uploadedRowsToPoints(rows), [{
    samplingPointsCode: 'UPLOAD00001', lon: 112.7, lat: 26.9,
    soilStcd: 0.4, ntCd: 0.2, soilStas: null, naAs: null, soilSph: null, soilSom: null,
  }]);
});
