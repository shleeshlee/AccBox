#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通用账号管家 - 后端API v4.0
新增: 自定义属性组系统、自定义账号类型、优化的数据结构
"""

import os
import json
import sqlite3
import hashlib
import secrets
from datetime import datetime, timedelta
from contextlib import contextmanager
from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from cryptography.fernet import Fernet
import uvicorn

# 配置 - 支持环境变量覆盖
DATA_DIR = os.environ.get("DATA_DIR", os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(DATA_DIR, "accounts.db")
ENCRYPTION_KEY_FILE = os.path.join(DATA_DIR, ".encryption_key")

# 登录失败限制
MAX_LOGIN_ATTEMPTS = 5
LOCKOUT_MINUTES = 15

app = FastAPI(title="通用账号管家 API v4.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==================== 加密模块 ====================

def get_or_create_encryption_key():
    if os.path.exists(ENCRYPTION_KEY_FILE):
        with open(ENCRYPTION_KEY_FILE, 'rb') as f:
            return f.read()
    else:
        key = Fernet.generate_key()
        with open(ENCRYPTION_KEY_FILE, 'wb') as f:
            f.write(key)
        os.chmod(ENCRYPTION_KEY_FILE, 0o600)
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
    if "accounts" not in data:
        raise HTTPException(status_code=400, detail="无效的导入数据")
    
    now = datetime.now().isoformat()
    imported_accounts = 0
    
    with get_db() as conn:
        for acc in data["accounts"]:
            try:
                conn.execute(f"""
                    INSERT INTO user_{user['id']}_accounts 
                    (type_id, email, password, country, custom_name, properties, tags, notes, is_favorite, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    acc.get("type_id"),
                    acc.get("email", ""),
                    encrypt_password(acc.get("password", "")),
                    acc.get("country", "🌍"),
                    acc.get("customName", ""),
                    json.dumps(acc.get("properties", {})),
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
    
    return {"message": f"成功导入 {imported_accounts} 个账号"}

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

@app.get("/api/health")
def health_check():
    return {"status": "ok", "version": "4.0", "time": datetime.now().isoformat()}

@app.get("/")
def root():
    return {"message": "通用账号管家 API v4.0", "docs": "/docs"}

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 9111))
    print(f"🔐 通用账号管家 API 启动中... 端口: {port}")
    print(f"📁 数据库路径: {DB_PATH}")
    init_db()
    migrate_add_combos_column()  # 数据库迁移
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
