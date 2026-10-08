const path = require('path')
const fs = require('fs')
const { createRequire } = require('module')

// 打包 EXE 后数据目录与可执行文件同级；源码运行在 server/data
function resolveDataDir() {
  if (process.env.MERIT_DATA_DIR) return process.env.MERIT_DATA_DIR
  if (process.pkg || process.env.MERIT_PORTABLE === '1') {
    return path.join(path.dirname(process.execPath), 'data')
  }
  return path.join(__dirname, 'data')
}

function loadSqliteDriver() {
  // SEA/便携版：从 exe 旁 node_modules 加载 better-sqlite3
  if (process.env.MERIT_PORTABLE === '1' || process.pkg) {
    const root = path.dirname(process.execPath)
    const req = createRequire(path.join(root, 'index.js'))
    try {
      return req('better-sqlite3')
    } catch {
      const native = path.join(root, 'better_sqlite3.node')
      if (fs.existsSync(native)) {
        // 仅原生文件时无法驱动 JS 包装层，需完整包
        throw new Error('未找到 better-sqlite3 运行库，请将 node_modules/better-sqlite3 与 exe 放在同一目录')
      }
      throw new Error('缺少 better-sqlite3，请检查发布目录完整性')
    }
  }
  return require('better-sqlite3')
}

function loadDatabase(dbPath) {
  const Database = loadSqliteDriver()
  try {
    return new Database(dbPath)
  } catch (e) {
    if (process.pkg || process.env.MERIT_PORTABLE === '1') {
      const p = path.join(path.dirname(process.execPath), 'better_sqlite3.node')
      if (fs.existsSync(p)) {
        return new Database(dbPath, { nativeBinding: p })
      }
    }
    throw e
  }
}

const DATA_DIR = resolveDataDir()
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

