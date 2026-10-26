# 产地重金属污染防控智慧平台

Vue 3 + Vite 项目，包含农田治理助手和污染状况智能分析两个独立入口。行政区、耕地图斑及底图等地图数据由 GeoServer/天地图提供；平台业务接口由本地开发代理转发。

## 环境要求

- Node.js 20.19+ 或 22.12+
- npm
- 使用 `/wrfx/` 地图圈选和行政区/耕地图层时，需要本机或可访问的 GeoServer

## 本地运行

```sh
npm install
cp .env.example .env.local
# 按需填写 .env.local 中的平台账号和 DeepSeek API Key
npm run dev
```

打开以下模块：

- 农田治理助手：<http://localhost:5177/jsyy/>
- 污染状况智能分析：<http://localhost:5177/wrfx/>

开发服务默认监听 `0.0.0.0:5177`，同一局域网的设备可通过本机局域网 IP 访问。若 GeoServer 不在本机 `localhost:18080`，可在 `.env.local` 中设置 `VITE_GEOSERVER_PROXY_TARGET`。

## 构建与预览

```sh
npm run build
npm run preview
```

构建文件输出到 `dist/`。业务代理由 `vite.config.js` 和 `server/` 提供，生产部署时需把相应 API 代理迁移或配置到正式服务端；仅托管静态构建文件不会提供这些代理能力。模块默认前缀为 `/jsyy/`，可通过 `VITE_BASE_PATH` 调整。

## 目录结构

- `src/`：两个模块的 Vue 页面、地图、业务逻辑和样式
- `server/`：平台数据与治理方案接口代理
- `public/`：静态资源
- `deploy/docker/`：PostGIS 与 GeoServer 的本地 Docker Compose 配置
- `shp_tool/`：面状 SHP 简化与合并工具
- `tests/`：项目自动化测试
- `vite.config.js`：开发路由、代理和构建入口

## 配置与数据安全

将 `.env.example` 复制为 `.env.local` 后填写本机凭据。`.env.local`、GeoServer 数据目录、数据库数据和密钥不会提交到仓库。不要把真实账号、密码或 API Key 写入源码。
