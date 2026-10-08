const express = require('express')
const {
  getMachineId,
  getStatus,
  activate,
  deactivate,
  generateLicense,
} = require('../services/license')
const { authRequired, requireLevel } = require('../middleware/auth')

const router = express.Router()

/** 公开：本机授权状态 + 机器码 */
router.get('/status', (req, res) => {
  res.json(getStatus())
})

/** 公开：激活 */
router.post('/activate', (req, res) => {
  const key = String(req.body?.key || '')
  if (!key) return res.status(400).json({ error: '请输入授权码' })
  const r = activate(key)
  if (!r.ok) return res.status(400).json({ error: r.error, machineId: r.machineId })
  res.json({ ok: true, message: '激活成功', ...r })
})

/** 本机机器码（登录前也可读，便于找厂商换码） */
router.get('/machine-id', (req, res) => {
  res.json({ machineId: getMachineId() })
})

/** 盟主：在本机为指定机器码生成授权（自用/内测） */
router.post('/issue', authRequired, requireLevel(4), (req, res) => {
  const { machine_id, expires = '', customer = '', edition = 'full' } = req.body || {}
  if (!machine_id || String(machine_id).replace(/-/g, '').length < 16) {
    return res.status(400).json({ error: '请填写完整机器码' })
  }
  const key = generateLicense({
    machineId: String(machine_id),
    expires: expires || 0,
    customer: customer || '',
    edition,
  })
  res.json({ ok: true, key, machineId: String(machine_id).toUpperCase(), expires: expires || '永久' })
})

/** 盟主：解除本机激活 */
router.post('/deactivate', authRequired, requireLevel(4), (req, res) => {
  deactivate()
  res.json({ ok: true, message: '已解除本机激活' })
})

module.exports = router
