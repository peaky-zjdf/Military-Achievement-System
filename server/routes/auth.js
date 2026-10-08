const express = require('express')
const bcrypt = require('bcryptjs')
const { db, logOp } = require('../db')
const { authRequired, signToken, requireLevel } = require('../middleware/auth')

const router = express.Router()

// 简易登录防暴力破解：IP + 用户名维度，5分钟内5次失败则锁定15分钟
const loginAttempts = new Map()
const MAX_ATTEMPTS = 5
const WINDOW_MS = 5 * 60 * 1000
const LOCKOUT_MS = 15 * 60 * 1000

function getAttemptKey(ip, username) {
  return `${ip}:${username}`
}

function checkLoginAllowed(ip, username) {
  const key = getAttemptKey(ip, username)
  const entry = loginAttempts.get(key)
  if (!entry) return { allowed: true }
  const now = Date.now()
  if (entry.lockedUntil && now < entry.lockedUntil) {
    const remainSec = Math.ceil((entry.lockedUntil - now) / 1000)
    return { allowed: false, error: `账号已临时锁定，请 ${remainSec} 秒后重试` }
  }
  if (now - entry.firstAttempt > WINDOW_MS) {
    loginAttempts.delete(key)
    return { allowed: true }
  }
  return { allowed: true }
}

function recordAttempt(ip, username, success) {
  const key = getAttemptKey(ip, username)
  const now = Date.now()
  if (success) {
    loginAttempts.delete(key)
    return
  }
  let entry = loginAttempts.get(key)
  if (!entry || now - entry.firstAttempt > WINDOW_MS) {
    entry = { count: 0, firstAttempt: now, lockedUntil: null }
  }
  entry.count++
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS
  }
  loginAttempts.set(key, entry)
}

// 定期清理过期记录
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of loginAttempts) {
    if (entry.lockedUntil && now > entry.lockedUntil) loginAttempts.delete(key)
    else if (now - entry.firstAttempt > WINDOW_MS + LOCKOUT_MS) loginAttempts.delete(key)
  }
}, 60000)

router.post('/login', (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown'
  const { username, password } = req.body || {}
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' })

  const check = checkLoginAllowed(ip, username)
  if (!check.allowed) return res.status(429).json({ error: check.error })

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
  if (!user) {
    recordAttempt(ip, username, false)
    return res.status(401).json({ error: '账号或密码错误' })
  }
  if (!bcrypt.compareSync(password, user.password_hash)) {
    recordAttempt(ip, username, false)
    return res.status(401).json({ error: '账号或密码错误' })
  }

  recordAttempt(ip, username, true)
  const token = signToken(user)
  const profile = db.prepare(`
    SELECT u.id, u.username, u.role, u.member_id,
           m.nickname, m.game_id, m.group_id, m.available_merit, m.total_merit, m.status
    FROM users u LEFT JOIN members m ON m.id = u.member_id WHERE u.id = ?
  `).get(user.id)
  logOp(user.id, '登录', username)
  res.json({ token, user: profile })
})

router.get('/me', authRequired, (req, res) => {
  const profile = db.prepare(`
    SELECT u.id, u.username, u.role, u.member_id,
           m.nickname, m.game_id, m.group_id, m.available_merit, m.total_merit, m.status, m.power
    FROM users u LEFT JOIN members m ON m.id = u.member_id WHERE u.id = ?
  `).get(req.user.id)
  res.json(profile)
})

// 盟主邀请码注册
router.post('/register-with-invite', (req, res) => {
  const { invite_code, username, password, alliance_name } = req.body || {}
  if (!invite_code || !username || !password) {
    return res.status(400).json({ error: '邀请码、账号、密码必填' })
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' })
  }

  const code = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(invite_code)
  if (!code) return res.status(400).json({ error: '邀请码无效' })
  if (code.use_count >= code.max_uses) return res.status(400).json({ error: '邀请码已用完' })
  if (code.expires_at && new Date(code.expires_at) < new Date()) {
    return res.status(400).json({ error: '邀请码已过期' })
  }

  // 检查用户名是否已存在
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (existing) return res.status(400).json({ error: '用户名已存在' })

  const aName = alliance_name || code.alliance_name || username + '的同盟'
  const hash = bcrypt.hashSync(String(password), 10)

  const tx = db.transaction(() => {
    // 创建同盟
    const aInfo = db.prepare('INSERT INTO alliances (name) VALUES (?)').run(aName)
    const allianceId = aInfo.lastInsertRowid

    // 创建盟主用户
    const uInfo = db.prepare(`
      INSERT INTO users (username, password_hash, role, alliance_id) VALUES (?, ?, '盟主', ?)
    `).run(username, hash, allianceId)

    // 更新同盟归属
    db.prepare('UPDATE alliances SET owner_user_id = ? WHERE id = ?').run(uInfo.lastInsertRowid, allianceId)

    // 标记邀请码已用
    db.prepare('UPDATE invite_codes SET use_count = use_count + 1, used_by = ? WHERE id = ?')
      .run(uInfo.lastInsertRowid, code.id)

    return uInfo.lastInsertRowid
  })

  try {
    const userId = tx()
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
    const token = signToken(user)
    logOp(userId, '邀请注册', `盟主: ${username}, 同盟: ${aName}`)
    res.json({ token, user: { id: userId, username, role: '盟主' } })
  } catch (e) {
    res.status(500).json({ error: '注册失败: ' + e.message })
  }
})

// 验证邀请码（注册页用）
router.get('/check-invite/:code', (req, res) => {
  const code = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(req.params.code)
  if (!code) return res.json({ valid: false, error: '邀请码无效' })
  if (code.use_count >= code.max_uses) return res.json({ valid: false, error: '邀请码已用完' })
  if (code.expires_at && new Date(code.expires_at) < new Date()) {
    return res.json({ valid: false, error: '邀请码已过期' })
  }
  res.json({ valid: true, alliance_name: code.alliance_name || '' })
})

router.post('/change-password', authRequired, (req, res) => {
  const { oldPassword, newPassword } = req.body || {}
  if (!oldPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' })
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)
  if (!bcrypt.compareSync(oldPassword, user.password_hash)) {
    return res.status(400).json({ error: '原密码错误' })
  }
  const hash = bcrypt.hashSync(newPassword, 10)
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id)
  res.json({ ok: true })
})

router.post('/reset-password', authRequired, requireLevel(3), (req, res) => {
  const { userId, newPassword } = req.body || {}
  if (!userId || !newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' })
  }
  const hash = bcrypt.hashSync(newPassword, 10)
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId)
  logOp(req.user.id, '重置密码', `user=${userId}`)
  res.json({ ok: true })
})

module.exports = router
