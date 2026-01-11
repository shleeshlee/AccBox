#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通用账号管家 - 后端API v5.0
新增: 自定义属性组系统、自定义账号类型、完整2FA TOTP支持(含Steam Guard)
安全: 环境变量密钥、安全中间件
"""

import os
import json
import sqlite3
import hashlib
import secrets
import base64
import time
from datetime import datetime, timedelta
from contextlib import contextmanager
from fastapi import FastAPI, HTTPException, Depends, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from cryptography.fernet import Fernet
import uvicorn

# 配置 - 支持环境变量覆盖
UNSAFE_DEFAULT_KEY = "DEFAULT_INSECURE_KEY_CHANGE_ME_IMMEDIATELY"
DATA_DIR = os.environ.get("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(DATA_DIR, "accounts.db")
ENCRYPTION_KEY_FILE = os.path.join(DATA_DIR, ".encryption_key")

# 登录失败限制
MAX_LOGIN_ATTEMPTS = 5
LOCKOUT_MINUTES = 15

app = FastAPI(title="通用账号管家 API v5.0")

# ==================== 安全中间件 ====================
@app.middleware("http")
async def security_middleware(request: Request, call_next):
    """阻止访问敏感文件"""
    path = request.url.path.lower()
    if (
        path.endswith(".py") or 
        path.endswith(".db") or 
        path.endswith(".key") or 
        "/data/" in path or
        "/." in path
    ):
        return JSONResponse(status_code=403, content={"detail": "🚫 禁止访问敏感资源"})
    return await call_next(request)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==================== 加密模块 ====================

def get_or_create_encryption_key():
    """获取密钥，优先级: 环境变量 > 文件 > 自动生成"""
    # 1. 优先从环境变量读取
    env_key = os.environ.get("APP_MASTER_KEY")
    if env_key and env_key != UNSAFE_DEFAULT_KEY:
        return env_key.encode()
    
    # 2. 从文件读取
    if os.path.exists(ENCRYPTION_KEY_FILE):
        with open(ENCRYPTION_KEY_FILE, 'rb') as f:
            return f.read()
    
    # 3. 自动生成
    key = Fernet.generate_key()
    with open(ENCRYPTION_KEY_FILE, 'wb') as f:
        f.write(key)
    try:
        os.chmod(ENCRYPTION_KEY_FILE, 0o600)
    except:
        pass
    return key

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
    properties: Dict[int, int] = {}  # {property_group_id: property_value_id} - 保留兼容
    combos: List[List[int]] = []  # 组合标签 [[值ID1, 值ID2], [值ID3, 值ID4, 值ID5], ...]
    tags: List[str] = []
    notes: str = ""

class AccountUpdate(BaseModel):
    type_id: Optional[int] = None
    email: Optional[str] = None
    password: Optional[str] = None
    country: Optional[str] = None
    customName: Optional[str] = None
    properties: Optional[Dict[int, int]] = None
    combos: Optional[List[List[int]]] = None  # 组合标签
    tags: Optional[List[str]] = None
    notes: Optional[str] = None
    is_favorite: Optional[bool] = None

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
        # 迁移：为旧数据库添加avatar列
        try:
            conn.execute("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT '👤'")
        except:
            pass
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
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # 检查是否需要初始化默认数据
        cursor = conn.execute(f"SELECT COUNT(*) FROM user_{user_id}_account_types")
        if cursor.fetchone()[0] == 0:
            # 插入默认账号类型
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
            
            # 插入默认属性组和值
            # 账号状态
            conn.execute(f"INSERT INTO user_{user_id}_property_groups (name, sort_order) VALUES ('账号状态', 0)")
            status_group_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            status_values = [('正常', '#4ade80'), ('受限', '#facc15'), ('不可用', '#f87171')]
            for i, (name, color) in enumerate(status_values):
                conn.execute(f"""
                    INSERT INTO user_{user_id}_property_values (group_id, name, color, sort_order)
                    VALUES (?, ?, ?, ?)
                """, (status_group_id, name, color, i))
            
            # 服务类型
            conn.execute(f"INSERT INTO user_{user_id}_property_groups (name, sort_order) VALUES ('服务类型', 1)")
            service_group_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            service_values = [('CLI', '#a78bfa'), ('Antigravity', '#60a5fa'), ('GCP', '#fb923c'), ('APIKey', '#4ade80'), ('Build', '#22d3ee')]
            for i, (name, color) in enumerate(service_values):
                conn.execute(f"""
                    INSERT INTO user_{user_id}_property_values (group_id, name, color, sort_order)
                    VALUES (?, ?, ?, ?)
                """, (service_group_id, name, color, i))
            
            # 添加一个示例账号
            # 获取刚插入的第一个类型ID（Google）和属性值ID
            cursor = conn.execute(f"SELECT id FROM user_{user_id}_account_types WHERE name='Google' LIMIT 1")
            google_type = cursor.fetchone()
            cursor = conn.execute(f"SELECT id FROM user_{user_id}_property_values WHERE group_id=? AND name='正常' LIMIT 1", (status_group_id,))
            normal_status = cursor.fetchone()
            cursor = conn.execute(f"SELECT id FROM user_{user_id}_property_values WHERE group_id=? AND name='CLI' LIMIT 1", (service_group_id,))
            cli_service = cursor.fetchone()
            
            if google_type and normal_status and cli_service:
                demo_combos = json.dumps([[normal_status[0]], [normal_status[0], cli_service[0]]])
                conn.execute(f"""
                    INSERT INTO user_{user_id}_accounts (type_id, email, password, country, custom_name, combos, tags, notes, is_favorite)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    google_type[0],
                    'demo@example.com',
                    encrypt_password('demo123456'),
                    'CN',
                    '默认账号',
                    demo_combos,
                    json.dumps(['示例']),
                    '这是一个示例账号，你可以删除它并添加自己的账号。',
                    1
                ))
        
        conn.commit()

