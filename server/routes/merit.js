const express = require('express')
const { db, logOp, getSetting, setSetting } = require('../db')
const { authRequired, requireLevel, canTouchMember } = require('../middleware/auth')
const { applyMerit, calcWarMerit, getRules } = require('../services/merit')
const { validId, validPositive, validNonZero, validNumber, validate } = require('../services/validate')
const { allianceFilterViaMember } = require('../middleware/alliance')

const router = express.Router()
router.use(authRequired)

// list war merit records
router.get('/war', (req, res) => {
  const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20))
  const afWar = allianceFilterViaMember(req, 'w')
  let sql = `
    FROM war_merit_records w
    JOIN members m ON m.id = w.member_id
    LEFT JOIN groups g ON g.id = m.group_id
    ${afWar.join}
    WHERE 1=1${afWar.where}
  `
  const params = [...afWar.params]
  if (req.user.role === '成员') {
    sql += ' AND w.member_id = ?'
    params.push(req.user.member_id || 0)
  } else if (req.user.role === '团长') {
    sql += ' AND (m.group_id = ? OR w.member_id = ?)'
    params.push(req.user.group_id || 0, req.user.member_id || 0)
  }
  let selectSql = `SELECT w.*, m.nickname, m.game_id, g.name as group_name ${sql}`
  selectSql += ' ORDER BY w.created_at DESC, w.id DESC'
  if (!hasPagination) {
    const rows = db.prepare(selectSql).all(...params)
    return res.json(rows)
  }
  const total = db.prepare(`SELECT COUNT(*) as total ${sql}`).get(...params).total
  const data = db.prepare(`${selectSql} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize)
  const totalPages = Math.ceil(total / pageSize)
  res.json({ data, total, page, pageSize, totalPages })
})

router.post('/war', requireLevel(2), (req, res) => {
  const { member_id, amount, type = '野战', source = '手动录入', note = '' } = req.body || {}
  const err = validate([validId(member_id, '成员ID'), validPositive(amount, '武勋')])
  if (err) return res.status(400).json({ error: err })
  if (!canTouchMember(req, member_id)) return res.status(403).json({ error: '团长只能为本团成员录入' })
  const amountNum = Number(amount)

  // 征程武勋去重：同一成员 + 相近金额（±10%）+ 来源为征程截图 的24小时内记录，警告可能重复
  if (source !== '征程截图') {
    const low = Math.floor(amountNum * 0.9)
    const high = Math.ceil(amountNum * 1.1)
    const dup = db.prepare(`
      SELECT id, amount, created_at FROM war_merit_records
      WHERE member_id = ? AND source = '征程截图' AND amount BETWEEN ? AND ?
        AND created_at >= datetime('now','localtime','-24 hours')
      LIMIT 1
    `).get(member_id, low, high)
    if (dup) {
      return res.status(409).json({
        error: `检测到该成员24小时内已有相近金额的征程武勋记录（${dup.amount}），可能为重复录入。如确认无误，请通过征程入口提交。`,
        duplicate_id: dup.id,
      })
    }
  }

  const merit = calcWarMerit(amountNum, type)
  db.prepare(`
    INSERT INTO war_merit_records (member_id, amount, type, source, note, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(member_id, amountNum, type, source, note, req.user.id)

  applyMerit(member_id, merit, '收入', '武勋', `${type}武勋${amountNum}`, req.user.id)
  logOp(req.user.id, '录入武勋', `member=${member_id} amount=${amountNum}`)
  res.json({ ok: true, merit })
})

