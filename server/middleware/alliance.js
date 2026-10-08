/**
 * 同盟数据隔离工具
 * root 不过滤，盟主及以下按 alliance_id 隔离
 */

/**
 * 获取当前用户的同盟ID（root 返回 null）
 */
function getAllianceId(req) {
  if (req.user.role === 'root') return null
  return req.user.alliance_id || null
}

/**
 * 为有 alliance_id 字段的表生成 WHERE 片段
 * @param {object} req - express req
 * @param {string} alias - 表别名，默认 'm'
 * @returns {{ sql: string, params: any[] }}
 */
function allianceFilter(req, alias = 'm') {
  const aid = getAllianceId(req)
  if (aid == null) return { sql: '', params: [] }
  return { sql: ` AND ${alias}.alliance_id = ?`, params: [aid] }
}

/**
 * 为通过 member_id 关联的表生成 JOIN + WHERE 片段
 * @param {object} req
 * @param {string} tableAlias - 当前表别名
 * @param {string} memberCol - member_id 列名，默认 'member_id'
 * @returns {{ join: string, where: string, params: any[] }}
 */
function allianceFilterViaMember(req, tableAlias, memberCol = 'member_id') {
  const aid = getAllianceId(req)
  if (aid == null) return { join: '', where: '', params: [] }
  return {
    join: ` JOIN members _am ON _am.id = ${tableAlias}.${memberCol}`,
    where: ` AND _am.alliance_id = ?`,
    params: [aid]
  }
}

/**
 * INSERT 时获取 alliance_id 值
 * root 创建的数据 alliance_id 为 null（全局数据）
 */
function getAllianceIdForInsert(req) {
  if (req.user.role === 'root') return null
  return req.user.alliance_id || null
}

module.exports = { getAllianceId, allianceFilter, allianceFilterViaMember, getAllianceIdForInsert }
