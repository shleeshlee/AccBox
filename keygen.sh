#!/bin/bash

# ==========================================
# AccBox 账号管家 - 密钥生成工具
# ==========================================

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${MAGENTA}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${MAGENTA}║  ${BOLD}AccBox 账号管家${NC}${MAGENTA} - 密钥生成工具                            ║${NC}"
echo -e "${MAGENTA}║  ${CYAN}作者: Author${NC}${MAGENTA}                                              ║${NC}"
echo -e "${MAGENTA}║  ${CYAN}GitHub: https://github.com/shleeshlee/AccBox${NC}${MAGENTA}              ║${NC}"
echo -e "${MAGENTA}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# 生成 Fernet 密钥
generate_fernet_key() {
    if command -v python3 &> /dev/null; then
        python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" 2>/dev/null || \
        python3 -c "import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())"
    elif command -v python &> /dev/null; then
        python -c "import base64, os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())"
    elif command -v openssl &> /dev/null; then
        openssl rand -base64 32
    else
        head -c 32 /dev/urandom | base64
    fi
}

# 生成 JWT 密钥
generate_jwt_key() {
    if command -v python3 &> /dev/null; then
        python3 -c "import secrets; print(secrets.token_urlsafe(32))"
    elif command -v python &> /dev/null; then
        python -c "import secrets; print(secrets.token_urlsafe(32))"
    elif command -v openssl &> /dev/null; then
        openssl rand -base64 32 | tr -d '/+=' | head -c 43
    else
        head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 43
    fi
}

APP_KEY=$(generate_fernet_key)
JWT_KEY=$(generate_jwt_key)

echo -e "${YELLOW}${BOLD}新生成的密钥:${NC}"
echo ""
echo -e "${BOLD}APP_MASTER_KEY:${NC}"
echo -e "${GREEN}${APP_KEY}${NC}"
echo ""
echo -e "${BOLD}JWT_SECRET_KEY:${NC}"
echo -e "${GREEN}${JWT_KEY}${NC}"
echo ""
echo -e "${CYAN}────────────────────────────────────────────────────────────────────${NC}"
echo ""
echo -e "将以上密钥复制到 ${BOLD}.env${NC} 文件中即可使用"
echo ""
echo -e "${YELLOW}⚠ 注意: 更换密钥后，旧数据将无法解密！${NC}"
echo -e "   请先导出数据，更换密钥后重新导入。"
echo ""
