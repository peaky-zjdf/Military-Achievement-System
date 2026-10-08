const express = require('express')
const { db, logOp } = require('../db')
const { authRequired, requireLevel } = require('../middleware/auth')
const { validId, validName, cleanName, validate } = require('../services/validate')
const { allianceFilter, allianceFilterViaMember, getAllianceIdForInsert, getAllianceId } = require('../middleware/alliance')

const router = express.Router()
router.use(authRequired)

router.get('/', (req, res) => {
  const af = allianceFilter(req, 'awards')
  const awards = db.prepare(`SELECT * FROM awards WHERE 1=1${af.sql} ORDER BY created_at DESC`).all(...af.params)
  const withList = awards.map((a) => ({
    ...a,
    distributions: db.prepare(`
      SELECT d.*, m.nickname, m.game_id, m.total_merit
      FROM award_distributions d
      JOIN members m ON m.id = d.member_id
      WHERE d.award_id = ?
      ORDER BY d.rank_no ASC
    `).all(a.id),
  }))
  res.json(withList)
})

router.post('/', requireLevel(3), (req, res) => {
  const { name, description = '', type = '征服名额', quota = 1 } = req.body || {}
  const err = validName(name, '奖励名称', 50)
  if (err) return res.status(400).json({ error: err })
  const clean = cleanName(name, 50)
  const allianceId = getAllianceIdForInsert(req)
  const info = db.prepare(`
    INSERT INTO awards (name, description, type, quota, created_by, alliance_id) VALUES (?, ?, ?, ?, ?, ?)
  `).run(clean, description, type, quota, req.user.id, allianceId)
  res.json({ id: info.lastInsertRowid })
})

router.put('/:id', requireLevel(3), (req, res) => {
  const af = allianceFilter(req, 'awards')
  const a = db.prepare(`SELECT * FROM awards WHERE id = ?${af.sql}`).get(req.params.id, ...af.params)
  if (!a) return res.status(404).json({ error: '不存在' })
  const b = req.body || {}
  db.prepare('UPDATE awards SET name=?, description=?, type=?, quota=?, status=? WHERE id=?')
    .run(b.name ?? a.name, b.description ?? a.description, b.type ?? a.type, b.quota ?? a.quota, b.status ?? a.status, a.id)
  res.json({ ok: true })
})

router.post('/:id/auto-distribute', requireLevel(3), (req, res) => {
  const af = allianceFilter(req, 'awards')
  const a = db.prepare(`SELECT * FROM awards WHERE id = ?${af.sql}`).get(req.params.id, ...af.params)
  if (!a) return res.status(404).json({ error: '不存在' })
  const maf = allianceFilter(req, 'm')
  const members = db.prepare(`
    SELECT id, total_merit FROM members m
    WHERE m.status IN ('活跃','预备')${maf.sql} ORDER BY total_merit DESC LIMIT ?
  `).all(...maf.params, a.quota)
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM award_distributions WHERE award_id = ?').run(a.id)
    members.forEach((m, i) => {
      db.prepare(`
        INSERT INTO award_distributions (award_id, member_id, rank_no, merit_snapshot, status)
        VALUES (?, ?, ?, ?, '待公示')
      `).run(a.id, m.id, i + 1, m.total_merit)
    })
  })
  tx()
  logOp(req.user.id, '自动生成奖励分配', a.name)
  res.json({ ok: true, count: members.length })
})

router.post('/:id/distribute', requireLevel(3), (req, res) => {
  const { member_id, rank_no = 0, note = '' } = req.body || {}
  const af = allianceFilter(req, 'awards')
  const a = db.prepare(`SELECT * FROM awards WHERE id = ?${af.sql}`).get(req.params.id, ...af.params)
  if (!a) return res.status(404).json({ error: '不存在' })
  const err = validId(member_id, '成员ID')
  if (err) return res.status(400).json({ error: err })
  const maf = allianceFilter(req, 'm')
  const m = db.prepare(`SELECT total_merit FROM members m WHERE m.id = ?${maf.sql}`).get(member_id, ...maf.params)
  db.prepare(`
    INSERT INTO award_distributions (award_id, member_id, rank_no, merit_snapshot, status, note)
    VALUES (?, ?, ?, ?, '待公示', ?)
  `).run(a.id, member_id, rank_no, m?.total_merit || 0, note)
  res.json({ ok: true })
})

router.delete('/dist/:id', requireLevel(3), (req, res) => {
  const aid = getAllianceId(req)
  if (aid != null) {
    const dist = db.prepare(`
      SELECT d.id FROM award_distributions d
      JOIN members m ON m.id = d.member_id
      WHERE d.id = ? AND m.alliance_id = ?
    `).get(req.params.id, aid)
    if (!dist) return res.status(404).json({ error: '不存在' })
  }
  db.prepare('DELETE FROM award_distributions WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

router.post('/:id/publish', requireLevel(3), (req, res) => {
  const af = allianceFilter(req, 'awards')
  const a = db.prepare(`SELECT * FROM awards WHERE id = ?${af.sql}`).get(req.params.id, ...af.params)
  if (!a) return res.status(404).json({ error: '不存在' })
  db.prepare("UPDATE awards SET status='已公示' WHERE id = ?").run(a.id)
  db.prepare("UPDATE award_distributions SET status='已公示' WHERE award_id = ?").run(a.id)
  logOp(req.user.id, '奖励公示', a.name)
  res.json({ ok: true })
})

module.exports = router
