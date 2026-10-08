const express = require('express')
const bcrypt = require('bcryptjs')
const { db, logOp, getSetting } = require('../db')
const { authRequired, requireLevel } = require('../middleware/auth')
const { applyMerit } = require('../services/merit')
const { validId, validName, cleanName, validate } = require('../services/validate')
const { allianceFilter, getAllianceIdForInsert } = require('../middleware/alliance')

const router = express.Router()
router.use(authRequired)

function canSeeAll(req) {
  return ['root', '盟主', '副盟'].includes(req.user.role)
}

router.get('/groups', (req, res) => {
  const af = allianceFilter(req, 'g')
  const mf = allianceFilter(req, 'm')
  const mmf = allianceFilter(req, 'mm')
  const rows = db.prepare(`
    SELECT g.*, m.nickname as leader_name,
           (SELECT COUNT(*) FROM members mm WHERE mm.group_id = g.id AND mm.status != '离盟'${mmf.sql}) as member_count
    FROM groups g
    LEFT JOIN members m ON m.id = g.leader_id${mf.sql}
    WHERE 1=1${af.sql}
    ORDER BY g.id
  `).all(...mmf.params, ...mf.params, ...af.params)
  res.json(rows)
})

router.post('/groups', requireLevel(3), (req, res) => {
  const { name, description } = req.body || {}
  const err = validate([validName(name, '团名', 20)])
  if (err) return res.status(400).json({ error: err })
  const clean = cleanName(name, 20)
  try {
    const aid = getAllianceIdForInsert(req)
    const info = db.prepare('INSERT INTO groups (name, description, alliance_id) VALUES (?, ?, ?)').run(clean, description || '', aid)
    logOp(req.user.id, '创建团', clean)
    res.json({ id: info.lastInsertRowid, name: clean })
  } catch (e) {
    res.status(400).json({ error: '团名已存在' })
  }
})

router.put('/groups/:id', requireLevel(3), (req, res) => {
  const { name, leader_id, description } = req.body || {}
  const af = allianceFilter(req, 'groups')
  const g = db.prepare(`SELECT * FROM groups WHERE id = ?${af.sql}`).get(req.params.id, ...af.params)
  if (!g) return res.status(404).json({ error: '团不存在' })
  db.prepare(`UPDATE groups SET name = ?, leader_id = ?, description = ? WHERE id = ?${af.sql}`)
    .run(name || g.name, leader_id != null ? leader_id : g.leader_id, description != null ? description : g.description, g.id, ...af.params)
  if (leader_id) {
    const mf = allianceFilter(req, 'members')
    const m = db.prepare(`SELECT role FROM members WHERE id = ?${mf.sql}`).get(leader_id, ...mf.params)
    if (m && m.role === '成员') {
      db.prepare("UPDATE members SET role = '团长' WHERE id = ?").run(leader_id)
    }
  }
  logOp(req.user.id, '修改团', `团#${g.id} → ${name || g.name}`)
  res.json({ ok: true })
})

// 获取团内成员
router.get('/groups/:id/members', (req, res) => {
  const af = allianceFilter(req, 'm')
  const rows = db.prepare(`
    SELECT m.id, m.game_id, m.nickname, m.role, m.status, m.power, m.total_merit, m.available_merit
    FROM members m WHERE m.group_id = ? AND m.status != '离盟'${af.sql}
    ORDER BY m.role DESC, m.total_merit DESC
  `).all(req.params.id, ...af.params)
  res.json(rows)
})

// 批量移动成员到团
router.post('/groups/:id/assign', requireLevel(3), (req, res) => {
  const { member_ids } = req.body || {}
  if (!Array.isArray(member_ids) || !member_ids.length) return res.status(400).json({ error: '请选择成员' })
  const af = allianceFilter(req, 'groups')
  const g = db.prepare(`SELECT * FROM groups WHERE id = ?${af.sql}`).get(req.params.id, ...af.params)
  if (!g) return res.status(404).json({ error: '团不存在' })
  const mf = allianceFilter(req, 'members')
  const stmt = db.prepare(`UPDATE members SET group_id = ? WHERE id = ?${mf.sql}`)
  let ok = 0
  for (const mid of member_ids) {
    const r = stmt.run(g.id, mid, ...mf.params)
    ok += r.changes
  }
  logOp(req.user.id, '批量分配团', `${ok}人 → ${g.name}`)
  res.json({ ok })
})

router.delete('/groups/:id', requireLevel(4), (req, res) => {
  const mf = allianceFilter(req, 'members')
  const count = db.prepare(`SELECT COUNT(*) as c FROM members WHERE group_id = ?${mf.sql}`).get(req.params.id, ...mf.params).c
  if (count > 0) return res.status(400).json({ error: '团内仍有成员，无法删除' })
  const af = allianceFilter(req, 'groups')
  db.prepare(`DELETE FROM groups WHERE id = ?${af.sql}`).run(req.params.id, ...af.params)
  res.json({ ok: true })
})

