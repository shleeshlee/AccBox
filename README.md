# 🍯 AccBox (通用账号管家) v5.1

一个简洁的多用户账号管理系统，支持自定义分类、属性标签、2FA、收藏等功能。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-5.1-green.svg)]()

## ✨ v5.1 更新内容 (安全修复版)

### 🔐 安全增强
- **密码哈希升级**: SHA256 → bcrypt (自动迁移旧密码)
- **Token 过期**: 随机字符串 → JWT (7天过期)
- **CORS 收紧**: `*` → 白名单模式
- **密码强度**: 4字符 → 8字符+字母+数字
- **URL 验证**: 防止 `javascript:` XSS 攻击
- **配置分离**: 密钥存储在 `.env` 文件，避免 git 冲突

### 📦 新功能
- **数据备份**: 一键备份/恢复数据库，支持定时自动备份
- **迁移备份**: 包含密钥文件，方便服务器迁移
- **一键更新**: 使用 `update.sh` 安全更新，自动备份配置

## ✨ 功能特性

- 🌙 日间/夜间主题切换
- 📁 自定义账号类型（Google、Microsoft、Discord等）
- 🎨 账号类型自定义图标和背景色
- 🏷️ 自定义属性组和标签
- ⭐ 收藏功能（多种收藏样式可选）
- 🕐 最近使用记录
- 🔍 搜索和多条件筛选
- 📥 JSON/CSV 导入导出
- ✅ 批量选择和删除
- 🃏 卡片/列表两种视图模式
- 👤 用户头像自定义
- 🔐 多用户数据隔离
- 📱 响应式设计，支持移动端
- 🛡️ 2FA/TOTP 支持 (含 Steam Guard)
- 📦 数据备份与恢复

## 🚀 快速部署

### 方式一：Docker 一键部署（推荐）

**前提：已安装 Docker 和 Docker Compose**

```bash
# 1. 克隆项目
git clone https://github.com/shleeshlee/account-manager.git
cd account-manager

# 2. 创建配置文件并设置密钥
cp .env.example .env
# 编辑 .env，填入您的 APP_MASTER_KEY（必须！否则会显示安全警告）

# 3. 启动服务
docker-compose up -d

# 4. 访问
# 浏览器打开 http://localhost:9111
```

### 方式二：手动部署

#### 1. 安装依赖

```bash
# Python 3.8+
pip install fastapi uvicorn cryptography pydantic passlib[bcrypt] python-jose[cryptography]
```

#### 2. 启动后端

```bash
python main.py
# 后端运行在 http://localhost:9111
```

## 🔄 更新版本

使用一键更新脚本（推荐）：

```bash
# 首次使用需要授权
chmod +x update.sh

# 以后每次更新
./update.sh
```

脚本会自动：
1. 📦 备份 `docker-compose.yml` 和 `.env`
2. ⬇️ 拉取最新代码
3. 🚀 重启服务

## ⚙️ 配置说明

### 配置文件 (.env)

密钥和端口配置存储在 `.env` 文件中（不会被 git 覆盖）：

```bash
# 端口设置
PORT=9111

# 主密钥（用于加密数据）
# 不设置则自动生成并保存在 data/.encryption_key
APP_MASTER_KEY=

# JWT 密钥（用于登录令牌）
# 不设置则自动从 APP_MASTER_KEY 派生
JWT_SECRET_KEY=
```

### 密钥说明

| 情况 | 说明 |
|------|------|
| `.env` 中设置了密钥 | ✅ 推荐，安全且方便迁移 |
| 未设置密钥 | ⚠️ 使用默认公开密钥，**不安全**，系统会显示警告 |

**重要**: 迁移服务器时必须保留您的密钥，否则数据无法解密。

## 📦 数据备份

### 使用界面备份
1. 点击头像 → 📦 数据备份
2. 点击「备份数据库」或「迁移备份」
3. 备份文件保存在 `data/backups/` 目录

### 备份类型

| 类型 | 说明 | 用途 |
|------|------|------|
| 📦 备份数据库 | 只备份数据库文件 | 日常备份 |
| 🔐 迁移备份 | 数据库 + 密钥文件 | 服务器迁移 |
| ⏰ 定时备份 | 自动执行（服务器端） | 无需保持浏览器打开 |

### 使用 API 备份
```bash
curl -X POST http://localhost:9111/api/backup \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"include_key": false}'
```

## 📁 项目结构

```
account-manager/
├── index.html          # 前端页面
├── style.css           # 样式文件
├── app.js              # 前端逻辑
├── flags.js            # 国家旗帜
├── main.py             # 后端 API (FastAPI)
├── Dockerfile          # Docker 镜像构建
├── docker-compose.yml  # Docker Compose 配置
├── .env.example        # 配置文件模板
├── .gitignore          # Git 忽略规则
├── update.sh           # 一键更新脚本
├── docker/
│   ├── nginx.conf      # Nginx 配置
│   └── supervisord.conf
└── data/               # 数据目录（自动创建）
    ├── accounts.db     # SQLite 数据库
    ├── .encryption_key # 加密密钥（自动生成时）
    └── backups/        # 备份目录
```

## 🔒 安全说明

### 已修复的安全问题 (v5.1)
- ✅ 密码使用 bcrypt 加盐哈希
- ✅ Token 使用 JWT 并设置过期时间
- ✅ CORS 使用白名单而非 `*`
- ✅ 密码强度要求增强
- ✅ URL 协议验证防止 XSS

### 旧密码自动升级
v5.1 兼容旧版本的 SHA256 密码：
- 旧用户可以正常登录
- 登录成功后自动升级为 bcrypt
- 无需手动操作

## 🔄 从 v5.0 升级

⚠️ **重要**: v5.1 改变了配置方式，请仔细阅读！

### 升级步骤

1. **备份当前密钥**
   
   打开您的 `docker-compose.yml`，复制 `APP_MASTER_KEY` 的值。

2. **创建 .env 文件**
   ```bash
   cp .env.example .env
   ```

3. **填入密钥**
   
   编辑 `.env`，将复制的密钥粘贴进去：
   ```bash
   APP_MASTER_KEY=您之前的密钥
   ```

4. **更新代码**
   ```bash
   ./update.sh
   # 或手动：git pull && docker-compose up -d --build
   ```

### 如果您之前没有设置密钥

说明您一直使用的是默认公开密钥，数据处于不安全状态。建议：
1. 导出数据（JSON 格式）
2. 创建 `.env` 文件并设置新密钥
3. 重新导入数据

## 📝 API 文档

启动后访问 `http://localhost:9111/docs` 查看 Swagger API 文档。

## 📄 License

MIT License

## 🙏 致谢

感谢 Anthropic Claude 和 Google Gemini 进行安全审计。
