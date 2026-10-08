const express = require('express')
const nodemailer = require('nodemailer')
const { db, getSetting, setSetting, logOp, getAllianceSetting, setAllianceSetting } = require('../db')
const { authRequired, requireLevel } = require('../middleware/auth')
const { maskKey, maskFromReq } = require('../services/utils')

const { allianceFilter } = require('../middleware/alliance')

const router = express.Router()
router.use(authRequired)

/** 读同盟级设置，root 用户 fallback 到全局设置 */
function gSetting(req, key, def = '') {
  const aid = req.user?.alliance_id
  if (aid) return getAllianceSetting(aid, key, def)
  // root 或无同盟 fallback 到全局
  return getSetting(key, def)
}
function gSetSetting(req, key, value) {
  const aid = req.user?.alliance_id
  if (aid) return setAllianceSetting(aid, key, value)
  return setSetting(key, value)
}

/** 邮箱配置（盟主） */
router.get('/config', requireLevel(4), (req, res) => {
  const g = (k) => gSetting(req, k, '')
  res.json({
    smtp: {
      host: g('smtp_host'),
      port: g('smtp_port') || '465',
      secure: g('smtp_secure') !== '0',
      user: g('smtp_user'),
      pass: maskKey(g('smtp_pass')),
      has_pass: !!g('smtp_pass'),
      from_name: g('smtp_from_name') || '同盟军功系统',
      enabled: g('smtp_enabled') === '1',
    },
    imap: {
      host: g('imap_host'),
      port: g('imap_port') || '993',
      secure: g('imap_secure') !== '0',
      user: g('imap_user'),
      pass: maskKey(g('imap_pass')),
      has_pass: !!g('imap_pass'),
      enabled: g('imap_enabled') === '1',
    },
  })
})

router.put('/config', requireLevel(4), (req, res) => {
  const b = req.body || {}
  const s = b.smtp || {}
  const i = b.imap || {}
  if (s.host !== undefined) gSetSetting(req, 'smtp_host', s.host || '')
  if (s.port !== undefined) gSetSetting(req, 'smtp_port', s.port || '465')
  if (s.secure !== undefined) gSetSetting(req, 'smtp_secure', s.secure ? '1' : '0')
  if (s.user !== undefined) gSetSetting(req, 'smtp_user', s.user || '')
  if (s.pass !== undefined) gSetSetting(req, 'smtp_pass', maskFromReq(s.pass, gSetting(req, 'smtp_pass', '')))
  if (s.from_name !== undefined) gSetSetting(req, 'smtp_from_name', s.from_name || '同盟军功系统')
  if (s.enabled !== undefined) gSetSetting(req, 'smtp_enabled', s.enabled ? '1' : '0')

  if (i.host !== undefined) gSetSetting(req, 'imap_host', i.host || '')
  if (i.port !== undefined) gSetSetting(req, 'imap_port', i.port || '993')
  if (i.secure !== undefined) gSetSetting(req, 'imap_secure', i.secure ? '1' : '0')
  if (i.user !== undefined) gSetSetting(req, 'imap_user', i.user || '')
  if (i.pass !== undefined) gSetSetting(req, 'imap_pass', maskFromReq(i.pass, gSetting(req, 'imap_pass', '')))
  if (i.enabled !== undefined) gSetSetting(req, 'imap_enabled', i.enabled ? '1' : '0')

  logOp(req.user.id, '修改邮箱配置')
  res.json({ ok: true })
})

/** 测试 SMTP 连通 */
router.post('/test', requireLevel(4), async (req, res) => {
  const host = gSetting(req, 'smtp_host')
  const user = gSetting(req, 'smtp_user')
  const pass = gSetting(req, 'smtp_pass')
  if (!host || !user || !pass) return res.json({ ok: false, error: '请先填写 SMTP 主机/账号/密码并保存' })
  try {
    const t = nodemailer.createTransport({
      host,
      port: Number(gSetting(req, 'smtp_port', '465')),
      secure: gSetting(req, 'smtp_secure', '1') !== '0',
      auth: { user, pass },
      connectionTimeout: 10000,
    })
    await t.verify()
    res.json({ ok: true, message: 'SMTP 连通正常' })
  } catch (e) {
    res.json({ ok: false, error: e.message || '连接失败' })
  }
})

function getTransport(req) {
  return nodemailer.createTransport({
    host: gSetting(req, 'smtp_host'),
    port: Number(gSetting(req, 'smtp_port', '465')),
    secure: gSetting(req, 'smtp_secure', '1') !== '0',
    auth: {
      user: gSetting(req, 'smtp_user'),
      pass: gSetting(req, 'smtp_pass'),
    },
    connectionTimeout: 15000,
  })
}

/** 发送邮件（单人/多人） */
router.post('/send', requireLevel(3), async (req, res) => {
  if (gSetting(req, 'smtp_enabled') !== '1') return res.status(400).json({ error: '请先启用 SMTP 邮箱服务' })
  const { to = [], subject = '', text = '', html = '', member_ids = [] } = req.body || {}

  let recipients = Array.isArray(to) ? to.filter(Boolean) : []
  // 按成员ID收集邮箱（只限本同盟）
  if (member_ids?.length) {
    const af = allianceFilter(req, 'members')
    const ph = member_ids.map(() => '?').join(',')
    const rows = db.prepare(`SELECT email, nickname FROM members WHERE id IN (${ph}) AND email != ''${af.sql}`).all(...member_ids, ...af.params)
    recipients = recipients.concat(rows.map((r) => r.email))
  }
  recipients = [...new Set(recipients)]
  if (!recipients.length) return res.status(400).json({ error: '没有有效收件邮箱' })
  if (!subject) return res.status(400).json({ error: '请填写邮件主题' })

  const fromName = gSetting(req, 'smtp_from_name', '同盟军功系统')
  const fromUser = gSetting(req, 'smtp_user')

  try {
    const t = getTransport(req)
    const info = await t.sendMail({
      from: `"${fromName}" <${fromUser}>`,
      to: recipients.join(', '),
      subject,
      text: text || '',
      html: html || (text ? `<div style="white-space:pre-wrap;font-family:sans-serif">${text}</div>` : ''),
    })
    logOp(req.user.id, '发送邮件', `to=${recipients.length} subject=${subject}`)
    res.json({ ok: true, count: recipients.length, messageId: info.messageId })
  } catch (e) {
    res.status(400).json({ error: '发送失败：' + (e.message || '') })
  }
})

/** 获取有邮箱的成员（供选择收件人） */
router.get('/recipients', (req, res) => {
  const af = allianceFilter(req, 'members')
  const rows = db.prepare(`
    SELECT id, nickname, game_id, email, group_id FROM members
    WHERE status != '离盟' AND email != ''${af.sql} ORDER BY nickname
  `).all(...af.params)
  res.json(rows)
})

module.exports = router
