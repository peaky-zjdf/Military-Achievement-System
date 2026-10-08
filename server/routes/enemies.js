const express = require('express')
const { db, logOp } = require('../db')
const { authRequired, requireLevel } = require('../middleware/auth')
const { validName, cleanName, validate } = require('../services/validate')
const { allianceFilter, getAllianceIdForInsert } = require('../middleware/alliance')

const router = express.Router()
router.use(authRequired)

/** 列表：可搜玩家/同盟 */
router.get('/', (req, res) => {
  const { q = '', alliance = '', threat = '' } = req.query
  const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20))
  let sql = `
    FROM enemies e
    WHERE 1=1
  `
  const params = []
  // 同盟数据隔离
  const af = allianceFilter(req, 'e')
  if (af.sql) { sql += af.sql; params.push(...af.params) }
  if (q) {
    sql += ' AND (e.nickname LIKE ? OR e.alliance LIKE ? OR e.note LIKE ?)'
    params.push(`%${q}%`, `%${q}%`, `%${q}%`)
  }
  if (alliance) {
    sql += ' AND e.alliance LIKE ?'
    params.push(`%${alliance}%`)
  }
  if (threat) {
    sql += ' AND e.threat_level = ?'
    params.push(threat)
  }
  let selectSql = `SELECT e.*,
      (SELECT COUNT(*) FROM enemy_generals g WHERE g.enemy_id = e.id) as general_count,
      (SELECT COALESCE(SUM(troops),0) FROM enemy_generals g WHERE g.enemy_id = e.id) as total_troops,
      (SELECT COALESCE(MAX(level),0) FROM enemy_generals g WHERE g.enemy_id = e.id) as max_level,
      (SELECT COALESCE(MAX(red_stars),0) FROM enemy_generals g WHERE g.enemy_id = e.id) as max_red ${sql}`
  selectSql += ' ORDER BY e.updated_at DESC, e.id DESC'
  if (!hasPagination) {
    const rows = db.prepare(selectSql).all(...params)
    return res.json(rows)
  }
  const total = db.prepare(`SELECT COUNT(*) as total ${sql}`).get(...params).total
  const data = db.prepare(`${selectSql} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize)
  const totalPages = Math.ceil(total / pageSize)
  res.json({ data, total, page, pageSize, totalPages })
})

router.get('/alliances', (req, res) => {
  const af = allianceFilter(req, 'enemies')
  const rows = db.prepare(`
    SELECT alliance, COUNT(*) as c FROM enemies
    WHERE alliance != ''${af.sql} GROUP BY alliance ORDER BY c DESC LIMIT 50
  `).all(...af.params)
  res.json(rows)
})

router.get('/:id', (req, res) => {
  const af = allianceFilter(req, 'e')
  const e = db.prepare(`SELECT * FROM enemies e WHERE e.id = ?${af.sql}`).get(req.params.id, ...af.params)
  if (!e) return res.status(404).json({ error: '记录不存在' })
  const generals = db.prepare(`
    SELECT * FROM enemy_generals WHERE enemy_id = ? ORDER BY
      CASE slot WHEN '大营' THEN 1 WHEN '中军' THEN 2 WHEN '前锋' THEN 3 ELSE 9 END,
      id
  `).all(e.id)
  res.json({ ...e, generals })
})

/** 新建玩家 + 可选武将 */
router.post('/', requireLevel(2), (req, res) => {
  const b = req.body || {}
  const err = validName(b.nickname, '玩家姓名', 20)
  if (err) return res.status(400).json({ error: err })
  const nickname = cleanName(b.nickname, 20)
  const allianceId = getAllianceIdForInsert(req)
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO enemies (nickname, alliance, server, threat_level, note, last_seen, created_by, alliance_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nickname,
      b.alliance || '',
      b.server || '',
      b.threat_level || '中',
      b.note || '',
      b.last_seen || new Date().toISOString().slice(0, 19).replace('T', ' '),
      req.user.id,
      allianceId
    )
    const enemyId = info.lastInsertRowid
    const generals = Array.isArray(b.generals) ? b.generals : []
    for (const g of generals) {
      if (!g?.name) continue
      db.prepare(`
        INSERT INTO enemy_generals (enemy_id, slot, name, level, troops, red_stars, treasures, skills, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        enemyId,
        g.slot || '',
        g.name,
        Number(g.level) || 0,
        Number(g.troops) || 0,
        Number(g.red_stars) || 0,
        g.treasures || '',
        g.skills || '',
        g.note || ''
      )
    }
    return enemyId
  })
  const id = tx()
  logOp(req.user.id, '新增敌对情报', nickname)
  res.json({ id })
})

