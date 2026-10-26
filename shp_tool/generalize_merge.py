#!/usr/bin/env python3
"""简化仅含几何的面状 SHP，并追加到一个 GeoPackage 中。"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import geopandas as gpd
import numpy as np
import pandas as pd
import pyogrio
import shapely
from pyproj import CRS
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon
from shapely.strtree import STRtree


def vertex_count(geom: Any) -> int:
    if geom is None or geom.is_empty:
        return 0
    typ = geom.geom_type
    if typ == "Polygon":
        return len(geom.exterior.coords) + sum(len(r.coords) for r in geom.interiors)
    if typ == "MultiPolygon":
        return sum(vertex_count(g) for g in geom.geoms)
    if typ == "GeometryCollection":
        return sum(vertex_count(g) for g in geom.geoms)
    return 0


def polygonal(geom: Any) -> Any:
    if geom is None or geom.is_empty:
        return geom
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom
    if geom.geom_type == "GeometryCollection":
        pieces = [polygonal(g) for g in geom.geoms]
        pieces = [g for g in pieces if g is not None and not g.is_empty and g.geom_type in ("Polygon", "MultiPolygon")]
        return shapely.union_all(pieces) if pieces else GeometryCollection()
    return GeometryCollection()


def choose_local_metric_crs(gdfs: list[gpd.GeoDataFrame]) -> CRS:
    source = CRS.from_user_input(gdfs[0].crs)
    if source.is_projected and all(CRS.from_user_input(g.crs) == source for g in gdfs):
        return source
    bounds = [g.to_crs(4326).total_bounds for g in gdfs]
    minx = min(b[0] for b in bounds)
    miny = min(b[1] for b in bounds)
    maxx = max(b[2] for b in bounds)
    maxy = max(b[3] for b in bounds)
    lon, lat = (minx + maxx) / 2, (miny + maxy) / 2
    zone = int(math.floor((lon + 180) / 6) + 1)
    epsg = (32600 if lat >= 0 else 32700) + zone
    return CRS.from_epsg(epsg)


def choose_metric_crs_from_paths(paths: list[Path]) -> tuple[CRS, list[dict[str, Any]]]:
    """仅读取各文件图层元数据来确定范围与处理坐标系。"""
    infos = [pyogrio.read_info(path) for path in paths]
    if any(not info.get("crs") for info in infos):
        missing = [str(path) for path, info in zip(paths, infos) if not info.get("crs")]
        raise ValueError(f"以下输入文件缺少坐标系信息：{missing[:5]}")
    crs_list = [CRS.from_user_input(info["crs"]) for info in infos]
    if all(crs == crs_list[0] for crs in crs_list) and crs_list[0].is_projected:
        return crs_list[0], infos
    geographic_bounds = []
    from pyproj import Transformer
    for info, crs in zip(infos, crs_list):
        bounds = info.get("total_bounds")
        if bounds is None:
            continue
        if crs.is_geographic:
            geographic_bounds.append(bounds)
        else:
            transformer = Transformer.from_crs(crs, 4326, always_xy=True)
            geographic_bounds.append(transformer.transform_bounds(*bounds, densify_pts=21))
    minx = min(b[0] for b in geographic_bounds)
    miny = min(b[1] for b in geographic_bounds)
    maxx = max(b[2] for b in geographic_bounds)
    maxy = max(b[3] for b in geographic_bounds)
    lon, lat = (minx + maxx) / 2, (miny + maxy) / 2
    zone = int(math.floor((lon + 180) / 6) + 1)
    epsg = (32600 if lat >= 0 else 32700) + zone
    return CRS.from_epsg(epsg), infos


def simplify_to_budget(geom: Any, max_area_change: float, target_ratio: float) -> tuple[Any, dict[str, Any]]:
    original_vertices = vertex_count(geom)
    original_area = geom.area
    if original_vertices <= 5 or original_area <= 0:
        return geom, {"tolerance": 0.0, "ratio": 1.0, "area_change": 0.0, "target_met": original_vertices <= 5}

    def candidate(tolerance: float) -> Any:
        return geom.simplify(tolerance, preserve_topology=True)

    # 先确定容差上界，再用二分法寻找未超过面积变化约束的最大容差。
    low, high = 0.0, max(math.sqrt(original_area) / 2, 1e-6)
    while high < 1e7:
        c = candidate(high)
        if vertex_count(c) <= max(original_vertices * target_ratio, 5) or abs(c.area - original_area) / original_area > max_area_change:
            break
        high *= 2
    best = geom
    best_tolerance = 0.0
    for _ in range(32):
        mid = (low + high) / 2
        c = candidate(mid)
        change = abs(c.area - original_area) / original_area if original_area else 0.0
        # 仅接受几何类型有效且没有超过单面面积变化限制的结果。
        acceptable = c.geom_type in ("Polygon", "MultiPolygon") and not c.is_empty and change <= max_area_change
        if acceptable:
            best, best_tolerance = c, mid
            low = mid
        else:
            high = mid
    new_vertices = vertex_count(best)
    area_change = abs(best.area - original_area) / original_area if original_area else 0.0
    return best, {
        "tolerance": best_tolerance,
        "ratio": new_vertices / original_vertices if original_vertices else 1.0,
        "area_change": area_change,
        "target_met": new_vertices <= original_vertices * target_ratio,
    }


def simplify_many(geometries: list[Any], max_area_change: float, target_ratio: float) -> tuple[list[Any], list[dict[str, Any]]]:
    """对大数据集批量搜索每个要素的简化容差。"""
    source = np.asarray(geometries, dtype=object)
    areas = np.asarray(shapely.area(source), dtype=float)
    original_vertices = np.asarray(shapely.get_num_coordinates(source), dtype=np.int64)
    low = np.zeros(len(source), dtype=float)
    high = np.maximum(np.sqrt(np.maximum(areas, 0.0)) / 2, 1e-6)
    best = source.copy()
    for _ in range(16):
        tolerance = (low + high) / 2
        candidate = shapely.simplify(source, tolerance, preserve_topology=True)
        candidate_area = np.asarray(shapely.area(candidate), dtype=float)
        relative = np.divide(np.abs(candidate_area - areas), areas, out=np.zeros_like(areas), where=areas > 0)
        type_ids = np.asarray(shapely.get_type_id(candidate))
        acceptable = (relative <= max_area_change) & np.isin(type_ids, [3, 6]) & np.asarray(shapely.is_valid(candidate))
        best = np.where(acceptable, candidate, best)
        low = np.where(acceptable, tolerance, low)
        high = np.where(acceptable, high, tolerance)
    result = list(best)
    stats = []
    for old_area, old_count, geom, tolerance in zip(areas, original_vertices, result, low):
        new_area = geom.area if geom is not None else 0.0
        new_count = vertex_count(geom)
        change = abs(new_area - old_area) / old_area if old_area else 0.0
        stats.append({"tolerance": float(tolerance), "ratio": float(new_count / old_count) if old_count else 1.0,
                      "area_change": float(change), "target_met": bool(new_count <= old_count * target_ratio)})
    return result, stats


def check_overlaps(geometries: list[Any], tolerance: float) -> dict[str, Any]:
    nonempty = [(i, g) for i, g in enumerate(geometries) if g is not None and not g.is_empty]
    if len(nonempty) < 2:
        return {"pairs_checked": 0, "overlap_pair_count": 0, "overlap_area_m2": 0.0, "examples": []}
    geoms = [g for _, g in nonempty]
    source_indices = [i for i, _ in nonempty]
    tree = STRtree(geoms)
    pairs = tree.query(geoms, predicate="intersects")
    seen: set[tuple[int, int]] = set()
    examples = []
    total_area = 0.0
    pair_count = 0
    for a, b in zip(pairs[0].tolist(), pairs[1].tolist()):
        if a >= b:
            continue
        key = (a, b)
        if key in seen:
            continue
        seen.add(key)
        # 共边的交集面积为零，因此允许相邻面共享边界。
        area = geoms[a].intersection(geoms[b]).area
        if area > tolerance:
            pair_count += 1
            total_area += area
            if len(examples) < 20:
                examples.append({"feature_a": source_indices[a], "feature_b": source_indices[b], "intersection_area_m2": area})
    return {"pairs_checked": len(seen), "overlap_pair_count": pair_count, "overlap_area_m2": total_area, "examples": examples}


def simplify_coverage(geometries: list[Any], max_area_change: float, target_ratio: float) -> tuple[list[Any], list[dict[str, Any]]]:
    """一次性简化有效的面覆盖数据，使共享边界保持一致。"""
    before_vertices = sum(vertex_count(g) for g in geometries)
    before_area = sum(g.area for g in geometries)
    if before_vertices == 0:
        return geometries, []
    low, high = 0.0, max(math.sqrt(before_area) / 2, 1e-6)

    def candidate(tolerance: float) -> list[Any]:
        return list(shapely.coverage_simplify(geometries, tolerance=tolerance, simplify_boundary=True))

    while high < 1e7:
        c = candidate(high)
        ratio = sum(vertex_count(g) for g in c) / before_vertices
        changes = [abs(new.area - old.area) / old.area if old.area else 0.0 for old, new in zip(geometries, c)]
        if ratio <= target_ratio or any(change > max_area_change for change in changes):
            break
        high *= 2
    best = geometries
    for _ in range(32):
        mid = (low + high) / 2
        c = candidate(mid)
        changes = [abs(new.area - old.area) / old.area if old.area else 0.0 for old, new in zip(geometries, c)]
        if all(change <= max_area_change for change in changes):
            best, low = c, mid
        else:
            high = mid
    stats = []
    for old, new in zip(geometries, best):
        old_area = old.area
        area_change = abs(new.area - old_area) / old_area if old_area else 0.0
        old_vertices, new_vertices = vertex_count(old), vertex_count(new)
        stats.append({"tolerance": low, "ratio": new_vertices / old_vertices if old_vertices else 1.0,
                      "area_change": area_change, "target_met": new_vertices <= old_vertices * target_ratio})
    return best, stats


def overlap_pairs(geometries: list[Any], tolerance: float) -> set[tuple[int, int]]:
    nonempty = [(i, g) for i, g in enumerate(geometries) if g is not None and not g.is_empty]
    if len(nonempty) < 2:
        return set()
    geoms = [g for _, g in nonempty]
    indices = [i for i, _ in nonempty]
    pairs = STRtree(geoms).query(geoms, predicate="intersects")
    result = set()
    for a, b in zip(pairs[0].tolist(), pairs[1].tolist()):
        if a < b and geoms[a].intersection(geoms[b]).area > tolerance:
            result.add((indices[a], indices[b]))
    return result


def prevent_new_overlaps(original: list[Any], simplified: list[Any], tolerance: float) -> tuple[list[Any], int, int]:
    source_pairs = overlap_pairs(original, tolerance)
    current = list(simplified)
    reverted: set[int] = set()
    for _ in range(len(current) + 1):
        new_pairs = overlap_pairs(current, tolerance) - source_pairs
        if not new_pairs:
            break
        for a, b in new_pairs:
            current[a], current[b] = original[a], original[b]
            reverted.update((a, b))
    return current, len(reverted), len(source_pairs)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument("--input-dir", type=Path, help="输入 SHP 文件所在目录")
    group.add_argument("--inputs", nargs="+", type=Path, help="显式指定输入 SHP 文件")
    p.add_argument("--output", required=True, type=Path, help="输出 GeoPackage 文件路径")
    p.add_argument("--layer", default="merged", help="GeoPackage 图层名称，默认 merged")
    p.add_argument("--target-ratio", type=float, default=0.15, help="目标顶点比例，例如 0.15")
    p.add_argument("--max-area-change", type=float, default=0.01, help="单个要素允许的最大面积相对变化")
    p.add_argument("--overlap-tolerance", type=float, default=0.01, help="重叠检查面积阈值，单位平方米")
    p.add_argument("--target-crs", help="可选输出坐标系，例如 EPSG:32649；默认使用第一个输入坐标系")
    p.add_argument("--coverage", action="store_true", help="使用面覆盖共享边界简化")
    p.add_argument("--repair-invalid", action="store_true", help="使用 make_valid 修复输入中的无效几何")
    p.add_argument("--stream-by-file", action="store_true", help="逐个输入文件处理，适用于大量县级图层，可降低内存占用")
    return p.parse_args()


def as_multi_polygon(geom: Any) -> Any:
    geom = polygonal(geom)
    if geom is None or geom.is_empty:
        return MultiPolygon()
    if geom.geom_type == "Polygon":
        return MultiPolygon([geom])
    if geom.geom_type == "MultiPolygon":
        return geom
    return MultiPolygon()


def process_stream_by_file(args: argparse.Namespace, inputs: list[Path], out: Path) -> dict[str, Any]:
    """逐县处理并追加写入，内存中只保留当前县的数据。"""
    metric_crs, infos = choose_metric_crs_from_paths(inputs)
    if args.target_crs:
        metric_crs = CRS.from_user_input(args.target_crs)
    if not metric_crs.is_projected:
        raise ValueError("处理坐标系必须是投影坐标系")
    output_crs = CRS.from_user_input(args.target_crs) if args.target_crs else CRS.from_user_input(infos[0]["crs"])
    working = out.with_name(out.stem + ".partial.gpkg")
    if out.exists() or working.exists():
        raise FileExistsError(f"输出文件或未完成的临时文件已存在，请先检查后另选输出路径：{out} / {working}")
    out.parent.mkdir(parents=True, exist_ok=True)

    input_report = []
    county_report = []
    totals = {"features": 0, "invalid": 0, "vertices_in": 0, "vertices_out": 0,
              "target_met": 0, "target_unmet": 0, "reverted": 0, "source_overlaps": 0,
              "remaining_invalid": 0, "max_area_change": 0.0}
    for file_index, (path, info) in enumerate(zip(inputs, infos), start=1):
        if info.get("features", 0) == 0:
            continue
        print(f"[{file_index}/{len(inputs)}] 正在处理 {path.name}（{info['features']:,} 个要素）", flush=True)
        gdf = gpd.read_file(path, engine="pyogrio")
        if gdf.crs is None:
            raise ValueError(f"输入文件缺少坐标系信息：{path}")
        bad = ~gdf.geometry.is_valid
        bad_count = int(bad.sum())
        if bad_count and not args.repair_invalid:
            raise ValueError(f"{path.name} 中有 {bad_count} 个无效几何；请检查源数据，或使用 --repair-invalid 修复")
        if bad_count:
            gdf.loc[bad, "geometry"] = gdf.loc[bad, "geometry"].make_valid().map(polygonal)
        source = gdf[[gdf.geometry.name]].copy()
        if source.geometry.name != "geometry":
            source = source.rename_geometry("geometry")
        projected = source.to_crs(metric_crs)
        original = [as_multi_polygon(g) for g in projected.geometry]
        original_vertices = [vertex_count(g) for g in original]
        if args.coverage:
            if not shapely.coverage_is_valid(original, gap_width=0.0):
                raise ValueError(f"{path.name} 不是有效的面覆盖数据，不能启用 --coverage")
            simplified, changes = simplify_coverage(original, args.max_area_change, args.target_ratio)
        else:
            simplified, changes = simplify_many(original, args.max_area_change, args.target_ratio)
        simplified, reverted_count, source_overlap_count = prevent_new_overlaps(original, simplified, args.overlap_tolerance)
        for i, geom in enumerate(simplified):
            old_area = original[i].area
            changes[i]["area_change"] = abs(geom.area - old_area) / old_area if old_area else 0.0
            changes[i]["ratio"] = vertex_count(geom) / original_vertices[i] if original_vertices[i] else 1.0
            changes[i]["target_met"] = vertex_count(geom) <= original_vertices[i] * args.target_ratio
        result = gpd.GeoDataFrame(geometry=simplified, crs=metric_crs)
        if output_crs != metric_crs:
            result = result.to_crs(output_crs)
        result.geometry = result.geometry.map(as_multi_polygon)
        result.to_file(working, layer=args.layer, driver="GPKG", engine="pyogrio", index=False,
                       mode="w" if not working.exists() else "a")

        vertices_in = sum(original_vertices)
        vertices_out = sum(vertex_count(g) for g in simplified)
        met = sum(bool(s["target_met"]) for s in changes)
        remaining_invalid = sum(not g.is_valid for g in simplified)
        county_report.append({"file": path.name, "features": len(simplified),
                              "vertex_ratio": vertices_out / vertices_in if vertices_in else None,
                              "target_met": met, "target_unmet": len(simplified) - met,
                              "invalid_before_repair": bad_count,
                              "source_overlap_pairs_within_file": source_overlap_count,
                              "features_reverted": reverted_count})
        input_report.append({"file": str(path), "features": len(gdf), "invalid_before_repair": bad_count,
                             "crs": gdf.crs.to_string()})
        totals["features"] += len(simplified)
        totals["invalid"] += bad_count
        totals["vertices_in"] += vertices_in
        totals["vertices_out"] += vertices_out
        totals["target_met"] += met
        totals["target_unmet"] += len(simplified) - met
        totals["reverted"] += reverted_count
        totals["source_overlaps"] += source_overlap_count
        totals["remaining_invalid"] += remaining_invalid
        totals["max_area_change"] = max(totals["max_area_change"], max((s["area_change"] for s in changes), default=0.0))
        print(f"    顶点比例 {vertices_out / vertices_in:.1%}；面积约束下未达顶点目标 {len(simplified) - met:,} 个；回退要素 {reverted_count:,}", flush=True)
        del gdf, source, projected, original, simplified, result, changes

    if not working.exists():
        raise ValueError("没有写出任何非空图层")
    working.rename(out)
    report = {
        "created_utc": datetime.now(timezone.utc).isoformat(), "inputs": input_report,
        "output": str(out), "layer": args.layer, "feature_count": totals["features"],
        "processing_crs": metric_crs.to_string(), "output_crs": output_crs.to_string(),
        "attributes_removed": True,
        "simplification": {"target_vertex_ratio": args.target_ratio,
                           "max_area_change_per_feature": args.max_area_change,
                           "target_met_feature_count": totals["target_met"],
                           "target_unmet_feature_count": totals["target_unmet"],
                           "source_vertex_count": totals["vertices_in"],
                           "output_vertex_count": totals["vertices_out"],
                           "overall_vertex_ratio": totals["vertices_out"] / totals["vertices_in"] if totals["vertices_in"] else None,
                           "max_observed_area_change": totals["max_area_change"]},
        "overlap_check": {"scope": "within_each_input_file", "source_overlap_pair_count": totals["source_overlaps"],
                          "new_overlap_pair_count": 0, "features_reverted": totals["reverted"]},
        "cross_file_topology_checked": False, "coverage_mode": args.coverage,
        "invalid_geometries_repaired": totals["invalid"],
        "invalid_geometries_remaining": totals["remaining_invalid"],
        "per_file": county_report,
        "notes": ["逐输入文件处理，内存中只保留当前文件的几何。",
                  "每个输入文件内部检查并阻止简化新增正面积重叠；不同输入文件之间的边界重叠未在此模式下核验。",
                  "共边接触允许；没有行政区边界基准时无法判定缝隙是否错误。"]}
    report_path = out.with_suffix(".report.json")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(out), "report": str(report_path), "feature_count": totals["features"],
                      "overall_vertex_ratio": report["simplification"]["overall_vertex_ratio"],
                      "target_unmet_feature_count": totals["target_unmet"],
                      "cross_file_topology_checked": False}, ensure_ascii=False, indent=2))
    return report


def main() -> int:
    args = parse_args()
    if not 0 < args.target_ratio <= 1:
        raise ValueError("--target-ratio 必须大于 0 且不超过 1")
    if not 0 <= args.max_area_change < 1:
        raise ValueError("--max-area-change 必须在 [0, 1) 范围内")
    if args.overlap_tolerance < 0:
        raise ValueError("--overlap-tolerance 不能为负数")
    inputs = sorted(args.input_dir.glob("*.shp")) if args.input_dir else [Path(x) for x in args.inputs]
    inputs = [p.resolve() for p in inputs]
    if not inputs:
        raise FileNotFoundError("没有找到 SHP 文件")
    out = args.output.resolve()
    if out.suffix.lower() != ".gpkg":
        raise ValueError("输出文件扩展名必须是 .gpkg")
    if out in inputs:
        raise ValueError("输出路径不能覆盖输入文件")
    if args.stream_by_file:
        process_stream_by_file(args, inputs, out)
        return 0

    frames: list[gpd.GeoDataFrame] = []
    input_report = []
    for path in inputs:
        if not path.exists():
            raise FileNotFoundError(f"找不到输入文件：{path}")
        gdf = gpd.read_file(path, engine="pyogrio")
        if gdf.crs is None:
            raise ValueError(f"输入文件缺少坐标系信息：{path}")
        if not len(gdf):
            continue
        bad = ~gdf.geometry.is_valid
        bad_count = int(bad.sum())
        if bad_count and not args.repair_invalid:
            raise ValueError(f"{path.name} 中有 {bad_count} 个无效几何；请检查源数据，或使用 --repair-invalid 修复")
        if bad_count:
            gdf.loc[bad, "geometry"] = gdf.loc[bad, "geometry"].make_valid().map(polygonal)
        geom_frame = gdf[[gdf.geometry.name]].copy()
        if gdf.geometry.name != "geometry":
            geom_frame = geom_frame.rename_geometry("geometry")
        frames.append(geom_frame)
        input_report.append({"file": str(path), "features": len(gdf), "invalid_before_repair": bad_count, "crs": gdf.crs.to_string()})
    if not frames:
        raise ValueError("输入图层均为空")

    metric_crs = CRS.from_user_input(args.target_crs) if args.target_crs else choose_local_metric_crs(frames)
    if not metric_crs.is_projected:
        raise ValueError("处理坐标系必须是投影坐标系")
    all_metric = [g.to_crs(metric_crs) for g in frames]
    combined = gpd.GeoDataFrame(pd.concat(all_metric, ignore_index=True), geometry="geometry", crs=metric_crs)
    original = list(combined.geometry)
    original_vertices = [vertex_count(g) for g in original]
    if args.coverage:
        invalid_coverage = shapely.coverage_is_valid(original, gap_width=0.0)
        if not invalid_coverage:
            bad_edges = shapely.coverage_invalid_edges(original, gap_width=0.0)
            bad_count = sum(not g.is_empty for g in bad_edges)
            raise ValueError(f"启用了 --coverage，但输入不是有效的无重叠面覆盖（{bad_count} 个要素存在问题）。请改用普通逐面模式，或先修正源数据拓扑。")

    if args.coverage:
        simplified, changes = simplify_coverage(original, args.max_area_change, args.target_ratio)
    else:
        simplified, changes = simplify_many(original, args.max_area_change, args.target_ratio)
    simplified, reverted_count, source_overlap_count = prevent_new_overlaps(original, simplified, args.overlap_tolerance)
    for i, geom in enumerate(simplified):
        old_area = original[i].area
        changes[i]["area_change"] = abs(geom.area - old_area) / old_area if old_area else 0.0
        changes[i]["ratio"] = vertex_count(geom) / original_vertices[i] if original_vertices[i] else 1.0
        changes[i]["target_met"] = vertex_count(geom) <= original_vertices[i] * args.target_ratio
    simplified_gdf = gpd.GeoDataFrame(geometry=simplified, crs=metric_crs)
    overlap = check_overlaps(simplified, args.overlap_tolerance)

    output_crs = CRS.from_user_input(args.target_crs) if args.target_crs else CRS.from_user_input(frames[0].crs)
    if output_crs != metric_crs:
        result_gdf = simplified_gdf.to_crs(output_crs)
    else:
        result_gdf = simplified_gdf
    # 输出不含业务属性；GeoPackage 驱动可能添加内部 fid 字段。
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        raise FileExistsError(f"输出文件已存在。为避免覆盖数据，请另选输出路径：{out}")
    result_gdf.to_file(out, layer=args.layer, driver="GPKG", engine="pyogrio", index=False)

    total_in_vertices = sum(original_vertices)
    total_out_vertices = sum(vertex_count(g) for g in simplified)
    report = {
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "inputs": input_report,
        "output": str(out),
        "layer": args.layer,
        "feature_count": len(simplified),
        "processing_crs": metric_crs.to_string(),
        "output_crs": output_crs.to_string(),
        "attributes_removed": True,
        "simplification": {
            "target_vertex_ratio": args.target_ratio,
            "max_area_change_per_feature": args.max_area_change,
            "target_met_feature_count": sum(s["target_met"] for s in changes),
            "target_unmet_feature_count": sum(not s["target_met"] for s in changes),
            "source_vertex_count": total_in_vertices,
            "output_vertex_count": total_out_vertices,
            "overall_vertex_ratio": total_out_vertices / total_in_vertices if total_in_vertices else None,
            "max_observed_area_change": max((s["area_change"] for s in changes), default=0.0),
        },
        "overlap_check": overlap,
        "source_overlap_pair_count": source_overlap_count,
        "features_reverted_to_prevent_new_overlaps": reverted_count,
        "coverage_mode": args.coverage,
        "invalid_geometries_remaining": int((~simplified_gdf.geometry.is_valid).sum()),
        "notes": ["Features were appended and not dissolved.", "Overlap detection reports positive-area intersections above the configured tolerance; shared boundary contact is allowed.", "Source gaps cannot be classified without an authoritative study-area boundary."],
    }
    report_path = out.with_suffix(".report.json")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(out), "report": str(report_path), "feature_count": len(simplified), "overall_vertex_ratio": report["simplification"]["overall_vertex_ratio"], "target_unmet_feature_count": report["simplification"]["target_unmet_feature_count"], "overlap_pair_count": overlap["overlap_pair_count"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"错误：{exc}", file=sys.stderr)
        raise SystemExit(2)
