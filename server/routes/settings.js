const express = require('express')
const bcrypt = require('bcryptjs')
const XLSX = require('xlsx')
const { db, getSetting, setSetting, logOp, getAllianceSetting, setAllianceSetting, getMaskedAllianceSetting } = require('../db')
const { authRequired, requireLevel } = require('../middleware/auth')
const { maskKey, maskFromReq } = require('../services/utils')
const { validName, cleanName, validate } = require('../services/validate')

const router = express.Router()

/** 公开：系统标题（登录页/顶栏用，无需登录） */
router.get('/brand', (req, res) => {
  res.json({ title: getSetting('system_title', '率土之滨 | 云衍 · 军功系统') })
})

router.use(authRequired)

router.get('/', requireLevel(2), (req, res) => {
  const settings = {}
  const rows = db.prepare('SELECT key, value FROM settings').all()
  for (const r of rows) settings[r.key] = r.value
  const seasons = db.prepare('SELECT * FROM seasons ORDER BY id DESC').all()
  const users = db.prepare(`
    SELECT u.id, u.username, u.role, u.member_id, m.nickname, m.game_id
    FROM users u LEFT JOIN members m ON m.id = u.member_id ORDER BY u.id
  `).all()
  const opAction = req.query.action || ''
  const opDateFrom = req.query.dateFrom || ''
  const opDateTo = req.query.dateTo || ''
  let opSql = `
    SELECT o.*, u.username, m.nickname
    FROM op_logs o
    LEFT JOIN users u ON u.id = o.user_id
    LEFT JOIN members m ON m.id = u.member_id
    WHERE 1=1
  `
  const opParams = []
  if (opAction) {
    opSql += ' AND o.action LIKE ?'
    opParams.push(`%${opAction}%`)
  }
  if (opDateFrom) {
    opSql += ' AND o.created_at >= ?'
    opParams.push(opDateFrom)
  }
  if (opDateTo) {
    opSql += ' AND o.created_at <= ?'
    opParams.push(opDateTo + ' 23:59:59')
  }
  opSql += ' ORDER BY o.created_at DESC LIMIT 100'
  const opLogs = db.prepare(opSql).all(...opParams)
  const announcements = db.prepare('SELECT * FROM announcements ORDER BY pinned DESC, created_at DESC LIMIT 50').all()
  // 不向前端泄露密钥
  delete settings.jwt_secret
  // API 密钥脱敏：只回 has_* 与脱敏值
  const mask = (k) => {
    const v = settings[k]
    if (!v) return ''
    const s = String(v)
    return s.length <= 8 ? '****' : s.slice(0, 3) + '****' + s.slice(-4)
  }
  const apiKeys = [
    'vision_api_key',
    'llm_api_key',
  ]
  for (const k of apiKeys) {
    settings[`has_${k}`] = !!settings[k]
    settings[k] = mask(k)
  }
  res.json({ settings, seasons, users, opLogs, announcements })
})

/** 视觉/大模型 API 配置（盟主，同盟级） */
router.get('/api-config', requireLevel(4), (req, res) => {
  const allianceId = req.user.alliance_id
  // root 用户（alliance_id=null）fallback 到全局设置
  const g = (k) => allianceId ? getAllianceSetting(allianceId, k, '') : getSetting(k, '')
  const masked = (k) => allianceId ? getMaskedAllianceSetting(allianceId, k) : maskKey(getSetting(k, ''))
  const has = (k) => allianceId ? !!getAllianceSetting(allianceId, k, '') : !!getSetting(k, '')
  res.json({
    vision: {
      provider: g('vision_provider') || 'openai',
      base_url: g('vision_base_url'),
      model: g('vision_model'),
      api_key: masked('vision_api_key'),
      has_key: has('vision_api_key'),
      enabled: g('vision_enabled') === '1',
      extra: g('vision_extra') || '',
    },
    llm: {
      provider: g('llm_provider') || 'openai',
      base_url: g('llm_base_url'),
      model: g('llm_model'),
      api_key: masked('llm_api_key'),
      has_key: has('llm_api_key'),
      enabled: g('llm_enabled') === '1',
      extra: g('llm_extra') || '',
    },
  })
})