router.post('/war/batch', requireLevel(2), (req, res) => {
  const { text = '', type = '野战' } = req.body || {}
  const afAid = req.user.role === 'root' ? null : (req.user.alliance_id || null)
  // Support lines like: 100000 武勋 or 昵称 100000
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  let ok = 0
  const errors = []
  const tx = db.transaction(() => {
    for (const line of lines) {
      const parts = line.split(/[\s,，\t]+/).filter(Boolean)
      let member = null
      let amount = 0
      if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1])) {
        amount = Number(parts[parts.length - 1])
        const key = parts.slice(0, -1).join('')
        member = afAid
          ? db.prepare('SELECT * FROM members WHERE (nickname = ? OR game_id = ?) AND alliance_id = ?').get(key, key, afAid)
          : db.prepare('SELECT * FROM members WHERE nickname = ? OR game_id = ?').get(key, key)
        if (!member && parts.length >= 2) {
          member = afAid
            ? db.prepare('SELECT * FROM members WHERE (game_id = ? OR nickname = ?) AND alliance_id = ?').get(parts[0], parts[0], afAid)
            : db.prepare('SELECT * FROM members WHERE game_id = ? OR nickname = ?').get(parts[0], parts[0])
          if (member && /^\d+$/.test(parts[1])) amount = Number(parts[1])
        }
      } else if (parts.length === 1 && /^\d+$/.test(parts[0]) && req.user.member_id) {
        // only amount -> current user
        amount = Number(parts[0])
        member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.user.member_id)
      }
      if (!member || !amount) {
        errors.push(`无法解析: ${line}`)
        continue
      }
      const merit = calcWarMerit(amount, type)
      db.prepare(`
        INSERT INTO war_merit_records (member_id, amount, type, source, note, recorded_by)
        VALUES (?, ?, ?, '批量粘贴', '', ?)
      `).run(member.id, amount, type, req.user.id)
      applyMerit(member.id, merit, '收入', '武勋', `${type}武勋${amount}`, req.user.id)
      ok++
    }
  })
  try {
    tx()
  } catch (e) {
    return res.status(500).json({ error: '批量录入失败' })
  }
  res.json({ ok, errors })
})

// power
router.get('/power', (req, res) => {
  const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20))
  const afPower = allianceFilterViaMember(req, 'p')
  let sql = `
    FROM power_records p
    JOIN members m ON m.id = p.member_id
    ${afPower.join}
    WHERE 1=1${afPower.where}
  `
  const params = [...afPower.params]
  let selectSql = `SELECT p.*, m.nickname, m.game_id ${sql} ORDER BY p.created_at DESC, p.id DESC`
  if (!hasPagination) {
    const rows = db.prepare(selectSql).all(...params)
    return res.json(rows)
  }
  const total = db.prepare(`SELECT COUNT(*) as total ${sql}`).get(...params).total
  const data = db.prepare(`${selectSql} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize)
  const totalPages = Math.ceil(total / pageSize)
  res.json({ data, total, page, pageSize, totalPages })
})

router.post('/power', requireLevel(2), (req, res) => {
  const { member_id, power, note = '' } = req.body || {}
  const err = validate([validId(member_id, '成员ID'), validNumber(power, '势力值')])
  if (err) return res.status(400).json({ error: err })
  const m = req.user.role === 'root'
    ? db.prepare('SELECT * FROM members WHERE id = ?').get(member_id)
    : db.prepare('SELECT * FROM members WHERE id = ? AND alliance_id = ?').get(member_id, req.user.alliance_id)
  if (!m) return res.status(404).json({ error: '成员不存在' })
  const p = Number(power)
  const delta = p - (m.power || 0)
  db.prepare('UPDATE members SET power = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(p, member_id)
  db.prepare('INSERT INTO power_records (member_id, power, delta, note) VALUES (?, ?, ?, ?)').run(member_id, p, delta, note)
  res.json({ ok: true, delta })
})

// manual merit +/- 
router.get('/adjust', requireLevel(2), (req, res) => {
  const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20))
  const where = "WHERE l.category NOT IN ('武勋', '打城', '缺勤', '商城兑换', '商城退还')"
  const params = []
  // 同盟数据隔离
  const afAdj = allianceFilterViaMember(req, 'l')
  let selectSql = `
    SELECT l.*, m.nickname, m.game_id
    FROM merit_logs l JOIN members m ON m.id = l.member_id
    ${afAdj.join}
    ${where}${afAdj.where}
    ORDER BY l.created_at DESC, l.id DESC
  `
  params.push(...afAdj.params)
  if (!hasPagination) {
    const rows = db.prepare(selectSql).all(...params)
    return res.json(rows)
  }
  const totalSql = `SELECT COUNT(*) as total FROM merit_logs l JOIN members m ON m.id = l.member_id ${afAdj.join} ${where}${afAdj.where}`
  const total = db.prepare(totalSql).get(...params).total
  const data = db.prepare(`${selectSql} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize)
  const totalPages = Math.ceil(total / pageSize)
  res.json({ data, total, page, pageSize, totalPages })
})