const db = loadDatabase(path.join(DATA_DIR, 'merit.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

function initSchema() {
  db.exec(`
    -- 同盟（盟主各自管理一个同盟）
    CREATE TABLE IF NOT EXISTS alliances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      owner_user_id INTEGER,
      status TEXT DEFAULT '正常',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 同盟独立设置（API、邮箱等按同盟隔离）
    CREATE TABLE IF NOT EXISTS alliance_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alliance_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      UNIQUE(alliance_id, key)
    );

    -- 盟主邀请码
    CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      alliance_name TEXT DEFAULT '',
      created_by INTEGER,
      used_by INTEGER,
      max_uses INTEGER DEFAULT 1,
      use_count INTEGER DEFAULT 0,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      leader_id INTEGER,
      alliance_id INTEGER REFERENCES alliances(id),
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL UNIQUE,
      nickname TEXT NOT NULL,
      group_id INTEGER REFERENCES groups(id),
      alliance_id INTEGER REFERENCES alliances(id),
      role TEXT NOT NULL DEFAULT '成员',
      status TEXT NOT NULL DEFAULT '活跃',
      power INTEGER DEFAULT 0,
      total_merit INTEGER DEFAULT 0,
      available_merit INTEGER DEFAULT 0,
      qq TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      note TEXT DEFAULT '',
      left_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      member_id INTEGER REFERENCES members(id),
      role TEXT NOT NULL DEFAULT '成员',
      alliance_id INTEGER REFERENCES alliances(id),
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      contact TEXT DEFAULT '',
      season_info TEXT DEFAULT '',
      obey_manage INTEGER DEFAULT 1,
      status TEXT DEFAULT '待审核',
      reviewer_id INTEGER,
      reject_reason TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      reviewed_at TEXT,
      alliance_id INTEGER REFERENCES alliances(id),
      email TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER REFERENCES members(id),
      inviter_id INTEGER REFERENCES members(id),
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS city_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      coord_x INTEGER DEFAULT 0,
      coord_y INTEGER DEFAULT 0,
      planned_time TEXT NOT NULL,
      target_group_id INTEGER,
      demolition_target INTEGER DEFAULT 0,
      guard_target INTEGER DEFAULT 0,
      note TEXT DEFAULT '',
      status TEXT DEFAULT '计划中',
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS city_signups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city_id INTEGER NOT NULL REFERENCES city_plans(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id),
      type TEXT NOT NULL,
      status TEXT DEFAULT '已报名',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(city_id, member_id, type)
    );

    CREATE TABLE IF NOT EXISTS city_attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city_id INTEGER NOT NULL REFERENCES city_plans(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id),
      attended INTEGER DEFAULT 0,
      demolition INTEGER DEFAULT 0,
      merit INTEGER DEFAULT 0,
      note TEXT DEFAULT '',
      recorded_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(city_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS war_merit_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL REFERENCES members(id),
      amount INTEGER NOT NULL,
      type TEXT DEFAULT '野战',
      source TEXT DEFAULT '手动录入',
      note TEXT DEFAULT '',
      recorded_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS power_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL REFERENCES members(id),
      power INTEGER NOT NULL,
      delta INTEGER DEFAULT 0,
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS merit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL REFERENCES members(id),
      type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER DEFAULT 0,
      total_after INTEGER DEFAULT 0,
      reason TEXT DEFAULT '',
      category TEXT DEFAULT '',
      related_id INTEGER,
      operator_id INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS battles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      coord_x INTEGER DEFAULT 0,
      coord_y INTEGER DEFAULT 0,
      start_time TEXT,
      end_time TEXT,
      vs_party TEXT DEFAULT '',
      groups_text TEXT DEFAULT '',
      status TEXT DEFAULT '进行中',
      note TEXT DEFAULT '',
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS battle_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      battle_id INTEGER NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id),
      war_merit INTEGER DEFAULT 0,
      demolition INTEGER DEFAULT 0,
      guard_minutes INTEGER DEFAULT 0,
      land_flips INTEGER DEFAULT 0,
      report_text TEXT DEFAULT '',
      merit_awarded INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS goods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT DEFAULT '虚拟',
      description TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      merit_cost INTEGER NOT NULL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      per_user_limit INTEGER DEFAULT 1,
      need_audit INTEGER DEFAULT 1,
      on_sale INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      start_time TEXT,
      end_time TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT NOT NULL UNIQUE,
      member_id INTEGER NOT NULL REFERENCES members(id),
      goods_id INTEGER NOT NULL REFERENCES goods(id),
      goods_name TEXT NOT NULL,
      goods_type TEXT DEFAULT '虚拟',
      merit_cost INTEGER NOT NULL,
      receiver_name TEXT DEFAULT '',
      receiver_phone TEXT DEFAULT '',
      receiver_address TEXT DEFAULT '',
      status TEXT DEFAULT '待审核',
      reviewer_id INTEGER,
      reject_reason TEXT DEFAULT '',
      deliver_note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      reviewed_at TEXT,
      delivered_at TEXT
    );

    CREATE TABLE IF NOT EXISTS awards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      type TEXT DEFAULT '征服名额',
      quota INTEGER DEFAULT 1,
      status TEXT DEFAULT '草稿',
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS award_distributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      award_id INTEGER NOT NULL REFERENCES awards(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id),
      rank_no INTEGER DEFAULT 0,
      merit_snapshot INTEGER DEFAULT 0,
      status TEXT DEFAULT '待公示',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT DEFAULT '',
      type TEXT DEFAULT '公告',
      pinned INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS seasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      active INTEGER DEFAULT 1,
      archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS op_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT,
      detail TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 敌对势力玩家
    CREATE TABLE IF NOT EXISTS enemies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT NOT NULL,
      alliance TEXT DEFAULT '',
      server TEXT DEFAULT '',
      threat_level TEXT DEFAULT '中',
      note TEXT DEFAULT '',
      last_seen TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      created_by INTEGER
    );

    -- 敌方武将明细
    CREATE TABLE IF NOT EXISTS enemy_generals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enemy_id INTEGER NOT NULL REFERENCES enemies(id) ON DELETE CASCADE,
      slot TEXT DEFAULT '',
      name TEXT NOT NULL,
      level INTEGER DEFAULT 0,
      troops INTEGER DEFAULT 0,
      red_stars INTEGER DEFAULT 0,
      treasures TEXT DEFAULT '',
      skills TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- 个人征程截图统计（按周提交）
    CREATE TABLE IF NOT EXISTS journey_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL REFERENCES members(id),
      week_key TEXT NOT NULL,
      nickname_ocr TEXT DEFAULT '',
      server_ocr TEXT DEFAULT '',
      kills_day INTEGER DEFAULT 0,
      kills_week INTEGER DEFAULT 0,
      land_day INTEGER DEFAULT 0,
      land_week INTEGER DEFAULT 0,
      demolish_day INTEGER DEFAULT 0,
      demolish_week INTEGER DEFAULT 0,
      war_merit_day INTEGER DEFAULT 0,
      war_merit_week INTEGER DEFAULT 0,
      war_merit_max_week INTEGER DEFAULT 0,
      city_kill_day INTEGER DEFAULT 0,
      city_kill_week INTEGER DEFAULT 0,
      journey_merit INTEGER DEFAULT 0,
      image_path TEXT DEFAULT '',
      ocr_confidence INTEGER DEFAULT 0,
      ocr_text TEXT DEFAULT '',
      status TEXT DEFAULT '已确认',
      recorded_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(member_id, week_key)
    );

    -- 战报附图：部队阵容（我方/敌方）
    CREATE TABLE IF NOT EXISTS battle_lineups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      side TEXT NOT NULL,
      player_name TEXT DEFAULT '',
      alliance TEXT DEFAULT '',
      note TEXT DEFAULT '',
      image_path TEXT DEFAULT '',
      ocr_text TEXT DEFAULT '',
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS battle_lineup_generals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lineup_id INTEGER NOT NULL REFERENCES battle_lineups(id) ON DELETE CASCADE,
      slot TEXT DEFAULT '',
      name TEXT NOT NULL,
      level INTEGER DEFAULT 0,
      camp TEXT DEFAULT '',
      red_stars INTEGER DEFAULT 0,
      treasures TEXT DEFAULT '',
      skills TEXT DEFAULT '',
      gems TEXT DEFAULT '',
      note TEXT DEFAULT ''
    );

    -- 武将统计 / 战法统计
    CREATE TABLE IF NOT EXISTS battle_stat_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT DEFAULT '',
      side TEXT DEFAULT '',
      note TEXT DEFAULT '',
      image_path TEXT DEFAULT '',
      ocr_text TEXT DEFAULT '',
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS battle_stat_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL REFERENCES battle_stat_reports(id) ON DELETE CASCADE,
      slot TEXT DEFAULT '',
      name TEXT NOT NULL,
      level INTEGER DEFAULT 0,
      camp TEXT DEFAULT '',
      -- 武将统计
      normal_kill INTEGER DEFAULT 0,
      skill_kill INTEGER DEFAULT 0,
      skill_cast INTEGER DEFAULT 0,
      rescue INTEGER DEFAULT 0,
      loss INTEGER DEFAULT 0,
      wounded INTEGER DEFAULT 0,
      total_wounded INTEGER DEFAULT 0,
      -- 战法统计
      normal_times INTEGER DEFAULT 0,
      skill_name TEXT DEFAULT '',
      skill_times INTEGER DEFAULT 0,
      skill_kill_amount INTEGER DEFAULT 0,
      extra TEXT DEFAULT ''
    );
  `)
}

function getSetting(key, def = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : def
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value))
}

