#!/bin/bash

# ==========================================
# AccBox 账号管家 - 一键安装脚本
# ==========================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m'

# 清屏
clear

# ========== 署名横幅 ==========
echo -e "${CYAN}"
cat << "EOF"
    ___                ____            
   /   | ____________ / __ )____  _  __
  / /| |/ ___/ ___/ __ / / __ \| |/_/
 / ___ / /__/ /__/ /_/ / /_/ />  <  
/_/  |_\___/\___/_____/\____/_/|_|  
                                      
EOF
echo -e "${NC}"

echo -e "${MAGENTA}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${MAGENTA}║                                                               ║${NC}"
echo -e "${MAGENTA}║  ${BOLD}AccBox 账号管家${NC}${MAGENTA} - 开源免费的多用户账号管理系统           ║${NC}"
echo -e "${MAGENTA}║                                                               ║${NC}"
echo -e "${MAGENTA}║  ${CYAN}作者: Author${NC}${MAGENTA}                                              ║${NC}"
echo -e "${MAGENTA}║  ${CYAN}GitHub: https://github.com/shleeshlee/AccBox${NC}${MAGENTA}              ║${NC}"
echo -e "${MAGENTA}║                                                               ║${NC}"
echo -e "${MAGENTA}║  ${GREEN}✓ 免费开源 | ✓ MIT 协议 | ✓ 禁止倒卖${NC}${MAGENTA}                     ║${NC}"
echo -e "${MAGENTA}║                                                               ║${NC}"
echo -e "${MAGENTA}║  ${YELLOW}⚠ 如果你是付费获取的本项目，你被骗了！${NC}${MAGENTA}                  ║${NC}"
echo -e "${MAGENTA}║                                                               ║${NC}"
echo -e "${MAGENTA}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# ========== 检测 5.0 版本密钥迁移 ==========
MIGRATED_KEY=""
DEFAULT_KEY="MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="

if [ -f "docker-compose.yml" ]; then
    # 尝试提取 docker-compose.yml 中的旧密钥
    OLD_KEY=$(grep -E "APP_MASTER_KEY=" docker-compose.yml | grep -v ':-' | grep -v '\${' | sed 's/.*APP_MASTER_KEY=//' | tr -d ' "' | head -1)
    
    if [ -n "$OLD_KEY" ] && [ "$OLD_KEY" != "$DEFAULT_KEY" ]; then
        echo -e "${YELLOW}════════════════════════════════════════════════════════════════════${NC}"
        echo -e "${YELLOW}  检测到 v5.0 版本的密钥配置！${NC}"
        echo -e "${YELLOW}════════════════════════════════════════════════════════════════════${NC}"
        echo ""
        echo -e "  发现旧密钥: ${CYAN}${OLD_KEY:0:20}...${NC}"
        echo ""
        echo -e "  为保证数据兼容，将自动迁移此密钥到 .env 文件"
        echo ""
        MIGRATED_KEY="$OLD_KEY"
    fi
fi

# ========== 检查依赖 ==========
echo -e "${YELLOW}[1/5] 检查环境...${NC}"

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}  ✗ 未检测到 Docker，请先安装 Docker${NC}"
    echo "    安装指南: https://docs.docker.com/get-docker/"
    exit 1
fi
echo -e "${GREEN}  ✓ Docker 已安装${NC}"

# 检查 Docker Compose
if command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
elif docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
else
    echo -e "${RED}  ✗ 未检测到 Docker Compose，请先安装${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ Docker Compose 已安装${NC}"

# ========== 生成密钥 ==========
echo ""
echo -e "${YELLOW}[2/5] 生成安全密钥...${NC}"

# 生成 Fernet 密钥 (用于数据加密)
# Fernet 密钥需要 32 字节的 base64 编码
generate_fernet_key() {
    # 生成 32 字节随机数据并进行 base64 编码
    if command -v openssl &> /dev/null; then
        openssl rand -base64 32
    elif command -v python3 &> /dev/null; then
        python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" 2>/dev/null || \
        python3 -c "import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())"
    elif command -v python &> /dev/null; then
        python -c "import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())"
    else
        # 最后手段：使用 /dev/urandom
        head -c 32 /dev/urandom | base64
    fi
}

# 生成 JWT 密钥 (URL 安全的随机字符串)
generate_jwt_key() {
    if command -v openssl &> /dev/null; then
        openssl rand -base64 32 | tr -d '/+=' | head -c 43
    elif command -v python3 &> /dev/null; then
        python3 -c "import secrets; print(secrets.token_urlsafe(32))"
    elif command -v python &> /dev/null; then
        python -c "import secrets; print(secrets.token_urlsafe(32))"
    else
        head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 43
    fi
}

