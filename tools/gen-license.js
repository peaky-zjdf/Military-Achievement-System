#!/usr/bin/env node
/** 厂商生成授权码： node tools/gen-license.js <机器码> [到期日YYYY-MM-DD|永久] [客户名] */
const { generateLicense, getMachineId } = require('../server/services/license')

const [, , machineId, expires = '', customer = ''] = process.argv

if (!machineId || machineId === '--self') {
  console.log('本机机器码:', getMachineId())
  console.log('用法: node tools/gen-license.js <机器码> [YYYY-MM-DD|永久] [客户名]')
  console.log('示例: node tools/gen-license.js ABCD... 2027-12-31 云衍盟')
  console.log('永久: node tools/gen-license.js ABCD... 永久 云衍盟')
  process.exit(machineId === '--self' ? 0 : 1)
}

const exp = !expires || expires === '永久' || expires === 'permanent' ? 0 : expires
const key = generateLicense({ machineId, expires: exp, customer })
console.log(key)