function logOp(userId, action, detail = '') {
  db.prepare('INSERT INTO op_logs (user_id, action, detail) VALUES (?, ?, ?)').run(userId || null, action, detail)
}

/** 同盟级设置读取 */
function getAllianceSetting(allianceId, key, def = '') {
  if (!allianceId) return def
  const row = db.prepare('SELECT value FROM alliance_settings WHERE alliance_id = ? AND key = ?').get(allianceId, key)
  return row ? row.value : def
}

/** 同盟级设置写入 */
function setAllianceSetting(allianceId, key, value) {
  if (!allianceId) return
  db.prepare(`
    INSERT INTO alliance_settings (alliance_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(alliance_id, key) DO UPDATE SET value = excluded.value
  `).run(allianceId, key, String(value))
}

/** 同盟级设置掩码读取（API Key 脱敏） */
function getMaskedAllianceSetting(allianceId, key) {
  const v = getAllianceSetting(allianceId, key, '')
  if (!v) return ''
  const s = String(v)
  return s.length <= 8 ? '****' : s.slice(0, 3) + '****' + s.slice(-4)
}

initSchema()

// default rules
const defaultRules = {
  system_title: '率土之滨 | 云衍 · 军功系统',
  war_merit_per_merit: '0.1',
  demolition_per_point: '2',
  attendance_merit: '20',
  absent_penalty: '50',
  land_flip_merit: '80',
  guard_minute_merit: '0.5',
  scout_merit: '5',
  // 个人征程字段折算（按「上周」值计周军功）
  journey_war_per_point: '0.1',
  journey_demolish_per_point: '2',
  journey_kill_per_point: '0.02',
  journey_land_per_point: '80',
  journey_city_kill_per_point: '0.05',
  journey_source: '上周',
  shop_enabled: '1',
  shop_audit_virtual: '0',
  shop_audit_physical: '1',
  shop_monthly_limit: '0',
  season_end_clear_available: '0',
  hide_dormant_default: '1',
}
for (const [k, v] of Object.entries(defaultRules)) {
  if (!getSetting(k)) setSetting(k, v)
}