router.put('/api-config', requireLevel(4), (req, res) => {
  const allianceId = req.user.alliance_id
  if (!allianceId) return res.status(400).json({ error: 'root 用户请直接修改全局设置' })
  const g = (k) => getAllianceSetting(allianceId, k, '')
  const s = (k, v) => setAllianceSetting(allianceId, k, v)

  const b = req.body || {}
  const v = b.vision || {}
  const l = b.llm || {}

  if (v.provider !== undefined) s('vision_provider', v.provider || 'openai')
  if (v.base_url !== undefined) s('vision_base_url', v.base_url || '')
  if (v.model !== undefined) s('vision_model', v.model || '')
  if (v.api_key !== undefined) s('vision_api_key', maskFromReq(v.api_key, g('vision_api_key')))
  if (v.enabled !== undefined) s('vision_enabled', v.enabled ? '1' : '0')
  if (v.extra !== undefined) s('vision_extra', v.extra || '')

  if (l.provider !== undefined) s('llm_provider', l.provider || 'openai')
  if (l.base_url !== undefined) s('llm_base_url', l.base_url || '')
  if (l.model !== undefined) s('llm_model', l.model || '')
  if (l.api_key !== undefined) s('llm_api_key', maskFromReq(l.api_key, g('llm_api_key')))
  if (l.enabled !== undefined) s('llm_enabled', l.enabled ? '1' : '0')
  if (l.extra !== undefined) s('llm_extra', l.extra || '')

  logOp(req.user.id, '修改API配置', `alliance=${allianceId}`)
  res.json({ ok: true })
})

/** 测试连通性：先 /models，再 /chat/completions 最小请求 */
router.post('/api-config/test', requireLevel(4), async (req, res) => {
  const kind = req.body?.kind === 'llm' ? 'llm' : 'vision'
  const allianceId = req.user.alliance_id
  const g = (k) => allianceId ? getAllianceSetting(allianceId, k, '') : getSetting(k, '')
  const baseUrl = (g(kind === 'vision' ? 'vision_base_url' : 'llm_base_url') || '').replace(/\/$/, '')
  const apiKey = g(kind === 'vision' ? 'vision_api_key' : 'llm_api_key')
  const model = g(kind === 'vision' ? 'vision_model' : 'llm_model')
  if (!baseUrl) return res.json({ ok: false, error: '请先填写 Base URL 并保存' })
  if (!apiKey) return res.json({ ok: false, error: '请先填写 API Key 并保存' })

  const label = kind === 'vision' ? '视觉' : '大模型'
  const tryFetch = async (url, options = {}) => {
    return fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(30000),
    })
  }

  // 1) GET /models
  try {
    const r = await tryFetch(baseUrl + '/models')
    if (r.ok) {
      await r.json().catch(() => ({}))
      return res.json({ ok: true, message: `${label}接口连通正常（/models）${model ? ' · ' + model : ''}` })
    }
    if (r.status === 401) return res.json({ ok: false, error: '连通成功但 API Key 无效 (401)' })
  } catch (e) {
    // fallthrough
  }

  // 2) POST /chat/completions
  try {
    const body = {
      model: model || 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    }
    const r = await tryFetch(baseUrl + '/chat/completions', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    if (r.ok) {
      await r.json().catch(() => ({}))
      return res.json({ ok: true, message: `${label}接口连通正常（chat）${model ? ' · ' + model : ''}` })
    }
    const errText = await r.text().catch(() => '')
    if (r.status === 401) return res.json({ ok: false, error: '连通成功但 API Key 无效 (401)' })
    if (r.status === 404) return res.json({ ok: false, error: `模型不存在或路径错误 (404)${model ? '：' + model : ''}` })
    return res.json({ ok: false, error: `HTTP ${r.status}${errText ? ' · ' + errText.slice(0, 160) : ''}` })
  } catch (e) {
    const name = e?.name || ''
    const msg = e?.message || ''
    if (name === 'TimeoutError' || /abort|timeout/i.test(msg)) {
      return res.json({ ok: false, error: '连接超时（30秒）。请检查本机能否访问该 Base URL，或换镜像地址。' })
    }
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(msg)) {
      return res.json({ ok: false, error: '网络无法访问该地址。请确认 Base URL 可达（本机能否打开 https://api.siliconflow.cn ）。' })
    }
    return res.json({ ok: false, error: msg || '连接失败' })
  }
})

