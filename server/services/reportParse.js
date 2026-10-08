const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { ocrChiImage, ocrMany, compactText } = require('./ocr')
const { rapidOcrFull } = require('./rapidOcr')
const { visionAnalyze } = require('./vision')
const { pythonExe } = require('./python')

function normalizeGenerals(list) {
  return (list || []).map((g, i) => ({
    slot: g.slot || ['大营', '中军', '前锋'][i] || '',
    name: g.name || '',
    level: Number(g.level) || 0,
    troops: Number(g.troops) || 0,
    red_stars: Number(g.red_stars) || 0,
    treasures: g.treasures || '',
    skills: Array.isArray(g.skills) ? g.skills.join('、') : (g.skills || ''),
    gems: Array.isArray(g.gems) ? g.gems.join('、') : (g.gems || ''),
    camp: g.camp || '',
  })).filter((g) => g.name || g.level)
}

function normalizeStatRows(rows, pageType) {
  return (rows || []).map((r, i) => {
    if (pageType === 'skill_stats') {
      const skills = Array.isArray(r.skills) ? r.skills : []
      return {
        name: r.name || '',
        level: Number(r.level) || 0,
        normal_times: Number(r.normal_times) || 0,
        normal_kill: Number(r.normal_kill) || 0,
        skills,
        extra: r.extra || skills.map((s) => `${s.name}×${s.times}${s.kill != null ? ` 杀伤${s.kill}` : ''}`).join('；'),
      }
    }
    return {
      slot: r.slot || ['大营', '中军', '前锋'][i % 3] || '',
      name: r.name || '',
      level: Number(r.level) || 0,
      normal_kill: Number(r.normal_kill) || 0,
      skill_kill: Number(r.skill_kill) || 0,
      skill_cast: Number(r.skill_cast) || 0,
      rescue: Number(r.rescue) || 0,
      loss: Number(r.loss) || 0,
      wounded: Number(r.wounded) || 0,
      total_wounded: Number(r.total_wounded) || 0,
    }
  }).filter((r) => r.name)
}

const GENERAL_POOL = [
  '甘宁', '司马炎', '孙权', '马岱', '关羽', '吕布', '荀彧', '贾诩', '郭嘉', '甄洛', '张春华',
  '赵云', '张飞', '马超', '黄忠', '曹操', '刘备', '诸葛亮', '周瑜', '陆逊', '吕蒙',
  '太史慈', '张辽', '许褚', '典韦', '夏侯惇', '夏侯渊', '徐晃', '张郃', '邓艾', '钟会', '姜维',
  '庞统', '法正', '魏延', '关银屏', '孙尚香', '大乔', '小乔', '蔡文姬', '貂蝉', '华佗',
  '黄月英', '马云禄', '祝融', '王异', '严颜', '张宁', '左慈', '于吉', '张角', '袁绍', '董卓',
]

const SKILL_POOL = [
  '侵掠如火', '及锋而试', '汜水关', '谋议宏图', '反计之策', '三军之众',
  '九锡黄龙', '垒实迎击', '重整旗鼓', '奉令护蜀', '先声夺人', '计险远近',
  '樊渊泅囚', '谋定后动', '奇正之势', '千里单骑', '先驱突击', '势无虚动',
  '利刃', '列阵', '守备', '勇毅', '地利', '迂回', '疾行', '难测',
]

const TREASURE_POOL = [
  '犀角弓', '铁首锤', '短戟', '彤素', '博浪', '八棱', '镔铁锤', '英勇', '仁心',
]

/** 战法 → 常见武将（用于纠正 OCR 错名） */
const SKILL_TO_GENERAL = {
  '侵掠如火': '甘宁', '及锋而试': '甘宁', '汜水关': '甘宁',
  '谋议宏图': '司马炎', '反计之策': '司马炎', '三军之众': '司马炎',
  '九锡黄龙': '孙权', '垒实迎击': '孙权', '重整旗鼓': '孙权',
  '千里单骑': '关羽', '先驱突击': '关羽', '势无虚动': '关羽',
  '樊渊泅囚': '关羽', '谋定后动': '关羽', '奇正之势': '关羽',
  '奉令护蜀': '马岱', '先声夺人': '马岱', '计险远近': '马岱',
  '樊城淹七军': '关羽', '一骑当千': '赵云', '浑身是胆': '赵云',
}

