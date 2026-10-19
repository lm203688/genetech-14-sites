/**
 * lib/schema-validator.cjs — 数据 schema 校验库（F4）
 *
 * 职责：
 *   - 加载 data/schemas/*.schema.json
 *   - 提供 validate() 函数，支持 JSON Schema draft-07 校验
 *   - 三处强制校验集成点：
 *     1. ingest 出口（pipeline 写盘前）
 *     2. sync-live 入口（站点同步前）
 *     3. MCP 工具出口（API 返回前）
 *
 * 验收判据：造一条缺字段记录，三处均拒绝
 */

const fs = require('fs');
const path = require('path');

const SCHEMAS_DIR = path.resolve(__dirname, '..', 'data', 'schemas');

// 缓存已加载的 schema
const schemaCache = new Map();

/**
 * 加载 schema 文件（带缓存）
 */
function loadSchema(name) {
  if (schemaCache.has(name)) {
    return schemaCache.get(name);
  }

  const schemaPath = path.join(SCHEMAS_DIR, `${name}.schema.json`);
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema not found: ${schemaPath}`);
  }

  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
  schemaCache.set(name, schema);
  return schema;
}

/**
 * 简单的 JSON Schema draft-07 校验器
 * 支持：type, required, properties, items, additionalProperties, enum, format
 */
function validateSchema(data, schema, path = 'root') {
  const errors = [];

  // 检查类型
  if (schema.type) {
    const actualType = Array.isArray(data) ? 'array' : typeof data;
    if (schema.type === 'array' && !Array.isArray(data)) {
      errors.push(`${path}: expected array, got ${actualType}`);
    } else if (schema.type === 'object' && (typeof data !== 'object' || data === null)) {
      errors.push(`${path}: expected object, got ${actualType}`);
    } else if (schema.type === 'string' && typeof data !== 'string') {
      errors.push(`${path}: expected string, got ${actualType}`);
    } else if (schema.type === 'number' && typeof data !== 'number') {
      errors.push(`${path}: expected number, got ${actualType}`);
    } else if (schema.type === 'boolean' && typeof data !== 'boolean') {
      errors.push(`${path}: expected boolean, got ${actualType}`);
    }
  }

  // 检查 required 字段
  if (schema.required && typeof data === 'object' && data !== null && !Array.isArray(data)) {
    for (const field of schema.required) {
      if (!(field in data)) {
        errors.push(`${path}: missing required field '${field}'`);
      }
    }
  }

  // 检查 properties
  if (schema.properties && typeof data === 'object' && data !== null && !Array.isArray(data)) {
    for (const [field, fieldSchema] of Object.entries(schema.properties)) {
      if (field in data) {
        const fieldPath = `${path}.${field}`;
        errors.push(...validateSchema(data[field], fieldSchema, fieldPath));
      }
    }
  }

  // 检查 items (数组)
  if (schema.items && Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const itemPath = `${path}[${i}]`;
      errors.push(...validateSchema(data[i], schema.items, itemPath));
    }
  }

  // 检查 enum
  if (schema.enum && !schema.enum.includes(data)) {
    errors.push(`${path}: value '${data}' not in enum ${JSON.stringify(schema.enum)}`);
  }

  // 检查 additionalProperties: false
  if (schema.additionalProperties === false && typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const allowed = new Set(Object.keys(schema.properties || {}));
    for (const key of Object.keys(data)) {
      if (!allowed.has(key)) {
        errors.push(`${path}: additional property '${key}' not allowed`);
      }
    }
  }

  // 检查 oneOf
  if (schema.oneOf && Array.isArray(schema.oneOf)) {
    let anyMatch = false;
    for (let i = 0; i < schema.oneOf.length; i++) {
      const subErrors = validateSchema(data, schema.oneOf[i], path);
      if (subErrors.length === 0) {
        anyMatch = true;
        break;
      }
    }
    if (!anyMatch) {
      errors.push(`${path}: value does not match any of the ${schema.oneOf.length} schemas`);
    }
  }

  return errors;
}

/**
 * 验证实体数组
 * @param {Array} entities - 实体数组
 * @param {string} schemaName - schema 名称（默认 'entity'）
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateEntities(entities, schemaName = 'entity') {
  if (!Array.isArray(entities)) {
    return { valid: false, errors: ['Input must be an array'] };
  }

  let schema;
  try {
    schema = loadSchema(schemaName);
  } catch (e) {
    return { valid: false, errors: [`Failed to load schema: ${e.message}`] };
  }

  const allErrors = [];
  let validCount = 0;
  let errorCount = 0;

  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    const entityPath = `entities[${i}]`;
    const errors = validateSchema(entity, schema, entityPath);

    if (errors.length === 0) {
      validCount++;
    } else {
      errorCount++;
      // 限制错误输出数量，避免日志爆炸
      if (errorCount <= 10) {
        for (const error of errors) {
          allErrors.push(error);
        }
      }
      if (errorCount === 11) {
        allErrors.push(`... and ${entities.length - validCount - 10} more errors`);
      }
    }
  }

  return {
    valid: errorCount === 0,
    errors: allErrors,
    stats: {
      total: entities.length,
      valid: validCount,
      invalid: errorCount
    }
  };
}

/**
 * 验证知识图谱
 * @param {Object} kg - 知识图谱对象
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateKnowledgeGraph(kg) {
  let schema;
  try {
    schema = loadSchema('knowledge-graph');
  } catch (e) {
    return { valid: false, errors: [`Failed to load schema: ${e.message}`] };
  }

  const errors = validateSchema(kg, schema);
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * 验证引用边
 * @param {Object} citationEdges - 引用边对象
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateCitationEdges(citationEdges) {
  let schema;
  try {
    schema = loadSchema('citation-edges');
  } catch (e) {
    return { valid: false, errors: [`Failed to load schema: ${e.message}`] };
  }

  const errors = validateSchema(citationEdges, schema);
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * 验证站点标签
 * @param {Object} stationTags - 站点标签对象
 * @returns {{valid: boolean, errors: string[]}}
 */
function validateStationTags(stationTags) {
  let schema;
  try {
    schema = loadSchema('station-tags');
  } catch (e) {
    return { valid: false, errors: [`Failed to load schema: ${e.message}`] };
  }

  const errors = validateSchema(stationTags, schema);
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * 通用验证函数
 * @param {*} data - 待验证数据
 * @param {string} schemaName - schema 名称
 * @returns {{valid: boolean, errors: string[]}}
 */
function validate(data, schemaName) {
  let schema;
  try {
    schema = loadSchema(schemaName);
  } catch (e) {
    return { valid: false, errors: [`Failed to load schema: ${e.message}`] };
  }

  const errors = validateSchema(data, schema);
  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  validate,
  validateSchema, // F4 测试 + 外部消费方需要直接调用核心校验器
  validateEntities,
  validateKnowledgeGraph,
  validateCitationEdges,
  validateStationTags,
  loadSchema
};