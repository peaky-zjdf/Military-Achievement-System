const express = require('express')
const { db } = require('../db')
const { authRequired, requireLevel } = require('../middleware/auth')
const { allianceFilter, getAllianceId } = require('../middleware/alliance')

const router = express.Router()
router.use(authRequired)

router.get('/', (req, res) => {
  const period = req.query.period || 'week'
  const cond = period === 'week'
    ? `l.created_at >= datetime('now','localtime','-6 days')`
    : '1=1'

  const aid = getAllianceId(req)
  const af = aid != null ? ` AND alliance_id = ${aid}` : ''
  const wmaf = aid != null ? ` AND EXISTS (SELECT 1 FROM members _wm WHERE _wm.id = w.member_id AND _wm.alliance_id = ${aid})` : ''
  const amaf = aid != null ? ` AND EXISTS (SELECT 1 FROM members _am2 WHERE _am2.id = a.member_id AND _am2.alliance_id = ${aid})` : ''
  const lmaf = aid != null ? ` AND EXISTS (SELECT 1 FROM members _lm WHERE _lm.id = l.member_id AND _lm.alliance_id = ${aid})` : ''
  const cpaf = aid != null ? ` AND alliance_id = ${aid}` : ''

  const overview = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM members WHERE status != '离盟'${af}) as member_count,
      (SELECT COALESCE(SUM(power),0) FROM members WHERE status != '离盟'${af}) as total_power,
      (SELECT COALESCE(SUM(amount),0) FROM war_merit_records w WHERE ${period === 'week' ? "w.created_at >= datetime('now','localtime','-6 days')" : '1=1'}${wmaf}) as total_war,
      (SELECT COALESCE(SUM(demolition),0) FROM city_attendance a WHERE 1=1${amaf}) as total_demolition,
      (SELECT COUNT(*) FROM city_plans WHERE status='已完成'${cpaf}) as total_cities,
      (SELECT COALESCE(SUM(CASE WHEN a.attended=1 THEN 1 ELSE 0 END)*100.0 / NULLIF(COUNT(*),0), 0) FROM city_attendance a WHERE 1=1${amaf}) as attendance_rate,
      (SELECT COALESCE(SUM(total_merit),0) FROM members WHERE status != '离盟'${af}) as total_merit,
      (SELECT COALESCE(SUM(CASE WHEN type='收入' THEN amount ELSE 0 END),0) FROM merit_logs l WHERE ${cond}${lmaf}) as period_income
  `).get()

  const maf = aid != null ? ` AND m.alliance_id = ${aid}` : ''
  const wmaf2 = aid != null ? ` AND EXISTS (SELECT 1 FROM members _wm2 WHERE _wm2.id = w.member_id AND _wm2.alliance_id = ${aid})` : ''
  const amaf2 = aid != null ? ` AND EXISTS (SELECT 1 FROM members _am3 WHERE _am3.id = a.member_id AND _am3.alliance_id = ${aid})` : ''

  const byGroup = db.prepare(`
    SELECT g.id, g.name,
      COUNT(m.id) as member_count,
      COALESCE(SUM(m.power),0) as total_power,
      COALESCE(SUM(m.total_merit),0) as total_merit,
      COALESCE(AVG(m.total_merit),0) as avg_merit,
      COALESCE((SELECT SUM(w.amount) FROM war_merit_records w JOIN members mm ON mm.id=w.member_id
        WHERE mm.group_id = g.id ${period === 'week' ? "AND w.created_at >= datetime('now','localtime','-6 days')" : ''}${aid != null ? ` AND mm.alliance_id = ${aid}` : ''}),0) as war_merit,
      COALESCE((SELECT SUM(a.demolition) FROM city_attendance a JOIN members mm ON mm.id=a.member_id WHERE mm.group_id = g.id${aid != null ? ` AND mm.alliance_id = ${aid}` : ''}),0) as demolition,
      (SELECT COUNT(DISTINCT a.city_id) FROM city_attendance a JOIN members mm ON mm.id=a.member_id
        WHERE mm.group_id = g.id AND a.attended=1${aid != null ? ` AND mm.alliance_id = ${aid}` : ''}) as city_attended,
      (SELECT COALESCE(SUM(a.merit),0) FROM city_attendance a JOIN members mm ON mm.id=a.member_id
        WHERE mm.group_id = g.id${aid != null ? ` AND mm.alliance_id = ${aid}` : ''}) as city_merit
    FROM groups g
    LEFT JOIN members m ON m.group_id = g.id AND m.status != '离盟'${maf}
    GROUP BY g.id
    ORDER BY total_merit DESC
  `).all()

  // team leader sees only own group details, but still can see overview
  if (req.user.role === '团长') {
    // keep all for comparison (group-level is ok), hide others' personal detail if needed
  }

  res.json({ period, overview, byGroup })
})

router.get('/export-data', requireLevel(3), (req, res) => {
  const aid = getAllianceId(req)
  const af = aid != null ? ` AND m.alliance_id = ${aid}` : ''
  const aaf = aid != null ? ` AND EXISTS (SELECT 1 FROM members _em WHERE _em.id = a.member_id AND _em.alliance_id = ${aid})` : ''
  const laf = aid != null ? ` AND EXISTS (SELECT 1 FROM members _lm2 WHERE _lm2.id = l.member_id AND _lm2.alliance_id = ${aid})` : ''
  const cpaf = aid != null ? ` AND c.alliance_id = ${aid}` : ''

  const members = db.prepare(`
    SELECT m.id, m.game_id, m.nickname, g.name as group_name, m.role, m.status,
           m.power, m.total_merit, m.available_merit, m.qq
    FROM members m LEFT JOIN groups g ON g.id = m.group_id
    WHERE 1=1${af}
    ORDER BY m.total_merit DESC
  `).all()
  const attendance = db.prepare(`
    SELECT c.name as city_name, c.planned_time, m.nickname, m.game_id,
           a.attended, a.demolition, a.merit
    FROM city_attendance a
    JOIN city_plans c ON c.id = a.city_id
    JOIN members m ON m.id = a.member_id
    WHERE 1=1${aaf}
    ORDER BY c.planned_time DESC
  `).all()
  const meritLogs = db.prepare(`
    SELECT l.created_at, m.nickname, m.game_id, l.type, l.amount, l.balance_after, l.category, l.reason
    FROM merit_logs l JOIN members m ON m.id = l.member_id
    WHERE 1=1${laf}
    ORDER BY l.created_at DESC
  `).all()
  res.json({ members, attendance, meritLogs })
})

module.exports = router
