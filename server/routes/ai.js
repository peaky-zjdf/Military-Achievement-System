const express = require('express')
const { db, logOp, getSetting } = require('../db')
const { authRequired, requireLevel } = require('../middleware/auth')
const { chatComplete, chatStream, getLlmConfig, getVisionConfig } = require('../services/vision')

const router = express.Router()
router.use(authRequired)

function llmCfg() {
  const cfg = getLlmConfig()
  if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey) {
    const e = new Error('请先在系统设置中配置并启用大模型 API')
    e.status = 400
    throw e
  }
  return cfg
}

function saveHistory(kind, title, target, content, userId) {
  try {
    db.prepare(`
      INSERT INTO ai_analyses (kind, title, target, content, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(kind, title, target, content, userId)
  } catch (e) {
    console.error('save ai history fail', e.message)
  }
}

/** SSE 流式分析 */
function streamHandler(buildPrompt) {
  return async (req, res) => {
    let cfg
    try {
      cfg = llmCfg()
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }

    let built
    try {
      built = buildPrompt(req)
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message })
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    try {
      const full = await chatStream({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        messages: [
          { role: 'system', content: built.system },
          { role: 'user', content: built.user },
        ],
        maxTokens: 2000,
        onDelta: (d) => send('delta', { text: d }),
      })
      saveHistory(built.kind, built.title, built.target || '', full, req.user.id)
      send('done', { ok: true, full })
    } catch (e) {
      send('error', { error: e.message })
    }
    res.end()
  }
}

function memberCtx(memberId) {
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId)
  if (!m) {
    const e = new Error('成员不存在')
    e.status = 404
    throw e
  }
  const war = db.prepare('SELECT amount, type, created_at FROM war_merit_records WHERE member_id = ? ORDER BY created_at DESC LIMIT 20').all(memberId)
  const att = db.prepare('SELECT attended, demolition FROM city_attendance WHERE member_id = ?').all(memberId)
  const journey = db.prepare('SELECT * FROM journey_records WHERE member_id = ? ORDER BY week_key DESC LIMIT 4').all(memberId)
  const attRate = att.length ? Math.round(att.filter((a) => a.attended).length / att.length * 100) : 0
  const totalDemo = att.reduce((s, a) => s + (a.demolition || 0), 0)
  const totalWar = war.reduce((s, w) => s + (w.amount || 0), 0)
  return {
    m,
    text: `成员：${m.nickname}（${m.game_id}）
状态：${m.status} 职位：${m.role}
势力值：${m.power}
累计军功：${m.total_merit} 可用：${m.available_merit}
出勤率：${attRate}%（${att.filter((a) => a.attended).length}/${att.length}）
累计拆迁：${totalDemo}
近20场武勋合计：${totalWar}
最近征程：${journey.map((j) => `周${j.week_key} 武勋${j.war_merit_week} 拆除${j.demolish_week} 灭敌${j.kills_week}`).join('；') || '无'}`,
  }
}

function weeklyCtx() {
  const members = db.prepare(`
    SELECT nickname, total_merit, available_merit, power, status FROM members
    WHERE status != '离盟' ORDER BY total_merit DESC
  `).all()
  const weekWar = db.prepare(`
    SELECT m.nickname, SUM(w.amount) as war
    FROM war_merit_records w JOIN members m ON m.id = w.member_id
    WHERE w.created_at >= datetime('now','localtime','-7 days')
    GROUP BY m.id ORDER BY war DESC LIMIT 15
  `).all()
  const groups = db.prepare(`
    SELECT g.name, COUNT(m.id) as cnt, COALESCE(SUM(m.total_merit),0) as merit
    FROM groups g LEFT JOIN members m ON m.group_id = g.id AND m.status != '离盟'
    GROUP BY g.id
  `).all()
  return `成员总数：${members.length}
本周武勋TOP：${weekWar.map((w) => `${w.nickname} ${w.war}`).join('、')}
各团：${groups.map((g) => `${g.name}(${g.cnt}人,军功${g.merit})`).join('；')}
累计军功TOP5：${members.slice(0, 5).map((m) => `${m.nickname} ${m.total_merit}`).join('、')}`
}

/** 管理仪表盘简报上下文 */
function dashboardCtx() {
  const overview = db.prepare(`
    SELECT
      (SELECT COALESCE(SUM(total_merit),0) FROM members WHERE status != '离盟') as total_merit,
      (SELECT COALESCE(SUM(amount),0) FROM war_merit_records WHERE created_at >= datetime('now','localtime','-6 days')) as week_war,
      (SELECT COUNT(*) FROM city_plans WHERE status='计划中') as pending_cities,
      (SELECT COUNT(*) FROM orders WHERE status='待审核') as pending_orders,
      (SELECT COUNT(*) FROM applications WHERE status='待审核') as pending_apps,
      (SELECT COUNT(*) FROM members WHERE status != '离盟') as member_count,
      (SELECT COALESCE(SUM(power),0) FROM members WHERE status != '离盟') as total_power,
      (SELECT COUNT(*) FROM city_plans WHERE status='已完成') as cities_done,
      (SELECT COUNT(*) FROM members WHERE status='活跃') as active_count,
      (SELECT COUNT(*) FROM members WHERE status='休战') as dormant_count,
      (SELECT COUNT(*) FROM members WHERE status='沦陷') as captured_count
  `).get()

  const weekTop = db.prepare(`
    SELECT m.nickname, SUM(w.amount) as war
    FROM war_merit_records w JOIN members m ON m.id = w.member_id
    WHERE w.created_at >= datetime('now','localtime','-6 days')
    GROUP BY m.id ORDER BY war DESC LIMIT 8
  `).all()

  const idle = db.prepare(`
    SELECT m.nickname, m.total_merit
    FROM members m
    WHERE m.status = '活跃'
      AND NOT EXISTS (
        SELECT 1 FROM war_merit_records w
        WHERE w.member_id = m.id AND w.created_at >= datetime('now','localtime','-6 days')
      )
    ORDER BY m.total_merit DESC LIMIT 8
  `).all()

  const groups = db.prepare(`
    SELECT g.name, COUNT(m.id) as cnt, COALESCE(SUM(m.total_merit),0) as merit, COALESCE(SUM(m.power),0) as power
    FROM groups g LEFT JOIN members m ON m.group_id = g.id AND m.status != '离盟'
    GROUP BY g.id ORDER BY merit DESC
  `).all()

  const att = db.prepare(`
    SELECT COUNT(*) as total, SUM(CASE WHEN attended=1 THEN 1 ELSE 0 END) as attended
    FROM city_attendance a
    JOIN city_plans c ON c.id = a.city_id
    WHERE c.planned_time >= datetime('now','localtime','-13 days')
  `).get()
  const attRate = att.total ? Math.round((att.attended / att.total) * 100) : null

  const upcoming = db.prepare(`
    SELECT name, planned_time FROM city_plans
    WHERE status='计划中' ORDER BY planned_time ASC LIMIT 5
  `).all()

  const trend = db.prepare(`
    SELECT date(created_at) as day, SUM(amount) as total
    FROM war_merit_records
    WHERE created_at >= datetime('now','localtime','-6 days')
    GROUP BY date(created_at) ORDER BY day
  `).all()

  const top5 = db.prepare(`
    SELECT nickname, total_merit, available_merit, power, status
    FROM members WHERE status != '离盟' ORDER BY total_merit DESC LIMIT 5
  `).all()

  return `【全盟概况】
在册成员：${overview.member_count}（活跃${overview.active_count}/休战${overview.dormant_count}/沦陷${overview.captured_count}）
总势力：${overview.total_power} 累计军功：${overview.total_merit}
本周武勋：${overview.week_war} 近7日趋势：${trend.map((t) => `${t.day}:${t.total}`).join('、') || '无'}
打城出勤率：${attRate === null ? '暂无数据' : attRate + '%'}（${att.attended || 0}/${att.total || 0}）
已完成打城：${overview.cities_done}

【各团】
${groups.map((g) => `${g.name}：${g.cnt}人 军功${g.merit} 势力${g.power}`).join('\n') || '未分团'}

【本周武勋TOP】
${weekTop.map((w, i) => `${i + 1}. ${w.nickname} ${w.war}`).join('\n') || '本周暂无武勋记录'}

【累计军功TOP5】
${top5.map((m, i) => `${i + 1}. ${m.nickname} 军功${m.total_merit} 势力${m.power} ${m.status}`).join('\n')}

【本周活跃但零武勋】
${idle.map((m) => m.nickname).join('、') || '无'}

【待办】
待审核入盟：${overview.pending_apps}
待审核兑换：${overview.pending_orders}
待执行打城：${overview.pending_cities}
即将打城：${upcoming.map((c) => `${c.name}(${c.planned_time})`).join('；') || '无'}`
}

// ===== 流式分析接口 =====
router.post('/stream/member', streamHandler((req) => {
  const memberId = Number(req.body?.member_id)
  const { m, text } = memberCtx(memberId)
  return {
    kind: 'member',
    title: `成员分析 · ${m.nickname}`,
    target: m.nickname,
    system: '你是率土之滨同盟管理AI助手。根据成员数据分析其贡献，给出简洁中文点评（200字内）：活跃度、贡献类型、改进建议。语气客观专业。',
    user: text,
  }
}))

router.post('/stream/weekly', streamHandler(() => ({
  kind: 'weekly',
  title: '全盟周报',
  target: '',
  system: '你是率土之滨同盟管理AI助手。根据全盟数据写一份简短周报点评（250字内）：整体战力、活跃情况、亮点与风险、下周建议。',
  user: weeklyCtx(),
})))

/** 管理仪表盘 AI 简报（盟主/副盟/团长） */
router.post('/stream/dashboard', streamHandler(() => ({
  kind: 'dashboard',
  title: '仪表盘 AI 简报',
  target: '',
  system: `你是率土之滨同盟管理AI参谋。根据仪表盘数据输出「今日管理简报」，严格用以下结构，总字数≤280：
【战况】一两句：本周武勋与趋势
【风险】最多3条：零武勋/出勤差/待办积压等
【待办】最多3条：优先处理动作
【建议】一两句：管理动作建议
不要客套，直接给结论。`,
  user: dashboardCtx(),
})))

router.get('/status', (req, res) => {
  const cfg = getLlmConfig()
  const v = getVisionConfig()
  res.json({
    enabled: !!(cfg.enabled && cfg.baseUrl && cfg.apiKey),
    model: cfg.model || '',
    source: getSetting('llm_api_key') ? 'llm' : (v.apiKey ? 'vision-fallback' : 'none'),
    vision_ready: !!(v.enabled && v.baseUrl && v.apiKey),
  })
})

router.post('/stream/enemy', streamHandler((req) => {
  const enemyId = Number(req.body?.enemy_id)
  const e = db.prepare('SELECT * FROM enemies WHERE id = ?').get(enemyId)
  if (!e) { const err = new Error('敌对不存在'); err.status = 404; throw err }
  const gens = db.prepare('SELECT * FROM enemy_generals WHERE enemy_id = ?').all(enemyId)
  return {
    kind: 'enemy',
    title: `敌对分析 · ${e.nickname}`,
    target: e.nickname,
    system: '你是率土之滨战术AI助手。根据敌方阵容分析威胁度与克制建议（200字内）：队伍特点、弱点、我方应对。',
    user: `敌方：${e.nickname}（${e.alliance || '无同盟'}）
威胁：${e.threat_level}
武将：${gens.map((g) => `${g.slot}${g.name} Lv${g.level} 兵${g.troops} 红${g.red_stars} 宝物${g.treasures || '无'}`).join('；')}`,
  }
}))

router.post('/stream/chat', streamHandler((req) => {
  const question = String(req.body?.question || '').slice(0, 2000)
  if (!question) { const err = new Error('请输入问题'); err.status = 400; throw err }
  const members = db.prepare('SELECT nickname, total_merit, power, status FROM members WHERE status != ? ORDER BY total_merit DESC LIMIT 10').all('离盟')
  return {
    kind: 'chat',
    title: question.slice(0, 30),
    target: '',
    system: '你是率土之滨同盟管理AI助手。结合给出的数据上下文回答问题，简洁专业，200字内。',
    user: `数据摘要：成员${members.length}+，军功TOP5：${members.slice(0, 5).map((m) => m.nickname + '(' + m.total_merit + ')').join('、')}\n\n问题：${question}`,
  }
}))

/** 奖励分配建议 */
router.post('/stream/award', streamHandler((req) => {
  const quota = Number(req.body?.quota) || 5
  const awardType = req.body?.award_type || '征服名额'
  const members = db.prepare(`
    SELECT m.nickname, m.total_merit, m.available_merit, m.power, m.status,
      COALESCE((SELECT SUM(a.attended) FROM city_attendance a WHERE a.member_id = m.id),0) as attended,
      COALESCE((SELECT COUNT(*) FROM city_attendance a WHERE a.member_id = m.id),0) as total_att,
      COALESCE((SELECT SUM(w.amount) FROM war_merit_records w WHERE w.member_id = m.id AND w.created_at >= datetime('now','localtime','-7 days')),0) as week_war
    FROM members m WHERE m.status = '活跃' ORDER BY m.total_merit DESC LIMIT 30
  `).all()
  const list = members.map((m, i) =>
    `${i + 1}. ${m.nickname} 军功${m.total_merit} 势力${m.power} 出勤${m.attended}/${m.total_att} 本周武勋${m.week_war}`
  ).join('\n')
  return {
    kind: 'award',
    title: `奖励分配建议 · ${awardType}×${quota}`,
    target: awardType,
    system: `你是率土之滨同盟管理AI助手。根据军功、出勤、本周活跃度，推荐 ${quota} 个「${awardType}」名额人选。输出格式：
【推荐名单】按优先级列出人选与理由（每人一句话）
【备选】如有争议人选单独列出
【说明】分配原则一句话
控制在 250 字内。`,
    user: `候选人（按累计军功排序）：\n${list}`,
  }
}))

// ===== 非流式兼容接口 =====
router.post('/member', async (req, res) => {
  try {
    const { m, text } = memberCtx(Number(req.body?.member_id))
    const analysis = await chatComplete({
      ...llmCfg(),
      messages: [
        { role: 'system', content: '你是率土之滨同盟管理AI助手。简洁点评成员贡献（150字内）。' },
        { role: 'user', content: text },
      ],
    })
    saveHistory('member', `成员分析 · ${m.nickname}`, m.nickname, analysis, req.user.id)
    res.json({ ok: true, analysis, member: m.nickname })
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message })
  }
})

// ===== 历史记录 =====
router.get('/history', (req, res) => {
  const { kind = '' } = req.query
  let sql = 'SELECT id, kind, title, target, content, created_at FROM ai_analyses WHERE 1=1'
  const params = []
  if (kind) { sql += ' AND kind = ?'; params.push(kind) }
  sql += ' ORDER BY created_at DESC LIMIT 100'
  res.json(db.prepare(sql).all(...params))
})

router.get('/history/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM ai_analyses WHERE id = ?').get(req.params.id)
  if (!r) return res.status(404).json({ error: '不存在' })
  res.json(r)
})

router.delete('/history/:id', requireLevel(2), (req, res) => {
  db.prepare('DELETE FROM ai_analyses WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

module.exports = router