# 如果检测到 5.0 迁移的密钥，使用旧密钥；否则生成新密钥
if [ -n "$MIGRATED_KEY" ]; then
    APP_MASTER_KEY="$MIGRATED_KEY"
    echo -e "${GREEN}  ✓ APP_MASTER_KEY 已从 v5.0 迁移${NC}"
else
    APP_MASTER_KEY=$(generate_fernet_key)
    echo -e "${GREEN}  ✓ APP_MASTER_KEY 已生成${NC}"
fi

JWT_SECRET_KEY=$(generate_jwt_key)
echo -e "${GREEN}  ✓ JWT_SECRET_KEY 已生成${NC}"

# ========== 创建配置文件 ==========
echo ""
echo -e "${YELLOW}[3/5] 创建配置文件...${NC}"

if [ -f ".env" ]; then
    echo -e "${YELLOW}  ! 检测到已存在 .env 文件${NC}"
    read -p "    是否覆盖？(y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${GREEN}  ✓ 保留现有配置${NC}"
        SKIP_ENV=true
    fi
fi

if [ "$SKIP_ENV" != true ]; then
    cat > .env << EOF
# ╔══════════════════════════════════════════════════════════════╗
# ║           AccBox 账号管家 - 配置文件                         ║
# ║           由安装脚本自动生成于 $(date +"%Y-%m-%d %H:%M:%S")             ║
# ╠══════════════════════════════════════════════════════════════╣
# ║  GitHub: https://github.com/shleeshlee/AccBox                ║
# ║  作者: Author | 免费开源，禁止倒卖                           ║
# ╚══════════════════════════════════════════════════════════════╝

# 端口设置 (默认 9111)
PORT=9111

# 🔐 主密钥 - 用于加密您的密码数据
# ⚠️ 重要：请妥善保管此密钥，丢失将无法解密数据！
APP_MASTER_KEY=${APP_MASTER_KEY}

# 🎫 JWT 密钥 - 用于登录令牌签名
JWT_SECRET_KEY=${JWT_SECRET_KEY}

# 📦 备份存储路径 (可选)
# BACKUP_HOST_PATH=/your/backup/path
EOF
    echo -e "${GREEN}  ✓ .env 文件已创建${NC}"
fi

# ========== 创建必要目录 ==========
echo ""
echo -e "${YELLOW}[4/5] 创建数据目录...${NC}"

mkdir -p data backups
echo -e "${GREEN}  ✓ data/ 目录已创建${NC}"
echo -e "${GREEN}  ✓ backups/ 目录已创建${NC}"

# ========== 启动服务 ==========
echo ""
echo -e "${YELLOW}[5/5] 启动服务...${NC}"

$COMPOSE_CMD up -d --build

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${GREEN}${BOLD}  ✓ 安装完成！${NC}"
echo ""
echo -e "${CYAN}════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}访问地址:${NC}  http://localhost:9111"
echo -e "            http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo "your-ip"):9111"
echo ""
echo -e "${CYAN}────────────────────────────────────────────────────────────────────${NC}"
echo ""
echo -e "  ${BOLD}${YELLOW}⚠ 请保存以下密钥（丢失将无法解密数据）:${NC}"
echo ""
echo -e "  ${BOLD}APP_MASTER_KEY:${NC}"
echo -e "  ${GREEN}${APP_MASTER_KEY}${NC}"
echo ""
echo -e "  ${BOLD}JWT_SECRET_KEY:${NC}"
echo -e "  ${GREEN}${JWT_SECRET_KEY}${NC}"
echo ""
echo -e "${CYAN}────────────────────────────────────────────────────────────────────${NC}"
echo ""
echo -e "  密钥已自动保存至 ${BOLD}.env${NC} 文件"
echo -e "  如需手动生成新密钥: ${BOLD}./keygen.sh${NC}"
echo ""
echo -e "${MAGENTA}════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}AccBox 账号管家${NC} - 开源免费"
echo -e "  作者: ${CYAN}Author${NC}"
echo -e "  GitHub: ${CYAN}https://github.com/shleeshlee/AccBox${NC}"
echo ""
echo -e "  ${YELLOW}★ 如果觉得好用，请给项目点个 Star！${NC}"
echo -e "  ${RED}✗ 本项目免费开源，如果你是付费获取的，你被骗了！${NC}"
echo ""
echo -e "${MAGENTA}════════════════════════════════════════════════════════════════════${NC}"
echo ""