router.get('/', (req, res) => {
  const { q = '', group_id = '', status = '', role = '' } = req.query
  const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20))
  const af = allianceFilter(req, 'm')
  let sql = `
    FROM members m
    LEFT JOIN groups g ON g.id = m.group_id
    WHERE 1=1${af.sql}
  `
  const params = [...af.params]
  if (q) {
    sql += ' AND (m.nickname LIKE ? OR m.game_id LIKE ?)'
    params.push(`%${q}%`, `%${q}%`)
  }
  if (group_id) {
    sql += ' AND m.group_id = ?'
    params.push(group_id)
  }
  if (status) {
    sql += ' AND m.status = ?'
    params.push(status)
  }
  if (role) {
    sql += ' AND m.role = ?'
    params.push(role)
  }
  let selectSql = `SELECT m.*, g.name as group_name ${sql}`
  selectSql += ' ORDER BY m.total_merit DESC, m.power DESC'

  const maskRows = (rows) => {
    let out = rows
    if (!canSeeAll(req) && req.user.role !== '团长') {
      out = out.map((r) => ({
        ...r,
        qq: r.id === req.user.member_id ? r.qq : '',
        phone: r.id === req.user.member_id ? r.phone : '',
      }))
    }
    if (req.user.role === '团长') {
      out = out.map((r) => {
        if (r.group_id === req.user.group_id || r.id === req.user.member_id) return r
        return { ...r, qq: '', phone: '' }
      })
    }
    return out
  }

  if (!hasPagination) {
    const rows = db.prepare(selectSql).all(...params)
    return res.json(maskRows(rows))
  }
  const total = db.prepare(`SELECT COUNT(*) as total ${sql}`).get(...params).total
  let rows = db.prepare(`${selectSql} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize)
  rows = maskRows(rows)
  const totalPages = Math.ceil(total / pageSize)
  res.json({ data: rows, total, page, pageSize, totalPages })
})

router.get('/mine', (req, res) => {
  if (!req.user.member_id) return res.json(null)
  const row = db.prepare(`
    SELECT m.*, g.name as group_name FROM members m
    LEFT JOIN groups g ON g.id = m.group_id WHERE m.id = ?
  `).get(req.user.member_id)
  res.json(row)
})

router.post('/', requireLevel(3), (req, res) => {
  const {
    game_id, nickname, group_id, role = '成员', status = '活跃',
    power = 0, qq = '', phone = '', email = '', note = '', username, password,
  } = req.body || {}
  const err = validate([validName(game_id, '游戏ID', 30), validName(nickname, '昵称', 20)])
  if (err) return res.status(400).json({ error: err })
  const cleanGameId = cleanName(game_id, 30)
  const cleanNickname = cleanName(nickname, 20)
  // 副盟不能创建盟主，盟主只能通过邀请码注册或 root 创建
  if (role === '盟主' && req.user.role !== 'root') {
    return res.status(403).json({ error: '只有 root 可创建盟主账号' })
  }
  try {
    const aid = getAllianceIdForInsert(req)
    const info = db.prepare(`
      INSERT INTO members (game_id, nickname, group_id, role, status, power, qq, phone, email, note, alliance_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(cleanGameId, cleanNickname, group_id || null, role, status, power || 0, qq, phone, email, note, aid)
    if (power > 0) {
      db.prepare('INSERT INTO power_records (member_id, power, delta, note) VALUES (?, ?, ?, ?)')
        .run(info.lastInsertRowid, power, power, '初始化')
    }
    if (username && password) {
      if (String(password).length < 6) {
        return res.status(400).json({ error: '密码至少 6 位' })
      }
      const hash = bcrypt.hashSync(password, 10)
      const userRole = role === '盟主' ? '盟主' : role === '副盟' ? '副盟' : role === '团长' ? '团长' : '成员'
      db.prepare('INSERT INTO users (username, password_hash, member_id, role) VALUES (?, ?, ?, ?)')
        .run(username, hash, info.lastInsertRowid, userRole)
    }
    logOp(req.user.id, '新增成员', `${cleanNickname}(${cleanGameId})`)
    res.json({ id: info.lastInsertRowid })
  } catch (e) {
    res.status(400).json({ error: '游戏ID已存在或数据无效' })
  }
})

