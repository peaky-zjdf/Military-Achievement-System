# 率土之滨军功管理系统（shitabing-merit）

面向《率土之滨》游戏同盟的军功管理平台：记录成员战功、自动识别战报截图、核算军功与奖励，支持多同盟隔离运行。前端为编译好的 React SPA，后端 Node.js + Express + better-sqlite3，单进程即可部署。

## 功能概览

- 多同盟架构：平台管理员（root）+ 同盟盟主两级管理，数据按同盟隔离，邀请码注册入盟
- 成员与分组：成员档案、团长/成员分组、城池（city）管理
- 军功记录：手动录入 + 战报截图 OCR 自动识别，双路识别（SiliconFlow 视觉模型 + 本地 rapidocr）
- 战报解析：report/battle/reportshot/journey 多入口，自动裁剪、解析、入库
- 奖励与商店：awards 奖励发放、shop 积分兑换、rank 排行榜、dashboard 数据看板
- 敌对同盟管理（enemies）、邮件通知（email，SMTP 按同盟配置）
- 系统设置：API/邮箱配置按同盟隔离（alliance_settings），AI 分析（ai）、功能开关（features）、授权许可（license）
- 前端体验：3 套主题循环切换（深色 / 玻璃拟态 / 浅色）、视频开屏动画、三皇背景登录页

## 技术栈

| 层 | 技术 |
| --- | --- |
| 后端 | Node.js (≥18)、Express 4、better-sqlite3 |
| 前端 | React SPA（编译产物在 `server/public/`，含多主题 CSS/JS） |
| OCR / AI | Python（rapidocr + Pillow）、SiliconFlow API（视觉 Qwen3-VL-8B-Instruct / 文本 DeepSeek-V4-Flash）、tesseract.js |
| 其他 | JWT + bcryptjs 鉴权、multer 上传、nodemailer 邮件、xlsx 导出 |

## 目录结构

```
server/
  index.js          # 入口：Express 装配 + 静态托管 + 启动
  db.js             # SQLite 连接与建表
  seed.js           # 演示数据
  clear-data.js     # 清空业务数据
  middleware/       # auth（JWT）、alliance（同盟数据隔离）
  routes/           # auth/members/merit/battle/report/ocr/journey/awards/
                    # shop/rank/dashboard/city/enemies/settings/features/
                    # ai/email/license/reportshot
  services/         # merit/ocr/rapidOcr/vision/reportParse/journeyOcr/
                    # uploader/license/python/validate 等业务实现
  public/           # 前端构建产物（SPA + 多主题 + 静态页）
  data/             # SQLite 数据库与上传文件（不入库，见 .gitignore）
tools/gen-license.js  # 授权许可生成
```

## 快速开始

```bash
npm install
npm run seed     # 可选：写入演示数据
npm start        # 默认 http://127.0.0.1:3789
```

环境变量：

- `PORT`：监听端口，默认 3789
- `MERIT_PYTHON` / `MIMO_PYTHON`：本地 OCR 使用的 Python 解释器路径
- 本地 OCR 需安装 `rapidocr` 与 `Pillow`；SiliconFlow API 密钥在系统设置 / 同盟设置中配置，不写在代码里

## 部署

生产环境用 systemd 管理（示例）：

```ini
[Service]
WorkingDirectory=/opt/merit
ExecStart=/usr/bin/node server/index.js
Restart=always
```

注意：`better-sqlite3` 为原生模块，重编译时请使用与运行时一致的 Node 版本（本机 `/usr/bin/node` v20）。

## 仓库说明

`node_modules/`、`server/data/`（数据库与玩家上传截图）、打包 zip 不入库；clone 后 `npm install` 并自行初始化数据库即可运行。
