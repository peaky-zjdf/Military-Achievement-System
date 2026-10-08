const express = require('express')
const { db, setSetting } = require('../db')
const { authRequired, requireLevel } = require('../middleware/auth')
const { allianceFilter, getAllianceId } = require('../middleware/alliance')

const router = express.Router()
router.use(authRequired)

function periodExpr(period, col = 'created_at') {
  if (period === 'week') return `${col} >= datetime('now','localtime','-6 days')`
  if (period === 'month') return `${col} >= datetime('now','localtime','-29 days')`
  return '1=1'
}

router.get('/', (req, res) => {
  const { type = 'merit', period = 'season', hideDormant = '1' } = req.query

  let memberFilter = "m.status != '离盟'"
  if (hideDormant === '1') memberFilter += " AND m.status != '休眠'"

  const af = allianceFilter(req, 'm')
  const allParams = [...af.params]

  let sql = ''
  if (type === 'merit') {
    sql = `
      SELECT m.id, m.nickname, m.game_id, m.role, m.status, m.power,
             m.total_merit, m.available_merit, g.name as group_name
      FROM members m LEFT JOIN groups g ON g.id = m.group_id
      WHERE ${memberFilter}${af.sql}
      ORDER BY m.total_merit DESC, m.available_merit DESC
    `
  } else if (type === 'war') {
    sql = `
      SELECT m.id, m.nickname, m.game_id, m.role, m.status, g.name as group_name,
             COALESCE(SUM(w.amount),0) as war_merit,
             COALESCE((SELECT SUM(amount) FROM merit_logs l WHERE l.member_id=m.id AND l.category='武勋' AND ${periodExpr(period)}),0) as merit_gained
      FROM members m
      LEFT JOIN groups g ON g.id = m.group_id
      LEFT JOIN war_merit_records w ON w.member_id = m.id AND ${periodExpr(period, 'w.created_at')}
      WHERE ${memberFilter}${af.sql}
      GROUP BY m.id
      ORDER BY war_merit DESC
    `
  } else if (type === 'demolition') {
    sql = `
      SELECT m.id, m.nickname, m.game_id, m.role, m.status, g.name as group_name,
             COALESCE(SUM(a.demolition),0) as demolition,
             SUM(CASE WHEN a.attended=1 THEN 1 ELSE 0 END) as attended
      FROM members m
      LEFT JOIN groups g ON g.id = m.group_id
      LEFT JOIN city_attendance a ON a.member_id = m.id AND ${periodExpr(period, 'a.created_at')}
      WHERE ${memberFilter}${af.sql}
      GROUP BY m.id
      ORDER BY demolition DESC
    `
  } else if (type === 'attendance') {
    sql = `
      SELECT m.id, m.nickname, m.game_id, m.role, m.status, g.name as group_name,
             COUNT(a.id) as total,
             SUM(CASE WHEN a.attended=1 THEN 1 ELSE 0 END) as attended,
             SUM(CASE WHEN a.attended=0 THEN 1 ELSE 0 END) as absent,
             CASE WHEN COUNT(a.id)=0 THEN 0
                  ELSE ROUND(100.0 * SUM(CASE WHEN a.attended=1 THEN 1 ELSE 0 END) / COUNT(a.id), 1)
             END as rate
      FROM members m
      LEFT JOIN groups g ON g.id = m.group_id
      LEFT JOIN city_attendance a ON a.member_id = m.id AND ${periodExpr(period, 'a.created_at')}
      WHERE ${memberFilter}${af.sql}
      GROUP BY m.id
      ORDER BY rate DESC, attended DESC
    `
  } else if (type === 'power') {
    sql = `
      SELECT m.id, m.nickname, m.game_id, m.role, m.status, m.power, g.name as group_name,
             COALESCE((SELECT SUM(delta) FROM power_records p WHERE p.member_id=m.id AND ${periodExpr(period, 'p.created_at')}),0) as power_delta
      FROM members m LEFT JOIN groups g ON g.id = m.group_id
      WHERE ${memberFilter}${af.sql}
      ORDER BY power_delta DESC, m.power DESC
    `
  } else if (type === 'pioneer') {
    sql = `
      SELECT m.id, m.nickname, m.game_id, m.role, m.status, m.power, g.name as group_name,
             COALESCE((SELECT power FROM power_records p WHERE p.member_id=m.id ORDER BY p.created_at DESC LIMIT 1), m.power) as latest_power,
             COALESCE((SELECT SUM(delta) FROM power_records p WHERE p.member_id=m.id),0) as total_growth
      FROM members m LEFT JOIN groups g ON g.id = m.group_id
      WHERE ${memberFilter}${af.sql}
      ORDER BY m.power DESC
    `
  } else {
    return res.status(400).json({ error: '未知榜单类型' })
  }

  res.json(db.prepare(sql).all(...allParams))
})

router.get('/alliance', (req, res) => {
  const aid = getAllianceId(req)
  const key = aid != null ? `alliance_rank_data_${aid}` : 'alliance_rank_data'
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key)
  let alliances = []
  try { alliances = row ? JSON.parse(row.value) : [] } catch (e) { alliances = [] }
  res.json(alliances)
})

router.post('/alliance', requireLevel(3), (req, res) => {
  const aid = getAllianceId(req)
  const key = aid != null ? `alliance_rank_data_${aid}` : 'alliance_rank_data'
  const list = Array.isArray(req.body?.list) ? req.body.list : []
  setSetting(key, JSON.stringify(list))
  res.json({ ok: true })
})

module.exports = router