router.put('/:id', requireLevel(2), (req, res) => {
  const af = allianceFilter(req, 'e')
  const e = db.prepare(`SELECT * FROM enemies e WHERE e.id = ?${af.sql}`).get(req.params.id, ...af.params)
  if (!e) return res.status(404).json({ error: '记录不存在' })
  const b = req.body || {}
  db.prepare(`
    UPDATE enemies SET nickname=?, alliance=?, server=?, threat_level=?, note=?, last_seen=?,
      updated_at=datetime('now','localtime')
    WHERE id=?
  `).run(
    b.nickname ?? e.nickname,
    b.alliance ?? e.alliance,
    b.server ?? e.server,
    b.threat_level ?? e.threat_level,
    b.note ?? e.note,
    b.last_seen ?? e.last_seen,
    e.id
  )
  logOp(req.user.id, '编辑敌对情报', String(e.id))
  res.json({ ok: true })
})

router.delete('/:id', requireLevel(2), (req, res) => {
  const af = allianceFilter(req, 'enemies')
  db.prepare(`DELETE FROM enemies WHERE id = ?${af.sql}`).run(req.params.id, ...af.params)
  res.json({ ok: true })
})

/** 新增/更新武将 */
router.post('/:id/generals', requireLevel(2), (req, res) => {
  const af = allianceFilter(req, 'e')
  const e = db.prepare(`SELECT id FROM enemies e WHERE e.id = ?${af.sql}`).get(req.params.id, ...af.params)
  if (!e) return res.status(404).json({ error: '玩家不存在' })
  const b = req.body || {}
  if (!b.name) return res.status(400).json({ error: '武将名称必填' })
  if (b.id) {
    const g = db.prepare('SELECT * FROM enemy_generals WHERE id = ? AND enemy_id = ?').get(b.id, e.id)
    if (!g) return res.status(404).json({ error: '武将不存在' })
    db.prepare(`
      UPDATE enemy_generals SET slot=?, name=?, level=?, troops=?, red_stars=?, treasures=?, skills=?, note=?,
        updated_at=datetime('now','localtime')
      WHERE id=?
    `).run(
      b.slot ?? g.slot, b.name ?? g.name,
      Number(b.level ?? g.level) || 0,
      Number(b.troops ?? g.troops) || 0,
      Number(b.red_stars ?? g.red_stars) || 0,
      b.treasures ?? g.treasures,
      b.skills ?? g.skills,
      b.note ?? g.note,
      g.id
    )
    return res.json({ id: g.id })
  }
  const info = db.prepare(`
    INSERT INTO enemy_generals (enemy_id, slot, name, level, troops, red_stars, treasures, skills, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    e.id, b.slot || '', b.name,
    Number(b.level) || 0, Number(b.troops) || 0, Number(b.red_stars) || 0,
    b.treasures || '', b.skills || '', b.note || ''
  )
  db.prepare("UPDATE enemies SET updated_at=datetime('now','localtime') WHERE id=?").run(e.id)
  res.json({ id: info.lastInsertRowid })
})

router.delete('/:id/generals/:gid', requireLevel(2), (req, res) => {
  const af = allianceFilter(req, 'e')
  const e = db.prepare(`SELECT id FROM enemies e WHERE e.id = ?${af.sql}`).get(req.params.id, ...af.params)
  if (!e) return res.status(404).json({ error: '记录不存在' })
  db.prepare('DELETE FROM enemy_generals WHERE id = ? AND enemy_id = ?').run(req.params.gid, e.id)
  res.json({ ok: true })
})

/**
 * 从战报文本粗解析敌方阵容（人工可再改）
 * body: { text, player_name?, alliance? }
 */
router.post('/parse-report', requireLevel(2), (req, res) => {
  const text = String(req.body?.text || '')
  if (!text.trim()) return res.status(400).json({ error: '请粘贴战报文本' })
  // 右侧敌方：Lv.xx / 兵力N / 红将星级较难，先抓 Lv 与 兵力
  const levels = [...text.matchAll(/Lv\.?\s*(\d{1,2})/gi)].map((m) => Number(m[1]))
  const troops = [...text.matchAll(/兵力\s*(\d+)/g)].map((m) => Number(m[1]))
  const reds = [...text.matchAll(/[★☆]{3,5}/g)].map((m) => (m[0].match(/★/g) || []).length)
  const names = [...text.matchAll(/([一-龥]{2,6})/g)]
    .map((m) => m[1])
    .filter((s) => !/武勋|拆迁|兵力|战报|胜利|失败|战败|战胜|大营|中军|前锋|等级|士气|战法/.test(s))

  const generals = []
  for (let i = 0; i < Math.min(3, Math.max(levels.length, troops.length)); i++) {
    generals.push({
      slot: ['大营', '中军', '前锋'][i] || '',
      name: names[i + 1] || names[i] || '',
      level: levels[i] || 0,
      troops: troops[i + 3] || troops[i] || 0, // 右侧兵力常在后半
      red_stars: reds[i + 1] || reds[i] || 0,
      treasures: '',
      skills: '',
    })
  }
  res.json({
    player_name: req.body?.player_name || '',
    alliance: req.body?.alliance || '',
    generals,
    hint: '自动解析仅供参考，请对照截图修改武将/等级/兵力/宝物/红将',
  })
})

module.exports = router
