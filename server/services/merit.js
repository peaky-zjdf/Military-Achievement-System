const { db, getSetting } = require('../db')

function getRules() {
  return {
    war_merit_per_merit: num(getSetting('war_merit_per_merit', '0.1'), 0.1),
    demolition_per_point: num(getSetting('demolition_per_point', '2'), 2),
    attendance_merit: num(getSetting('attendance_merit', '20'), 20),
    absent_penalty: num(getSetting('absent_penalty', '50'), 50),
    land_flip_merit: num(getSetting('land_flip_merit', '80'), 80),
    guard_minute_merit: num(getSetting('guard_minute_merit', '0.5'), 0.5),
    scout_merit: num(getSetting('scout_merit', '5'), 5),
    journey_war_per_point: num(getSetting('journey_war_per_point', '0.1'), 0.1),
    journey_demolish_per_point: num(getSetting('journey_demolish_per_point', '2'), 2),
    journey_kill_per_point: num(getSetting('journey_kill_per_point', '0.02'), 0.02),
    journey_land_per_point: num(getSetting('journey_land_per_point', '80'), 80),
    journey_city_kill_per_point: num(getSetting('journey_city_kill_per_point', '0.05'), 0.05),
    journey_source: getSetting('journey_source', '上周'),
  }
}

function num(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function calcWarMerit(warAmount, type = '野战') {
  const r = getRules()
  return Math.round(Number(warAmount) * r.war_merit_per_merit)
}

function calcCityMerit({ attended = 0, demolition = 0 }) {
  const r = getRules()
  if (!attended) return -Math.abs(r.absent_penalty)
  return Math.round(r.attendance_merit + Number(demolition || 0) * r.demolition_per_point)
}

function calcJourneyMerit(stats, source) {
  const r = getRules()
  const src = source || r.journey_source || '上周'
  const pick = (weekKey, dayKey) => (src === '单日最高' ? Number(stats[dayKey] || 0) : Number(stats[weekKey] || 0))

  const war = pick('war_merit_week', 'war_merit_day')
  const demolish = pick('demolish_week', 'demolish_day')
  const kills = pick('kills_week', 'kills_day')
  const land = pick('land_week', 'land_day')
  const city = pick('city_kill_week', 'city_kill_day')

  const parts = {
    war_merit: Math.round(war * r.journey_war_per_point),
    demolition: Math.round(demolish * r.journey_demolish_per_point),
    kills: Math.round(kills * r.journey_kill_per_point),
    land: Math.round(land * r.journey_land_per_point),
    city_kills: Math.round(city * r.journey_city_kill_per_point),
  }
  const total = parts.war_merit + parts.demolition + parts.kills + parts.land + parts.city_kills
  return { total, parts, source: src, raw: { war, demolish, kills, land, city } }
}

/**
 * 原子增减军功。可用余额不允许为负（扣减时不足则拒绝）。
 * @returns {{logId:number, available:number, total:number, applied:number}}
 */
function applyMerit(memberId, delta, type, category, reason, operatorId = null, relatedId = null) {
  const amount = Math.round(Number(delta) || 0)
  if (!amount) throw new Error('变动分值无效')
  const member = db.prepare('SELECT id, available_merit, total_merit FROM members WHERE id = ?').get(memberId)
  if (!member) throw new Error('成员不存在')

  if (amount < 0 && (member.available_merit || 0) + amount < 0) {
    throw new Error('可用军功不足')
  }

  const nextTotal = amount >= 0 ? (member.total_merit || 0) + amount : (member.total_merit || 0)
  const upd = db.prepare(`
    UPDATE members
    SET available_merit = available_merit + ?,
        total_merit = ?,
        updated_at = datetime('now','localtime')
    WHERE id = ? AND (available_merit + ?) >= 0
  `).run(amount, nextTotal, memberId, amount)

  if (upd.changes === 0) throw new Error('可用军功不足')

  const after = db.prepare('SELECT available_merit, total_merit FROM members WHERE id = ?').get(memberId)
  const info = db.prepare(`
    INSERT INTO merit_logs (member_id, type, amount, balance_after, total_after, reason, category, related_id, operator_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(memberId, amount >= 0 ? '收入' : '扣减', amount, after.available_merit, after.total_merit, reason || '', category || '', relatedId, operatorId)

  return {
    logId: info.lastInsertRowid,
    available: after.available_merit,
    total: after.total_merit,
    applied: amount,
  }
}

/** 可能为 0：跳过并返回 applied=0（用于差额修正） */
function applyMeritIfNonZero(memberId, delta, type, category, reason, operatorId = null, relatedId = null) {
  const amount = Math.round(Number(delta) || 0)
  if (!amount) return { logId: null, applied: 0, available: null, total: null }
  return applyMerit(memberId, amount, type, category, reason, operatorId, relatedId)
}

function weekStart(date = new Date()) {
  const d = new Date(date)
  const day = d.getDay() || 7
  d.setDate(d.getDate() - day + 1)
  d.setHours(0, 0, 0, 0)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function dateFilterExpr(alias = 'created_at', period = 'season') {
  if (period === 'week') return `${alias} >= datetime('now','localtime','-6 days')`
  if (period === 'month') return `${alias} >= datetime('now','localtime','-29 days')`
  return '1=1'
}

module.exports = {
  getRules,
  calcWarMerit,
  calcCityMerit,
  calcJourneyMerit,
  applyMerit,
  applyMeritIfNonZero,
  weekStart,
  dateFilterExpr,
}