router.post('/adjust', requireLevel(2), (req, res) => {
  const { member_id, amount, reason = '', category = '奖惩' } = req.body || {}
  const err = validate([validId(member_id, '成员ID'), validNonZero(amount, '分值')])
  if (err) return res.status(400).json({ error: err })
  if (!canTouchMember(req, member_id)) return res.status(403).json({ error: '团长只能为本团成员加减分' })
  const amt = Number(amount)
  try {
    applyMerit(member_id, amt, amt > 0 ? '收入' : '扣减', category, reason, req.user.id)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  logOp(req.user.id, '军功加减分', `member=${member_id} ${amt} ${reason}`)
  res.json({ ok: true })
})

// all merit logs
router.get('/logs', (req, res) => {
  const { member_id = '', category = '' } = req.query
  const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20))
  const afLogs = allianceFilterViaMember(req, 'l')
  let sql = `
    FROM merit_logs l
    JOIN members m ON m.id = l.member_id
    LEFT JOIN groups g ON g.id = m.group_id
    ${afLogs.join}
    WHERE 1=1${afLogs.where}
  `
  const params = [...afLogs.params]
  if (req.user.role === '成员') {
    sql += ' AND l.member_id = ?'
    params.push(req.user.member_id || 0)
  } else if (req.user.role === '团长') {
    sql += ' AND (m.group_id = ? OR l.member_id = ?)'
    params.push(req.user.group_id || 0, req.user.member_id || 0)
  }
  if (member_id) {
    sql += ' AND l.member_id = ?'
    params.push(member_id)
  }
  if (category) {
    sql += ' AND l.category = ?'
    params.push(category)
  }
  let selectSql = `SELECT l.*, m.nickname, m.game_id, g.name as group_name ${sql}`
  selectSql += ' ORDER BY l.created_at DESC, l.id DESC'
  if (!hasPagination) {
    const rows = db.prepare(selectSql).all(...params)
    return res.json(rows)
  }
  const total = db.prepare(`SELECT COUNT(*) as total ${sql}`).get(...params).total
  const data = db.prepare(`${selectSql} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize)
  const totalPages = Math.ceil(total / pageSize)
  res.json({ data, total, page, pageSize, totalPages })
})

// rules
router.get('/rules', (req, res) => {
  res.json(getRules())
})

router.put('/rules', requireLevel(4), (req, res) => {
  const keys = [
    'war_merit_per_merit', 'demolition_per_point', 'attendance_merit', 'absent_penalty',
    'land_flip_merit', 'guard_minute_merit', 'scout_merit',
    'journey_war_per_point', 'journey_demolish_per_point', 'journey_kill_per_point',
    'journey_land_per_point', 'journey_city_kill_per_point', 'journey_source',
    'shop_enabled', 'shop_audit_virtual', 'shop_audit_physical', 'shop_monthly_limit',
    'season_end_clear_available',
  ]
  for (const k of keys) {
    if (req.body[k] !== undefined) setSetting(k, req.body[k])
  }
  logOp(req.user.id, '修改军功规则')
  res.json({ ok: true, rules: getRules() })
})

module.exports = router
