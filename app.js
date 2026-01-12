const API = '/api';
const VERSION = 'v5.0'; // 完整2FA支持(含Steam Guard)、二维码扫描、安全加固
let token = localStorage.getItem('token');
let user = JSON.parse(localStorage.getItem('user') || 'null');
let accounts = [], accountTypes = [], propertyGroups = [];
let currentView = 'all', currentSort = 'recent', currentFilters = {};
let currentSortDir = 'desc'; // 排序方向: 'asc' 或 'desc'
let lastClickedFilter = null; // 记录最后点击的筛选项 {type: 'type'|'propval'|'noprop', id: xxx, name: xxx}
let currentViewMode = localStorage.getItem('viewMode') || 'card'; // 卡片/列表视图
let editingAccountId = null, editingTags = [], editingCombos = [];

// v10 新增：批量操作和导入重复检测
let batchMode = false;
let selectedAccounts = new Set();
let pendingImportData = null;
let duplicateAccounts = [];

// ==================== 补丁：核心 API 请求函数 ====================
async function apiRequest(endpoint, options = {}) {
    const url = API + endpoint;
    
    // 自动携带 Token 和 Content-Type
    const defaultHeaders = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
    };

    const config = {
        ...options,
        headers: {
            ...defaultHeaders,
            ...options.headers
        }
    };

    const response = await fetch(url, config);

    // 如果 Token 过期 (401)，自动跳转登录
    if (response.status === 401) {
        handleAuthError();
        throw new Error('登录已过期');
    }

    return response;
}
// ==================== 补丁结束 ====================

// ==================== HTTP 兼容：剪贴板操作 ====================
// navigator.clipboard 需要安全上下文(HTTPS)，HTTP 环境下回退到 execCommand
async function copyToClipboard(text) {
    // 优先尝试现代 Clipboard API
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            console.warn('Clipboard API 失败，尝试回退方案:', err);
        }
    }
    
    // 回退方案：使用 execCommand (兼容 HTTP 和老浏览器)
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        
        // 尝试选中全部内容（兼容某些移动端）
        textarea.setSelectionRange(0, textarea.value.length);
        
        const success = document.execCommand('copy');
        document.body.removeChild(textarea);
        
        if (!success) throw new Error('execCommand 返回 false');
        return true;
    } catch (err) {
        console.error('复制失败:', err);
        // 最后的回退：提示用户手动复制
        showToast('⚠️ 自动复制失败，请手动复制', true);
        return false;
    }
}

// 清空剪贴板（用于安全场景，如 TOTP 过期清除）
async function clearClipboard() {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText('');
        }
        // execCommand 无法"清空"剪贴板，只能写入空字符串模拟
        // 由于安全原因，HTTP 下这个操作可能无效，静默失败即可
    } catch (err) {
        // 静默失败
    }
}
// ==================== 剪贴板兼容结束 ====================

// 国家代码映射（使用区域指示符号组合）
const COUNTRY_MAP = {
    'US': '\u{1F1FA}\u{1F1F8}',  // 🇺🇸
    'JP': '\u{1F1EF}\u{1F1F5}',  // 🇯🇵
    'TW': '\u{1F1F9}\u{1F1FC}',  // 🇹🇼
    'HK': '\u{1F1ED}\u{1F1F0}',  // 🇭🇰
    'SG': '\u{1F1F8}\u{1F1EC}',  // 🇸🇬
    'KR': '\u{1F1F0}\u{1F1F7}',  // 🇰🇷
    'GB': '\u{1F1EC}\u{1F1E7}',  // 🇬🇧
    'DE': '\u{1F1E9}\u{1F1EA}',  // 🇩🇪
    'FR': '\u{1F1EB}\u{1F1F7}',  // 🇫🇷
    'AU': '\u{1F1E6}\u{1F1FA}',  // 🇦🇺
    'CA': '\u{1F1E8}\u{1F1E6}',  // 🇨🇦
    'IN': '\u{1F1EE}\u{1F1F3}',  // 🇮🇳
    'VN': '\u{1F1FB}\u{1F1F3}',  // 🇻🇳
    'TH': '\u{1F1F9}\u{1F1ED}',  // 🇹🇭
    'MY': '\u{1F1F2}\u{1F1FE}',  // 🇲🇾
    'ID': '\u{1F1EE}\u{1F1E9}',  // 🇮🇩
    'PH': '\u{1F1F5}\u{1F1ED}',  // 🇵🇭
    'BR': '\u{1F1E7}\u{1F1F7}',  // 🇧🇷
    'RU': '\u{1F1F7}\u{1F1FA}',  // 🇷🇺
    'CN': '\u{1F1E8}\u{1F1F3}'   // 🇨🇳
};

// 初始化
function init() {
    console.log('账号管家初始化', VERSION);
    initTheme();
    initViewMode();
    initFavStyle();
    if (token && user) { showApp(); loadData(); }
    checkSecurity(); // 安全检查
}

// ==================== 安全检查 ====================
async function checkSecurity() {
    try {
        const res = await fetch(API + '/health');
        const data = await res.json();
        
        if (data.key_status === 'unsafe_default') {
            showSecurityModal(
                '⚠️ 安全警报：正在使用默认公开密钥！',
                '系统检测到您使用的是默认的 <b>APP_MASTER_KEY</b>。<br><br>' +
                '1. 您的数据目前处于<b>裸奔状态</b>，极易被破解！<br>' +
                '2. <b>请勿在此状态下保存重要数据！</b><br>' +
                '3. 请立即去 <code>docker-compose.yml</code> 修改密钥并重启。<br><br>' +
                '❌ <b>切记：如果您现在存了数据，以后再改密钥，数据将永久无法解密！</b>'
            );
        } else if (data.key_status === 'file_based') {
            console.warn('正在使用文件密钥模式，请注意备份 data/.encryption_key');
            showToast('⚠️ 提示：当前未配置环境变量密钥，请妥善备份 data 目录', true);
        }
    } catch (e) {
        console.error('安全检查失败', e);
    }
}

