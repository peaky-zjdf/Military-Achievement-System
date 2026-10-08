const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { ocrImage, ocrChiImage, ocrMany, parseJourneyText } = require('./ocr')
const { pythonExe } = require('./python')

const CROP_ROOT = path.join(__dirname, '../data/journey-crops')

function extractNicknameFromText(...texts) {
  const all = texts.filter(Boolean).join('\n')
  const compact = all
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/(?<=[一-龥])\s+(?=[一-龥])/g, '')
        .replace(/(?<=[一-龥])\s+(?=[\d.Ss-])/g, '')
        .replace(/(?<=[\d.Ss-])\s+(?=[一-龥])/g, '')
    )
    .join('\n')

  // 经典服 S3529-云衍 | 玄清
  let m = compact.match(
    /(?:经典服|征服服|流浪军)?\s*(S\d{1,5}\s*[-–—]\s*[一-龥A-Za-z0-9]{1,8})\s*[|｜·・\-–—]?\s*([一-龥A-Za-z0-9]{2,12})/
  )
  if (m) {
    const server = m[1].replace(/\s+/g, '')
    const nickname = m[2]
    return { server, nickname, full_name: `${server} | ${nickname}` }
  }

  // 云衍 | 玄清
  m = compact.match(/([一-龥A-Za-z0-9]{2,8})\s*[|｜丨]\s*([一-龥A-Za-z0-9]{2,12})/)
  if (m) {
    return { server: m[1], nickname: m[2], full_name: `${m[1]} | ${m[2]}` }
  }

  // any CJK 2-8 chars that looks like a player name (not UI labels)
  const cjkRuns = [...compact.matchAll(/[一-龥]{2,8}/g)].map((x) => x[0])
  const bad = /经典服|征服服|流浪军|下载|体验|个人|征程|征伐|征战|地址|网易|游戏|长按|图片|灭敌|武勋|拆除|抢夺|土地|城池|上周|单日|单周/
  const name = cjkRuns.find((s) => !bad.test(s))
  if (name) return { server: null, nickname: name, full_name: name }

  return { server: null, nickname: null, full_name: null }
}

/**
 * Bright-region journey OCR (for 个人征程 share images).
 * Crops gold/white numbers, OCRs each strip, recovers 万/块 units.
 */
async function ocrJourneyImage(imagePath) {
  const outDir = path.join(CROP_ROOT, Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6))
  fs.mkdirSync(outDir, { recursive: true })

  const script = path.join(__dirname, '../crop_bright.py')
  let cropOk = false
  try {
    execFileSync(pythonExe(), [script, imagePath, outDir], {
      timeout: 25000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    cropOk = true
  } catch (e) {
    console.error('crop_bright failed', e.message)
  }

  const parts = []
  let confSum = 0
  let confN = 0

  const keys = ['kills', 'land', 'demolish', 'war', 'city', 'footer']
  const cropPaths = keys
    .map((k) => ({ key: k, p: path.join(outDir, `b-${k}.png`) }))
    .filter((x) => fs.existsSync(x.p))

  // eng 区域并行 + chi 页脚并行
  const nameCrop = path.join(outDir, 'b-footer_name.png')
  const footerCrop = path.join(outDir, 'b-footer.png')
  const chiJobs = []
  if (fs.existsSync(nameCrop)) chiJobs.push(ocrChiImage(nameCrop))
  if (fs.existsSync(footerCrop)) chiJobs.push(ocrChiImage(footerCrop))

  const [engResults, chiResults] = await Promise.all([
    ocrMany(cropPaths.map((x) => x.p)),
    Promise.all(chiJobs),
  ])

  cropPaths.forEach((x, i) => {
    const r = engResults[i] || { text: '', confidence: 0 }
    parts.push(`[REGION:${x.key}]`)
    parts.push(r.text || '')
    confSum += r.confidence || 0
    confN++
  })

  const combined = parts.join('\n')
  let parsed = parseJourneyText(combined)

  const chiFooter = chiResults.map((r) => r.text || '').filter(Boolean).join('\n')

  const named = extractNicknameFromText(chiFooter, textOfRegion(parts, 'footer'), combined)
  if (named.full_name) parsed.full_name = named.full_name
  if (named.nickname) parsed.nickname = named.nickname
  if (named.server) parsed.server = named.server

  const got =
    parsed.war_merit_week ||
    parsed.war_merit_max_week ||
    parsed.demolish_week ||
    parsed.kills_week ||
    parsed.land_week ||
    parsed.city_kill_week

  if (!got) {
    try {
      const full = await ocrImage(imagePath)
      const p2 = parseJourneyText(combined + '\n[REGION:full]\n' + (full.text || ''))
      confSum += full.confidence || 0
      confN++
      for (const k of Object.keys(parsed)) {
        if ((parsed[k] === 0 || parsed[k] == null) && p2[k]) parsed[k] = p2[k]
      }
      const named2 = extractNicknameFromText(chiFooter, full.text || '')
      if (!parsed.nickname && named2.nickname) parsed.nickname = named2.nickname
    } catch (e) {
      console.error('full ocr fail', e.message)
    }
  }

  if (!parsed.war_merit) {
    parsed.war_merit = parsed.war_merit_week || parsed.war_merit_max_week || 0
  }
  if (!parsed.demolition) {
    parsed.demolition = parsed.demolish_week || parsed.demolish_day || 0
  }

  return {
    text: combined + (chiFooter ? '\n[REGION:footer_chi]\n' + chiFooter : ''),
    confidence: confN ? Math.round(confSum / confN) : 0,
    parsed,
  }
}

function textOfRegion(parts, key) {
  const i = parts.indexOf(`[REGION:${key}]`)
  return i >= 0 ? parts[i + 1] || '' : ''
}

module.exports = { ocrJourneyImage, extractNicknameFromText }