def migrate_add_combos_column():
    """为现有用户表添加combos列"""
    with get_db() as conn:
        # 获取所有用户
        cursor = conn.execute("SELECT id FROM users")
        users = cursor.fetchall()
        for user in users:
            user_id = user["id"]
            # 检查combos列是否存在
            try:
                conn.execute(f"SELECT combos FROM user_{user_id}_accounts LIMIT 1")
            except sqlite3.OperationalError:
                # 列不存在，添加它
                try:
                    conn.execute(f"ALTER TABLE user_{user_id}_accounts ADD COLUMN combos TEXT DEFAULT '[]'")
                    conn.commit()
                    print(f"✅ 为用户 {user_id} 添加了 combos 列")
                except:
                    pass

# ==================== 工具函数 ====================

def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()

def generate_token() -> str:
    return secrets.token_hex(32)

def get_current_user(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未授权")
    token = authorization.replace("Bearer ", "")
    with get_db() as conn:
        cursor = conn.execute("SELECT id, username FROM users WHERE token = ?", (token,))
        user = cursor.fetchone()
    if not user:
        raise HTTPException(status_code=401, detail="无效令牌")
    return {"id": user["id"], "username": user["username"]}

# ==================== 用户API ====================

@app.post("/api/register")
def register(data: UserRegister):
    if len(data.username) < 2:
        raise HTTPException(status_code=400, detail="用户名至少2个字符")
    if len(data.password) < 4:
        raise HTTPException(status_code=400, detail="密码至少4个字符")
    
    password_hash = hash_password(data.password)
    token = generate_token()
    
    with get_db() as conn:
        try:
            cursor = conn.execute(
                "INSERT INTO users (username, password_hash, token) VALUES (?, ?, ?)",
                (data.username, password_hash, token)
            )
            user_id = cursor.lastrowid
            conn.commit()
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=400, detail="用户名已存在")
    
    init_user_tables(user_id)
    return {"message": "注册成功", "token": token, "user": {"id": user_id, "username": data.username, "avatar": "👤"}}

