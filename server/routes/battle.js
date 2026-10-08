const express = require('express')
const { db, logOp } = require('../db')
const { authRequired, requireLevel } = require('../middleware/auth')
const { getRules, applyMerit, applyMeritIfNonZero } = require('../services/merit')
const { validId, validName, cleanName, validate } = require('../services/validate')
const { allianceFilter, allianceFilterViaMember, getAllianceIdForInsert } = require('../middleware/alliance')

const router = express.Router()
router.use(authRequired)

// === 同盟数据隔离: 确保 battles 表有 alliance_id 列 ===
try {
  db.prepare('ALTER TABLE battles ADD COLUMN alliance_id INTEGER').run()
} catch (_) { /* column already exists */ }

router.get('/', (req, res) => {
  const af = allianceFilter(req, 'b')
  const rows = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM battle_reports r WHERE r.battle_id=b.id) as report_count,
      (SELECT COALESCE(SUM(war_merit),0) FROM battle_reports r WHERE r.battle_id=b.id) as total_war_merit,
      (SELECT COALESCE(SUM(demolition),0) FROM battle_reports r WHERE r.battle_id=b.id) as total_demolition
    FROM battles b WHERE 1=1${af.sql} ORDER BY b.created_at DESC
  `).all(...af.params)
  res.json(rows)
})

router.get('/:id', (req, res) => {
  const af = allianceFilter(req, 'b')
  const b = db.prepare(`SELECT * FROM battles b WHERE b.id = ?${af.sql}`).get(req.params.id, ...af.params)
  if (!b) return res.status(404).json({ error: '战役不存在' })
  const afm = allianceFilterViaMember(req, 'r')
  const reports = db.prepare(`
    SELECT r.*, m.nickname, m.game_id, g.name as group_name
    FROM battle_reports r
    JOIN members m ON m.id = r.member_id
    LEFT JOIN groups g ON g.id = m.group_id
    ${afm.join}
    WHERE r.battle_id = ?${afm.where}
    ORDER BY r.war_merit DESC
  `).all(b.id, ...afm.params)
  res.json({ ...b, reports })
})

router.post('/', requireLevel(2), (req, res) => {
  const b = req.body || {}
  const err = validate([validName(b.name, '战役名称', 50)])
  if (err) return res.status(400).json({ error: err })
  const clean = cleanName(b.name, 50)
  const allianceId = getAllianceIdForInsert(req)
  const info = db.prepare(`
    INSERT INTO battles (name, coord_x, coord_y, start_time, end_time, vs_party, groups_text, note, created_by, alliance_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    clean, b.coord_x || 0, b.coord_y || 0, b.start_time || '', b.end_time || '',
    b.vs_party || '', b.groups_text || '', b.note || '', req.user.id, allianceId
  )
  logOp(req.user.id, '创建战役', b.name)
  res.json({ id: info.lastInsertRowid })
})

router.put('/:id', requireLevel(2), (req, res) => {
  const af = allianceFilter(req, 'b')
  const old = db.prepare(`SELECT * FROM battles b WHERE b.id = ?${af.sql}`).get(req.params.id, ...af.params)
  if (!old) return res.status(404).json({ error: '不存在' })
  const b = req.body || {}
  db.prepare(`
    UPDATE battles SET name=?, coord_x=?, coord_y=?, start_time=?, end_time=?, vs_party=?, groups_text=?, status=?, note=?
    WHERE id=?
  `).run(
    b.name ?? old.name, b.coord_x ?? old.coord_x, b.coord_y ?? old.coord_y,
    b.start_time ?? old.start_time, b.end_time ?? old.end_time, b.vs_party ?? old.vs_party,
    b.groups_text ?? old.groups_text, b.status ?? old.status, b.note ?? old.note, old.id
  )
  res.json({ ok: true })
})

router.post('/:id/reports', requireLevel(2), (req, res) => {
  const {
    member_id, war_merit = 0, demolition = 0, guard_minutes = 0,
    land_flips = 0, report_text = '', apply_merit = true,
  } = req.body || {}
  const err = validId(member_id, '成员ID')
  if (err) return res.status(400).json({ error: err })

  // 校验战役归属同盟
  const af = allianceFilter(req, 'b')
  const battle = db.prepare(`SELECT id FROM battles b WHERE b.id = ?${af.sql}`).get(req.params.id, ...af.params)
  if (!battle) return res.status(404).json({ error: '战役不存在' })

  // 团长仅本团 + 同盟过滤
  if (req.user.role === '团长') {
    const afMember = allianceFilter(req, 'members')
    const t = db.prepare(`SELECT group_id FROM members WHERE id = ?${afMember.sql}`).get(member_id, ...afMember.params)
    if (!t || t.group_id !== req.user.group_id) {
      return res.status(403).json({ error: '团长只能为本团成员录入' })
    }
  }

  const r = getRules()
  let awarded = 0
  if (apply_merit) {
    awarded = Math.round(
      Number(war_merit) * r.war_merit_per_merit +
      Number(demolition) * r.demolition_per_point +
      Number(land_flips) * r.land_flip_merit +
      Number(guard_minutes) * r.guard_minute_merit
    )
  }

  const prev = db.prepare('SELECT id, merit_awarded FROM battle_reports WHERE battle_id = ? AND member_id = ?')
    .get(req.params.id, member_id)

  const tx = db.transaction(() => {
    if (prev) {
      db.prepare(`
        UPDATE battle_reports SET war_merit=?, demolition=?, guard_minutes=?, land_flips=?,
          report_text=?, merit_awarded=? WHERE id=?
      `).run(war_merit, demolition, guard_minutes, land_flips, report_text, awarded, prev.id)
      const delta = awarded - (prev.merit_awarded || 0)
      if (delta !== 0) {
        applyMeritIfNonZero(member_id, delta, delta >= 0 ? '收入' : '扣减', '战场', '战役贡献修正', req.user.id, prev.id)
      }
      return { id: prev.id, merit: awarded }
    }
    const info = db.prepare(`
      INSERT INTO battle_reports (battle_id, member_id, war_merit, demolition, guard_minutes, land_flips, report_text, merit_awarded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.params.id, member_id, war_merit, demolition, guard_minutes, land_flips, report_text, awarded)
    if (awarded > 0) {
      applyMerit(member_id, awarded, '收入', '战场', '战役贡献', req.user.id, info.lastInsertRowid)
    }
    return { id: info.lastInsertRowid, merit: awarded }
  })

  try {
    const out = tx()
    res.json(out)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.delete('/:id', requireLevel(3), (req, res) => {
  // 校验战役归属同盟
  const af = allianceFilter(req, 'b')
  const battle = db.prepare(`SELECT id FROM battles b WHERE b.id = ?${af.sql}`).get(req.params.id, ...af.params)
  if (!battle) return res.status(404).json({ error: '战役不存在' })

  // 删除战役前回滚已发军功
  const reports = db.prepare('SELECT id, member_id, merit_awarded FROM battle_reports WHERE battle_id = ?').all(req.params.id)
  const tx = db.transaction(() => {
    for (const rep of reports) {
      applyMeritIfNonZero(rep.member_id, -(rep.merit_awarded || 0), '扣减', '战场', '删除战役回滚', req.user.id, rep.id)
    }
    db.prepare('DELETE FROM battles WHERE id = ?').run(req.params.id)
  })
  try {
    tx()
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

module.exports = router
