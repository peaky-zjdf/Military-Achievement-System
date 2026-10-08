const express = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { db, logOp, getSetting, setSetting } = require('../db')
const { authRequired, requireLevel, canTouchMember } = require('../middleware/auth')
const { allianceFilter, allianceFilterViaMember } = require('../middleware/alliance')
const { ocrImage, parseBattleReport, parseJourneyText, matchMember, compactText } = require('../services/ocr')
const { ocrJourneyImage } = require('../services/journeyOcr')
const { visionAnalyze, getVisionConfig } = require('../services/vision')
const { execFileSync } = require('child_process')
const { calcJourneyMerit, applyMerit, weekStart, getRules } = require('../services/merit')

const router = express.Router()
router.use(authRequired)

const UPLOAD_DIR = path.join(__dirname, '../data/journey')
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg'
    cb(null, `j-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
  },
})
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|bmp)$/i.test(file.mimetype)) cb(null, true)
    else cb(new Error('仅支持图片'))
  },
})

router.get('/uploads/:name', (req, res) => {
  const p = path.join(UPLOAD_DIR, path.basename(req.params.name))
  if (!fs.existsSync(p)) return res.status(404).end()
  res.sendFile(p)
})

/**
 * 上传个人征程截图 → 优先视觉模型 → 回退分区 OCR → 返回可编辑字段
 */
router.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择征程截图' })
  const imagePath = req.file.path
  try {
    // 1) 视觉模型（率土艺术字中文，远强于本地 OCR）
    let visionNote = ''
    try {
      const cfg = getVisionConfig()
      if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey) {
        visionNote = '视觉 API 未配置，已回退本地 OCR（中文识别较差，请先在系统设置配置视觉模型）'
      } else {
        const v = await visionAnalyze(imagePath, 'journey')
        if (v.ok && v.data) {
          const d = v.data
          // 兼容 page_type 标记或直接字段
          const isJourney =
            d.page_type === 'journey' ||
            d.page_type === '个人征程' ||
            d.war_merit_week != null ||
            d.war_merit_max_week != null ||
            d.kills_week != null
          if (isJourney) {
            const n = (x) => Number(x) || 0
            const parsed = {
              page_type: '个人征程',
              nickname: d.nickname || '',
              server: d.server || '',
              full_name: d.server && d.nickname ? `${d.server} | ${d.nickname}` : (d.nickname || ''),
              kills_day: n(d.kills_day), kills_week: n(d.kills_week),
              land_day: n(d.land_day), land_week: n(d.land_week),
              demolish_day: n(d.demolish_day), demolish_week: n(d.demolish_week),
              war_merit_day: n(d.war_merit_day), war_merit_week: n(d.war_merit_week),
              war_merit_max_week: n(d.war_merit_max_week),
              city_kill_day: n(d.city_kill_day), city_kill_week: n(d.city_kill_week),
              war_merit: n(d.war_merit_week) || n(d.war_merit_max_week),
              demolition: n(d.demolish_week) || n(d.demolish_day),
              type: '野战',
              battle: null,
              source: 'vision',
            }
            let member = null
            if (parsed.nickname) member = matchMember(db, parsed.nickname)
            if (member && req.user.alliance_id && member.alliance_id !== req.user.alliance_id) member = null
            if (!member && req.user.member_id) {
              member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.user.member_id)
              if (member && !parsed.nickname) parsed.nickname = member.nickname
            }
            return res.json({
              ok: true,
              filename: req.file.filename,
              file: `/api/journey/uploads/${req.file.filename}`,
              ocr: { text: v.raw || '', confidence: 95 },
              parsed,
              member: member
                ? { id: member.id, nickname: member.nickname, game_id: member.game_id }
                : null,
              preview: calcJourneyMerit(parsed),
              rules: getRules(),
              source: 'vision',
            })
          }
        } else {
          visionNote = '视觉识别失败：' + (v.error || '未知') + '，已回退本地 OCR'
        }
      }
    } catch (e) {
      console.error('journey vision fail', e.message)
      visionNote = '视觉识别异常：' + e.message + '，已回退本地 OCR'
    }

    // 2) 本地 OCR 回退
    const { text, confidence, parsed } = await ocrJourneyImage(imagePath)
    if (visionNote) parsed.vision_note = visionNote

    let member = null
    if (parsed.nickname) member = matchMember(db, parsed.nickname)
    if (member && req.user.alliance_id && member.alliance_id !== req.user.alliance_id) member = null
    if (!member && req.user.member_id) {
      member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.user.member_id)
      if (member && !parsed.nickname) parsed.nickname = member.nickname
    }

    const preview = calcJourneyMerit(parsed)

    res.json({
      ok: true,
      filename: req.file.filename,
      file: `/api/journey/uploads/${req.file.filename}`,
      ocr: { text, confidence: Math.round(confidence) },
      parsed,
      member: member
        ? { id: member.id, nickname: member.nickname, game_id: member.game_id }
        : null,
      preview,
      rules: getRules(),
      source: 'ocr',
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: '识别失败: ' + e.message })
  }
})

/**
 * 确认写入征程统计 + 计入军功
 */
router.post('/confirm', (req, res) => {
  const b = req.body || {}
  const isLeader = ['root', '盟主', '副盟', '团长'].includes(req.user.role)
  let mid = Number(b.member_id)
  if (!isLeader) {
    mid = req.user.member_id
    if (!mid) return res.status(400).json({ error: '账号未绑定成员' })
  }
  if (!mid) return res.status(400).json({ error: '请选择成员' })
  if (!canTouchMember(req, mid)) return res.status(403).json({ error: '团长只能为本团成员录入征程' })

  const af = allianceFilter(req, 'm')
  const member = db.prepare(`SELECT * FROM members m WHERE m.id = ?${af.sql}`).get(mid, ...af.params)
  if (!member) return res.status(404).json({ error: '成员不存在或不属于当前同盟' })

  const stats = {
    kills_day: Number(b.kills_day) || 0,
    kills_week: Number(b.kills_week) || 0,
    land_day: Number(b.land_day) || 0,
    land_week: Number(b.land_week) || 0,
    demolish_day: Number(b.demolish_day) || 0,
    demolish_week: Number(b.demolish_week) || 0,
    war_merit_day: Number(b.war_merit_day) || 0,
    war_merit_week: Number(b.war_merit_week) || 0,
    war_merit_max_week: Number(b.war_merit_max_week) || 0,
    city_kill_day: Number(b.city_kill_day) || 0,
    city_kill_week: Number(b.city_kill_week) || 0,
  }

  // at least one week-level metric
  const hasData =
    stats.war_merit_week || stats.demolish_week || stats.kills_week || stats.land_week || stats.city_kill_week ||
    stats.war_merit_max_week
  if (!hasData) return res.status(400).json({ error: '请至少填写一项「上周」数据' })

  const weekKey = b.week_key || weekStart()
  const calc = calcJourneyMerit(stats, b.source)
  const image = b.filename || ''
  const ocrText = b.ocr_text || ''
  const conf = Number(b.ocr_confidence) || 0

  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM journey_records WHERE member_id = ? AND week_key = ?').get(mid, weekKey)
    let delta = calc.total
    if (existing) {
      delta = calc.total - (existing.journey_merit || 0)
      db.prepare(`
        UPDATE journey_records SET
          nickname_ocr=?, server_ocr=?,
          kills_day=?, kills_week=?, land_day=?, land_week=?,
          demolish_day=?, demolish_week=?,
          war_merit_day=?, war_merit_week=?, war_merit_max_week=?,
          city_kill_day=?, city_kill_week=?,
          journey_merit=?, image_path=?, ocr_confidence=?, ocr_text=?,
          recorded_by=?, created_at=datetime('now','localtime')
        WHERE id=?
      `).run(
        b.nickname_ocr || '', b.server_ocr || '',
        stats.kills_day, stats.kills_week, stats.land_day, stats.land_week,
        stats.demolish_day, stats.demolish_week,
        stats.war_merit_day, stats.war_merit_week, stats.war_merit_max_week,
        stats.city_kill_day, stats.city_kill_week,
        calc.total, image, conf, ocrText,
        req.user.id, existing.id
      )
      if (delta !== 0) {
        applyMerit(mid, delta, delta >= 0 ? '收入' : '扣减', '征程', `征程周${weekKey}修正`, req.user.id, existing.id)
      }
    } else {
      const info = db.prepare(`
        INSERT INTO journey_records (
          member_id, week_key, nickname_ocr, server_ocr,
          kills_day, kills_week, land_day, land_week,
          demolish_day, demolish_week,
          war_merit_day, war_merit_week, war_merit_max_week,
          city_kill_day, city_kill_week,
          journey_merit, image_path, ocr_confidence, ocr_text, recorded_by
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        mid, weekKey, b.nickname_ocr || '', b.server_ocr || '',
        stats.kills_day, stats.kills_week, stats.land_day, stats.land_week,
        stats.demolish_day, stats.demolish_week,
        stats.war_merit_day, stats.war_merit_week, stats.war_merit_max_week,
        stats.city_kill_day, stats.city_kill_week,
        calc.total, image, conf, ocrText, req.user.id
      )
      applyMerit(mid, calc.total, '收入', '征程', `征程周${weekKey}`, req.user.id, info.lastInsertRowid)
    }
    // 征程武勋去重：将武勋组件写入 war_merit_records，标记 source='征程截图'
    const warAmt = stats.war_merit_week || stats.war_merit_max_week || 0
    if (warAmt > 0) {
      db.prepare(`
        INSERT INTO war_merit_records (member_id, amount, type, source, note, recorded_by)
        VALUES (?, ?, '野战', '征程截图', ?, ?)
      `).run(mid, warAmt, `征程周${weekKey}`, req.user.id)
    }
    return { delta, total: calc.total }
  })

  const result = tx()
  logOp(req.user.id, '录入征程统计', `member=${mid} week=${weekKey} merit=${result.total}`)
  res.json({
    ok: true,
    week_key: weekKey,
    journey_merit: result.total,
    delta: result.delta,
    parts: calc.parts,
    member: member.nickname,
  })
})