function showSecurityModal(title, htmlContent) {
    const warningHtml = `
    <div style="position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;">
        <div style="background:#18181b;border:2px solid #ef4444;border-radius:16px;padding:30px;max-width:500px;text-align:center;box-shadow:0 0 50px rgba(239,68,68,0.5);">
            <div style="font-size:4rem;margin-bottom:20px;">☢️</div>
            <h2 style="color:#ef4444;margin-bottom:20px;font-size:1.5rem;">${title}</h2>
            <div style="color:#e4e4e7;text-align:left;line-height:1.6;font-size:0.95rem;background:rgba(239,68,68,0.1);padding:15px;border-radius:8px;">${htmlContent}</div>
            <div style="margin-top:25px;font-size:0.85rem;color:#71717a;">修改 docker-compose.yml 后重启容器，此警告将自动消失。</div>
        </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', warningHtml);
}

// 视图模式
function initViewMode() {
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === currentViewMode);
    });
    updateViewModeClass();
}

function setViewMode(mode) {
    currentViewMode = mode;
    localStorage.setItem('viewMode', mode);
    document.querySelectorAll('.view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === mode);
    });
    updateViewModeClass();
}

function updateViewModeClass() {
    const grid = document.getElementById('cardsList');
    if (grid) {
        grid.classList.toggle('list-view', currentViewMode === 'list');
    }
}

// 获取国家显示（小国旗+代码，如 🇺🇸 US）
function getCountryDisplay(country) {
    if (!country || country === '🌍') return '🌍';
    // 如果flags.js已加载，使用Twemoji小图标
    if (typeof getFlagHtml === 'function') {
        const code = country.toUpperCase();
        return getFlagHtml(code, 14) + ' ' + code;
    }
    // 降级：使用Unicode国旗
    const upperCountry = country.toUpperCase();
    const flag = COUNTRY_MAP[upperCountry];
    return flag ? `${flag} ${upperCountry}` : country;
}

// 主题
let currentTheme = localStorage.getItem('theme') || 'dark';
function initTheme() {
    document.documentElement.setAttribute('data-theme', currentTheme === 'light' ? 'light' : '');
    ['themeBtn', 'themeBtn2'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = currentTheme === 'light' ? '☀️' : '🌙'; });
}
function toggleTheme() {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', currentTheme);
    initTheme();
}

// 登录注册
function switchLoginTab(tab) {
    document.querySelectorAll('.login-tab').forEach((el, i) => el.classList.toggle('active', tab === 'login' ? i === 0 : i === 1));
    document.querySelectorAll('.login-form').forEach((el, i) => el.classList.toggle('active', tab === 'login' ? i === 0 : i === 1));
}

async function handleLogin(e) {
    e.preventDefault();
    try {
        const res = await fetch(API + '/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: document.getElementById('loginUsername').value, password: document.getElementById('loginPassword').value })
        });
        const data = await res.json();
        if (res.ok) { token = data.token; user = data.user; localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify(user)); showToast('登录成功'); showApp(); loadData(); }
        else showToast(data.detail || '登录失败', true);
    } catch { showToast('网络错误', true); }
}

async function handleRegister(e) {
    e.preventDefault();
    const p1 = document.getElementById('regPassword').value, p2 = document.getElementById('regPassword2').value;
    if (p1 !== p2) { showToast('密码不一致', true); return; }
    try {
        const res = await fetch(API + '/register', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: document.getElementById('regUsername').value, password: p1 })
        });
        const data = await res.json();
        if (res.ok) { token = data.token; user = data.user; localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify(user)); showToast('注册成功'); showApp(); loadData(); }
        else showToast(data.detail || '注册失败', true);
    } catch { showToast('网络错误', true); }
}

function logout() {
    if (!confirm('确定退出?')) return;
    doLogout();
}

// 统一退出处理
function doLogout() {
    localStorage.removeItem('token'); localStorage.removeItem('user'); token = null; user = null;
    accounts = []; accountTypes = []; propertyGroups = [];
    document.getElementById('app').classList.remove('show');
    document.getElementById('loginContainer').style.display = 'flex';
}

// 认证失效时自动跳转登录
function handleAuthError() {
    showToast('登录已过期，请重新登录', true);
    setTimeout(() => doLogout(), 500);
}

function showApp() {
    document.getElementById('loginContainer').style.display = 'none';
    document.getElementById('app').classList.add('show');
    // 更新用户面板信息
    document.getElementById('userDisplayName').textContent = user.username;
    // 加载头像（从user对象或服务器）
    loadUserAvatar();
}

async function loadUserAvatar() {
    // 优先从user对象获取，否则用默认
    let avatar = user.avatar || '👤';
    document.getElementById('userAvatar').textContent = avatar;
    document.getElementById('userAvatarLarge').textContent = avatar;
}

// 数据加载
async function loadData() {
    try {
        await Promise.all([loadAccountTypes(), loadPropertyGroups(), loadAccounts()]);
        renderSidebar(); renderCards();
    } catch (e) {
        console.error('loadData错误:', e);
    }
}

async function loadAccounts() {
    try { 
        const res = await fetch(API + '/accounts', { headers: { Authorization: 'Bearer ' + token } }); 
        if (res.status === 401) { handleAuthError(); return; }
        if (!res.ok) { showToast('加载账号失败', true); return; }
        const data = await res.json(); 
        accounts = data.accounts || [];
    }
    catch (e) { 
        console.error('loadAccounts错误:', e);
        showToast('加载账号失败', true); 
    }
}

async function loadAccountTypes() {
    try { 
        const res = await fetch(API + '/account-types', { headers: { Authorization: 'Bearer ' + token } }); 
        if (res.status === 401) { handleAuthError(); return; }
        if (!res.ok) return;
        const data = await res.json(); 
        accountTypes = data.types || [];
    } catch (e) {
        console.error('loadAccountTypes错误:', e);
    }
}

async function loadPropertyGroups() {
    try { 
        const res = await fetch(API + '/property-groups', { headers: { Authorization: 'Bearer ' + token } }); 
        if (res.status === 401) { handleAuthError(); return; }
        if (!res.ok) return;
        const data = await res.json(); 
        propertyGroups = data.groups || [];
    } catch (e) {
        console.error('loadPropertyGroups错误:', e);
    }
}

// 侧边栏
function renderSidebar() {
    let typesHtml = `<div class="collapsible-group"><div class="group-header" onclick="toggleGroup(this)"><span class="group-arrow">▼</span><span>账号类型</span><span class="group-actions"><button class="btn-tiny" onclick="event.stopPropagation();openTypeManager()">⚙</button></span></div><div class="group-content">`;
    accountTypes.forEach(t => {
        const count = accounts.filter(a => a.type_id === t.id).length;
        const isSelected = currentFilters['type_' + t.id];
        typesHtml += `<div class="nav-item${isSelected ? ' active' : ''}" onclick="filterByType(${t.id})"><span class="nav-icon" style="color:${escapeAttr(t.color)}">${escapeHtml(t.icon)}</span><span class="nav-label">${escapeHtml(t.name)}</span><span class="nav-count">${count}</span></div>`;
    });
    typesHtml += '</div></div>';
    document.getElementById('sidebarTypes').innerHTML = typesHtml;

    let propsHtml = '';
    propertyGroups.forEach(g => {
        
        propsHtml += `<div class="collapsible-group"><div class="group-header" onclick="toggleGroup(this)"><span class="group-arrow">▼</span><span>${escapeHtml(g.name)}</span><span class="group-actions"><button class="btn-tiny" onclick="event.stopPropagation();openPropertyManager()">⚙</button></span></div><div class="group-content">`;
        (g.values || []).forEach(v => {
            // 统计包含此属性值的账号数量（遍历combos数组，处理类型不一致）
            const count = accounts.filter(a => {
                const combos = a.combos || [];
                return combos.some(combo => {
                    if (!Array.isArray(combo)) return false;
                    return combo.some(vid => String(vid) === String(v.id));
                });
            }).length;
            const isSelected = currentFilters['propval_' + v.id];
            propsHtml += `<div class="prop-item${isSelected ? ' active' : ''}" onclick="filterByProperty(${g.id},${v.id})"><span class="prop-dot" style="background:${escapeAttr(v.color)}"></span><span class="prop-label">${escapeHtml(v.name)}</span><span class="prop-count">${count}</span></div>`;
        });
        propsHtml += '</div></div>';
    });
    document.getElementById('sidebarProperties').innerHTML = propsHtml;

    document.getElementById('countAll').textContent = accounts.length;
    document.getElementById('countFav').textContent = accounts.filter(a => a.is_favorite).length;
    document.getElementById('countNoCombo').textContent = accounts.filter(a => !a.combos || a.combos.length === 0 || a.combos.every(c => !c || c.length === 0)).length;
    document.getElementById('countRecent').textContent = accounts.filter(a => a.last_used && (Date.now() - new Date(a.last_used).getTime()) < 7*24*60*60*1000).length;
}

// 卡片渲染
function renderCards() {
    const filtered = getFilteredAccounts(), sorted = sortAccounts(filtered);
    if (sorted.length === 0) { document.getElementById('cardsList').innerHTML = `<div class="empty-state"><div class="icon">📭</div><div>暂无账号</div></div>`; return; }

    // 建立值ID到值对象的映射，方便查找
    const valueMap = {};
    propertyGroups.forEach(g => {
        (g.values || []).forEach(v => { valueMap[v.id] = v; });
    });

    document.getElementById('cardsList').innerHTML = sorted.map(acc => {
        const type = accountTypes.find(t => t.id === acc.type_id) || { icon: '🔑', color: '#8b5cf6' };
        
        // 根据combos判断卡片状态（不再根据选中状态变色）
        let cardClass = 'account-card';
        const combos = acc.combos || [];
        // 查找第一个属性组（账号状态）的值来决定卡片样式
        if (combos.length > 0 && propertyGroups.length > 0) {
            const firstGroup = propertyGroups[0];
            for (const combo of combos) {
                const statusValue = (firstGroup.values || []).find(v => combo.includes(v.id));
                if (statusValue?.name === '受限') { cardClass += ' warning'; break; }
                else if (statusValue?.name === '不可用') { cardClass += ' error'; break; }
            }
        }

        // 渲染组合标签
        let combosHtml = '';
        combos.forEach(combo => {
            const parts = [];
            let color = '#8b5cf6'; // 默认颜色
            let isFirst = true;
            // 遍历combo中的每个值ID
            combo.forEach(vid => {
                const v = valueMap[vid];
                if (v) {
                    if (isFirst) { color = v.color; isFirst = false; } // 第一个值决定颜色
                    parts.push(v.name);
                }
            });
            if (parts.length > 0) {
                // 简洁样式：圆点 + 文字，轻量背景
                combosHtml += `<span class="combo-badge" style="background:${hexToRgba(color,0.12)};color:${color}"><span class="combo-dot" style="background:${color}"></span>${parts.join(' ')}</span>`;
            }
        });

        // 批量选择复选框（点击框或卡片都可以勾选）
        const isChecked = selectedAccounts.has(acc.id);
        const checkboxHtml = batchMode ? `<div class="batch-checkbox" onclick="event.stopPropagation(); toggleAccountSelection(${acc.id}, event)"><input type="checkbox" ${isChecked ? 'checked' : ''}><span class="checkmark"></span></div>` : '';

        // 收藏状态通过卡片类名控制（紫色高亮）
        const favoriteClass = acc.is_favorite ? 'favorite' : '';
        
        // 勾选模式下点击卡片即可勾选
        const cardClickHandler = batchMode ? `onclick="toggleAccountSelection(${acc.id}, event)"` : '';

        return `<div class="${cardClass} ${favoriteClass}" data-id="${acc.id}" ${cardClickHandler}>
            <div class="card-body">
                <div class="card-header">
                    ${checkboxHtml}
                    <div class="card-icon" style="background:linear-gradient(135deg,${type.color},${adjustColor(type.color,-20)})">${type.icon}</div>
                    <div class="card-info" ${!batchMode ? `onclick="copyEmail('${escapeHtml(acc.email)}')" title="点击复制邮箱"` : ''}><div class="card-name">${escapeHtml(acc.customName || acc.email)}</div><div class="card-email">${escapeHtml(acc.email)}</div></div>
                    <div class="card-combos">${combosHtml}</div>
                    <div class="card-meta">
                        <span class="card-country">${getCountryDisplay(acc.country)}</span>
                        ${!batchMode ? `<div class="card-menu" onclick="event.stopPropagation()">
                            <button class="btn-menu-dots" onclick="toggleCardMenu(${acc.id})">⋮</button>
                            <div class="card-menu-dropdown">
                                <div class="menu-item" onclick="toggleFavorite(${acc.id});closeAllMenus()">${acc.is_favorite ? '💔 取消收藏' : '💌 收藏'}</div>
                                <div class="menu-item" onclick="openEditModal(${acc.id});closeAllMenus()">✏️ 编辑</div>
                                <div class="menu-item danger" onclick="deleteAccount(${acc.id});closeAllMenus()">🗑️ 删除</div>
                            </div>
                        </div>` : ''}
                    </div>
                </div>
                ${(acc.tags||[]).length ? `<div class="card-tags">${acc.tags.map(t => `<span class="free-tag">${t}</span>`).join('')}</div>` : ''}
            </div>
            <div class="card-footer">
                <button class="btn-action" onclick="event.stopPropagation();copyPassword(${acc.id})" title="复制密码">🔑 密码</button>
                ${acc.has_2fa ? `<button class="btn-action btn-2fa" onclick="event.stopPropagation();show2FAPopup(${acc.id})" title="查看验证码">🛡️ 2FA</button>` : ''}
                <button class="btn-action" onclick="event.stopPropagation();copyEmail('${escapeHtml(acc.email)}')" title="复制邮箱">📋 复制</button>
                <button class="btn-action" onclick="event.stopPropagation();loginTest(${acc.id})" title="登录测试">🔗 登录</button>
            </div>
        </div>`;
    }).join('');
    
    // 应用视图模式
    updateViewModeClass();
}

function getFilteredAccounts() {
    let result = [...accounts];
    const search = document.getElementById('searchInput').value.toLowerCase();
    if (currentView === 'favorites') result = result.filter(a => a.is_favorite);
    else if (currentView === 'recent') result = result.filter(a => a.last_used && (Date.now() - new Date(a.last_used).getTime()) < 7*24*60*60*1000);
    else if (currentView === 'nocombo') result = result.filter(a => !a.combos || a.combos.length === 0 || a.combos.every(c => !c || c.length === 0));
    
    // 按账号类型筛选（新结构：type_xxx）
    Object.keys(currentFilters).forEach(key => {
        if (key.startsWith('type_')) {
            const typeId = currentFilters[key];
            result = result.filter(a => a.type_id === typeId);
        }
    });
    
    // 按"未设置"属性组筛选
    Object.keys(currentFilters).forEach(key => {
        if (key.startsWith('noprop_')) {
            const groupId = parseInt(currentFilters[key]);
            const group = propertyGroups.find(g => g.id === groupId);
            if (group) {
                const groupValueIds = (group.values || []).map(v => v.id);
                result = result.filter(a => {
                    const combos = a.combos || [];
                    return !combos.some(combo => {
                        if (!Array.isArray(combo)) return false;
                        return combo.some(vid => groupValueIds.includes(Number(vid)) || groupValueIds.includes(String(vid)));
                    });
                });
            }
        }
    });
    // 按属性值ID筛选（新的combos逻辑，处理类型不一致）
    Object.keys(currentFilters).forEach(key => {
        if (key.startsWith('propval_')) {
            const valueId = currentFilters[key];
            result = result.filter(a => {
                const combos = a.combos || [];
                return combos.some(combo => {
                    if (!Array.isArray(combo)) return false;
                    return combo.some(vid => String(vid) === String(valueId));
                });
            });
        }
    });
    if (search) result = result.filter(a => (a.email || '').toLowerCase().includes(search) || (a.customName || '').toLowerCase().includes(search) || (a.tags || []).some(t => t.toLowerCase().includes(search)));
    return result;
}

function sortAccounts(list) {
    const sorted = [...list];
    const dir = currentSortDir === 'asc' ? 1 : -1;
    
    if (currentSort === 'recent') {
        sorted.sort((a, b) => {
            const aTime = a.last_used ? new Date(a.last_used).getTime() : 0;
            const bTime = b.last_used ? new Date(b.last_used).getTime() : 0;
            return dir * (bTime - aTime) || dir * (new Date(b.created_at) - new Date(a.created_at));
        });
    } else if (currentSort === 'name') {
        sorted.sort((a, b) => dir * (a.customName || a.email).localeCompare(b.customName || b.email));
    } else if (currentSort === 'created') {
        sorted.sort((a, b) => dir * (new Date(b.created_at) - new Date(a.created_at)));
    }
    return sorted;
}

// 视图筛选
function setView(view) {
    currentView = view; 
    currentFilters = {};
    lastClickedFilter = null;
    document.querySelectorAll('.view-section .nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
    updatePageTitle();
    renderSidebar();
    renderFiltersBar(); 
    renderCards();
}

function filterByType(typeId) {
    const key = 'type_' + typeId;
    const t = accountTypes.find(t => t.id === typeId);
    const wasSelected = currentFilters[key];
    
    // 账号类型互斥：先清除所有已选的账号类型
    Object.keys(currentFilters).forEach(k => {
        if (k.startsWith('type_')) delete currentFilters[k];
    });
    
    // 如果点的是同一个，就取消；否则选中新的
    if (wasSelected) {
        // 已选中，取消
    } else {
        currentFilters[key] = typeId;
    }
    updatePageTitle();
    renderSidebar();
    renderFiltersBar(); 
    renderCards();
}

function filterByProperty(groupId, valueId) {
    const key = 'propval_' + valueId;
    // 查找属性值名称
    let valueName = '';
    for (const g of propertyGroups) {
        const v = (g.values || []).find(v => v.id === valueId);
        if (v) { valueName = v.name; break; }
    }
    // 切换选中状态：如果已选中则取消，否则添加
    if (currentFilters[key]) {
        delete currentFilters[key];
        lastClickedFilter = null;
    } else {
        currentFilters[key] = valueId;
        lastClickedFilter = { type: 'propval', id: valueId, name: valueName };
    }
    updatePageTitle();
    renderSidebar();
    renderFiltersBar(); 
    renderCards();
}

function filterByNoProperty(groupId) {
    const key = 'noprop_' + groupId;
    const g = propertyGroups.find(g => g.id === groupId);
    // 切换选中状态：如果已选中则取消，否则添加
    if (currentFilters[key]) {
        delete currentFilters[key];
        lastClickedFilter = null;
    } else {
        currentFilters[key] = groupId;
        lastClickedFilter = { type: 'noprop', id: groupId, name: (g?.name || '属性') + ' - 未设置' };
    }
    updatePageTitle();
    renderSidebar();
    renderFiltersBar(); 
    renderCards();
}

function updatePageTitle() {
    const viewName = currentView === 'all' ? '全部账号' : currentView === 'favorites' ? '所有收藏' : currentView === 'nocombo' ? '无属性组' : '最近使用';
    
    let path = viewName;
    
    // 第二层：账号类型（固定显示）
    Object.keys(currentFilters).forEach(key => {
        if (key.startsWith('type_')) {
            const typeId = currentFilters[key];
            const t = accountTypes.find(t => t.id === typeId);
            if (t) path += ' > ' + t.name;
        }
    });
    
    // 第三层：最后点击的属性组（非类型）
    if (lastClickedFilter && lastClickedFilter.type !== 'type') {
        path += ' > ' + lastClickedFilter.name;
    }
    
    document.getElementById('pageTitle').textContent = path;
}

function renderFiltersBar() {
    const container = document.getElementById('activeFilters'), has = Object.keys(currentFilters).length > 0;
    container.classList.toggle('show', has);
    if (!has) { container.innerHTML = ''; return; }
    let html = '';
    
    // 账号类型标签
    Object.keys(currentFilters).forEach(key => {
        if (key.startsWith('type_')) {
            const typeId = currentFilters[key];
            const t = accountTypes.find(t => t.id === typeId);
            if (t) html += `<div class="filter-tag"><span class="dot" style="background:${escapeAttr(t.color)}"></span>${escapeHtml(t.name)}<span class="remove" onclick="removeFilter('${key}')">✕</span></div>`;
        }
    });
    
    // 属性值标签
    Object.keys(currentFilters).forEach(key => {
        if (key.startsWith('noprop_')) {
            const groupId = currentFilters[key];
            const g = propertyGroups.find(g => g.id === groupId);
            if (g) {
                html += `<div class="filter-tag"><span class="dot" style="background:#9ca3af"></span>${escapeHtml(g.name)} - 未设置<span class="remove" onclick="removeFilter('${key}')">✕</span></div>`;
            }
        }
        if (key.startsWith('propval_')) {
            const valueId = currentFilters[key];
            for (const g of propertyGroups) {
                const v = (g.values || []).find(v => v.id === valueId);
                if (v) {
                    html += `<div class="filter-tag"><span class="dot" style="background:${escapeAttr(v.color)}"></span>${escapeHtml(v.name)}<span class="remove" onclick="removeFilter('${key}')">✕</span></div>`;
                    break;
                }
            }
        }
    });
    
    html += `<button class="clear-filters" onclick="clearFilters()">清除全部</button>`;
    container.innerHTML = html;
}

function removeFilter(key) { 
    delete currentFilters[key]; 
    // 如果删除的是最后点击的那个，清除 lastClickedFilter
    if (lastClickedFilter) {
        if ((key.startsWith('type_') && lastClickedFilter.type === 'type') ||
            (key.startsWith('propval_') && lastClickedFilter.type === 'propval' && key === 'propval_' + lastClickedFilter.id) ||
            (key.startsWith('noprop_') && lastClickedFilter.type === 'noprop' && key === 'noprop_' + lastClickedFilter.id)) {
            lastClickedFilter = null;
        }
    }
    updatePageTitle();
    renderSidebar();
    renderFiltersBar(); 
    renderCards(); 
}

function clearFilters() { 
    currentFilters = {}; 
    lastClickedFilter = null;
    updatePageTitle();
    renderSidebar();
    renderFiltersBar(); 
    renderCards(); 
}

function setSort(sort) { 
    if (currentSort === sort) {
        // 同一个排序项，切换方向
        currentSortDir = currentSortDir === 'desc' ? 'asc' : 'desc';
    } else {
        // 新的排序项，默认降序
        currentSort = sort;
        currentSortDir = 'desc';
    }
    updateSortButtons();
    renderCards(); 
}

function updateSortButtons() {
    document.querySelectorAll('.sort-option').forEach(el => {
        const isActive = el.dataset.sort === currentSort;
        el.classList.toggle('active', isActive);
        // 更新箭头
        const arrow = currentSortDir === 'desc' ? '↓' : '↑';
        const baseText = el.dataset.sort === 'recent' ? '最近使用' : el.dataset.sort === 'name' ? '名称' : '创建时间';
        el.textContent = isActive ? `${baseText} ${arrow}` : baseText;
    });
}

function filterAccounts() { renderCards(); }

// 账号操作
async function toggleFavorite(id) {
    try { const res = await fetch(API + `/accounts/${id}/favorite`, { method: 'POST', headers: { Authorization: 'Bearer ' + token } }); if (res.ok) { const data = await res.json(); const acc = accounts.find(a => a.id === id); if (acc) acc.is_favorite = data.is_favorite; renderSidebar(); renderCards(); } } catch {}
}

function copyEmail(email) { copyToClipboard(email).then(ok => ok && showToast('📋 邮箱已复制')); }

// 复制密码
async function copyPassword(accountId) {
    const acc = accounts.find(a => a.id === accountId);
    if (!acc) return;
    if (!acc.password) { showToast('该账号未设置密码', true); return; }
    const ok = await copyToClipboard(acc.password);
    if (ok) showToast('🔑 密码已复制');
    // 标记使用时间
    apiRequest(`/accounts/${accountId}/use`, { method: 'POST' }).catch(() => {});
}

async function loginTest(id) {
    const acc = accounts.find(a => a.id === id);
    if (!acc) return;
    try { await fetch(API + `/accounts/${id}/use`, { method: 'POST', headers: { Authorization: 'Bearer ' + token } }); acc.last_used = new Date().toISOString(); } catch {}
    copyToClipboard(acc.email).then(ok => ok && showToast('已复制邮箱'));
    const type = accountTypes.find(t => t.id === acc.type_id);
    if (type?.login_url) { let url = type.login_url; if (url.includes('Email=')) url += encodeURIComponent(acc.email); setTimeout(() => window.open(url, '_blank'), 300); }
}

async function deleteAccount(id) {
    if (!confirm('确定删除此账号?')) return;
    try { const res = await fetch(API + `/accounts/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }); if (res.ok) { accounts = accounts.filter(a => a.id !== id); showToast('已删除'); renderSidebar(); renderCards(); } } catch { showToast('删除失败', true); }
}

