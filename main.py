#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通用账号管家 - 后端API v5.1.4
=====================================
v5.1.4 更新:
- 🕐 时区统一: 所有时间处理统一使用 UTC
- 🔧 正则优化: 去除重复模式，优先识别服务来源
- 🌍 跨时区支持: 确保不同时区用户正常使用

历史更新:
- 🔐 密码哈希: SHA256 → bcrypt (自动迁移旧密码)
- 🎫 Token: 随机字符串 → JWT (7天过期，兼容旧Token)
- 🌐 CORS: * → 白名单
- 🔑 密码强度: 8字符+字母+数字
- 🛡️ URL验证: 防止 javascript: XSS
- 📦 备份功能
- 📬 邮箱验证码授权 (OAuth + IMAP)
- ⚙️ 前端OAuth配置支持
"""

import sys

# ==================== v5.1 依赖检测 ====================
def check_dependencies():
    """检查 v5.1 新增的依赖是否已安装"""
    missing = []
    
    try:
        from passlib.context import CryptContext
    except ImportError:
        missing.append("passlib[bcrypt]")
    
    try:
        from jose import jwt
    except ImportError:
        missing.append("python-jose[cryptography]")
    
    if missing:
        print("\n" + "=" * 60)
        print("🚨 AccBox v5.1 需要安装新的依赖！")
        print("=" * 60)
        print(f"\n缺少的依赖: {', '.join(missing)}")
        print("\n请运行以下命令安装:")
        print("-" * 60)
        print(f"  pip install {' '.join(missing)}")
        print("-" * 60)
        print("\n或者一次性安装所有依赖:")
        print("-" * 60)
        print("  pip install -r requirements.txt")
        print("-" * 60)
        print("\n安装完成后重新启动即可。\n")
        sys.exit(1)

check_dependencies()

import os
import json
import sqlite3
import hashlib  # 保留用于兼容旧密码
import secrets
import base64
import time
import re
import shutil
import hmac
import struct
import urllib.parse
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from pathlib import Path
import threading
from fastapi import FastAPI, HTTPException, Depends, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from cryptography.fernet import Fernet
import uvicorn

# ==================== 新增安全依赖 (已通过检测) ====================
from passlib.context import CryptContext
from jose import jwt, JWTError

# ==================== 配置 ====================
# 公开的默认不安全密钥（32个0的base64编码）
# 使用此密钥时系统会显示安全警告
UNSAFE_DEFAULT_KEY = "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA="
DATA_DIR = os.environ.get("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(DATA_DIR, "accounts.db")
ENCRYPTION_KEY_FILE = os.path.join(DATA_DIR, ".encryption_key")
# 备份目录优先读取环境变量，这样可以通过 docker-compose.yml 配置到不同位置
DEFAULT_BACKUP_DIR = os.environ.get("BACKUP_PATH", os.path.join(DATA_DIR, "backups"))
BACKUP_SETTINGS_FILE = os.path.join(DATA_DIR, ".backup_settings.json")

# 定时备份全局变量
auto_backup_timer = None
auto_backup_settings = {
    "enabled": False,
    "interval_hours": 24,
    "keep_count": 10,
    "backup_dir": None,
    "last_backup": None
}

# 登录失败限制
MAX_LOGIN_ATTEMPTS = 5
LOCKOUT_MINUTES = 15

# JWT 配置
JWT_SECRET_KEY = os.environ.get("JWT_SECRET_KEY", "")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 24 * 7  # 7天

# 密码哈希配置 (bcrypt)
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# CORS 白名单
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "").split(",") if os.environ.get("ALLOWED_ORIGINS") else [
    "http://localhost",
    "http://localhost:9111",
    "http://127.0.0.1:9111",
    "http://localhost:80",
    "http://127.0.0.1:80",
]
ALLOWED_ORIGINS = [origin.strip() for origin in ALLOWED_ORIGINS if origin.strip()]

app = FastAPI(title="通用账号管家 API v5.1")

# ==================== 安全中间件 ====================
@app.middleware("http")
async def security_middleware(request: Request, call_next):
    """阻止直接访问敏感文件（不影响 API）"""
    path = request.url.path.lower()
    
    # API 请求放行
    if path.startswith("/api/"):
        return await call_next(request)
    
    # 阻止直接访问敏感文件
    if (
        path.endswith(".py") or 
        path.endswith(".db") or 
        path.endswith(".key") or 
        "/data/" in path or
        "/backups/" in path or
        "/." in path
    ):
        return JSONResponse(status_code=403, content={"detail": "🚫 禁止访问敏感资源"})
    return await call_next(request)

# CORS 配置 (已收紧)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

# ==================== 加密模块 ====================

def get_or_create_encryption_key():
    """获取密钥，必须由用户在 .env 中设置"""
    env_key = os.environ.get("APP_MASTER_KEY", "").strip()
    
    # 环境变量有效（非空且非默认值）
    if env_key and env_key != UNSAFE_DEFAULT_KEY:
        return env_key.encode()
    
    # 使用默认不安全密钥（会触发前端警告）
    print("\n" + "=" * 60)
    print("⚠️  警告：正在使用默认公开密钥！")
    print("⚠️  您的数据处于不安全状态！")
    print("⚠️  请创建 .env 文件并设置 APP_MASTER_KEY")
    print("=" * 60 + "\n")
    return UNSAFE_DEFAULT_KEY.encode()

ENCRYPTION_KEY = get_or_create_encryption_key()
cipher = Fernet(ENCRYPTION_KEY)

def encrypt_password(password: str) -> str:
    if not password:
        return ""
    return cipher.encrypt(password.encode()).decode()

def decrypt_password(encrypted: str) -> str:
    if not encrypted:
        return ""
    try:
        return cipher.decrypt(encrypted.encode()).decode()
    except:
        return encrypted

# ==================== 密码哈希 (bcrypt + 兼容旧SHA256) ====================

def hash_password(password: str) -> str:
    """使用 bcrypt 哈希密码"""
    return pwd_context.hash(password)

def verify_password(plain_password: str, hashed_password: str) -> tuple:
    """
    验证密码，兼容旧 SHA256 格式
    返回: (是否验证成功, 是否需要升级到bcrypt)
    """
    # 尝试旧的 SHA256 验证
    old_hash = hashlib.sha256(plain_password.encode()).hexdigest()
    if hashed_password == old_hash:
        return True, True  # 验证成功，需要升级
    
    # 尝试新的 bcrypt 验证
    try:
        if pwd_context.verify(plain_password, hashed_password):
            return True, False  # 验证成功，无需升级
    except:
        pass
    
    return False, False  # 验证失败

# ==================== JWT Token ====================

def get_jwt_secret():
    """获取 JWT 密钥"""
    if JWT_SECRET_KEY:
        return JWT_SECRET_KEY
    # 从加密密钥派生
    if isinstance(ENCRYPTION_KEY, bytes):
        return ENCRYPTION_KEY[:32].decode('latin-1')
    return ENCRYPTION_KEY[:32]

def create_access_token(user_id: int, username: str) -> str:
    """创建 JWT Token"""
    expire = datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRE_HOURS)
    payload = {
        "sub": username,
        "id": user_id,
        "exp": expire,
        "iat": datetime.now(timezone.utc)
    }
    return jwt.encode(payload, get_jwt_secret(), algorithm=JWT_ALGORITHM)

def verify_jwt_token(token: str) -> dict:
    """验证 JWT Token"""
    try:
        payload = jwt.decode(token, get_jwt_secret(), algorithms=[JWT_ALGORITHM])
        return {"id": payload["id"], "username": payload["sub"]}
    except JWTError:
        return None

# ==================== 密码强度验证 ====================

def validate_password_strength(password: str) -> tuple:
    """验证密码强度，返回 (是否通过, 错误信息)"""
    if len(password) < 8:
        return False, "密码至少需要 8 个字符"
    if not re.search(r"[a-zA-Z]", password):
        return False, "密码必须包含至少一个字母"
    if not re.search(r"\d", password):
        return False, "密码必须包含至少一个数字"
    return True, ""

# ==================== URL 协议验证 ====================

def validate_url_protocol(url: str) -> bool:
    """验证 URL 是否使用安全协议"""
    if not url:
        return True
    url_lower = url.lower().strip()
    return url_lower.startswith("http://") or url_lower.startswith("https://")

# ==================== 数据模型 ====================

class UserRegister(BaseModel):
    username: str
    password: str

class UserLogin(BaseModel):
    username: str
    password: str

class ChangePassword(BaseModel):
    old_password: str
    new_password: str

class UpdateAvatar(BaseModel):
    avatar: str

class AccountCreate(BaseModel):
    type_id: int
    email: str
    password: str = ""
    country: str = "🌍"
    customName: str = ""
    properties: Dict[int, int] = {}
    combos: List[List[int]] = []
    tags: List[str] = []
    notes: str = ""

class AccountUpdate(BaseModel):
    type_id: Optional[int] = None
    email: Optional[str] = None
    password: Optional[str] = None
    country: Optional[str] = None
    customName: Optional[str] = None
    properties: Optional[Dict[int, int]] = None
    combos: Optional[List[List[int]]] = None
    tags: Optional[List[str]] = None
    notes: Optional[str] = None
    is_favorite: Optional[bool] = None
    timers: Optional[List[Dict[str, Any]]] = None

class AccountTypeCreate(BaseModel):
    name: str
    icon: str
    color: str = "#8b5cf6"
    login_url: str = ""

class AccountTypeUpdate(BaseModel):
    name: Optional[str] = None
    icon: Optional[str] = None
    color: Optional[str] = None
    login_url: Optional[str] = None

class PropertyGroupCreate(BaseModel):
    name: str

class PropertyGroupUpdate(BaseModel):
    name: Optional[str] = None

class PropertyValueCreate(BaseModel):
    group_id: int
    name: str
    color: str = "#8b5cf6"

class PropertyValueUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    hidden: Optional[int] = None  # 0=显示, 1=隐藏

class BackupConfig(BaseModel):
    backup_dir: Optional[str] = None
    include_key: bool = False
    auto: bool = False  # 是否是自动备份
    keep_count: int = 10  # 自动备份保留数量

class BackupSettings(BaseModel):
    interval_hours: int = 0  # 备份间隔（小时）
    keep_count: int = 10  # 保留数量

class TOTPCreate(BaseModel):
    secret: str
    issuer: str = ""
    totp_type: str = "totp"
    algorithm: str = "SHA1"
    digits: int = 6
    period: int = 30
    backup_codes: List[str] = []

# ==================== 数据库 ====================

@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                token TEXT,
                avatar TEXT DEFAULT '👤',
                login_attempts INTEGER DEFAULT 0,
                locked_until TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        try:
            conn.execute("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT '👤'")
        except:
            pass
        
        # OAuth配置表（全局，非用户级）
        conn.execute("""
            CREATE TABLE IF NOT EXISTS oauth_configs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider TEXT NOT NULL UNIQUE,
                client_id TEXT NOT NULL,
                client_secret TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        conn.commit()

