const path = require('path')
const { execFileSync } = require('child_process')
const { pythonExe } = require('./python')

/** RapidOCR 中文识别，返回按 y 排序的文本行 */
function rapidOcr(imagePath) {
  try {
    const out = execFileSync(
      pythonExe(),
      [path.join(__dirname, '../rapid_ocr.py'), imagePath],
      { timeout: 60000, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
    )
    const line = String(out).trim().split('\n').filter(Boolean).pop() || '{}'
    const data = JSON.parse(line)
    return (data.items || []).map((it) => it.text)
  } catch (e) {
    console.error('rapidOcr fail', e.message)
    return []
  }
}

function rapidOcrFull(imagePath) {
  try {
    const out = execFileSync(
      pythonExe(),
      [path.join(__dirname, '../rapid_ocr.py'), imagePath],
      { timeout: 60000, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
    )
    const line = String(out).trim().split('\n').filter(Boolean).pop() || '{}'
    const data = JSON.parse(line)
    const items = data.items || []
    return {
      items,
      text: items.map((it) => it.text).join('\n'),
    }
  } catch (e) {
    console.error('rapidOcr fail', e.message)
    return { items: [], text: '' }
  }
}

module.exports = { rapidOcr, rapidOcrFull }
