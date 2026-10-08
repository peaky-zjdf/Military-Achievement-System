const path = require('path')
const { createWorker } = require('tesseract.js')

let workerPromise = null
let chiWorkerPromise = null

async function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      cachePath: path.join(__dirname, '../data/tesseract'),
      logger: () => {},
    })
  }
  return workerPromise
}

/** 常驻中文 worker（识别昵称用），失败可重试 */
async function getChiWorker() {
  if (chiWorkerPromise === false) {
    chiWorkerPromise = null // allow retry
  }
  if (chiWorkerPromise === null) {
    chiWorkerPromise = createWorker('chi_sim', 1, {
      cachePath: path.join(__dirname, '../data/tesseract'),
      logger: () => {},
    }).catch((e) => {
      console.error('chi worker init fail', e.message)
      chiWorkerPromise = null
      throw e
    })
  }
  return chiWorkerPromise
}

async function ocrImage(imagePath) {
  const worker = await getWorker()
  const { data } = await worker.recognize(imagePath)
  return {
    text: data.text || '',
    confidence: data.confidence || 0,
  }
}

async function ocrChiImage(imagePath) {
  try {
    const w = await getChiWorker()
    if (!w) return { text: '', confidence: 0 }
    const { data } = await w.recognize(imagePath)
    return { text: data.text || '', confidence: data.confidence || 0 }
  } catch (e) {
    console.error('chi ocr fail', e.message)
    return { text: '', confidence: 0 }
  }
}

/** 并行识别多张图（底层 eng 单 worker 会排队，但可与 chi 并行） */
async function ocrMany(paths) {
  return Promise.all(
    paths.map(async (p) => {
      try {
        return await ocrImage(p)
      } catch (e) {
        return { text: '', confidence: 0, error: e.message }
      }
    })
  )
}

/** Parse "61.1万" / "19万" / "48块" / "4,969" into a number. */
function parseAmount(raw) {
  if (raw == null) return null
  let s = String(raw).replace(/[，,\s]/g, '').trim()
  if (!s) return null

  const wan = s.match(/^(\d+(?:\.\d+)?)[万萬wW]$/)
  if (wan) return Math.round(Number(wan[1]) * 10000)

  const kuai = s.match(/^(\d+(?:\.\d+)?)[块塊kK]$/)
  if (kuai) return Math.round(Number(kuai[1]))

  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    return Number.isFinite(n) ? Math.round(n) : null
  }

  const m = s.match(/(\d+(?:\.\d+)?)[万萬wW块塊kK]?/)
  if (m) {
    const n = Number(m[1])
    if (!Number.isFinite(n)) return null
    if (/[万萬wW]/.test(s)) return Math.round(n * 10000)
    return Math.round(n)
  }
  return null
}

/**
 * Journey OCR often drops 万/块 and keeps trailing 7/8/k from the unit glyph.
 * Context-aware recovery:
 *   61.173 / 61.17 / 107.48 / 11.57 / 25.17  →  xx.x 万
 *   1973 / 19万3 → 19 万
 *   481k / 17618 → 块 count
 */
function recoverJourneyAmount(token, kind) {
  if (token == null) return null
  let s = String(token).replace(/[，,\s]/g, '').trim()
  if (!s) return null

  // explicit 万 always trusted
  if (/[万萬wW]/.test(s)) {
    const direct = parseAmount(s)
    if (direct != null) return direct
  }

  // 61.173 → 61.1万  (trailing 3 is half of 万)
  // 107.48 → 107.4万
  // 11.57  → 11.5万
  // 25.17  → 25.1万
  if (kind === 'wan') {
    const d1 = s.match(/^(\d{1,3}\.\d)73?$/)
    if (d1) return Math.round(Number(d1[1]) * 10000)
    const d2 = s.match(/^(\d{1,3}\.\d)[78]$/)
    if (d2) return Math.round(Number(d2[1]) * 10000)
    const d3 = s.match(/^(\d{1,3}\.\d{1,2})[78kK]?$/)
    if (d3 && s.includes('.')) {
      // 19.0 / 11.5 already handled; 1973 style handled below
      const n = Number(d3[1])
      if (n >= 1 && n < 10000) return Math.round(n * 10000)
    }
    // 1973 → 19万 (last digit garbled 万) — prefer 2-digit base for war/kill scale
    const i2 = s.match(/^(\d{2})[378]$/)
    if (i2) return Math.round(Number(i2[1]) * 10000)
    const i1 = s.match(/^(\d{2})\d?[378]$/)
    if (i1 && s.length >= 3 && s.length <= 4) return Math.round(Number(i1[1]) * 10000)
    const i0 = s.match(/^(\d{1,3})[378]$/)
    if (i0) return Math.round(Number(i0[1]) * 10000)
  }

  if (kind === 'kuai') {
    // 481k → 48块 (OCR merges 块 into trailing 1/k)
    const k = s.match(/^(\d{1,4})[kK块塊]$/)
    if (k) {
      let n = Number(k[1])
      if (n > 200 && n % 10 === 1) n = Math.floor(n / 10)
      if (n > 0 && n < 10000) return n
    }
    // 17618 → 176 (trailing 18 from 块)
    const k2 = s.match(/^(\d{2,4})18$/)
    if (k2) return Number(k2[1])
    // 481 → 48
    if (/^\d{3}$/.test(s)) {
      const n = Number(s)
      if (n % 10 === 1) return Math.floor(n / 10)
      return n
    }
    if (/^\d{1,4}$/.test(s)) return Number(s)
  }

  // demolish: plain integers
  if (kind === 'plain') {
    const n = Number(s)
    return Number.isFinite(n) ? Math.round(n) : null
  }

  return parseAmount(s)
}