@app.post("/api/login")
def login(data: UserLogin):
    with get_db() as conn:
        # 检查锁定
        cursor = conn.execute("SELECT login_attempts, locked_until FROM users WHERE username = ?", (data.username,))
        row = cursor.fetchone()
        if row and row["locked_until"]:
            locked_until = datetime.fromisoformat(row["locked_until"])
            if datetime.now() < locked_until:
                remaining = (locked_until - datetime.now()).seconds // 60 + 1
                raise HTTPException(status_code=423, detail=f"账号已锁定，请 {remaining} 分钟后重试")
            else:
                conn.execute("UPDATE users SET login_attempts = 0, locked_until = NULL WHERE username = ?", (data.username,))
        
        password_hash = hash_password(data.password)
        cursor = conn.execute(
            "SELECT id, username, avatar FROM users WHERE username = ? AND password_hash = ?",
            (data.username, password_hash)
        )
        user = cursor.fetchone()
        
        if not user:
            cursor2 = conn.execute("SELECT id FROM users WHERE username = ?", (data.username,))
            if cursor2.fetchone():
                conn.execute("UPDATE users SET login_attempts = login_attempts + 1 WHERE username = ?", (data.username,))
                cursor3 = conn.execute("SELECT login_attempts FROM users WHERE username = ?", (data.username,))
                attempts = cursor3.fetchone()["login_attempts"]
                if attempts >= MAX_LOGIN_ATTEMPTS:
                    locked_until = (datetime.now() + timedelta(minutes=LOCKOUT_MINUTES)).isoformat()
                    conn.execute("UPDATE users SET locked_until = ? WHERE username = ?", (locked_until, data.username))
                    conn.commit()
                    raise HTTPException(status_code=423, detail=f"账号已锁定，请 {LOCKOUT_MINUTES} 分钟后重试")
                conn.commit()
                raise HTTPException(status_code=401, detail=f"密码错误，还剩 {MAX_LOGIN_ATTEMPTS - attempts} 次尝试")
            raise HTTPException(status_code=401, detail="用户名或密码错误")
        
        conn.execute("UPDATE users SET login_attempts = 0, locked_until = NULL WHERE username = ?", (data.username,))
        token = generate_token()
        conn.execute("UPDATE users SET token = ? WHERE id = ?", (token, user["id"]))
        conn.commit()
    
    init_user_tables(user["id"])
    return {"message": "登录成功", "token": token, "user": {"id": user["id"], "username": user["username"], "avatar": user["avatar"] or "👤"}}

@app.post("/api/update-avatar")
def update_avatar(data: UpdateAvatar, user: dict = Depends(get_current_user)):
    """更新用户头像"""
    with get_db() as conn:
        conn.execute("UPDATE users SET avatar = ? WHERE id = ?", (data.avatar, user["id"]))
        conn.commit()
    return {"message": "头像更新成功", "avatar": data.avatar}

@app.post("/api/change-password")
def change_password(data: ChangePassword, user: dict = Depends(get_current_user)):
    """修改当前用户密码"""
    old_hash = hash_password(data.old_password)
    new_hash = hash_password(data.new_password)
    
    with get_db() as conn:
        # 验证旧密码
        cursor = conn.execute("SELECT password_hash FROM users WHERE id = ?", (user["id"],))
        row = cursor.fetchone()
        if not row or row["password_hash"] != old_hash:
            raise HTTPException(status_code=400, detail="当前密码错误")
        
        # 更新新密码
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (new_hash, user["id"]))
        conn.commit()
    
    return {"message": "密码修改成功"}

# ==================== 账号类型API ====================