router.put('/:id', requireLevel(2), (req, res) => {
  const id = Number(req.params.id)
  const af = allianceFilter(req, 'm')
  const m = db.prepare(`SELECT * FROM members m WHERE m.id = ?${af.sql}`).get(id, ...af.params)
  if (!m) return res.status(404).json({ error: '成员不存在' })

  // team leader can only edit own group
  if (req.user.role === '团长' && m.group_id !== req.user.group_id && m.id !== req.user.member_id) {
    return res.status(403).json({ error: '只能编辑本团成员' })
  }
  // team leader cannot change role to 盟主/副盟
  const body = req.body || {}
  if (req.user.role === '团长' && body.role && ['盟主', '副盟'].includes(body.role)) {
    return res.status(403).json({ error: '无权设置该职位' })
  }

  const fields = ['game_id', 'nickname', 'group_id', 'role', 'status', 'power', 'qq', 'phone', 'email', 'note']
  const updates = []
  const params = []
  for (const f of fields) {
    if (body[f] !== undefined) {
      updates.push(`${f} = ?`)
      params.push(body[f])
    }
  }
  if (body.status === '离盟' && m.status !== '离盟') {
    updates.push('left_at = datetime(\'now\',\'localtime\')')
  }
  if (!updates.length) return res.json({ ok: true })
  updates.push("updated_at = datetime('now','localtime')")
  const afu = allianceFilter(req, 'members')
  db.prepare(`UPDATE members SET ${updates.join(', ')} WHERE id = ?${afu.sql}`).run(...params, id, ...afu.params)

  if (body.power !== undefined && Number(body.power) !== m.power) {
    const delta = Number(body.power) - m.power
    db.prepare('INSERT INTO power_records (member_id, power, delta, note) VALUES (?, ?, ?, ?)')
      .run(id, Number(body.power), delta, '手动更新')
  }

  // sync user role
  if (body.role) {
    const userRole = body.role === '盟主' ? '盟主' : body.role === '副盟' ? '副盟' : body.role === '团长' ? '团长' : '成员'
    db.prepare('UPDATE users SET role = ? WHERE member_id = ?').run(userRole, id)
  }

  logOp(req.user.id, '编辑成员', `id=${id}`)
  res.json({ ok: true })
})

router.delete('/:id', requireLevel(4), (req, res) => {
  const id = Number(req.params.id)
  const af = allianceFilter(req, 'members')
  db.prepare(`UPDATE members SET status = '离盟', left_at = datetime('now','localtime') WHERE id = ?${af.sql}`).run(id, ...af.params)
  // 禁用关联的登录账号
  db.prepare("UPDATE users SET role = '成员' WHERE member_id = ?").run(id)
  logOp(req.user.id, '成员离盟', `id=${id}`)
  res.json({ ok: true })
})

router.post('/batch-import', requireLevel(3), (req, res) => {
  const { text = '', group_id = null } = req.body || {}
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  let created = 0
  const errors = []
  const aid = getAllianceIdForInsert(req)
  for (const line of lines) {
    // format: game_id,nickname[,qq]
    const parts = line.split(/[,，\t]/).map((s) => s.trim())
    if (parts.length < 2 || !parts[0]) {
      errors.push(`格式错误: ${line}`)
      continue
    }
    try {
      db.prepare(`
        INSERT INTO members (game_id, nickname, group_id, alliance_id) VALUES (?, ?, ?, ?)
      `).run(parts[0], parts[1], group_id || null, aid)
      created++
    } catch (e) {
      errors.push(`重复或失败: ${parts[0]}`)
    }
  }
  logOp(req.user.id, '批量导入成员', `成功${created}`)
  res.json({ created, errors })
})

router.get('/applications', requireLevel(2), (req, res) => {
  const af = allianceFilter(req, 'a')
  const rows = db.prepare(`SELECT a.*, al.name as alliance_name FROM applications a LEFT JOIN alliances al ON al.id = a.alliance_id WHERE 1=1${af.sql} ORDER BY a.created_at DESC`).all(...af.params)
  res.json(rows)
})