/** Compact OCR text: remove spaces between CJK and between CJK/digits. */
function compactText(raw) {
  return (raw || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/：/g, ':')
    .replace(/，/g, ',')
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/(?<=[一-龥])\s+(?=[一-龥])/g, '')
        .replace(/(?<=[一-龥])\s+(?=[\d.])/g, '')
        .replace(/(?<=[\d.])\s+(?=[一-龥])/g, '')
    )
    .filter(Boolean)
    .join('\n')
}

/**
 * Fuzzy pick: find a line containing any keyword fragment, then take amount.
 * keywords: array of substrings, any match is enough
 */
function pickByKeywords(text, keywords) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const hit = keywords.some((k) => line.includes(k))
    if (!hit) continue
    // same line amount after keyword
    const after = line.slice(Math.max(0, line.search(new RegExp(keywords.map(escapeRe).join('|')))))
    const tok = after.match(/(\d+(?:[.,]\d+)?\s*[万萬块塊]?|\d+(?:[.,]\d+)?)/)
    if (tok) {
      const n = parseAmount(tok[1])
      if (n != null && n > 0) return n
    }
    // next non-empty line
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      const t2 = lines[j].match(/(\d+(?:[.,]\d+)?\s*[万萬块塊]?|\d+(?:[.,]\d+)?)/)
      if (t2) {
        const n2 = parseAmount(t2[1])
        if (n2 != null && n2 > 0) return n2
      }
    }
  }
  return null
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Journey page fixed layout (fraction of W/H) for 率土「个人征程」share image.
 * Used to crop noisy full-image OCR into readable strips.
 */
const JOURNEY_REGIONS = [
  { key: 'kills', box: [0.03, 0.28, 0.30, 0.60], labels: ['灭敌'] },
  { key: 'land', box: [0.22, 0.48, 0.48, 0.78], labels: ['抢夺土地', '抢地', '抢夺'] },
  { key: 'demolish', box: [0.40, 0.28, 0.64, 0.60], labels: ['拆除', '拆迁'] },
  { key: 'war', box: [0.60, 0.48, 0.86, 0.78], labels: ['武勋', '功勋'] },
  { key: 'city', box: [0.76, 0.28, 0.99, 0.60], labels: ['城池灭敌', '城池', '灭敌'] },
  { key: 'footer', box: [0.0, 0.88, 0.55, 1.0], labels: [] },
]

/**
 * Parse journey OCR text into screenshot fields.
 * Accepts full-page text and/or [REGION:key] strips from crop OCR.
 */