router.put('/', requireLevel(4), (req, res) => {
  const allowed = new Set([
    'system_title',
    'shop_enabled', 'shop_audit_virtual', 'shop_audit_physical', 'shop_monthly_limit',
    'season_end_clear_available', 'hide_dormant_default',
    'war_merit_per_merit', 'demolition_per_point', 'attendance_merit', 'absent_penalty',
    'land_flip_merit', 'guard_minute_merit', 'scout_merit',
    'journey_war_per_point', 'journey_demolish_per_point', 'journey_kill_per_point',
    'journey_land_per_point', 'journey_city_kill_per_point', 'journey_source',
  ])
  const body = req.body || {}
  if (body.system_title !== undefined) {
    const t = String(body.system_title || '').trim()
    if (!t || t.length > 80) return res.status(400).json({ error: '系统标题需为 1-80 字' })
    body.system_title = t
  }
  const keys = Object.keys(body).filter((k) => allowed.has(k) && k !== 'jwt_secret')
  for (const k of keys) {
    setSetting(k, body[k])
  }
  logOp(req.user.id, '修改系统设置', keys.join(','))
  res.json({ ok: true, updated: keys })
})

router.post('/seasons', requireLevel(4), (req, res) => {
  const { name, start_date, end_date } = req.body || {}
  const err = validate([validName(name, '赛季名称', 40)])
  if (err) return res.status(400).json({ error: err })
  const clean = cleanName(name, 40)
  db.prepare('UPDATE seasons SET active = 0').run()
  const info = db.prepare(`
    INSERT INTO seasons (name, start_date, end_date, active) VALUES (?, ?, ?, 1)
  `).run(clean, start_date || '', end_date || '')
  res.json({ id: info.lastInsertRowid })
})

router.post('/seasons/:id/archive', requireLevel(4), (req, res) => {
  const s = db.prepare('SELECT * FROM seasons WHERE id = ?').get(req.params.id)
  if (!s) return res.status(404).json({ error: '赛季不存在' })
  const tx = db.transaction(() => {
    db.prepare("UPDATE seasons SET archived = 1, active = 0 WHERE id = ?").run(s.id)
    if (getSetting('season_end_clear_available', '0') === '1') {
      db.prepare('UPDATE members SET available_merit = 0').run()
    }
    // reset total? keep total as history - create new season concept
  })
  tx()
  logOp(req.user.id, '归档赛季', s.name)
  res.json({ ok: true })
})

router.post('/users', requireLevel(4), (req, res) => {
  const { username, password, role = '成员', member_id } = req.body || {}
  const err = validate([validName(username, '账号', 20)])
  if (err) return res.status(400).json({ error: err })
  if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' })
  // 盟主只能由 root 创建（或通过邀请码注册）
  if (role === '盟主' && req.user.role !== 'root') {
    return res.status(403).json({ error: '只有 root 可以创建盟主账号，请使用邀请码注册' })
  }
  if (role === 'root') {
    return res.status(403).json({ error: '不能通过此接口创建 root 账号' })
  }
  const cleanUser = cleanName(username, 20)
  const hash = bcrypt.hashSync(String(password), 10)
  const allianceId = req.user.alliance_id || null
  try {
    const info = db.prepare('INSERT INTO users (username, password_hash, member_id, role, alliance_id) VALUES (?, ?, ?, ?, ?)')
      .run(cleanUser, hash, member_id || null, role, role === '盟主' ? null : allianceId)
    res.json({ id: info.lastInsertRowid })
  } catch (e) {
    res.status(400).json({ error: '用户名已存在' })
  }
})

router.put('/users/:id', requireLevel(4), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
  if (!u) return res.status(404).json({ error: '用户不存在' })
  const { role, member_id, newPassword } = req.body || {}
  const allowedRoles = ['盟主', '副盟', '团长', '成员']
  const nextRole = role !== undefined ? role : u.role
  if (!allowedRoles.includes(nextRole)) return res.status(400).json({ error: '角色无效' })

  // 盟主角色只能由 root 设置
  if (nextRole === '盟主' && req.user.role !== 'root') {
    return res.status(403).json({ error: '只有 root 可以设置盟主角色' })
  }
  // 不能修改 root 用户的角色
  if (u.role === 'root' && req.user.role !== 'root') {
    return res.status(403).json({ error: '无权修改 root 用户' })
  }

  if (Number(u.id) === Number(req.user.id) && nextRole !== '盟主' && req.user.role !== 'root') {
    return res.status(400).json({ error: '不能降低自己的盟主权限，请让其他盟主操作' })
  }

  const nextMemberId = member_id === undefined || member_id === '' || member_id === null
    ? null
    : Number(member_id)

  db.prepare('UPDATE users SET role = ?, member_id = ? WHERE id = ?')
    .run(nextRole, nextMemberId, u.id)

  if (newPassword) {
    if (String(newPassword).length < 6) return res.status(400).json({ error: '新密码至少 6 位' })
    const hash = bcrypt.hashSync(String(newPassword), 10)
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, u.id)
  }

  logOp(req.user.id, '修改账号', `user=${u.username} role=${nextRole}`)
  res.json({ ok: true })
})

