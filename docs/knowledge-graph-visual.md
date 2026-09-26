# GeneTech 知识图谱可视化

## 概述
基于 `data/knowledge-graph-entities.json` 构建交互式领域关系图谱，展示：
- **节点**：4075 个实体（按领域分类着色）
- **边**：5050 条关系（原始语义边 50 条 + 共现边 5000 条）
- **交互**：节点点击查看详情、边悬停显示权重、领域筛选、力导向布局

## 技术栈
- D3.js v7（力导向图）
- 原生 Canvas/SVG 渲染
- 无后端依赖，纯前端静态页面

## 文件说明
- `docs/domain-graph.html` — 主可视化页面（已存在，健康仪表盘）
- `docs/knowledge-graph-visual.html` — 新增交互式图谱页面

## 使用方式
直接在浏览器中打开 `docs/knowledge-graph-visual.html`，或部署到 GitHub Pages 后访问。

## 数据流
```
data/knowledge-graph-entities.json
    ↓ (D3 force simulation)
SVG canvas
    ↓ (click/hover events)
节点详情面板 / 边信息浮层
```

## API 端点
- `GET /api/v1/requests` — 查询数据需求列表
- `POST /api/v1/requests` — 提交数据需求
- `GET /api/v1/requests/:id` — 查询单个需求详情
