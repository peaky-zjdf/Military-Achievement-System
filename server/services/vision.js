const { getSetting } = require('../db')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { pythonExe } = require('./python')

function getVisionConfig() {
  return {
    enabled: getSetting('vision_enabled') === '1',
    baseUrl: (getSetting('vision_base_url', '') || '').replace(/\/$/, ''),
    apiKey: getSetting('vision_api_key', ''),
    model: getSetting('vision_model', ''),
  }
}

function getLlmConfig() {
  let enabled = getSetting('llm_enabled') === '1'
  let baseUrl = (getSetting('llm_base_url', '') || '').replace(/\/$/, '')
  let apiKey = getSetting('llm_api_key', '')
  let model = getSetting('llm_model', '')

  // 未单独配置文本大模型时，回退使用视觉通道（同一 SiliconFlow/OpenAI 兼容端点）
  if (!baseUrl || !apiKey) {
    const v = getVisionConfig()
    if (v.baseUrl && v.apiKey) {
      baseUrl = baseUrl || v.baseUrl
      apiKey = apiKey || v.apiKey
      if (!model) model = v.model
      if (v.enabled) enabled = true
    }
  }

  return {
    enabled: !!(enabled && baseUrl && apiKey),
    baseUrl,
    apiKey,
    model,
  }
}

function compressForVision(imagePath) {
  try {
    const tmp = imagePath + '.vision.jpg'
    execFileSync(pythonExe(), [
      path.join(__dirname, '../compress_vision.py'), imagePath, tmp,
    ], { timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    if (fs.existsSync(tmp) && fs.statSync(tmp).size > 1000) return tmp
  } catch (e) {
    console.error('compress fail', e.message)
  }
  return imagePath
}

async function chatComplete({ baseUrl, apiKey, model, messages, maxTokens = 2500 }) {
  const r = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.05,
    }),
    signal: AbortSignal.timeout(80000),
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    const err = new Error(`LLM HTTP ${r.status} ${t.slice(0, 120)}`)
    err.status = r.status
    throw err
  }
  const j = await r.json()
  return j.choices?.[0]?.message?.content || ''
}

/** 流式对话：onDelta(chunk) 逐段回调，返回完整文本 */
async function chatStream({ baseUrl, apiKey, model, messages, maxTokens = 2000, onDelta }) {
  const r = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
      stream: true,
    }),
    signal: AbortSignal.timeout(90000),
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`LLM HTTP ${r.status} ${t.slice(0, 120)}`)
  }
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let full = ''
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const s = line.trim()
      if (!s.startsWith('data:')) continue
      const payload = s.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const j = JSON.parse(payload)
        const delta = j.choices?.[0]?.delta?.content || ''
        if (delta) {
          full += delta
          if (onDelta) onDelta(delta)
        }
      } catch {}
    }
  }
  return full
}

const SYS = `你是率土之滨截图识别助手。只输出 JSON，不要 markdown。
自动判断类型：
1. journey：kills_day,kills_week,land_day,land_week,demolish_day,demolish_week,war_merit_day,war_merit_week,war_merit_max_week,city_kill_day,city_kill_week,nickname,server
   61.1万→611000；页脚 Sxxxx-云衍|玄清 → server,nickname
2. battle：result(胜/败/平),war_merit,our_player,our_alliance,enemy_player,enemy_alliance,generals[{side,name,level,troops,red_stars,skills,treasures}]
3. lineup：side(我方/敌方),generals[{slot,name,level,red_stars,skills,treasures,gems}]
4. general_stats：rows[{slot,name,level,normal_kill,skill_kill,skill_cast,rescue,loss,wounded,total_wounded}]
5. skill_stats：rows[{name,level,normal_times,normal_kill,skills[{name,times,kill}]}]
识别不到给0或空串。武将名用标准名（甘宁/司马炎/孙权/关羽/马岱等）。`

async function visionAnalyze(imagePath, hint = 'auto') {
  const cfg = getVisionConfig()
  if (!cfg.enabled || !cfg.baseUrl || !cfg.apiKey) {
    return { ok: false, error: 'vision_api_disabled', data: null }
  }

  const usePath = compressForVision(imagePath)
  const buf = fs.readFileSync(usePath)
  const b64 = buf.toString('base64')
  const mime = usePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'

  const cleanup = () => {
    if (usePath !== imagePath && fs.existsSync(usePath)) {
      try { fs.unlinkSync(usePath) } catch {}
    }
  }

  const messages = [
    { role: 'system', content: SYS },
    {
      role: 'user',
      content: [
        { type: 'text', text: `识别截图 hint=${hint}，严格输出 JSON` },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
      ],
    },
  ]

  // 重试 2 次（503 busy / 超时）
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const content = await chatComplete({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        messages,
      })
      const data = normalizePageType(JSON.parse(extractJson(content)))
      cleanup()
      return { ok: true, data, raw: content }
    } catch (e) {
      const busy = e.status === 503 || /busy|timeout|aborted/i.test(e.message || '')
      if (attempt < 2 && busy) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
        continue
      }
      cleanup()
      return { ok: false, error: e.message, data: null }
    }
  }
  cleanup()
  return { ok: false, error: 'vision_failed', data: null }
}

function extractJson(text) {
  if (!text) return '{}'
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) return fence[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return text.trim()
}

/** 规范化 page_type 字段（兼容不同视觉模型的返回格式） */
function normalizePageType(data) {
  if (!data || typeof data !== 'object') return data
  // 已有 page_type 直接返回
  if (data.page_type) return data
  // 从 type 字段推断
  if (data.type) return { ...data, page_type: data.type }
  // 从数据结构推断类型
  if (data.battle || data.war_merit !== undefined || data.our_player || data.enemy_player)
    return { ...data, page_type: 'battle' }
  if (data.generals && Array.isArray(data.generals) && data.side)
    return { ...data, page_type: 'lineup' }
  if (data.rows && Array.isArray(data.rows) && !data.kills_day)
    return { ...data, page_type: data.rows[0]?.skill_times !== undefined ? 'skill_stats' : 'general_stats' }
  if (data.kills_day !== undefined || data.war_merit_week !== undefined || data.war_merit_max_week !== undefined)
    return { ...data, page_type: 'journey' }
  return data
}

module.exports = { visionAnalyze, getVisionConfig, getLlmConfig, chatComplete, chatStream }
