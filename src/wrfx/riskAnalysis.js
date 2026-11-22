export const riskLevels = [
  { level: 0, label: '无风险', color: '#30d861' },
  { level: 1, label: '低风险', color: '#e1db43' },
  { level: 2, label: '中风险', color: '#f3a43c' },
  { level: 3, label: '高风险', color: '#ef6254' },
  { level: 4, label: '极高风险', color: '#bd52c8' },
];

export function riskProfile(summary = [], riskMap = {}) {
  const entries = Array.isArray(summary) ? summary : [];
  const levels = riskLevels.map(item => ({
    ...item,
    areaMu: entries.filter(entry => Number(entry.riskLevel) === item.level)
      .reduce((sum, entry) => sum + (Number(entry.riskArea) || 0), 0),
    plots: Object.values(riskMap || {}).filter(entry => Number(entry?.riskLevel) === item.level).length,
  }));
  const areaMu = levels.reduce((sum, item) => sum + item.areaMu, 0);
  const plotCount = levels.reduce((sum, item) => sum + item.plots, 0);
  const priorityMu = levels.filter(item => item.level >= 2).reduce((sum, item) => sum + item.areaMu, 0);
  return { levels, areaMu, plotCount, priorityMu, priorityPercent: areaMu ? priorityMu / areaMu * 100 : 0 };
}

export function riskGeoFeatures(geometry, riskMap) {
  if (geometry?.type !== 'FeatureCollection' || !Array.isArray(geometry.features) || !riskMap) return [];
  return geometry.features.filter(feature => feature.geometry && riskMap[feature.properties?.dkcode])
    .map(feature => ({ ...feature, properties: { ...feature.properties, riskLevel: Number(riskMap[feature.properties.dkcode].riskLevel) } }));
}