function parseJourneyText(rawText) {
  const all = compactText(rawText)
  const result = {
    kills_day: 0,
    kills_week: 0,
    land_day: 0,
    land_week: 0,
    demolish_day: 0,
    demolish_week: 0,
    war_merit_day: 0,
    war_merit_week: 0,
    war_merit_max_week: 0,
    city_kill_day: 0,
    city_kill_week: 0,
    nickname: null,
    server: null,
    matched: [],
  }

  const sections = {}
  let current = 'full'
  sections.full = []
  for (const line of all.split('\n')) {
    const m = line.match(/^\[REGION:([a-z]+)\]$/i)
    if (m) {
      current = m[1].toLowerCase()
      sections[current] = sections[current] || []
      continue
    }
    sections[current] = sections[current] || []
    sections[current].push(line)
  }

  const textOf = (key) => (sections[key] || []).join('\n')
  const full = sections.full.join('\n') || all

  /** amounts in a region strip, order preserved, drop year-like 2026 */
  const amountsIn = (key, kind) => {
    const t = textOf(key)
    if (!t) return []
    const out = []
    const re = /(\d+(?:[.,]\d+)?\s*[万萬块塊kK]?)/g
    let m
    while ((m = re.exec(t))) {
      const rawTok = m[1]
      // drop date/year noise like 2026, 2026598, 202648H
      if (/202[0-9]/.test(rawTok.replace(/[.,]/g, ''))) continue
      const n = recoverJourneyAmount(rawTok, kind || 'plain')
      if (n == null) continue
      if (n >= 2020 && n <= 2035) continue
      if (kind === 'wan' && (n < 10000 || n > 20000000)) continue
      if (kind === 'kuai' && (n < 10 || n > 5000)) continue
      if (kind === 'plain' && (n < 50 || n > 500000)) continue
      out.push(n)
    }
    // unique preserve order
    return [...new Set(out)]
  }

  /** take last N (skip left-side bleed from neighbor column) */
  const lastN = (arr, n) => (arr.length > n ? arr.slice(-n) : arr)

  // Preferred: positional assignment from region crops
  // kills: day value is above week value in layout → first two
  const killsNums = amountsIn('kills', 'wan')
  if (killsNums.length >= 2) {
    result.kills_day = killsNums[0]
    result.kills_week = killsNums[1]
  } else if (killsNums.length === 1) {
    result.kills_week = killsNums[0]
  }

  const landNums = lastN(amountsIn('land', 'kuai'), 2)
  if (landNums.length >= 2) {
    result.land_day = landNums[0]
    result.land_week = landNums[1]
  } else if (landNums.length === 1) {
    result.land_week = landNums[0]
  }

  const demoNums = lastN(amountsIn('demolish', 'plain'), 2)
  if (demoNums.length >= 2) {
    result.demolish_day = demoNums[0]
    result.demolish_week = demoNums[1]
  } else if (demoNums.length === 1) {
    result.demolish_week = demoNums[0]
  }

  const warNums = lastN(amountsIn('war', 'wan'), 2)
  if (warNums.length >= 2) {
    result.war_merit_max_week = warNums[0]
    result.war_merit_week = warNums[1]
  } else if (warNums.length === 1) {
    result.war_merit_week = warNums[0]
  }

  const cityNums = lastN(amountsIn('city', 'wan'), 2)
  if (cityNums.length >= 2) {
    result.city_kill_day = cityNums[0]
    result.city_kill_week = cityNums[1]
  } else if (cityNums.length === 1) {
    result.city_kill_week = cityNums[0]
  }

  // Label-based fallback / refine (when full OCR has readable labels)
  if (!result.kills_day) result.kills_day = pickByKeywords(full, ['单日最多灭敌', '单日灭敌', '最多灭敌']) ?? 0
  if (!result.kills_week) result.kills_week = pickByKeywords(full, ['上周灭敌', '本周灭敌']) ?? 0
  if (!result.land_day) result.land_day = pickByKeywords(full, ['单日最高抢夺土地', '单日抢夺土地', '最高抢夺']) ?? 0
  if (!result.land_week) result.land_week = pickByKeywords(full, ['上周抢夺土地', '本周抢夺土地']) ?? 0
  if (!result.demolish_day) result.demolish_day = pickByKeywords(full, ['单日最高拆除', '单日拆除', '最高拆除']) ?? 0
  if (!result.demolish_week) result.demolish_week = pickByKeywords(full, ['上周拆除', '本周拆除']) ?? 0
  if (!result.war_merit_max_week) result.war_merit_max_week = pickByKeywords(full, ['单周最高武勋', '周最高武勋', '最高武勋']) ?? 0
  if (!result.war_merit_week) result.war_merit_week = pickByKeywords(full, ['上周武勋', '本周武勋']) ?? 0
  if (!result.city_kill_day) result.city_kill_day = pickByKeywords(full, ['单日最高城池灭敌', '单日城池灭敌']) ?? 0
  if (!result.city_kill_week) result.city_kill_week = pickByKeywords(full, ['上周城池灭敌', '本周城池灭敌']) ?? 0

  // Also try keyword match inside each region strip (handles "上周武勋 11.5万")
  const tryRegionLabel = (key, dayKeys, weekKeys, dayField, weekField) => {
    const t = textOf(key) + '\n' + full
    if (!result[dayField]) result[dayField] = pickByKeywords(t, dayKeys) ?? 0
    if (!result[weekField]) result[weekField] = pickByKeywords(t, weekKeys) ?? 0
  }
  tryRegionLabel('kills', ['单日最多灭敌', '最多灭敌'], ['上周灭敌'], 'kills_day', 'kills_week')
  tryRegionLabel('land', ['单日最高抢夺土地', '最高抢夺'], ['上周抢夺土地'], 'land_day', 'land_week')
  tryRegionLabel('demolish', ['单日最高拆除', '最高拆除'], ['上周拆除'], 'demolish_day', 'demolish_week')
  tryRegionLabel('war', ['单周最高武勋', '最高武勋'], ['上周武勋'], 'war_merit_max_week', 'war_merit_week')
  tryRegionLabel('city', ['单日最高城池灭敌', '城池灭敌'], ['上周城池灭敌'], 'city_kill_day', 'city_kill_week')

  // footer nickname / server
  const footer = textOf('footer') + '\n' + textOf('full') + '\n' + full
  const fm = compactText(footer).match(
    /(?:经典服|征服服|流浪军)?\s*(S\d{1,5}[-–—][一-龥A-Za-z0-9]{1,8})\s*[|｜·・\-–—]?\s*([一-龥A-Za-z0-9]{2,12})/
  )
  if (fm) {
    result.server = fm[1]
    result.nickname = fm[2]
  } else {
    const pipe = compactText(footer).match(/S\d{1,5}\s*[-–—]\s*[一-龥A-Za-z0-9]{1,8}\s*[|｜]\s*([一-龥A-Za-z0-9]{2,12})/)
    if (pipe) result.nickname = pipe[1]
  }
  // fallback: last CJK name in footer strip
  if (!result.nickname && textOf('footer')) {
    const cjk = compactText(textOf('footer')).match(/([一-龥]{2,8})\s*$/)
    if (cjk && !/经典服|下载|体验/.test(cjk[1])) result.nickname = cjk[1]
  }

  const hints = []
  if (result.kills_week || result.kills_day) hints.push('灭敌')
  if (result.land_week || result.land_day) hints.push('抢地')
  if (result.demolish_week || result.demolish_day) hints.push('拆除')
  if (result.war_merit_week || result.war_merit_max_week) hints.push('武勋')
  if (result.city_kill_week || result.city_kill_day) hints.push('城池灭敌')
  if (result.nickname) hints.push('昵称')
  result.matched = hints
  result.page_type = hints.length >= 2 ? '个人征程' : '未知'
  return result
}

