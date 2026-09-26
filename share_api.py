"""
分享链接（给队友看安全码）

独立模块：所有依赖（数据库、加解密、TOTP、密码哈希、JWT、收信）由 main.py 通过 setup() 注入，
本文件不读取任何全局变量，可以整体剥离。

安全模型（2026-09-26 拍板 B）：
- 链接 token（24 位随机）+ 口令；口令通过后签发访客 JWT（scope=share），存在访客浏览器。
- 访客所有查询都以分享记录里写死的 account_ids / 对应邮箱地址过滤，没有"列全部"的接口。
- 访客永远拿不到：TOTP 密钥、备用码、邮箱授权凭据、组合/属性/标签、导出、删除。
- 访客只能改：密码（同步回主人的卡，记旧值）和"他自己的备注"（存 share_notes，主人的备注不给他看、他的也不覆盖主人的）。
- 没有任何把卡片复制/转移给访客的接口：分享的意思是"看和用"，不是"给"。
"""
import json
import secrets
import threading
import time
from collections import deque
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, HTTPException, Request, Header, Cookie
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel
from jose import jwt, JWTError

router = APIRouter()
_d: Dict[str, Any] = {}          # 注入的依赖

DEFAULT_PERMS = {"totp": True, "password": True, "edit": True, "mail_codes": True}
PIN_MAX_ATTEMPTS = 5
PIN_LOCK_MINUTES = 15
GUEST_TOKEN_DAYS = 60
GUEST_RATE_PER_MIN = 120
UNLOCK_RATE_PER_MIN = 20
REFRESH_MIN_INTERVAL = 10        # 秒，访客触发收信的最小间隔


# ==================== 依赖注入 ====================

def setup(app, **deps):
    """main.py 调用：share_api.setup(app, get_db=..., ...)"""
    required = ["get_db", "get_current_user", "encrypt", "decrypt", "generate_totp", "generate_steam_code",
                "hash_password", "verify_password",
                "jwt_secret", "jwt_algorithm",
                "refresh_mailboxes", "static_dir"]
    missing = [k for k in required if k not in deps]
    if missing:
        raise RuntimeError(f"share_api.setup 缺少依赖: {missing}")
    _d.update(deps)
    _ensure_tables()
    app.include_router(router)


