const express = require('express')
const { db, logOp } = require('../db')
const { authRequired, requireLevel } = require('../middleware/auth')
const { calcCityMerit, applyMerit, applyMeritIfNonZero } = require('../services/merit')
const { validId, validName, cleanName, validate } = require('../services/validate')
const { allianceFilter, allianceFilterViaMember, getAllianceIdForInsert } = require('../middleware/alliance')

const router = express.Router()
router.use(authRequired)

router.get('/plans', (req, res) => {
  const { status = '' } = req.query
  const af = allianceFilter(req, 'c')
  let sql = `
    SELECT c.*, g.name as group_name,
           (SELECT COUNT(*) FROM city_signups s WHERE s.city_id=c.id AND s.type='拆迁') as demo_count,
           (SELECT COUNT(*) FROM city_signups s WHERE s.city_id=c.id AND s.type='驻守') as guard_count,
           (SELECT COUNT(*) FROM city_signups s WHERE s.city_id=c.id AND s.type='主力') as main_count,
           (SELECT COUNT(*) FROM city_attendance a WHERE a.city_id=c.id AND a.attended=1) as attended_count
    FROM city_plans c
    LEFT JOIN groups g ON g.id = c.target_group_id
    WHERE 1=1 ${af.sql}
  `
  const params = [...af.params]
  if (status) {
    sql += ' AND c.status = ?'
    params.push(status)
  }
  sql += ' ORDER BY c.planned_time DESC'
  res.json(db.prepare(sql).all(...params))
})

router.get('/plans/:id', (req, res) => {
  const af = allianceFilter(req, 'c')
  const plan = db.prepare(`
    SELECT c.*, g.name as group_name FROM city_plans c
    LEFT JOIN groups g ON g.id = c.target_group_id WHERE c.id = ? ${af.sql}
  `).get(req.params.id, ...af.params)
  if (!plan) return res.status(404).json({ error: '打城计划不存在' })

  const signups = db.prepare(`
    SELECT s.*, m.nickname, m.game_id, g.name as group_name
    FROM city_signups s
    JOIN members m ON m.id = s.member_id
    LEFT JOIN groups g ON g.id = m.group_id
    WHERE s.city_id = ?
    ORDER BY s.type, m.total_merit DESC
  `).all(plan.id)

  const attendance = db.prepare(`
    SELECT a.*, m.nickname, m.game_id, g.name as group_name
    FROM city_attendance a
    JOIN members m ON m.id = a.member_id
    LEFT JOIN groups g ON g.id = m.group_id
    WHERE a.city_id = ?
    ORDER BY a.attended DESC, a.demolition DESC
  `).all(plan.id)

  res.json({ ...plan, signups, attendance })
})

