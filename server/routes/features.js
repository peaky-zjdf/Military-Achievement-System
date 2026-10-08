const express = require('express')
const { db, logOp } = require('../db')
const { authRequired, requireLevel } = require('../middleware/auth')
const { validId, validName, cleanName, validate } = require('../services/validate')

const router = express.Router()
router.use(authRequired)

// ===== 要塞管理 =====
router.get('/fortresses', (req, res) => {
  const rows = db.prepare('SELECT * FROM fortresses ORDER BY updated_at DESC').all()
  res.json(rows)
})

router.post('/fortresses', requireLevel(2), (req, res) => {
  const b = req.body || {}
  const err = validName(b.name, '要塞名称', 30)
  if (err) return res.status(400).json({ error: err })
  const clean = cleanName(b.name, 30)
  const info = db.prepare(`
    INSERT INTO fortresses (name, coord_x, coord_y, owner_name, level, troops, status, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(clean, b.coord_x||0, b.coord_y||0, b.owner_name||'', b.level||1, b.troops||0, b.status||'建设中', b.note||'')
  logOp(req.user.id, '新增要塞', clean)
  res.json({ id: info.lastInsertRowid })
})

router.put('/fortresses/:id', requireLevel(2), (req, res) => {
  const b = req.body || {}
  db.prepare(`
    UPDATE fortresses SET name=?, coord_x=?, coord_y=?, owner_name=?, level=?, troops=?, status=?, note=?, updated_at=datetime('now','localtime')
    WHERE id=?
  `).run(b.name, b.coord_x||0, b.coord_y||0, b.owner_name||'', b.level||1, b.troops||0, b.status||'建设中', b.note||'', req.params.id)
  res.json({ ok: true })
})

router.delete('/fortresses/:id', requireLevel(3), (req, res) => {
  db.prepare('DELETE FROM fortresses WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// ===== 开荒进度 =====
router.get('/pioneer', (req, res) => {
  const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20))
  const selectSql = `
    SELECT p.*, m.nickname, m.game_id
    FROM pioneer_records p JOIN members m ON m.id = p.member_id
    ORDER BY p.record_date DESC, p.created_at DESC
  `
  if (!hasPagination) {
    const rows = db.prepare(selectSql).all()
    return res.json(rows)
  }
  const total = db.prepare(`SELECT COUNT(*) as total FROM pioneer_records`).get().total
  const data = db.prepare(`${selectSql} LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize)
  const totalPages = Math.ceil(total / pageSize)
  res.json({ data, total, page, pageSize, totalPages })
})

