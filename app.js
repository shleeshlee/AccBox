const API = '/api';
const VERSION = 'v11.5'; // 添加无属性组视图、GitHub链接、美化滚动条
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
        typesHtml += `<div class="nav-item${isSelected ? ' active' : ''}" onclick="filterByType(${t.id})"><span class="nav-icon" style="color:${t.color}">${t.icon}</span><span class="nav-label">${t.name}</span><span class="nav-count">${count}</span></div>`;
    });
    typesHtml += '</div></div>';
    document.getElementById('sidebarTypes').innerHTML = typesHtml;

    let propsHtml = '';
    propertyGroups.forEach(g => {
        
        propsHtml += `<div class="collapsible-group"><div class="group-header" onclick="toggleGroup(this)"><span class="group-arrow">▼</span><span>${g.name}</span><span class="group-actions"><button class="btn-tiny" onclick="event.stopPropagation();openPropertyManager()">⚙</button></span></div><div class="group-content">`;
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
            propsHtml += `<div class="prop-item${isSelected ? ' active' : ''}" onclick="filterByProperty(${g.id},${v.id})"><span class="prop-dot" style="background:${v.color}"></span><span class="prop-label">${v.name}</span><span class="prop-count">${count}</span></div>`;
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
        
        // 根据combos判断卡片状态
        let cardClass = 'account-card';
        if (batchMode && selectedAccounts.has(acc.id)) cardClass += ' selected';
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

        // 批量选择复选框
        const checkboxHtml = batchMode ? `<label class="batch-checkbox" onclick="toggleAccountSelection(${acc.id}, event)"><input type="checkbox" ${selectedAccounts.has(acc.id) ? 'checked' : ''}><span class="checkmark"></span></label>` : '';

        // 收藏状态通过卡片类名控制（紫色高亮）
        const favoriteClass = acc.is_favorite ? 'favorite' : '';

        return `<div class="${cardClass} ${favoriteClass}" data-id="${acc.id}">
            <div class="card-body">
                <div class="card-header">
                    ${checkboxHtml}
                    <div class="card-icon" style="background:linear-gradient(135deg,${type.color},${adjustColor(type.color,-20)})">${type.icon}</div>
                    <div class="card-info" onclick="copyEmail('${escapeHtml(acc.email)}')" title="点击复制邮箱"><div class="card-name">${escapeHtml(acc.customName || acc.email)}</div><div class="card-email">${escapeHtml(acc.email)}</div></div>
                    <div class="card-combos">${combosHtml}</div>
                    <div class="card-meta">
                        <span class="card-country">${getCountryDisplay(acc.country)}</span>
                        <div class="card-menu" onclick="event.stopPropagation()">
                            <button class="btn-menu-dots" onclick="toggleCardMenu(${acc.id})">⋮</button>
                            <div class="card-menu-dropdown">
                                <div class="menu-item" onclick="toggleFavorite(${acc.id});closeAllMenus()">${acc.is_favorite ? '💔 取消收藏' : '💜 收藏'}</div>
                                <div class="menu-item" onclick="openEditModal(${acc.id});closeAllMenus()">✏️ 编辑</div>
                                <div class="menu-item danger" onclick="deleteAccount(${acc.id});closeAllMenus()">🗑️ 删除</div>
                            </div>
                        </div>
                    </div>
                </div>
                ${(acc.tags||[]).length ? `<div class="card-tags">${acc.tags.map(t => `<span class="free-tag">${t}</span>`).join('')}</div>` : ''}
            </div>
            <div class="card-footer">
                <button class="btn-action" onclick="copyEmail('${escapeHtml(acc.email)}')">📋 复制</button>
                <button class="btn-action" onclick="loginTest(${acc.id})">🔗 登录</button>
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
    // 切换选中状态：如果已选中则取消，否则添加
    if (currentFilters[key]) {
        delete currentFilters[key];
        lastClickedFilter = null;
    } else {
        currentFilters[key] = typeId;
        lastClickedFilter = { type: 'type', id: typeId, name: t?.name || '账号类型' };
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
    const viewName = currentView === 'all' ? '全部账号' : currentView === 'favorites' ? '收藏' : currentView === 'nocombo' ? '无属性组' : '最近使用';
    
    if (lastClickedFilter) {
        document.getElementById('pageTitle').textContent = viewName + ' > ' + lastClickedFilter.name;
    } else {
        document.getElementById('pageTitle').textContent = viewName;
    }
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
            if (t) html += `<div class="filter-tag"><span class="dot" style="background:${t.color}"></span>${t.name}<span class="remove" onclick="removeFilter('${key}')">✕</span></div>`;
        }
    });
    
    // 属性值标签
    Object.keys(currentFilters).forEach(key => {
        if (key.startsWith('noprop_')) {
            const groupId = currentFilters[key];
            const g = propertyGroups.find(g => g.id === groupId);
            if (g) {
                html += `<div class="filter-tag"><span class="dot" style="background:#9ca3af"></span>${g.name} - 未设置<span class="remove" onclick="removeFilter('${key}')">✕</span></div>`;
            }
        }
        if (key.startsWith('propval_')) {
            const valueId = currentFilters[key];
            for (const g of propertyGroups) {
                const v = (g.values || []).find(v => v.id === valueId);
                if (v) {
                    html += `<div class="filter-tag"><span class="dot" style="background:${v.color}"></span>${v.name}<span class="remove" onclick="removeFilter('${key}')">✕</span></div>`;
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

function copyEmail(email) { navigator.clipboard.writeText(email); showToast('已复制'); }

async function loginTest(id) {
    const acc = accounts.find(a => a.id === id);
    if (!acc) return;
    try { await fetch(API + `/accounts/${id}/use`, { method: 'POST', headers: { Authorization: 'Bearer ' + token } }); acc.last_used = new Date().toISOString(); } catch {}
    navigator.clipboard.writeText(acc.email); showToast('已复制邮箱');
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
    document.getElementById('accType').innerHTML = accountTypes.map(t => `<option value="${t.id}">${t.icon} ${t.name}</option>`).join('');
    ['accName', 'accEmail', 'accPassword', 'accNotes'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('accCountry').value = '🌍';
    renderCombosBox(); renderTagsBox();
    document.getElementById('accountModal').classList.add('show');
}

function openEditModal(id) {
    const acc = accounts.find(a => a.id === id);
    if (!acc) return;
    editingAccountId = id; editingTags = [...(acc.tags || [])]; editingCombos = [...(acc.combos || [])];
    document.getElementById('accountModalTitle').textContent = '编辑账号';
    document.getElementById('accType').innerHTML = accountTypes.map(t => `<option value="${t.id}" ${t.id === acc.type_id ? 'selected' : ''}>${t.icon} ${t.name}</option>`).join('');
    document.getElementById('accName').value = acc.customName || '';
    document.getElementById('accEmail').value = acc.email || '';
    document.getElementById('accPassword').value = acc.password || '';
    document.getElementById('accCountry').value = acc.country || '🌍';
    document.getElementById('accNotes').value = acc.notes || '';
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
        html += `<div class="combo-group"><div class="combo-group-name">${g.name}</div><div class="combo-group-options">`;
        if ((g.values || []).length === 0) {
            html += `<span class="combo-empty">暂无属性值</span>`;
        }
        (g.values || []).forEach(v => {
            html += `<div class="combo-option" data-vid="${v.id}" data-color="${v.color}" onclick="toggleComboOption(this)"><span class="combo-check-dot" style="background:${v.color}"></span>${v.name}</div>`;
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
    let html = '<div class="hint-box"><p>设置平台图标和登录链接。</p></div><div class="editor-group"><div class="editor-values">';
    accountTypes.forEach(t => html += `<div class="value-row"><input type="text" value="${escapeHtml(t.icon)}" style="width:40px;text-align:center" onchange="updateType(${t.id}, 'icon', this.value)"><input type="text" value="${escapeHtml(t.name)}" onchange="updateType(${t.id}, 'name', this.value)"><input type="text" value="${escapeHtml(t.login_url)}" style="flex:2" placeholder="登录链接" onchange="updateType(${t.id}, 'login_url', this.value)"><button class="btn-del" onclick="deleteType(${t.id})">✕</button></div>`);
    html += '<button class="btn-add-row" onclick="addType()">+ 添加类型</button></div></div>';
    document.getElementById('typeEditorBody').innerHTML = html;
}

async function addType() { const name = prompt('类型名称:'); if (!name) return; const icon = prompt('图标:', '🔑') || '🔑'; try { await fetch(API + '/account-types', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ name, icon, color: '#8b5cf6', login_url: '' }) }); await loadAccountTypes(); renderTypeEditor(); renderSidebar(); } catch {} }
async function updateType(id, field, value) { try { await fetch(API + `/account-types/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ [field]: value }) }); await loadAccountTypes(); renderSidebar(); renderCards(); } catch {} }
async function deleteType(id) { if (!confirm('删除此类型?')) return; try { await fetch(API + `/account-types/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }); await loadAccountTypes(); renderTypeEditor(); renderSidebar(); } catch {} }

// 导入导出
function openImportModal() { document.getElementById('importFile').value = ''; document.getElementById('importCsv').value = ''; document.getElementById('importModal').classList.add('show'); }
function closeImportModal() { document.getElementById('importModal').classList.remove('show'); }

function handleImportFile(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            pendingImportData = data;
            
            // 检测重复
            const existingEmails = new Set(accounts.map(a => a.email?.toLowerCase()));
            const importAccounts = data.accounts || [];
            duplicateAccounts = importAccounts.filter(a => a.email && existingEmails.has(a.email.toLowerCase()));
            
            if (duplicateAccounts.length > 0) {
                showDuplicateModal(importAccounts.length, duplicateAccounts);
            } else {
                await doImportJson(data, 'all');
            }
        } catch { showToast('导入失败', true); }
    };
    reader.readAsText(file);
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
    try {
        const res = await fetch(API + '/export', { headers: { Authorization: 'Bearer ' + token } });
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `accounts_backup_${new Date().toISOString().slice(0,10)}.json`; a.click();
        showToast('导出成功');
    } catch { showToast('导出失败', true); }
}

// 工具
function toggleSidebar() { const s = document.getElementById('sidebar'); s.classList.toggle('collapsed'); s.classList.toggle('open'); }
function toggleGroup(el) { el.closest('.collapsible-group').classList.toggle('collapsed'); }
function showToast(msg, isError = false) { const t = document.getElementById('toast'); t.textContent = msg; t.className = 'toast show' + (isError ? ' error' : ''); setTimeout(() => t.classList.remove('show'), 2000); }
function escapeHtml(str) { return str ? str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }
function hexToRgba(hex, alpha) { const r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16); return `rgba(${r},${g},${b},${alpha})`; }
function adjustColor(hex, amount) { const num = parseInt(hex.slice(1), 16); return '#' + (0x1000000 + Math.min(255, Math.max(0, (num >> 16) + amount))*0x10000 + Math.min(255, Math.max(0, ((num >> 8) & 0xFF) + amount))*0x100 + Math.min(255, Math.max(0, (num & 0xFF) + amount))).toString(16).slice(1); }

// 三点菜单控制
function toggleCardMenu(id) {
    const card = document.querySelector(`.account-card[data-id="${id}"]`);
    const menu = card?.querySelector('.card-menu');
    if (!menu) return;
    
    // 先关闭所有其他菜单
    document.querySelectorAll('.card-menu.open').forEach(m => {
        if (m !== menu) m.classList.remove('open');
    });
    
    menu.classList.toggle('open');
}

function closeAllMenus() {
    document.querySelectorAll('.card-menu.open').forEach(m => m.classList.remove('open'));
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
    if (selectedAccounts.has(id)) selectedAccounts.delete(id);
    else selectedAccounts.add(id);
    updateBatchCount();
    const card = document.querySelector(`.account-card[data-id="${id}"]`);
    if (card) card.classList.toggle('selected', selectedAccounts.has(id));
}

async function batchDelete() {
    if (selectedAccounts.size === 0) { showToast('请先选择账号', true); return; }
    if (!confirm(`确定删除 ${selectedAccounts.size} 个账号?`)) return;
    let ok = 0, fail = 0;
    for (const id of selectedAccounts) {
        try {
            const res = await fetch(API + `/accounts/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
            if (res.ok) { accounts = accounts.filter(a => a.id !== id); ok++; } else fail++;
        } catch { fail++; }
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
const AVATAR_OPTIONS = ['👤', '😀', '😎', '🤖', '👨‍💻', '👩‍💻', '🦊', '🐱', '🐶', '🐼', '🦁', '🐯', '🐸', '🐵', '🦄', '🌟', '🔥', '💎', '🎮', '🎯'];

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

init();