router.post('/users/:id/reset-password', requireLevel(4), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
  if (!u) return res.status(404).json({ error: '用户不存在' })
  const { newPassword } = req.body || {}
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' })
  }
  const hash = bcrypt.hashSync(String(newPassword), 10)
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, u.id)
  logOp(req.user.id, '重置账号密码', `user=${u.username}`)
  res.json({ ok: true })
})

router.delete('/users/:id', requireLevel(4), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
  if (!u) return res.status(404).json({ error: '用户不存在' })
  if (Number(u.id) === Number(req.user.id)) {
    return res.status(400).json({ error: '不能删除当前登录账号' })
  }
  if (u.role === 'root') {
    return res.status(400).json({ error: '不能删除 root 账号' })
  }
  if (u.role === '盟主' && req.user.role !== 'root') {
    return res.status(403).json({ error: '只有 root 可以删除盟主账号' })
  }
  if (u.role === '盟主') {
    const masterCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = '盟主'").get().c
    if (masterCount <= 1) return res.status(400).json({ error: '至少保留一个盟主账号' })
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id)
  logOp(req.user.id, '删除账号', `user=${u.username}`)
  res.json({ ok: true })
})

// ===== root 专属：邀请码管理 =====
router.get('/invite-codes', requireLevel(5), (req, res) => {
  const rows = db.prepare(`
    SELECT ic.*,
           cu.username as creator_name,
           uu.username as used_by_name
    FROM invite_codes ic
    LEFT JOIN users cu ON cu.id = ic.created_by
    LEFT JOIN users uu ON uu.id = ic.used_by
    ORDER BY ic.created_at DESC
  `).all()
  res.json(rows)
})

