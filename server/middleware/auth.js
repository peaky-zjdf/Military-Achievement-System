const jwt = require('jsonwebtoken')
const crypto = require('crypto')
const { db, getSetting, setSetting } = require('../db')

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET
  let s = getSetting('jwt_secret', '')
  if (!s) {
    s = crypto.randomBytes(32).toString('hex')
    setSetting('jwt_secret', s)
  }
  return s
}

const JWT_SECRET = loadSecret()

const ROLE_LEVEL = {
  '成员': 1,
  '团长': 2,
  '副盟': 3,
  '盟主': 4,
  'root': 5,
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: '未登录' })
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    const user = db.prepare(`
      SELECT u.id, u.username, u.role, u.member_id, u.alliance_id,
             m.nickname, m.game_id, m.group_id, m.status as member_status, m.role as member_role
      FROM users u
      LEFT JOIN members m ON m.id = u.member_id
      WHERE u.id = ?
    `).get(payload.id)
    if (!user) return res.status(401).json({ error: '用户不存在' })
    if (user.role !== 'root' && user.member_status === '离盟') return res.status(403).json({ error: '账号已停用' })
    req.user = user
    req.userLevel = ROLE_LEVEL[user.role] || 1
    next()
  } catch (e) {
    return res.status(401).json({ error: '登录已过期' })
  }
}

function requireLevel(minLevel) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: '未登录' })
    if ((ROLE_LEVEL[req.user.role] || 1) < minLevel) {
      return res.status(403).json({ error: '权限不足' })
    }
    next()
  }
}

/** 团长只能操作本团成员，root可操作所有人 */
function canTouchMember(req, memberId) {
  if (['root', '盟主', '副盟'].includes(req.user.role)) return true
  if (req.user.role !== '团长') return req.user.member_id === Number(memberId)
  const m = db.prepare('SELECT group_id FROM members WHERE id = ?').get(memberId)
  return !!m && m.group_id === req.user.group_id
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, {
    expiresIn: '7d',
  })
}

module.exports = { authRequired, requireLevel, signToken, ROLE_LEVEL, JWT_SECRET, canTouchMember }
