<div align="center">

```
  |\---/|
  | o_o |
  \_^_/
AccBox 赛博金库 - 你的账号都在这里喵~
```

**自部署的账号管理工具 · Docker 一键启动 · 数据加密存储**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 🐱 本项目完全免费开源，如果你是付费获取的，你被骗了喵！

</div>

---

## 🗝️ 这是什么

AccBox 是一个自托管的账号管理面板，用于集中管理你散落各处的账号、密码、2FA 令牌和验证码。Docker 部署，多用户隔离，所有敏感数据加密存储在你自己的服务器上。

## ✨ 功能一览

| 模块 | 说明 |
|------|------|
| 📦 **账号管理** | 自定义分类、属性标签、组合筛选、排除筛选、收藏、批量操作 |
| 🛡️ **2FA/TOTP** | 标准 TOTP + Steam Guard，QR 扫码/手动配置，备份码独立管理 |
| 📬 **邮箱验证码** | OAuth 授权 Gmail/Outlook，支持 QQ/IMAP/Cloudflare Worker，自动提取推送 |
| ⏱️ **定时器** | 单个或批量倒计时，到期提醒 |
| 🎨 **主题** | 日间/夜间切换，四季主题（春樱/夏海/秋枫/冬雪） |
| 📱 **移动端** | 响应式适配，紧凑布局 |
| 💾 **数据** | JSON/CSV 导入导出，定时备份，含密钥的迁移备份 |

## 🚀 部署

需要 Docker 和 Docker Compose。

```bash
git clone https://github.com/shleeshlee/AccBox.git
cd AccBox
chmod +x install.sh && ./install.sh
```

安装脚本会自动生成加密密钥并保存到 `.env`，部署完成后按提示访问（默认端口 `9111`）。

### 更新

```bash
./update.sh
```

自动备份配置 → 拉取代码 → 重启服务，一条命令搞定喵。

## ⚙️ 配置

密钥和端口在 `.env` 文件中：

```bash
PORT=9111
APP_MASTER_KEY=    # 数据加密密钥，不设置则自动生成
JWT_SECRET_KEY=    # 登录令牌密钥，不设置则从主密钥派生
```

> ⚠️ **迁移服务器时必须保留密钥，否则已有数据无法解密。**

## 🔒 安全

- 密码 bcrypt 加盐哈希
- JWT Token（7 天过期）
- CORS 白名单
- 密码强度要求：≥8 字符 + 字母 + 数字
- 未设置密钥时使用默认公开密钥，系统会显示警告

## 📁 项目结构

```
AccBox/
├── index.html / style.css / app.js   # 前端（纯静态）
├── main.py                            # 后端（FastAPI + SQLite）
├── docker-compose.yml / Dockerfile    # 容器配置
├── install.sh / update.sh / keygen.sh # 运维脚本
└── data/                              # 数据目录（自动创建）
    ├── accounts.db                    #   SQLite 数据库
    └── backups/                       #   自动备份
```

## 📖 API

启动后访问 `/docs` 查看 Swagger 文档。

## 📄 License

MIT — 免费使用，保留署名。

---

<div align="center">

```
                                             /\_/\                                                                                                    
 ( o.o )
 > ^ < 
Made with 🐾 by WanWan 
```

</div>