router.post('/invite-codes', requireLevel(5), (req, res) => {
  const { alliance_name = '', max_uses = 1, expires_days = 0 } = req.body || {}
  const crypto = require('crypto')
  const code = crypto.randomBytes(6).toString('base64url')
  let expiresAt = null
  if (expires_days > 0) {
    const d = new Date()
    d.setDate(d.getDate() + expires_days)
    expiresAt = d.toISOString().slice(0, 19).replace('T', ' ')
  }
  const info = db.prepare(`
    INSERT INTO invite_codes (code, alliance_name, created_by, max_uses, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(code, alliance_name, req.user.id, max_uses, expiresAt)
  logOp(req.user.id, '创建邀请码', code)
  res.json({ id: info.lastInsertRowid, code })
})

router.delete('/invite-codes/:id', requireLevel(5), (req, res) => {
  db.prepare('DELETE FROM invite_codes WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// ===== root 专属：同盟管理 =====
router.get('/alliances', requireLevel(5), (req, res) => {
  const rows = db.prepare(`
    SELECT a.*,
           u.username as owner_username,
           (SELECT COUNT(*) FROM users WHERE alliance_id = a.id AND role != 'root') as user_count,
           (SELECT COUNT(*) FROM members WHERE alliance_id = a.id AND status != '离盟') as member_count
    FROM alliances a
    LEFT JOIN users u ON u.id = a.owner_user_id
    ORDER BY a.created_at DESC
  `).all()
  res.json(rows)
})

router.put('/alliances/:id', requireLevel(5), (req, res) => {
  const a = db.prepare('SELECT * FROM alliances WHERE id = ?').get(req.params.id)
  if (!a) return res.status(404).json({ error: '同盟不存在' })
  const { name, status, description } = req.body || {}
  if (name) {
    const exist = db.prepare('SELECT id FROM alliances WHERE name = ? AND id != ?').get(name, a.id)
    if (exist) return res.status(400).json({ error: '同盟名已存在' })
  }
  db.prepare('UPDATE alliances SET name = COALESCE(?, name), status = COALESCE(?, status), description = COALESCE(?, description) WHERE id = ?')
    .run(name || null, status || null, description !== undefined ? description : null, a.id)
  logOp(req.user.id, '修改同盟', `id=${a.id}`)
  res.json({ ok: true })
})

router.delete('/alliances/:id', requireLevel(5), (req, res) => {
  const a = db.prepare('SELECT * FROM alliances WHERE id = ?').get(req.params.id)
  if (!a) return res.status(404).json({ error: '同盟不存在' })
  const userCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE alliance_id = ? AND role != 'root'").get(a.id).c
  if (userCount > 0) return res.status(400).json({ error: '同盟下仍有用户，无法删除' })
  db.prepare('DELETE FROM alliances WHERE id = ?').run(a.id)
  logOp(req.user.id, '删除同盟', a.name)
  res.json({ ok: true })
})

router.post('/announcements', requireLevel(3), (req, res) => {
  const { title, content = '', type = '公告', pinned = 0 } = req.body || {}
  const err = validName(title, '标题', 100)
  if (err) return res.status(400).json({ error: err })
  const cleanTitle = cleanName(title, 100)
  const info = db.prepare(`
    INSERT INTO announcements (title, content, type, pinned, created_by) VALUES (?, ?, ?, ?, ?)
  `).run(cleanTitle, content, type, pinned ? 1 : 0, req.user.id)
  res.json({ id: info.lastInsertRowid })
})

router.delete('/announcements/:id', requireLevel(3), (req, res) => {
  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

router.get('/announcements', (req, res) => {
  const rows = db.prepare('SELECT * FROM announcements ORDER BY pinned DESC, created_at DESC LIMIT 30').all()
  res.json(rows)
})

router.get('/export/:kind', requireLevel(3), (req, res) => {
  const kind = req.params.kind
  const { dateFrom = '', dateTo = '' } = req.query
  let rows = []
  let sheetName = 'Sheet1'
  const dateCond = (col) => {
    const parts = []
    if (dateFrom) parts.push(`${col} >= '${dateFrom}'`)
    if (dateTo) parts.push(`${col} <= '${dateTo} 23:59:59'`)
    return parts.length ? ' AND ' + parts.join(' AND ') : ''
  }
  if (kind === 'members') {
    sheetName = '成员名单'
    rows = db.prepare(`
      SELECT m.id as ID, m.game_id as '游戏ID', m.nickname as '昵称', g.name as '所属团',
             m.role as '职位', m.status as '状态', m.power as '势力值',
             m.total_merit as '累计军功', m.available_merit as '可用军功', m.qq as 'QQ'
      FROM members m LEFT JOIN groups g ON g.id = m.group_id ORDER BY m.total_merit DESC
    `).all()
  } else if (kind === 'attendance') {
    sheetName = '考勤表'
    rows = db.prepare(`
      SELECT c.name as '城池', c.planned_time as '计划时间', m.nickname as '昵称', m.game_id as '游戏ID',
             CASE a.attended WHEN 1 THEN '出勤' ELSE '缺勤' END as '出勤',
             a.demolition as '拆迁', a.merit as '军功'
      FROM city_attendance a
      JOIN city_plans c ON c.id = a.city_id
      JOIN members m ON m.id = a.member_id
      WHERE 1=1${dateCond('c.planned_time')}
      ORDER BY c.planned_time DESC
    `).all()
  } else if (kind === 'merit') {
    sheetName = '军功流水'
    rows = db.prepare(`
      SELECT l.created_at as '时间', m.nickname as '昵称', m.game_id as '游戏ID',
             l.type as '类型', l.amount as '变动', l.balance_after as '可用余额',
             l.category as '分类', l.reason as '备注'
      FROM merit_logs l JOIN members m ON m.id = l.member_id
      WHERE 1=1${dateCond('l.created_at')}
      ORDER BY l.created_at DESC
    `).all()
  } else if (kind === 'orders') {
    sheetName = '兑换订单'
    rows = db.prepare(`
      SELECT o.order_no as '订单号', m.nickname as '昵称', m.game_id as '游戏ID',
             o.goods_name as '商品', o.goods_type as '类型', o.merit_cost as '消耗军功',
             o.status as '状态', o.created_at as '兑换时间', o.deliver_note as '发放备注'
      FROM orders o JOIN members m ON m.id = o.member_id
      WHERE 1=1${dateCond('o.created_at')}
      ORDER BY o.created_at DESC
    `).all()
  } else if (kind === 'report') {
    sheetName = '团报'
    rows = db.prepare(`
      SELECT g.name as '团', COUNT(m.id) as '人数',
             COALESCE(SUM(m.power),0) as '总势力',
             COALESCE(SUM(m.total_merit),0) as '总军功',
             ROUND(COALESCE(AVG(m.total_merit),0),1) as '平均军功'
      FROM groups g LEFT JOIN members m ON m.group_id = g.id AND m.status != '离盟'
      GROUP BY g.id
    `).all()
  } else {
    return res.status(400).json({ error: '未知导出类型' })
  }

  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.json_to_sheet(rows)
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(kind)}.xlsx"`)
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.send(buf)
})

module.exports = router