function inferGeneralFromSkills(skillNames) {
  const votes = {}
  for (const s of skillNames || []) {
    const g = SKILL_TO_GENERAL[s]
    if (g) votes[g] = (votes[g] || 0) + 1
  }
  let best = ''
  let n = 0
  for (const [g, c] of Object.entries(votes)) {
    if (c > n) { n = c; best = g }
  }
  return best
}

function fuzzyMatch(raw, pool) {
  if (!raw) return ''
  const s = compactText(raw).replace(/[^一-龥]/g, '')
  if (!s) return ''
  for (const p of pool) {
    if (s.includes(p) || (s.length >= 2 && p.includes(s))) return p
  }
  // 字符重合度纠错：OCR 常把 侵→促、千→干、汜→泗
  let best = ''
  let bestScore = 0
  for (const p of pool) {
    let shared = 0
    const set = new Set(p)
    for (const ch of s) if (set.has(ch)) shared++
    const score = shared / Math.max(s.length, p.length)
    if (score > bestScore) {
      bestScore = score
      best = p
    }
  }
  if (bestScore >= 0.5 && s.length >= 2) return best
  return s.slice(0, 4)
}

function parseLv(raw) {
  const m = raw.match(/Lv\.?\s*(\d{1,2})/i)
  return m ? Number(m[1]) : 0
}

function parseStars(raw) {
  const runs = [...raw.matchAll(/([★☆]{3,5})/g)]
  if (!runs.length) return 0
  return Math.max(...runs.map((m) => (m[1].match(/★/g) || []).length))
}

/** 部队阵容截图 → 3 将 */
function parseLineup(rawText) {
  const all = compactText(rawText)
  const side = /敌方/.test(all) && !/我方/.test(all) ? '敌方' : /我方/.test(all) ? '我方' : ''

  const slots = ['大营', '中军', '前锋']
  const lines = all.split('\n').filter(Boolean)
  const generals = []

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]
    const idx = lines.findIndex((l) => l.includes(slot))
    let chunk = idx >= 0 ? lines.slice(idx, idx + 8).join('\n') : ''
    if (!chunk) chunk = all.slice(i * 80, (i + 1) * 80)

    let name = ''
    for (const g of GENERAL_POOL) {
      if (chunk.includes(g)) { name = g; break }
    }
    if (!name) {
      const cjk = [...chunk.matchAll(/[一-龥]{2,3}/g)]
        .map((x) => x[0])
        .filter((s) => !/大营|中军|前锋|部队|阵容|我方|敌方|兵力|等级|战法|宝物|极|悍/.test(s))
      if (cjk[0]) name = cjk[0]
    }

    const level = parseLv(chunk)
    const stars = parseStars(chunk)
    const skills = SKILL_POOL.filter((s) => chunk.includes(s)).slice(0, 3)
    const treasures = TREASURE_POOL.filter((s) => chunk.includes(s))
    const treasure = treasures.find((t) => t.length >= 3) || treasures[0] || ''
    const gems = SKILL_POOL.slice(-8).filter((s) => chunk.includes(s))

    if (name || level) {
      generals.push({
        slot,
        name,
        level,
        camp: '',
        red_stars: stars,
        treasures: treasure,
        skills: skills.join('、'),
        gems: gems.join('、'),
      })
    }
  }

  return { side, generals, page_type: side ? `部队阵容-${side}` : '部队阵容' }
}

