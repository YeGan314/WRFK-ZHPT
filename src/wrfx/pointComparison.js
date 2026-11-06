import * as XLSX from "xlsx";

const metrics = [
  { key: "soilStcd", header: "土壤总镉" },
  { key: "ntCd", header: "农产品总镉" },
  { key: "soilStas", header: "土壤总砷" },
];

function numeric(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export async function readSupplementPoints(file) {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("Excel 文件中没有可读取的工作表。");
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true });
  if (!rows.length || !["序号", ...metrics.map(item => item.header)].every(key => key in rows[0])) {
    throw new Error("Excel 需要包含“序号、土壤总镉、农产品总镉、土壤总砷”列。");
  }
  const points = new Map();
  for (const row of rows) {
    const serial = numeric(row["序号"]);
    if (!Number.isInteger(serial) || serial <= 0) continue;
    if (points.has(serial)) throw new Error(`Excel 序号 ${serial} 重复，请先核对文件。`);
    points.set(serial, row);
  }
  if (!points.size) throw new Error("Excel 中没有有效的点位序号。");
  const countyCodes = new Set(rows.map(row => String(row["行政区编码"] || "").trim()).filter(Boolean));
  return { points, countyCodes };
}

export function comparePoints(apiPoints, uploadPoints) {
  const records = [];
  for (const point of apiPoints) {
    const match = String(point.samplingPointsCode || "").match(/(\d{5})$/);
    if (!match) continue;
    const serial = Number(match[1]);
    const uploaded = uploadPoints.get(serial);
    if (!uploaded) continue;
    const apiLon = numeric(point.lon);
    const apiLat = numeric(point.lat);
    const uploadLon = numeric(uploaded["经度"]);
    const uploadLat = numeric(uploaded["纬度"]);
    if (apiLon !== null && apiLat !== null && uploadLon !== null && uploadLat !== null &&
      (Math.abs(apiLon - uploadLon) > 0.00001 || Math.abs(apiLat - uploadLat) > 0.00001)) continue;
    const values = metrics.map(({ key, header }) => {
      const original = numeric(point[key]);
      const supplement = numeric(uploaded[header]);
      const difference = original === null || supplement === null ? null
        : original === 0 ? (supplement === 0 ? 0 : Infinity)
          : Math.abs(supplement - original) / Math.abs(original) * 100;
      return { original, supplement, difference };
    });
    records.push({ serial, code: point.samplingPointsCode, values,
      incomplete: values.some(value => value.original === null || value.supplement === null),
      maxDifference: Math.max(...values.map(value => value.difference ?? -1)) });
  }
  records.sort((a, b) => b.maxDifference - a.maxDifference || a.serial - b.serial);
  const significant = records.filter(row => row.maxDifference > 20);
  const changed = records.filter(row => row.maxDifference > 0);
  const incomplete = records.filter(row => row.incomplete);
  return { matched: records.length, totalApi: apiPoints.length, totalUpload: uploadPoints.size,
    significant: significant.length, changed: changed.length, incomplete: incomplete.length,
    rows: significant.length ? significant : changed.length ? changed.slice(0, 3)
      : incomplete.length ? incomplete.slice(0, 3) : [...records].sort((a, b) => a.serial - b.serial).slice(0, 3) };
}
