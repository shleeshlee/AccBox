# 🍯 AccBox - 通用账号管家

一个安全、简洁的多用户账号管理系统，支持 **完整 2FA 验证码生成**、**二维码扫描导入**、**Steam Guard** 等功能。

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-5.0-green.svg)
![Docker](https://img.shields.io/badge/docker-ready-blue.svg)

## 📦 版本选择

| 版本 | 定位 | 获取方式 |
|------|------|----------|
| **v5.0** (当前) | 🚀 主推版本，功能完整 | `git clone` 默认获取 |
| v4.0 | 📦 简洁版，代码重构 | [切换到 v4 分支](https://github.com/shleeshlee/account-manager/tree/v4.0%E7%AE%80%E8%A6%81%E7%89%88?tab=readme-ov-file) |

### 版本功能对比

| 功能 | v5.0 ✅ | v4.0 |
|------|---------|------|
| 标准 TOTP (6/8位) | ✅ | ✅ |
| Steam Guard (5位字母) | ✅ | ✅ |
| 二维码扫描导入 | ✅ | ✅ |
| 多算法 (SHA1/256/512) | ✅ | ✅ |
| **时间偏移校正** | ✅ | ❌ |
| **备份码管理** | ✅ | ❌ |
| 安全中间件 | ✅ | ✅ |
| 环境变量密钥 | ✅ | ✅ |

> 💡 **推荐使用 v5.0**，功能更完整。v4.0 适合追求极简代码的开发者。

---

## ✨ 功能特性

### 🛡️ 完整 2FA 支持
- **标准 TOTP** - 支持 6/8 位数字验证码
- **Steam Guard** - Steam 专用 5 位字母验证码
- **多算法** - SHA1 / SHA256 / SHA512
- **二维码扫描** - 上传或拖拽图片自动识别
- **URI 导入** - 支持 `otpauth://` 链接
- **时间校正** - 服务器时间差修正
- **动画倒计时** - 验证码过期可视化

### 🔐 安全特性
- **Fernet 加密** - 密码加密存储
- **环境变量密钥** - 支持 `APP_MASTER_KEY` 配置
- **安全中间件** - 阻止访问敏感文件
- **前端警告** - 不安全配置时显示警告
- **多用户隔离** - 独立数据空间

### 📁 账号管理
- 自定义账号类型（图标、颜色、登录链接）
- 组合标签系统
- 收藏功能（多种样式）
- 批量操作
- JSON/CSV 导入导出

### 🎨 界面体验
- 日间/夜间主题
- 卡片/列表视图
- 响应式设计
- 自定义头像

---

## 🚀 快速部署

### Docker 一键部署（推荐）

```bash
# 1. 克隆项目
git clone https://github.com/shleeshlee/account-manager.git
cd account-manager

# 2. 生成安全密钥（重要！）
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"

# 3. 修改 docker-compose.yml 中的 APP_MASTER_KEY

# 4. 启动
docker-compose up -d

# 5. 访问 http://localhost:9111
```

### 手动部署

```bash
pip install fastapi uvicorn cryptography pydantic
export APP_MASTER_KEY="your-secure-key"
python main.py
```

---

## 🔐 安全配置

### 密钥模式

| 模式 | 安全级别 | 说明 |
|------|---------|------|
| 环境变量 | ⭐⭐⭐ 推荐 | `APP_MASTER_KEY` |
| 文件密钥 | ⭐⭐ | 自动生成 `data/.encryption_key` |
| 默认密钥 | ❌ 危险 | 会显示红色警告 |

### 生成密钥

```python
from cryptography.fernet import Fernet
print(Fernet.generate_key().decode())
# 输出类似: gAAAAABk...
```

⚠️ **警告**：使用默认密钥时，系统会显示安全警告。请在存入数据前配置正式密钥！

---

## 📷 二维码扫描

支持直接扫描 2FA 二维码图片：

1. 点击 **🛡️ 配置 2FA**
2. 上传或拖拽二维码截图
3. 自动识别并填充配置

支持：Google Authenticator、Microsoft Authenticator、Authy、1Password 等

---

## 🎮 Steam Guard

1. 获取 Steam `shared_secret`（Base64格式）
2. 点击账号的 **🛡️ 2FA** 按钮
3. 选择类型 **Steam Guard**
4. 粘贴密钥并保存
5. 即可生成 5 位字母验证码

---

## 📝 API 接口

访问 `http://localhost:9111/docs` 查看完整 API 文档。

### 主要接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/register` | POST | 用户注册 |
| `/api/login` | POST | 用户登录 |
| `/api/accounts` | GET/POST | 账号列表/创建 |
| `/api/accounts/{id}/totp` | GET/POST/DELETE | 2FA 配置 |
| `/api/accounts/{id}/totp/generate` | GET | 生成验证码 |
| `/api/export` | GET | 导出数据 |
| `/api/import` | POST | 导入数据 |
| `/api/health` | GET | 健康检查 |

---

## 📁 项目结构

```
account-manager/
├── index.html          # 前端页面
├── style.css           # 样式文件
├── app.js              # 前端逻辑
├── flags.js            # 国家旗帜
├── main.py             # 后端 API
├── Dockerfile          
├── docker-compose.yml  
├── nginx.conf          
└── data/               # 数据目录
    ├── accounts.db
    └── .encryption_key
```

---

## 🔄 更新日志

### v5.0
- ✨ 二维码扫描导入 2FA
- ✨ 后端验证码生成（支持 Steam Guard）
- ✨ 算法选择（SHA1/SHA256/SHA512）
- ✨ 时间偏移校正
- 🔒 安全中间件 + 环境变量密钥

### v4.0
- 🔧 代码重构整理
- ✨ 二维码扫描
- ✨ 完整 2FA 支持

### v3.0
- 🔒 安全中间件
- ✨ 2FA 基础功能

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 License

MIT License
