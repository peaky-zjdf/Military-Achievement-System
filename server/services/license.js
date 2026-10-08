const crypto = require('crypto')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

/** 与 tools/gen-license.js 保持一致，勿外泄到前端 */
const LICENSE_SECRET = 'STB-MERIT-2026-SECRET-8f3a9c2e'
const PRODUCT = 'shitabing-merit'
const VERSION = 1

function appRoot() {
  if (process.pkg || process.env.MERIT_PORTABLE === '1') {
    return path.dirname(process.execPath)
  }
  return path.join(__dirname, '..', '..')
}

function licenseFile() {
  return path.join(appRoot(), 'data', 'license.json')
}

function collectMac() {
  const nets = os.networkInterfaces()
  const macs = []
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (!n.mac || n.mac === '00:00:00:00:00:00') continue
      if (n.internal) continue
      macs.push(n.mac.toLowerCase())
    }
  }
  return macs.sort()
}

function windowsVolumeSerial() {
  if (process.platform !== 'win32') return ''
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq \'C:\' } | Select-Object -ExpandProperty VolumeSerialNumber"',
      { encoding: 'utf8', timeout: 8000, windowsHide: true }
    )
    const m = /([0-9A-Fa-f]{4,})/.exec(String(out).trim())
    return m ? m[1].toUpperCase() : ''
  } catch {
    return ''
  }
}

/** 本机指纹（用于绑码） */
function getMachineId() {
  const macs = collectMac()
  const raw = [
    PRODUCT,
    os.hostname(),
    macs[0] || 'nomac',
    windowsVolumeSerial() || 'novol',
    process.platform,
  ].join('|')
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32).toUpperCase()
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url')
}

function hmac(payload) {
  return crypto.createHmac('sha256', LICENSE_SECRET).update(payload).digest('base64url').slice(0, 22)
}

/**
 * 生成授权码（厂商侧）
 * @param {object} opts
 * @param {string} opts.machineId 目标机器ID（可选，空则不绑机）
 * @param {string|number} opts.expires 到期日 YYYY-MM-DD，0/空=永久
 * @param {string} opts.customer 客户备注
 */
function generateLicense({ machineId = '', expires = 0, customer = '', edition = 'full' } = {}) {
  const payloadObj = {
    v: VERSION,
    p: PRODUCT,
    mid: machineId ? String(machineId).replace(/-/g, '').toUpperCase().slice(0, 32) : '',
    exp: expires ? String(expires).slice(0, 10) : '',
    c: String(customer || '').slice(0, 40),
    e: edition,
    n: crypto.randomBytes(4).toString('hex').toUpperCase(),
  }
  const payload = b64url(JSON.stringify(payloadObj))
  const sig = hmac(payload)
  return `STB1.${payload}.${sig}`
}

function parseLicense(key) {
  const s = String(key || '').trim()
  const parts = s.split('.')
  if (parts.length !== 3 || parts[0] !== 'STB1') {
    return { ok: false, error: '授权码格式不正确' }
  }
  const [, payload, sig] = parts
  if (hmac(payload) !== sig) {
    return { ok: false, error: '授权码校验失败（可能被篡改）' }
  }
  let obj
  try {
    obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, error: '授权码内容无效' }
  }
  if (obj.p !== PRODUCT) return { ok: false, error: '授权码产品不匹配' }
  return { ok: true, data: obj }
}

function isExpired(exp) {
  if (!exp) return false
  const end = new Date(exp + 'T23:59:59')
  if (Number.isNaN(end.getTime())) return true
  return Date.now() > end.getTime()
}

function evaluateLicense(key, machineId) {
  const parsed = parseLicense(key)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const d = parsed.data
  if (d.mid && d.mid !== machineId) {
    return { ok: false, error: '授权码与本机不匹配，请使用本机机器码生成', machineId }
  }
  if (isExpired(d.exp)) {
    return { ok: false, error: `授权已于 ${d.exp} 过期` }
  }
  return {
    ok: true,
    license: {
      customer: d.c || '',
      edition: d.e || 'full',
      expires: d.exp || '',
      permanent: !d.exp,
      bound: !!d.mid,
      serial: d.n || '',
    },
  }
}

/** 开发模式（源码运行）默认放行；打包 EXE 必须激活 */
function isDevBypass() {
  if (process.env.LICENSE_STRICT === '1') return false
  if (process.env.LICENSE_OFF === '1') return true
  if (process.pkg || process.env.MERIT_PORTABLE === '1') return false
  return true
}

function readStored() {
  try {
    return JSON.parse(fs.readFileSync(licenseFile(), 'utf8'))
  } catch {
    return null
  }
}

function writeStored(data) {
  const f = licenseFile()
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8')
}

function getStatus() {
  const machineId = getMachineId()
  if (isDevBypass()) {
    return {
      ok: true,
      mode: 'dev',
      machineId,
      message: '开发模式（源码运行）免授权。打包 EXE 后需激活。',
    }
  }
  const stored = readStored()
  if (!stored?.key) {
    return { ok: false, mode: 'prod', machineId, error: '未激活', reason: 'unactivated' }
  }
  const r = evaluateLicense(stored.key, machineId)
  if (!r.ok) {
    return { ok: false, mode: 'prod', machineId, error: r.error, reason: 'invalid' }
  }
  return {
    ok: true,
    mode: 'prod',
    machineId,
    activated_at: stored.activated_at || '',
    ...r.license,
  }
}

function activate(key) {
  const machineId = getMachineId()
  const r = evaluateLicense(key, machineId)
  if (!r.ok) return r
  writeStored({
    key: String(key).trim(),
    machine_id: machineId,
    activated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    ...r.license,
  })
  return { ok: true, machineId, ...r.license }
}

function deactivate() {
  try {
    fs.unlinkSync(licenseFile())
    return { ok: true }
  } catch {
    return { ok: true }
  }
}

function ensureLicensed() {
  return getStatus()
}

module.exports = {
  getMachineId,
  generateLicense,
  parseLicense,
  evaluateLicense,
  getStatus,
  activate,
  deactivate,
  ensureLicensed,
  isDevBypass,
  LICENSE_SECRET,
  PRODUCT,
}