/** 武将统计 */
function parseGeneralStats(rawText) {
  const all = compactText(rawText)
  const lines = all.split('\n').filter(Boolean)
  const slots = ['大营', '中军', '前锋']
  const rows = []

  const nameHits = []
  for (let i = 0; i < lines.length; i++) {
    for (const g of GENERAL_POOL) {
      if (lines[i].includes(g) || (i + 1 < lines.length && lines[i + 1].includes(g))) {
        nameHits.push({ name: g, line: i })
        break
      }
    }
  }

  const used = new Set()
  for (const hit of nameHits) {
    if (used.has(hit.name + hit.line)) continue
    const chunk = lines.slice(hit.line, hit.line + 4).join('\n')
    const lv = parseLv(chunk)
    const rawNums = [...chunk.replace(/Lv\.?\s*\d+/gi, '').matchAll(/(\d{1,7})/g)].map((m) => Number(m[1]))
    const slot = slots[rows.length % 3] || ''
    rows.push({
      slot,
      name: hit.name,
      level: lv,
      normal_kill: rawNums[0] || 0,
      skill_kill: rawNums[1] || 0,
      skill_cast: rawNums[2] || 0,
      rescue: rawNums[3] || 0,
      loss: rawNums[4] || 0,
      wounded: rawNums[5] || 0,
      total_wounded: rawNums[6] || 0,
    })
    used.add(hit.name + hit.line)
    if (rows.length >= 6) break
  }

  const side = /平局/.test(all) ? '平局' : /我方胜/.test(all) ? '我方胜' : /我方败/.test(all) ? '我方败' : ''
  return { side, rows, page_type: '武将统计' }
}