def _ensure_tables():
    with _d["get_db"]() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS shares (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_id INTEGER NOT NULL,
                token TEXT NOT NULL UNIQUE,
                name TEXT DEFAULT '',
                account_ids TEXT NOT NULL DEFAULT '[]',
                perms TEXT NOT NULL DEFAULT '{}',
                pin_hash TEXT NOT NULL,
                pin_attempts INTEGER DEFAULT 0,
                pin_locked_until TEXT,
                status TEXT DEFAULT 'active',
                created_at TEXT,
                last_opened_at TEXT,
                open_count INTEGER DEFAULT 0,
                revoked_at TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS share_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                share_id INTEGER NOT NULL,
                action TEXT NOT NULL,
                account_id INTEGER,
                detail TEXT DEFAULT '',
                ip TEXT DEFAULT '',
                created_at TEXT
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_share_logs_share ON share_logs(share_id, id)")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS share_notes (
                share_id INTEGER NOT NULL,
                account_id INTEGER NOT NULL,
                note TEXT DEFAULT '',
                updated_at TEXT,
                PRIMARY KEY (share_id, account_id)
            )
        """)
        conn.commit()


# ==================== 小工具 ====================

def _now() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _parse_ts(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00'))
    except ValueError:
        return None


def _client_ip(request: Request) -> str:
    return (request.headers.get("x-real-ip")
            or (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
            or (request.client.host if request.client else ""))


_rate_lock = threading.Lock()
_rate: Dict[str, deque] = {}


def _rate_check(key: str, limit: int, window: int = 60):
    """简单滑动窗口限速；超限抛 429。"""
    now = time.time()
    with _rate_lock:
        q = _rate.setdefault(key, deque())
        while q and q[0] < now - window:
            q.popleft()
        if len(q) >= limit:
            raise HTTPException(status_code=429, detail="请求太频繁，稍等一下")
        q.append(now)


def _log(conn, share_id: int, action: str, ip: str, account_id: Optional[int] = None, detail: Any = ""):
    conn.execute(
        "INSERT INTO share_logs (share_id, action, account_id, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (share_id, action, account_id, json.dumps(detail, ensure_ascii=False) if not isinstance(detail, str) else detail, ip, _now()),
    )


def _share_row_to_dict(row) -> dict:
    d = dict(row)
    d["account_ids"] = json.loads(d.get("account_ids") or "[]")
    perms = dict(DEFAULT_PERMS)
    try:
        perms.update(json.loads(d.get("perms") or "{}"))
    except ValueError:
        pass
    perms["totp"] = True                      # 安全码是这个功能存在的理由，不可关
    d["perms"] = perms
    d.pop("pin_hash", None)
    return d


def _load_share(token: str, require_active: bool = True) -> dict:
    with _d["get_db"]() as conn:
        row = conn.execute("SELECT * FROM shares WHERE token = ?", (token,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="链接不存在")
    share = _share_row_to_dict(row)
    share["_pin_hash"] = row["pin_hash"]
    if require_active and share["status"] != "active":
        raise HTTPException(status_code=410, detail="链接已被关闭")
    return share


def _listed_ids(share: dict) -> List[int]:
    return [int(i) for i in share["account_ids"]]


def _owner_accounts(conn, owner_id: int, ids: List[int]):
    """只取清单内的账号，且按清单顺序返回。"""
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    rows = conn.execute(f"""
        SELECT a.*, t.name AS type_name, t.icon AS type_icon, t.color AS type_color
        FROM user_{owner_id}_accounts a
        LEFT JOIN user_{owner_id}_account_types t ON t.id = a.type_id
        WHERE a.id IN ({marks})
    """, ids).fetchall()
    by_id = {r["id"]: r for r in rows}
    return [by_id[i] for i in ids if i in by_id]


def _listed_emails(share: dict) -> List[str]:
    with _d["get_db"]() as conn:
        rows = _owner_accounts(conn, share["owner_id"], _listed_ids(share))
    return sorted({(r["email"] or "").strip().lower() for r in rows if r["email"]})


# ==================== 主人侧 ====================

def _owner(request: Request, authorization: str = Header(None), auth_token: str = Cookie(None)) -> dict:
    return _d["get_current_user"](request, authorization, auth_token)


class ShareCreate(BaseModel):
    name: str = ""
    account_ids: List[int]
    perms: Optional[Dict[str, bool]] = None
    pin: str


class SharePin(BaseModel):
    pin: str


def _validate_pin(pin: str):
    pin = (pin or "").strip()
    if not (4 <= len(pin) <= 16):
        raise HTTPException(status_code=400, detail="口令要 4~16 位")
    return pin


@router.post("/api/shares")
def create_share(data: ShareCreate, request: Request, authorization: str = Header(None), auth_token: str = Cookie(None)):
    user = _owner(request, authorization, auth_token)
    pin = _validate_pin(data.pin)
    ids = sorted({int(i) for i in data.account_ids})
    if not ids:
        raise HTTPException(status_code=400, detail="至少选一张卡")
    perms = dict(DEFAULT_PERMS)
    if data.perms:
        for k in DEFAULT_PERMS:
            if k in data.perms:
                perms[k] = bool(data.perms[k])
    perms["totp"] = True

    with _d["get_db"]() as conn:
        # 清单里的每一张卡都必须是本人的
        marks = ",".join("?" * len(ids))
        owned = {r["id"] for r in conn.execute(f"SELECT id FROM user_{user['id']}_accounts WHERE id IN ({marks})", ids)}
        bad = [i for i in ids if i not in owned]
        if bad:
            raise HTTPException(status_code=400, detail=f"有 {len(bad)} 张卡不在你的账号里")
        token = secrets.token_urlsafe(18)
        cur = conn.execute(
            "INSERT INTO shares (owner_id, token, name, account_ids, perms, pin_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
            (user["id"], token, (data.name or "").strip()[:40], json.dumps(ids), json.dumps(perms), _d["hash_password"](pin), _now()),
        )
        share_id = cur.lastrowid
        _log(conn, share_id, "created", _client_ip(request), None, {"count": len(ids)})
        conn.commit()
    return {"id": share_id, "token": token, "path": f"/s/{token}", "account_ids": ids, "perms": perms}


@router.get("/api/shares")
def list_shares(request: Request, authorization: str = Header(None), auth_token: str = Cookie(None)):
    user = _owner(request, authorization, auth_token)
    with _d["get_db"]() as conn:
        rows = conn.execute("SELECT * FROM shares WHERE owner_id = ? ORDER BY id DESC", (user["id"],)).fetchall()
        out = []
        for r in rows:
            s = _share_row_to_dict(r)
            edits = conn.execute("SELECT COUNT(*) FROM share_logs WHERE share_id = ? AND action = 'edit'", (s["id"],)).fetchone()[0]
            s["edit_count"] = edits
            s["path"] = f"/s/{s['token']}"
            out.append(s)
    return {"shares": out}


def _owned_share(conn, user_id: int, share_id: int):
    row = conn.execute("SELECT * FROM shares WHERE id = ? AND owner_id = ?", (share_id, user_id)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="分享不存在")
    return row


@router.post("/api/shares/{share_id}/revoke")
def revoke_share(share_id: int, request: Request, authorization: str = Header(None), auth_token: str = Cookie(None)):
    user = _owner(request, authorization, auth_token)
    with _d["get_db"]() as conn:
        _owned_share(conn, user["id"], share_id)
        conn.execute("UPDATE shares SET status = 'revoked', revoked_at = ? WHERE id = ?", (_now(), share_id))
        _log(conn, share_id, "revoked", _client_ip(request))
        conn.commit()
    return {"message": "已作废"}


@router.post("/api/shares/{share_id}/restore")
def restore_share(share_id: int, request: Request, authorization: str = Header(None), auth_token: str = Cookie(None)):
    user = _owner(request, authorization, auth_token)
    with _d["get_db"]() as conn:
        row = _owned_share(conn, user["id"], share_id)
        conn.execute("UPDATE shares SET status = 'active', revoked_at = NULL, pin_attempts = 0, pin_locked_until = NULL WHERE id = ?", (share_id,))
        _log(conn, share_id, "restored", _client_ip(request))
        conn.commit()
    return {"message": "已恢复"}


@router.post("/api/shares/{share_id}/pin")
def reset_share_pin(share_id: int, data: SharePin, request: Request, authorization: str = Header(None), auth_token: str = Cookie(None)):
    user = _owner(request, authorization, auth_token)
    pin = _validate_pin(data.pin)
    with _d["get_db"]() as conn:
        _owned_share(conn, user["id"], share_id)
        conn.execute("UPDATE shares SET pin_hash = ?, pin_attempts = 0, pin_locked_until = NULL WHERE id = ?", (_d["hash_password"](pin), share_id))
        _log(conn, share_id, "pin_reset", _client_ip(request))
        conn.commit()
    return {"message": "口令已更新，对方已记住的设备要重新输一次"}


@router.delete("/api/shares/{share_id}")
def delete_share(share_id: int, request: Request, authorization: str = Header(None), auth_token: str = Cookie(None)):
    user = _owner(request, authorization, auth_token)
    with _d["get_db"]() as conn:
        _owned_share(conn, user["id"], share_id)
        conn.execute("DELETE FROM share_logs WHERE share_id = ?", (share_id,))
        conn.execute("DELETE FROM share_notes WHERE share_id = ?", (share_id,))
        conn.execute("DELETE FROM shares WHERE id = ?", (share_id,))
        conn.commit()
    return {"message": "已删除"}


@router.get("/api/shares/{share_id}/logs")
def share_logs(share_id: int, request: Request, authorization: str = Header(None), auth_token: str = Cookie(None)):
    user = _owner(request, authorization, auth_token)
    with _d["get_db"]() as conn:
        _owned_share(conn, user["id"], share_id)
        rows = conn.execute("SELECT * FROM share_logs WHERE share_id = ? ORDER BY id DESC LIMIT 200", (share_id,)).fetchall()
        logs = []
        for r in rows:
            item = dict(r)
            try:
                detail = json.loads(item["detail"]) if item["detail"] else {}
            except ValueError:
                detail = {"raw": item["detail"]}
            if isinstance(detail, dict) and detail.get("field") == "password" and detail.get("old_enc"):
                try:
                    detail["old"] = _d["decrypt"](detail.pop("old_enc"))
                except Exception:
                    detail["old"] = ""
            item["detail"] = detail
            logs.append(item)
    return {"logs": logs}


# ==================== 访客侧 ====================

def _issue_guest_token(share: dict) -> str:
    now = datetime.now(timezone.utc)
    payload = {"scope": "share", "sid": share["id"], "tok": share["token"],
               "iat": now, "exp": now + timedelta(days=GUEST_TOKEN_DAYS)}
    return jwt.encode(payload, _d["jwt_secret"](), algorithm=_d["jwt_algorithm"])


def _guest(token: str, request: Request, authorization: str = Header(None)) -> dict:
    """访客鉴权：链接必须 active，Bearer 里的访客令牌必须对应这条链接。"""
    _rate_check(f"g:{token}:{_client_ip(request)}", GUEST_RATE_PER_MIN)
    share = _load_share(token)
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="需要口令")
    try:
        payload = jwt.decode(authorization[7:], _d["jwt_secret"](), algorithms=[_d["jwt_algorithm"]])
    except JWTError:
        raise HTTPException(status_code=401, detail="需要口令")
    if payload.get("scope") != "share" or payload.get("sid") != share["id"] or payload.get("tok") != token:
        raise HTTPException(status_code=401, detail="需要口令")
    return share


class Unlock(BaseModel):
    pin: str


class GuestEdit(BaseModel):
    password: Optional[str] = None
    note: Optional[str] = None


@router.get("/api/s/{token}/info")
def guest_info(token: str, request: Request):
    """解锁前能看到的：只有链接名和主人用户名，没有任何账号数据。"""
    _rate_check(f"i:{_client_ip(request)}", GUEST_RATE_PER_MIN)
    share = _load_share(token, require_active=False)
    with _d["get_db"]() as conn:
        owner = conn.execute("SELECT username FROM users WHERE id = ?", (share["owner_id"],)).fetchone()
    locked_until = _parse_ts(share.get("pin_locked_until"))
    locked = bool(locked_until and locked_until > datetime.now(timezone.utc))
    return {"name": share["name"], "owner": owner["username"] if owner else "",
            "status": share["status"], "count": len(share["account_ids"]), "locked": locked}


@router.post("/api/s/{token}/unlock")
def guest_unlock(token: str, data: Unlock, request: Request):
    ip = _client_ip(request)
    _rate_check(f"u:{ip}", UNLOCK_RATE_PER_MIN)
    share = _load_share(token)
    now = datetime.now(timezone.utc)
    locked_until = _parse_ts(share.get("pin_locked_until"))
    if locked_until and locked_until > now:
        mins = int((locked_until - now).total_seconds()) // 60 + 1
        raise HTTPException(status_code=423, detail=f"口令错太多次，{mins} 分钟后再试")

    ok, _ = _d["verify_password"](data.pin or "", share["_pin_hash"])
    with _d["get_db"]() as conn:
        if not ok:
            attempts = (share.get("pin_attempts") or 0) + 1
            if attempts >= PIN_MAX_ATTEMPTS:
                until = (now + timedelta(minutes=PIN_LOCK_MINUTES)).strftime('%Y-%m-%dT%H:%M:%SZ')
                conn.execute("UPDATE shares SET pin_attempts = 0, pin_locked_until = ? WHERE id = ?", (until, share["id"]))
                _log(conn, share["id"], "pin_locked", ip)
                conn.commit()
                raise HTTPException(status_code=423, detail=f"口令错太多次，{PIN_LOCK_MINUTES} 分钟后再试")
            conn.execute("UPDATE shares SET pin_attempts = ? WHERE id = ?", (attempts, share["id"]))
            _log(conn, share["id"], "pin_failed", ip)
            conn.commit()
            raise HTTPException(status_code=401, detail=f"口令不对，还剩 {PIN_MAX_ATTEMPTS - attempts} 次")
        conn.execute("UPDATE shares SET pin_attempts = 0, pin_locked_until = NULL, last_opened_at = ?, open_count = open_count + 1 WHERE id = ?", (_now(), share["id"]))
        _log(conn, share["id"], "unlocked", ip, None, {"ua": request.headers.get("user-agent", "")[:120]})
        conn.commit()
    return {"guest_token": _issue_guest_token(share)}


@router.get("/api/s/{token}/accounts")
def guest_accounts(token: str, request: Request, authorization: str = Header(None)):
    share = _guest(token, request, authorization)
    perms = share["perms"]
    with _d["get_db"]() as conn:
        rows = _owner_accounts(conn, share["owner_id"], _listed_ids(share))
        owner = conn.execute("SELECT username FROM users WHERE id = ?", (share["owner_id"],)).fetchone()
        notes = {r["account_id"]: r["note"] for r in conn.execute("SELECT account_id, note FROM share_notes WHERE share_id = ?", (share["id"],))}
        conn.execute("UPDATE shares SET last_opened_at = ? WHERE id = ?", (_now(), share["id"]))
        conn.commit()
    accounts = []
    for r in rows:
        keys = r.keys()
        acc = {
            "id": r["id"],
            "email": r["email"],
            "country": r["country"] or "🌍",
            "customName": r["custom_name"] or "",
            "type_name": r["type_name"] or "",
            "type_icon": r["type_icon"] or "🔑",
            "type_color": r["type_color"] or "#8b5cf6",
            "note": notes.get(r["id"], ""),
            "has_totp": bool(r["totp_secret"]) if "totp_secret" in keys else False,
            "totp_type": (r["totp_type"] or "totp") if "totp_type" in keys else "totp",
            "updated_at": r["updated_at"],
        }
        if perms.get("password"):
            acc["password"] = _d["decrypt"](r["password"]) if r["password"] else ""
        accounts.append(acc)
    return {"name": share["name"], "owner": owner["username"] if owner else "", "perms": perms, "accounts": accounts}


@router.get("/api/s/{token}/totp")
def guest_totp(token: str, request: Request, authorization: str = Header(None)):
    share = _guest(token, request, authorization)
    with _d["get_db"]() as conn:
        rows = _owner_accounts(conn, share["owner_id"], _listed_ids(share))
    out = {}
    now = int(time.time())
    for r in rows:
        keys = r.keys()
        if "totp_secret" not in keys or not r["totp_secret"]:
            continue
        try:
            secret = _d["decrypt"](r["totp_secret"])
        except Exception:
            continue
        if not secret:
            continue
        totp_type = r["totp_type"] or "totp"
        offset = r["time_offset"] or 0
        period = r["totp_period"] or 30
        if totp_type == "steam":
            code = _d["generate_steam_code"](secret, offset)
        else:
            code = _d["generate_totp"](secret, time_offset=offset, digits=r["totp_digits"] or 6,
                                       period=period, algorithm=r["totp_algorithm"] or "SHA1")
        out[str(r["id"])] = {"code": code, "type": totp_type, "period": period,
                             "remaining": period - ((now + offset) % period)}
    return {"codes": out, "server_time": now}


@router.put("/api/s/{token}/accounts/{account_id}")
def guest_edit(token: str, account_id: int, data: GuestEdit, request: Request, authorization: str = Header(None)):
    share = _guest(token, request, authorization)
    if not share["perms"].get("edit"):
        raise HTTPException(status_code=403, detail="这个链接不允许修改")
    if account_id not in _listed_ids(share):
        raise HTTPException(status_code=404, detail="账号不存在")
    if data.password is None and data.note is None:
        raise HTTPException(status_code=400, detail="没有要改的内容")
    ip = _client_ip(request)
    owner_id = share["owner_id"]
    changed = False
    with _d["get_db"]() as conn:
        row = conn.execute(f"SELECT password FROM user_{owner_id}_accounts WHERE id = ?", (account_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="账号不存在")
        if data.password is not None and share["perms"].get("password"):
            new_pw = data.password[:200]
            try:
                old_pw = _d["decrypt"](row["password"]) if row["password"] else ""
            except Exception:
                old_pw = None
            if new_pw != old_pw:                      # 没改就不写、不记
                conn.execute(f"UPDATE user_{owner_id}_accounts SET password = ?, updated_at = ? WHERE id = ?",
                             (_d["encrypt"](new_pw) if new_pw else "", _now(), account_id))
                _log(conn, share["id"], "edit", ip, account_id, {"field": "password", "old_enc": row["password"] or ""})
                changed = True
        if data.note is not None:
            # 访客自己的备注，只存在分享记录下，不碰主人的 notes 列
            conn.execute("INSERT INTO share_notes (share_id, account_id, note, updated_at) VALUES (?, ?, ?, ?) "
                         "ON CONFLICT(share_id, account_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at",
                         (share["id"], account_id, data.note[:2000], _now()))
            changed = True
        conn.commit()
    return {"message": "已保存" if changed else "没有变化"}


def _codes_for_emails(conn, owner_id: int, emails: List[str], only_new: bool = False):
    if not emails:
        return []
    rows = conn.execute(f"""
        SELECT id, email, service, code, account_name, is_read, expires_at, created_at
        FROM user_{owner_id}_verification_codes
        WHERE created_at > datetime('now', '-5 minutes')
        ORDER BY created_at DESC LIMIT 50
    """).fetchall()
    allowed = set(emails)
    out = []
    for r in rows:
        if (r["email"] or "").strip().lower() not in allowed:
            continue
        out.append({
            "id": r["id"], "email": r["email"], "service": r["service"], "code": r["code"],
            "account_name": r["account_name"], "is_read": bool(r["is_read"]),
            "expires_at": (r["expires_at"] + "Z") if r["expires_at"] and not r["expires_at"].endswith("Z") else r["expires_at"],
            "created_at": (r["created_at"] + "Z") if r["created_at"] and not r["created_at"].endswith("Z") else r["created_at"],
        })
    return out[:10]


@router.get("/api/s/{token}/mail-codes")
def guest_mail_codes(token: str, request: Request, authorization: str = Header(None)):
    share = _guest(token, request, authorization)
    if not share["perms"].get("mail_codes"):
        return {"codes": [], "enabled": False}
    emails = _listed_emails(share)
    with _d["get_db"]() as conn:
        codes = _codes_for_emails(conn, share["owner_id"], emails)
    return {"codes": codes, "enabled": True, "emails": emails}


_refresh_last: Dict[int, float] = {}


@router.post("/api/s/{token}/mail-refresh")
def guest_mail_refresh(token: str, request: Request, authorization: str = Header(None)):
    """只收清单里那几个邮箱地址，不碰主人其他邮箱。"""
    share = _guest(token, request, authorization)
    if not share["perms"].get("mail_codes"):
        raise HTTPException(status_code=403, detail="这个链接不允许收验证码")
    now = time.time()
    if now - _refresh_last.get(share["id"], 0) < REFRESH_MIN_INTERVAL:
        return {"success": True, "throttled": True, "new_codes": []}
    _refresh_last[share["id"]] = now
    emails = _listed_emails(share)
    if not emails:
        return {"success": True, "new_codes": [], "errors": []}
    result = _d["refresh_mailboxes"](share["owner_id"], only_addresses=emails)
    allowed = set(emails)
    result["new_codes"] = [c for c in result.get("new_codes", []) if (c.get("email") or "").lower() in allowed]
    # 出错信息只给"哪个邮箱"，不带任何凭据/上游细节（refresh 本身已脱敏，再兜一层）
    result["errors"] = [{"provider": e.get("provider", ""), "message": e.get("message", "")} for e in result.get("errors", [])]
    return result


# ==================== 页面 ====================

@router.get("/s/{token}")
def share_page(token: str):
    import os
    path = os.path.join(_d["static_dir"], "share.html")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="share.html 不存在")
    return FileResponse(path, media_type="text/html")
