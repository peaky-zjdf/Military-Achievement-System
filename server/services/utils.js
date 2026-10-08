/**
 * 密钥脱敏：显示前3后4，中间 ****
 */
function maskKey(v) {
  if (!v) return ''
  const s = String(v)
  return s.length <= 8 ? '****' : s.slice(0, 3) + '****' + s.slice(-4)
}

/**
 * 处理前端回传的脱敏值：包含 **** 的视为未修改，保持原值
 */
function maskFromReq(bodyVal, current) {
  if (bodyVal === undefined) return current
  if (bodyVal === '') return ''
  if (String(bodyVal).includes('****')) return current
  return String(bodyVal)
}

module.exports = { maskKey, maskFromReq }