def init_user_tables(user_id: int):
    with get_db() as conn:
        # 账号类型表
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS user_{user_id}_account_types (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                icon TEXT DEFAULT '🔑',
                color TEXT DEFAULT '#8b5cf6',
                login_url TEXT DEFAULT '',
                sort_order INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # 属性组表
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS user_{user_id}_property_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # 属性值表
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS user_{user_id}_property_values (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                color TEXT DEFAULT '#8b5cf6',
                sort_order INTEGER DEFAULT 0,
                hidden INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (group_id) REFERENCES user_{user_id}_property_groups(id) ON DELETE CASCADE
            )
        """)
        
        # 账号表
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS user_{user_id}_accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type_id INTEGER,
                email TEXT NOT NULL,
                password TEXT DEFAULT '',
                country TEXT DEFAULT '🌍',
                custom_name TEXT DEFAULT '',
                properties TEXT DEFAULT '{{}}',
                combos TEXT DEFAULT '[]',
                tags TEXT DEFAULT '[]',
                notes TEXT DEFAULT '',
                is_favorite INTEGER DEFAULT 0,
                last_used TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                totp_secret TEXT DEFAULT '',
                totp_issuer TEXT DEFAULT '',
                totp_type TEXT DEFAULT '',
                totp_algorithm TEXT DEFAULT 'SHA1',
                totp_digits INTEGER DEFAULT 6,
                totp_period INTEGER DEFAULT 30,
                backup_codes TEXT DEFAULT '[]',
                time_offset INTEGER DEFAULT 0,
                timers TEXT
            )
        """)

        # 邮箱授权表
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS user_{user_id}_emails (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                address TEXT NOT NULL UNIQUE,
                provider TEXT DEFAULT 'imap',
                status TEXT DEFAULT 'active',
                credentials TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # 待授权邮箱表（从账号辅助邮箱收集）
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS user_{user_id}_pending_emails (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # 验证码表
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS user_{user_id}_verification_codes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL,
                service TEXT DEFAULT '',
                code TEXT NOT NULL,
                account_name TEXT DEFAULT '',
                is_read INTEGER DEFAULT 0,
                expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                source_msg_id TEXT DEFAULT ''
            )
        """)
        try:
            conn.execute(f"ALTER TABLE user_{user_id}_verification_codes ADD COLUMN source_msg_id TEXT DEFAULT ''")
        except:
            pass
        
        # 初始化默认数据
        cursor = conn.execute(f"SELECT COUNT(*) FROM user_{user_id}_account_types")
        if cursor.fetchone()[0] == 0:
            default_types = [
                ('Google', 'G', '#4285f4', 'https://accounts.google.com/signin/v2/identifier?Email='),
                ('Microsoft', 'M', '#00a4ef', 'https://login.live.com/'),
                ('Discord', 'D', '#5865F2', 'https://discord.com/login'),
                ('Steam', '🎮', '#1b2838', 'https://store.steampowered.com/login/'),
                ('EA/FIFA', 'EA', '#ff4747', 'https://www.ea.com/login'),
            ]
            for i, (name, icon, color, url) in enumerate(default_types):
                conn.execute(f"""
                    INSERT INTO user_{user_id}_account_types (name, icon, color, login_url, sort_order)
                    VALUES (?, ?, ?, ?, ?)
                """, (name, icon, color, url, i))
            
            # 默认属性组
            conn.execute(f"INSERT INTO user_{user_id}_property_groups (name, sort_order) VALUES ('账号状态', 0)")
            status_group_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            for i, (name, color) in enumerate([('正常', '#4ade80'), ('受限', '#facc15'), ('不可用', '#f87171')]):
                conn.execute(f"INSERT INTO user_{user_id}_property_values (group_id, name, color, sort_order) VALUES (?, ?, ?, ?)",
                    (status_group_id, name, color, i))
            
            conn.execute(f"INSERT INTO user_{user_id}_property_groups (name, sort_order) VALUES ('服务类型', 1)")
            service_group_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            for i, (name, color) in enumerate([('CLI', '#a78bfa'), ('Antigravity', '#60a5fa'), ('GCP', '#fb923c'), ('APIKey', '#4ade80'), ('Build', '#22d3ee')]):
                conn.execute(f"INSERT INTO user_{user_id}_property_values (group_id, name, color, sort_order) VALUES (?, ?, ?, ?)",
                    (service_group_id, name, color, i))
        
        conn.commit()

def migrate_add_combos_column():
    """迁移：添加 combos 列"""
    with get_db() as conn:
        cursor = conn.execute("SELECT id FROM users")
        for user in cursor.fetchall():
            user_id = user["id"]
            try:
                conn.execute(f"SELECT combos FROM user_{user_id}_accounts LIMIT 1")
            except sqlite3.OperationalError:
                try:
                    conn.execute(f"ALTER TABLE user_{user_id}_accounts ADD COLUMN combos TEXT DEFAULT '[]'")
                    conn.commit()
                except:
                    pass

def migrate_add_2fa_columns():
    """迁移：添加 2FA 字段"""
    with get_db() as conn:
        users = conn.execute("SELECT id FROM users").fetchall()
        for user in users:
            user_id = user['id']
            table = f"user_{user_id}_accounts"
            for col, typ in [
                ("totp_secret", "TEXT DEFAULT ''"),
                ("totp_issuer", "TEXT DEFAULT ''"),
                ("totp_type", "TEXT DEFAULT ''"),
                ("totp_algorithm", "TEXT DEFAULT 'SHA1'"),
                ("totp_digits", "INTEGER DEFAULT 6"),
                ("totp_period", "INTEGER DEFAULT 30"),
                ("backup_codes", "TEXT DEFAULT '[]'"),
                ("time_offset", "INTEGER DEFAULT 0")
            ]:
                try:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")
                except:
                    pass
        conn.commit()

# ==================== 工具函数 ====================

def migrate_add_hidden_column():
    """迁移：为属性值表添加 hidden 字段"""
    with get_db() as conn:
        cursor = conn.execute("SELECT id FROM users")
        for user in cursor.fetchall():
            user_id = user["id"]
            try:
                conn.execute(f"SELECT hidden FROM user_{user_id}_property_values LIMIT 1")
            except sqlite3.OperationalError:
                try:
                    conn.execute(f"ALTER TABLE user_{user_id}_property_values ADD COLUMN hidden INTEGER DEFAULT 0")
                    conn.commit()
                except:
                    pass

def migrate_add_timers_column():
    """迁移：为账号表添加 timers 列"""
    with get_db() as conn:
        cursor = conn.execute("SELECT id FROM users")
        for user in cursor.fetchall():
            user_id = user["id"]
            try:
                conn.execute(f"SELECT timers FROM user_{user_id}_accounts LIMIT 1")
            except sqlite3.OperationalError:
                try:
                    conn.execute(f"ALTER TABLE user_{user_id}_accounts ADD COLUMN timers TEXT")
                    conn.commit()
                except:
                    pass

def generate_token() -> str:
    return secrets.token_hex(32)

def get_current_user(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未授权")
    token = authorization.replace("Bearer ", "")
    
    # 先尝试 JWT 验证
    jwt_user = verify_jwt_token(token)
    if jwt_user:
        return jwt_user
    
    # 回退到数据库 Token (兼容旧版)
    with get_db() as conn:
        cursor = conn.execute("SELECT id, username FROM users WHERE token = ?", (token,))
        user = cursor.fetchone()
    if not user:
        raise HTTPException(status_code=401, detail="无效令牌或已过期")
    return {"id": user["id"], "username": user["username"]}

# ==================== 用户 API ====================

@app.post("/api/register")
def register(data: UserRegister):
    if len(data.username) < 2:
        raise HTTPException(status_code=400, detail="用户名至少2个字符")
    
    # 密码强度验证
    is_valid, error_msg = validate_password_strength(data.password)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error_msg)
    
    password_hash = hash_password(data.password)
    
    with get_db() as conn:
        try:
            cursor = conn.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                (data.username, password_hash)
            )
            user_id = cursor.lastrowid
            conn.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=400, detail="用户名已存在")
    
    init_user_tables(user_id)
    token = create_access_token(user_id, data.username)
    
    return {"message": "注册成功", "token": token, "user": {"id": user_id, "username": data.username, "avatar": "👤"}}

@app.post("/api/login")
def login(data: UserLogin):
    with get_db() as conn:
        cursor = conn.execute(
            "SELECT id, username, password_hash, avatar, login_attempts, locked_until FROM users WHERE username = ?",
            (data.username,)
        )
        user = cursor.fetchone()
        
        if not user:
            raise HTTPException(status_code=401, detail="用户名或密码错误")
        
        # 检查锁定
        if user["locked_until"]:
            locked_until = datetime.fromisoformat(user["locked_until"].replace('Z', '+00:00'))
            if locked_until.tzinfo is None:
                locked_until = locked_until.replace(tzinfo=timezone.utc)
            now_utc = datetime.now(timezone.utc)
            if now_utc < locked_until:
                remaining = int((locked_until - now_utc).total_seconds()) // 60 + 1
                raise HTTPException(status_code=423, detail=f"账号已锁定，请 {remaining} 分钟后重试")
            else:
                conn.execute("UPDATE users SET login_attempts = 0, locked_until = NULL WHERE username = ?", (data.username,))
        
        # 验证密码 (兼容旧SHA256)
        auth_success, need_upgrade = verify_password(data.password, user["password_hash"])
        
        if not auth_success:
            conn.execute("UPDATE users SET login_attempts = login_attempts + 1 WHERE username = ?", (data.username,))
            cursor2 = conn.execute("SELECT login_attempts FROM users WHERE username = ?", (data.username,))
            attempts = cursor2.fetchone()["login_attempts"]
            
            if attempts >= MAX_LOGIN_ATTEMPTS:
                locked_until = (datetime.now(timezone.utc) + timedelta(minutes=LOCKOUT_MINUTES)).strftime('%Y-%m-%dT%H:%M:%SZ')
                conn.execute("UPDATE users SET locked_until = ? WHERE username = ?", (locked_until, data.username))
                conn.commit()
                raise HTTPException(status_code=423, detail=f"账号已锁定，请 {LOCKOUT_MINUTES} 分钟后重试")
            
            conn.commit()
            raise HTTPException(status_code=401, detail=f"密码错误，还剩 {MAX_LOGIN_ATTEMPTS - attempts} 次尝试")
        
        # 登录成功，重置计数
        conn.execute("UPDATE users SET login_attempts = 0, locked_until = NULL WHERE username = ?", (data.username,))
        
        # 自动升级旧密码到 bcrypt
        if need_upgrade:
            new_hash = hash_password(data.password)
            conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (new_hash, user["id"]))
            print(f"✅ 用户 {data.username} 的密码已自动升级为 bcrypt")
        
        conn.commit()
    
    init_user_tables(user["id"])
    token = create_access_token(user["id"], user["username"])
    
    return {
        "message": "登录成功",
        "token": token,
        "user": {"id": user["id"], "username": user["username"], "avatar": user["avatar"] or "👤"}
    }

@app.post("/api/update-avatar")
def update_avatar(data: UpdateAvatar, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        conn.execute("UPDATE users SET avatar = ? WHERE id = ?", (data.avatar, user["id"]))
        conn.commit()
    return {"message": "头像更新成功", "avatar": data.avatar}

@app.post("/api/change-password")
def change_password(data: ChangePassword, user: dict = Depends(get_current_user)):
    # 密码强度验证
    is_valid, error_msg = validate_password_strength(data.new_password)
    if not is_valid:
        raise HTTPException(status_code=400, detail=error_msg)
    
    with get_db() as conn:
        cursor = conn.execute("SELECT password_hash FROM users WHERE id = ?", (user["id"],))
        row = cursor.fetchone()
        
        auth_success, _ = verify_password(data.old_password, row["password_hash"])
        if not auth_success:
            raise HTTPException(status_code=400, detail="当前密码错误")
        
        new_hash = hash_password(data.new_password)
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (new_hash, user["id"]))
        conn.commit()
    
    return {"message": "密码修改成功"}

# ==================== 账号类型 API ====================

@app.get("/api/account-types")
def get_account_types(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        cursor = conn.execute(f"SELECT * FROM user_{user['id']}_account_types ORDER BY sort_order, id")
        rows = cursor.fetchall()
    return {"types": [dict(row) for row in rows]}

@app.post("/api/account-types")
def create_account_type(data: AccountTypeCreate, user: dict = Depends(get_current_user)):
    # URL 协议验证
    if data.login_url and not validate_url_protocol(data.login_url):
        raise HTTPException(status_code=400, detail="登录URL必须以 http:// 或 https:// 开头")
    
    with get_db() as conn:
        cursor = conn.execute(f"""
            INSERT INTO user_{user['id']}_account_types (name, icon, color, login_url)
            VALUES (?, ?, ?, ?)
        """, (data.name, data.icon, data.color, data.login_url))
        conn.commit()
        return {"message": "创建成功", "id": cursor.lastrowid}

@app.put("/api/account-types/{type_id}")
def update_account_type(type_id: int, data: AccountTypeUpdate, user: dict = Depends(get_current_user)):
    # URL 协议验证
    if data.login_url is not None and data.login_url and not validate_url_protocol(data.login_url):
        raise HTTPException(status_code=400, detail="登录URL必须以 http:// 或 https:// 开头")
    
    updates, values = [], []
    if data.name is not None:
        updates.append("name = ?")
        values.append(data.name)
    if data.icon is not None:
        updates.append("icon = ?")
        values.append(data.icon)
    if data.color is not None:
        updates.append("color = ?")
        values.append(data.color)
    if data.login_url is not None:
        updates.append("login_url = ?")
        values.append(data.login_url)
    if not updates:
        raise HTTPException(status_code=400, detail="没有要更新的字段")
    values.append(type_id)
    with get_db() as conn:
        conn.execute(f"UPDATE user_{user['id']}_account_types SET {', '.join(updates)} WHERE id = ?", values)
        conn.commit()
    return {"message": "更新成功"}

@app.delete("/api/account-types/{type_id}")
def delete_account_type(type_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        conn.execute(f"UPDATE user_{user['id']}_accounts SET type_id = NULL WHERE type_id = ?", (type_id,))
        conn.execute(f"DELETE FROM user_{user['id']}_account_types WHERE id = ?", (type_id,))
        conn.commit()
    return {"message": "删除成功"}

# ==================== 属性组 API ====================

@app.get("/api/property-groups")
def get_property_groups(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        groups = []
        cursor = conn.execute(f"SELECT * FROM user_{user['id']}_property_groups ORDER BY sort_order, id")
        for row in cursor.fetchall():
            group = dict(row)
            values_cursor = conn.execute(f"SELECT * FROM user_{user['id']}_property_values WHERE group_id = ? ORDER BY sort_order, id", (group['id'],))
            group['values'] = [dict(v) for v in values_cursor.fetchall()]
            groups.append(group)
    return {"groups": groups}

@app.post("/api/property-groups")
def create_property_group(data: PropertyGroupCreate, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        cursor = conn.execute(f"INSERT INTO user_{user['id']}_property_groups (name) VALUES (?)", (data.name,))
        conn.commit()
        return {"message": "创建成功", "id": cursor.lastrowid}

@app.put("/api/property-groups/{group_id}")
def update_property_group(group_id: int, data: PropertyGroupUpdate, user: dict = Depends(get_current_user)):
    if data.name is None:
        raise HTTPException(status_code=400, detail="没有要更新的字段")
    with get_db() as conn:
        conn.execute(f"UPDATE user_{user['id']}_property_groups SET name = ? WHERE id = ?", (data.name, group_id))
        conn.commit()
    return {"message": "更新成功"}

@app.delete("/api/property-groups/{group_id}")
def delete_property_group(group_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        # 先获取该属性组下所有属性值的ID
        cursor = conn.execute(f"SELECT id FROM user_{user['id']}_property_values WHERE group_id = ?", (group_id,))
        value_ids = [row['id'] for row in cursor.fetchall()]
        
        # 删除属性组（会级联删除属性值）
        conn.execute(f"DELETE FROM user_{user['id']}_property_groups WHERE id = ?", (group_id,))
        
        # 清理账号中引用这些属性值的combo
        if value_ids:
            cursor = conn.execute(f"SELECT id, combos FROM user_{user['id']}_accounts")
            for row in cursor.fetchall():
                try:
                    combos = json.loads(row['combos'] or '[]')
                    # 过滤掉包含已删除属性值的ID
                    new_combos = []
                    for combo in combos:
                        if isinstance(combo, list):
                            filtered = [vid for vid in combo if vid not in value_ids]
                            if filtered:  # 只保留非空的combo
                                new_combos.append(filtered)
                    conn.execute(f"UPDATE user_{user['id']}_accounts SET combos = ? WHERE id = ?",
                                (json.dumps(new_combos), row['id']))
                except:
                    pass
        
        conn.commit()
    return {"message": "删除成功"}

# 属性组重排序API
class PropertyGroupReorder(BaseModel):
    order: list  # [{"id": 1, "sort_order": 0}, {"id": 2, "sort_order": 1}, ...]

@app.post("/api/property-groups/reorder")
def reorder_property_groups(data: PropertyGroupReorder, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        for item in data.order:
            conn.execute(
                f"UPDATE user_{user['id']}_property_groups SET sort_order = ? WHERE id = ?",
                (item['sort_order'], item['id'])
            )
        conn.commit()
    return {"message": "排序已更新"}

# ==================== 属性值 API ====================

@app.post("/api/property-values")
def create_property_value(data: PropertyValueCreate, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        cursor = conn.execute(f"INSERT INTO user_{user['id']}_property_values (group_id, name, color) VALUES (?, ?, ?)",
            (data.group_id, data.name, data.color))
        conn.commit()
        return {"message": "创建成功", "id": cursor.lastrowid}

@app.put("/api/property-values/{value_id}")
def update_property_value(value_id: int, data: PropertyValueUpdate, user: dict = Depends(get_current_user)):
    updates, values = [], []
    if data.name is not None:
        updates.append("name = ?")
        values.append(data.name)
    if data.color is not None:
        updates.append("color = ?")
        values.append(data.color)
    if data.hidden is not None:
        updates.append("hidden = ?")
        values.append(data.hidden)
    if not updates:
        raise HTTPException(status_code=400, detail="没有要更新的字段")
    values.append(value_id)
    with get_db() as conn:
        conn.execute(f"UPDATE user_{user['id']}_property_values SET {', '.join(updates)} WHERE id = ?", values)
        conn.commit()
    return {"message": "更新成功"}

@app.delete("/api/property-values/{value_id}")
def delete_property_value(value_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        # 删除属性值
        conn.execute(f"DELETE FROM user_{user['id']}_property_values WHERE id = ?", (value_id,))
        
        # 清理账号中引用该属性值的combo
        cursor = conn.execute(f"SELECT id, combos FROM user_{user['id']}_accounts")
        for row in cursor.fetchall():
            try:
                combos = json.loads(row['combos'] or '[]')
                new_combos = []
                for combo in combos:
                    if isinstance(combo, list):
                        filtered = [vid for vid in combo if vid != value_id]
                        if filtered:  # 只保留非空的combo
                            new_combos.append(filtered)
                conn.execute(f"UPDATE user_{user['id']}_accounts SET combos = ? WHERE id = ?",
                            (json.dumps(new_combos), row['id']))
            except:
                pass
        
        conn.commit()
    return {"message": "删除成功"}

# ==================== 清理无效属性 API ====================

@app.post("/api/cleanup-invalid-combos")
def cleanup_invalid_combos(user: dict = Depends(get_current_user)):
    """清理所有账号中引用已删除属性值的combo"""
    with get_db() as conn:
        # 获取所有有效的属性值ID
        cursor = conn.execute(f"SELECT id FROM user_{user['id']}_property_values")
        valid_ids = set(row['id'] for row in cursor.fetchall())
        
        # 遍历所有账号，清理无效引用
        cursor = conn.execute(f"SELECT id, combos FROM user_{user['id']}_accounts")
        cleaned_count = 0
        
        for row in cursor.fetchall():
            try:
                combos = json.loads(row['combos'] or '[]')
                new_combos = []
                changed = False
                
                for combo in combos:
                    if isinstance(combo, list):
                        filtered = [vid for vid in combo if vid in valid_ids]
                        if len(filtered) != len(combo):
                            changed = True
                        if filtered:
                            new_combos.append(filtered)
                        elif combo:  # 原来有内容但被清空了
                            changed = True
                
                if changed:
                    conn.execute(f"UPDATE user_{user['id']}_accounts SET combos = ? WHERE id = ?",
                                (json.dumps(new_combos), row['id']))
                    cleaned_count += 1
            except:
                pass
        
        conn.commit()
    
    return {"message": f"已清理 {cleaned_count} 个账号的无效属性", "cleaned_count": cleaned_count}

# ==================== 账号 API ====================

@app.get("/api/accounts")
def get_accounts(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        cursor = conn.execute(f"""
            SELECT * FROM user_{user['id']}_accounts 
            ORDER BY is_favorite DESC, last_used DESC NULLS LAST, created_at DESC
        """)
        rows = cursor.fetchall()
    
    accounts = []
    for row in rows:
        has_2fa = False
        has_backup_codes = False
        try:
            has_2fa = bool(row["totp_secret"]) if "totp_secret" in row.keys() else False
            if has_2fa and "backup_codes" in row.keys():
                codes = json.loads(row["backup_codes"] or "[]")
                has_backup_codes = len(codes) > 0
        except:
            pass
        accounts.append({
            "id": row["id"],
            "type_id": row["type_id"],
            "email": row["email"],
            "password": decrypt_password(row["password"]),
            "country": row["country"],
            "customName": row["custom_name"] or "",
            "properties": json.loads(row["properties"] or "{}"),
            "combos": json.loads(row["combos"] if "combos" in row.keys() and row["combos"] else "[]"),
            "tags": json.loads(row["tags"] or "[]"),
            "notes": row["notes"] or "",
            "is_favorite": bool(row["is_favorite"]),
            "has_2fa": has_2fa,
            "has_backup_codes": has_backup_codes,
            "last_used": row["last_used"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "timers": json.loads(row["timers"]) if "timers" in row.keys() and row["timers"] else None
        })
    return {"accounts": accounts}

@app.post("/api/accounts")
def create_account(data: AccountCreate, user: dict = Depends(get_current_user)):
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    encrypted_pwd = encrypt_password(data.password) if data.password else ""
    
    with get_db() as conn:
        cursor = conn.execute(f"""
            INSERT INTO user_{user['id']}_accounts 
            (type_id, email, password, country, custom_name, properties, combos, tags, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            data.type_id, data.email, encrypted_pwd, data.country, data.customName,
            json.dumps(data.properties), json.dumps(data.combos),
            json.dumps(data.tags, ensure_ascii=False), data.notes, now, now
        ))
        conn.commit()
    return {"message": "创建成功", "id": cursor.lastrowid}

