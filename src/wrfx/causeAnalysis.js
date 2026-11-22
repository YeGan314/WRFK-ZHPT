const contributionLabels = { other: '土壤污染', agr: '农艺措施', variety: '水稻品种', ph: '土壤 pH' };
const inputLabels = { '1': '大气沉降', '2': '灌溉水', '3': '农业投入品' };

const validNumber = value => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;

export function causeReport(summary, factor) {
  const cause = Array.isArray(summary?.causeSum) ? summary.causeSum.find(item => item.factorCode === factor)?.data : null;
  const contributions = cause ? Object.entries(contributionLabels).map(([key, label]) => ({ label, value: validNumber(cause[key]) })).filter(item => item.value !== null).sort((a, b) => b.value - a.value) : [];
  const inputs = (summary?.inputSum || []).filter(item => item.factorsCode === factor && inputLabels[item.categoryCode]).map(item => ({ label: inputLabels[item.categoryCode], value: validNumber(item.rmean), sampleCount: validNumber(item.total) })).filter(item => item.value !== null);
  const outputs = (summary?.outputSum || []).filter(item => item.factorsCode === factor && validNumber(item.rmean) !== null);
  const soilTrend = (summary?.soilTrend || []).filter(item => item.factorsCode === factor && validNumber(item.eval) !== null).sort((a, b) => Number(a.year) - Number(b.year));
  const inputTotal = inputs.length === 3 ? inputs.reduce((sum, item) => sum + item.value, 0) : null;
  const outputTotal = outputs.length === 3 ? outputs.reduce((sum, item) => sum + Number(item.rmean), 0) : null;
  return {
    contributions,
    modelSamples: validNumber(cause?.total),
    inputs,
    inputTotal,
    outputTotal,
    net: inputTotal !== null && outputTotal !== null ? inputTotal - outputTotal : null,
    soilTrend,
  };
}