// 账号模态框
function openAddModal() {
    editingAccountId = null; editingTags = []; editingCombos = [];
    document.getElementById('accountModalTitle').textContent = '添加账号';
    document.getElementById('accType').innerHTML = accountTypes.map(t => `<option value="${t.id}">${escapeHtml(t.icon)} ${escapeHtml(t.name)}</option>`).join('');
    ['accName', 'accEmail', 'accPassword', 'accNotes'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('accCountry').value = '🌍';
    // 隐藏 2FA 按钮（添加时不显示）
    const btn2FA = document.getElementById('btn2FAConfig');
    if (btn2FA) btn2FA.style.display = 'none';
    renderCombosBox(); renderTagsBox();
    document.getElementById('accountModal').classList.add('show');
}

function openEditModal(id) {
    const acc = accounts.find(a => a.id === id);
    if (!acc) return;
    editingAccountId = id; editingTags = [...(acc.tags || [])]; editingCombos = [...(acc.combos || [])];
    document.getElementById('accountModalTitle').textContent = '编辑账号';
    document.getElementById('accType').innerHTML = accountTypes.map(t => `<option value="${t.id}" ${t.id === acc.type_id ? 'selected' : ''}>${escapeHtml(t.icon)} ${escapeHtml(t.name)}</option>`).join('');
    document.getElementById('accName').value = acc.customName || '';
    document.getElementById('accEmail').value = acc.email || '';
    document.getElementById('accPassword').value = acc.password || '';
    document.getElementById('accCountry').value = acc.country || '🌍';
    document.getElementById('accNotes').value = acc.notes || '';
    // 显示 2FA 按钮（编辑时显示）
    const btn2FA = document.getElementById('btn2FAConfig');
    if (btn2FA) {
        btn2FA.style.display = 'inline-flex';
        btn2FA.textContent = acc.has_2fa ? '🛡️ 2FA ✓' : '🛡️ 2FA';
    }
    renderCombosBox(); renderTagsBox();
    document.getElementById('accountModal').classList.add('show');
}

// 组合标签渲染
function renderCombosBox() {
    const container = document.getElementById('accCombosBox');
    let html = editingCombos.map((combo, idx) => {
        const display = getComboDisplay(combo);
        return `<span class="combo-tag" style="background:${hexToRgba(display.color,0.12)};color:${display.color}"><span class="combo-dot" style="background:${display.color}"></span>${display.text}<span class="remove" onclick="removeCombo(${idx})">✕</span></span>`;
    }).join('');
    html += '<button class="btn-add-combo" onclick="openComboSelector()">+ 添加</button>';
    container.innerHTML = html;
}

function getComboDisplay(combo) {
    let color = '#8b5cf6', parts = [], isFirst = true;
    // 遍历combo中的每个值ID，按顺序查找
    combo.forEach(vid => {
        // 在所有属性组中查找这个值ID
        for (const g of propertyGroups) {
            const v = (g.values || []).find(v => v.id === vid);
            if (v) {
                if (isFirst) { color = v.color; isFirst = false; }
                parts.push(v.name);
                break;
            }
        }
    });
    return { color, text: parts.join(' ') || '●' };
}

function removeCombo(idx) {
    editingCombos.splice(idx, 1);
    renderCombosBox();
}

let comboSelectorVisible = false;
function openComboSelector() {
    const existing = document.getElementById('comboSelectorOverlay');
    if (existing) existing.remove();
    
    let html = '<div id="comboSelectorOverlay" class="combo-overlay"><div class="combo-dialog"><div class="combo-dialog-header"><span>选择服务状态</span><button class="combo-close" onclick="cancelComboSelector()">✕</button></div><div class="combo-dialog-body">';
    propertyGroups.forEach(g => {
        html += `<div class="combo-group"><div class="combo-group-name">${escapeHtml(g.name)}</div><div class="combo-group-options">`;
        if ((g.values || []).length === 0) {
            html += `<span class="combo-empty">暂无属性值</span>`;
        }
        (g.values || []).forEach(v => {
            html += `<div class="combo-option" data-vid="${v.id}" data-color="${escapeAttr(v.color)}" onclick="toggleComboOption(this)"><span class="combo-check-dot" style="background:${escapeAttr(v.color)}"></span>${escapeHtml(v.name)}</div>`;
        });
        html += '</div></div>';
    });
    html += '</div><div class="combo-dialog-footer"><button class="combo-btn" onclick="cancelComboSelector()">取消</button><button class="combo-btn primary" onclick="confirmComboSelector()">确定</button></div></div></div>';
    
    document.body.insertAdjacentHTML('beforeend', html);
}

function toggleComboOption(el) {
    el.classList.toggle('selected');
}

function cancelComboSelector() {
    const overlay = document.getElementById('comboSelectorOverlay');
    if (overlay) overlay.remove();
}

function confirmComboSelector() {
    const selected = document.querySelectorAll('#comboSelectorOverlay .combo-option.selected');
    console.log('选中的元素数量:', selected.length);
    const combo = Array.from(selected).map(el => parseInt(el.dataset.vid));
    console.log('生成的combo:', combo);
    if (combo.length > 0) {
        editingCombos.push(combo);
        console.log('当前editingCombos:', editingCombos);
        renderCombosBox();
    }
    cancelComboSelector();
}

function renderTagsBox() {
    document.getElementById('accTagsBox').innerHTML = editingTags.map(t => `<span class="tag-badge">${escapeHtml(t)}<span class="remove" onclick="removeTag('${escapeHtml(t)}')">✕</span></span>`).join('') + '<input type="text" class="tag-input" id="accTagInput" placeholder="回车添加" onkeydown="handleTagInput(event)">';
}

function handleTagInput(e) { if (e.key === 'Enter') { e.preventDefault(); const val = e.target.value.trim(); if (val && !editingTags.includes(val)) { editingTags.push(val); renderTagsBox(); } e.target.value = ''; } }
function removeTag(tag) { editingTags = editingTags.filter(t => t !== tag); renderTagsBox(); }
function closeAccountModal() { document.getElementById('accountModal').classList.remove('show'); }

async function saveAccount() {
    const data = { 
        type_id: parseInt(document.getElementById('accType').value), 
        email: document.getElementById('accEmail').value, 
        password: document.getElementById('accPassword').value, 
        country: document.getElementById('accCountry').value, 
        customName: document.getElementById('accName').value, 
        combos: editingCombos,
        tags: editingTags, 
        notes: document.getElementById('accNotes').value 
    };
    console.log('保存数据:', JSON.stringify(data));  // 调试
    try {
        const res = await fetch(editingAccountId ? API + `/accounts/${editingAccountId}` : API + '/accounts', { method: editingAccountId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(data) });
        if (res.ok) { showToast(editingAccountId ? '已更新' : '已添加'); closeAccountModal(); await loadAccounts(); console.log('加载后accounts:', accounts); renderSidebar(); renderCards(); }
        else { const err = await res.json(); showToast(err.detail || '保存失败', true); }
    } catch(e) { console.error('保存错误:', e); showToast('网络错误', true); }
}

// 属性组管理
function openPropertyManager() { renderPropertyEditor(); document.getElementById('propertyModal').classList.add('show'); }
function closePropertyManager() { document.getElementById('propertyModal').classList.remove('show'); }

function renderPropertyEditor() {
    let html = '<div class="hint-box"><p>属性组类似Discord分类，可自由增删改。</p></div>';
    propertyGroups.forEach(g => {
        html += `<div class="editor-group"><div class="editor-header"><input type="text" value="${escapeHtml(g.name)}" onchange="updateGroupName(${g.id}, this.value)"><button class="btn-del" onclick="deleteGroup(${g.id})">🗑️</button></div><div class="editor-values">`;
        (g.values || []).forEach(v => html += `<div class="value-row"><input type="color" class="color-picker" value="${v.color}" onchange="updateValue(${v.id}, null, this.value)"><input type="text" value="${escapeHtml(v.name)}" onchange="updateValue(${v.id}, this.value, null)"><button class="btn-del" onclick="deleteValue(${v.id})">✕</button></div>`);
        html += `<button class="btn-add-row" onclick="addValue(${g.id})">+ 添加</button></div></div>`;
    });
    html += '<button class="btn-add-group" onclick="addGroup()">➕ 添加新属性组</button>';
    document.getElementById('propertyEditorBody').innerHTML = html;
}

async function addGroup() { const name = prompt('属性组名称:'); if (!name) return; try { await fetch(API + '/property-groups', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ name }) }); await loadPropertyGroups(); renderPropertyEditor(); renderSidebar(); } catch {} }
async function updateGroupName(id, name) { try { await fetch(API + `/property-groups/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ name }) }); await loadPropertyGroups(); renderSidebar(); } catch {} }
async function deleteGroup(id) { if (!confirm('删除此属性组?')) return; try { await fetch(API + `/property-groups/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }); await loadPropertyGroups(); renderPropertyEditor(); renderSidebar(); } catch {} }
async function addValue(groupId) { const name = prompt('属性值名称:'); if (!name) return; try { await fetch(API + '/property-values', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ group_id: groupId, name, color: '#8b5cf6' }) }); await loadPropertyGroups(); renderPropertyEditor(); renderSidebar(); } catch {} }
async function updateValue(id, name, color) { const data = {}; if (name !== null) data.name = name; if (color !== null) data.color = color; try { await fetch(API + `/property-values/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(data) }); await loadPropertyGroups(); renderSidebar(); renderCards(); } catch {} }
async function deleteValue(id) { if (!confirm('删除此属性值?')) return; try { await fetch(API + `/property-values/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }); await loadPropertyGroups(); renderPropertyEditor(); renderSidebar(); } catch {} }

