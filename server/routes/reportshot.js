const express = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const { db, logOp } = require('../db')
const { authRequired, requireLevel } = require('../middleware/auth')
const { parseReportScreenshot } = require('../services/reportParse')

const router = express.Router()
router.use(authRequired)

const UPLOAD_DIR = path.join(__dirname, '../data/report-uploads')
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png'
      cb(null, `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//i.test(file.mimetype)) cb(null, true)
    else cb(new Error('仅支持图片'))
  },
})

/** 上传并识别：阵容 / 武将统计 / 战法统计 / 战报 */
router.post('/parse', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择图片' })
  try {
    const parsed = await parseReportScreenshot(req.file.path)

    // 战报：自动匹配成员
    let member = null
    if (parsed.kind === 'battle' && parsed.nickname) {
      const { matchMember } = require('../services/ocr')
      member = matchMember(db, parsed.nickname)
      if (!member && req.user.member_id) {
        member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.user.member_id)
      }
    }

    // 自动保存阵容到阵容库（战报类型且有武将数据）
    let lineupId = null
    if (parsed.kind === 'battle' && parsed.generals && parsed.generals.length > 0) {
      try {
        const gens = parsed.generals
        const ourGens = gens.filter(g => g.side !== '敌方')
        const enemyGens = gens.filter(g => g.side === '敌方')
        const playerName = parsed.battle?.our_player || parsed.nickname || ''
        const alliance = parsed.battle?.our_alliance || ''

        // 保存我方阵容
        if (ourGens.length > 0) {
          const info = db.prepare(`
            INSERT INTO battle_lineups (side, player_name, alliance, note, image_path, ocr_text, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run('我方', playerName, alliance, '战报自动入库', req.file.filename, parsed.raw || '', req.user.id)
          lineupId = info.lastInsertRowid
          for (const g of ourGens) {
            if (!g?.name) continue
            db.prepare(`
              INSERT INTO battle_lineup_generals (lineup_id, slot, name, level, camp, red_stars, treasures, skills, gems, note)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(lineupId, g.slot || '', g.name, Number(g.level) || 0, g.camp || '',
              Number(g.red_stars) || 0, g.treasures || '',
              Array.isArray(g.skills) ? g.skills.join('、') : (g.skills || ''),
              g.gems || '', '')
          }
        }

        // 保存敌方阵容 + 同步敌对情报
        if (enemyGens.length > 0) {
          const enemyPlayer = parsed.battle?.enemy_player || ''
          const enemyAlliance = parsed.battle?.enemy_alliance || ''
          if (enemyPlayer) {
            const eInfo = db.prepare(`
              INSERT INTO battle_lineups (side, player_name, alliance, note, image_path, ocr_text, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run('敌方', enemyPlayer, enemyAlliance, '战报自动入库', req.file.filename, parsed.raw || '', req.user.id)
            for (const g of enemyGens) {
              if (!g?.name) continue
              db.prepare(`
                INSERT INTO battle_lineup_generals (lineup_id, slot, name, level, camp, red_stars, treasures, skills, gems, note)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(eInfo.lastInsertRowid, g.slot || '', g.name, Number(g.level) || 0, g.camp || '',
                Number(g.red_stars) || 0, g.treasures || '',
                Array.isArray(g.skills) ? g.skills.join('、') : (g.skills || ''),
                g.gems || '', '')
            }

            // 同步到敌对势力情报
            const exist = db.prepare('SELECT id FROM enemies WHERE nickname = ?').get(enemyPlayer)
            let enemyId
            if (exist) {
              enemyId = exist.id
              db.prepare("UPDATE enemies SET alliance=?, last_seen=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?")
                .run(enemyAlliance, enemyId)
              db.prepare('DELETE FROM enemy_generals WHERE enemy_id = ?').run(enemyId)
            } else {
              enemyId = db.prepare("INSERT INTO enemies (nickname, alliance, threat_level, note, last_seen, created_by) VALUES (?, ?, '中', ?, datetime('now','localtime'), ?)")
                .run(enemyPlayer, enemyAlliance, '战报自动入库', req.user.id).lastInsertRowid
            }
            for (const g of enemyGens) {
              if (!g?.name) continue
              db.prepare("INSERT INTO enemy_generals (enemy_id, slot, name, level, troops, red_stars, treasures, skills, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                .run(enemyId, g.slot || '', g.name, Number(g.level) || 0, 0, Number(g.red_stars) || 0,
                  g.treasures || '', Array.isArray(g.skills) ? g.skills.join('、') : (g.skills || ''), '')
            }
          }
        }
        logOp(req.user.id, '战报自动入库阵容', `${playerName} 我方${ourGens.length}武将 敌方${enemyGens.length}武将`)
      } catch (e) {
        console.error('自动保存阵容失败:', e.message)
      }
    }

    res.json({
      ok: true,
      filename: req.file.filename,
      file: `/api/reportshot/uploads/${req.file.filename}`,
      kind: parsed.kind,
      page_type: parsed.page_type || parsed.kind,
      side: parsed.side || '',
      generals: parsed.generals || [],
      rows: parsed.rows || [],
      battle: parsed.battle || null,
      nickname: parsed.nickname || '',
      war_merit: parsed.war_merit || 0,
      member: member ? { id: member.id, nickname: member.nickname, game_id: member.game_id } : null,
      raw: parsed.raw || '',
      source: parsed.source || 'ocr',
      lineup_id: lineupId,
    })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: '识别失败：' + e.message })
  }
})

/** 批量上传识别（最多20张）- 自动匹配成员 */
router.post('/parse-multi', upload.array('images', 20), async (req, res) => {
  const files = req.files || []
  if (!files.length) return res.status(400).json({ error: '请选择至少一张图片' })
  const { matchMember } = require('../services/ocr')
  const allMembers = db.prepare("SELECT id, nickname, game_id, group_id FROM members WHERE status != '离盟'").all()

  const results = []
  for (const f of files) {
    try {
      const parsed = await parseReportScreenshot(f.path)

      // 从识别结果中提取玩家名（支持所有类型）
      let nickname = parsed.nickname || ''
      let playerName = parsed.player_name || ''
      let battlePlayer = parsed.battle?.our?.player || ''
      let battleAlliance = parsed.battle?.our?.alliance || ''
      // 合并所有可能的名称（新模型可能把server|nick拆到不同字段）
      let searchName = nickname || playerName || battlePlayer
      // 如果 battlePlayer 包含 | 分隔符，直接用；否则合并 player + alliance
      if (battlePlayer && !battlePlayer.includes('|') && battleAlliance && !battleAlliance.includes('|')) {
        // 新模型可能把 server 放 player，nick 放 alliance
        searchName = `${battlePlayer} | ${battleAlliance}`
      }

      // 尝试匹配成员
      let member = null
      let matchMethod = ''
      if (searchName) {
        member = matchMember(db, searchName)
        if (member) matchMethod = 'name_match'
      }
      // 如果没匹配到但当前用户绑定了成员，不自动绑定（留给用户选择）
      let memberInfo = member
        ? { id: member.id, nickname: member.nickname, game_id: member.game_id, match_method: matchMethod }
        : null

      results.push({
        ok: true,
        filename: f.filename,
        file: `/api/reportshot/uploads/${f.filename}`,
        kind: parsed.kind,
        page_type: parsed.page_type || parsed.kind,
        side: parsed.side || '',
        generals: parsed.generals || [],
        rows: parsed.rows || [],
        battle: parsed.battle || null,
        nickname: searchName,
        war_merit: parsed.war_merit || 0,
        member: memberInfo,
        matched: !!member,
        raw: parsed.raw || '',
        source: parsed.source || 'ocr',
      })
    } catch (e) {
      results.push({
        ok: false, filename: f.filename, error: e.message,
        kind: 'unknown', page_type: '未知', generals: [], rows: [],
        matched: false, member: null, nickname: '',
      })
    }
  }

  const matched = results.filter(r => r.matched).length
  const unmatched = results.filter(r => r.ok && !r.matched).length
  logOp(req.user.id, '批量截图识别', `共${files.length}张 匹配${matched} 未匹配${unmatched}`)
  res.json({ ok: true, count: results.length, matched, unmatched, results })
})

/** 批量确认保存阵容 - items: [{filename, member_id?, side, generals, ...}] */
router.post('/batch-confirm', requireLevel(2), (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  if (!items.length) return res.status(400).json({ error: '无待确认数据' })
  if (items.length > 20) return res.status(400).json({ error: '一次最多确认20条' })

  const out = []
  const tx = db.transaction(() => {
    for (const it of items) {
      if (!it.kind || !it.filename) {
        out.push({ filename: it.filename, ok: false, error: '缺少必要字段' })
        continue
      }
      // 验证成员
      const mid = Number(it.member_id)
      if (!mid) {
        out.push({ filename: it.filename, ok: false, error: '请选择关联成员' })
        continue
      }
      const member = db.prepare('SELECT id, nickname FROM members WHERE id = ?').get(mid)
      if (!member) {
        out.push({ filename: it.filename, ok: false, error: '成员不存在' })
        continue
      }

      try {
        if (it.kind === 'battle' || it.kind === 'lineup') {
          // 保存阵容
          const side = it.side || '我方'
          const info = db.prepare(`
            INSERT INTO battle_lineups (side, player_name, alliance, note, image_path, ocr_text, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(side, it.nickname || member.nickname, it.alliance || '', it.note || '',
            it.file || '', it.raw || '', req.user.id)
          const lineupId = info.lastInsertRowid
          for (const g of it.generals || []) {
            if (!g?.name) continue
            db.prepare(`
              INSERT INTO battle_lineup_generals (lineup_id, slot, name, level, camp, red_stars, treasures, skills, gems, note)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(lineupId, g.slot || '', g.name, Number(g.level) || 0, g.camp || '',
              Number(g.red_stars) || 0, g.treasures || '', g.skills || '', g.gems || '', '')
          }
          // 敌方自动同步到敌对情报
          if (side === '敌方' && it.nickname) {
            const exist = db.prepare('SELECT id FROM enemies WHERE nickname = ?').get(it.nickname)
            let enemyId
            if (exist) {
              enemyId = exist.id
              db.prepare("UPDATE enemies SET alliance=?, last_seen=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?")
                .run(it.alliance || '', enemyId)
              db.prepare('DELETE FROM enemy_generals WHERE enemy_id = ?').run(enemyId)
            } else {
              enemyId = db.prepare("INSERT INTO enemies (nickname, alliance, threat_level, note, last_seen, created_by) VALUES (?, ?, '中', ?, datetime('now','localtime'), ?)")
                .run(it.nickname, it.alliance || '', '阵容截图录入', req.user.id).lastInsertRowid
            }
            for (const g of it.generals || []) {
              if (!g?.name) continue
              db.prepare("INSERT INTO enemy_generals (enemy_id, slot, name, level, troops, red_stars, treasures, skills, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                .run(enemyId, g.slot || '', g.name, Number(g.level) || 0, 0, Number(g.red_stars) || 0,
                  g.treasures || '', [g.skills, g.gems].filter(Boolean).join('、'), '')
            }
          }
          out.push({ filename: it.filename, ok: true, id: lineupId, type: 'lineup', member: member.nickname })

        } else if (it.kind === 'general_stats' || it.kind === 'skill_stats') {
          // 保存统计
          const kind = it.kind === 'skill_stats' ? '战法统计' : '武将统计'
          const info = db.prepare(`
            INSERT INTO battle_stat_reports (kind, title, side, note, image_path, ocr_text, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(kind, it.title || kind, it.side || '', it.note || '', it.file || '', it.raw || '', req.user.id)
          const reportId = info.lastInsertRowid
          for (const r of it.rows || []) {
            if (!r?.name) continue
            if (kind === '武将统计') {
              db.prepare(`INSERT INTO battle_stat_rows (report_id, slot, name, level, normal_kill, skill_kill, skill_cast, rescue, loss, wounded, total_wounded)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(reportId, r.slot || '', r.name, Number(r.level) || 0,
                  Number(r.normal_kill) || 0, Number(r.skill_kill) || 0, Number(r.skill_cast) || 0,
                  Number(r.rescue) || 0, Number(r.loss) || 0, Number(r.wounded) || 0, Number(r.total_wounded) || 0)
            } else {
              const skills = Array.isArray(r.skills) ? r.skills : []
              db.prepare(`INSERT INTO battle_stat_rows (report_id, name, normal_times, normal_kill, skill_name, skill_times, skill_kill_amount, extra)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(reportId, r.name, Number(r.normal_times) || 0, Number(r.normal_kill) || 0,
                  skills.map(s => s.name || s).join('、'), Number(r.skill_times || skills[0]?.times) || 0,
                  Number(r.skill_kill_amount) || 0, r.extra || '')
            }
          }
          out.push({ filename: it.filename, ok: true, id: reportId, type: 'stats', member: member.nickname })
        } else {
          out.push({ filename: it.filename, ok: false, error: '未知类型: ' + it.kind })
        }
      } catch (e) {
        out.push({ filename: it.filename, ok: false, error: e.message })
      }
    }
  })

  try {
    tx()
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  const okN = out.filter(x => x.ok).length
  logOp(req.user.id, '批量保存截图', `ok=${okN}/${out.length}`)
  res.json({ ok: true, results: out, okCount: okN })
})

router.get('/uploads/:name', (req, res) => {
  const p = path.join(UPLOAD_DIR, path.basename(req.params.name))
  if (!fs.existsSync(p)) return res.status(404).end()
  res.sendFile(p)
})

/** 保存阵容 */
router.post('/lineup', requireLevel(2), (req, res) => {
  const b = req.body || {}
  const side = b.side === '敌方' ? '敌方' : '我方'
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO battle_lineups (side, player_name, alliance, note, image_path, ocr_text, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(side, b.player_name || '', b.alliance || '', b.note || '', b.image_path || '', b.ocr_text || '', req.user.id)
    const id = info.lastInsertRowid
    for (const g of b.generals || []) {
      if (!g?.name) continue
      db.prepare(`
        INSERT INTO battle_lineup_generals (lineup_id, slot, name, level, camp, red_stars, treasures, skills, gems, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, g.slot || '', g.name, Number(g.level) || 0, g.camp || '', Number(g.red_stars) || 0,
        g.treasures || '', g.skills || '', g.gems || '', g.note || '')
    }
    if (side === '敌方' && b.player_name) {
      const exist = db.prepare('SELECT id FROM enemies WHERE nickname = ?').get(b.player_name)
      let enemyId
      if (exist) {
        enemyId = exist.id
        db.prepare(`
          UPDATE enemies SET alliance=?, note=?, last_seen=datetime('now','localtime'), updated_at=datetime('now','localtime')
          WHERE id=?
        `).run(b.alliance || '', b.note || '阵容截图更新', enemyId)
        db.prepare('DELETE FROM enemy_generals WHERE enemy_id = ?').run(enemyId)
      } else {
        enemyId = db.prepare(`
          INSERT INTO enemies (nickname, alliance, threat_level, note, last_seen, created_by)
          VALUES (?, ?, '中', ?, datetime('now','localtime'), ?)
        `).run(b.player_name, b.alliance || '', '阵容截图录入', req.user.id).lastInsertRowid
      }
      for (const g of b.generals || []) {
        if (!g?.name) continue
        db.prepare(`
          INSERT INTO enemy_generals (enemy_id, slot, name, level, troops, red_stars, treasures, skills, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(enemyId, g.slot || '', g.name, Number(g.level) || 0, 0, Number(g.red_stars) || 0,
          g.treasures || '', [g.skills, g.gems].filter(Boolean).join('、'), '')
      }
    }
    return id
  })
  const id = tx()
  logOp(req.user.id, '保存部队阵容', `${side} ${b.player_name || ''}`)
  res.json({ id })
})

/** 保存统计 */
router.post('/stats', requireLevel(2), (req, res) => {
  const b = req.body || {}
  const kind = b.kind === 'skill_stats' ? '战法统计' : '武将统计'
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO battle_stat_reports (kind, title, side, note, image_path, ocr_text, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(kind, b.title || kind, b.side || '', b.note || '', b.image_path || '', b.ocr_text || '', req.user.id)
    const id = info.lastInsertRowid
    for (const r of b.rows || []) {
      if (!r?.name) continue
      if (kind === '武将统计') {
        db.prepare(`
          INSERT INTO battle_stat_rows (report_id, slot, name, level, normal_kill, skill_kill, skill_cast, rescue, loss, wounded, total_wounded)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, r.slot || '', r.name, Number(r.level) || 0,
          Number(r.normal_kill) || 0, Number(r.skill_kill) || 0, Number(r.skill_cast) || 0,
          Number(r.rescue) || 0, Number(r.loss) || 0, Number(r.wounded) || 0, Number(r.total_wounded) || 0)
      } else {
        db.prepare(`
          INSERT INTO battle_stat_rows (report_id, name, normal_times, normal_kill, skill_name, skill_times, skill_kill_amount, extra)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, r.name, Number(r.normal_times) || 0, Number(r.normal_kill) || 0,
          r.extra || (r.skills || []).map((s) => s.name).join('、'),
          Number((r.skills && r.skills[0] && r.skills[0].times) || r.skill_times) || 0,
          Number(r.skill_kill_amount) || 0, r.extra || '')
      }
    }
    return id
  })
  const id = tx()
  logOp(req.user.id, '保存战报统计', kind)
  res.json({ id })
})

/** 列表 */
router.get('/lineups', (req, res) => {
  const rows = db.prepare(`
    SELECT l.*,
      (SELECT COUNT(*) FROM battle_lineup_generals g WHERE g.lineup_id=l.id) as general_count
    FROM battle_lineups l
    ORDER BY l.created_at DESC LIMIT 100
  `).all()
  res.json(rows)
})

router.get('/lineups/:id', (req, res) => {
  const l = db.prepare('SELECT * FROM battle_lineups WHERE id = ?').get(req.params.id)
  if (!l) return res.status(404).json({ error: '不存在' })
  const generals = db.prepare('SELECT * FROM battle_lineup_generals WHERE lineup_id = ?').all(l.id)
  res.json({ ...l, generals })
})

router.get('/stats', (req, res) => {
  const kind = req.query.kind || ''
  let sql = `
    SELECT r.*,
      (SELECT COUNT(*) FROM battle_stat_rows x WHERE x.report_id=r.id) as row_count
    FROM battle_stat_reports r WHERE 1=1
  `
  const params = []
  if (kind) { sql += ' AND r.kind = ?'; params.push(kind) }
  sql += ' ORDER BY r.created_at DESC LIMIT 100'
  res.json(db.prepare(sql).all(...params))
})

router.get('/stats/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM battle_stat_reports WHERE id = ?').get(req.params.id)
  if (!r) return res.status(404).json({ error: '不存在' })
  const rows = db.prepare('SELECT * FROM battle_stat_rows WHERE report_id = ?').all(r.id)
  res.json({ ...r, rows })
})

router.delete('/lineups/:id', requireLevel(2), (req, res) => {
  db.prepare('DELETE FROM battle_lineups WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

router.delete('/stats/:id', requireLevel(2), (req, res) => {
  db.prepare('DELETE FROM battle_stat_reports WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

module.exports = router
