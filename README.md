# AccBox

自部署的账号管理工具。Docker 一键部署，多用户隔离，数据加密存储。

## 功能

- **账号管理** — 自定义分类、属性标签、组合筛选、排除筛选、收藏、批量操作
- **2FA/TOTP** — 支持标准 TOTP 和 Steam Guard，含备份码
- **邮箱验证码** — OAuth 授权 Gmail/Outlook，支持 QQ/IMAP/Cloudflare Worker，自动提取验证码并推送
- **卡片状态** — 三级状态（正常/混合/冰冻），冰冻账号自动沉底
- **定时器** — 单个或批量添加倒计时，到期后点击消除
- **视图** — 卡片/列表切换，日间/夜间/四季主题
- **数据** — JSON/CSV 导入导出，定时备份，迁移备份（含密钥）
- **移动端** — 响应式适配

## 部署

需要 Docker 和 Docker Compose。

```bash
git clone https://github.com/shleeshlee/AccBox.git
cd AccBox
chmod +x install.sh && ./install.sh
```

安装脚本会自动生成加密密钥并保存到 `.env`。部署完成后按提示访问。

## 更新

```bash
./update.sh
```

自动备份配置、拉取代码、重启服务。

## 配置

密钥和端口在 `.env` 文件中：

```bash
PORT=9111
APP_MASTER_KEY=    # 数据加密密钥，不设置则自动生成
JWT_SECRET_KEY=    # 登录令牌密钥，不设置则从主密钥派生
```

迁移服务器时必须保留密钥，否则已有数据无法解密。

## 项目结构

```
AccBox/
├── index.html / style.css / app.js   # 前端
├── main.py                            # 后端 (FastAPI + SQLite)
├── docker-compose.yml / Dockerfile    # 容器配置
├── install.sh / update.sh / keygen.sh # 运维脚本
└── data/                              # 数据目录（自动创建）
    ├── accounts.db
    └── backups/
```

## API

启动后访问 `/docs` 查看 Swagger 文档。

## License

MIT
