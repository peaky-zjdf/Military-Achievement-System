const fs = require('fs')
const path = require('path')

/** 解析可用的 Python 解释器（Windows: python / Linux: python3） */
function pythonExe() {
  if (process.env.MIMO_PYTHON) return process.env.MIMO_PYTHON
  if (process.env.MERIT_PYTHON) return process.env.MERIT_PYTHON
  if (process.platform === 'win32') return 'python'
  return 'python3'
}

module.exports = { pythonExe }