// 类型管理
function openTypeManager() { renderTypeEditor(); document.getElementById('typeModal').classList.add('show'); }
function closeTypeManager() { document.getElementById('typeModal').classList.remove('show'); }

function renderTypeEditor() {
    let html = '<div class="hint-box"><p>点击图标可更换背景色</p></div><div class="editor-group"><div class="editor-values">';
    accountTypes.forEach(t => {
        const color = t.color || '#8b5cf6';
        html += `<div class="value-row" style="gap:8px">
            <label style="background:${color};min-width:32px;width:32px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:1rem;cursor:pointer;position:relative">
                ${escapeHtml(t.icon)}
                <input type="color" value="${color}" style="position:absolute;opacity:0;width:100%;height:100%;cursor:pointer" onchange="updateType(${t.id}, 'color', this.value);this.parentElement.style.background=this.value">
            </label>
            <input type="text" value="${escapeHtml(t.icon)}" style="width:42px;text-align:center;flex:none" onchange="updateType(${t.id}, 'icon', this.value)">
            <input type="text" value="${escapeHtml(t.name)}" style="width:80px;flex:none" onchange="updateType(${t.id}, 'name', this.value)">
            <input type="text" value="${escapeHtml(t.login_url || '')}" style="flex:1;min-width:0" placeholder="登录链接(可选)" onchange="updateType(${t.id}, 'login_url', this.value)">
            <button class="btn-del" onclick="deleteType(${t.id})">✕</button>
        </div>`;
    });
    html += '<button class="btn-add-row" onclick="addType()">+ 添加类型</button></div></div>';
    document.getElementById('typeEditorBody').innerHTML = html;
}