/** 战法统计 */
function parseSkillStats(rawText) {
  const all = compactText(rawText)
  const lines = all.split('\n').filter(Boolean)
  const rows = []

  // 1) 优先按 [REGION:stat_rN_chi] 行解析
  const sections = {}
  let cur = 'full'
  sections.full = []
  for (const line of all.split('\n')) {
    const m = line.match(/^\[REGION:([a-z0-9_]+)\]$/i)
    if (m) {
      cur = m[1].toLowerCase()
      sections[cur] = sections[cur] || []
      continue
    }
    sections[cur] = sections[cur] || []
    sections[cur].push(line)
  }

  const parseRowText = (text, fallbackName) => {
    const chunk = compactText(text)
    let name = fallbackName || ''
    for (const g of GENERAL_POOL) {
      if (chunk.includes(g)) { name = g; break }
    }
    const normalM = chunk.match(/普通攻击\s*(\d{1,3})次/) || chunk.match(/(\d{1,3})次/)
    const timesAll = [...chunk.matchAll(/(\d{1,3})次/g)].map((m) => Number(m[1]))
    const kills = [...chunk.matchAll(/(?:杀伤)?\s*(\d{2,7})\b/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n >= 10 && n <= 9999999 && n !== 2026)
    const timesSet = new Set(timesAll)
    const killNums = kills.filter((n) => !timesSet.has(n) || n >= 100)
    const skillMatches = [...chunk.matchAll(/([一-龥]{2,6})\s*(\d{1,3})次/g)]
      .filter((m) => !/普通|杀伤|攻击/.test(m[1]))
    const skills = skillMatches.map((m) => ({
      name: fuzzyMatch(m[1], SKILL_POOL) || m[1],
      times: Number(m[2]),
    }))
    // 战法反推武将，纠正 OCR 错名（一一人/三继/戟东 等）
    if (!name || !GENERAL_POOL.includes(name)) {
      name = inferGeneralFromSkills(skills.map((s) => s.name)) || name || ''
    }
    // 仍无有效名则不塞垃圾
    if (name && !GENERAL_POOL.includes(name)) {
      const cjk = [...chunk.matchAll(/[一-龥]{2,3}/g)].map((x) => x[0])
        .filter((s) => !/普通|攻击|杀伤|救援|次|战法|统计|平局|我方|敌方|大营|中军|前锋/.test(s))
      const fm = cjk[0] ? fuzzyMatch(cjk[0], GENERAL_POOL) : ''
      name = fm || ''
    }
    const normalTimes = normalM ? Number(normalM[1]) : (timesAll[0] || 0)
    const normalKill = killNums[0] || 0
    if (!name && !normalTimes && killNums.length === 0) return null
    return {
      name: name || '',
      level: parseLv(chunk),
      normal_times: normalTimes,
      normal_kill: normalKill,
      skills,
      extra: skills.length
        ? skills.map((s, i) => `${s.name}×${s.times}${killNums[i + 1] != null ? ` 杀伤${killNums[i + 1]}` : ''}`).join('；')
        : (timesAll.length ? `普攻${normalTimes}次 杀伤${normalKill}` : ''),
    }
  }

  for (let i = 0; i < 6; i++) {
    const chi = (sections[`stat_r${i}_name_chi`] || []).join('\n')
    const rowChi = (sections[`stat_r${i}_chi`] || []).join('\n')
    const rowEng = (sections[`stat_r${i}`] || []).join('\n')
    const nameStrip = (sections[`stat_r${i}_name`] || []).join('\n')
    let name = ''
    for (const g of GENERAL_POOL) {
      if ((chi + rowChi + nameStrip).includes(g)) { name = g; break }
    }
    const row = parseRowText(rowChi + '\n' + chi + '\n' + rowEng + '\n' + nameStrip, name)
    if (row) rows.push(row)
  }

  // 战法反推兜底：无名或非法名 —— 始终优先合法推断，丢弃一一人/三继等垃圾
  for (const r of rows) {
    const inferred = inferGeneralFromSkills((r.skills || []).map((s) => s.name))
    if (inferred) r.name = inferred
    else if (!r.name || !GENERAL_POOL.includes(r.name)) r.name = ''
  }

  // 2) 回退：整段文本按普通攻击切块
  if (rows.length < 2) {
    const blocks = all.split(/(?=普通攻击)/).filter((b) => /次/.test(b))
    for (const b of blocks) {
      const row = parseRowText(b)
      if (row && !rows.find((x) => x.name === row.name && x.normal_times === row.normal_times)) {
        rows.push(row)
      }
      if (rows.length >= 6) break
    }
  }

  // 3) 回退：按名字
  if (rows.length < 2) {
    const nameHits = []
    for (let i = 0; i < lines.length; i++) {
      for (const g of GENERAL_POOL) {
        if (lines[i].includes(g)) {
          nameHits.push({ name: g, line: i })
          break
        }
      }
    }
    for (const hit of nameHits) {
      const chunk = lines.slice(hit.line, hit.line + 6).join('\n')
      const row = parseRowText(chunk, hit.name)
      if (row) rows.push(row)
      if (rows.length >= 6) break
    }
  }

  const side = /平局/.test(all) ? '平局' : ''
  return { side, rows, page_type: '战法统计' }
}

/** 统一入口：视觉模型优先，本地OCR回退 */
async function parseReportScreenshot(imagePath) {
  // 优先视觉模型，失败再回退本地OCR

  const visionResult = await visionAnalyze(imagePath, 'auto').catch(e => ({ ok: false, error: e.message }))

  // 优先使用视觉模型结果（精度更高）
  if (visionResult.ok && visionResult.data) {
    const d = visionResult.data
    const raw = visionResult.raw || ''
    const page = (d.page_type || d.type || '').toLowerCase()
      if (page === 'lineup' || page === '部队阵容') {
        return {
          kind: 'lineup',
          page_type: `部队阵容-${d.side || '我方'}`,
          side: d.side || '我方',
          player_name: d.player_name || d.nickname || '',
          alliance: d.alliance || '',
          generals: normalizeGenerals(d.generals || []),
          rows: [],
          raw,
          source: 'vision',
        }
      }
      if (page === 'general_stats' || page === 'generalstats' || page === '武将统计' ||
          page === 'skill_stats' || page === 'skillstats' || page === '战法统计') {
        const isSkill = page.includes('skill') || page.includes('战法')
        return {
          kind: isSkill ? 'skill_stats' : 'general_stats',
          page_type: isSkill ? '战法统计' : '武将统计',
          side: d.side || '',
          generals: [],
          rows: normalizeStatRows(d.rows || [], isSkill ? 'skill_stats' : 'general_stats'),
          raw,
          source: 'vision',
        }
      }
      if (page === 'battle' || page === '战报') {
        // 兼容新模型 {battle: {result, ...}} 和旧模型 {result, ...} 两种格式
        const b = d.battle || d
        const gens = (b.generals || d.generals || []).map((g) => ({
          slot: g.slot || '',
          name: g.name || '',
          level: Number(g.level) || 0,
          troops: Number(g.troops) || 0,
          red_stars: Number(g.red_stars) || 0,
          treasures: g.treasures || '',
          skills: Array.isArray(g.skills) ? g.skills.join('、') : (g.skills || ''),
          side: g.side || '',
        }))
        return {
          kind: 'battle',
          page_type: '战报',
          side: b.result || '',
          result: b.result || '',
          war_merit: Number(b.war_merit) || 0,
          nickname: b.our_player || '',
          full_name: b.our_player || '',
          battle: {
            result: b.result || '',
            war_merit: Number(b.war_merit) || 0,
            our: { player: b.our_player || '', alliance: b.our_alliance || '', generals: gens.filter((g) => g.side !== '敌方') },
            enemy: { player: b.enemy_player || '', alliance: b.enemy_alliance || '', generals: gens.filter((g) => g.side === '敌方') },
          },
          generals: [],
          rows: [],
          raw,
          source: 'vision',
        }
      }
      if (page === 'journey') {
        const n = (x) => Number(x) || 0
        return {
          kind: 'journey',
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
          generals: [],
          rows: [],
          raw,
          source: 'vision',
        }
        }
        }

        // 回退：使用本地 OCR 结果
  const ocrResult = await runLocalOcr(imagePath).catch(e => ({ kind: 'unknown', error: e.message }))
  return { ...ocrResult, source: 'ocr' }
}

/** 本地 OCR 识别（RapidOCR + Tesseract） */
async function runLocalOcr(imagePath) {
  const outDir = path.join(__dirname, '../data/report-crops', Date.now().toString(36))
  fs.mkdirSync(outDir, { recursive: true })

  let rapidText = ''
  try {
    const rapid = rapidOcrFull(imagePath)
    rapidText = rapid.text || ''
  } catch (e) {
    console.error('rapid fail', e.message)
  }

  try {
    execFileSync(pythonExe(), [path.join(__dirname, '../crop_lineup.py'), imagePath, outDir], {
      timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    console.error('lineup crop fail', e.message)
  }

  const crops = fs.existsSync(outDir)
    ? fs.readdirSync(outDir).filter((f) => f.endsWith('.png'))
    : []

  const parts = []
  const eng = await ocrMany(crops.map((c) => path.join(outDir, c)))

  if (rapidText) { parts.push('[REGION:rapid]'); parts.push(rapidText) }
  crops.forEach((c, i) => {
    parts.push(`[REGION:${c.replace(/\.png$/, '')}]`)
    parts.push((eng[i] && eng[i].text) || '')
  })

  const raw = parts.join('\n')
  const all = compactText(raw)

  let kind = 'unknown'
  if (/部队阵容/.test(all) || (/我方|敌方/.test(all) && /大营|中军|前锋/.test(all) && /Lv/i.test(all))) kind = 'lineup'
  else if (/普通杀伤|战法杀伤|总伤兵|本场伤兵/.test(all)) kind = 'general_stats'
  else if (/普通攻击/.test(all) && /次/.test(all)) kind = 'skill_stats'
  else if (/武将|战法|统计/.test(all) && /次|杀伤/.test(all)) kind = 'skill_stats'

  let data = {}
  if (kind === 'lineup') data = parseLineup(raw)
  else if (kind === 'general_stats') data = parseGeneralStats(raw)
  else if (kind === 'skill_stats') data = parseSkillStats(raw)
  else {
    const a = parseLineup(raw), b = parseGeneralStats(raw), c = parseSkillStats(raw)
    if (a.generals?.length >= 2) { kind = 'lineup'; data = a }
    else if (b.rows?.length >= 2) { kind = 'general_stats'; data = b }
    else if (c.rows?.length >= 1) { kind = 'skill_stats'; data = c }
    else data = { page_type: '未知', generals: [], rows: [] }
  }

  return { kind, raw, outDir, rapid_text: rapidText, ...data }
}

module.exports = { parseReportScreenshot, parseLineup, parseGeneralStats, parseSkillStats }