@app.put("/api/accounts/{account_id}")
def update_account(account_id: int, data: AccountUpdate, user: dict = Depends(get_current_user)):
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    updates, values = [], []
    
    if data.type_id is not None:
        updates.append("type_id = ?")
        values.append(data.type_id)
    if data.email is not None:
        updates.append("email = ?")
        values.append(data.email)
    if data.password is not None:
        updates.append("password = ?")
        values.append(encrypt_password(data.password) if data.password else "")
    if data.country is not None:
        updates.append("country = ?")
        values.append(data.country)
    if data.customName is not None:
        updates.append("custom_name = ?")
        values.append(data.customName)
    if data.properties is not None:
        updates.append("properties = ?")
        values.append(json.dumps(data.properties))
    if data.combos is not None:
        updates.append("combos = ?")
        values.append(json.dumps(data.combos))
    if data.tags is not None:
        updates.append("tags = ?")
        values.append(json.dumps(data.tags, ensure_ascii=False))
    if data.notes is not None:
        updates.append("notes = ?")
        values.append(data.notes)
    if data.is_favorite is not None:
        updates.append("is_favorite = ?")
        values.append(1 if data.is_favorite else 0)
    if data.timers is not None:
        updates.append("timers = ?")
        values.append(json.dumps(data.timers))

    if not updates:
        raise HTTPException(status_code=400, detail="没有要更新的字段")
    
    updates.append("updated_at = ?")
    values.append(now)
    values.append(account_id)
    
    with get_db() as conn:
        cursor = conn.execute(f"UPDATE user_{user['id']}_accounts SET {', '.join(updates)} WHERE id = ?", values)
        conn.commit()
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="账号不存在")
    return {"message": "更新成功"}

@app.post("/api/accounts/{account_id}/use")
def record_account_use(account_id: int, user: dict = Depends(get_current_user)):
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    with get_db() as conn:
        conn.execute(f"UPDATE user_{user['id']}_accounts SET last_used = ? WHERE id = ?", (now, account_id))
        conn.commit()
    return {"message": "已记录"}