// 从环境变量注入视觉/大模型配置（服务器部署用，仅在库中为空时写入）
function seedApiFromEnv() {
  const map = [
    ['VISION_BASE_URL', 'vision_base_url'],
    ['VISION_API_KEY', 'vision_api_key'],
    ['VISION_MODEL', 'vision_model'],
    ['VISION_ENABLED', 'vision_enabled'],
    ['LLM_BASE_URL', 'llm_base_url'],
    ['LLM_API_KEY', 'llm_api_key'],
    ['LLM_MODEL', 'llm_model'],
    ['LLM_ENABLED', 'llm_enabled'],
  ]
  for (const [envKey, dbKey] of map) {
    const v = process.env[envKey]
    if (v && !getSetting(dbKey)) setSetting(dbKey, v)
  }
  // 若提供了 Key 但未显式 enabled，默认打开
  if (process.env.VISION_API_KEY && process.env.VISION_BASE_URL && !getSetting('vision_enabled')) {
    setSetting('vision_enabled', '1')
  }
  if (process.env.LLM_API_KEY && process.env.LLM_BASE_URL && !getSetting('llm_enabled')) {
    setSetting('llm_enabled', '1')
  }
}
seedApiFromEnv()

// ---- 扩展模块表 ----
db.exec(`
  -- 要塞管理
  CREATE TABLE IF NOT EXISTS fortresses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    coord_x INTEGER DEFAULT 0,
    coord_y INTEGER DEFAULT 0,
    owner_id INTEGER,
    owner_name TEXT DEFAULT '',
    level INTEGER DEFAULT 1,
    troops INTEGER DEFAULT 0,
    status TEXT DEFAULT '建设中',
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  -- 开荒进度
  CREATE TABLE IF NOT EXISTS pioneer_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER NOT NULL,
    record_date TEXT DEFAULT (date('now','localtime')),
    land_level INTEGER DEFAULT 0,
    land_count INTEGER DEFAULT 0,
    power_before INTEGER DEFAULT 0,
    power_after INTEGER DEFAULT 0,
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  -- 赛季日历
  CREATE TABLE IF NOT EXISTS season_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    event_type TEXT DEFAULT '普通',
    event_date TEXT NOT NULL,
    end_date TEXT DEFAULT '',
    description TEXT DEFAULT '',
    is_done INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  -- 同盟科技/建设
  CREATE TABLE IF NOT EXISTS alliance_tech (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tech_name TEXT NOT NULL,
    tech_type TEXT DEFAULT '科技',
    level INTEGER DEFAULT 0,
    max_level INTEGER DEFAULT 10,
    contribution INTEGER DEFAULT 0,
    target_contribution INTEGER DEFAULT 0,
    status TEXT DEFAULT '进行中',
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );

  -- AI 分析历史 (ai_history 已合并到 ai_analyses)

  -- 性能索引
  CREATE INDEX IF NOT EXISTS idx_war_merit_member ON war_merit_records(member_id);
  CREATE INDEX IF NOT EXISTS idx_war_merit_created ON war_merit_records(created_at);
  CREATE INDEX IF NOT EXISTS idx_merit_logs_member ON merit_logs(member_id);
  CREATE INDEX IF NOT EXISTS idx_merit_logs_created ON merit_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_merit_logs_category ON merit_logs(category);
  CREATE INDEX IF NOT EXISTS idx_city_attendance_member ON city_attendance(member_id);
  CREATE INDEX IF NOT EXISTS idx_city_attendance_city ON city_attendance(city_id);
  CREATE INDEX IF NOT EXISTS idx_city_signups_city ON city_signups(city_id);
  CREATE INDEX IF NOT EXISTS idx_battle_reports_battle ON battle_reports(battle_id);
  CREATE INDEX IF NOT EXISTS idx_battle_reports_member ON battle_reports(member_id);
  CREATE INDEX IF NOT EXISTS idx_power_records_member ON power_records(member_id);
  CREATE INDEX IF NOT EXISTS idx_orders_member ON orders(member_id);
  CREATE INDEX IF NOT EXISTS idx_orders_goods ON orders(goods_id);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_journey_member_week ON journey_records(member_id, week_key);
  CREATE INDEX IF NOT EXISTS idx_enemy_generals_enemy ON enemy_generals(enemy_id);
  CREATE INDEX IF NOT EXISTS idx_award_dist_award ON award_distributions(award_id);
  CREATE INDEX IF NOT EXISTS idx_op_logs_created ON op_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_op_logs_user ON op_logs(user_id);

  -- 战报库（独立于战役战报）
  CREATE TABLE IF NOT EXISTS battle_report_lib (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id INTEGER,
    member_name TEXT DEFAULT '',
    enemy_name TEXT DEFAULT '',
    enemy_alliance TEXT DEFAULT '',
    result TEXT DEFAULT '',
    war_merit INTEGER DEFAULT 0,
    generals_used TEXT DEFAULT '',
    enemy_generals TEXT DEFAULT '',
    report_text TEXT DEFAULT '',
    image_path TEXT DEFAULT '',
    battle_date TEXT DEFAULT (date('now','localtime')),
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  -- 赛季归档
  CREATE TABLE IF NOT EXISTS season_archives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    season_name TEXT NOT NULL,
    archive_data TEXT DEFAULT '{}',
    total_members INTEGER DEFAULT 0,
    total_merit INTEGER DEFAULT 0,
    total_war INTEGER DEFAULT 0,
    top_members TEXT DEFAULT '[]',
    archived_at TEXT DEFAULT (datetime('now','localtime'))
  );

  -- AI 分析历史
  CREATE TABLE IF NOT EXISTS ai_analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    title TEXT DEFAULT '',
    target TEXT DEFAULT '',
    content TEXT DEFAULT '',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// 打城计划：主力目标（拆迁/驻守之外的第三类报名）
try {
  db.exec(`ALTER TABLE city_plans ADD COLUMN main_force_target INTEGER DEFAULT 0`)
} catch (e) {
  // column already exists
}

// 多同盟架构迁移
try { db.exec(`ALTER TABLE users ADD COLUMN alliance_id INTEGER REFERENCES alliances(id)`) } catch (e) {}
try { db.exec(`ALTER TABLE members ADD COLUMN alliance_id INTEGER REFERENCES alliances(id)`) } catch (e) {}
try { db.exec(`ALTER TABLE groups ADD COLUMN alliance_id INTEGER REFERENCES alliances(id)`) } catch (e) {}
try { db.exec(`ALTER TABLE battles ADD COLUMN alliance_id INTEGER REFERENCES alliances(id)`) } catch (e) {}
try { db.exec(`ALTER TABLE city_plans ADD COLUMN alliance_id INTEGER REFERENCES alliances(id)`) } catch (e) {}
try { db.exec(`ALTER TABLE goods ADD COLUMN alliance_id INTEGER REFERENCES alliances(id)`) } catch (e) {}
try { db.exec(`ALTER TABLE awards ADD COLUMN alliance_id INTEGER REFERENCES alliances(id)`) } catch (e) {}
try { db.exec(`ALTER TABLE enemies ADD COLUMN alliance_id INTEGER REFERENCES alliances(id)`) } catch (e) {}
try { db.exec(`ALTER TABLE applications ADD COLUMN alliance_id INTEGER REFERENCES alliances(id)`) } catch (e) {}
try { db.exec(`ALTER TABLE applications ADD COLUMN email TEXT DEFAULT ''`) } catch (e) {}
try { db.exec(`ALTER TABLE announcements ADD COLUMN alliance_id INTEGER REFERENCES alliances(id)`) } catch (e) {}

// 已有 admin 盟主 → 自动升级为 root
try {
  const adminUser = db.prepare("SELECT id FROM users WHERE username = 'admin' AND role = '盟主'").get()
  if (adminUser) {
    db.prepare("UPDATE users SET role = 'root', username = 'root' WHERE id = ?").run(adminUser.id)
    console.log('已将 admin 账号升级为 root 角色')
  }
} catch (e) {}

// 为现有数据创建默认同盟（如果还没有的话）
try {
  const allianceCount = db.prepare('SELECT COUNT(*) as c FROM alliances').get().c
  if (allianceCount === 0) {
    db.prepare("INSERT INTO alliances (name, description) VALUES ('默认同盟', '系统初始同盟')").run()
  }
} catch (e) {}

module.exports = { db, getSetting, setSetting, logOp, getAllianceSetting, setAllianceSetting, getMaskedAllianceSetting }
