const express = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { db, logOp } = require('../db')
const { authRequired } = require('../middleware/auth')
const { ocrImage, ocrChiImage, ocrMany, parseBattleReport, parseJourneyText, matchMember, compactText } = require('../services/ocr')
const { ocrJourneyImage } = require('../services/journeyOcr')
const { visionAnalyze } = require('../services/vision')
const { pythonExe } = require('../services/python')
const { calcWarMerit, applyMerit } = require('../services/merit')

const router = express.Router()
router.use(authRequired)

const UPLOAD_DIR = path.join(__dirname, '../data/uploads')
const CROP_DIR = path.join(__dirname, '../data/battle-crops')
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
if (!fs.existsSync(CROP_DIR)) fs.mkdirSync(CROP_DIR, { recursive: true })

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png'
    const safe = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext
    cb(null, safe)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|bmp|gif)$/i.test(file.mimetype)) cb(null, true)
    else cb(new Error('仅支持图片文件'))
  },
})

/** Crop battle-report strips and OCR both sides. */
async function ocrBattleReport(imagePath) {
  const outDir = path.join(CROP_DIR, Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5))
  fs.mkdirSync(outDir, { recursive: true })
  try {
    execFileSync(pythonExe(), [path.join(__dirname, '../crop_bright.py'), imagePath, outDir], {
      timeout: 20000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    console.error('battle crop fail', e.message)
  }

  const parts = []
  let conf = 0
  let n = 0

  const regionKeys = [
    'battle_center', 'battle_name',
    'battle_left_name', 'battle_left_troops', 'battle_left_ally', 'battle_left_gens',
    'battle_right_name', 'battle_right_troops', 'battle_right_ally', 'battle_right_gens',
    'footer', 'footer_name',
  ]
  const regionPaths = regionKeys
    .map((k) => ({ key: k, p: path.join(outDir, `b-${k}.png`) }))
    .filter((x) => fs.existsSync(x.p))

  const chiKeys = [
    'battle_name', 'battle_center',
    'battle_left_name', 'battle_left_ally', 'battle_left_gens',
    'battle_right_name', 'battle_right_ally', 'battle_right_gens',
  ]

  const [engRes, fullRes, chiList] = await Promise.all([
    ocrMany(regionPaths.map((x) => x.p)),
    ocrImage(imagePath).catch(() => ({ text: '', confidence: 0 })),
    Promise.all(
      chiKeys.map(async (k) => {
        const p = path.join(outDir, `b-${k}.png`)
        if (!fs.existsSync(p)) return { key: k, text: '' }
        const r = await ocrChiImage(p)
        return { key: k, text: r.text || '' }
      })
    ),
  ])

  for (const c of chiList) {
    if (c.text) {
      parts.push(`[REGION:${c.key}_chi]`)
      parts.push(c.text)
    } else {
      console.error('chi empty', c.key)
    }
  }
  regionPaths.forEach((x, i) => {
    const r = engRes[i] || { text: '', confidence: 0 }
    parts.push(`[REGION:${x.key}]`)
    parts.push(r.text || '')
    conf += r.confidence || 0
    n++
  })
  if (fullRes.text) {
    parts.push('[REGION:full]')
    parts.push(fullRes.text)
    conf += fullRes.confidence || 0
    n++
  }

  const combined = parts.join('\n')
  const parsed = parseBattleReport(combined, { page: 'battle' })

  return { text: combined, confidence: n ? Math.round(conf / n) : 0, parsed }
}

router.get('/uploads/:name', (req, res) => {
  const p = path.join(UPLOAD_DIR, path.basename(req.params.name))
  if (!fs.existsSync(p)) return res.status(404).json({ error: '文件不存在' })
  res.sendFile(p)
})

/** 识别单张上传文件，返回统一结构 */
async function processOneUpload(file, user) {
  const imagePath = file.path

  // 1) 优先视觉模型
  try {
    const v = await visionAnalyze(imagePath, 'auto')
    if (v.ok && v.data) {
      const d = v.data
      let parsed = null
      if (d.page_type === 'journey') {
        const n = (x) => Number(x) || 0
        parsed = {
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
        }
      } else if (d.page_type === 'battle') {
        const gens = (d.generals || []).map((g) => ({
          slot: g.slot || '', name: g.name || '', level: Number(g.level) || 0,
          troops: Number(g.troops) || 0, red_stars: Number(g.red_stars) || 0,
          treasures: g.treasures || '',
          skills: Array.isArray(g.skills) ? g.skills.join('、') : (g.skills || ''),
          side: g.side || '',
        }))
        parsed = {
          page_type: '战报',
          nickname: d.battle?.our_player || d.our_player || '',
          full_name: d.battle?.our_player || d.our_player || '',
          server: d.battle?.our_alliance || d.our_alliance || '',
          war_merit: Number(d.battle?.war_merit || d.war_merit) || 0,
          demolition: 0,
          type: '野战',
          battle: {
            result: d.battle?.result || d.result || '',
            war_merit: Number(d.battle?.war_merit || d.war_merit) || 0,
            our: { player: d.battle?.our_player || d.our_player || '', alliance: d.battle?.our_alliance || d.our_alliance || '', generals: gens.filter((g) => g.side !== '敌方') },
            enemy: { player: d.battle?.enemy_player || d.enemy_player || '', alliance: d.battle?.enemy_alliance || d.enemy_alliance || '', generals: gens.filter((g) => g.side === '敌方') },
          },
        }
      }
      if (parsed) {
        let member = null
        if (parsed.nickname) member = matchMember(db, parsed.nickname)
        if (!member && user.member_id) {
          member = db.prepare('SELECT * FROM members WHERE id = ?').get(user.member_id)
          if (member && !parsed.nickname) parsed.nickname = member.nickname
        }

        // 自动保存阵容到阵容库
        let lineupId = null
        if (d.page_type === 'battle' && parsed.battle) {
          try {
            const ourGens = parsed.battle.our?.generals || []
            const enemyGens = parsed.battle.enemy?.generals || []
            const playerName = parsed.battle.our?.player || ''
            const alliance = parsed.battle.our?.alliance || ''

            if (ourGens.length > 0) {
              const info = db.prepare(`INSERT INTO battle_lineups (side, player_name, alliance, note, image_path, ocr_text, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                .run('我方', playerName, alliance, '战报自动入库', file.filename, v.raw || '', user.id)
              lineupId = info.lastInsertRowid
              for (const g of ourGens) {
                if (!g?.name) continue
                db.prepare(`INSERT INTO battle_lineup_generals (lineup_id, slot, name, level, camp, red_stars, treasures, skills, gems, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                  .run(lineupId, g.slot || '', g.name, Number(g.level) || 0, g.camp || '', Number(g.red_stars) || 0, g.treasures || '', g.skills || '', '', '')
              }
            }

            if (enemyGens.length > 0) {
              const ePlayer = parsed.battle.enemy?.player || ''
              const eAlliance = parsed.battle.enemy?.alliance || ''
              if (ePlayer) {
                const eInfo = db.prepare(`INSERT INTO battle_lineups (side, player_name, alliance, note, image_path, ocr_text, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                  .run('敌方', ePlayer, eAlliance, '战报自动入库', file.filename, v.raw || '', user.id)
                for (const g of enemyGens) {
                  if (!g?.name) continue
                  db.prepare(`INSERT INTO battle_lineup_generals (lineup_id, slot, name, level, camp, red_stars, treasures, skills, gems, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(eInfo.lastInsertRowid, g.slot || '', g.name, Number(g.level) || 0, g.camp || '', Number(g.red_stars) || 0, g.treasures || '', g.skills || '', '', '')
                }
                // 同步敌对情报
                const exist = db.prepare('SELECT id FROM enemies WHERE nickname = ?').get(ePlayer)
                let enemyId
                if (exist) {
                  enemyId = exist.id
                  db.prepare("UPDATE enemies SET alliance=?, last_seen=datetime('now','localtime') WHERE id=?").run(eAlliance, enemyId)
                  db.prepare('DELETE FROM enemy_generals WHERE enemy_id=?').run(enemyId)
                } else {
                  enemyId = db.prepare("INSERT INTO enemies (nickname, alliance, threat_level, note, last_seen, created_by) VALUES (?, ?, '中', ?, datetime('now','localtime'), ?)")
                    .run(ePlayer, eAlliance, '战报自动入库', user.id).lastInsertRowid
                }
                for (const g of enemyGens) {
                  if (!g?.name) continue
                  db.prepare("INSERT INTO enemy_generals (enemy_id, slot, name, level, troops, red_stars, treasures, skills, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                    .run(enemyId, g.slot || '', g.name, Number(g.level) || 0, 0, Number(g.red_stars) || 0, g.treasures || '', g.skills || '', '')
                }
              }
            }
            logOp(user.id, '战报自动入库阵容', `${playerName} 我方${ourGens.length} 敌方${enemyGens.length}`)
          } catch (e) {
            console.error('自动保存阵容失败:', e.message)
          }
        }

        const warAmt = Number(parsed.war_merit || 0)
        return {
          ok: true,
          filename: file.filename,
          original: file.originalname || '',
          file: `/api/merit/uploads/${file.filename}`,
          ocr: { text: v.raw || '', confidence: 95 },
          parsed: { ...parsed, war_merit: warAmt, preview_merit: warAmt ? calcWarMerit(warAmt, parsed.type) : 0 },
          member: member ? { id: member.id, nickname: member.nickname, game_id: member.game_id } : null,
          source: 'vision',
        }
      }
    }
  } catch (e) {
    console.error('vision upload fail', e.message)
  }

  // 2) 本地 OCR 回退
  const sniff = await ocrImage(imagePath)
  const sniffText = compactText(sniff.text || '')
  const looksBattle = /我方战败|我方战胜|战况回放|武勋\s*[+＋]|战报详情/.test(sniffText)
  const looksJourney = /个人征程|单日最多灭敌|单周最高武勋|上周武勋|上周拆除|单日最高抢夺土地/.test(sniffText)

  let parsed
  let text = sniff.text || ''
  let confidence = Math.round(sniff.confidence || 0)

  if (looksBattle || !looksJourney) {
    const battle = await ocrBattleReport(imagePath)
    if (battle.parsed?.war_merit || looksBattle) {
      parsed = battle.parsed
      text = battle.text || text
      confidence = Math.max(confidence, battle.confidence || 0)
    }
  }

  if (!parsed || (!parsed.war_merit && looksJourney)) {
    const journey = await ocrJourneyImage(imagePath)
    const jp = journey.parsed
    if (!parsed) {
      parsed = jp
      text = journey.text || text
      confidence = Math.max(confidence, journey.confidence || 0)
    } else {
      for (const k of Object.keys(jp)) {
        if ((parsed[k] === 0 || parsed[k] == null) && jp[k]) parsed[k] = jp[k]
      }
    }
    if (parsed.page_type === '个人征程' || looksJourney) {
      if (!parsed.war_merit) {
        parsed.war_merit = parsed.war_merit_week || parsed.war_merit_max_week || 0
      }
      if (!parsed.demolition) {
        parsed.demolition = parsed.demolish_week || parsed.demolish_day || 0
      }
    }
  }

  let member = null
  if (parsed.nickname) member = matchMember(db, parsed.nickname)
  if (!member && user.member_id) {
    member = db.prepare('SELECT * FROM members WHERE id = ?').get(user.member_id)
    if (member && !parsed.nickname) parsed.nickname = member.nickname
  }

  const warAmt = Number(parsed.war_merit || parsed.war_merit_week || parsed.war_merit_max_week || 0)
  const previewMerit = warAmt ? calcWarMerit(warAmt, parsed.type) : 0

  return {
    ok: true,
    filename: file.filename,
    original: file.originalname || '',
    file: `/api/merit/uploads/${file.filename}`,
    ocr: { text, confidence: Math.round(confidence) },
    parsed: { ...parsed, war_merit: warAmt || parsed.war_merit || 0, preview_merit: previewMerit },
    member: member
      ? { id: member.id, nickname: member.nickname, game_id: member.game_id }
      : null,
  }
}

/**
 * Upload image + OCR parse.
 * Auto-detects 战报 vs 个人征程 and extracts the right fields.
 */
router.post('/ocr/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择图片' })
  try {
    const result = await processOneUpload(req.file, req.user)
    logOp(req.user.id, '上传战报图片OCR', req.file.filename)
    res.json(result)
  } catch (e) {
    console.error('OCR error', e)
    res.status(500).json({ error: '图片识别失败：' + e.message })
  }
})

/**
 * 多图批量识别（最多 12 张）。串行处理，避免打满 CPU。
 */
router.post('/ocr/upload-multi', upload.array('images', 12), async (req, res) => {
  const files = req.files || []
  if (!files.length) return res.status(400).json({ error: '请选择至少一张图片' })
  const results = []
  for (const f of files) {
    try {
      results.push(await processOneUpload(f, req.user))
    } catch (e) {
      results.push({
        ok: false,
        filename: f.filename,
        original: f.originalname || '',
        error: e.message,
        parsed: {},
        member: null,
      })
    }
  }
  logOp(req.user.id, '批量上传战报OCR', `n=${files.length}`)
  res.json({ ok: true, count: results.length, results })
})

/** 批量确认：items = [{filename, member_id, war_merit, demolition, type, note}] */
router.post('/ocr/confirm-multi', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  if (!items.length) return res.status(400).json({ error: '无待确认数据' })
  if (items.length > 20) return res.status(400).json({ error: '一次最多确认 20 条' })

  const isLeader = ['root', '盟主', '副盟', '团长'].includes(req.user.role)
  const out = []
  const tx = db.transaction(() => {
    for (const it of items) {
      let mid = Number(it.member_id)
      if (!isLeader) {
        mid = req.user.member_id
        if (!mid) {
          out.push({ filename: it.filename, ok: false, error: '账号未绑定成员' })
          continue
        }
      }
      if (!mid) {
        out.push({ filename: it.filename, ok: false, error: '请选择成员' })
        continue
      }
      if (req.user.role === '团长') {
        const t = db.prepare('SELECT group_id FROM members WHERE id = ?').get(mid)
        if (!t || t.group_id !== req.user.group_id) {
          out.push({ filename: it.filename, ok: false, error: '团长只能为本团成员录入' })
          continue
        }
      }
      const amount = Number(it.war_merit) || 0
      if (amount <= 0) {
        out.push({ filename: it.filename, ok: false, error: '武勋必须大于 0' })
        continue
      }
      if (it.filename) {
        const dup = db.prepare('SELECT id FROM war_merit_records WHERE note LIKE ? LIMIT 1').get(`%${it.filename}%`)
        if (dup) {
          out.push({ filename: it.filename, ok: false, error: '该截图已录入过' })
          continue
        }
      }
      const member = db.prepare('SELECT id, nickname FROM members WHERE id = ?').get(mid)
      if (!member) {
        out.push({ filename: it.filename, ok: false, error: '成员不存在' })
        continue
      }
      const type = it.type || '野战'
      const merit = calcWarMerit(amount, type)
      const note = `${it.note || ''}${it.filename ? ' | ' + it.filename : ''}`
      // 征程类型自动标记 source
      const itemSource = (/journey|征程/i.test(it.source || it.page_type || '')) ? '征程截图' : '战报截图OCR'
      db.prepare(`
        INSERT INTO war_merit_records (member_id, amount, type, source, note, recorded_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(mid, amount, type, itemSource, note, req.user.id)
      applyMerit(mid, merit, '收入', '武勋', `${type}武勋${amount}(截图)`, req.user.id)
      const demo = Number(it.demolition) || 0
      if (demo > 0) {
        const { getRules } = require('../services/merit')
        const r = getRules()
        const dMerit = Math.round(demo * r.demolition_per_point)
        if (dMerit > 0) applyMerit(mid, dMerit, '收入', '打城', `截图拆迁${demo}`, req.user.id)
      }
      out.push({ filename: it.filename, ok: true, merit, member: member.nickname })
    }
  })
  try {
    tx()
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  const okN = out.filter((x) => x.ok).length
  logOp(req.user.id, '批量确认OCR战报', `ok=${okN}/${out.length}`)
  res.json({ ok: true, results: out, okCount: okN })
})

/**
 * Confirm OCR result -> write war merit (and optional demolition note).
 * 同一 filename 只允许确认一次，防止重复入账。
 */
router.post('/ocr/confirm', (req, res) => {
  const {
    member_id, war_merit, type = '野战', demolition = 0,
    note = '', filename = '', source = '战报截图OCR',
  } = req.body || {}

  // 征程类型自动标记 source
  const effectiveSource = (/journey|征程/i.test(source)) ? '征程截图' : source

  const isLeader = ['root', '盟主', '副盟', '团长'].includes(req.user.role)
  let mid = Number(member_id)
  if (!isLeader) {
    mid = req.user.member_id
    if (!mid) return res.status(400).json({ error: '账号未绑定成员' })
  }
  if (!mid) return res.status(400).json({ error: '请选择成员' })

  // 团长只能给本团录
  if (req.user.role === '团长') {
    const t = db.prepare('SELECT group_id FROM members WHERE id = ?').get(mid)
    if (!t || t.group_id !== req.user.group_id) {
      return res.status(403).json({ error: '团长只能为本团成员录入' })
    }
  }

  const amount = Number(war_merit) || 0
  if (amount <= 0) return res.status(400).json({ error: '武勋必须大于 0' })

  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(mid)
  if (!member) return res.status(404).json({ error: '成员不存在' })

  // 防重复：同一截图文件不可二次入账
  if (filename) {
    const dup = db.prepare(`
      SELECT id FROM war_merit_records WHERE note LIKE ? LIMIT 1
    `).get(`%${filename}%`)
    if (dup) return res.status(400).json({ error: '该截图已录入过，请勿重复提交' })
  }

  const merit = calcWarMerit(amount, type)
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO war_merit_records (member_id, amount, type, source, note, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(mid, amount, type, effectiveSource, `${note}${filename ? ' | ' + filename : ''}`, req.user.id)
    applyMerit(mid, merit, '收入', '武勋', `${type}武勋${amount}(截图)`, req.user.id)

    const demoMerit = Number(demolition) || 0
    if (demoMerit > 0) {
      const { getRules } = require('../services/merit')
      const r = getRules()
      const dMerit = Math.round(demoMerit * r.demolition_per_point)
      if (dMerit > 0) {
        applyMerit(mid, dMerit, '收入', '打城', `截图拆迁${demoMerit}`, req.user.id)
      }
    }
  })
  try {
    tx()
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  logOp(req.user.id, '确认OCR战报', `member=${mid} war=${amount}`)
  res.json({ ok: true, merit, member: member.nickname })
})

router.get('/ocr/history', (req, res) => {
  const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20))
  const where = "WHERE o.action LIKE '%OCR%' OR o.action LIKE '%截图%'"
  const selectSql = `
    SELECT o.*, u.username, m.nickname
    FROM op_logs o
    LEFT JOIN users u ON u.id = o.user_id
    LEFT JOIN members m ON m.id = u.member_id
    ${where}
    ORDER BY o.created_at DESC
  `
  if (!hasPagination) {
    const rows = db.prepare(selectSql).all()
    return res.json(rows)
  }
  const total = db.prepare(`SELECT COUNT(*) as total FROM op_logs o ${where}`).get().total
  const data = db.prepare(`${selectSql} LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize)
  const totalPages = Math.ceil(total / pageSize)
  res.json({ data, total, page, pageSize, totalPages })
})

module.exports = router
