const express = require('express')
const { db, logOp, getSetting } = require('../db')
const { authRequired, requireLevel } = require('../middleware/auth')
const { applyMerit } = require('../services/merit')
const { validId, validPositive, validName, cleanName, validate } = require('../services/validate')
const { allianceFilter, allianceFilterViaMember, getAllianceIdForInsert } = require('../middleware/alliance')

const router = express.Router()
router.use(authRequired)

function orderNo() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const rnd = Math.floor(Math.random() * 9000) + 1000
  return `EX${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${rnd}`
}

router.get('/goods', (req, res) => {
  const onlySale = req.query.all !== '1'
  const af = allianceFilter(req, 'goods')
  let sql = 'SELECT * FROM goods WHERE 1=1' + af.sql
  if (onlySale) sql += ' AND on_sale = 1'
  sql += ' ORDER BY sort_order DESC, id DESC'
  const rows = db.prepare(sql).all(...af.params)
  // member remaining limit
  if (req.user.member_id) {
    const memberId = req.user.member_id
    for (const g of rows) {
      if (g.per_user_limit <= 0) {
        g.remain_limit = 999
      } else {
        const used = db.prepare(`
          SELECT COUNT(*) as c FROM orders
          WHERE member_id = ? AND goods_id = ? AND status != '审核驳回' AND status != '已取消'
        `).get(memberId, g.id).c
        g.remain_limit = Math.max(0, g.per_user_limit - used)
      }
    }
  }
  res.json(rows)
})