router.post('/applications', (req, res) => {
  // public apply endpoint could be separate; here members create for others
  const { game_id, nickname, contact = '', season_info = '', obey_manage = 1 } = req.body || {}
  if (!game_id || !nickname) return res.status(400).json({ error: '游戏ID和昵称必填' })
  const aid = getAllianceIdForInsert(req)
  const info = db.prepare(`
    INSERT INTO applications (game_id, nickname, contact, season_info, obey_manage, alliance_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(game_id, nickname, contact, season_info, obey_manage ? 1 : 0, aid)
  res.json({ id: info.lastInsertRowid })
})

// public apply
router.post('/apply-public', (req, res) => {
  const { game_id, nickname, contact = '', season_info = '', obey_manage = 1 } = req.body || {}
  if (!game_id || !nickname) return res.status(400).json({ error: '游戏ID和昵称必填' })
  const aid = getAllianceIdForInsert(req)
  const info = db.prepare(`
    INSERT INTO applications (game_id, nickname, contact, season_info, obey_manage, alliance_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(game_id, nickname, contact, season_info, obey_manage ? 1 : 0, aid)
  res.json({ id: info.lastInsertRowid, message: '申请已提交' })
})

router.post('/applications/:id/review', requireLevel(3), (req, res) => {
  const { action, reject_reason = '', group_id = null, username = '', password = '' } = req.body || {}
  const af = allianceFilter(req, 'a')
  const app = db.prepare(`SELECT * FROM applications a WHERE a.id = ?${af.sql}`).get(req.params.id, ...af.params)
  if (!app) return res.status(404).json({ error: '申请不存在' })
  if (app.status !== '待审核') return res.status(400).json({ error: '该申请已处理' })

  if (action === 'reject') {
    db.prepare(`
      UPDATE applications SET status='已驳回', reviewer_id=?, reject_reason=?, reviewed_at=datetime('now','localtime')
      WHERE id=?${af.sql}
    `).run(req.user.id, reject_reason, app.id, ...af.params)
    return res.json({ ok: true })
  }

  // approve
  let memberId
  const mf = allianceFilter(req, 'members')
  const exist = db.prepare(`SELECT id FROM members WHERE game_id = ?${mf.sql}`).get(app.game_id, ...mf.params)
  if (exist) {
    memberId = exist.id
    db.prepare(`UPDATE members SET status='活跃', nickname=?, group_id=? WHERE id=?${mf.sql}`)
      .run(app.nickname, group_id || null, memberId, ...mf.params)
  } else {
    const maf = getAllianceIdForInsert(req)
    const info = db.prepare(`
      INSERT INTO members (game_id, nickname, group_id, status, alliance_id) VALUES (?, ?, ?, '活跃', ?)
    `).run(app.game_id, app.nickname, group_id || null, maf)
    memberId = info.lastInsertRowid
  }
  if (username && password) {
    const hash = bcrypt.hashSync(password, 10)
    try {
      db.prepare('INSERT INTO users (username, password_hash, member_id, role) VALUES (?, ?, ?, ?)')
        .run(username, hash, memberId, '成员')
    } catch (e) {
      // username exists
    }
  }
  db.prepare(`
    UPDATE applications SET status='已通过', reviewer_id=?, reviewed_at=datetime('now','localtime')
    WHERE id=?${af.sql}
  `).run(req.user.id, app.id, ...af.params)
  logOp(req.user.id, '通过入盟申请', app.nickname)
  res.json({ ok: true, member_id: memberId })
})

router.get('/invites', requireLevel(2), (req, res) => {
  const mf = allianceFilter(req, 'm')
  const uf = allianceFilter(req, 'u')
  const rows = db.prepare(`
    SELECT i.*, m.nickname, m.game_id, u.nickname as inviter_name
    FROM invites i
    LEFT JOIN members m ON m.id = i.member_id${mf.sql}
    LEFT JOIN members u ON u.id = i.inviter_id${uf.sql}
    ORDER BY i.created_at DESC
  `).all(...mf.params, ...uf.params)
  res.json(rows)
})

router.post('/invites', requireLevel(2), (req, res) => {
  const { member_id, note = '' } = req.body || {}
  const err = validId(member_id, '成员ID')
  if (err) return res.status(400).json({ error: err })
  const info = db.prepare('INSERT INTO invites (member_id, inviter_id, note) VALUES (?, ?, ?)')
    .run(member_id, req.user.member_id, note)
  res.json({ id: info.lastInsertRowid })
})

router.get('/attendance/:memberId', (req, res) => {
  const memberId = Number(req.params.memberId)
  if (req.user.role === '成员' && req.user.member_id !== memberId) {
    return res.status(403).json({ error: '只能查看自己的考勤' })
  }
  const rows = db.prepare(`
    SELECT a.*, c.name as city_name, c.planned_time
    FROM city_attendance a
    JOIN city_plans c ON c.id = a.city_id
    WHERE a.member_id = ?
    ORDER BY c.planned_time DESC
  `).all(memberId)
  res.json(rows)
})

router.get('/merit-log/:memberId', (req, res) => {
  const memberId = Number(req.params.memberId)
  if (req.user.role === '成员' && req.user.member_id !== memberId) {
    return res.status(403).json({ error: '只能查看自己的军功流水' })
  }
  const rows = db.prepare(`
    SELECT * FROM merit_logs WHERE member_id = ? ORDER BY created_at DESC, id DESC LIMIT 200
  `).all(memberId)
  res.json(rows)
})

module.exports = router
