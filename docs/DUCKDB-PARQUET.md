# DuckDB + Parquet 集成方案

> Phase 6 P2-3：30 站 entities.json → Parquet 列式格式，支持跨站查询

## 一、背景与目标

**现状**：30 站 entities.json 合计 518MB，JSON 行式格式，查询需加载全文件。

**目标**：
- 518MB JSON → ~50-100MB Parquet（列式压缩，预估 80-90% 节省）
- DuckDB 可直接查询 Parquet（零后端依赖，单机 SQLite 模式）
- 支持跨站 UNION ALL 查询（30 站合并分析）

## 二、工具链

| 工具 | 用途 | 安装 |
|---|---|---|
| DuckDB | SQL 查询引擎（Parquet 原生支持） | `choco install duckdb` / `brew install duckdb` / 下载 [duckdb.org](https://duckdb.org/docs/stable/installation) |
| `tools/build-parquet.mjs` | JSON → Parquet 转换 | `node tools/build-parquet.mjs` |
| `tools/parquet-query.mjs` | 查询示例 | `node tools/parquet-query.mjs` |

**Node.js 绑定**（可选）：
```bash
npm install @duckdb/node-bindings duckdb
```

## 三、使用流程

### 3.1 构建 Parquet 索引

```bash
# 单站构建
node tools/build-parquet.mjs neuromorphic

# 全部 30 站
node tools/build-parquet.mjs

# 指定输出目录
node tools/build-parquet.mjs --out data/parquet
```

**输出结构**：
```
data/parquet/
├── neuromorphic.parquet      # 单站
├── new-energy.parquet
├── ... (30 站)
├── all.parquet               # 合并站
├── _<site>.sql               # 构建脚本（可手动执行）
└── _combined.sql
```

### 3.2 查询示例

```bash
# 默认示例查询（5 个演示）
node tools/parquet-query.mjs

# 自定义查询
node tools/parquet-query.mjs "SELECT COUNT(*) FROM read_parquet('data/parquet/*.parquet')"

# 直接用 DuckDB CLI
duckdb -c "SELECT * FROM read_parquet('data/parquet/*.parquet') LIMIT 5"
```

### 3.3 典型查询

```sql
-- 全站实体总数
SELECT COUNT(*) FROM read_parquet('data/parquet/*.parquet');

-- 各站实体数
SELECT extract_filename(filename) AS site, COUNT(*) AS cnt 
FROM read_parquet('data/parquet/*.parquet') 
GROUP BY site ORDER BY cnt DESC;

-- 高置信度实体 Top 10
SELECT name, doi, confidence 
FROM read_parquet('data/parquet/*.parquet') 
WHERE confidence > 0.9 
ORDER BY confidence DESC LIMIT 10;

-- 跨站重复 DOI
SELECT doi, COUNT(DISTINCT extract_filename(filename)) AS sites, COUNT(*) AS occurrences 
FROM read_parquet('data/parquet/*.parquet') 
WHERE doi != '' 
GROUP BY doi HAVING COUNT(*) > 1 
ORDER BY sites DESC LIMIT 20;
```

## 四、性能对比

| 指标 | JSON（现状） | Parquet（目标） |
|---|---|---|
| 30 站总大小 | 518 MB | ~50-100 MB（预估 80-90% 节省） |
| 单站加载 | 13-22 MB | ~1-3 MB |
| 跨站查询 | 需 JS 遍历 | DuckDB SQL（C++ 引擎） |
| 列式过滤 | 全文件扫描 | 列裁剪 + 谓词下推 |
| 后端依赖 | 无 | 无（DuckDB 单机） |

**实测数据**（待 DuckDB 安装后补充）：
- neuromorphic: 13MB JSON → ?MB Parquet
- 30 站合计: 518MB JSON → ?MB Parquet

## 五、CI 集成

```yaml
# .github/workflows/parquet-build.yml（建议）
name: parquet-build
on:
  push:
    paths: ['**/entities.json']
  schedule:
    - cron: '0 2 * * *'  # 每日 02:00 UTC

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install DuckDB
        run: sudo apt-get update && sudo apt-get install -y duckdb
      - name: Build Parquet
        run: node tools/build-parquet.mjs
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: parquet-index
          path: data/parquet/*.parquet
```

## 六、与现有系统对比

| 方案 | 优点 | 缺点 |
|---|---|---|
| JSON（现状） | 简单、无依赖 | 大、查询慢、需加载全文件 |
| **DuckDB + Parquet** | **列式压缩、SQL 查询、零后端** | **需安装 DuckDB** |
| SQLite | 成熟、标准 SQL | 无 Parquet 原生支持 |
| PostgreSQL | 企业级、扩展 | 需部署后端 |
| ES/Milvus | 全文/向量搜索 | 复杂、成本高 |

**推荐场景**：
- 跨站聚合分析（引用率、趋势、覆盖度）
- 数据质量监控（重复 DOI、缺失字段）
- 研究报告生成（引用网络、领域对比）

## 七、局限性

1. **需安装 DuckDB**：Windows 用户需手动安装或 choco
2. **不替代全文搜索**：Pagefind 更适合用户端搜索
3. **不替代向量检索**：语义搜索仍需 TEI/Milvus
4. **构建耗时**：30 站全量 ~2-3 分钟（DuckDB 编译）

## 八、下一步

- [ ] DuckDB 安装指南（Windows/macOS/Linux）
- [ ] CI 自动构建 Parquet 索引
- [ ] 数据质量报告自动生成（重复 DOI、缺失字段）
- [ ] 跨站分析脚本（引用率趋势、领域覆盖度）
- [ ] 与 Pagefind 搜索整合（Parquet 做后端分析，Pagefind 做前端搜索）

## 九、参考

- [DuckDB 官方文档](https://duckdb.org/docs/stable/data/parquet/overview)
- [Parquet 格式规范](https://parquet.apache.org/docs/file-format/)
- [DuckDB Node.js 绑定](https://duckdb.org/docs/stable/guides/nodejs/overview)

---

**状态**：工具链就绪（`build-parquet.mjs` + `parquet-query.mjs`），待 DuckDB 安装实测。