router.post('/goods', requireLevel(3), (req, res) => {
  const b = req.body || {}
  const err = validName(b.name, '商品名称', 50)
  if (err) return res.status(400).json({ error: err })
  const clean = cleanName(b.name, 50)
  const allianceId = getAllianceIdForInsert(req)
  const info = db.prepare(`
    INSERT INTO goods (name, type, description, image_url, merit_cost, stock, per_user_limit, need_audit, on_sale, sort_order, start_time, end_time, alliance_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    clean, b.type || '虚拟', b.description || '', b.image_url || '',
    Number(b.merit_cost) || 0, Number(b.stock) || 0, Number(b.per_user_limit) || 1,
    b.need_audit === undefined ? 1 : (b.need_audit ? 1 : 0),
    b.on_sale === undefined ? 1 : (b.on_sale ? 1 : 0),
    Number(b.sort_order) || 0, b.start_time || null, b.end_time || null,
    allianceId
  )
  logOp(req.user.id, '新增商品', b.name)
  res.json({ id: info.lastInsertRowid })
})

router.put('/goods/:id', requireLevel(3), (req, res) => {
  const af = allianceFilter(req, 'goods')
  const g = db.prepare('SELECT * FROM goods WHERE id = ?' + af.sql).get(req.params.id, ...af.params)
  if (!g) return res.status(404).json({ error: '商品不存在' })
  const b = req.body || {}
  db.prepare(`
    UPDATE goods SET name=?, type=?, description=?, image_url=?, merit_cost=?, stock=?,
      per_user_limit=?, need_audit=?, on_sale=?, sort_order=?, start_time=?, end_time=?,
      updated_at=datetime('now','localtime')
    WHERE id=?
  `).run(
    b.name ?? g.name, b.type ?? g.type, b.description ?? g.description, b.image_url ?? g.image_url,
    b.merit_cost ?? g.merit_cost, b.stock ?? g.stock, b.per_user_limit ?? g.per_user_limit,
    b.need_audit !== undefined ? (b.need_audit ? 1 : 0) : g.need_audit,
    b.on_sale !== undefined ? (b.on_sale ? 1 : 0) : g.on_sale,
    b.sort_order ?? g.sort_order, b.start_time ?? g.start_time, b.end_time ?? g.end_time,
    g.id
  )
  res.json({ ok: true })
})

router.delete('/goods/:id', requireLevel(3), (req, res) => {
  const af = allianceFilter(req, 'goods')
  db.prepare('UPDATE goods SET on_sale = 0 WHERE id = ?' + af.sql).run(req.params.id, ...af.params)
  res.json({ ok: true })
})

router.post('/orders', (req, res) => {
  const { goods_id, receiver_name = '', receiver_phone = '', receiver_address = '' } = req.body || {}
  if (!req.user.member_id) return res.status(400).json({ error: '请先关联游戏成员' })
  const err = validId(goods_id, '商品ID')
  if (err) return res.status(400).json({ error: err })
  if (getSetting('shop_enabled', '1') !== '1') return res.status(400).json({ error: '军功商场已关闭' })

  const afGoods = allianceFilter(req, 'goods')
  const goods = db.prepare('SELECT * FROM goods WHERE id = ?' + afGoods.sql).get(goods_id, ...afGoods.params)
  if (!goods || !goods.on_sale) return res.status(400).json({ error: '商品已下架' })

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  if (goods.start_time && now < goods.start_time) return res.status(400).json({ error: '未到兑换时间' })
  if (goods.end_time && now > goods.end_time) return res.status(400).json({ error: '兑换已截止' })
  if (goods.stock <= 0) return res.status(400).json({ error: '库存不足' })

  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(req.user.member_id)
  if (!member) return res.status(400).json({ error: '成员不存在' })
  if ((member.available_merit || 0) < goods.merit_cost) {
    return res.status(400).json({ error: '可用军功不足' })
  }

  if (goods.per_user_limit > 0) {
    const used = db.prepare(`
      SELECT COUNT(*) as c FROM orders
      WHERE member_id = ? AND goods_id = ? AND status != '审核驳回' AND status != '已取消'
    `).get(req.user.member_id, goods.id).c
    if (used >= goods.per_user_limit) return res.status(400).json({ error: '已达限购次数' })
  }

  if (goods.type === '实物') {
    if (!receiver_name || !receiver_phone || !receiver_address) {
      return res.status(400).json({ error: '请填写完整收货信息' })
    }
  }

  // audit settings
  let needAudit = goods.need_audit === 1
  if (goods.type === '虚拟' && getSetting('shop_audit_virtual', '0') === '0') needAudit = false
  if (goods.type === '实物' && getSetting('shop_audit_physical', '1') === '1') needAudit = true

  const monthlyLimit = Number(getSetting('shop_monthly_limit', '0')) || 0
  if (monthlyLimit > 0) {
    const spent = db.prepare(`
      SELECT COALESCE(SUM(merit_cost),0) as s FROM orders
      WHERE member_id = ? AND status != '审核驳回' AND status != '已取消'
        AND created_at >= datetime('now','localtime','start of month')
    `).get(req.user.member_id).s
    if (spent + goods.merit_cost > monthlyLimit) {
      return res.status(400).json({ error: '超出本月兑换上限' })
    }
  }

  const tx = db.transaction(() => {
    // 原子扣库存
    const st = db.prepare('UPDATE goods SET stock = stock - 1 WHERE id = ? AND stock > 0 AND on_sale = 1').run(goods.id)
    if (st.changes === 0) throw new Error('库存不足或已下架')

    // 原子扣军功（余额不足会抛错）
    const meritRes = applyMerit(req.user.member_id, -goods.merit_cost, '扣减', '商城兑换', `兑换${goods.name}`, req.user.id)

    const info = db.prepare(`
      INSERT INTO orders (order_no, member_id, goods_id, goods_name, goods_type, merit_cost,
        receiver_name, receiver_phone, receiver_address, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderNo(), req.user.member_id, goods.id, goods.name, goods.type, goods.merit_cost,
      goods.type === '实物' ? receiver_name : '',
      goods.type === '实物' ? receiver_phone : '',
      goods.type === '实物' ? receiver_address : '',
      needAudit ? '待审核' : '待发放'
    )
    // 回填 related_id
    db.prepare('UPDATE merit_logs SET related_id = ? WHERE id = ?').run(info.lastInsertRowid, meritRes.logId)
    return info.lastInsertRowid
  })

  try {
    const id = tx()
    logOp(req.user.id, '提交兑换', goods.name)
    res.json({ id, message: needAudit ? '已提交，等待审核' : '兑换成功，待发放' })
  } catch (e) {
    res.status(400).json({ error: '兑换失败：' + e.message })
  }
})

