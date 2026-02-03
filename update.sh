#!/bin/bash

# ==========================================
# AccBox 账号管家 - 安全更新脚本
# 使用此脚本更新，自动备份配置防止丢失
# ==========================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检测 docker compose 命令（新版Docker用 "docker compose"，旧版用 "docker-compose"）
detect_compose_cmd() {
    if docker compose version &> /dev/null 2>&1; then
        echo "docker compose"
    elif command -v docker-compose &> /dev/null 2>&1; then
        echo "docker-compose"
    else
        echo ""
    fi
}

# 如果是被自己调用的（第二阶段），直接执行重启
if [ "$1" = "--restart-only" ]; then
    echo ""
    echo -e "${YELLOW}[4/4] 重启服务...${NC}"
    
    COMPOSE_CMD=$(detect_compose_cmd)
    if [ -z "$COMPOSE_CMD" ]; then
        echo -e "${RED}  ✗ 未检测到 Docker Compose${NC}"
        exit 1
    fi
    
    $COMPOSE_CMD down
    $COMPOSE_CMD up -d --build
    
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║           更新完成！                   ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
    echo ""
    exit 0
fi

# ========== 第一阶段：备份和拉取 ==========

echo ""
echo "╔════════════════════════════════════════╗"
echo "║     AccBox 账号管家 - 安全更新         ║"
echo "╚════════════════════════════════════════╝"
echo ""

# 忽略文件权限变化
git config core.fileMode false

# 1. 获取当前时间戳
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# 2. 备份配置文件
echo -e "${YELLOW}[1/4] 备份配置文件...${NC}"

BACKUP_FILE=""
if [ -f "docker-compose.yml" ]; then
    BACKUP_FILE="docker-compose.yml.bak.${TIMESTAMP}"
    cp docker-compose.yml "$BACKUP_FILE"
    echo -e "${GREEN}  ✓ 已备份: ${BACKUP_FILE}${NC}"
fi

if [ -f ".env" ]; then
    ENV_BACKUP=".env.bak.${TIMESTAMP}"
    cp .env "$ENV_BACKUP"
    echo -e "${GREEN}  ✓ 已备份: ${ENV_BACKUP}${NC}"
fi

# 3. 拉取最新代码
echo ""
echo -e "${YELLOW}[2/4] 拉取最新代码...${NC}"

if git pull; then
    echo -e "${GREEN}  ✓ 代码更新成功${NC}"
else
    echo -e "${RED}  ✗ Git 拉取失败！${NC}"
    echo ""
    echo "可能原因："
    echo "  1. 本地有未提交的修改"
    echo "  2. 网络连接问题"
    echo ""
    echo "您的配置已备份，可以尝试："
    echo "  git stash && git pull && git stash pop"
    echo ""
    exit 1
fi

# 4. 检查 .env 文件
echo ""
echo -e "${YELLOW}[3/4] 检查配置...${NC}"

if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        echo -e "${YELLOW}  ! 未找到 .env 文件，正在从模板创建...${NC}"
        cp .env.example .env
        echo -e "${GREEN}  ✓ 已创建 .env 文件，请编辑填入您的密钥${NC}"
        echo -e "${YELLOW}  ! 提示: 如果之前使用的是自动生成的密钥，无需修改${NC}"
    fi
else
    echo -e "${GREEN}  ✓ .env 配置文件存在${NC}"
fi

# 5. 用新版脚本执行重启（关键：git pull后脚本已更新，重新执行确保用新版）
exec bash "./update.sh" --restart-only
