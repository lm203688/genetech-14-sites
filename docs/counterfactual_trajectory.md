# Counterfactual Trajectory API

> ⚠️ 本文档最后更新于 2026-10-17，可能已过期。权威口径见 docs/CORE_OBJECTIVE.md

## 概念

`counterfactual_trajectory` 是反事实轨迹分析工具，用于回答**"如果...会怎样"**类型的问题。它基于农业生长模型，模拟在不同条件下的作物表现轨迹。

### 什么是反事实轨迹？

反事实轨迹是对**历史事实的假设性重构**。例如：
- "如果去年夏天温度高 2°C，玉米产量会怎样？"
- "如果灌溉减少 20%，小麦的生长轨迹会如何变化？"
- "如果施肥时间提前一周，大豆的产量曲线会有什么不同？"

### 与 `agri_growth_plan` 的关系

| 工具 | 用途 | 数据类型 | 时间维度 |
|------|------|----------|----------|
| `agri_growth_plan` | **事实**：基于历史数据的实际生长轨迹 | 历史观测数据 | 过去 → 现在 |
| `counterfactual_trajectory` | **假设**：基于条件变化的模拟轨迹 | 模拟预测数据 | 现在 → 未来 |

## 输入参数

```json
{
  "recipe_ref": "string",      // 生长方案引用（必填）
  "perturbation": {            // 扰动条件（必填）
    "temperature": "+2.0",     // 温度变化（°C）
    "rainfall": "-20%",       // 降水变化（%）
    "soil_moisture": "+15%",  // 土壤湿度变化（%）
    "nutrient_level": "+10%", // 营养水平变化（%）
    "co2_level": "+50ppm"     // CO2浓度变化（ppm）
  },
  "steps": 7,                  // 模拟步数（天）
  "confidence_level": 0.95     // 置信度（0.8-0.99）
}
```

### 参数说明

- **`recipe_ref`**: 生长方案ID，格式为 `genetech:recipe:<station>:<crop>:<variety>`
- **`perturbation`**: 扰动条件对象，支持：
  - **数值变化**: `"+2.0"`（增加2°C）或 `"-10%"`（减少10%）
  - **绝对值**: `"25.0"`（温度固定为25°C）
  - **组合扰动**: 可同时修改多个环境参数
- **`steps`**: 模拟天数（1-30天）
- **`confidence_level`**: 置信度，影响预测区间宽度

## 输出格式

```json
{
  "trajectory": [
    {
      "day": 1,
      "yield_estimate": 8.5,
      "confidence_interval": [7.8, 9.2],
      "key_metrics": {
        "biomass": 45.2,
        "leaf_area": 3.8,
        "water_use_efficiency": 1.2
      },
      "environmental_stress": 0.15
    }
  ],
  "summary": {
    "total_yield_change": "+12.3%",
    "confidence_score": 0.87,
    "risk_level": "low",
    "key_drivers": ["temperature", "rainfall"],
    "recommendations": [
      "建议提前灌溉计划",
      "考虑增加遮阳网"
    ]
  },
  "metadata": {
    "recipe_id": "genetech:recipe:agritech:rice:superior",
    "simulation_id": "cf_2026-10-17_14:30:22",
    "model_version": "v2.1",
    "data_sources": ["field_observation", "climate_model", "soil_sensor"]
  }
}
```

## 使用场景

### 1. 决策支持
```javascript
// 如果干旱持续一周，对玉米产量影响？
const droughtScenario = {
  recipe_ref: "genetech:recipe:agritech:corn:drought_resistant",
  perturbation: {
    rainfall: "-100%",  // 完全无降雨
    temperature: "+3.0"  // 温度升高3°C
  },
  steps: 7
};
```

### 2. 风险评估
```javascript
// 评估极端天气事件对产量的影响
const extremeWeather = {
  recipe_ref: "genetech:recipe:agritech:wheat:high_yield",
  perturbation: {
    temperature: "+5.0",  // 极端高温
    rainfall: "+50%"      // 暴雨
  },
  steps: 3
};
```

### 3. 优化建议
```javascript
// 寻找最佳灌溉策略
const irrigationOptimization = {
  recipe_ref: "genetech:recipe:agritech:soybean:drought_tolerant",
  perturbation: {
    soil_moisture: "+10%",  // 微调土壤湿度
    temperature: "-1.0"     // 温度微降
  },
  steps: 14
};
```

## 技术实现

### 模型基础
- **生长模型**: 基于作物生理学的动态模型
- **环境响应**: 根据历史数据拟合的环境响应函数
- **不确定性量化**: 贝叶斯方法计算置信区间

### 数据源
- **田间观测**: 实时传感器数据
- **气象数据**: 历史气象记录和预报
- **土壤数据**: 土壤类型和养分含量
- **品种特性**: 品种特异性参数

### 计算流程
1. **参数验证**: 检查输入参数的合理性
2. **基准轨迹**: 计算无扰动条件下的基准轨迹
3. **扰动模拟**: 应用扰动条件重新计算
4. **不确定性传播**: 将不确定性从输入传播到输出
5. **结果分析**: 生成关键指标和建议

## 错误处理

| 错误类型 | 原因 | 解决方案 |
|----------|------|----------|
| `INVALID_RECIPE` | 生长方案不存在 | 检查recipe_ref格式 |
| `INVALID_PERTURBATION` | 扰动参数超出范围 | 验证扰动值范围 |
| `INSUFFICIENT_DATA` | 历史数据不足 | 增加数据收集或使用简化模型 |
| `MODEL_ERROR` | 模型计算失败 | 检查模型版本和参数 |

## 示例代码

```javascript
// 使用 counterfactual_trajectory API
const response = await fetch('/api/counterfactual', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ${token}'
  },
  body: JSON.stringify({
    recipe_ref: "genetech:recipe:agritech:rice:superior",
    perturbation: {
      temperature: "+2.0",
      rainfall: "-15%"
    },
    steps: 7,
    confidence_level: 0.95
  })
});

const result = await response.json();
console.log(`产量变化: ${result.summary.total_yield_change}`);
console.log(`建议: ${result.summary.recommendations.join(', ')}`);
```

## 相关工具

- `agri_growth_plan`: 获取实际生长轨迹
- `climate_impact_assessment`: 评估气候长期影响
- `yield_prediction`: 产量预测工具
- `soil_health_analysis`: 土壤健康分析

## 更新日志

- **v2.1** (2026-10-17): 增加CO2浓度扰动支持，优化不确定性量化算法
- **v2.0** (2026-09-15): 重构模型架构，支持多品种比较
- **v1.0** (2026-08-01): 初始版本，支持基础反事实分析