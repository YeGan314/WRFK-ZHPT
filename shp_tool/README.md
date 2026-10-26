# 面状 SHP 简化与合并工具

本工具用于批量读取面状 SHP，删除源属性字段，在面积变化约束下简化边界，并把要素追加到同一个 GeoPackage 图层。程序不会修改输入文件。

## 环境安装

推荐使用 Miniforge/Conda 和 conda-forge 软件源。先为当前操作系统安装 Miniforge，然后在本目录运行：

```bash
conda env create -f environment.yml
conda activate shp-generalize
```

环境文件会为当前系统和 CPU 架构解析 GDAL、GEOS、PROJ 等原生 GIS 依赖。把工具复制到 Windows 或 Linux 时，应在目标电脑重新创建环境，不要复制本 Mac 的原生库文件。

## 处理工程中的样例

```bash
python generalize_merge.py \
  --input-dir "../衡南&衡阳" \
  --output "../输出/水田_简化合并.gpkg" \
  --target-ratio 0.15 \
  --max-area-change 0.01 \
  --overlap-tolerance 0.01 \
  --repair-invalid
```

## 处理大量按县区拆分的图层

图层数量多、数据总量大时，使用 `--stream-by-file` 逐个县区读写，避免一次把全省数据装入内存：

```bash
python generalize_merge.py \
  --input-dir "/Users/mac/Downloads/cf_county_hunan" \
  --output "../输出/湖南省耕地图斑_简化合并.gpkg" \
  --target-ratio 0.15 \
  --max-area-change 0.01 \
  --repair-invalid \
  --stream-by-file
```

流式模式会逐个输入文件处理，并在日志中显示进度；每个县区内部会检查和阻止简化新引入的正面积重叠。为控制内存占用，不会把所有县区同时装入内存，因此县区文件之间的边界重叠不在该模式中核验，报告会明确标注这一点。处理前建议先检查县界接边，处理后再做省域范围的跨县边界核验。

程序会读取输入目录中的全部 `.shp` 文件。也可以用 `--inputs 文件1.shp 文件2.shp` 显式指定文件。输出包括一个仅含几何的 GeoPackage 图层 `merged`，以及同目录下的 JSON 处理报告。默认目标是让总顶点数尽量降到原来的 15%，同时每个要素面积变化不超过 1%。若某个面无法在面积限制内达到顶点目标，优先遵守面积限制，并在报告中列出未达标数量。

输出文件已存在时程序会停止，以免覆盖已有数据；请改用新的输出路径。

## 拓扑检查说明

程序会追加要素，不会溶解相邻面。普通模式使用 GEOS 的拓扑保持简化，使单个要素保持有效；随后通过空间索引检查面间正面积重叠，并把简化中新产生重叠的要素恢复为原始几何，直到没有新增重叠。原始数据里已有的重叠会单独计入报告。共享边界接触不算重叠。

如果输入是一组边界精确相接的面覆盖数据，可加 `--coverage` 使用覆盖面简化，让相邻面共享边界一起简化。该模式要求输入先通过覆盖拓扑检查；检查失败时程序会停止，不会擅自改变源拓扑。它不能推断没有研究区边界定义的空隙是否为错误。

## 常用参数

- `--target-ratio`：目标顶点比例，例如 `0.15` 表示尽量保留约 15% 顶点。
- `--max-area-change`：每个要素允许的最大面积相对变化，例如 `0.01` 表示 1%。
- `--overlap-tolerance`：报告重叠时的面积阈值，单位为平方米，默认 `0.01` 平方米。
- `--target-crs`：可选输出坐标系，例如 `EPSG:32649`。未指定时输出使用第一个输入图层的坐标系。
- `--coverage`：启用面覆盖共享边界简化。
- `--repair-invalid`：先用 `make_valid` 修复无效输入。修复可能改变几何类型，报告会记录修复前无效要素数。

运行 `python generalize_merge.py --help` 查看全部参数。
