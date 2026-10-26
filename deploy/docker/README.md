# 本机空间数据库与 GeoServer（Apple Silicon）

配置目标：Docker Desktop、PostgreSQL 17 + PostGIS 3.5、GeoServer 2.28.2（低于 3.0）。所有服务只绑定本机回环地址，不对局域网或公网开放。

## 安装 Docker Desktop

1. 从 Docker 官方安装页下载 Apple silicon 版本并安装 Docker Desktop：https://docs.docker.com/desktop/setup/install/mac-install/
2. 启动 Docker Desktop，等待状态显示 Docker Engine 正在运行。初次启动按系统提示完成权限确认。
3. 在终端确认 `docker --version` 和 `docker compose version` 均可运行。

## 启动服务

在仓库根目录运行：

```sh
cd deploy/docker
cp .env.example .env
```

编辑 `.env`，将两个密码改成不同的强密码，然后运行：

```sh
docker compose up -d
```

首次启动需要下载镜像并初始化数据库。GeoServer 管理页：<http://localhost:8080/geoserver>。数据库连接客户端可用 `localhost:5432`，数据库名、用户和密码取自 `.env`。

## GeoServer 连接 PostGIS

在 GeoServer 管理页登录后，添加 Store → PostGIS。容器间连接地址使用主机名 `postgis`（不要用 `localhost`），端口 `5432`，数据库名/用户名/密码取自 `.env`。GeoServer 与数据库已经加入同一个 Compose 网络。

在目标数据库执行：

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

PostGIS 镜像会为首次创建的默认数据库初始化 PostGIS；此命令可用于确认/启用扩展。

## 常用管理命令

```sh
docker compose ps
docker compose logs -f geoserver
docker compose logs -f postgis
docker compose stop
docker compose start
```

保留数据停止：`docker compose down`。**不要使用 `docker compose down -v`**，该命令会删除数据库卷。GeoServer 配置保存在本目录的 `geoserver_data/`；PostgreSQL 数据保存在 Docker 命名卷 `postgis_data`。

备份数据库示例：

```sh
docker compose exec -T postgis pg_dump -U gisadmin -d gis > gis-backup.sql
```

此示例里的用户名和数据库名为默认值；若在 `.env` 中改过，请同步替换。