async function addType() { 
    const name = prompt('类型名称:'); 
    if (!name) return; 
    const icon = prompt('图标:', '🔑') || '🔑'; 
    const color = '#22c55e';
    try { 
        await fetch(API + '/account-types', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ name, icon, color, login_url: '' }) }); 
        await loadAccountTypes(); 
        renderTypeEditor(); 
        renderSidebar(); 
        showToast('添加成功');
    } catch {} 
}
async function updateType(id, field, value) { try { await fetch(API + `/account-types/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ [field]: value }) }); await loadAccountTypes(); renderSidebar(); renderCards(); } catch {} }
async function deleteType(id) { if (!confirm('删除此类型?')) return; try { await fetch(API + `/account-types/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }); await loadAccountTypes(); renderTypeEditor(); renderSidebar(); } catch {} }

// 导入导出
function openImportModal() { 
    document.getElementById('importFile').value = ''; 
    document.getElementById('importCsv').value = ''; 
    document.getElementById('importModal').classList.add('show'); 
    initDropZone();
}
function closeImportModal() { document.getElementById('importModal').classList.remove('show'); }

// 拖拽导入初始化
function initDropZone() {
    const dropZone = document.getElementById('dropZone');
    if (!dropZone || dropZone.dataset.initialized) return;
    dropZone.dataset.initialized = 'true';
    
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
        dropZone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); });
    });
    
    ['dragenter', 'dragover'].forEach(evt => {
        dropZone.addEventListener(evt, () => dropZone.classList.add('drag-over'));
    });
    
    ['dragleave', 'drop'].forEach(evt => {
        dropZone.addEventListener(evt, () => dropZone.classList.remove('drag-over'));
    });
    
    dropZone.addEventListener('drop', e => {
        const file = e.dataTransfer.files[0];
        if (file && file.name.endsWith('.json')) {
            handleDroppedFile(file);
        } else {
            showToast('请拖入 .json 文件', true);
        }
    });
}

function handleDroppedFile(file) {
    const reader = new FileReader();
    reader.onload = async (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            
            if (data.detail) {
                showToast('无效的备份文件: ' + data.detail, true);
                return;
            }
            if (!data.accounts || !Array.isArray(data.accounts)) {
                showToast('无效的备份文件格式', true);
                return;
            }
            if (data.accounts.length === 0) {
                showToast('备份文件中没有账号数据', true);
                return;
            }
            
            pendingImportData = data;
            const existingEmails = new Set(accounts.map(a => a.email?.toLowerCase()));
            const importAccounts = data.accounts || [];
            duplicateAccounts = importAccounts.filter(a => a.email && existingEmails.has(a.email.toLowerCase()));
            
            if (duplicateAccounts.length > 0) {
                showDuplicateModal(importAccounts.length, duplicateAccounts);
            } else {
                await doImportJson(data, 'all');
            }
        } catch (err) { 
            console.error('导入解析错误:', err);
            showToast('导入失败：文件格式错误', true); 
        }
    };
    reader.readAsText(file);
}

function handleImportFile(e) {
    const file = e.target.files[0]; if (!file) return;
    handleDroppedFile(file);
}

function showDuplicateModal(totalCount, duplicates) {
    closeImportModal();
    document.getElementById('duplicateSummary').innerHTML = `
        <div class="summary-item"><span class="summary-label">待导入:</span><span class="summary-value">${totalCount}</span></div>
        <div class="summary-item"><span class="summary-label">新账号:</span><span class="summary-value success">${totalCount - duplicates.length}</span></div>
        <div class="summary-item"><span class="summary-label">重复:</span><span class="summary-value warning">${duplicates.length}</span></div>
    `;
    let listHtml = '<div class="duplicate-list-title">重复账号:</div>';
    duplicates.slice(0, 10).forEach(a => listHtml += `<div class="duplicate-item">${escapeHtml(a.email)}</div>`);
    if (duplicates.length > 10) listHtml += `<div class="duplicate-more">... 还有 ${duplicates.length - 10} 个</div>`;
    document.getElementById('duplicateList').innerHTML = listHtml;
    document.getElementById('duplicateModal').classList.add('show');
}

function closeDuplicateModal() {
    document.getElementById('duplicateModal').classList.remove('show');
    pendingImportData = null; duplicateAccounts = [];
}

async function importWithOption(option) {
    if (!pendingImportData) { showToast('导入数据丢失', true); closeDuplicateModal(); return; }
    await doImportJson(pendingImportData, option);
    closeDuplicateModal();
}

async function doImportJson(data, option) {
    try {
        let importData = { ...data };
        if (option === 'skip') {
            const existingEmails = new Set(accounts.map(a => a.email?.toLowerCase()));
            importData.accounts = (data.accounts || []).filter(a => !a.email || !existingEmails.has(a.email.toLowerCase()));
        }
        const res = await fetch(API + '/import', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ ...importData, import_mode: option }) });
        const result = await res.json();
        showToast(result.message || '导入成功');
        closeImportModal(); loadData();
    } catch { showToast('导入失败', true); }
}

async function doImport() {
    const csv = document.getElementById('importCsv').value.trim();
    if (csv) { try { const res = await fetch(API + '/import-csv', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ csv }) }); const result = await res.json(); showToast(result.message); closeImportModal(); loadData(); } catch { showToast('导入失败', true); } }
    else showToast('请选择文件或粘贴CSV', true);
}

async function exportData() {
    // 确保 token 存在
    if (!token) token = localStorage.getItem('token');
    if (!token) {
        showToast('登录已过期，请重新登录', true);
        setTimeout(() => doLogout(), 500);
        return;
    }
    
    try {
        const res = await fetch(API + '/export', { headers: { 'Authorization': 'Bearer ' + token } });
        
        if (res.status === 401) {
            showToast('登录已过期，请重新登录', true);
            setTimeout(() => doLogout(), 500);
            return;
        }
        
        if (!res.ok) {
            showToast('导出失败', true);
            return;
        }
        
        const data = await res.json();
        
        // 检查是否是有效的备份数据
        if (!data.accounts || data.detail) {
            showToast('导出失败: ' + (data.detail || '无效数据'), true);
            return;
        }
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); 
        a.href = URL.createObjectURL(blob); 
        a.download = `accounts_backup_${new Date().toISOString().slice(0,10)}.json`; 
        a.click();
        showToast(`导出成功，共 ${data.accounts.length} 个账号`);
    } catch (e) { 
        console.error('导出错误:', e);
        showToast('导出失败', true); 
    }
}

