#!/usr/bin/env node
/** 清空业务测试数据（保留表结构与系统设置/API配置） */
const path = require('path')
const { createRequire } = require('module')
const fs = require('fs')

function resolveDataDir() {
  if (process.env.MERIT_DATA_DIR) return process.env.MERIT_DATA_DIR
  if (process.pkg || process.env.MERIT_PORTABLE === '1') {
    return path.join(path.dirname(process.execPath), 'data')
  }
  return path.join(__dirname, 'data')
}

function loadSqliteDriver() {
  if (process.env.MERIT_PORTABLE === '1' || process.pkg) {
    const root = path.dirname(process.execPath)
    const req = createRequire(path.join(root, 'index.js'))
    try { return req('better-sqlite3') } catch {}
  }
  return require('better-sqlite3')
}

const DATA_DIR = resolveDataDir()
const dbPath = path.join(DATA_DIR, 'merit.db')

if (!fs.existsSync(dbPath)) {
  console.log('数据库不存在，无需清理:', dbPath)
  process.exit(0)
}

const Database = loadSqliteDriver()
const db = new Database(dbPath)
db.pragma('foreign_keys = OFF')

const tables = [
  'op_logs',
  'ai_analyses',
  'ai_history',
  'merit_logs',
  'war_merit_records',
  'journey_records',
  'city_attendance',
  'city_signups',
  'city_plans',
  'orders',
  'goods',
  'applications',
  'invites',
  'battle_reports',
  'battles',
  'enemies',
  'enemy_generals',
  'awards',
  'award_distributions',
  'announcements',
  'season_events',
  'season_archives',
  'fortresses',
  'pioneer_records',
  'alliance_tech',
  'battle_report_lib',
  'battle_lineup_generals',
  'battle_lineups',
  'battle_stat_rows',
  'battle_stat_reports',
  'users',
  'members',
  'groups',
  'seasons',
]

const existing = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
  .all()
  .map((r) => r.name)

let n = 0
for (const t of tables) {
  if (!existing.includes(t)) continue
  try {
    db.prepare(`DELETE FROM ${t}`).run()
    n++
  } catch (e) {
    console.warn('跳过', t, e.message)
  }
}

// 重置自增
for (const t of existing) {
  try {
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(t)
  } catch {}
}

// 保留的设置里去掉演示痕迹可选：默认保留 API/规则配置
console.log(`已清空 ${n} 张业务表。API 密钥与军功规则等系统设置已保留。`)
console.log('重启服务后会重新初始化基础分组/商品/赛季，并打印随机 admin 密码。')
db.close()