function extractAmounts(text) {
  const out = []
  const re = /(\d+(?:[.,]\d+)?\s*[万萬块塊]?)/g
  let m
  while ((m = re.exec(text))) {
    const n = parseAmount(m[1])
    if (n != null && n > 0 && n < 100000000) out.push(n)
  }
  return out
}

/** Parse battle report using [REGION:xxx] strips when available. */
/** 率土常见武将名，用于 OCR 纠错 */
const GENERAL_NAME_POOL = [
  '荀彧', '贾诩', '郭嘉', '甄洛', '张春华', '吕布', '赵云', '关羽', '张飞', '马超', '黄忠',
  '曹操', '刘备', '孙权', '司马懿', '诸葛亮', '周瑜', '陆逊', '吕蒙', '甘宁', '太史慈',
  '张辽', '许褚', '典韦', '夏侯惇', '夏侯渊', '徐晃', '张郃', '邓艾', '钟会', '姜维',
  '庞统', '法正', '魏延', '马岱', '关银屏', '孙尚香', '大乔', '小乔', '蔡文姬', '貂蝉',
  '华佗', '左慈', '于吉', '张角', '袁绍', '董卓', '陈宫', '高顺', '沮授', '徐庶',
  '黄月英', '马云禄', '祝融', '王异', '严颜', '张宁',
]

function fuzzyGeneralName(raw) {
  if (!raw) return ''
  const s = compactText(raw).replace(/[^一-龥]/g, '')
  if (!s) return ''
  for (const g of GENERAL_NAME_POOL) {
    if (s.includes(g) || (s.length >= 2 && g.includes(s))) return g
  }
  if (s.length >= 2 && s.length <= 3) return s
  return s.slice(0, 3)
}

function fuzzyPlayerName(raw) {
  if (!raw) return null
  let s = compactText(raw).replace(/^[口橱]/, '').replace(/1/g, '|')
  const pipe = s.match(/([一-龥A-Za-z0-9]{2,8})\s*[|｜]\s*([一-龥A-Za-z0-9]{2,12})/)
  if (pipe && /[一-龥]/.test(pipe[2])) return `${pipe[1]} | ${pipe[2]}`
  const cjk = s.match(/[一-龥]{2,12}/)
  return cjk ? cjk[0] : null
}