// 工具
function toggleSidebar() { const s = document.getElementById('sidebar'); s.classList.toggle('collapsed'); s.classList.toggle('open'); }
function toggleGroup(el) { el.closest('.collapsible-group').classList.toggle('collapsed'); }
function showToast(msg, isError = false) { const t = document.getElementById('toast'); t.textContent = msg; t.className = 'toast show' + (isError ? ' error' : ''); setTimeout(() => t.classList.remove('show'), 2000); }
function escapeHtml(str) { return str ? str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }
function escapeAttr(str) { return str ? str.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;') : ''; }
function hexToRgba(hex, alpha) { const r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16); return `rgba(${r},${g},${b},${alpha})`; }
function adjustColor(hex, amount) { const num = parseInt(hex.slice(1), 16); return '#' + (0x1000000 + Math.min(255, Math.max(0, (num >> 16) + amount))*0x10000 + Math.min(255, Math.max(0, ((num >> 8) & 0xFF) + amount))*0x100 + Math.min(255, Math.max(0, (num & 0xFF) + amount))).toString(16).slice(1); }

// 三点菜单控制
function toggleCardMenu(id) {
    const card = document.querySelector(`.account-card[data-id="${id}"]`);
    const menu = card?.querySelector('.card-menu');
    if (!menu) return;
    
    // 先关闭所有其他菜单，移除其他卡片的menu-active类
    document.querySelectorAll('.card-menu.open').forEach(m => {
        if (m !== menu) {
            m.classList.remove('open');
            m.closest('.account-card')?.classList.remove('menu-active');
        }
    });
    
    menu.classList.toggle('open');
    card.classList.toggle('menu-active', menu.classList.contains('open'));
}

function closeAllMenus() {
    document.querySelectorAll('.card-menu.open').forEach(m => {
        m.classList.remove('open');
        m.closest('.account-card')?.classList.remove('menu-active');
    });
}

// 点击页面其他地方关闭菜单
document.addEventListener('click', (e) => {
    if (!e.target.closest('.card-menu')) {
        closeAllMenus();
    }
});

document.querySelectorAll('.modal-overlay').forEach(m => m.addEventListener('click', function(e) { if (e.target === this) this.classList.remove('show'); }));

// ==================== v10 批量选择功能 ====================
function toggleBatchMode() {
    batchMode = !batchMode;
    selectedAccounts.clear();
    updateBatchUI();
    renderCards();
}

function cancelBatchMode() {
    batchMode = false;
    selectedAccounts.clear();
    updateBatchUI();
    renderCards();
}

function updateBatchUI() {
    const batchActions = document.getElementById('batchActions');
    const btnBatchMode = document.getElementById('btnBatchMode');
    const btnBatchModeMobile = document.getElementById('btnBatchModeMobile');
    if (batchMode) {
        batchActions?.classList.add('show');
        btnBatchMode?.classList.add('active');
        btnBatchModeMobile?.classList.add('active');
        document.querySelector('.toolbar')?.classList.add('batch-mode');
    } else {
        batchActions?.classList.remove('show');
        btnBatchMode?.classList.remove('active');
        btnBatchModeMobile?.classList.remove('active');
        document.querySelector('.toolbar')?.classList.remove('batch-mode');
    }
    updateBatchCount();
}

function updateBatchCount() {
    const el = document.getElementById('batchCount');
    if (el) el.textContent = `已选 ${selectedAccounts.size} 项`;
}

function toggleAccountSelection(id, event) {
    if (event) event.stopPropagation();
    if (selectedAccounts.has(id)) {
        selectedAccounts.delete(id);
    } else {
        selectedAccounts.add(id);
    }
    updateBatchCount();
    // 只更新勾选框状态，不重新渲染整个卡片
    const card = document.querySelector(`.account-card[data-id="${id}"]`);
    if (card) {
        const checkbox = card.querySelector('.batch-checkbox input');
        if (checkbox) checkbox.checked = selectedAccounts.has(id);
    }
}

// 勾选当前页面全部
function selectAllVisible() {
    const filtered = getFilteredAccounts();
    const sorted = sortAccounts(filtered);
    sorted.forEach(acc => selectedAccounts.add(acc.id));
    updateBatchCount();
    renderCards();
}

// 取消全部勾选
function deselectAll() {
    selectedAccounts.clear();
    updateBatchCount();
    renderCards();
}

// 全选按钮：点一次全选，再点一次取消全选
function toggleSelectAll() {
    const filtered = getFilteredAccounts();
    const sorted = sortAccounts(filtered);
    const allSelected = sorted.length > 0 && sorted.every(acc => selectedAccounts.has(acc.id));
    
    if (allSelected) {
        deselectAll();
    } else {
        selectAllVisible();
    }
}

async function batchDelete() {
    if (selectedAccounts.size === 0) { showToast('请先选择账号', true); return; }
    
    // 如果内存中 token 丢失，尝试从 localStorage 恢复
    if (!token) {
        token = localStorage.getItem('token');
    }
    
    if (!token) {
        showToast('登录已过期，请重新登录', true);
        setTimeout(() => doLogout(), 500);
        return;
    }
    
    if (!confirm(`确定删除 ${selectedAccounts.size} 个账号?`)) return;
    
    let ok = 0, fail = 0;
    for (const id of selectedAccounts) {
        try {
            const res = await fetch(API + `/accounts/${id}`, { 
                method: 'DELETE', 
                headers: { 'Authorization': 'Bearer ' + token }
            });
            
            // 401 表示认证失败，直接退出登录
            if (res.status === 401) {
                showToast('登录已过期，请重新登录', true);
                setTimeout(() => doLogout(), 500);
                return;
            }
            
            // 200 成功删除，404 表示已不存在（也算删除成功）
            if (res.ok || res.status === 404) { 
                accounts = accounts.filter(a => a.id !== id); 
                ok++; 
            } else {
                fail++;
                console.error('删除失败:', id, res.status);
            }
        } catch (e) { 
            fail++; 
            console.error('删除异常:', id, e);
        }
    }
    selectedAccounts.clear(); batchMode = false;
    updateBatchUI(); renderSidebar(); renderCards();
    showToast(fail ? `删除${ok}个成功，${fail}个失败` : `已删除${ok}个账号`, fail > 0);
}

// ===== 用户面板 =====
function toggleUserPanel() {
    const panel = document.getElementById('userPanel');
    panel.classList.toggle('show');
    // 点击外部关闭
    if (panel.classList.contains('show')) {
        setTimeout(() => document.addEventListener('click', closeUserPanelOnClickOutside), 10);
    }
}

function closeUserPanelOnClickOutside(e) {
    const panel = document.getElementById('userPanel');
    const btn = document.getElementById('userAvatar');
    if (!panel.contains(e.target) && e.target !== btn) {
        panel.classList.remove('show');
        document.removeEventListener('click', closeUserPanelOnClickOutside);
    }
}

function closeUserPanel() {
    document.getElementById('userPanel').classList.remove('show');
    document.removeEventListener('click', closeUserPanelOnClickOutside);
}

// ===== 工具菜单（移动端） =====
function toggleToolsMenu() {
    const menu = document.getElementById('toolsMenu');
    menu.classList.toggle('show');
    if (menu.classList.contains('show')) {
        setTimeout(() => document.addEventListener('click', closeToolsMenuOnClickOutside), 10);
    }
}

function closeToolsMenuOnClickOutside(e) {
    const menu = document.getElementById('toolsMenu');
    const wrapper = e.target.closest('.tools-menu-wrapper');
    if (!wrapper) {
        menu.classList.remove('show');
        document.removeEventListener('click', closeToolsMenuOnClickOutside);
    }
}

function closeToolsMenu() {
    document.getElementById('toolsMenu').classList.remove('show');
    document.removeEventListener('click', closeToolsMenuOnClickOutside);
}

// ===== 密码重置 =====
function openPasswordReset() {
    closeUserPanel();
    document.getElementById('oldPassword').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('newPassword2').value = '';
    document.getElementById('passwordModal').classList.add('show');
}

function closePasswordModal() {
    document.getElementById('passwordModal').classList.remove('show');
}

async function submitPasswordReset() {
    const oldPwd = document.getElementById('oldPassword').value;
    const newPwd = document.getElementById('newPassword').value;
    const newPwd2 = document.getElementById('newPassword2').value;
    
    if (!oldPwd || !newPwd) { showToast('请填写密码', true); return; }
    if (newPwd !== newPwd2) { showToast('新密码不一致', true); return; }
    if (newPwd.length < 4) { showToast('密码至少4位', true); return; }
    
    try {
        const res = await fetch(API + '/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ old_password: oldPwd, new_password: newPwd })
        });
        const data = await res.json();
        if (res.ok) {
            showToast('密码修改成功');
            closePasswordModal();
        } else {
            showToast(data.detail || '修改失败', true);
        }
    } catch {
        showToast('网络错误', true);
    }
}

// ===== 头像选择 =====
const AVATAR_OPTIONS = ['👤', '😀', '😎', '🤡', '🤬', '🤠', '🥰', '🤗', '👨‍💻', '👩‍💻', '🤖', '🦊', '🐱', '🐶', '🐼', '🦁', '🐯', '🐸', '🐵', '🦄', '🌟', '🔥', '💎', '🎮', '🎯'];

function openAvatarPicker() {
    closeUserPanel();
    const grid = document.getElementById('avatarGrid');
    const currentAvatar = user.avatar || '👤';
    grid.innerHTML = AVATAR_OPTIONS.map(a => 
        `<div class="avatar-option ${a === currentAvatar ? 'selected' : ''}" onclick="selectAvatar('${a}')">${a}</div>`
    ).join('');
    document.getElementById('avatarModal').classList.add('show');
}

