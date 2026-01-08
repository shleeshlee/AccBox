# 🍯 AccBox (通用账号管家)

一个简洁的多用户账号管理系统，支持自定义分类、属性标签、收藏等功能。

![License](https://img.shields.io/badge/license-MIT-blue.svg)

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

## 🚀 快速部署

### 方式一：Docker 一键部署（推荐）

**前提：已安装 Docker 和 Docker Compose**

```bash
# 1. 克隆项目
git clone https://github.com/shleeshlee/account-manager.git
cd account-manager

# 2. 启动服务
docker-compose up -d

# 3. 访问
# 浏览器打开 http://localhost:9111
```

**停止服务：**
```bash
docker-compose down
```

**查看日志：**
```bash
docker-compose logs -f
```

---

### 方式二：手动部署

#### 1. 安装依赖

```bash
# Python 3.8+
pip install fastapi uvicorn cryptography pydantic
```

#### 2. 启动后端

```bash
python main.py
# 后端运行在 http://localhost:9111
```

#### 3. 配置 Nginx

```nginx
server {
    listen 80;
    server_name your-domain.com;
    
    root /path/to/account-manager;
    index index.html;
    
    location / {
        try_files $uri $uri/ /index.html;
    }
    
    # API 反向代理
    location /api {
        proxy_pass http://127.0.0.1:9111;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

#### 4. 使用 systemd 管理（可选）

```bash
# 创建服务文件
sudo cat > /etc/systemd/system/account-manager.service << 'EOF'
[Unit]
Description=Account Manager API
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/account-manager
ExecStart=/usr/bin/python3 main.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 启动服务
sudo systemctl daemon-reload
sudo systemctl enable account-manager
sudo systemctl start account-manager
```

---

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
├── docker/
│   ├── nginx.conf      # Nginx 配置
│   └── supervisord.conf # 进程管理配置
└── data/               # 数据目录（自动创建）
    ├── accounts.db     # SQLite 数据库
    └── .encryption_key # 加密密钥
```

## ⚙️ 配置说明

### 修改端口

**Docker 方式：** 修改 `docker-compose.yml` 中的端口映射：
```yaml
ports:
  - "你的端口:80"
```

**手动部署：** 设置环境变量或修改 `main.py`：
```bash
PORT=8080 python main.py
```

### 数据持久化

- 数据库文件：`accounts.db`
- 加密密钥：`.encryption_key`

⚠️ **重要：** `.encryption_key` 文件是解密账号密码的密钥，请妥善备份！

## 🛠️ 常见问题

### API 返回 404？

确保 Nginx 配置了 `/api` 反向代理到后端端口（默认 9111）。

### 忘记密码？

数据库中密码是加密的，无法恢复。可以删除数据库文件重新开始，或直接操作 SQLite 删除用户。

### Docker 启动失败？

```bash
# 查看详细日志
docker-compose logs -f

# 重新构建
docker-compose build --no-cache
docker-compose up -d
```

## 📝 API 文档

启动后访问 `http://localhost:9111/docs` 查看 Swagger API 文档。

## 🖼️ 截图预览

> 可在此处添加应用截图

## 🔄 更新日志

### v11.6
- 新增：账号类型支持自定义背景色（点击图标即可更换）
- 新增：批量选择/删除功能
- 新增：卡片/列表视图切换
- 新增：收藏样式自定义（紫/粉/金/红/蓝/绿）
- 新增：用户头像选择
- 优化：空状态页面居中显示
- 优化：类型管理界面布局
- 修复：批量删除时已不存在的账号也计为成功

## 📄 License

MIT License