router.post('/plans', requireLevel(2), (req, res) => {
  const {
    name, coord_x = 0, coord_y = 0, planned_time,
    target_group_id = null, demolition_target = 0, guard_target = 0,
    main_force_target = 0, note = '',
  } = req.body || {}
  const err = validate([validName(name, '城池名称', 30)])
  if (err) return res.status(400).json({ error: err })
  if (!planned_time) return res.status(400).json({ error: '计划时间必填' })
  const cleanName_ = cleanName(name, 30)
  const allianceId = getAllianceIdForInsert(req)
  const info = db.prepare(`
    INSERT INTO city_plans (name, coord_x, coord_y, planned_time, target_group_id, demolition_target, guard_target, main_force_target, note, created_by, alliance_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(cleanName_, coord_x, coord_y, planned_time, target_group_id || null, demolition_target, guard_target, main_force_target, note, req.user.id, allianceId)
  logOp(req.user.id, '创建打城计划', name)
  res.json({ id: info.lastInsertRowid })
})

router.put('/plans/:id', requireLevel(2), (req, res) => {
  const af = allianceFilter(req, 'c')
  const plan = db.prepare(`SELECT * FROM city_plans c WHERE c.id = ? ${af.sql}`).get(req.params.id, ...af.params)
  if (!plan) return res.status(404).json({ error: '不存在' })
  const b = req.body || {}
  db.prepare(`
    UPDATE city_plans SET name=?, coord_x=?, coord_y=?, planned_time=?, target_group_id=?,
      demolition_target=?, guard_target=?, main_force_target=?, note=?, status=?, finished_at=?
    WHERE id=?
  `).run(
    b.name ?? plan.name,
    b.coord_x ?? plan.coord_x,
    b.coord_y ?? plan.coord_y,
    b.planned_time ?? plan.planned_time,
    b.target_group_id ?? plan.target_group_id,
    b.demolition_target ?? plan.demolition_target,
    b.guard_target ?? plan.guard_target,
    b.main_force_target ?? plan.main_force_target ?? 0,
    b.note ?? plan.note,
    b.status ?? plan.status,
    b.status === '已完成' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : plan.finished_at,
    plan.id
  )
  res.json({ ok: true })
})

router.delete('/plans/:id', requireLevel(3), (req, res) => {
  const af = allianceFilter(req)
  // Use 'c' alias won't work on DELETE directly; check plan first
  const plan = db.prepare(`SELECT * FROM city_plans WHERE id = ?`).get(req.params.id)
  if (!plan) return res.status(404).json({ error: '不存在' })
  const aid = getAllianceIdForInsert(req)
  if (aid !== null && plan.alliance_id !== aid) return res.status(404).json({ error: '不存在' })
  db.prepare('DELETE FROM city_plans WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

const SIGNUP_TYPES = ['拆迁', '驻守', '主力', '预备']

/** 验证 plan 存在且属于当前同盟，返回 plan 或 null */
function getPlanForAlliance(req, planId) {
  const af = allianceFilter(req, 'c')
  return db.prepare(`SELECT * FROM city_plans c WHERE c.id = ? ${af.sql}`).get(planId, ...af.params)
}

router.post('/plans/:id/signup', (req, res) => {
  const { type = '拆迁' } = req.body || {}
  if (!req.user.member_id) return res.status(400).json({ error: '请先关联游戏成员' })
  if (!SIGNUP_TYPES.includes(type)) return res.status(400).json({ error: '报名类型无效' })
  const plan = getPlanForAlliance(req, req.params.id)
  if (!plan) return res.status(404).json({ error: '打城计划不存在' })
  try {
    const info = db.prepare('INSERT INTO city_signups (city_id, member_id, type) VALUES (?, ?, ?)')
      .run(req.params.id, req.user.member_id, type)
    res.json({ id: info.lastInsertRowid })
  } catch (e) {
    res.status(400).json({ error: '已报名该类型' })
  }
})

router.post('/plans/:id/signup-manual', requireLevel(2), (req, res) => {
  const { member_id, type = '拆迁' } = req.body || {}
  const err = validId(member_id, '成员ID')
  if (err) return res.status(400).json({ error: err })
  if (!SIGNUP_TYPES.includes(type)) return res.status(400).json({ error: '报名类型无效' })
  const plan = getPlanForAlliance(req, req.params.id)
  if (!plan) return res.status(404).json({ error: '打城计划不存在' })
  try {
    const info = db.prepare('INSERT INTO city_signups (city_id, member_id, type) VALUES (?, ?, ?)')
      .run(req.params.id, member_id, type)
    res.json({ id: info.lastInsertRowid })
  } catch (e) {
    res.status(400).json({ error: '已报名该类型' })
  }
})

router.delete('/signup/:id', (req, res) => {
  const s = db.prepare(`
    SELECT s.* FROM city_signups s
    JOIN city_plans c ON c.id = s.city_id
    WHERE s.id = ?
  `).get(req.params.id)
  if (!s) return res.status(404).json({ error: '不存在' })
  // 验证 plan 属于当前同盟
  const plan = getPlanForAlliance(req, s.city_id)
  if (!plan) return res.status(404).json({ error: '不存在' })
  if (req.user.role === '成员' && s.member_id !== req.user.member_id) {
    return res.status(403).json({ error: '只能取消自己的报名' })
  }
  db.prepare('DELETE FROM city_signups WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

router.post('/plans/:id/attendance', requireLevel(2), (req, res) => {
  const { items = [], autoPenalty = true } = req.body || {}
  const cityId = Number(req.params.id)
  // 验证 plan 属于当前同盟
  const plan = getPlanForAlliance(req, cityId)
  if (!plan) return res.status(404).json({ error: '打城计划不存在' })
  // items: [{ member_id, attended, demolition, note }]
  // 差额计分：同一城池重复提交只补/扣与上次的差，避免双计
  const tx = db.transaction(() => {
    let awarded = 0
    for (const it of items) {
      if (!it.member_id) continue
      const attended = it.attended ? 1 : 0
      const demolition = Number(it.demolition) || 0
      const merit = calcCityMerit({ attended, demolition })
      const prev = db.prepare('SELECT merit FROM city_attendance WHERE city_id = ? AND member_id = ?')
        .get(cityId, it.member_id)
      db.prepare(`
        INSERT INTO city_attendance (city_id, member_id, attended, demolition, merit, note, recorded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(city_id, member_id) DO UPDATE SET
          attended=excluded.attended, demolition=excluded.demolition,
          merit=excluded.merit, note=excluded.note, recorded_by=excluded.recorded_by
      `).run(cityId, it.member_id, attended, demolition, merit, it.note || '', req.user.id)

      const delta = merit - (prev?.merit || 0)
      applyMeritIfNonZero(
        it.member_id,
        delta,
        delta >= 0 ? '收入' : '扣减',
        attended ? '打城' : '缺勤',
        attended ? `打城拆迁${demolition}` : '打城缺勤',
        req.user.id,
        cityId
      )
      awarded++
    }
    if (autoPenalty) {
      const absent = db.prepare(`
        SELECT s.member_id FROM city_signups s
        WHERE s.city_id = ? AND s.member_id NOT IN (
          SELECT member_id FROM city_attendance WHERE city_id = ?
        )
      `).all(cityId, cityId)
      for (const a of absent) {
        const exists = db.prepare('SELECT id FROM city_attendance WHERE city_id=? AND member_id=?').get(cityId, a.member_id)
        if (exists) continue
        const merit = calcCityMerit({ attended: 0, demolition: 0 })
        db.prepare(`
          INSERT INTO city_attendance (city_id, member_id, attended, demolition, merit, note, recorded_by)
          VALUES (?, ?, 0, 0, ?, '报名未到自动扣分', ?)
        `).run(cityId, a.member_id, merit, req.user.id)
        try {
          applyMeritIfNonZero(a.member_id, merit, '扣减', '缺勤', '报名未到', req.user.id, cityId)
        } catch (e) {
          // 余额不足时仍记录考勤，仅跳过扣分（避免一个成员失败阻断全部考勤）
          console.warn(`缺勤扣分跳过 member=${a.member_id}: ${e.message}`)
        }
      }
    }
    db.prepare("UPDATE city_plans SET status='已完成' WHERE id = ?").run(req.params.id)
    return awarded
  })
  const n = tx()
  logOp(req.user.id, '录入打城考勤', `city=${req.params.id} n=${n}`)
  res.json({ ok: true, count: n })
})

router.get('/stats', (req, res) => {
  const af = allianceFilter(req, 'c')
  const totalCities = db.prepare(`SELECT COUNT(*) as c FROM city_plans c WHERE c.status='已完成' ${af.sql}`).get(...af.params).c
  const afm = allianceFilter(req, 'm')
  const personal = db.prepare(`
    SELECT m.id, m.nickname, m.game_id,
      COUNT(a.id) as total_sign,
      SUM(CASE WHEN a.attended=1 THEN 1 ELSE 0 END) as attended,
      SUM(CASE WHEN a.attended=0 THEN 1 ELSE 0 END) as absent,
      SUM(a.demolition) as demolition
    FROM members m
    LEFT JOIN city_attendance a ON a.member_id = m.id
    WHERE m.status != '离盟' ${afm.sql}
    GROUP BY m.id
    ORDER BY attended DESC, demolition DESC
  `).all(...afm.params)
  res.json({ totalCities, personal })
})

module.exports = router