function closeAvatarModal() {
    document.getElementById('avatarModal').classList.remove('show');
}

async function selectAvatar(avatar) {
    try {
        const res = await fetch(API + '/update-avatar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ avatar: avatar })
        });
        const data = await res.json();
        if (res.ok) {
            user.avatar = avatar;
            localStorage.setItem('user', JSON.stringify(user));
            document.getElementById('userAvatar').textContent = avatar;
            document.getElementById('userAvatarLarge').textContent = avatar;
            closeAvatarModal();
            showToast('头像已更新');
        } else {
            showToast(data.detail || '更新失败', true);
        }
    } catch (e) {
        console.error('头像更新错误:', e);
        showToast('网络错误', true);
    }
}

// ===== 收藏便签样式选择 =====
const FAV_STYLES = [
    { id: 'purple', name: '紫色心形', color: '#8b5cf6', icon: '♥' },
    { id: 'pink', name: '粉色星星', color: '#ec4899', icon: '★' },
    { id: 'gold', name: '金色星星', color: '#f59e0b', icon: '★' },
    { id: 'red', name: '红色心形', color: '#ef4444', icon: '♥' },
    { id: 'blue', name: '蓝色菱形', color: '#3b82f6', icon: '✦' },
    { id: 'green', name: '绿色勾选', color: '#22c55e', icon: '✓' }
];

function openFavStylePicker() {
    closeUserPanel();
    const grid = document.getElementById('favStyleGrid');
    const currentStyle = localStorage.getItem('favStyle') || 'purple';
    grid.innerHTML = FAV_STYLES.map(s => `
        <div class="fav-style-option ${s.id === currentStyle ? 'selected' : ''}" onclick="selectFavStyle('${s.id}')">
            <div class="fav-style-preview style-${s.id}"></div>
            <span class="fav-style-name">${s.name}</span>
        </div>
    `).join('');
    document.getElementById('favStyleModal').classList.add('show');
}

function closeFavStyleModal() {
    document.getElementById('favStyleModal').classList.remove('show');
}

function selectFavStyle(styleId) {
    localStorage.setItem('favStyle', styleId);
    applyFavStyle(styleId);
    closeFavStyleModal();
    showToast('收藏样式已更新');
}

function applyFavStyle(styleId) {
    const style = FAV_STYLES.find(s => s.id === styleId) || FAV_STYLES[0];
    document.documentElement.style.setProperty('--fav-color', style.color);
    document.documentElement.style.setProperty('--fav-icon', `'${style.icon}'`);
}

// 初始化时应用收藏样式
function initFavStyle() {
    const styleId = localStorage.getItem('favStyle') || 'purple';
    applyFavStyle(styleId);
}

// ==================== v12.0 新增：随机密码生成器 ====================
function generatePassword(length = 16) {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*';
    const array = new Uint32Array(length);
    window.crypto.getRandomValues(array);
    return Array.from(array, x => chars[x % chars.length]).join('');
}

function generateAndFillPassword() {
    const pwd = generatePassword(16);
    const input = document.getElementById('accPassword');
    if (input) {
        input.value = pwd;
        input.type = 'text'; // 生成后显示
        updateTogglePwdBtn(true);
        setTimeout(() => {
            input.type = 'password';
            updateTogglePwdBtn(false);
        }, 3000);
    }
    copyToClipboard(pwd).then(ok => {
        if (ok) showToast('🎲 已生成16位强密码并复制');
    });
}

function togglePasswordVisibility() {
    const input = document.getElementById('accPassword');
    if (!input) return;
    const isVisible = input.type === 'text';
    input.type = isVisible ? 'password' : 'text';
    updateTogglePwdBtn(!isVisible);
}

function updateTogglePwdBtn(isVisible) {
    const btn = document.querySelector('.btn-toggle-pwd');
    if (btn) btn.textContent = isVisible ? '🙈' : '👁️';
}

// ==================== v12.0 新增：2FA TOTP 模块 ====================
const STEAM_CHARS = "23456789BCDFGHJKMNPQRTVWXY";
let totpIntervals = {};
let clipboardTimeout = null;

function base32Decode(str) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    str = str.toUpperCase().replace(/\s+/g, '').replace(/=+$/, '');
    let bits = '', bytes = [];
    for (let c of str) {
        const idx = alphabet.indexOf(c);
        if (idx >= 0) bits += idx.toString(2).padStart(5, '0');
    }
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.slice(i, i + 8), 2));
    }
    return new Uint8Array(bytes);
}

async function hmacSha1(key, data) {
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data));
}

async function generateTOTP(secret, timeOffset = 0, digits = 6, period = 30) {
    try {
        const key = base32Decode(secret);
        let counter = Math.floor((Date.now() / 1000 + timeOffset) / period);
        const counterBytes = new Uint8Array(8);
        for (let i = 7; i >= 0; i--) { counterBytes[i] = counter & 0xff; counter = Math.floor(counter / 256); }
        const hash = await hmacSha1(key, counterBytes);
        const offset = hash[hash.length - 1] & 0x0f;
        const code = ((hash[offset] & 0x7f) << 24 | (hash[offset + 1] & 0xff) << 16 | (hash[offset + 2] & 0xff) << 8 | (hash[offset + 3] & 0xff)) % Math.pow(10, digits);
        return code.toString().padStart(digits, '0');
    } catch (e) { console.error('TOTP错误:', e); return ''; }
}

async function generateSteamCode(secret, timeOffset = 0) {
    try {
        const key = Uint8Array.from(atob(secret), c => c.charCodeAt(0));
        let counter = Math.floor((Date.now() / 1000 + timeOffset) / 30);
        const counterBytes = new Uint8Array(8);
        for (let i = 7; i >= 0; i--) { counterBytes[i] = counter & 0xff; counter = Math.floor(counter / 256); }
        const hash = await hmacSha1(key, counterBytes);
        const offset = hash[hash.length - 1] & 0x0f;
        let code = ((hash[offset] & 0x7f) << 24 | (hash[offset + 1] & 0xff) << 16 | (hash[offset + 2] & 0xff) << 8 | (hash[offset + 3] & 0xff));
        let result = '';
        for (let i = 0; i < 5; i++) { result += STEAM_CHARS[code % STEAM_CHARS.length]; code = Math.floor(code / STEAM_CHARS.length); }
        return result;
    } catch (e) { console.error('Steam错误:', e); return ''; }
}

function getTimeRemaining(period = 30) {
    return period - Math.floor(Date.now() / 1000) % period;
}

async function show2FAPopup(accountId) {
    const acc = accounts.find(a => a.id === accountId);
    if (!acc || !acc.has_2fa) { showToast('该账号未配置2FA', true); return; }
    try {
        // 先获取配置信息
        const configRes = await apiRequest(`/accounts/${accountId}/totp`);
        if (!configRes.ok) throw new Error();
        const data = await configRes.json();
        
        const popup = document.createElement('div');
        popup.className = 'totp-popup';
        popup.id = `totp-popup-${accountId}`;
        popup.innerHTML = `<div class="totp-popup-content">
            <div class="totp-header"><span class="totp-issuer">${data.issuer || acc.email}</span><button class="totp-close" onclick="close2FAPopup(${accountId})">✕</button></div>
            <div class="totp-code-wrapper">
                <div class="totp-code" id="totp-code-${accountId}" onclick="copyTOTPCode(${accountId})" style="cursor:pointer">------</div>
                <svg class="totp-timer" viewBox="0 0 36 36"><path class="totp-timer-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/><path class="totp-timer-progress" id="totp-progress-${accountId}" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/></svg>
            </div>
            <div class="totp-actions"><button class="totp-copy-btn" onclick="copyTOTPCode(${accountId})">📋 复制</button><span class="totp-remaining" id="totp-remaining-${accountId}"></span></div>
        </div>`;
        document.body.appendChild(popup);
        popup.totpData = data;
        
        // 使用后端生成
        await updateTOTPDisplayFromBackend(accountId, data);
        totpIntervals[accountId] = setInterval(() => updateTOTPDisplayFromBackend(accountId, data), 1000);
        popup.addEventListener('click', e => { if (e.target === popup) close2FAPopup(accountId); });
    } catch { showToast('获取2FA失败', true); }
}

async function updateTOTPDisplayFromBackend(accountId, configData) {
    const codeEl = document.getElementById(`totp-code-${accountId}`);
    const progressEl = document.getElementById(`totp-progress-${accountId}`);
    const remainingEl = document.getElementById(`totp-remaining-${accountId}`);
    if (!codeEl) { clearInterval(totpIntervals[accountId]); return; }
    
    try {
        // 从后端获取验证码
        const res = await apiRequest(`/accounts/${accountId}/totp/generate`);
        if (!res.ok) return;
        const data = await res.json();
        
        const code = data.code;
        const remaining = data.remaining;
        const period = data.period || 30;
        const progress = (remaining / period) * 100;
        
        // 显示验证码（Steam 5位字母，标准TOTP分隔显示）
        if (data.type === 'steam') {
            codeEl.textContent = code;
            codeEl.style.letterSpacing = '6px';
        } else {
            const mid = Math.floor(code.length / 2);
            codeEl.textContent = code.slice(0, mid) + ' ' + code.slice(mid);
        }
        codeEl.dataset.code = code;
        
        progressEl.style.strokeDasharray = `${progress}, 100`;
        if (remaining <= 5) { progressEl.style.stroke = '#ef4444'; codeEl.classList.add('expiring'); }
        else if (remaining <= 10) { progressEl.style.stroke = '#f59e0b'; codeEl.classList.remove('expiring'); }
        else { progressEl.style.stroke = '#8b5cf6'; codeEl.classList.remove('expiring'); }
        remainingEl.textContent = `${remaining}s`;
    } catch (e) {
        console.error('更新验证码失败:', e);
    }
}