@app.post("/api/accounts/{account_id}/favorite")
def toggle_favorite(account_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        cursor = conn.execute(f"SELECT is_favorite FROM user_{user['id']}_accounts WHERE id = ?", (account_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="账号不存在")
        new_value = 0 if row["is_favorite"] else 1
        conn.execute(f"UPDATE user_{user['id']}_accounts SET is_favorite = ? WHERE id = ?", (new_value, account_id))
        conn.commit()
    return {"message": "已更新", "is_favorite": bool(new_value)}

@app.delete("/api/accounts/{account_id}")
def delete_account(account_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        cursor = conn.execute(f"DELETE FROM user_{user['id']}_accounts WHERE id = ?", (account_id,))
        conn.commit()
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="账号不存在")
    return {"message": "删除成功"}

@app.post("/api/accounts/batch-delete")
def batch_delete_accounts(data: dict, user: dict = Depends(get_current_user)):
    ids = data.get("ids", [])
    if not ids:
        raise HTTPException(status_code=400, detail="没有选择账号")
    
    with get_db() as conn:
        placeholders = ",".join("?" * len(ids))
        cursor = conn.execute(f"DELETE FROM user_{user['id']}_accounts WHERE id IN ({placeholders})", ids)
        conn.commit()
    
    return {"message": f"成功删除 {cursor.rowcount} 个账号", "deleted": cursor.rowcount}

# ==================== 计时器 API ====================

def _parse_duration(duration_str: str) -> int:
    """Parse duration string like '5h', '7d', '2h30m', '90m' into seconds."""
    pattern = r'(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?'
    match = re.fullmatch(pattern, duration_str.strip())
    if not match or not any(match.groups()):
        raise HTTPException(status_code=400, detail=f"无效的时间格式: {duration_str}")
    days = int(match.group(1) or 0)
    hours = int(match.group(2) or 0)
    minutes = int(match.group(3) or 0)
    total = days * 86400 + hours * 3600 + minutes * 60
    if total <= 0:
        raise HTTPException(status_code=400, detail="时间必须大于0")
    return total

def _get_account_dict(conn, user_id: int, account_id: int) -> dict:
    """Fetch a single account and return formatted dict."""
    row = conn.execute(
        f"SELECT * FROM user_{user_id}_accounts WHERE id = ?", (account_id,)
    ).fetchone()
    if not row:
        return None
    has_2fa = False
    has_backup_codes = False
    try:
        has_2fa = bool(row["totp_secret"]) if "totp_secret" in row.keys() else False
        if has_2fa and "backup_codes" in row.keys():
            codes = json.loads(row["backup_codes"] or "[]")
            has_backup_codes = len(codes) > 0
    except:
        pass
    return {
        "id": row["id"],
        "type_id": row["type_id"],
        "email": row["email"],
        "password": decrypt_password(row["password"]),
        "country": row["country"],
        "customName": row["custom_name"] or "",
        "properties": json.loads(row["properties"] or "{}"),
        "combos": json.loads(row["combos"] if "combos" in row.keys() and row["combos"] else "[]"),
        "tags": json.loads(row["tags"] or "[]"),
        "notes": row["notes"] or "",
        "is_favorite": bool(row["is_favorite"]),
        "has_2fa": has_2fa,
        "has_backup_codes": has_backup_codes,
        "last_used": row["last_used"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "timers": json.loads(row["timers"]) if "timers" in row.keys() and row["timers"] else None
    }

@app.post("/api/batch-timers")
def batch_add_timers(data: dict, user: dict = Depends(get_current_user)):
    account_ids = data.get("account_ids", [])
    label = data.get("label", "")
    duration = data.get("duration", "")

    if not account_ids:
        raise HTTPException(status_code=400, detail="没有选择账号")
    if not label:
        raise HTTPException(status_code=400, detail="缺少 label")
    if not duration:
        raise HTTPException(status_code=400, detail="缺少 duration")

    duration_seconds = _parse_duration(duration)
    now_ts = int(time.time())
    expires_at = now_ts + duration_seconds
    now_str = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    updated_accounts = []
    with get_db() as conn:
        for aid in account_ids:
            row = conn.execute(
                f"SELECT timers FROM user_{user['id']}_accounts WHERE id = ?", (aid,)
            ).fetchone()
            if not row:
                continue
            existing = json.loads(row["timers"] or "[]") if row["timers"] else []
            existing.append({"label": label, "expires_at": expires_at})
            conn.execute(
                f"UPDATE user_{user['id']}_accounts SET timers = ?, last_used = ?, updated_at = ? WHERE id = ?",
                (json.dumps(existing), now_str, now_str, aid)
            )
        conn.commit()
        for aid in account_ids:
            acct = _get_account_dict(conn, user['id'], aid)
            if acct:
                updated_accounts.append(acct)

    return {"accounts": updated_accounts}

@app.delete("/api/accounts/{account_id}/timer/{timer_index}")
def delete_timer(account_id: int, timer_index: int, user: dict = Depends(get_current_user)):
    now_str = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    with get_db() as conn:
        row = conn.execute(
            f"SELECT timers FROM user_{user['id']}_accounts WHERE id = ?", (account_id,)
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="账号不存在")
        timers = json.loads(row["timers"] or "[]") if row["timers"] else []
        if timer_index < 0 or timer_index >= len(timers):
            raise HTTPException(status_code=400, detail="无效的计时器索引")
        timers.pop(timer_index)
        conn.execute(
            f"UPDATE user_{user['id']}_accounts SET timers = ?, updated_at = ? WHERE id = ?",
            (json.dumps(timers), now_str, account_id)
        )
        conn.commit()
        account = _get_account_dict(conn, user['id'], account_id)

    return {"account": account}

# ==================== 导入导出 API ====================

@app.get("/api/export")
def export_data(include_emails: bool = False, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        types_cursor = conn.execute(f"SELECT * FROM user_{user['id']}_account_types ORDER BY sort_order")
        types = [dict(row) for row in types_cursor.fetchall()]
        
        groups = []
        groups_cursor = conn.execute(f"SELECT * FROM user_{user['id']}_property_groups ORDER BY sort_order")
        for row in groups_cursor.fetchall():
            group = dict(row)
            values_cursor = conn.execute(f"SELECT * FROM user_{user['id']}_property_values WHERE group_id = ? ORDER BY sort_order", (group['id'],))
            group['values'] = [dict(v) for v in values_cursor.fetchall()]
            groups.append(group)
        
        accounts_cursor = conn.execute(f"SELECT * FROM user_{user['id']}_accounts")
        accounts = []
        for row in accounts_cursor.fetchall():
            account_data = {
                "type_id": row["type_id"],
                "email": row["email"],
                "password": decrypt_password(row["password"]),
                "country": row["country"],
                "customName": row["custom_name"] or "",
                "properties": json.loads(row["properties"] or "{}"),
                "combos": json.loads(row["combos"] if "combos" in row.keys() and row["combos"] else "[]"),
                "tags": json.loads(row["tags"] or "[]"),
                "notes": row["notes"] or "",
                "backup_email": row["backup_email"] if "backup_email" in row.keys() else "",
                "is_favorite": bool(row["is_favorite"]),
                "created_at": row["created_at"]
            }
            if "totp_secret" in row.keys() and row["totp_secret"]:
                account_data["totp"] = {
                    "secret": decrypt_password(row["totp_secret"]),
                    "issuer": row["totp_issuer"] or "",
                    "type": row["totp_type"] or "totp",
                    "algorithm": row["totp_algorithm"] or "SHA1",
                    "digits": row["totp_digits"] or 6,
                    "period": row["totp_period"] or 30,
                    "backup_codes": json.loads(row["backup_codes"] or "[]"),
                }
            accounts.append(account_data)
        
        # 导出邮箱相关配置（如果请求）
        oauth_configs = []
        pending_emails = []
        email_addresses = []  # 已授权邮箱地址列表（用于在新环境提示需要重新授权）
        
        if include_emails:
            # 导出 OAuth 应用凭证（Client ID/Secret），而非 access_token
            # 这样更安全：即使文件泄露，攻击者也无法直接访问邮箱
            try:
                oauth_cursor = conn.execute("SELECT provider, client_id, client_secret FROM oauth_configs")
                for row in oauth_cursor.fetchall():
                    oauth_configs.append({
                        "provider": row["provider"],
                        "client_id": row["client_id"],
                        "client_secret": decrypt_password(row["client_secret"])
                    })
            except:
                pass
            
            # 获取已授权邮箱地址（仅地址，不含token，用于提示用户重新授权）
            try:
                emails_cursor = conn.execute(f"SELECT address, provider FROM user_{user['id']}_emails WHERE status = 'active'")
                for row in emails_cursor.fetchall():
                    email_addresses.append({
                        "address": row["address"],
                        "provider": row["provider"]
                    })
            except:
                pass
            
            # 获取待授权邮箱
            try:
                pending_cursor = conn.execute(f"SELECT email FROM user_{user['id']}_pending_emails")
                pending_emails = [row["email"] for row in pending_cursor.fetchall()]
            except:
                pass
    
    result = {
        "version": "5.1.4",
        "exported_at": datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        "user": user["username"],
        "account_types": types,
        "property_groups": groups,
        "accounts": accounts
    }
    
    if include_emails:
        result["oauth_configs"] = oauth_configs  # OAuth应用凭证
        result["email_addresses"] = email_addresses  # 已授权邮箱地址（需重新授权）
        result["pending_emails"] = pending_emails  # 待授权邮箱
    
    return result

@app.post("/api/import")
def import_data(data: dict, user: dict = Depends(get_current_user)):
    if "accounts" not in data:
        raise HTTPException(status_code=400, detail="无效的导入数据")
    
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    import_mode = data.get("import_mode", "all")
    
    imported_accounts = 0
    updated_accounts = 0
    skipped_accounts = 0
    imported_types = 0
    imported_groups = 0
    imported_values = 0
    
    type_id_map = {}
    value_id_map = {}
    
    with get_db() as conn:
        # 导入账号类型
        if "account_types" in data:
            existing_types = {}
            cursor = conn.execute(f"SELECT id, name FROM user_{user['id']}_account_types")
            for row in cursor.fetchall():
                existing_types[row["name"].lower()] = row["id"]
            
            for old_type in data["account_types"]:
                old_id = old_type.get("id")
                name = old_type.get("name", "")
                name_lower = name.lower()
                
                if name_lower in existing_types:
                    type_id_map[old_id] = existing_types[name_lower]
                else:
                    cursor = conn.execute(f"""
                        INSERT INTO user_{user['id']}_account_types (name, icon, color, login_url, sort_order)
                        VALUES (?, ?, ?, ?, ?)
                    """, (name, old_type.get("icon", "🔑"), old_type.get("color", "#8b5cf6"),
                          old_type.get("login_url", ""), old_type.get("sort_order", 0)))
                    new_id = cursor.lastrowid
                    type_id_map[old_id] = new_id
                    existing_types[name_lower] = new_id
                    imported_types += 1
        
        # 导入属性组和值
        if "property_groups" in data:
            existing_groups = {}
            cursor = conn.execute(f"SELECT id, name FROM user_{user['id']}_property_groups")
            for row in cursor.fetchall():
                existing_groups[row["name"].lower()] = row["id"]
            
            for old_group in data["property_groups"]:
                old_group_id = old_group.get("id")
                group_name = old_group.get("name", "")
                group_name_lower = group_name.lower()
                
                if group_name_lower in existing_groups:
                    new_group_id = existing_groups[group_name_lower]
                else:
                    cursor = conn.execute(f"INSERT INTO user_{user['id']}_property_groups (name, sort_order) VALUES (?, ?)",
                        (group_name, old_group.get("sort_order", 0)))
                    new_group_id = cursor.lastrowid
                    existing_groups[group_name_lower] = new_group_id
                    imported_groups += 1
                
                if "values" in old_group:
                    existing_values = {}
                    cursor = conn.execute(f"SELECT id, name FROM user_{user['id']}_property_values WHERE group_id = ?", (new_group_id,))
                    for row in cursor.fetchall():
                        existing_values[row["name"].lower()] = row["id"]
                    
                    for old_value in old_group["values"]:
                        old_value_id = old_value.get("id")
                        value_name = old_value.get("name", "")
                        value_name_lower = value_name.lower()
                        
                        if value_name_lower in existing_values:
                            value_id_map[old_value_id] = existing_values[value_name_lower]
                        else:
                            cursor = conn.execute(f"""
                                INSERT INTO user_{user['id']}_property_values (group_id, name, color, sort_order)
                                VALUES (?, ?, ?, ?)
                            """, (new_group_id, value_name, old_value.get("color", "#8b5cf6"), old_value.get("sort_order", 0)))
                            value_id_map[old_value_id] = cursor.lastrowid
                            imported_values += 1
        
        # 导入账号
        for acc in data["accounts"]:
            email = acc.get("email", "")
            
            cursor = conn.execute(f"SELECT id FROM user_{user['id']}_accounts WHERE email = ?", (email,))
            existing = cursor.fetchone()
            
            if existing:
                if import_mode == "skip":
                    skipped_accounts += 1
                    continue
                elif import_mode == "overwrite":
                    new_type_id = type_id_map.get(acc.get("type_id")) if acc.get("type_id") else None
                    new_combos = []
                    for combo in acc.get("combos", []):
                        new_combo = [value_id_map.get(v, v) for v in combo]
                        new_combos.append(new_combo)
                    
                    conn.execute(f"""
                        UPDATE user_{user['id']}_accounts SET
                        type_id=?, password=?, country=?, custom_name=?, properties=?, combos=?, tags=?, notes=?, is_favorite=?, updated_at=?
                        WHERE id=?
                    """, (
                        new_type_id, encrypt_password(acc.get("password", "")),
                        acc.get("country", "🌍"), acc.get("customName", ""),
                        json.dumps(acc.get("properties", {})), json.dumps(new_combos),
                        json.dumps(acc.get("tags", []), ensure_ascii=False),
                        acc.get("notes", ""), 1 if acc.get("is_favorite") else 0, now, existing["id"]
                    ))
                    updated_accounts += 1
                    continue
            
            new_type_id = type_id_map.get(acc.get("type_id")) if acc.get("type_id") else None
            new_combos = []
            for combo in acc.get("combos", []):
                new_combo = [value_id_map.get(v, v) for v in combo]
                new_combos.append(new_combo)
            
            cursor = conn.execute(f"""
                INSERT INTO user_{user['id']}_accounts 
                (type_id, email, password, country, custom_name, properties, combos, tags, notes, is_favorite, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                new_type_id, email, encrypt_password(acc.get("password", "")),
                acc.get("country", "🌍"), acc.get("customName", ""),
                json.dumps(acc.get("properties", {})), json.dumps(new_combos),
                json.dumps(acc.get("tags", []), ensure_ascii=False),
                acc.get("notes", ""), 1 if acc.get("is_favorite") else 0,
                acc.get("created_at", now), now  # 保留原始创建时间
            ))
            
            if "totp" in acc and acc["totp"].get("secret"):
                totp = acc["totp"]
                conn.execute(f"""
                    UPDATE user_{user['id']}_accounts SET
                    totp_secret=?, totp_issuer=?, totp_type=?, totp_algorithm=?, totp_digits=?, totp_period=?, backup_codes=?
                    WHERE id=?
                """, (
                    encrypt_password(totp["secret"]), totp.get("issuer", ""),
                    totp.get("type", "totp"), totp.get("algorithm", "SHA1"),
                    totp.get("digits", 6), totp.get("period", 30),
                    json.dumps(totp.get("backup_codes", [])), cursor.lastrowid
                ))
            
            imported_accounts += 1
        
        # 导入 OAuth 应用凭证（Client ID/Secret）
        imported_oauth = 0
        if "oauth_configs" in data and data["oauth_configs"]:
            for config in data["oauth_configs"]:
                provider = config.get("provider")
                client_id = config.get("client_id")
                client_secret = config.get("client_secret")
                
                if not provider or not client_id or not client_secret:
                    continue
                
                try:
                    encrypted_secret = encrypt_password(client_secret)
                    conn.execute("""
                        INSERT OR REPLACE INTO oauth_configs (provider, client_id, client_secret)
                        VALUES (?, ?, ?)
                    """, (provider, client_id, encrypted_secret))
                    imported_oauth += 1
                except Exception as e:
                    print(f"导入OAuth凭证 {provider} 失败: {e}")
        
        # 导入待授权邮箱（包括之前已授权但需要重新授权的）
        imported_pending = 0
        
        # 从 email_addresses 添加到待授权（这些是之前授权过的，需要重新授权）
        if "email_addresses" in data and data["email_addresses"]:
            for email_info in data["email_addresses"]:
                email = email_info.get("address") if isinstance(email_info, dict) else email_info
                if email:
                    try:
                        conn.execute(f"""
                            INSERT OR IGNORE INTO user_{user['id']}_pending_emails (email)
                            VALUES (?)
                        """, (email,))
                        imported_pending += 1
                    except:
                        pass
        
        # 从 pending_emails 添加
        if "pending_emails" in data and data["pending_emails"]:
            for email in data["pending_emails"]:
                if email:
                    try:
                        conn.execute(f"""
                            INSERT OR IGNORE INTO user_{user['id']}_pending_emails (email)
                            VALUES (?)
                        """, (email,))
                        imported_pending += 1
                    except:
                        pass
        
        conn.commit()
    
    result_msg = f"导入完成：{imported_accounts} 新增, {updated_accounts} 更新, {skipped_accounts} 跳过"
    if imported_oauth > 0:
        result_msg += f", {imported_oauth} 个OAuth配置"
    if imported_pending > 0:
        result_msg += f", {imported_pending} 个待授权邮箱"
    
    return {
        "message": result_msg,
        "imported_types": imported_types,
        "imported_groups": imported_groups,
        "imported_values": imported_values,
        "imported": imported_accounts,
        "updated": updated_accounts,
        "skipped": skipped_accounts,
        "imported_oauth": imported_oauth,
        "imported_pending": imported_pending
    }

@app.post("/api/import-csv")
def import_csv(data: dict, user: dict = Depends(get_current_user)):
    csv_text = data.get("csv", "")
    if not csv_text:
        raise HTTPException(status_code=400, detail="CSV内容为空")
    
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    imported = 0
    errors = []
    
    lines = csv_text.strip().split('\n')
    with get_db() as conn:
        for i, line in enumerate(lines):
            if not line.strip() or line.startswith('#'):
                continue
            parts = [p.strip() for p in line.split(',')]
            if len(parts) < 2:
                errors.append(f"第{i+1}行格式错误")
                continue
            try:
                email = parts[0]
                password = parts[1]
                country = parts[2] if len(parts) > 2 and parts[2] else "🌍"
                custom_name = parts[3] if len(parts) > 3 else ""
                
                conn.execute(f"""
                    INSERT INTO user_{user['id']}_accounts 
                    (email, password, country, custom_name, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (email, encrypt_password(password), country, custom_name, now, now))
                imported += 1
            except Exception as e:
                errors.append(f"第{i+1}行: {str(e)}")
        conn.commit()
    
    return {"message": f"成功导入 {imported} 个账号", "count": imported, "errors": errors[:10]}

# ==================== 2FA TOTP API ====================

STEAM_CHARS = "23456789BCDFGHJKMNPQRTVWXY"

def generate_totp(secret: str, time_offset: int = 0, digits: int = 6, period: int = 30, algorithm: str = "SHA1") -> str:
    try:
        key = base64.b32decode(secret.upper().replace(" ", "") + "=" * ((8 - len(secret) % 8) % 8))
        counter = (int(time.time()) + time_offset) // period
        counter_bytes = struct.pack(">Q", counter)
        hash_func = {"SHA256": hashlib.sha256, "SHA512": hashlib.sha512}.get(algorithm.upper(), hashlib.sha1)
        h = hmac.new(key, counter_bytes, hash_func).digest()
        offset = h[-1] & 0x0F
        code = struct.unpack(">I", h[offset:offset + 4])[0] & 0x7FFFFFFF
        return str(code % (10 ** digits)).zfill(digits)
    except:
        return ""

def generate_steam_code(secret: str, time_offset: int = 0) -> str:
    try:
        key = base64.b64decode(secret)
        counter = (int(time.time()) + time_offset) // 30
        h = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
        offset = h[-1] & 0x0F
        code = struct.unpack(">I", h[offset:offset + 4])[0] & 0x7FFFFFFF
        return "".join(STEAM_CHARS[code // (len(STEAM_CHARS) ** i) % len(STEAM_CHARS)] for i in range(5))
    except:
        return ""

def parse_otpauth_uri(uri: str) -> dict:
    try:
        match = re.match(r'otpauth://(totp|hotp)/([^?]+)\?(.+)', uri)
        if not match:
            return None
        params = dict(p.split('=', 1) for p in match.group(3).split('&') if '=' in p)
        return {
            "type": match.group(1),
            "label": match.group(2),
            "secret": params.get("secret", ""),
            "issuer": params.get("issuer", ""),
            "algorithm": params.get("algorithm", "SHA1").upper(),
            "digits": int(params.get("digits", 6)),
            "period": int(params.get("period", 30))
        }
    except:
        return None

@app.post("/api/accounts/{account_id}/totp")
def set_account_totp(account_id: int, data: TOTPCreate, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        row = conn.execute(f"SELECT id FROM user_{user['id']}_accounts WHERE id = ?", (account_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="账号不存在")
        conn.execute(f"""UPDATE user_{user['id']}_accounts 
            SET totp_secret=?, totp_issuer=?, totp_type=?, totp_algorithm=?, totp_digits=?, totp_period=?, backup_codes=?, updated_at=?
            WHERE id=?""",
            (encrypt_password(data.secret), data.issuer, data.totp_type, data.algorithm, data.digits, data.period,
             json.dumps(data.backup_codes), datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), account_id))
        conn.commit()
    return {"message": "2FA 配置已保存"}

@app.get("/api/accounts/{account_id}/totp")
def get_account_totp(account_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        row = conn.execute(f"""SELECT totp_secret, totp_issuer, totp_type, totp_algorithm, totp_digits, totp_period, backup_codes, time_offset 
            FROM user_{user['id']}_accounts WHERE id = ?""", (account_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="账号不存在")
    if not row["totp_secret"]:
        return {"secret": None}
    return {
        "secret": decrypt_password(row["totp_secret"]),
        "issuer": row["totp_issuer"],
        "type": row["totp_type"],
        "algorithm": row["totp_algorithm"],
        "digits": row["totp_digits"],
        "period": row["totp_period"],
        "backup_codes": json.loads(row["backup_codes"] or "[]"),
        "time_offset": row["time_offset"]
    }

@app.get("/api/accounts/{account_id}/totp/generate")
def generate_totp_code(account_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        row = conn.execute(f"""SELECT totp_secret, totp_type, totp_algorithm, totp_digits, totp_period, time_offset 
            FROM user_{user['id']}_accounts WHERE id = ?""", (account_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="账号不存在")
    
    secret = decrypt_password(row["totp_secret"]) if row["totp_secret"] else None
    if not secret:
        raise HTTPException(status_code=404, detail="未配置 2FA")
    
    totp_type = row["totp_type"] or "totp"
    time_offset = row["time_offset"] or 0
    period = row["totp_period"] or 30
    
    if totp_type == "steam":
        code = generate_steam_code(secret, time_offset)
    else:
        code = generate_totp(secret, time_offset=time_offset, digits=row["totp_digits"] or 6,
            period=period, algorithm=row["totp_algorithm"] or "SHA1")
    
    remaining = period - ((int(time.time()) + time_offset) % period)
    
    return {"code": code, "type": totp_type, "remaining": remaining, "period": period}

@app.delete("/api/accounts/{account_id}/totp")
def delete_account_totp(account_id: int, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        conn.execute(f"""UPDATE user_{user['id']}_accounts 
            SET totp_secret='', totp_issuer='', totp_type='', backup_codes='[]', updated_at=?
            WHERE id=?""", (datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), account_id))
        conn.commit()
    return {"message": "2FA 配置已删除"}

@app.post("/api/accounts/{account_id}/totp/parse")
def parse_totp_uri(account_id: int, data: dict, user: dict = Depends(get_current_user)):
    parsed = parse_otpauth_uri(data.get("uri", ""))
    if not parsed:
        raise HTTPException(status_code=400, detail="无效的 otpauth URI")
    with get_db() as conn:
        conn.execute(f"""UPDATE user_{user['id']}_accounts 
            SET totp_secret=?, totp_issuer=?, totp_type=?, totp_algorithm=?, totp_digits=?, totp_period=?, updated_at=?
            WHERE id=?""",
            (encrypt_password(parsed["secret"]), parsed["issuer"] or parsed["label"], parsed["type"],
             parsed["algorithm"], parsed["digits"], parsed["period"], datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), account_id))
        conn.commit()
    return {"message": "2FA 配置已从 URI 导入", "parsed": {k: v for k, v in parsed.items() if k != "secret"}}

# ==================== 备份 API ====================

@app.post("/api/backup")
def create_backup(config: BackupConfig = BackupConfig(), user: dict = Depends(get_current_user)):
    backup_dir = config.backup_dir if config.backup_dir else DEFAULT_BACKUP_DIR
    
    try:
        os.makedirs(backup_dir, exist_ok=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"无法创建备份目录: {str(e)}")
    
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    
    # 文件名根据是否包含密钥和是否自动备份
    suffix = "_full" if config.include_key else ""
    prefix = "auto_" if config.auto else ""
    db_backup_name = f"backup_{timestamp}{suffix}.db"
    db_backup_path = os.path.join(backup_dir, db_backup_name)
    
    try:
        with get_db() as conn:
            backup_conn = sqlite3.connect(db_backup_path)
            conn.backup(backup_conn)
            backup_conn.close()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"数据库备份失败: {str(e)}")
    
    result = {
        "message": "备份成功",
        "timestamp": timestamp,
        "backup_dir": backup_dir,
        "files": [db_backup_name]
    }
    
    # 如果是自动备份，自动清理旧备份
    if config.auto and config.keep_count > 0:
        try:
            backups = sorted([f for f in os.listdir(backup_dir) if f.endswith('.db')], reverse=True)
            for old_backup in backups[config.keep_count:]:
                os.remove(os.path.join(backup_dir, old_backup))
            if len(backups) > config.keep_count:
                result["cleaned"] = len(backups) - config.keep_count
        except Exception:
            pass
    
    if config.include_key and os.path.exists(ENCRYPTION_KEY_FILE):
        key_backup_name = f"backup_{timestamp}_full.key"
        key_backup_path = os.path.join(backup_dir, key_backup_name)
        try:
            shutil.copy2(ENCRYPTION_KEY_FILE, key_backup_path)
            os.chmod(key_backup_path, 0o600)
            result["files"].append(key_backup_name)
            result["warning"] = "⚠️ 加密密钥已备份，请妥善保管！"
        except Exception as e:
            result["key_backup_error"] = str(e)
    
    return result

@app.get("/api/backup/download")
def download_backup(user: dict = Depends(get_current_user)):
    """
    生成备份并直接下载到用户电脑
    这样即使 VPS 或 Docker 被删除，用户本地还有备份
    """
    import tempfile
    
    # 创建临时备份文件
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    temp_dir = tempfile.mkdtemp()
    db_backup_name = f"accbox_backup_{timestamp}.db"
    db_backup_path = os.path.join(temp_dir, db_backup_name)
    
    try:
        # 执行数据库备份
        with get_db() as conn:
            backup_conn = sqlite3.connect(db_backup_path)
            conn.backup(backup_conn)
            backup_conn.close()
        
        # 返回文件流，触发浏览器下载
        return FileResponse(
            path=db_backup_path,
            filename=db_backup_name,
            media_type='application/octet-stream',
            headers={
                "Content-Disposition": f'attachment; filename="{db_backup_name}"'
            }
        )
    except Exception as e:
        # 清理临时文件
        if os.path.exists(db_backup_path):
            os.remove(db_backup_path)
        if os.path.exists(temp_dir):
            os.rmdir(temp_dir)
        raise HTTPException(status_code=500, detail=f"备份生成失败: {str(e)}")

@app.get("/api/backups/{filename}/download")
def download_existing_backup(filename: str, path: Optional[str] = None, user: dict = Depends(get_current_user)):
    """
    下载已存在的备份文件到用户电脑
    """
    # 安全检查：防止路径遍历攻击
    if not (filename.startswith("backup_") or filename.startswith("accounts_backup_") or filename.startswith("accbox_backup_")) or ".." in filename:
        raise HTTPException(status_code=400, detail="无效的文件名")
    
    backup_dir = path if path else DEFAULT_BACKUP_DIR
    file_path = os.path.join(backup_dir, filename)
    
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="备份文件不存在")
    
    return FileResponse(
        path=file_path,
        filename=filename,
        media_type='application/octet-stream',
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        }
    )

@app.post("/api/backup/settings")
def save_backup_settings(settings: BackupSettings, backup_dir: Optional[str] = None, user: dict = Depends(get_current_user)):
    """保存并应用定时备份设置"""
    global auto_backup_settings, auto_backup_timer
    
    # 更新设置
    auto_backup_settings["enabled"] = settings.interval_hours > 0
    auto_backup_settings["interval_hours"] = settings.interval_hours
    auto_backup_settings["keep_count"] = settings.keep_count
    auto_backup_settings["backup_dir"] = backup_dir
    
    # 保存到文件
    try:
        with open(BACKUP_SETTINGS_FILE, 'w') as f:
            json.dump(auto_backup_settings, f)
    except Exception as e:
        print(f"保存备份设置失败: {e}")
    
    # 重启定时器
    setup_auto_backup()
    
    return {
        "message": "定时备份设置已保存",
        "settings": auto_backup_settings
    }

@app.get("/api/backup/settings")
def get_backup_settings(user: dict = Depends(get_current_user)):
    """获取定时备份设置"""
    return auto_backup_settings

@app.post("/api/backup/validate-path")
def validate_backup_path(path: str, user: dict = Depends(get_current_user)):
    """验证备份路径是否有效且可写"""
    if not path:
        return {"valid": True, "path": DEFAULT_BACKUP_DIR, "message": "使用默认路径"}
    
    try:
        # 尝试创建目录
        os.makedirs(path, exist_ok=True)
        # 尝试写入测试文件
        test_file = os.path.join(path, ".write_test")
        with open(test_file, 'w') as f:
            f.write("test")
        os.remove(test_file)
        return {"valid": True, "path": path, "message": "路径有效"}
    except PermissionError:
        return {"valid": False, "path": path, "message": "没有写入权限"}
    except Exception as e:
        return {"valid": False, "path": path, "message": f"路径无效: {str(e)}"}

# ==================== 密钥管理 API ====================

@app.get("/api/encryption-key/info")
def get_key_info(user: dict = Depends(get_current_user)):
    """获取密钥信息（不返回密钥本身）"""
    env_key = os.environ.get("APP_MASTER_KEY", "").strip()
    
    if env_key and env_key != UNSAFE_DEFAULT_KEY:
        return {
            "source": "environment",
            "message": "密钥已配置在 .env 文件中"
        }
    else:
        return {
            "source": "unsafe_default",
            "message": "正在使用默认不安全密钥"
        }

# ==================== 定时备份核心功能 ====================

def load_backup_settings():
    """加载备份设置"""
    global auto_backup_settings
    if os.path.exists(BACKUP_SETTINGS_FILE):
        try:
            with open(BACKUP_SETTINGS_FILE, 'r') as f:
                saved = json.load(f)
                auto_backup_settings.update(saved)
        except Exception as e:
            print(f"加载备份设置失败: {e}")

def do_auto_backup():
    """执行自动备份"""
    global auto_backup_settings
    
    if not auto_backup_settings.get("enabled"):
        return
    
    backup_dir = auto_backup_settings.get("backup_dir") or DEFAULT_BACKUP_DIR
    keep_count = auto_backup_settings.get("keep_count", 10)
    
    try:
        os.makedirs(backup_dir, exist_ok=True)
        
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        db_backup_name = f"backup_{timestamp}_auto.db"
        db_backup_path = os.path.join(backup_dir, db_backup_name)
        
        # 执行备份
        with get_db() as conn:
            backup_conn = sqlite3.connect(db_backup_path)
            conn.backup(backup_conn)
            backup_conn.close()
        
        # 更新最后备份时间
        auto_backup_settings["last_backup"] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        with open(BACKUP_SETTINGS_FILE, 'w') as f:
            json.dump(auto_backup_settings, f)
        
        # 清理旧备份
        backups = sorted([f for f in os.listdir(backup_dir) if f.endswith('.db') and '_auto' in f], reverse=True)
        for old_backup in backups[keep_count:]:
            try:
                os.remove(os.path.join(backup_dir, old_backup))
            except:
                pass
        
        print(f"✅ 自动备份完成: {db_backup_path}")
        
    except Exception as e:
        print(f"❌ 自动备份失败: {e}")

def auto_backup_loop():
    """定时备份循环"""
    global auto_backup_timer, auto_backup_settings
    
    while auto_backup_settings.get("enabled"):
        interval = auto_backup_settings.get("interval_hours", 24)
        # 等待指定小时数
        time.sleep(interval * 3600)
        
        if auto_backup_settings.get("enabled"):
            do_auto_backup()

def setup_auto_backup():
    """设置定时备份"""
    global auto_backup_timer, auto_backup_settings
    
    # 停止现有定时器
    if auto_backup_timer and auto_backup_timer.is_alive():
        auto_backup_settings["enabled"] = False
        auto_backup_timer.join(timeout=1)
    
    # 如果启用了定时备份，启动新线程
    if auto_backup_settings.get("enabled") and auto_backup_settings.get("interval_hours", 0) > 0:
        auto_backup_settings["enabled"] = True
        auto_backup_timer = threading.Thread(target=auto_backup_loop, daemon=True)
        auto_backup_timer.start()
        print(f"🕐 定时备份已启动: 每 {auto_backup_settings['interval_hours']} 小时")
    else:
        print("🕐 定时备份已关闭")

# 启动时加载设置并启动定时备份
load_backup_settings()
setup_auto_backup()

@app.get("/api/backups")
def list_backups(path: Optional[str] = None, user: dict = Depends(get_current_user)):
    backup_dir = path if path else DEFAULT_BACKUP_DIR
    
    if not os.path.exists(backup_dir):
        return {"backups": [], "backup_dir": backup_dir}
    
    backups = []
    for filename in os.listdir(backup_dir):
        if filename.startswith("backup_") and filename.endswith(".db"):
            filepath = os.path.join(backup_dir, filename)
            stat = os.stat(filepath)
            
            try:
                # 匹配新格式 backup_20260123_153045.db 或 backup_20260123_153045_full.db
                timestamp_str = filename.replace("backup_", "").replace("_full", "").replace(".db", "")
                backup_time = datetime.strptime(timestamp_str, "%Y%m%d_%H%M%S")
            except:
                backup_time = datetime.fromtimestamp(stat.st_mtime)
            
            backups.append({
                "filename": filename,
                "size": stat.st_size,
                "size_human": f"{stat.st_size / 1024:.1f} KB",
                "created_at": backup_time.isoformat(),
                "created_at_human": backup_time.strftime("%Y-%m-%d %H:%M:%S")
            })
    
    # 也支持旧格式文件名
    for filename in os.listdir(backup_dir):
        if filename.startswith("accounts_backup_") and filename.endswith(".db"):
            filepath = os.path.join(backup_dir, filename)
            stat = os.stat(filepath)
            
            try:
                timestamp_str = filename.replace("accounts_backup_", "").replace(".db", "")
                backup_time = datetime.strptime(timestamp_str, "%Y%m%d_%H%M%S")
            except:
                backup_time = datetime.fromtimestamp(stat.st_mtime)
            
            backups.append({
                "filename": filename,
                "size": stat.st_size,
                "size_human": f"{stat.st_size / 1024:.1f} KB",
                "created_at": backup_time.isoformat(),
                "created_at_human": backup_time.strftime("%Y-%m-%d %H:%M:%S")
            })
    
    backups.sort(key=lambda x: x["created_at"], reverse=True)
    
    return {"backups": backups, "backup_dir": backup_dir, "total_count": len(backups)}

@app.delete("/api/backups/{filename}")
def delete_backup(filename: str, path: Optional[str] = None, user: dict = Depends(get_current_user)):
    # 支持新旧两种文件名格式
    if not (filename.startswith("backup_") or filename.startswith("accounts_backup_")) or ".." in filename:
        raise HTTPException(status_code=400, detail="无效的文件名")
    
    backup_dir = path if path else DEFAULT_BACKUP_DIR
    backup_path = os.path.join(backup_dir, filename)
    
    if not os.path.exists(backup_path):
        raise HTTPException(status_code=404, detail="备份文件不存在")
    
    try:
        os.remove(backup_path)
        # 删除对应的密钥文件（如果有）
        key_backup = backup_path.replace(".db", ".key")
        if os.path.exists(key_backup):
            os.remove(key_backup)
        return {"message": "备份已删除", "filename": filename}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"删除失败: {str(e)}")

class RestoreConfig(BaseModel):
    backup_dir: Optional[str] = None

@app.post("/api/backups/{filename}/restore")
def restore_backup(filename: str, config: RestoreConfig = RestoreConfig(), user: dict = Depends(get_current_user)):
    # 支持新旧两种文件名格式
    if not (filename.startswith("backup_") or filename.startswith("accounts_backup_")) or ".." in filename:
        raise HTTPException(status_code=400, detail="无效的文件名")
    
    backup_dir = config.backup_dir if config.backup_dir else DEFAULT_BACKUP_DIR
    backup_path = os.path.join(backup_dir, filename)
    
    if not os.path.exists(backup_path):
        raise HTTPException(status_code=404, detail="备份文件不存在")
    
    try:
        # 恢复前先备份当前数据
        current_backup = f"backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}_before_restore.db"
        os.makedirs(DEFAULT_BACKUP_DIR, exist_ok=True)
        shutil.copy2(DB_PATH, os.path.join(DEFAULT_BACKUP_DIR, current_backup))
        shutil.copy2(backup_path, DB_PATH)
        
        return {
            "message": "恢复成功",
            "restored_from": filename,
            "previous_backup": current_backup,
            "warning": "请重新登录以加载恢复的数据"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"恢复失败: {str(e)}")

@app.post("/api/backup/cleanup")
def cleanup_old_backups(max_keep: int = 7, user: dict = Depends(get_current_user)):
    if max_keep < 1:
        raise HTTPException(status_code=400, detail="至少保留1个备份")
    
    backup_dir = DEFAULT_BACKUP_DIR
    if not os.path.exists(backup_dir):
        return {"message": "没有备份需要清理", "deleted": 0}
    
    backups = []
    for filename in os.listdir(backup_dir):
        if filename.startswith("accounts_backup_") and filename.endswith(".db"):
            filepath = os.path.join(backup_dir, filename)
            backups.append((filename, os.path.getmtime(filepath)))
    
    backups.sort(key=lambda x: x[1], reverse=True)
    
    deleted = []
    for filename, _ in backups[max_keep:]:
        try:
            os.remove(os.path.join(backup_dir, filename))
            key_file = filename.replace("accounts_backup_", "encryption_key_backup_").replace(".db", ".key")
            key_path = os.path.join(backup_dir, key_file)
            if os.path.exists(key_path):
                os.remove(key_path)
            deleted.append(filename)
        except:
            pass
    
    return {"message": f"清理完成，删除了 {len(deleted)} 个旧备份", "kept": max_keep, "deleted": deleted}

# ==================== 健康检查 ====================

@app.get("/api/health")
def health_check():
    current_key = os.environ.get("APP_MASTER_KEY", "")
    jwt_key = os.environ.get("JWT_SECRET_KEY", "")
    
    # 只有两种状态：安全 或 不安全（使用默认密钥）
    if current_key and current_key != UNSAFE_DEFAULT_KEY:
        key_status = "secure"
    else:
        key_status = "unsafe_default"
    
    return {
        "status": "ok",
        "version": "5.1",
        "key_status": key_status,
        "jwt_configured": bool(jwt_key),
        "cors_origins": len(ALLOWED_ORIGINS),
        "time": datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    }

@app.get("/api/version")
def get_version():
    """返回服务器版本"""
    return {"server_version": "v5.1.4"}

# ==================== 静态文件 ====================

# ==================== 邮箱授权 API ====================

class EmailOAuthStart(BaseModel):
    provider: str  # gmail, outlook
    origin: Optional[str] = None  # 前端传递的 window.location.origin

class EmailIMAPAdd(BaseModel):
    provider: str  # qq, imap
    email: str
    password: str
    server: Optional[str] = None
    port: Optional[int] = 993

class EmailCloudflareAdd(BaseModel):
    worker_domain: str      # e.g. steep-night-1f5a.ddzhaogg001.workers.dev
    email_domain: str       # e.g. example.com
    admin_password: str     # Worker 管理密码
    email_address: Optional[str] = None  # 可选，不填则自动创建

class OAuthConfigSave(BaseModel):
    provider: str
    client_id: str
    client_secret: str

# 存储OAuth状态（生产环境应用Redis）
oauth_states: Dict[str, Dict] = {}

# IMAP 请求频率限制（防止QQ等邮箱封号）
# 格式: {email_address: last_fetch_timestamp}
imap_last_fetch: Dict[str, float] = {}
IMAP_MIN_INTERVAL = 60  # 最少间隔60秒

@app.get("/api/emails")
def get_emails(user: dict = Depends(get_current_user)):
    """获取已授权和待授权邮箱列表"""
    user_id = user['id']
    
    with get_db() as conn:
        # 获取已授权邮箱（表在init_user_tables中已创建）
        try:
            cursor = conn.execute(f"SELECT id, address, provider, status FROM user_{user_id}_emails")
            authorized = [{"id": row["id"], "address": row["address"], "provider": row["provider"], "status": row["status"]} for row in cursor.fetchall()]
        except:
            authorized = []
        
        # 获取待授权邮箱（从pending_emails表 + 账号的辅助邮箱字段收集，排除已授权的）
        pending_set = set()
        authorized_addresses = {e["address"].lower() for e in authorized}
        
        # 从pending_emails表获取
        try:
            cursor = conn.execute(f"SELECT email FROM user_{user_id}_pending_emails")
            for row in cursor.fetchall():
                email = row["email"]
                if email and email.lower() not in authorized_addresses:
                    pending_set.add(email)
        except:
            pass
        
        # 从账号的辅助邮箱字段获取
        try:
            cursor = conn.execute(f"SELECT DISTINCT backup_email FROM user_{user_id}_accounts WHERE backup_email IS NOT NULL AND backup_email != ''")
            for row in cursor.fetchall():
                email = row["backup_email"]
                if email and email.lower() not in authorized_addresses:
                    pending_set.add(email)
        except:
            pass  # backup_email字段可能不存在
        
        pending = list(pending_set)
    
    return {"authorized": authorized, "pending": pending}

@app.post("/api/emails/pending")
def sync_pending_emails(data: dict, user: dict = Depends(get_current_user)):
    """同步待授权邮箱列表"""
    user_id = user['id']
    emails = data.get("emails", [])
    
    with get_db() as conn:
        # 获取已授权邮箱地址
        try:
            cursor = conn.execute(f"SELECT address FROM user_{user_id}_emails")
            authorized_addresses = {row["address"].lower() for row in cursor.fetchall()}
        except:
            authorized_addresses = set()
        
        # 添加未授权的邮箱到pending_emails表
        added = 0
        for email in emails:
            if email and email.lower() not in authorized_addresses:
                try:
                    conn.execute(f"INSERT OR IGNORE INTO user_{user_id}_pending_emails (email) VALUES (?)", (email,))
                    added += 1
                except:
                    pass
        
        conn.commit()
    
    return {"success": True, "added": added}

@app.get("/api/emails/oauth/config-status")
def get_oauth_config_status(provider: str, user: dict = Depends(get_current_user)):
    """检查OAuth是否已配置，如果已配置则返回client_id用于前端显示"""
    provider = provider.lower()
    
    # 先检查环境变量
    if provider == 'gmail':
        if os.environ.get('GOOGLE_CLIENT_ID') and os.environ.get('GOOGLE_CLIENT_SECRET'):
            return {"configured": True, "source": "env", "client_id": os.environ.get('GOOGLE_CLIENT_ID')}
    elif provider == 'outlook':
        if os.environ.get('MICROSOFT_CLIENT_ID') and os.environ.get('MICROSOFT_CLIENT_SECRET'):
            return {"configured": True, "source": "env", "client_id": os.environ.get('MICROSOFT_CLIENT_ID')}
    
    # 再检查数据库（表在init_db中已创建）
    with get_db() as conn:
        try:
            cursor = conn.execute("SELECT client_id, client_secret FROM oauth_configs WHERE provider = ?", (provider,))
            row = cursor.fetchone()
            if row:
                # 返回 client_id 和 client_secret（解密后）用于前端自动填充
                return {
                    "configured": True, 
                    "source": "db", 
                    "client_id": row["client_id"],
                    "client_secret": decrypt_password(row["client_secret"])
                }
        except:
            pass
    
    return {"configured": False}

@app.post("/api/emails/oauth/config")
def save_oauth_config(data: OAuthConfigSave, user: dict = Depends(get_current_user)):
    """保存OAuth配置（前端填写的凭证）"""
    provider = data.provider.lower()
    
    if provider not in ['gmail', 'outlook']:
        raise HTTPException(status_code=400, detail="不支持的邮箱类型")
    
    if not data.client_id or not data.client_secret:
        raise HTTPException(status_code=400, detail="Client ID 和 Client Secret 不能为空")
    
    with get_db() as conn:
        # 加密存储
        encrypted_secret = encrypt_password(data.client_secret)
        
        conn.execute("""
            INSERT OR REPLACE INTO oauth_configs (provider, client_id, client_secret)
            VALUES (?, ?, ?)
        """, (provider, data.client_id, encrypted_secret))
        conn.commit()
    
    return {"success": True}

def get_oauth_credentials(provider: str):
    """获取OAuth凭证（优先环境变量，其次数据库）"""
    if provider == 'gmail':
        client_id = os.environ.get('GOOGLE_CLIENT_ID')
        client_secret = os.environ.get('GOOGLE_CLIENT_SECRET')
        if client_id and client_secret:
            return client_id, client_secret
    elif provider == 'outlook':
        client_id = os.environ.get('MICROSOFT_CLIENT_ID')
        client_secret = os.environ.get('MICROSOFT_CLIENT_SECRET')
        if client_id and client_secret:
            return client_id, client_secret
    
    # 从数据库获取
    with get_db() as conn:
        try:
            cursor = conn.execute("SELECT client_id, client_secret FROM oauth_configs WHERE provider = ?", (provider,))
            row = cursor.fetchone()
            if row:
                client_id = row["client_id"]
                client_secret = decrypt_password(row["client_secret"])
                return client_id, client_secret
        except:
            pass
    
    return None, None

@app.post("/api/emails/oauth/start")
def start_oauth(data: EmailOAuthStart, request: Request, user: dict = Depends(get_current_user)):
    """启动OAuth授权流程"""
    provider = data.provider.lower()
    
    if provider not in ['gmail', 'outlook']:
        raise HTTPException(status_code=400, detail="不支持的邮箱类型")
    
    # 获取OAuth凭证
    client_id, client_secret = get_oauth_credentials(provider)
    
    if not client_id or not client_secret:
        raise HTTPException(
            status_code=400, 
            detail=f"{provider.title()} OAuth未配置。请填写 Client ID 和 Client Secret"
        )
    
    # 生成state
    state = secrets.token_urlsafe(32)
    
    # 自动检测回调地址：优先 .env 配置，其次前端传递的 origin，最后从请求头获取
    redirect_uri = os.environ.get('OAUTH_REDIRECT_URI')
    if not redirect_uri:
        if data.origin:
            # 使用前端传递的 origin（最可靠，包含正确的 scheme）
            redirect_uri = f"{data.origin}/api/emails/oauth/callback"
        else:
            # 从请求头获取
            host = request.headers.get('x-forwarded-host') or request.headers.get('host') or 'localhost:9111'
            scheme = request.headers.get('x-forwarded-proto') or 'http'
            redirect_uri = f"{scheme}://{host}/api/emails/oauth/callback"
    
    if provider == 'gmail':
        params = urllib.parse.urlencode({
            'client_id': client_id,
            'redirect_uri': redirect_uri,
            'response_type': 'code',
            'scope': 'https://www.googleapis.com/auth/gmail.readonly',
            'access_type': 'offline',
            'prompt': 'consent select_account',
            'state': state
        })
        auth_url = f"https://accounts.google.com/o/oauth2/v2/auth?{params}"
    else:  # outlook
        params = urllib.parse.urlencode({
            'client_id': client_id,
            'redirect_uri': redirect_uri,
            'response_type': 'code',
            'scope': 'https://graph.microsoft.com/Mail.Read offline_access',
            'prompt': 'select_account',
            'state': state
        })
        auth_url = f"https://login.microsoftonline.com/common/oauth2/v2.0/authorize?{params}"
    
    # 保存state（包含redirect_uri用于token交换）
    oauth_states[state] = {
        "user_id": user['id'],
        "provider": provider,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": redirect_uri,
        "created_at": time.time()
    }
    
    return {"auth_url": auth_url, "state": state}

@app.get("/api/emails/oauth/callback")
def oauth_callback(code: str = None, state: str = None, error: str = None):
    """OAuth回调处理"""
    if error:
        return JSONResponse(content={"status": "error", "message": error})
    
    if not state or state not in oauth_states:
        return JSONResponse(content={"status": "error", "message": "无效的state"})
    
    state_data = oauth_states[state]
    user_id = state_data["user_id"]
    provider = state_data["provider"]
    client_id = state_data.get("client_id")
    client_secret = state_data.get("client_secret")
    
    # 如果state中没有凭证，尝试重新获取
    if not client_id or not client_secret:
        client_id, client_secret = get_oauth_credentials(provider)
    
    if not client_id or not client_secret:
        oauth_states[state]["status"] = "error"
        oauth_states[state]["message"] = "OAuth凭证丢失"
        return JSONResponse(content={"status": "error", "message": "OAuth凭证丢失"})
    
    try:
        import urllib.request
        import urllib.parse
        
        # 使用授权时保存的 redirect_uri
        redirect_uri = state_data.get('redirect_uri') or os.environ.get('OAUTH_REDIRECT_URI', 'http://localhost:9111/api/emails/oauth/callback')
        
        if provider == 'gmail':
            # 用code换取token
            token_url = "https://oauth2.googleapis.com/token"
            token_data = urllib.parse.urlencode({
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code"
            }).encode()
            
            req = urllib.request.Request(token_url, data=token_data, method='POST')
            req.add_header('Content-Type', 'application/x-www-form-urlencoded')
            
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    token_resp = json.loads(resp.read().decode())
            except urllib.error.HTTPError as e:
                error_body = e.read().decode() if e.fp else ""
                oauth_states[state]["status"] = "error"
                oauth_states[state]["message"] = f"Token交换失败: {e.code} - {error_body}"
                return JSONResponse(content={"status": "error", "message": f"Token交换失败: {error_body}"})
            
            access_token = token_resp.get('access_token')
            refresh_token = token_resp.get('refresh_token')
            
            if not access_token:
                oauth_states[state]["status"] = "error"
                oauth_states[state]["message"] = f"未获取到access_token: {token_resp}"
                return JSONResponse(content={"status": "error", "message": "未获取到access_token"})
            
            # 获取用户邮箱 - 使用 Gmail API
            profile_url = "https://gmail.googleapis.com/gmail/v1/users/me/profile"
            req = urllib.request.Request(profile_url)
            req.add_header('Authorization', f'Bearer {access_token}')
            
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    profile = json.loads(resp.read().decode())
            except urllib.error.HTTPError as e:
                error_body = e.read().decode() if e.fp else ""
                oauth_states[state]["status"] = "error"
                oauth_states[state]["message"] = f"获取用户信息失败: {e.code} - {error_body}"
                return JSONResponse(content={"status": "error", "message": f"获取用户信息失败: {error_body}"})
            
            email = profile.get('emailAddress')
            
            # 存储到数据库（表在init_user_tables中已创建）
            with get_db() as conn:
                credentials = json.dumps({
                    "access_token": access_token,
                    "refresh_token": refresh_token,
                    "token_type": token_resp.get('token_type'),
                    "expires_in": token_resp.get('expires_in')
                })
                encrypted_creds = encrypt_password(credentials)
                
                conn.execute(f"""
                    INSERT OR REPLACE INTO user_{user_id}_emails (address, provider, status, credentials)
                    VALUES (?, 'gmail', 'active', ?)
                """, (email, encrypted_creds))
                conn.commit()
            
            # 更新state状态
            oauth_states[state]["status"] = "success"
            oauth_states[state]["email"] = email
            
            # 返回成功页面
            return JSONResponse(content={
                "status": "success",
                "message": f"成功授权 {email}",
                "html": f"""
                    <html><body style="font-family:sans-serif;text-align:center;padding-top:50px;">
                    <h2>✅ 授权成功</h2>
                    <p>已成功授权邮箱: {email}</p>
                    <p>您可以关闭此窗口</p>
                    <script>setTimeout(()=>window.close(),2000)</script>
                    </body></html>
                """
            })
            
        elif provider == 'outlook':
            # Microsoft OAuth token交换
            token_url = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
            token_data = urllib.parse.urlencode({
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code"
            }).encode()
            
            req = urllib.request.Request(token_url, data=token_data, method='POST')
            req.add_header('Content-Type', 'application/x-www-form-urlencoded')
            
            with urllib.request.urlopen(req, timeout=10) as resp:
                token_resp = json.loads(resp.read().decode())
            
            access_token = token_resp.get('access_token')
            refresh_token = token_resp.get('refresh_token')
            
            # 获取用户邮箱
            profile_url = "https://graph.microsoft.com/v1.0/me"
            req = urllib.request.Request(profile_url)
            req.add_header('Authorization', f'Bearer {access_token}')
            
            with urllib.request.urlopen(req, timeout=10) as resp:
                profile = json.loads(resp.read().decode())
            
            email = profile.get('mail') or profile.get('userPrincipalName')
            
            with get_db() as conn:
                credentials = json.dumps({
                    "access_token": access_token,
                    "refresh_token": refresh_token
                })
                encrypted_creds = encrypt_password(credentials)
                
                conn.execute(f"""
                    INSERT OR REPLACE INTO user_{user_id}_emails (address, provider, status, credentials)
                    VALUES (?, 'outlook', 'active', ?)
                """, (email, encrypted_creds))
                conn.commit()
            
            oauth_states[state]["status"] = "success"
            oauth_states[state]["email"] = email
            
            return JSONResponse(content={
                "status": "success",
                "message": f"成功授权 {email}"
            })
            
    except Exception as e:
        oauth_states[state]["status"] = "error"
        oauth_states[state]["message"] = str(e)
        return JSONResponse(content={"status": "error", "message": str(e)})
    
    finally:
        # 清理过期的state（超过10分钟）
        now = time.time()
        expired = [s for s, d in oauth_states.items() if now - d.get("created_at", 0) > 600]
        for s in expired:
            del oauth_states[s]

@app.get("/api/emails/oauth/status")
def get_oauth_status(state: str, user: dict = Depends(get_current_user)):
    """查询OAuth授权状态"""
    if state not in oauth_states:
        return {"status": "expired", "message": "授权已过期"}
    
    state_data = oauth_states[state]
    if state_data.get("user_id") != user['id']:
        return {"status": "error", "message": "无权查询"}
    
    return {
        "status": state_data.get("status", "pending"),
        "message": state_data.get("message", ""),
        "email": state_data.get("email", "")
    }

class ManualCallbackData(BaseModel):
    provider: str
    code: str
    state: Optional[str] = None

@app.post("/api/emails/oauth/callback-manual")
def oauth_callback_manual(data: ManualCallbackData, user: dict = Depends(get_current_user)):
    """手动处理OAuth回调（用于无法自动回调的情况）"""
    provider = data.provider.lower()
    code = data.code
    user_id = user['id']
    
    if provider not in ['gmail', 'outlook']:
        raise HTTPException(status_code=400, detail="不支持的邮箱类型")
    
    # 获取OAuth凭证
    client_id, client_secret = get_oauth_credentials(provider)
    if not client_id or not client_secret:
        raise HTTPException(status_code=400, detail="OAuth凭证未配置")
    
    # 使用 urn:ietf:wg:oauth:2.0:oob 作为回调URI（适用于手动方式）
    # 或者尝试从 state 获取原始的 redirect_uri
    redirect_uri = 'urn:ietf:wg:oauth:2.0:oob'
    
    try:
        if provider == 'gmail':
            # Google OAuth token交换
            token_url = "https://oauth2.googleapis.com/token"
            token_data = urllib.parse.urlencode({
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code"
            }).encode()
            
            req = urllib.request.Request(token_url, data=token_data, method='POST')
            req.add_header('Content-Type', 'application/x-www-form-urlencoded')
            
            with urllib.request.urlopen(req, timeout=10) as resp:
                token_resp = json.loads(resp.read().decode())
            
            access_token = token_resp.get('access_token')
            refresh_token = token_resp.get('refresh_token')
            
            # 获取用户邮箱
            profile_url = "https://www.googleapis.com/oauth2/v2/userinfo"
            req = urllib.request.Request(profile_url)
            req.add_header('Authorization', f'Bearer {access_token}')
            
            with urllib.request.urlopen(req, timeout=10) as resp:
                profile = json.loads(resp.read().decode())
            
            email = profile.get('email')
            
            # 存储到数据库
            with get_db() as conn:
                credentials = json.dumps({
                    "access_token": access_token,
                    "refresh_token": refresh_token,
                    "token_type": token_resp.get('token_type'),
                    "expires_in": token_resp.get('expires_in')
                })
                encrypted_creds = encrypt_password(credentials)
                
                conn.execute(f"""
                    INSERT OR REPLACE INTO user_{user_id}_emails (address, provider, status, credentials)
                    VALUES (?, 'gmail', 'active', ?)
                """, (email, encrypted_creds))
                conn.commit()
            
            return {"status": "success", "email": email}
            
        elif provider == 'outlook':
            # Microsoft OAuth token交换
            token_url = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
            token_data = urllib.parse.urlencode({
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code"
            }).encode()
            
            req = urllib.request.Request(token_url, data=token_data, method='POST')
            req.add_header('Content-Type', 'application/x-www-form-urlencoded')
            
            with urllib.request.urlopen(req, timeout=10) as resp:
                token_resp = json.loads(resp.read().decode())
            
            access_token = token_resp.get('access_token')
            refresh_token = token_resp.get('refresh_token')
            
            # 获取用户邮箱
            profile_url = "https://graph.microsoft.com/v1.0/me"
            req = urllib.request.Request(profile_url)
            req.add_header('Authorization', f'Bearer {access_token}')
            
            with urllib.request.urlopen(req, timeout=10) as resp:
                profile = json.loads(resp.read().decode())
            
            email = profile.get('mail') or profile.get('userPrincipalName')
            
            with get_db() as conn:
                credentials = json.dumps({
                    "access_token": access_token,
                    "refresh_token": refresh_token
                })
                encrypted_creds = encrypt_password(credentials)
                
                conn.execute(f"""
                    INSERT OR REPLACE INTO user_{user_id}_emails (address, provider, status, credentials)
                    VALUES (?, 'outlook', 'active', ?)
                """, (email, encrypted_creds))
                conn.commit()
            
            return {"status": "success", "email": email}
            
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.post("/api/emails/imap/add")
def add_imap_email(data: EmailIMAPAdd, user: dict = Depends(get_current_user)):
    """添加IMAP邮箱"""
    user_id = user['id']
    
    # 验证IMAP连接
    import imaplib
    
    try:
        if data.provider == 'qq':
            server = 'imap.qq.com'
            port = 993
        elif data.provider == 'imap':
            if not data.server:
                raise HTTPException(status_code=400, detail="请填写IMAP服务器地址")
            server = data.server
            port = data.port or 993
        else:
            raise HTTPException(status_code=400, detail="不支持的邮箱类型")
        
        # 测试连接
        imap = imaplib.IMAP4_SSL(server, port)
        imap.login(data.email, data.password)
        imap.logout()
        
        # 存储到数据库（表在init_user_tables中已创建）
        with get_db() as conn:
            credentials = json.dumps({
                "server": server,
                "port": port,
                "password": data.password
            })
            encrypted_creds = encrypt_password(credentials)
            
            conn.execute(f"""
                INSERT OR REPLACE INTO user_{user_id}_emails (address, provider, status, credentials)
                VALUES (?, ?, 'active', ?)
            """, (data.email, data.provider, encrypted_creds))
            conn.commit()
        
        return {"success": True, "message": f"成功添加 {data.email}"}
        
    except imaplib.IMAP4.error as e:
        raise HTTPException(status_code=400, detail=f"IMAP连接失败: {str(e)}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"添加失败: {str(e)}")

@app.post("/api/emails/cloudflare/add")
def add_cloudflare_email(data: EmailCloudflareAdd, user: dict = Depends(get_current_user)):
    """添加 Cloudflare Worker 邮箱"""
    import urllib.request
    import urllib.error

    user_id = user['id']
    worker_base = f"https://{data.worker_domain}"
    CF_UA = 'AccBox/1.0'

    try:
        email_address = data.email_address

        # 统一走 /admin/new_address（Worker 没有 /auth/login 路由）
        # 指定了邮箱就拆出 name，没指定就随机生成
        if email_address and '@' in email_address:
            name_part = email_address.split('@')[0]
            domain_part = email_address.split('@')[1]
        else:
            import random, string
            name_length = random.randint(10, 14)
            name_chars = list(random.choices(string.ascii_lowercase, k=name_length))
            for _ in range(random.choice([1, 2])):
                pos = random.randint(2, len(name_chars) - 1)
                name_chars.insert(pos, random.choice(string.digits))
            name_part = ''.join(name_chars)
            domain_part = data.email_domain

        create_url = f"{worker_base}/admin/new_address"
        create_body = json.dumps({
            "enablePrefix": True,
            "name": name_part,
            "domain": domain_part
        }).encode()
        req = urllib.request.Request(create_url, data=create_body, method='POST')
        req.add_header('Content-Type', 'application/json')
        req.add_header('x-admin-auth', data.admin_password)
        req.add_header('User-Agent', CF_UA)

        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read().decode())

        email_address = result.get('address')
        cf_token = result.get('jwt')
        if not email_address:
            raise HTTPException(status_code=400, detail="Worker 未返回邮箱地址")
        if not cf_token:
            raise HTTPException(status_code=400, detail="Worker 未返回 JWT token")

        # 测试连接：调用 GET /api/mails 验证 token
        test_url = f"{worker_base}/api/mails?limit=1&offset=0"
        req = urllib.request.Request(test_url)
        req.add_header('Authorization', f'Bearer {cf_token}')
        req.add_header('User-Agent', CF_UA)

        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()  # 只要不报错就说明 token 有效

        # 存储到数据库
        with get_db() as conn:
            credentials = json.dumps({
                "worker_domain": data.worker_domain,
                "cf_token": cf_token,
                "admin_password": data.admin_password,
                "email_domain": data.email_domain
            })
            encrypted_creds = encrypt_password(credentials)

            conn.execute(f"""
                INSERT OR REPLACE INTO user_{user_id}_emails (address, provider, status, credentials)
                VALUES (?, 'cloudflare', 'active', ?)
            """, (email_address, encrypted_creds))
            conn.commit()

        return {"success": True, "message": f"成功添加 {email_address}", "email": email_address}

    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ''
        raise HTTPException(status_code=400, detail=f"Worker 请求失败 ({e.code}): {body}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"添加失败: {str(e)}")

@app.delete("/api/emails/{email_id}")
def remove_email(email_id: int, user: dict = Depends(get_current_user)):
    """移除授权邮箱"""
    user_id = user['id']
    
    with get_db() as conn:
        conn.execute(f"DELETE FROM user_{user_id}_emails WHERE id = ?", (email_id,))
        conn.commit()
    
    return {"success": True}

@app.get("/api/emails/codes")
def get_verification_codes(user: dict = Depends(get_current_user)):
    """获取最近的验证码"""
    user_id = user['id']
    
    with get_db() as conn:
        # 获取最近5分钟内的验证码
        try:
            cursor = conn.execute(f"""
                SELECT id, email, service, code, account_name, is_read, expires_at, created_at
                FROM user_{user_id}_verification_codes
                WHERE created_at > datetime('now', '-5 minutes')
                ORDER BY created_at DESC
                LIMIT 10
            """)
            
            codes = []
            for row in cursor.fetchall():
                codes.append({
                    "id": row["id"],
                    "email": row["email"],
                    "service": row["service"],
                    "code": row["code"],
                    "account_name": row["account_name"],
                    "is_read": bool(row["is_read"]),
                    "expires_at": row["expires_at"],
                    "created_at": row["created_at"]
                })
        except:
            codes = []
    
    return {"codes": codes}

def extract_verification_code(text: str) -> tuple:
    """从文本中提取验证码，返回 (code, service)"""
    import re
    
    # 常见验证码模式 - 按优先级排序（先匹配带服务名的，再匹配通用格式）
    patterns = [
        # 1. 带服务名的模式（优先识别来源）
        (r'(?:Google|谷歌).*?(?:code|验证码)[：:\s]*(\d{4,6})', 'Google'),
        (r'Email verification code[：:\s]*(\d{4,6})', 'Google'),  # Google 专用格式
        (r'(?:Microsoft|微软).*?(?:code|验证码)[：:\s]*(\d{4,6})', 'Microsoft'),
        (r'(?:Apple|苹果).*?(?:code|验证码)[：:\s]*(\d{4,6})', 'Apple'),
        (r'(?:Amazon|亚马逊).*?(?:code|验证码)[：:\s]*(\d{4,6})', 'Amazon'),
        (r'(?:Facebook|脸书|Meta).*?(?:code|验证码)[：:\s]*(\d{4,6})', 'Facebook'),
        (r'(?:Twitter|推特|X).*?(?:code|验证码)[：:\s]*(\d{4,6})', 'Twitter'),
        (r'(?:LinkedIn).*?(?:code|验证码)[：:\s]*(\d{4,6})', 'LinkedIn'),
        (r'(?:GitHub).*?(?:code|验证码)[：:\s]*(\d{4,6})', 'GitHub'),
        (r'(?:Discord).*?(?:code|验证码)[：:\s]*(\d{4,6})', 'Discord'),
        (r'(?:Telegram).*?(?:code|验证码)[：:\s]*(\d{5,6})', 'Telegram'),
        (r'(?:WhatsApp).*?(?:code|验证码)[：:\s]*(\d{4,6})', 'WhatsApp'),
        (r'(?:支付宝|Alipay).*?(?:code|验证码)[：:\s]*(\d{4,6})', '支付宝'),
        (r'(?:微信|WeChat).*?(?:code|验证码)[：:\s]*(\d{4,6})', '微信'),
        (r'(?:淘宝|Taobao).*?(?:code|验证码)[：:\s]*(\d{4,6})', '淘宝'),
        (r'(?:京东|JD).*?(?:code|验证码)[：:\s]*(\d{4,6})', '京东'),
        (r'(?:Steam).*?(?:code|验证码)[：:\s]*(\d{5})', 'Steam'),
        
        # 2. 通用验证码格式（无法识别来源时使用）
        (r'(\d{4,6})\s*(?:是你的|为你的|is your)', 'unknown'),
        (r'(?:verification code|验证码)[：:\s]*(\d{4,6})', 'unknown'),
        (r'(?:code|码)[：:\s]+(\d{4,6})\b', 'unknown'),
    ]
    
    for pattern, service in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return match.group(1), service
    
    # 最后尝试：独立的6位数字（但不要匹配年份等）
    match = re.search(r'(?<![0-9])(\d{6})(?![0-9])', text)
    if match:
        code = match.group(1)
        # 排除可能是年份的数字（如202x, 201x等）
        if not code.startswith('20') and not code.startswith('19'):
            return code, 'unknown'
    
    return None, None

def refresh_gmail_token(refresh_token: str, email_id: int, user_id: int) -> str:
    """使用 refresh_token 刷新 Gmail access_token"""
    import urllib.request
    import urllib.error
    
    # 获取 OAuth 凭证
    client_id, client_secret = get_oauth_credentials('gmail')
    if not client_id or not client_secret:
        return None
    
    # 请求新的 access_token
    token_url = "https://oauth2.googleapis.com/token"
    token_data = urllib.parse.urlencode({
        'client_id': client_id,
        'client_secret': client_secret,
        'refresh_token': refresh_token,
        'grant_type': 'refresh_token'
    }).encode()
    
    try:
        req = urllib.request.Request(token_url, data=token_data, method='POST')
        req.add_header('Content-Type', 'application/x-www-form-urlencoded')
        
        with urllib.request.urlopen(req, timeout=10) as resp:
            token_resp = json.loads(resp.read().decode())
        
        new_access_token = token_resp.get('access_token')
        if not new_access_token:
            return None
        
        # 更新数据库中的凭证
        with get_db() as conn:
            # 获取现有凭证
            cursor = conn.execute(f"SELECT credentials FROM user_{user_id}_emails WHERE id = ?", (email_id,))
            row = cursor.fetchone()
            if row:
                creds = json.loads(decrypt_password(row["credentials"]))
                creds['access_token'] = new_access_token
                # 如果返回了新的 refresh_token，也更新
                if token_resp.get('refresh_token'):
                    creds['refresh_token'] = token_resp['refresh_token']
                if token_resp.get('expires_in'):
                    creds['expires_in'] = token_resp['expires_in']
                
                # 保存更新后的凭证
                conn.execute(
                    f"UPDATE user_{user_id}_emails SET credentials = ? WHERE id = ?",
                    (encrypt_password(json.dumps(creds)), email_id)
                )
                conn.commit()
        
        return new_access_token
    except Exception as e:
        print(f"刷新 Gmail token 失败: {e}")
        return None

def refresh_outlook_token(refresh_token: str, email_id: int, user_id: int) -> str:
    """使用 refresh_token 刷新 Outlook access_token"""
    import urllib.request
    import urllib.error
    
    # 获取 OAuth 凭证
    client_id, client_secret = get_oauth_credentials('outlook')
    if not client_id or not client_secret:
        return None
    
    # 请求新的 access_token
    token_url = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    token_data = urllib.parse.urlencode({
        'client_id': client_id,
        'client_secret': client_secret,
        'refresh_token': refresh_token,
        'grant_type': 'refresh_token',
        'scope': 'https://graph.microsoft.com/Mail.Read offline_access'
    }).encode()
    
    try:
        req = urllib.request.Request(token_url, data=token_data, method='POST')
        req.add_header('Content-Type', 'application/x-www-form-urlencoded')
        
        with urllib.request.urlopen(req, timeout=10) as resp:
            token_resp = json.loads(resp.read().decode())
        
        new_access_token = token_resp.get('access_token')
        if not new_access_token:
            return None
        
        # 更新数据库中的凭证
        with get_db() as conn:
            cursor = conn.execute(f"SELECT credentials FROM user_{user_id}_emails WHERE id = ?", (email_id,))
            row = cursor.fetchone()
            if row:
                creds = json.loads(decrypt_password(row["credentials"]))
                creds['access_token'] = new_access_token
                if token_resp.get('refresh_token'):
                    creds['refresh_token'] = token_resp['refresh_token']
                if token_resp.get('expires_in'):
                    creds['expires_in'] = token_resp['expires_in']
                
                conn.execute(
                    f"UPDATE user_{user_id}_emails SET credentials = ? WHERE id = ?",
                    (encrypt_password(json.dumps(creds)), email_id)
                )
                conn.commit()
        
        return new_access_token
    except Exception as e:
        print(f"刷新 Outlook token 失败: {e}")
        return None

def fetch_imap_emails(email_address: str, creds: dict) -> list:
    """通过 IMAP 获取最近5分钟的邮件"""
    import imaplib
    import email
    from email.header import decode_header
    from email.utils import parsedate_to_datetime
    from datetime import datetime, timedelta, timezone
    
    server = creds.get('server')
    port = creds.get('port', 993)
    password = creds.get('password')
    
    if not server or not password:
        return []
    
    emails_content = []
    
    # 固定查询5分钟前
    since_datetime = datetime.now(timezone.utc) - timedelta(minutes=5)
    
    try:
        # 设置超时，避免卡死
        imaplib.IMAP4.timeout = 10
        imap = imaplib.IMAP4_SSL(server, port)
        imap.login(email_address, password)
        imap.select('INBOX', readonly=True)
        
        # IMAP只支持按日期搜索
        months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
        since_date = f"{since_datetime.day:02d}-{months[since_datetime.month-1]}-{since_datetime.year}"
        status, messages = imap.search(None, f'SINCE {since_date}')
        
        if status != 'OK':
            imap.logout()
            return []
        
        msg_nums = messages[0].split()
        # 只取最近5封
        msg_nums = msg_nums[-5:] if len(msg_nums) > 5 else msg_nums
        
        for num in reversed(msg_nums):  # 从新到旧
            try:
                # 只获取邮件头和文本部分
                status, msg_data = imap.fetch(num, '(BODY.PEEK[HEADER] BODY.PEEK[TEXT])')
                if status != 'OK':
                    continue
                
                # 解析邮件
                raw_header = msg_data[0][1] if msg_data[0] else b''
                raw_body = msg_data[1][1] if len(msg_data) > 1 and msg_data[1] else b''
                
                raw_email = raw_header + b'\r\n' + raw_body
                msg = email.message_from_bytes(raw_email)
                
                # 检查邮件时间，只要最近5分钟的邮件
                date_str = msg.get('Date', '')
                if date_str:
                    try:
                        mail_datetime = parsedate_to_datetime(date_str)
                        if mail_datetime < since_datetime:
                            continue  # 跳过5分钟前的邮件
                    except:
                        pass
                
                # 获取发件人
                from_header = msg.get('From', '')
                
                # 获取邮件内容
                body = ''
                if msg.is_multipart():
                    for part in msg.walk():
                        if part.get_content_type() == 'text/plain':
                            charset = part.get_content_charset() or 'utf-8'
                            try:
                                payload = part.get_payload(decode=True)
                                if payload:
                                    body = payload.decode(charset, errors='ignore')
                            except:
                                pass
                            break
                else:
                    charset = msg.get_content_charset() or 'utf-8'
                    try:
                        payload = msg.get_payload(decode=True)
                        if payload:
                            body = payload.decode(charset, errors='ignore')
                    except:
                        pass
                
                if body:
                    emails_content.append({
                        'from': from_header,
                        'body': body
                    })
            except Exception as e:
                continue
        
        imap.logout()
    except Exception as e:
        print(f"IMAP 获取邮件失败 ({server}): {e}")
    
    return emails_content

def fetch_outlook_emails(access_token: str) -> list:
    """通过 Microsoft Graph API 获取最近5分钟的 Outlook 邮件"""
    import urllib.request
    import urllib.error
    from datetime import datetime, timedelta, timezone
    
    emails_content = []
    
    try:
        # 固定查询最近5分钟
        since_time = datetime.now(timezone.utc) - timedelta(minutes=5)
        since_iso = since_time.strftime('%Y-%m-%dT%H:%M:%SZ')
        
        base_url = "https://graph.microsoft.com/v1.0/me/messages"
        params = [
            "$top=10", 
            "$orderby=receivedDateTime desc", 
            "$select=from,body,subject",
            f"$filter=receivedDateTime ge {since_iso}"
        ]
        
        url = f"{base_url}?{'&'.join(params)}"
        
        req = urllib.request.Request(url)
        req.add_header('Authorization', f'Bearer {access_token}')
        
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        
        for msg in data.get('value', []):
            from_addr = msg.get('from', {}).get('emailAddress', {}).get('address', '')
            body = msg.get('body', {}).get('content', '')
            # 去除 HTML 标签（简单处理）
            import re
            body = re.sub(r'<[^>]+>', '', body)
            
            emails_content.append({
                'from': from_addr,
                'body': body
            })
    except Exception as e:
        print(f"Outlook 获取邮件失败: {e}")

    return emails_content

def _parse_mime_body(raw_email: str) -> str:
    """从 MIME 原始邮件中提取纯文本正文"""
    import email
    import email.policy

    try:
        msg = email.message_from_string(raw_email, policy=email.policy.default)

        # 优先取纯文本
        body = msg.get_body(preferencelist=('plain',))
        if body:
            text = body.get_content()
            if text:
                return text

        # 其次取 HTML 并去标签
        body = msg.get_body(preferencelist=('html',))
        if body:
            html = body.get_content()
            if html:
                import re
                return re.sub(r'<[^>]+>', '', html)

        # 兜底：非 multipart 直接取 payload
        if not msg.is_multipart():
            payload = msg.get_payload(decode=True)
            if payload:
                charset = msg.get_content_charset() or 'utf-8'
                return payload.decode(charset, errors='replace')
    except Exception as e:
        print(f"MIME 解析失败，使用原始内容: {e}")

    return raw_email

def fetch_cloudflare_emails(worker_domain: str, cf_token: str) -> list:
    """通过 CF Worker API 获取邮件"""
    import urllib.request
    import urllib.error

    emails_content = []

    try:
        url = f"https://{worker_domain}/api/mails?limit=10&offset=0"
        req = urllib.request.Request(url)
        req.add_header('Authorization', f'Bearer {cf_token}')
        req.add_header('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')

        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())

        mails = data if isinstance(data, list) else data.get('results', data.get('mails', []))

        for mail in mails:
            from_addr = mail.get('source', mail.get('from', mail.get('sender', '')))
            raw = mail.get('raw', mail.get('text', mail.get('body', mail.get('html', ''))))
            msg_id = mail.get('id', mail.get('messageId', ''))

            # 用 MIME 解析器提取正文（处理 base64/quoted-printable/multipart）
            body = _parse_mime_body(raw)

            emails_content.append({
                'from': from_addr,
                'body': body,
                'msg_id': str(msg_id)
            })
    except Exception as e:
        print(f"Cloudflare 获取邮件失败 ({worker_domain}): {e}")

    return emails_content

@app.post("/api/emails/refresh")
def refresh_emails(data: dict = None, user: dict = Depends(get_current_user)):
    """刷新邮箱，获取最新验证码（支持 Gmail、Outlook、QQ、IMAP）"""
    user_id = user['id']
    new_codes = []
    
    # 获取客户端传来的启动时间戳（只检测此时间之后的邮件）
    with get_db() as conn:
        # 确保 source_msg_id 列存在（兼容旧版升级）
        try:
            conn.execute(f"ALTER TABLE user_{user_id}_verification_codes ADD COLUMN source_msg_id TEXT DEFAULT ''")
            conn.commit()
        except:
            pass
        
        # 获取已授权的邮箱
        try:
            cursor = conn.execute(f"SELECT id, address, provider, credentials FROM user_{user_id}_emails WHERE status = 'active'")
            emails = cursor.fetchall()
        except:
            return {"success": False, "message": "无法获取邮箱列表", "codes": []}
        
        for email_row in emails:
            email_address = email_row["address"]
            email_id = email_row["id"]
            provider = email_row["provider"]
            encrypted_creds = email_row["credentials"]
            
            try:
                creds = json.loads(decrypt_password(encrypted_creds))
                emails_content = []
                
                # ==================== Gmail ====================
                if provider == 'gmail':
                    access_token = creds.get('access_token')
                    refresh_token = creds.get('refresh_token')
                    
                    if not access_token:
                        continue
                    
                    import urllib.request
                    import urllib.error
                    import time
                    
                    # 使用 epoch 时间戳精确查询最近5分钟的邮件
                    # Gmail API 支持 after:EPOCH_SECONDS 格式，比 newer_than 更精确
                    five_minutes_ago = int(time.time()) - 300
                    query = f"after:{five_minutes_ago}"
                    
                    list_url = f"https://gmail.googleapis.com/gmail/v1/users/me/messages?q={urllib.parse.quote(query)}&maxResults=50"
                    
                    # 尝试请求，如果401则刷新token重试
                    messages_data = None
                    for attempt in range(2):
                        req = urllib.request.Request(list_url)
                        req.add_header('Authorization', f'Bearer {access_token}')
                        
                        try:
                            with urllib.request.urlopen(req, timeout=10) as resp:
                                messages_data = json.loads(resp.read().decode())
                            break
                        except urllib.error.HTTPError as e:
                            if e.code == 401 and attempt == 0 and refresh_token:
                                new_token = refresh_gmail_token(refresh_token, email_id, user_id)
                                if new_token:
                                    access_token = new_token
                                    continue
                            break
                    
                    if not messages_data:
                        print(f"[Gmail] {email_address}: messages_data 为空")
                        continue
                    
                    msg_count = len(messages_data.get('messages', []))
                    print(f"[Gmail] {email_address}: 查询 after:{five_minutes_ago}, 获取到 {msg_count} 封邮件")
                    
                    for msg in messages_data.get('messages', []):
                        msg_id = msg['id']
                        detail_url = f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{msg_id}?format=full"
                        req = urllib.request.Request(detail_url)
                        req.add_header('Authorization', f'Bearer {access_token}')
                        
                        try:
                            with urllib.request.urlopen(req, timeout=10) as resp:
                                msg_data = json.loads(resp.read().decode())
                        except:
                            continue
                        
                        snippet = msg_data.get('snippet', '')
                        payload = msg_data.get('payload', {})
                        body_data = ''
                        
                        if 'body' in payload and payload['body'].get('data'):
                            body_data = base64.urlsafe_b64decode(payload['body']['data']).decode('utf-8', errors='ignore')
                        elif 'parts' in payload:
                            for part in payload['parts']:
                                if part.get('mimeType') == 'text/plain' and part.get('body', {}).get('data'):
                                    body_data = base64.urlsafe_b64decode(part['body']['data']).decode('utf-8', errors='ignore')
                                    break
                        
                        from_addr = ''
                        for h in payload.get('headers', []):
                            if h['name'].lower() == 'from':
                                from_addr = h['value']
                                break
                        
                        emails_content.append({
                            'from': from_addr,
                            'body': snippet + ' ' + body_data,
                            'msg_id': msg_id
                        })
                        print(f"[Gmail] 添加邮件: from={from_addr[:30]}..., body长度={len(snippet + body_data)}")
                
                # ==================== Outlook ====================
                elif provider == 'outlook':
                    access_token = creds.get('access_token')
                    refresh_token = creds.get('refresh_token')
                    
                    if not access_token:
                        continue
                    
                    import urllib.request
                    import urllib.error
                    
                    # 尝试获取邮件，如果401则刷新token
                    for attempt in range(2):
                        try:
                            emails_content = fetch_outlook_emails(access_token)
                            break
                        except urllib.error.HTTPError as e:
                            if e.code == 401 and attempt == 0 and refresh_token:
                                new_token = refresh_outlook_token(refresh_token, email_id, user_id)
                                if new_token:
                                    access_token = new_token
                                    continue
                            break
                        except:
                            break
                
                # ==================== QQ / IMAP ====================
                elif provider in ['qq', 'imap']:
                    # 频率限制：防止频繁登录被封号
                    import time
                    now = time.time()
                    last_fetch = imap_last_fetch.get(email_address, 0)
                    if now - last_fetch < IMAP_MIN_INTERVAL:
                        # 距离上次请求不足60秒，跳过
                        continue
                    
                    emails_content = fetch_imap_emails(email_address, creds)
                    imap_last_fetch[email_address] = now  # 更新最后请求时间

                # ==================== Cloudflare ====================
                elif provider == 'cloudflare':
                    cf_token = creds.get('cf_token')
                    worker_domain = creds.get('worker_domain')
                    if cf_token and worker_domain:
                        emails_content = fetch_cloudflare_emails(worker_domain, cf_token)

                # ==================== 提取验证码 ====================
                print(f"[验证码] emails_content 数量: {len(emails_content)}")
                for email_data in emails_content:
                    full_text = email_data.get('body', '')
                    from_addr = email_data.get('from', '')
                    source_msg_id = email_data.get('msg_id', '')
                    
                    code, service = extract_verification_code(full_text)
                    print(f"[验证码] 提取结果: code={code}, service={service}")
                    
                    if code:
                        # 如果服务未识别，用发件人
                        if service == 'unknown':
                            service = from_addr.split('<')[0].strip() or from_addr
                        
                        # 去重检查
                        already_exists = False
                        if source_msg_id:
                            # Gmail/Outlook: 按邮件ID去重，永不重复处理同一封邮件
                            cursor = conn.execute(f"""
                                SELECT id FROM user_{user_id}_verification_codes 
                                WHERE email = ? AND source_msg_id = ?
                            """, (email_address, source_msg_id))
                            already_exists = cursor.fetchone() is not None
                        else:
                            # IMAP等: 保持原有的5分钟窗口去重
                            cursor = conn.execute(f"""
                                SELECT id FROM user_{user_id}_verification_codes 
                                WHERE email = ? AND code = ? AND created_at > datetime('now', '-5 minutes')
                            """, (email_address, code))
                            already_exists = cursor.fetchone() is not None
                        
                        if not already_exists:
                            # 计算过期时间（3分钟后）- 使用 UTC
                            expires_at = (datetime.now(timezone.utc) + timedelta(minutes=3)).strftime('%Y-%m-%dT%H:%M:%SZ')
                            
                            # 验证码有效期3分钟
                            conn.execute(f"""
                                INSERT INTO user_{user_id}_verification_codes 
                                (email, service, code, account_name, is_read, expires_at, created_at, source_msg_id)
                                VALUES (?, ?, ?, ?, 0, datetime('now', '+3 minutes'), datetime('now'), ?)
                            """, (email_address, service[:50], code, '', source_msg_id))
                            conn.commit()
                            
                            print(f"[验证码] ✅ 新验证码已保存: {code} from {service}")
                            
                            new_codes.append({
                                "email": email_address,
                                "service": service,
                                "code": code,
                                "expires_at": expires_at
                            })
                        else:
                            print(f"[验证码] ⏭️ 去重命中: code={code}")
            
            except Exception as e:
                print(f"处理邮箱 {email_address} 失败: {e}")
                continue
    
    return {"success": True, "new_codes": new_codes}

@app.post("/api/emails/codes/{code_id}/read")
def mark_code_read(code_id: int, user: dict = Depends(get_current_user)):
    """标记验证码已读"""
    user_id = user['id']
    
    with get_db() as conn:
        conn.execute(f"UPDATE user_{user_id}_verification_codes SET is_read = 1 WHERE id = ?", (code_id,))
        conn.commit()
    
    return {"success": True}

@app.post("/api/emails/codes/read-all")
def mark_all_codes_read(user: dict = Depends(get_current_user)):
    """标记所有验证码已读"""
    user_id = user['id']
    
    with get_db() as conn:
        conn.execute(f"UPDATE user_{user_id}_verification_codes SET is_read = 1")
        conn.commit()
    
    return {"success": True}


STATIC_DIR = os.path.dirname(os.path.abspath(__file__))

@app.get("/")
def root():
    index_path = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path, media_type="text/html")
    return {"message": "通用账号管家 API v5.1", "docs": "/docs"}

@app.get("/{filename:path}")
def serve_static(filename: str):
    if filename.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")
    
    file_path = os.path.join(STATIC_DIR, filename)
    if os.path.exists(file_path) and os.path.isfile(file_path):
        if filename.endswith(".css"):
            return FileResponse(file_path, media_type="text/css")
        elif filename.endswith(".js"):
            return FileResponse(file_path, media_type="application/javascript")
        elif filename.endswith(".html"):
            return FileResponse(file_path, media_type="text/html")
        else:
            return FileResponse(file_path)
    raise HTTPException(status_code=404, detail="File not found")

# ==================== 启动 ====================

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 9111))
    key_mode = "ENV" if os.environ.get("APP_MASTER_KEY") else "FILE"
    jwt_mode = "ENV" if os.environ.get("JWT_SECRET_KEY") else "DERIVED"
    
    print(f"""
╔══════════════════════════════════════════════════════════════╗
║        🔐 通用账号管家 API v5.1 (安全修复版)                 ║
╠══════════════════════════════════════════════════════════════╣
║  端口: {port:<5}  |  加密密钥: {key_mode:<4}  |  JWT密钥: {jwt_mode:<7}        ║
║  数据库: {DB_PATH:<48} ║
║  CORS 允许域名: {len(ALLOWED_ORIGINS)} 个                                      ║
╠══════════════════════════════════════════════════════════════╣
║  安全修复:                                                   ║
║  ✅ 密码哈希: SHA256 → bcrypt (自动迁移)                     ║
║  ✅ Token: JWT (7天过期，兼容旧Token)                        ║
║  ✅ CORS: 白名单模式                                         ║
║  ✅ 密码强度: 8字符+字母+数字                                ║
║  ✅ URL验证: 防止 javascript: XSS                            ║
║  ✅ 新增备份功能                                             ║
╚══════════════════════════════════════════════════════════════╝
""")
    
    init_db()
    migrate_add_combos_column()
    migrate_add_2fa_columns()
    migrate_add_hidden_column()
    migrate_add_timers_column()
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