/** 征程列表 */
router.get('/list', (req, res) => {
  const { member_id = '', week_key = '' } = req.query
  const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20))
  let sql = `
    FROM journey_records j
    JOIN members m ON m.id = j.member_id
    LEFT JOIN groups g ON g.id = m.group_id
    WHERE 1=1
  `
  const params = []
  if (req.user.role === '成员') {
    sql += ' AND j.member_id = ?'
    params.push(req.user.member_id || 0)
  } else if (req.user.role === '团长') {
    sql += ' AND (m.group_id = ? OR j.member_id = ?)'
    params.push(req.user.group_id || 0, req.user.member_id || 0)
  }
  const af = allianceFilter(req, 'm')
  if (af.sql) {
    sql += af.sql
    params.push(...af.params)
  }
  if (member_id) {
    sql += ' AND j.member_id = ?'
    params.push(member_id)
  }
  if (week_key) {
    sql += ' AND j.week_key = ?'
    params.push(week_key)
  }
  let selectSql = `SELECT j.*, m.nickname, m.game_id, g.name as group_name ${sql}`
  selectSql += ' ORDER BY j.week_key DESC, j.journey_merit DESC'
  if (!hasPagination) {
    const rows = db.prepare(selectSql).all(...params)
    return res.json(rows)
  }
  const total = db.prepare(`SELECT COUNT(*) as total ${sql}`).get(...params).total
  const data = db.prepare(`${selectSql} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize)
  const totalPages = Math.ceil(total / pageSize)
  res.json({ data, total, page, pageSize, totalPages })
})

/** 周排行：按征程周军功 */
router.get('/rank', (req, res) => {
  const week = req.query.week || weekStart()
  const hideDormant = req.query.hideDormant === '1'
  let filter = "m.status != '离盟'"
  if (hideDormant) filter += " AND m.status != '休眠'"
  const af = allianceFilter(req, 'm')
  if (af.sql) filter += af.sql
  const rows = db.prepare(`
    SELECT m.id, m.nickname, m.game_id, m.status, m.power, m.total_merit, m.available_merit,
           g.name as group_name,
           COALESCE(j.journey_merit, 0) as journey_merit,
           COALESCE(j.war_merit_week, 0) as war_merit_week,
           COALESCE(j.war_merit_max_week, 0) as war_merit_max_week,
           COALESCE(j.demolish_week, 0) as demolish_week,
           COALESCE(j.kills_week, 0) as kills_week,
           COALESCE(j.land_week, 0) as land_week,
           COALESCE(j.city_kill_week, 0) as city_kill_week,
           j.week_key
    FROM members m
    LEFT JOIN groups g ON g.id = m.group_id
    LEFT JOIN journey_records j ON j.member_id = m.id AND j.week_key = ?
    WHERE ${filter}
    ORDER BY journey_merit DESC, m.total_merit DESC
  `).all(week, ...af.params)
  res.json({ week, list: rows })
})

/** 各团汇总 */
router.get('/group-summary', (req, res) => {
  const week = req.query.week || weekStart()
  const af = allianceFilter(req, 'm')
  const memberCountAf = allianceFilter(req, 'mm')
  const rows = db.prepare(`
    SELECT g.id, g.name,
      COUNT(j.id) as submitted,
      (SELECT COUNT(*) FROM members mm WHERE mm.group_id = g.id AND mm.status != '离盟'${memberCountAf.sql}) as member_count,
      COALESCE(SUM(j.journey_merit),0) as total_journey_merit,
      COALESCE(SUM(j.war_merit_week),0) as total_war,
      COALESCE(SUM(j.demolish_week),0) as total_demolish,
      COALESCE(SUM(j.kills_week),0) as total_kills,
      COALESCE(SUM(j.land_week),0) as total_land,
      COALESCE(SUM(j.city_kill_week),0) as total_city_kills
    FROM groups g
    LEFT JOIN members m ON m.group_id = g.id AND m.status != '离盟'${af.sql}
    LEFT JOIN journey_records j ON j.member_id = m.id AND j.week_key = ?
    GROUP BY g.id
    ORDER BY total_journey_merit DESC
  `).all(...af.params, week, ...memberCountAf.params)
  res.json({ week, groups: rows })
})

router.get('/rules', (req, res) => {
  res.json(getRules())
})

router.put('/rules', requireLevel(4), (req, res) => {
  const keys = [
    'journey_war_per_point', 'journey_demolish_per_point', 'journey_kill_per_point',
    'journey_land_per_point', 'journey_city_kill_per_point', 'journey_source',
  ]
  for (const k of keys) {
    if (req.body[k] !== undefined) setSetting(k, req.body[k])
  }
  logOp(req.user.id, '修改征程折算规则')
  res.json({ ok: true, rules: getRules() })
})

module.exports = router