function parseBattleRegions(rawText) {
  const sections = {}
  let cur = 'full'
  sections.full = []
  for (const line of compactText(rawText).split('\n')) {
    const m = line.match(/^\[REGION:([a-z_]+)\]$/i)
    if (m) {
      cur = m[1].toLowerCase()
      sections[cur] = sections[cur] || []
      continue
    }
    sections[cur] = sections[cur] || []
    sections[cur].push(line)
  }
  const t = (k) => (sections[k] || []).join('\n')
  const tc = (k) => compactText(t(k) + '\n' + t(k + '_chi'))

  // result / war merit from center
  const center = tc('battle_center') + '\n' + t('battle_center_chi') + '\n' + t('full')
  let warMerit = null
  const plus = center.match(/武勋\s*[+＋]\s*(\d[\d,，]*)/)
  if (plus) warMerit = Number(String(plus[1]).replace(/[^0-9]/g, ''))
  let result = null
  if (/我方战败|战败/.test(center)) result = '败'
  else if (/我方战胜|战胜|胜利/.test(center)) result = '胜'

  const parsePlayer = (nameKey, allyKey, troopsKey) => {
    const nameText = tc(nameKey).replace(/1/g, '|') // OCR 常把 | 读成 1
    const allyText = tc(allyKey)
    const troopsText = t(troopsKey)
    let player = null
    // 优先纯中文名（战报常见）
    const cjkOnly = [...nameText.matchAll(/[一-龥]{2,8}/g)].map((x) => x[0])
      .filter((s) => !/武勋|战报|详情|结果|胜|败|兵力|战况|回放|统计|阵容|地点|大营|中军|前锋|士气|找马|兵力/.test(s))
    const pipe = nameText.match(/([一-龥A-Za-z0-9]{2,8})\s*[|｜丨]\s*([一-龥A-Za-z0-9]{2,12})/)
    if (pipe && /[一-龥]/.test(pipe[2])) {
      player = `${pipe[1]} | ${pipe[2]}`
    } else if (cjkOnly.length) {
      if (cjkOnly.length >= 2 && cjkOnly[0].length <= 4) player = `${cjkOnly[0]} | ${cjkOnly[1]}`
      else player = cjkOnly[0]
    } else if (pipe) {
      player = pipe[0]
    }
    if (player) player = fuzzyPlayerName(player) || player
    let alliance = null
    const ap = allyText.match(/([一-龥]{2,8})\s*[|｜]\s*([一-龥]{2,8})/)
    if (ap) alliance = `${ap[1]} | ${ap[2]}`
    else {
      const a2 = [...allyText.matchAll(/[一-龥]{2,8}/g)].map((x) => x[0]).find((s) => !/武勋|兵力|战报|详情|胜|败/.test(s))
      if (a2) alliance = a2
    }
    const bar = troopsText.match(/(\d{1,5})\/(\d{1,5})/)
    const troops = bar ? { current: Number(bar[1]), max: Number(bar[2]) } : null
    return { player, alliance, troops }
  }

  const parseGens = (key) => {
    // 合并 chi + eng，chi 负责中文名，eng 负责 Lv/兵力
    const rawChi = t(key + '_chi') || ''
    const rawEng = t(key) || ''
    const raw = rawChi + '\n' + rawEng
    const text = compactText(raw)

    const troopSeq = [...raw.matchAll(/兵力\s*(\d{1,5})/g)].map((m) => Number(m[1]))
      .concat([...rawEng.matchAll(/\b(\d{3,5})\b/g)].map((m) => Number(m[1])).filter((n) => n > 100))
    const lvSeq = [...raw.matchAll(/Lv\.?\s*(\d{1,2})/gi)].map((m) => Number(m[1]))

    // 武将名：按阵营切开再取 2 字名
    let names = []
    const compactCamp = rawChi.replace(/\s+/g, '')
    const segs = compactCamp.split(/(?=[魏蜀吴群汉晋])/).filter(Boolean)
    for (const seg of segs) {
      const m = seg.match(/^[魏蜀吴群汉晋]([一-龥]{2,3})/)
      if (m) {
        let nm = m[1]
        nm = nm.replace(/[魏蜀吴群汉晋]$/, '').replace(/兵力?$/, '')
        const fn = fuzzyGeneralName(nm)
        if (fn.length >= 2) names.push({ camp: seg[0], name: fn })
      }
      if (names.length >= 3) break
    }
    if (names.length < 3) {
      // 无阵营前缀：从「荀彧 贾诩 郭嘉」行抽 2 字 CJK
      const lines = rawChi.split('\n')
      for (const line of lines) {
        if (/兵力|Lv/i.test(line)) continue
        const cands = [...compactText(line).matchAll(/[一-龥]{2,3}/g)]
          .map((x) => x[0])
          .filter((s) => !/兵力|等级|士气|战法|大营|中军|前锋|战报|详情|我方|敌方|武勋|胜|败|结果|回放|统计/.test(s))
        for (const c of cands) {
          if (names.length >= 3) break
          const fn = fuzzyGeneralName(c)
          if (fn && !names.find((x) => x.name === fn)) names.push({ camp: '', name: fn })
        }
        if (names.length >= 3) break
      }
    }

    const slots = ['大营', '中军', '前锋']
    // 兵力优先用「兵力N」序列；没有则用 eng 大数
    let troopsUse = troopSeq.filter((n) => /兵力/.test(raw) ? true : n >= 1000)
    if (!/兵力/.test(raw)) {
      troopsUse = [...rawEng.matchAll(/\b(\d{4,5})\b/g)].map((m) => Number(m[1])).filter((n) => n > 500).slice(0, 3)
    } else {
      troopsUse = [...raw.matchAll(/兵力\s*(\d{1,5})/g)].map((m) => Number(m[1]))
    }

    const out = []
    for (let i = 0; i < 3; i++) {
      if (!names[i] && troopsUse[i] == null && lvSeq[i] == null) continue
      out.push({
        slot: slots[i],
        camp: names[i]?.camp || '',
        name: names[i]?.name || '',
        troops: troopsUse[i] || 0,
        level: lvSeq[i] || 0,
        red_stars: 0,
        treasures: '',
      })
    }

    const tr = [...rawChi.matchAll(/[极拗悍]\s*([一-龥]{2,6})/g)].map((x) => compactText(x[1]))
    out.forEach((g, i) => { if (tr[i]) g.treasures = tr[i] })
    // 宝物常见格式：彤素·英勇 / 八棱·镔铁锤
    const tr2 = [...rawChi.matchAll(/([一-龥]{2,4})\s*[·・]\s*([一-龥]{2,6})/g)].map((m) => `${m[1]}·${m[2]}`)
    out.forEach((g, i) => { if (!g.treasures && tr2[i]) g.treasures = tr2[i] })
    const stars = [...rawChi.matchAll(/([★☆]{3,5})/g)].map((m) => (m[1].match(/★/g) || []).length)
    out.forEach((g, i) => { if (stars[i]) g.red_stars = stars[i] })
    // 战法：极/拗 后的短词
    const sk = [...rawChi.matchAll(/(?:极|拗|悍)\s*([一-龥]{2,4})/g)].map((x) => compactText(x[1]))
    out.forEach((g, i) => { if (!g.skills && sk[i]) g.skills = sk[i] })

    return out.filter((g) => g.name || g.level || g.troops).slice(0, 3)
  }

  const our = parsePlayer('battle_left_name', 'battle_left_ally', 'battle_left_troops')
  const enemy = parsePlayer('battle_right_name', 'battle_right_ally', 'battle_right_troops')
  const ourGens = parseGens('battle_left_gens')
  const enemyGens = parseGens('battle_right_gens')

  // fallback: first pipe name is our
  if (!our.player) {
    const all = compactText(rawText)
    const pipe = all.match(/([一-龥A-Za-z0-9]{2,8})\s*[|｜丨]\s*([一-龥A-Za-z0-9]{2,12})/)
    if (pipe) our.player = `${pipe[1]} | ${pipe[2]}`
  }

  const hasAny = warMerit || result || our.player || enemy.player || ourGens.length || enemyGens.length
  if (!hasAny) return null

  return {
    result,
    war_merit: warMerit || 0,
    our: { ...our, generals: ourGens },
    enemy: { ...enemy, generals: enemyGens },
  }
}