router.get('/orders', (req, res) => {
  const { status = '', member_id = '' } = req.query
  const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20))
  const af = allianceFilter(req, 'm')
  let sql = `
    FROM orders o
    JOIN members m ON m.id = o.member_id
    LEFT JOIN groups g ON g.id = m.group_id
    WHERE 1=1
  `
  const params = []
  if (req.user.role === '成员') {
    sql += ' AND o.member_id = ?'
    params.push(req.user.member_id || 0)
  } else if (req.user.role === '团长') {
    sql += ' AND (m.group_id = ? OR o.member_id = ?)'
    params.push(req.user.group_id || 0, req.user.member_id || 0)
  }
  if (af.sql) {
    sql += af.sql
    params.push(...af.params)
  }
  if (status) {
    sql += ' AND o.status = ?'
    params.push(status)
  }
  if (member_id && req.user.role !== '成员') {
    sql += ' AND o.member_id = ?'
    params.push(member_id)
  }
  let selectSql = `SELECT o.*, m.nickname, m.game_id, g.name as group_name ${sql}`
  selectSql += ' ORDER BY o.created_at DESC, o.id DESC'

  // hide shipping info from non-admin except own orders
  const maskRows = (rows) => rows.map((r) => {
    const isOwn = r.member_id === req.user.member_id
    const isAdmin = ['root', '盟主', '副盟'].includes(req.user.role)
    if (isOwn || isAdmin) return r
    return {
      ...r,
      receiver_name: r.receiver_name ? r.receiver_name[0] + '**' : '',
      receiver_phone: r.receiver_phone ? r.receiver_phone.slice(0, 3) + '****' + r.receiver_phone.slice(-2) : '',
      receiver_address: r.receiver_address ? r.receiver_address.slice(0, 6) + '***' : '',
    }
  })

  if (!hasPagination) {
    const rows = db.prepare(selectSql).all(...params)
    return res.json(maskRows(rows))
  }
  const total = db.prepare(`SELECT COUNT(*) as total ${sql}`).get(...params).total
  let rows = db.prepare(`${selectSql} LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize)
  rows = maskRows(rows)
  const totalPages = Math.ceil(total / pageSize)
  res.json({ data: rows, total, page, pageSize, totalPages })
})

router.post('/orders/:id/review', requireLevel(3), (req, res) => {
  const { action, reject_reason = '', deliver_note = '' } = req.body || {}
  const af = allianceFilterViaMember(req, 'o')
  const o = db.prepare(`SELECT o.* FROM orders o ${af.join} WHERE o.id = ? ${af.where}`).get(req.params.id, ...af.params)
  if (!o) return res.status(404).json({ error: '订单不存在' })
  if (action === 'reject') {
    if (o.status !== '待审核') return res.status(400).json({ error: '仅待审核订单可驳回' })
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE orders SET status='审核驳回', reviewer_id=?, reject_reason=?, reviewed_at=datetime('now','localtime')
        WHERE id=?
      `).run(req.user.id, reject_reason, o.id)
      db.prepare('UPDATE goods SET stock = stock + 1 WHERE id = ?').run(o.goods_id)
      applyMerit(o.member_id, o.merit_cost, '收入', '商城退还', `兑换驳回退还-${o.goods_name}`, req.user.id, o.id)
      logOp(req.user.id, '审核驳回订单', o.order_no)
    })
    tx()
    return res.json({ ok: true })
  }
  if (action === 'approve') {
    if (o.status !== '待审核') return res.status(400).json({ error: '状态不允许' })
    db.prepare(`
      UPDATE orders SET status='待发放', reviewer_id=?, reviewed_at=datetime('now','localtime')
      WHERE id=?
    `).run(req.user.id, o.id)
    logOp(req.user.id, '审核通过订单', o.order_no)
    return res.json({ ok: true })
  }
  if (action === 'deliver') {
    if (!['待发放', '审核通过'].includes(o.status)) return res.status(400).json({ error: '状态不允许发放' })
    db.prepare(`
      UPDATE orders SET status='已发放', deliver_note=?, delivered_at=datetime('now','localtime')
      WHERE id=?
    `).run(deliver_note, o.id)
    logOp(req.user.id, '发放奖励', o.order_no)
    return res.json({ ok: true })
  }
  res.status(400).json({ error: '未知操作' })
})

router.get('/orders/summary', requireLevel(2), (req, res) => {
  const af = allianceFilterViaMember(req, 'o')
  const pending = db.prepare(`SELECT COUNT(*) as c FROM orders o ${af.join} WHERE o.status='待审核' ${af.where}`).get(...af.params).c
  const delivered = db.prepare(`SELECT COUNT(*) as c FROM orders o ${af.join} WHERE o.status='已发放' ${af.where}`).get(...af.params).c
  const spent = db.prepare(`SELECT COALESCE(SUM(o.merit_cost),0) as s FROM orders o ${af.join} WHERE o.status != '审核驳回' AND o.status != '已取消' ${af.where}`).get(...af.params).s
  const topGoods = db.prepare(`
    SELECT o.goods_name, COUNT(*) as c, SUM(o.merit_cost) as merit
    FROM orders o ${af.join} WHERE o.status != '审核驳回' ${af.where}
    GROUP BY o.goods_id ORDER BY c DESC LIMIT 5
  `).all(...af.params)
  res.json({ pending, delivered, spent, topGoods })
})

module.exports = router
