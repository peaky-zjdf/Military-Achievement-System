const multer = require('multer')
const path = require('path')
const fs = require('fs')

/**
 * 创建带去重文件名的 multer 上传中间件
 * @param {string} dir 上传目录路径
 * @param {string} prefix 文件名前缀 (如 'j-', 'r-', 'u-')
 * @param {object} opts 额外选项 { maxSize, fileFilter }
 */
function createUploader(dir, prefix = '', opts = {}) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png'
      const safe = `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
      cb(null, safe)
    },
  })

  const fileFilter = opts.fileFilter || ((req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|bmp|gif)$/i.test(file.mimetype)) cb(null, true)
    else cb(new Error('仅支持图片文件'))
  })

  return multer({
    storage,
    limits: { fileSize: opts.maxSize || 8 * 1024 * 1024 },
    fileFilter,
  })
}

/** 静态文件服务中间件：提供上传目录的文件访问 */
function serveUploads(router, dir, routePath = '/uploads/:name') {
  router.get(routePath, (req, res) => {
    const p = path.join(dir, path.basename(req.params.name))
    if (!fs.existsSync(p)) return res.status(404).json({ error: '文件不存在' })
    res.sendFile(p)
  })
}

module.exports = { createUploader, serveUploads }