/** Full parse used by battle-report OCR path. */
function parseBattleReport(rawText, opts = {}) {
  const all = compactText(rawText)
  const isBattle =
    opts.page === 'battle' ||
    /我方战败|我方战胜|战报详情|武勋\s*[+＋]|战况回放|REGION:battle/.test(all)

  const isJourney =
    !isBattle &&
    (opts.page === 'journey' ||
      /个人征程|单日最多灭敌|单周最高武勋|上周武勋|上周拆除|单日最高城池灭敌|单日最高抢夺土地/.test(all))

  if (isJourney) {
    const j = parseJourneyText(rawText)
    return {
      page_type: j.page_type,
      kills_day: j.kills_day,
      kills_week: j.kills_week,
      land_day: j.land_day,
      land_week: j.land_week,
      demolish_day: j.demolish_day,
      demolish_week: j.demolish_week,
      war_merit_day: j.war_merit_day,
      war_merit_week: j.war_merit_week,
      war_merit_max_week: j.war_merit_max_week,
      city_kill_day: j.city_kill_day,
      city_kill_week: j.city_kill_week,
      war_merit: j.war_merit_week || j.war_merit_max_week,
      demolition: j.demolish_week || j.demolish_day,
      land_flips: j.land_week || j.land_day,
      kills: j.kills_week || j.kills_day,
      city_kills: j.city_kill_week || j.city_kill_day,
      troops: null,
      server: j.server,
      nickname: j.nickname,
      type: '野战',
      raw_text: rawText,
      matched: j.matched,
    }
  }

  // ---- 战报截图 ----
  let regionBattle = null
  try {
    regionBattle = parseBattleRegions(rawText)
  } catch (e) {
    console.error('parseBattleRegions fail', e.message)
  }

  // 武勋 +937 优先
  let warMerit = regionBattle?.war_merit || null
  const plus = all.match(/武勋\s*[+＋]\s*(\d[\d,，]*)/)
  if (plus) warMerit = Number(String(plus[1]).replace(/[^0-9]/g, ''))
  if (warMerit == null) {
    warMerit = pickByKeywords(all, ['本场武勋', '获得武勋', '武勋', '功勋', '战功'])
  }

  const demolition = pickByKeywords(all, ['拆迁值', '拆迁', '拆除', '攻城值', '拆迁耐久'])
  const troops = pickByKeywords(all, ['剩余兵力', '兵力'])

  // 结果
  let result = regionBattle?.result || null
  if (!result && /我方战败|我方失败/.test(all)) result = '败'
  else if (!result && /我方战胜|我方胜利/.test(all)) result = '胜'
  else if (!result && /(^|\n)败(\n|$)/.test(all)) result = '败'
  else if (!result && /(^|\n)胜(\n|$)/.test(all)) result = '胜'

  // 双方玩家：x/y 兵力条 + 名称
  // 我方在左：74/15506 云衍|玄清 ；敌方在右：橙色的光 22783/29500
  const troopBars = [...all.matchAll(/(\d{1,5})\/(\d{1,5})/g)].map((m) => ({
    left: Number(m[1]),
    right: Number(m[2]),
    index: m.index,
  }))

  // 玩家名候选：带 | 的，或短 CJK 名
  const pipeNames = [...all.matchAll(/([一-龥A-Za-z0-9]{2,8})\s*[|｜丨]\s*([一-龥A-Za-z0-9]{2,12})/g)]
    .map((m) => ({ server: m[1], nick: m[2], full: `${m[1]} | ${m[2]}`, index: m.index }))

  // 同盟：嘴哥找马马 / 极道 | 霜降 / 汉 极道
  const allianceRe = /(?:^|\n)([一-龥]{2,8}(?:\s*[|｜]\s*[一-龥]{2,8})?)(?:\s*[聚漢汉魏蜀群吴])?(?:\n|$)/g
  const alliances = []
  let am
  while ((am = allianceRe.exec(all))) {
    const a = am[1].trim()
    if (/武勋|战报|详情|结果|胜|败|兵力|武将|大营|中军|前锋|战况|回放|统计|阵容|地点/.test(a)) continue
    if (a.length >= 2 && a.length <= 12) alliances.push({ name: a, index: am.index })
  }

  // 武将卡：阵营 + 名字 + Lv + 兵力
  // 如 魏 荀彧 ... 兵力0 2545 Lv.44
  const genRe = /(?:魏|蜀|吴|群|汉|晋)\s*([一-龥]{2,4})[\s\S]{0,80}?兵力\s*(\d{1,5})[\s\S]{0,40}?Lv\.?\s*(\d{1,2})/g
  const gens = []
  let gm
  while ((gm = genRe.exec(all))) {
    gens.push({
      camp: all[gm.index],
      name: gm[1],
      troops: Number(gm[2]),
      level: Number(gm[3]),
      index: gm.index,
    })
  }
  // 也抓「Lv 在前」的顺序
  if (gens.length < 3) {
    const genRe2 = /(魏|蜀|吴|群|汉|晋)\s*([一-龥]{2,4})[\s\S]{0,100}?Lv\.?\s*(\d{1,2})[\s\S]{0,40}?兵力\s*(\d{1,5})/g
    let g2
    while ((g2 = genRe2.exec(all))) {
      if (gens.find((x) => x.name === g2[2] && Math.abs(x.index - g2.index) < 20)) continue
      gens.push({
        camp: g2[1],
        name: g2[2],
        level: Number(g2[3]),
        troops: Number(g2[4]),
        index: g2.index,
      })
    }
  }

  // 红将星数：连续 ★
  const starsRe = /([★]{3,5}|[☆]{3,5})/g
  const starRuns = []
  let sm
  while ((sm = starsRe.exec(all))) {
    starRuns.push({ count: (sm[1].match(/★/g) || []).length || (sm[1].match(/☆/g) || []).length, index: sm.index })
  }

  // 昵称：优先 pipe 名（我方常见）
  let nickname = null
  let server = null
  let fullName = null
  if (regionBattle?.our?.player) {
    fullName = regionBattle.our.player
    const p = fullName.split(/\s*[|｜]\s*/)
    server = p[0]
    nickname = p[1] || p[0]
  } else if (pipeNames.length) {
    // 第一个 pipe 名通常是战报主角（我方）
    server = pipeNames[0].server
    nickname = pipeNames[0].nick
    fullName = pipeNames[0].full
  }
  if (!nickname) {
    const fm = all.match(
      /(?:经典服|征服服)?\s*(S\d{1,5}[-–—][一-龥A-Za-z0-9]{1,8})\s*[|｜]?\s*([一-龥A-Za-z0-9]{2,12})/
    )
    if (fm) {
      server = fm[1]
      nickname = fm[2]
      fullName = `${fm[1]} | ${fm[2]}`
    }
  }

  // 组装双方（优先 region）
  const ourName = fullName || nickname || null
  const ourAlliance = regionBattle?.our?.alliance || alliances[0]?.name || null
  const ourTroops = regionBattle?.our?.troops || (troopBars[0] ? { current: troopBars[0].left, max: troopBars[0].right } : null)
  const ourGens = regionBattle?.our?.generals?.length
    ? regionBattle.our.generals
    : gens.filter((g) => g.index < (troopBars[1]?.index ?? Infinity)).slice(0, 3)

  // 敌方玩家
  let enemyName = regionBattle?.enemy?.player || null
  let enemyAlliance = regionBattle?.enemy?.alliance || null
  if (troopBars.length >= 2 && !enemyName) {
    const eIdx = troopBars[1].index
    const ePipe = pipeNames.find((p) => p.index > eIdx - 200 && p.index < eIdx + 80)
    if (ePipe) {
      enemyName = ePipe.full
      enemyAlliance = ePipe.server
    }
    if (!enemyName) {
      const near = all.slice(Math.max(0, eIdx - 120), eIdx + 40)
      const nm = near.match(/([一-龥A-Za-z0-9]{2,8})\s*\n?\s*\d{1,5}\/\d{1,5}/) ||
        near.match(/([一-龥A-Za-z0-9]{2,8})/)
      if (nm && !/武勋|兵力|战报|详情/.test(nm[1])) enemyName = nm[1]
    }
    if (!enemyAlliance && alliances[1]) enemyAlliance = alliances[1].name
    const eAll = all.slice(Math.max(0, eIdx - 80), eIdx + 120).match(/([一-龥]{2,6})\s*[|｜]\s*([一-龥]{2,8})/)
    if (eAll && eAll[1] !== server) enemyAlliance = `${eAll[1]} | ${eAll[2]}`
  }
  const enemyTroops = regionBattle?.enemy?.troops ||
    (troopBars[1] ? { current: troopBars[1].left, max: troopBars[1].right } : null)
  const enemyGens = regionBattle?.enemy?.generals?.length
    ? regionBattle.enemy.generals
    : gens.filter((g) => g.index >= (troopBars[1]?.index ?? Infinity)).slice(0, 3)
  // 若无法按 index 切分，后 3 个给敌方
  let ourList = ourGens
  let enemyList = enemyGens
  if (gens.length >= 6 && ourGens.length + enemyGens.length < 6) {
    ourList = gens.slice(0, 3)
    enemyList = gens.slice(3, 6)
  }

  const attachStars = (list) =>
    list.map((g) => {
      const near = starRuns.filter((s) => Math.abs(s.index - g.index) < 120)
      const red = near.length ? Math.max(...near.map((s) => s.count)) : 0
      return { ...g, red_stars: red || 0 }
    })

  const matched = []
  if (warMerit != null) matched.push('武勋')
  if (demolition != null) matched.push('拆迁')
  if (fullName || nickname) matched.push('我方玩家')
  if (enemyName) matched.push('敌方玩家')
  if (ourList.length || enemyList.length) matched.push('武将阵容')
  if (result) matched.push('胜负')
  if (isBattle) matched.push('战报')

  return {
    page_type: isBattle ? '战报' : '战报/其他',
    kills_day: 0, kills_week: 0, land_day: 0, land_week: 0,
    demolish_day: 0, demolish_week: demolition || 0,
    war_merit_day: warMerit || 0, war_merit_week: 0, war_merit_max_week: 0,
    city_kill_day: 0, city_kill_week: 0,
    war_merit: warMerit,
    demolition: demolition || 0,
    troops,
    land_flips: 0,
    kills: null,
    city_kills: null,
    server,
    nickname,
    full_name: fullName || nickname,
    battle: {
      result,
      war_merit: warMerit || 0,
      our: {
        player: ourName,
        alliance: ourAlliance,
        troops: ourTroops,
        generals: attachStars(ourList),
      },
      enemy: {
        player: enemyName,
        alliance: enemyAlliance,
        troops: enemyTroops,
        generals: attachStars(enemyList),
      },
    },
    type: opts.type || '野战',
    raw_text: rawText,
    matched,

  }
}