router.post('/pioneer', requireLevel(2), (req, res) => {
  const b = req.body || {}
  const err = validId(b.member_id, '成员ID')
  if (err) return res.status(400).json({ error: err })
  const info = db.prepare(`
    INSERT INTO pioneer_records (member_id, record_date, land_level, land_count, power_before, power_after, note)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(b.member_id, b.record_date || new Date().toISOString().slice(0,10), b.land_level||0, b.land_count||0, b.power_before||0, b.power_after||0, b.note||'')
  res.json({ id: info.lastInsertRowid })
})

// ===== 赛季日历 =====
router.get('/season-events', (req, res) => {
  const rows = db.prepare('SELECT * FROM season_events ORDER BY event_date ASC').all()
  res.json(rows)
})

router.post('/season-events', requireLevel(2), (req, res) => {
  const b = req.body || {}
  const err = validate([validName(b.title, '标题', 50)])
  if (err) return res.status(400).json({ error: err })
  if (!b.event_date) return res.status(400).json({ error: '日期必填' })
  const cleanTitle = cleanName(b.title, 50)
  const info = db.prepare(`
    INSERT INTO season_events (title, event_type, event_date, end_date, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(cleanTitle, b.event_type||'普通', b.event_date, b.end_date||'', b.description||'')
  res.json({ id: info.lastInsertRowid })
})

router.put('/season-events/:id', requireLevel(2), (req, res) => {
  const b = req.body || {}
  db.prepare(`
    UPDATE season_events SET title=?, event_type=?, event_date=?, end_date=?, description=?, is_done=?
    WHERE id=?
  `).run(b.title, b.event_type||'普通', b.event_date, b.end_date||'', b.description||'', b.is_done?1:0, req.params.id)
  res.json({ ok: true })
})

router.delete('/season-events/:id', requireLevel(2), (req, res) => {
  db.prepare('DELETE FROM season_events WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// ===== 同盟科技 =====
router.get('/alliance-tech', (req, res) => {
  const rows = db.prepare('SELECT * FROM alliance_tech ORDER BY tech_type, tech_name').all()
  res.json(rows)
})

router.post('/alliance-tech', requireLevel(2), (req, res) => {
  const b = req.body || {}
  const err = validName(b.tech_name, '科技名称', 30)
  if (err) return res.status(400).json({ error: err })
  const clean = cleanName(b.tech_name, 30)
  const info = db.prepare(`
    INSERT INTO alliance_tech (tech_name, tech_type, level, max_level, contribution, target_contribution, status, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(clean, b.tech_type||'科技', b.level||0, b.max_level||10, b.contribution||0, b.target_contribution||0, b.status||'进行中', b.note||'')
  res.json({ id: info.lastInsertRowid })
})

router.put('/alliance-tech/:id', requireLevel(2), (req, res) => {
  const b = req.body || {}
  db.prepare(`
    UPDATE alliance_tech SET tech_name=?, tech_type=?, level=?, max_level=?, contribution=?, target_contribution=?, status=?, note=?, updated_at=datetime('now','localtime')
    WHERE id=?
  `).run(b.tech_name, b.tech_type||'科技', b.level||0, b.max_level||10, b.contribution||0, b.target_contribution||0, b.status||'进行中', b.note||'', req.params.id)
  res.json({ ok: true })
})

router.delete('/alliance-tech/:id', requireLevel(3), (req, res) => {
  db.prepare('DELETE FROM alliance_tech WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

// ===== 战报库 =====
router.get('/battle-reports', (req, res) => {
  const { q = '', result = '', member_id = '' } = req.query
  const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20))
  let sql = `
    FROM battle_report_lib br
    LEFT JOIN members m ON m.id = br.member_id
    WHERE 1=1
  `
  const params = []
  if (q) {
    sql += ' AND (br.member_name LIKE ? OR br.enemy_name LIKE ? OR br.enemy_alliance LIKE ? OR br.generals_used LIKE ? OR br.report_text LIKE ?)'
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
  }
  if (result) { sql += ' AND br.result = ?'; params.push(result) }
  if (member_id) { sql += ' AND br.member_id = ?'; params.push(member_id) }
  let selectSql = `SELECT br.*, m.nickname, m.game_id ${sql}`
  selectSql += ' ORDER BY br.created_at DESC'
  if (!hasPagination) {
    const rows = db.prepare(selectSql).all(...params)
    return res.json(rows)
  }
  const total = db.prepare(`SELECT COUNT(*) as total ${sql}`).get(...params).total
  const data = db.prepare(`${selectSql} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize)
  const totalPages = Math.ceil(total / pageSize)
  res.json({ data, total, page, pageSize, totalPages })
})

router.post('/battle-reports', requireLevel(2), (req, res) => {
  const b = req.body || {}
  const info = db.prepare(`
    INSERT INTO battle_report_lib (member_id, member_name, enemy_name, enemy_alliance, result, war_merit, generals_used, enemy_generals, report_text, image_path, battle_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.member_id||null, b.member_name||'', b.enemy_name||'', b.enemy_alliance||'', b.result||'', b.war_merit||0, b.generals_used||'', b.enemy_generals||'', b.report_text||'', b.image_path||'', b.battle_date||new Date().toISOString().slice(0,10))
  res.json({ id: info.lastInsertRowid })
})

// ===== 赛季归档 =====
router.get('/season-archives', (req, res) => {
  const rows = db.prepare('SELECT * FROM season_archives ORDER BY archived_at DESC').all()
  res.json(rows.map(r => ({ ...r, archive_data: JSON.parse(r.archive_data||'{}'), top_members: JSON.parse(r.top_members||'[]') })))
})

router.post('/season-archives', requireLevel(4), (req, res) => {
  const seasonName = req.body?.season_name
  const err = validName(seasonName, '赛季名称', 40)
  if (err) return res.status(400).json({ error: err })
  const cleanSeason = cleanName(seasonName, 40)
  const members = db.prepare('SELECT id, nickname, total_merit, available_merit, power FROM members WHERE status != ? ORDER BY total_merit DESC').all('离盟')
  const top = members.slice(0, 20)
  const totalMerit = members.reduce((s, m) => s + (m.total_merit||0), 0)
  const totalWar = db.prepare('SELECT COALESCE(SUM(amount),0) as s FROM war_merit_records').get().s
  const info = db.prepare(`
    INSERT INTO season_archives (season_name, archive_data, total_members, total_merit, total_war, top_members)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(cleanSeason, JSON.stringify({ members: members.length }), members.length, totalMerit, totalWar, JSON.stringify(top))
  logOp(req.user.id, '赛季归档', cleanSeason)
  res.json({ id: info.lastInsertRowid })
})

// ===== 成员画像 =====
router.get('/member-profile/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(req.params.id)
  if (!m) return res.status(404).json({ error: '成员不存在' })

  const warRecords = db.prepare('SELECT * FROM war_merit_records WHERE member_id = ? ORDER BY created_at DESC LIMIT 50').all(m.id)
  const meritLogs = db.prepare('SELECT * FROM merit_logs WHERE member_id = ? ORDER BY created_at DESC LIMIT 50').all(m.id)
  const attendance = db.prepare(`
    SELECT a.*, c.name as city_name FROM city_attendance a
    JOIN city_plans c ON c.id = a.city_id
    WHERE a.member_id = ? ORDER BY a.created_at DESC LIMIT 30
  `).all(m.id)
  const journey = db.prepare('SELECT * FROM journey_records WHERE member_id = ? ORDER BY week_key DESC LIMIT 12').all(m.id)
  const pioneer = db.prepare('SELECT * FROM pioneer_records WHERE member_id = ? ORDER BY record_date DESC LIMIT 30').all(m.id)

  const totalWar = warRecords.reduce((s, r) => s + (r.amount||0), 0)
  const attended = attendance.filter(a => a.attended).length
  const totalAtt = attendance.length
  const attRate = totalAtt ? Math.round(attended/totalAtt*100) : 0

  res.json({
    member: m,
    stats: {
      total_war: totalWar,
      attendance_rate: attRate,
      attended,
      total_attendance: totalAtt,
      journey_count: journey.length,
      pioneer_count: pioneer.length,
    },
    war_records: warRecords,
    merit_logs: meritLogs,
    attendance,
    journey,
    pioneer,
  })
})

// ===== 数据大屏 =====
router.get('/dashboard-big', (req, res) => {
  const overview = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM members WHERE status != '离盟') as member_count,
      (SELECT COALESCE(SUM(total_merit),0) FROM members WHERE status != '离盟') as total_merit,
      (SELECT COALESCE(SUM(amount),0) FROM war_merit_records WHERE created_at >= datetime('now','localtime','-6 days')) as week_war,
      (SELECT COUNT(*) FROM city_plans WHERE status='计划中') as pending_cities,
      (SELECT COUNT(*) FROM city_plans WHERE status='已完成') as cities_done,
      (SELECT COUNT(*) FROM fortresses) as fortress_count,
      (SELECT COUNT(*) FROM enemies) as enemy_count
  `).get()

  const topMembers = db.prepare(`
    SELECT nickname, total_merit, available_merit, power FROM members
    WHERE status != '离盟' ORDER BY total_merit DESC LIMIT 10
  `).all()

  const groupStats = db.prepare(`
    SELECT g.name,
      COUNT(m.id) as member_count,
      COALESCE(SUM(m.total_merit),0) as total_merit,
      COALESCE(SUM(m.power),0) as total_power
    FROM groups g
    LEFT JOIN members m ON m.group_id = g.id AND m.status != '离盟'
    GROUP BY g.id ORDER BY total_merit DESC
  `).all()

  const upcomingCities = db.prepare(`
    SELECT * FROM city_plans WHERE status='计划中' ORDER BY planned_time ASC LIMIT 5
  `).all()

  const recentLogs = db.prepare(`
    SELECT l.created_at, l.type, l.amount, l.category, m.nickname
    FROM merit_logs l JOIN members m ON m.id = l.member_id
    ORDER BY l.created_at DESC LIMIT 10
  `).all()

  res.json({ overview, top_members: topMembers, group_stats: groupStats, upcoming_cities: upcomingCities, recent_logs: recentLogs })
})

module.exports = router
