const express = require('express')
const cors = require('cors')
const compression = require('compression')
const path = require('path')
const fs = require('fs')
const bcrypt = require('bcryptjs')
const crypto = require('crypto')
const { db, getSetting, setSetting, logOp } = require('./db')
const { ensureLicensed } = require('./services/license')

const app = express()
const PORT = process.env.PORT || 3789

// Gzip 压缩（减少传输体积 60-80%）
app.use(compression({ threshold: 1024 }))

// 安全响应头
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  next()
})

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// License：打包版未激活时拦截业务 API
const LICENSE_OPEN = new Set([
  '/api/license/status',
  '/api/license/activate',
  '/api/license/machine-id',
  '/api/settings/brand',
  '/api/apply',
])
app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next()
  if (LICENSE_OPEN.has(req.path)) return next()
  const st = ensureLicensed()
  if (st.ok) return next()
  return res.status(402).json({
    error: st.error || '软件未激活',
    code: 'LICENSE_REQUIRED',
    machineId: st.machineId,
  })
})

// API routes
app.use('/api/license', require('./routes/license'))
app.use('/api/auth', require('./routes/auth'))
app.use('/api/members', require('./routes/members'))
app.use('/api/city', require('./routes/city'))
app.use('/api/merit', require('./routes/merit'))
app.use('/api/shop', require('./routes/shop'))
app.use('/api/rank', require('./routes/rank'))
app.use('/api/report', require('./routes/report'))
app.use('/api/battle', require('./routes/battle'))
app.use('/api/awards', require('./routes/awards'))
app.use('/api/settings', require('./routes/settings'))
app.use('/api/dashboard', require('./routes/dashboard'))
app.use('/api/merit', require('./routes/ocr'))
app.use('/api/journey', require('./routes/journey'))
app.use('/api/enemies', require('./routes/enemies'))
app.use('/api/reportshot', require('./routes/reportshot'))
app.use('/api/features', require('./routes/features'))
app.use('/api/ai', require('./routes/ai'))
app.use('/api/email', require('./routes/email'))

// public: list alliances for apply form
app.get('/api/alliances-list', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.id, a.name, u.username as owner_name
      FROM alliances a
      LEFT JOIN users u ON u.id = a.owner_user_id AND u.role = '盟主'
      WHERE a.status = '正常'
      ORDER BY a.id
    `).all()
    res.json(rows)
  } catch (e) {
    res.status(500).json({ error: '获取同盟列表失败' })
  }
})

// public apply (no auth)
app.post('/api/apply', (req, res) => {
  const { game_id, nickname, contact = '', season_info = '', obey_manage = 1, email = '', alliance_id = null } = req.body || {}
  if (!game_id || !nickname) return res.status(400).json({ error: '游戏ID和昵称必填' })
  try {
    const info = db.prepare(`
      INSERT INTO applications (game_id, nickname, contact, season_info, obey_manage, email, alliance_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(game_id, nickname, contact, season_info, obey_manage ? 1 : 0, email, alliance_id || null)
    res.json({ id: info.lastInsertRowid, message: '申请已提交，请等待审核' })
  } catch (e) {
    res.status(500).json({ error: '提交失败' })
  }
})

// static frontend（打包后从 snapshot 或 exe 旁 public 读取）
function resolvePublicDir() {
  const portable = process.pkg || process.env.MERIT_PORTABLE === '1'
  const candidates = [
    path.join(__dirname, 'public'),
    portable ? path.join(path.dirname(process.execPath), 'public') : null,
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'index.html'))) return p
  }
  return null
}
const publicDir = resolvePublicDir()
if (publicDir) {
  // 独立页面路由
  app.get('/test-video', (req, res) => { res.sendFile(path.join(publicDir, 'test-video.html')) })
  app.get('/batch-upload', (req, res) => {
    res.sendFile(path.join(publicDir, 'batch-upload.html'))
  })
  app.get('/group-manage', (req, res) => {
    res.sendFile(path.join(publicDir, 'group-manage.html'))
  })

  // 静态资源：带 hash 的文件名长期缓存，其他文件不缓存
  app.use(express.static(publicDir, {
    maxAge: '1y',
    immutable: true,
    setHeaders: (res, filePath) => {
      // 只对带 hash 的资源文件设置长期缓存
      if (/\/assets\/index-[a-zA-Z0-9_-]+\.(js|css)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate')
      }
    },
  }))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next()
    res.setHeader('Cache-Control', 'no-cache, must-revalidate')
    res.sendFile(path.join(publicDir, 'index.html'))
  })
}

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: err.message || '服务器错误' })
})

// 首次空库：初始化分组/商品/赛季；无root时创建 root，随机密码仅打印一次
function ensureSeed() {
  const groupCount = db.prepare('SELECT COUNT(*) as c FROM groups').get().c
  if (groupCount === 0) {
    db.prepare("INSERT INTO groups (name) VALUES ('一团')").run()
    db.prepare("INSERT INTO groups (name) VALUES ('二团')").run()
    db.prepare("INSERT INTO groups (name) VALUES ('三团')").run()

    const goods = [
      ['征服名额排队优先权', '虚拟', '赛季征服名额优先排队', 5000, 3, 1, 0],
      ['资源包分配优先', '虚拟', '盟内资源补给优先发放', 2000, 10, 1, 0],
      ['免扣分券', '虚拟', '一次打城缺勤免扣军功', 1500, 5, 1, 0],
      ['开荒支援', '虚拟', '盟内高战帮忙打地', 3000, 5, 1, 1],
      ['配将咨询', '虚拟', '战报分析与配将建议', 800, 20, 0, 0],
      ['盟内专属头衔', '虚拟', '群内特殊标识头衔', 1200, 8, 1, 0],
      ['主题鼠标垫', '实物', '率土主题鼠标垫', 8000, 5, 1, 1],
      ['奶茶红包', '实物', '盟内自采购奶茶', 2500, 10, 1, 1],
    ]
    for (const g of goods) {
      db.prepare(`
        INSERT INTO goods (name, type, description, merit_cost, stock, per_user_limit, need_audit)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(g[0], g[1], g[2], g[3], g[4], g[5], g[6])
    }
    db.prepare(`
      INSERT INTO seasons (name, start_date, active) VALUES ('S1 赛季', date('now'), 1)
    `).run()
  }

  // 检查是否已有 root 用户
  const rootCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'root'").get().c
  if (rootCount > 0) return

  const password = crypto.randomBytes(6).toString('base64url')
  const hash = bcrypt.hashSync(password, 10)
  // root 是系统管理员，不关联任何成员和同盟
  const username = db.prepare('SELECT id FROM users WHERE username = ?').get('root')
    ? 'root_' + Date.now().toString(36)
    : 'root'
  db.prepare(`
    INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'root')
  `).run(username, hash)

  const annCount = db.prepare('SELECT COUNT(*) as c FROM announcements').get().c
  if (annCount === 0) {
    db.prepare(`
      INSERT INTO announcements (title, content, type, pinned, created_by)
      VALUES ('欢迎使用军功系统', '本系统用于同盟内部军功统计与奖励分配。军功仅为盟内积分，非游戏资产，无法兑换现金。请尽快修改初始密码。', '公告', 1, 1)
    `).run()
  }

  console.log('========================================')
  console.log('已创建初始 root 管理员账号（仅此一次显示）')
  console.log('用户名: ' + username)
  console.log('密  码: ' + password)
  console.log('请立即登录并修改密码，勿泄露此密码。')
  console.log('========================================')
}

ensureSeed()

app.listen(PORT, () => {
  console.log(`军功系统服务已启动: http://127.0.0.1:${PORT}`)
})
