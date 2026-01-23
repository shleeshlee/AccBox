#!/bin/bash

# ==========================================
# AccBox 账号管家 - 安全更新脚本
# 使用此脚本更新，自动备份配置防止丢失
# ==========================================

set -e

echo ""
echo "╔════════════════════════════════════════╗"
echo "║     AccBox 账号管家 - 安全更新         ║"
echo "╚════════════════════════════════════════╝"
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. 获取当前时间戳
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# 2. 备份配置文件
echo -e "${YELLOW}[1/4] 备份配置文件...${NC}"

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

# 5. 重启服务
echo ""
echo -e "${YELLOW}[4/4] 重启服务...${NC}"

docker-compose down
docker-compose up -d --build

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           更新完成！                   ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo "备份文件保存在当前目录，如需恢复可使用："
echo "  cp ${BACKUP_FILE} docker-compose.yml"
echo ""