// 保留前端生成函数作为备用
async function updateTOTPDisplay(accountId, data) {
    const codeEl = document.getElementById(`totp-code-${accountId}`);
    const progressEl = document.getElementById(`totp-progress-${accountId}`);
    const remainingEl = document.getElementById(`totp-remaining-${accountId}`);
    if (!codeEl) { clearInterval(totpIntervals[accountId]); return; }
    const remaining = getTimeRemaining(data.period || 30);
    const progress = (remaining / (data.period || 30)) * 100;
    const code = data.type === 'steam' ? await generateSteamCode(data.secret, data.time_offset || 0) : await generateTOTP(data.secret, data.time_offset || 0, data.digits || 6, data.period || 30);
    if (!codeEl.classList.contains('blurred')) codeEl.textContent = code.length === 6 ? code.slice(0, 3) + ' ' + code.slice(3) : code;
    codeEl.dataset.code = code;
    progressEl.style.strokeDasharray = `${progress}, 100`;
    if (remaining <= 5) { progressEl.style.stroke = '#ef4444'; codeEl.classList.add('expiring'); }
    else if (remaining <= 10) { progressEl.style.stroke = '#f59e0b'; codeEl.classList.remove('expiring'); }
    else { progressEl.style.stroke = '#8b5cf6'; codeEl.classList.remove('expiring'); }
    remainingEl.textContent = `${remaining}s`;
}

function toggleTOTPBlur(accountId) {
    const codeEl = document.getElementById(`totp-code-${accountId}`);
    if (!codeEl) return;
    codeEl.classList.toggle('blurred');
    if (!codeEl.classList.contains('blurred')) {
        const code = codeEl.dataset.code || '';
        codeEl.textContent = code.length === 6 ? code.slice(0, 3) + ' ' + code.slice(3) : code;
        setTimeout(() => { if (codeEl && !codeEl.classList.contains('blurred')) { codeEl.classList.add('blurred'); codeEl.textContent = '------'; } }, 10000);
    } else codeEl.textContent = '------';
}

function copyTOTPCode(accountId) {
    const codeEl = document.getElementById(`totp-code-${accountId}`);
    if (!codeEl) return;
    copyToClipboard(codeEl.dataset.code || '').then(ok => {
        if (ok) {
            showToast('✓ 验证码已复制 (60秒后清除)');
            if (clipboardTimeout) clearTimeout(clipboardTimeout);
            clipboardTimeout = setTimeout(() => clearClipboard(), 60000);
        }
    });
}

function close2FAPopup(accountId) {
    document.getElementById(`totp-popup-${accountId}`)?.remove();
    if (totpIntervals[accountId]) { clearInterval(totpIntervals[accountId]); delete totpIntervals[accountId]; }
}

// ==================== v5.0 新增：二维码扫描 + 2FA 配置模态框 ====================

let current2FAAccountId = null;

function open2FAConfig(accountId) {
    const acc = accounts.find(a => a.id === accountId);
    if (!acc) return;
    
    current2FAAccountId = accountId;
    const modal = document.getElementById('twoFAConfigModal');
    
    // 重置表单
    document.getElementById('totp2FASecret').value = '';
    document.getElementById('totp2FAIssuer').value = '';
    document.getElementById('totp2FAType').value = 'totp';
    document.getElementById('totp2FAAlgorithm').value = 'SHA1';
    document.getElementById('totp2FADigits').value = '6';
    document.getElementById('totp2FATimeOffset').value = '0';
    document.getElementById('qrScanResult').style.display = 'none';
    document.getElementById('qrScanResult').innerHTML = '';
    
    // 如果已有2FA配置，加载现有配置
    if (acc.has_2fa) {
        document.getElementById('btn2FADelete').style.display = 'block';
        loadExisting2FAConfig(accountId);
    } else {
        document.getElementById('btn2FADelete').style.display = 'none';
    }
    
    // 初始化拖拽上传
    initQRDropZone();
    
    modal.classList.add('show');
}

function close2FAConfigModal() {
    document.getElementById('twoFAConfigModal').classList.remove('show');
    current2FAAccountId = null;
}

async function loadExisting2FAConfig(accountId) {
    try {
        const res = await apiRequest(`/accounts/${accountId}/totp`);
        if (res.ok) {
            const data = await res.json();
            if (data.secret) {
                document.getElementById('totp2FASecret').value = data.secret;
                document.getElementById('totp2FAIssuer').value = data.issuer || '';
                document.getElementById('totp2FAType').value = data.type || 'totp';
                document.getElementById('totp2FAAlgorithm').value = data.algorithm || 'SHA1';
                document.getElementById('totp2FADigits').value = data.digits || 6;
                document.getElementById('totp2FATimeOffset').value = data.time_offset || 0;
            }
        }
    } catch (e) {
        console.error('加载2FA配置失败', e);
    }
}

// 二维码扫描功能
function initQRDropZone() {
    const zone = document.getElementById('qrUploadZone');
    if (!zone || zone.dataset.initialized) return;
    zone.dataset.initialized = 'true';
    
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
        zone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); });
    });
    
    ['dragenter', 'dragover'].forEach(evt => {
        zone.addEventListener(evt, () => zone.classList.add('drag-over'));
    });
    
    ['dragleave', 'drop'].forEach(evt => {
        zone.addEventListener(evt, () => zone.classList.remove('drag-over'));
    });
    
    zone.addEventListener('drop', e => {
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) {
            scanQRFromFile(file);
        } else {
            showToast('请拖入图片文件', true);
        }
    });
}

function handleQRUpload(event) {
    const file = event.target.files[0];
    if (file) {
        scanQRFromFile(file);
    }
}

async function scanQRFromFile(file) {
    const resultDiv = document.getElementById('qrScanResult');
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = '<span style="color:var(--text-secondary)">🔄 正在识别二维码...</span>';
    
    try {
        const img = await createImageBitmap(file);
        const canvas = document.getElementById('qrCanvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        
        // 使用 jsQR 解析
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        
        if (code && code.data) {
            const uri = code.data;
            if (uri.startsWith('otpauth://')) {
                parseOtpAuthUri(uri);
                resultDiv.innerHTML = '<span style="color:#22c55e">✅ 识别成功！已自动填充配置</span>';
            } else {
                resultDiv.innerHTML = '<span style="color:#ef4444">❌ 二维码内容不是有效的 2FA 配置</span>';
            }
        } else {
            resultDiv.innerHTML = '<span style="color:#ef4444">❌ 未能识别二维码，请确保图片清晰</span>';
        }
    } catch (e) {
        console.error('二维码识别错误:', e);
        resultDiv.innerHTML = '<span style="color:#ef4444">❌ 识别失败：' + e.message + '</span>';
    }
}

function parseOtpAuthUri(uri) {
    try {
        const url = new URL(uri);
        const params = url.searchParams;
        
        // 提取 secret
        const secret = params.get('secret');
        if (secret) document.getElementById('totp2FASecret').value = secret;
        
        // 提取 issuer
        let issuer = params.get('issuer');
        if (!issuer) {
            const path = decodeURIComponent(url.pathname.slice(1));
            issuer = path.includes(':') ? path.split(':')[0] : path;
        }
        if (issuer) document.getElementById('totp2FAIssuer').value = issuer;
        
        // 提取类型
        const type = url.host;
        if (type === 'totp' || type === 'hotp') document.getElementById('totp2FAType').value = type;
        if (uri.toLowerCase().includes('steam')) document.getElementById('totp2FAType').value = 'steam';
        
        // 提取算法
        const algorithm = params.get('algorithm');
        if (algorithm) document.getElementById('totp2FAAlgorithm').value = algorithm.toUpperCase();
        
        // 提取位数
        const digits = params.get('digits');
        if (digits) document.getElementById('totp2FADigits').value = digits;
        
        // 提取周期
        const period = params.get('period');
        if (period) console.log('周期:', period); // 后端会使用
        
        console.log('解析 otpauth URI:', { secret: secret ? '***' : null, issuer, type });
    } catch (e) {
        console.error('解析 otpauth URI 失败:', e);
    }
}

async function save2FAConfig() {
    const secret = document.getElementById('totp2FASecret').value.trim();
    if (!secret) { showToast('请输入密钥或扫描二维码', true); return; }
    if (secret.length < 8) { showToast('密钥长度不足', true); return; }
    
    const config = {
        secret: secret,
        issuer: document.getElementById('totp2FAIssuer').value.trim(),
        totp_type: document.getElementById('totp2FAType').value,
        algorithm: document.getElementById('totp2FAAlgorithm').value,
        digits: parseInt(document.getElementById('totp2FADigits').value) || 6,
        period: 30,
        backup_codes: []
    };
    
    try {
        const res = await apiRequest(`/accounts/${current2FAAccountId}/totp`, {
            method: 'POST',
            body: JSON.stringify(config)
        });
        
        if (res.ok) {
            showToast('✅ 2FA 配置成功');
            close2FAConfigModal();
            await loadData();
        } else {
            const data = await res.json();
            showToast(data.detail || '保存失败', true);
        }
    } catch (e) {
        console.error('保存2FA配置错误:', e);
        showToast('网络错误', true);
    }
}

async function delete2FAFromModal() {
    if (!confirm('⚠️ 确定要移除该账号的 2FA 保护吗？')) return;
    
    try {
        const res = await apiRequest(`/accounts/${current2FAAccountId}/totp`, { method: 'DELETE' });
        if (res.ok) {
            showToast('🗑️ 2FA 已移除');
            close2FAConfigModal();
            await loadData();
        } else {
            showToast('移除失败', true);
        }
    } catch (e) {
        showToast('网络错误', true);
    }
}

// 保留旧的 delete2FA 函数兼容
async function delete2FA(accountId) {
    current2FAAccountId = accountId;
    await delete2FAFromModal();
}

init();
