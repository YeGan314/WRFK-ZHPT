import test from 'node:test';
import assert from 'node:assert/strict';
import { riskGeoFeatures, riskProfile } from '../src/wrfx/riskAnalysis.js';

test('risk profile keeps model area and plot counts as separate measures', () => {
  const profile = riskProfile(
    [{ riskLevel: 0, riskArea: 92 }, { riskLevel: 3, riskArea: 110 }, { riskLevel: 4, riskArea: 501 }],
    { DK1: { riskLevel: 0 }, DK2: { riskLevel: 3 }, DK3: { riskLevel: 4 } },
  );
  assert.equal(profile.areaMu, 703);
  assert.equal(profile.priorityMu, 611);
  assert.equal(profile.plotCount, 3);
  assert.equal(profile.levels[4].areaMu, 501);
});

test('risk geometries join by original dkcode and skip unknown plots', () => {
  const geometry = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { dkcode: 'DK1' }, geometry: { type: 'Polygon', coordinates: [] } },
    { type: 'Feature', properties: { dkcode: 'DK2' }, geometry: { type: 'Polygon', coordinates: [] } },
  ] };
  const joined = riskGeoFeatures(geometry, { DK1: { riskLevel: 3 } });
  assert.equal(joined.length, 1);
  assert.equal(joined[0].properties.riskLevel, 3);
  assert.equal(geometry.features[0].properties.riskLevel, undefined);
});