@app.get("/api/account-types")
def get_account_types(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        cursor = conn.execute(f"SELECT * FROM user_{user['id']}_account_types ORDER BY sort_order, id")
        rows = cursor.fetchall()
    return {"types": [dict(row) for row in rows]}

@app.post("/api/account-types")
def create_account_type(data: AccountTypeCreate, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        cursor = conn.execute(f"""
            INSERT INTO user_{user['id']}_account_types (name, icon, color, login_url)
            VALUES (?, ?, ?, ?)
        """, (data.name, data.icon, data.color, data.login_url))
        conn.commit()
        return {"message": "创建成功", "id": cursor.lastrowid}

@app.put("/api/account-types/{type_id}")
def update_account_type(type_id: int, data: AccountTypeUpdate, user: dict = Depends(get_current_user)):
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

# ==================== 属性组API ====================

@app.get("/api/property-groups")
def get_property_groups(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        groups = []
        cursor = conn.execute(f"SELECT * FROM user_{user['id']}_property_groups ORDER BY sort_order, id")
        for row in cursor.fetchall():
            group = dict(row)
            values_cursor = conn.execute(f"""
                SELECT * FROM user_{user['id']}_property_values 
                WHERE group_id = ? ORDER BY sort_order, id
            """, (group['id'],))
            group['values'] = [dict(v) for v in values_cursor.fetchall()]
            groups.append(group)
    return {"groups": groups}

@app.post("/api/property-groups")
def create_property_group(data: PropertyGroupCreate, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        cursor = conn.execute(f"""
            INSERT INTO user_{user['id']}_property_groups (name) VALUES (?)
        """, (data.name,))
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
        conn.execute(f"DELETE FROM user_{user['id']}_property_groups WHERE id = ?", (group_id,))
        conn.commit()
    return {"message": "删除成功"}

# ==================== 属性值API ====================

@app.post("/api/property-values")
def create_property_value(data: PropertyValueCreate, user: dict = Depends(get_current_user)):
    with get_db() as conn:
        cursor = conn.execute(f"""
            INSERT INTO user_{user['id']}_property_values (group_id, name, color)
            VALUES (?, ?, ?)
        """, (data.group_id, data.name, data.color))
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
        conn.execute(f"DELETE FROM user_{user['id']}_property_values WHERE id = ?", (value_id,))
        conn.commit()
    return {"message": "删除成功"}

# ==================== 账号API ====================

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
        # 检查是否有 totp_secret 字段（2FA）
        has_2fa = False
        try:
            has_2fa = bool(row["totp_secret"]) if "totp_secret" in row.keys() else False
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
            "last_used": row["last_used"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"]
        })
    return {"accounts": accounts}

@app.post("/api/accounts")
def create_account(data: AccountCreate, user: dict = Depends(get_current_user)):
    now = datetime.now().isoformat()
    encrypted_pwd = encrypt_password(data.password) if data.password else ""
    
    with get_db() as conn:
        cursor = conn.execute(f"""
            INSERT INTO user_{user['id']}_accounts 
            (type_id, email, password, country, custom_name, properties, combos, tags, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            data.type_id, data.email, encrypted_pwd, data.country, data.customName,
            json.dumps(data.properties),
            json.dumps(data.combos),
            json.dumps(data.tags, ensure_ascii=False),
            data.notes, now, now
        ))
        conn.commit()
    return {"message": "创建成功", "id": cursor.lastrowid}

@app.put("/api/accounts/{account_id}")
def update_account(account_id: int, data: AccountUpdate, user: dict = Depends(get_current_user)):
    now = datetime.now().isoformat()
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
    now = datetime.now().isoformat()
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

# ==================== 导入导出API ====================

@app.get("/api/export")
def export_data(user: dict = Depends(get_current_user)):
    with get_db() as conn:
        # 导出账号类型
        types_cursor = conn.execute(f"SELECT * FROM user_{user['id']}_account_types ORDER BY sort_order")
        types = [dict(row) for row in types_cursor.fetchall()]
        
        # 导出属性组和值
        groups = []
        groups_cursor = conn.execute(f"SELECT * FROM user_{user['id']}_property_groups ORDER BY sort_order")
        for row in groups_cursor.fetchall():
            group = dict(row)
            values_cursor = conn.execute(f"SELECT * FROM user_{user['id']}_property_values WHERE group_id = ? ORDER BY sort_order", (group['id'],))
            group['values'] = [dict(v) for v in values_cursor.fetchall()]
            groups.append(group)
        
        # 导出账号
        accounts_cursor = conn.execute(f"SELECT * FROM user_{user['id']}_accounts")
        accounts = []
        for row in accounts_cursor.fetchall():
            accounts.append({
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
                "created_at": row["created_at"]
            })
    
    return {
        "version": "4.0",
        "exported_at": datetime.now().isoformat(),
        "user": user["username"],
        "account_types": types,
        "property_groups": groups,
        "accounts": accounts
    }

@app.post("/api/import")
def import_data(data: dict, user: dict = Depends(get_current_user)):
    """
    完整导入功能，支持：
    - 导入账号类型（按名称匹配，避免重复）
    - 导入属性组和属性值（按名称匹配，避免重复）
    - 导入账号（支持 skip/overwrite/all 模式）
    - 自动映射旧ID到新ID
    """
    if "accounts" not in data:
        raise HTTPException(status_code=400, detail="无效的导入数据")
    
    now = datetime.now().isoformat()
    import_mode = data.get("import_mode", "all")  # all, skip, overwrite
    
    imported_accounts = 0
    updated_accounts = 0
    skipped_accounts = 0
    imported_types = 0
    imported_groups = 0
    imported_values = 0
    
    # ID映射表：旧ID -> 新ID
    type_id_map = {}
    value_id_map = {}
    
    with get_db() as conn:
        # ========== 步骤1：导入账号类型（按名称匹配或新建） ==========
        if "account_types" in data:
            # 获取现有类型
            existing_types = {}
            cursor = conn.execute(f"SELECT id, name FROM user_{user['id']}_account_types")
            for row in cursor.fetchall():
                existing_types[row["name"].lower()] = row["id"]
            
            for old_type in data["account_types"]:
                old_id = old_type.get("id")
                name = old_type.get("name", "")
                name_lower = name.lower()
                
                if name_lower in existing_types:
                    # 已存在同名类型，复用
                    type_id_map[old_id] = existing_types[name_lower]
                else:
                    # 新建类型
                    cursor = conn.execute(f"""
                        INSERT INTO user_{user['id']}_account_types (name, icon, color, login_url, sort_order)
                        VALUES (?, ?, ?, ?, ?)
                    """, (
                        name,
                        old_type.get("icon", "🔑"),
                        old_type.get("color", "#8b5cf6"),
                        old_type.get("login_url", ""),
                        old_type.get("sort_order", 0)
                    ))
                    new_id = cursor.lastrowid
                    type_id_map[old_id] = new_id
                    existing_types[name_lower] = new_id
                    imported_types += 1
        
        # ========== 步骤2：导入属性组和属性值（按名称匹配或新建） ==========
        if "property_groups" in data:
            # 获取现有属性组
            existing_groups = {}
            cursor = conn.execute(f"SELECT id, name FROM user_{user['id']}_property_groups")
            for row in cursor.fetchall():
                existing_groups[row["name"].lower()] = row["id"]
            
            # 获取现有属性值（按组ID分组）
            existing_values = {}  # {group_id: {name_lower: value_id}}
            cursor = conn.execute(f"SELECT id, group_id, name FROM user_{user['id']}_property_values")
            for row in cursor.fetchall():
                gid = row["group_id"]
                if gid not in existing_values:
                    existing_values[gid] = {}
                existing_values[gid][row["name"].lower()] = row["id"]
            
            for old_group in data["property_groups"]:
                old_group_id = old_group.get("id")
                group_name = old_group.get("name", "")
                group_name_lower = group_name.lower()
                
                if group_name_lower in existing_groups:
                    # 已存在同名组，复用
                    new_group_id = existing_groups[group_name_lower]
                else:
                    # 新建组
                    cursor = conn.execute(f"""
                        INSERT INTO user_{user['id']}_property_groups (name, sort_order)
                        VALUES (?, ?)
                    """, (group_name, old_group.get("sort_order", 0)))
                    new_group_id = cursor.lastrowid
                    existing_groups[group_name_lower] = new_group_id
                    existing_values[new_group_id] = {}
                    imported_groups += 1
                
                # 导入该组的属性值
                for old_value in old_group.get("values", []):
                    old_value_id = old_value.get("id")
                    value_name = old_value.get("name", "")
                    value_name_lower = value_name.lower()
                    
                    group_values = existing_values.get(new_group_id, {})
                    if value_name_lower in group_values:
                        # 已存在同名值，复用
                        value_id_map[old_value_id] = group_values[value_name_lower]
                    else:
                        # 新建值
                        cursor = conn.execute(f"""
                            INSERT INTO user_{user['id']}_property_values (group_id, name, color, sort_order)
                            VALUES (?, ?, ?, ?)
                        """, (
                            new_group_id,
                            value_name,
                            old_value.get("color", "#8b5cf6"),
                            old_value.get("sort_order", 0)
                        ))
                        new_value_id = cursor.lastrowid
                        value_id_map[old_value_id] = new_value_id
                        if new_group_id not in existing_values:
                            existing_values[new_group_id] = {}
                        existing_values[new_group_id][value_name_lower] = new_value_id
                        imported_values += 1
        
        # ========== 步骤3：获取现有账号（用于重复检测） ==========
        existing_accounts = {}
        if import_mode in ("skip", "overwrite"):
            cursor = conn.execute(f"SELECT id, email FROM user_{user['id']}_accounts WHERE email != ''")
            for row in cursor.fetchall():
                existing_accounts[row["email"].lower()] = row["id"]
        
        # ========== 步骤4：导入账号 ==========
        for acc in data["accounts"]:
            try:
                email = acc.get("email", "")
                email_lower = email.lower() if email else ""
                existing_id = existing_accounts.get(email_lower) if email_lower else None
                
                # 映射 type_id（如果有映射表则转换，否则保持原值）
                old_type_id = acc.get("type_id")
                new_type_id = type_id_map.get(old_type_id, old_type_id) if old_type_id else None
                
                # 映射 combos 中的属性值ID
                old_combos = acc.get("combos", [])
                new_combos = []
                for combo in old_combos:
                    if isinstance(combo, list):
                        new_combo = [value_id_map.get(vid, vid) for vid in combo]
                        new_combos.append(new_combo)
                
                # 映射 properties 中的属性值ID（旧格式兼容）
                old_properties = acc.get("properties", {})
                new_properties = {}
                for k, v in old_properties.items():
                    new_k = str(k)  # key可能是字符串
                    new_properties[new_k] = value_id_map.get(v, v)
                
                if existing_id:
                    # 账号已存在
                    if import_mode == "skip":
                        skipped_accounts += 1
                        continue
                    elif import_mode == "overwrite":
                        # 更新现有账号
                        conn.execute(f"""
                            UPDATE user_{user['id']}_accounts SET
                            type_id = ?, password = ?, country = ?, custom_name = ?,
                            properties = ?, combos = ?, tags = ?, notes = ?,
                            is_favorite = ?, updated_at = ?
                            WHERE id = ?
                        """, (
                            new_type_id,
                            encrypt_password(acc.get("password", "")),
                            acc.get("country", "🌍"),
                            acc.get("customName", ""),
                            json.dumps(new_properties),
                            json.dumps(new_combos),
                            json.dumps(acc.get("tags", []), ensure_ascii=False),
                            acc.get("notes", ""),
                            1 if acc.get("is_favorite") else 0,
                            now,
                            existing_id
                        ))
                        updated_accounts += 1
                        continue
                
                # 新建账号
                conn.execute(f"""
                    INSERT INTO user_{user['id']}_accounts 
                    (type_id, email, password, country, custom_name, properties, combos, tags, notes, is_favorite, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    new_type_id,
                    email,
                    encrypt_password(acc.get("password", "")),
                    acc.get("country", "🌍"),
                    acc.get("customName", ""),
                    json.dumps(new_properties),
                    json.dumps(new_combos),
                    json.dumps(acc.get("tags", []), ensure_ascii=False),
                    acc.get("notes", ""),
                    1 if acc.get("is_favorite") else 0,
                    acc.get("created_at", now),
                    now
                ))
                imported_accounts += 1
            except Exception as e:
                print(f"导入账号失败: {e}")
        
        conn.commit()
    
    # 构建返回消息
    parts = []
    if imported_types > 0:
        parts.append(f"类型 {imported_types} 个")
    if imported_groups > 0:
        parts.append(f"属性组 {imported_groups} 个")
    if imported_values > 0:
        parts.append(f"属性值 {imported_values} 个")
    if imported_accounts > 0:
        parts.append(f"新增账号 {imported_accounts} 个")
    if updated_accounts > 0:
        parts.append(f"覆盖账号 {updated_accounts} 个")
    if skipped_accounts > 0:
        parts.append(f"跳过 {skipped_accounts} 个")
    
    message = "成功导入：" + "，".join(parts) if parts else "没有数据被导入"
    return {
        "message": message, 
        "imported_types": imported_types,
        "imported_groups": imported_groups,
        "imported_values": imported_values,
        "imported": imported_accounts, 
        "updated": updated_accounts, 
        "skipped": skipped_accounts
    }

@app.post("/api/import-csv")
def import_csv(data: dict, user: dict = Depends(get_current_user)):
    csv_text = data.get("csv", "")
    if not csv_text:
        raise HTTPException(status_code=400, detail="CSV内容为空")
    
    now = datetime.now().isoformat()
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

# ==================== v5.0 新增：2FA TOTP API ====================
import hmac
import struct
import re

STEAM_CHARS = "23456789BCDFGHJKMNPQRTVWXY"

def generate_totp(secret: str, time_offset: int = 0, digits: int = 6, period: int = 30, algorithm: str = "SHA1") -> str:
    """生成标准 TOTP 验证码"""
    try:
        import hashlib
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
    """生成 Steam Guard 验证码"""
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
    """解析 otpauth:// URI"""
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

class TOTPCreate(BaseModel):
    secret: str
    issuer: str = ""
    totp_type: str = "totp"
    algorithm: str = "SHA1"
    digits: int = 6
    period: int = 30
    backup_codes: List[str] = []

# 数据库迁移：添加 2FA 字段
def migrate_add_2fa_columns():
    """为现有用户表添加 2FA 相关字段"""
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

@app.post("/api/accounts/{account_id}/totp")
def set_account_totp(account_id: int, data: TOTPCreate, user: dict = Depends(get_current_user)):
    """配置账号的 2FA"""
    with get_db() as conn:
        row = conn.execute(f"SELECT id FROM user_{user['id']}_accounts WHERE id = ?", (account_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="账号不存在")
        conn.execute(f"""UPDATE user_{user['id']}_accounts 
            SET totp_secret=?, totp_issuer=?, totp_type=?, totp_algorithm=?, totp_digits=?, totp_period=?, backup_codes=?, updated_at=?
            WHERE id=?""",
            (encrypt_password(data.secret), data.issuer, data.totp_type, data.algorithm, data.digits, data.period, 
             json.dumps(data.backup_codes), datetime.now().isoformat(), account_id))
        conn.commit()
    return {"message": "2FA 配置已保存"}

@app.get("/api/accounts/{account_id}/totp")
def get_account_totp(account_id: int, user: dict = Depends(get_current_user)):
    """获取账号的 2FA 配置（解密密钥供前端生成验证码）"""
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
    """生成当前 2FA 验证码（支持标准TOTP和Steam Guard）"""
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
        code = generate_totp(
            secret,
            time_offset=time_offset,
            digits=row["totp_digits"] or 6,
            period=period,
            algorithm=row["totp_algorithm"] or "SHA1"
        )
    
    remaining = period - ((int(time.time()) + time_offset) % period)
    
    return {
        "code": code,
        "type": totp_type,
        "remaining": remaining,
        "period": period
    }

@app.delete("/api/accounts/{account_id}/totp")
def delete_account_totp(account_id: int, user: dict = Depends(get_current_user)):
    """删除账号的 2FA 配置"""
    with get_db() as conn:
        conn.execute(f"""UPDATE user_{user['id']}_accounts 
            SET totp_secret='', totp_issuer='', totp_type='', backup_codes='[]', updated_at=?
            WHERE id=?""", (datetime.now().isoformat(), account_id))
        conn.commit()
    return {"message": "2FA 配置已删除"}

@app.post("/api/accounts/{account_id}/totp/parse")
def parse_totp_uri(account_id: int, data: dict, user: dict = Depends(get_current_user)):
    """从 otpauth:// URI 导入 2FA 配置"""
    parsed = parse_otpauth_uri(data.get("uri", ""))
    if not parsed:
        raise HTTPException(status_code=400, detail="无效的 otpauth URI")
    with get_db() as conn:
        conn.execute(f"""UPDATE user_{user['id']}_accounts 
            SET totp_secret=?, totp_issuer=?, totp_type=?, totp_algorithm=?, totp_digits=?, totp_period=?, updated_at=?
            WHERE id=?""",
            (encrypt_password(parsed["secret"]), parsed["issuer"] or parsed["label"], parsed["type"], 
             parsed["algorithm"], parsed["digits"], parsed["period"], datetime.now().isoformat(), account_id))
        conn.commit()
    return {"message": "2FA 配置已从 URI 导入", "parsed": {k: v for k, v in parsed.items() if k != "secret"}}

@app.get("/api/health")
def health_check():
    current_key = os.environ.get("APP_MASTER_KEY", "")
    if not current_key:
        key_status = "file_based"
    elif current_key == UNSAFE_DEFAULT_KEY:
        key_status = "unsafe_default"
    else:
        key_status = "secure"
    return {"status": "ok", "version": "5.0", "key_status": key_status, "time": datetime.now().isoformat()}

@app.get("/")
def root():
    return {"message": "通用账号管家 API v5.0", "docs": "/docs"}

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 9111))
    key_mode = "ENV" if os.environ.get("APP_MASTER_KEY") else "FILE"
    print(f"🔐 通用账号管家 API v5.0 启动中... 端口: {port} | 密钥: {key_mode}")
    print(f"📁 数据库路径: {DB_PATH}")
    init_db()
    migrate_add_combos_column()  # 数据库迁移
    migrate_add_2fa_columns()    # 2FA字段迁移
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
