/**
 * user-agent.cjs — 唯一的 User-Agent 真源
 *
 * 为什么单独成文件
 *   之前 UA 有 4 种并存值（GeneTechBot/1.0、GeneTechBot/2.0 (mailto:genetech.example)、
 *   GeneTechBot/2.0 (mailto:swarmlabs.tools)、genetech-geo-bot），散在 7 个 pipeline 里。
 *   实际危害不只是"不整洁"：对同一上游（OpenAlex / Crossref / GitHub）用不同身份，
 *   对方的限流是按 UA 分桶的，等于把自己的配额切碎成几份、每份更容易触顶。
 *
 *   做成 .cjs 是因为 operations-plan/ 下同时存在 ESM（lib/*.mjs）与 CJS（pipeline-*.js）。
 *   两种模块系统都能读同一个 named export，才能真正做到"一份实现 = 一处修改"。
 *
 * 修改纪律
 *   - 换 UA 只改这一处。
 *   - mailto 必须可送达（上游会用回信地址联系你调整限流），别写 .example 假地址。
 *   - 不要为"看起来专业"而加浏览器 UA 伪装——本项目数据源是公开学术 JSON API，
 *     反爬伪装属于违反 ToS 的方向，不做。
 */
'use strict';

module.exports = {
  USER_AGENT: 'GeneTechBot/2.0 (+https://swarmlabs.tools/; mailto:ops@swarmlabs.tools)',
};
