/**
 * 统一输入验证工具
 * 所有 API 接口使用这些函数校验入参，保持一致的错误信息风格。
 */

/** 正整数校验 */
function validId(v, label = 'ID') {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) return `${label}必须为正整数`
  return null
}

/** 有限正数（>0） */
function validPositive(v, label = '数值') {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return `${label}必须为正数`
  return null
}

/** 有限非零数（可正可负） */
function validNonZero(v, label = '数值') {
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return `${label}不能为零`
  return null
}

/** 有限数（含零） */
function validNumber(v, label = '数值') {
  const n = Number(v)
  if (!Number.isFinite(n)) return `${label}必须为有效数字`
  return null
}

/**
 * 名称：自动 trim、限长度、非空
 * @param {any} v - 原始值
 * @param {string} label - 错误提示标签
 * @param {number} maxLen - 最大长度，默认 50
 * @returns {string|null} 错误信息或 null
 */
function validName(v, label = '名称', maxLen = 50) {
  const s = String(v || '').trim()
  if (!s) return `${label}不能为空`
  if (s.length > maxLen) return `${label}不能超过${maxLen}字`
  return null
}

/**
 * 清洗名称字段：去首尾空格、截断超长
 */
function cleanName(v, maxLen = 50) {
  return String(v || '').trim().slice(0, maxLen)
}

/**
 * 批量校验，返回第一个错误信息，或 null 表示全部通过
 * @param {Array<string|null>} checks - 各校验函数的返回值
 * @returns {string|null}
 */
function validate(checks) {
  for (const c of checks) {
    if (c) return c
  }
  return null
}

module.exports = { validId, validPositive, validNonZero, validNumber, validName, cleanName, validate }