/** Match OCR nickname against members table (fuzzy). */
function matchMember(db, nickname) {
  if (!nickname) return null
  // full name "云衍 | 玄清" → try after pipe, then whole string
  const parts = String(nickname).split(/[|｜丨·・]/).map((s) => s.trim()).filter(Boolean)
  const candidates = [nickname, ...parts].filter(Boolean)

  for (const c of candidates) {
    const exact = db.prepare('SELECT * FROM members WHERE nickname = ? OR game_id = ?').get(c, c)
    if (exact) return exact
  }
  for (const c of candidates) {
    const like = db.prepare('SELECT * FROM members WHERE nickname LIKE ? LIMIT 1').get(`%${c}%`)
    if (like) return like
  }

  const all = db.prepare("SELECT * FROM members WHERE status != '离盟'").all()
  let best = null
  let bestScore = 0
  for (const target of candidates) {
    const t = target.replace(/\s+/g, '')
    if (t.length < 2) continue
    for (const m of all) {
      const n = (m.nickname || '').replace(/\s+/g, '')
      if (!n) continue
      let shared = 0
      const set = new Set(n)
      for (const ch of t) if (set.has(ch)) shared++
      const score = shared / Math.max(t.length, n.length)
      if (score > bestScore) {
        bestScore = score
        best = m
      }
    }
  }
  return bestScore >= 0.7 ? best : null
}

module.exports = {
  ocrImage,
  ocrChiImage,
  ocrMany,
  parseBattleReport,
  parseJourneyText,
  matchMember,
  parseAmount,
  recoverJourneyAmount,
  compactText,
}
