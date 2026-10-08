const express = require('express')
const { db } = require('../db')
const { authRequired } = require('../middleware/auth')
const { allianceFilter, getAllianceId } = require('../middleware/alliance')

const router = express.Router()
router.use(authRequired)

router.get('/', (req, res) => {
  const isAdmin = ['root', '盟主', '副盟'].includes(req.user.role)
  const isLeader = req.user.role === '团长'
  const aid = getAllianceId(req)

  if (!isAdmin && !isLeader) {
    // member personal dashboard
    const mid = req.user.member_id || 0
    const me = db.prepare('SELECT * FROM members WHERE id = ?').get(mid) || {}
    const afUpcoming = allianceFilter(req, 'city_plans')
    const upcoming = db.prepare(`
      SELECT * FROM city_plans
      WHERE status = '计划中' AND planned_time >= datetime('now','localtime')${afUpcoming.sql}
      ORDER BY planned_time ASC LIMIT 5
    `).all(...afUpcoming.params)
    const myPending = db.prepare(`
      SELECT COUNT(*) as c FROM orders WHERE member_id = ? AND status = '待审核'
    `).get(mid).c
    const recentLogs = db.prepare(`
      SELECT * FROM merit_logs WHERE member_id = ? ORDER BY created_at DESC LIMIT 10
    `).all(mid)
    const rankAf = allianceFilter(req, 'members')
    const myRank = db.prepare(`
      SELECT COUNT(*) + 1 as r FROM members WHERE total_merit > ? AND status != '离盟'${rankAf.sql}
    `).get(me.total_merit || 0, ...rankAf.params).r
    const annAf = allianceFilter(req, 'announcements')
    const announcements = db.prepare(`SELECT * FROM announcements WHERE 1=1${annAf.sql} ORDER BY pinned DESC, created_at DESC LIMIT 5`).all(...annAf.params)

    return res.json({
      role: 'member',
      profile: me,
      stats: {
        total_merit: me.total_merit || 0,
        available_merit: me.available_merit || 0,
        upcoming_city: upcoming.length,
        pending_orders: myPending,
        power: me.power || 0,
        rank: myRank,
      },
      upcoming,
      recentLogs,
      announcements,
    })
  }

  // alliance filter helpers for admin/leader overview
  const af = aid != null ? ` AND alliance_id = ${aid}` : ''
  const maf = aid != null ? ` AND m.alliance_id = ${aid}` : ''
  const wmaf = aid != null ? ` AND EXISTS (SELECT 1 FROM members _wm WHERE _wm.id = w.member_id AND _wm.alliance_id = ${aid})` : ''
  const amaf = aid != null ? ` AND EXISTS (SELECT 1 FROM members _am2 WHERE _am2.id = a.member_id AND _am2.alliance_id = ${aid})` : ''
  const oaf = aid != null ? ` AND EXISTS (SELECT 1 FROM members _om WHERE _om.id = o.member_id AND _om.alliance_id = ${aid})` : ''
  const apaf = '' // applications 通过公开页面提交，暂不按同盟过滤
  const cpaf = aid != null ? ` AND alliance_id = ${aid}` : ''
  const lmaf = aid != null ? ` AND EXISTS (SELECT 1 FROM members _lm WHERE _lm.id = l.member_id AND _lm.alliance_id = ${aid})` : ''

  const overview = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(total_merit),0) FROM members WHERE status != '离盟'${af}) as total_merit,
      (SELECT COALESCE(SUM(amount),0) FROM war_merit_records w WHERE w.created_at >= datetime('now','localtime','-6 days')${wmaf}) as week_war,
      (SELECT COUNT(*) FROM city_plans WHERE status='计划中'${cpaf}) as pending_cities,
      (SELECT COUNT(*) FROM orders o WHERE o.status='待审核'${oaf}) as pending_orders,
      (SELECT COUNT(*) FROM applications ap WHERE ap.status='待审核'${apaf}) as pending_apps,
      (SELECT COUNT(*) FROM members WHERE status != '离盟'${af}) as member_count,
      (SELECT COALESCE(SUM(power),0) FROM members WHERE status != '离盟'${af}) as total_power,
      (SELECT COUNT(*) FROM city_plans WHERE status='已完成'${cpaf}) as cities_done,
      (SELECT COUNT(*) FROM members WHERE status='活跃'${af}) as active_count,
      (SELECT COUNT(*) FROM members WHERE status='休战'${af}) as dormant_count,
      (SELECT COUNT(*) FROM members WHERE status='沦陷'${af}) as captured_count
  `).get()

  // 近7天零武勋成员（活跃但无记录）
  const idleMembers = db.prepare(`
    SELECT m.nickname, m.game_id, m.total_merit, m.power
    FROM members m
    WHERE m.status = '活跃'${maf}
      AND NOT EXISTS (
        SELECT 1 FROM war_merit_records w
        WHERE w.member_id = m.id AND w.created_at >= datetime('now','localtime','-6 days')
      )
    ORDER BY m.total_merit DESC
    LIMIT 10
  `).all()

  // 本周武勋 TOP
  const weekTop = db.prepare(`
    SELECT m.nickname, m.game_id, SUM(w.amount) as war, COUNT(*) as hits
    FROM war_merit_records w
    JOIN members m ON m.id = w.member_id
    WHERE w.created_at >= datetime('now','localtime','-6 days')${maf}
    GROUP BY m.id
    ORDER BY war DESC
    LIMIT 8
  `).all()

  // 打城出勤汇总
  const attendance = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN a.attended = 1 THEN 1 ELSE 0 END) as attended,
      COALESCE(SUM(a.demolition), 0) as demolition
    FROM city_attendance a
    JOIN city_plans c ON c.id = a.city_id
    WHERE c.planned_time >= datetime('now','localtime','-13 days')${amaf}
  `).get()
  const attRate = attendance.total
    ? Math.round((attendance.attended / attendance.total) * 100)
    : null

  // 各团本周出勤
  const groupAttendance = db.prepare(`
    SELECT g.name,
           COUNT(a.id) as total,
           SUM(CASE WHEN a.attended = 1 THEN 1 ELSE 0 END) as attended
    FROM groups g
    LEFT JOIN members m ON m.group_id = g.id AND m.status != '离盟'${maf}
    LEFT JOIN city_attendance a ON a.member_id = m.id
      AND a.city_id IN (SELECT id FROM city_plans WHERE planned_time >= datetime('now','localtime','-13 days')${cpaf})
    GROUP BY g.id
  `).all()

  const insights = {
    idleMembers,
    weekTop,
    attRate,
    attendanceTotal: attendance.total || 0,
    attendanceAttended: attendance.attended || 0,
    demolitionTotal: attendance.demolition || 0,
    groupAttendance: groupAttendance.map((g) => ({
      name: g.name,
      total: g.total || 0,
      attended: g.attended || 0,
      rate: g.total ? Math.round((g.attended / g.total) * 100) : null,
    })),
  }

  const top5 = db.prepare(`
    SELECT id, nickname, game_id, total_merit, available_merit, power, status
    FROM members WHERE status != '离盟'${af} ORDER BY total_merit DESC LIMIT 5
  `).all()

  const groupMerits = db.prepare(`
    SELECT g.name, COALESCE(SUM(m.total_merit),0) as merit, COUNT(m.id) as cnt
    FROM groups g LEFT JOIN members m ON m.group_id = g.id AND m.status != '离盟'${maf}
    GROUP BY g.id ORDER BY merit DESC
  `).all()

  const recentLogs = db.prepare(`
    SELECT l.created_at, l.type, l.amount, l.category, l.reason, m.nickname
    FROM merit_logs l JOIN members m ON m.id = l.member_id
    WHERE 1=1${lmaf}
    ORDER BY l.created_at DESC, l.id DESC LIMIT 12
  `).all()

  const upcoming = db.prepare(`
    SELECT * FROM city_plans WHERE status='计划中'${cpaf} ORDER BY planned_time ASC LIMIT 5
  `).all()

  const applications = db.prepare(`
    SELECT * FROM applications WHERE status='待审核'${apaf} ORDER BY created_at DESC LIMIT 5
  `).all()

  const warTrend = db.prepare(`
    SELECT date(w.created_at) as day, SUM(w.amount) as total
    FROM war_merit_records w
    WHERE w.created_at >= datetime('now','localtime','-13 days')${wmaf}
    GROUP BY date(w.created_at) ORDER BY day
  `).all()

  const annAf = allianceFilter(req, 'announcements')
  const announcements = db.prepare(`SELECT * FROM announcements WHERE 1=1${annAf.sql} ORDER BY pinned DESC, created_at DESC LIMIT 5`).all(...annAf.params)

  res.json({
    role: isAdmin ? 'admin' : 'leader',
    overview,
    top5,
    groupMerits,
    recentLogs,
    upcoming,
    applications,
    warTrend,
    announcements,
    insights,
  })
})

module.exports = router
