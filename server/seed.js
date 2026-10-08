const bcrypt = require('bcryptjs')
const { db } = require('./db')

function seed() {
  const memberCount = db.prepare('SELECT COUNT(*) as c FROM members').get().c
  if (memberCount > 3) {
    console.log('数据已存在，跳过演示数据')
    return
  }

  const groups = db.prepare('SELECT * FROM groups').all()
  const g1 = groups[0]?.id
  const g2 = groups[1]?.id
  const g3 = groups[2]?.id

  const names = [
    ['10001', '青龙偃月', g1, '团长', 28000],
    ['10002', '丈八蛇矛', g1, '成员', 26500],
    ['10003', '方天画戟', g1, '成员', 31200],
    ['10004', '麒麟弓', g1, '成员', 22100],
    ['10005', '倚天剑', g1, '成员', 19800],
    ['20001', '虎头湛金', g2, '团长', 27500],
    ['20002', '亮银枪', g2, '成员', 24300],
    ['20003', '龙胆', g2, '成员', 29800],
    ['20004', '铁脊蛇矛', g2, '成员', 18700],
    ['20005', '双股剑', g2, '成员', 21000],
    ['30001', '古锭刀', g3, '团长', 25600],
    ['30002', '青釭剑', g3, '成员', 23400],
    ['30003', '七星宝刀', g3, '成员', 20100],
    ['30004', '铁蒺藜骨朵', g3, '成员', 17600],
    ['30005', '飞将', g3, '成员', 15200],
  ]

  const insert = db.prepare(`
    INSERT INTO members (game_id, nickname, group_id, role, status, power, total_merit, available_merit)
    VALUES (?, ?, ?, ?, '活跃', ?, ?, ?)
  `)

  const memberIds = []
  names.forEach((n, i) => {
    const merit = Math.round(n[4] * (0.8 + Math.random() * 0.5))
    const info = insert.run(n[0], n[1], n[2], n[3], n[4], merit, merit)
    memberIds.push(info.lastInsertRowid)
  })

  // users for some members
  const hash = bcrypt.hashSync('123456', 10)
  db.prepare('INSERT OR IGNORE INTO users (username, password_hash, member_id, role) VALUES (?, ?, ?, ?)')
    .run('leader1', hash, memberIds[0], '团长')
  db.prepare('INSERT OR IGNORE INTO users (username, password_hash, member_id, role) VALUES (?, ?, ?, ?)')
    .run('member1', hash, memberIds[1], '成员')

  // update group leaders
  db.prepare('UPDATE groups SET leader_id = ? WHERE id = ?').run(memberIds[0], g1)
  db.prepare('UPDATE groups SET leader_id = ? WHERE id = ?').run(memberIds[5], g2)
  db.prepare('UPDATE groups SET leader_id = ? WHERE id = ?').run(memberIds[10], g3)

  // city plans
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  const d1 = new Date(now.getTime() + 86400000)
  const d2 = new Date(now.getTime() + 2 * 86400000)
  const d0 = new Date(now.getTime() - 86400000)

  const c1 = db.prepare(`
    INSERT INTO city_plans (name, coord_x, coord_y, planned_time, target_group_id, demolition_target, guard_target, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, '计划中', 1)
  `).run('虎牢关', 500, 400, fmt(d1), null, 200000, 20).lastInsertRowid

  const c2 = db.prepare(`
    INSERT INTO city_plans (name, coord_x, coord_y, planned_time, target_group_id, demolition_target, guard_target, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, '计划中', 1)
  `).run('洛阳', 620, 580, fmt(d2), null, 500000, 40).lastInsertRowid

  const c0 = db.prepare(`
    INSERT INTO city_plans (name, coord_x, coord_y, planned_time, target_group_id, demolition_target, guard_target, status, finished_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, '已完成', ?, 1)
  `).run('函谷关', 480, 390, fmt(d0), null, 150000, 15, fmt(new Date(d0.getTime() + 3600000))).lastInsertRowid

  // signups for upcoming
  for (const id of memberIds.slice(0, 8)) {
    db.prepare('INSERT INTO city_signups (city_id, member_id, type) VALUES (?, ?, ?)').run(c1, id, '拆迁')
  }
  for (const id of memberIds.slice(8, 12)) {
    db.prepare('INSERT INTO city_signups (city_id, member_id, type) VALUES (?, ?, ?)').run(c1, id, '驻守')
  }

  // attendance for finished city
  const att = db.prepare(`
    INSERT INTO city_attendance (city_id, member_id, attended, demolition, merit, recorded_by)
    VALUES (?, ?, ?, ?, ?, 1)
  `)
  memberIds.slice(0, 10).forEach((id, i) => {
    const attended = i < 8 ? 1 : 0
    const demolition = attended ? 5000 + Math.floor(Math.random() * 15000) : 0
    const merit = attended ? 20 + demolition * 2 : -50
    att.run(c0, id, attended, demolition, merit)
    db.prepare(`
      INSERT INTO merit_logs (member_id, type, amount, balance_after, total_after, reason, category, operator_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      id, merit >= 0 ? '收入' : '扣减', merit,
      (db.prepare('SELECT available_merit FROM members WHERE id=?').get(id).available_merit),
      (db.prepare('SELECT total_merit FROM members WHERE id=?').get(id).total_merit),
      attended ? `打城拆迁${demolition}` : '打城缺勤',
      attended ? '打城' : '缺勤'
    )
  })

  // war merit samples
  const war = db.prepare(`
    INSERT INTO war_merit_records (member_id, amount, type, source, recorded_by)
    VALUES (?, ?, ?, '演示数据', 1)
  `)
  memberIds.forEach((id) => {
    const amount = 80000 + Math.floor(Math.random() * 200000)
    war.run(id, amount, '野战')
    const merit = Math.round(amount * 0.1)
    const m = db.prepare('SELECT available_merit, total_merit FROM members WHERE id=?').get(id)
    db.prepare('UPDATE members SET available_merit = ?, total_merit = ? WHERE id = ?')
      .run(m.available_merit + merit, m.total_merit + merit, id)
    db.prepare(`
      INSERT INTO merit_logs (member_id, type, amount, balance_after, total_after, reason, category, operator_id)
      VALUES (?, '收入', ?, ?, ?, ?, '武勋', 1)
    `).run(id, merit, m.available_merit + merit, m.total_merit + merit, `野战武勋${amount}`)
  })

  // battle
  const b = db.prepare(`
    INSERT INTO battles (name, coord_x, coord_y, start_time, end_time, vs_party, groups_text, status, created_by)
    VALUES ('中原争夺战', 550, 500, ?, ?, '【敌盟】铁骑', '一团,二团', '进行中', 1)
  `).run(fmt(d0), fmt(now)).lastInsertRowid

  memberIds.slice(0, 5).forEach((id) => {
    db.prepare(`
      INSERT INTO battle_reports (battle_id, member_id, war_merit, demolition, guard_minutes, land_flips, merit_awarded)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(b, id, 50000 + Math.floor(Math.random() * 100000), 3000, 30, 5, 800)
  })

  // applications
  db.prepare(`
    INSERT INTO applications (game_id, nickname, contact, season_info, obey_manage)
    VALUES ('90001', '新晋都督', 'qq:123456', '上赛季割据，擅长拆迁队', 1)
  `).run()
  db.prepare(`
    INSERT INTO applications (game_id, nickname, contact, season_info, obey_manage)
    VALUES ('90002', '夜袭小将', 'wx:ye_xi', '开服玩家，可长期在线', 1)
  `).run()

  // more goods already seeded; awards
  db.prepare(`
    INSERT INTO awards (name, description, type, quota, created_by)
    VALUES ('S1 征服名额', '按累计军功排名分配征服名额', '征服名额', 5, 1)
  `).run()

  console.log('演示数据已写入')
  console.log('团长: leader1 / 123456')
  console.log('成员: member1 / 123456')
  console.log('管理员 admin 密码若由服务端首次初始化，请查看启动日志中的随机密码')
}

seed()
