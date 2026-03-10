const API = '/api';
const VERSION = 'v5.1.4'; // 辅助邮箱联想 + 智能轮询 + 导入导出邮箱凭证 + 移动端搜索栏优化
let token = localStorage.getItem('token');
let user = JSON.parse(localStorage.getItem('user') || 'null');
let accounts = [], accountTypes = [], propertyGroups = [];
let currentView = 'all', currentSort = 'recent', currentFilters = {};
let currentExcludes = {}; // 新增：排除筛选
let currentSortDir = 'desc'; // 排序方向: 'asc' 或 'desc'
let lastClickedFilter = null; // 记录最后点击的筛选项 {type: 'type'|'propval'|'noprop', id: xxx, name: xxx}
let currentViewMode = localStorage.getItem('viewMode') || 'card'; // 卡片/列表视图
let showTimeBadge = localStorage.getItem('showTimeBadge') !== 'false'; // 时间提醒开关，默认开启
let editingAccountId = null, editingTags = [], editingCombos = [];

// v10 新增：批量操作和导入重复检测
let batchMode = false;
let selectedAccounts = new Set();
let pendingImportData = null;
let duplicateAccounts = [];

// v5.1.3 新增：邮箱验证码功能
let authorizedEmails = []; // 已授权邮箱列表
let pendingEmails = []; // 待授权邮箱列表（从账号辅助邮箱收集）
let verificationCodes = []; // 验证码列表（最近5条）
let selectedProvider = 'gmail'; // 当前选择的邮箱类型
let pushSettings = JSON.parse(localStorage.getItem('pushSettings') || '{"notify":true,"toast":true}');
let codeToastTimer = null; // 验证码弹窗定时器
let emailPollingInterval = null; // 邮箱轮询定时器

// v5.1.4 新增：智能轮询 - 页面可见性检测
let isPageVisible = true;
let pollingInterval = 5000; // 默认5秒轮询（学注册机：高频短间隔）
let pollingIntervalFast = 3000; // 高频模式3秒轮询
let fastModeEndTime = 0; // 高频模式结束时间


// ==================== CSRF Token 读取 ====================
function getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : '';
}

// ==================== 补丁：核心 API 请求函数 ==
async function apiRequest(endpoint, options = {}) {
    const url = API + endpoint;

    const defaultHeaders = {
        'Content-Type': 'application/json',
    };
    // 灰度期：Bearer + Cookie 并行
    if (token) defaultHeaders['Authorization'] = 'Bearer ' + token;
    // 非 GET 请求附加 CSRF token
    const method = (options.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
        defaultHeaders['X-CSRF-Token'] = getCsrfToken();
    }

    const config = {
        ...options,
        credentials: 'same-origin',
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
    console.log('账号管家初始化', VERSION); // 保留：启动日志
    initTheme();
    initSeason(); // 初始化季节主题
    initViewMode();
    initFavStyle();
    initTimeBadge(); // 初始化时间提醒开关
    if (token && user) { showApp(); loadData(); }
    checkSecurity(); // 安全检查
    checkHttpWarning(); // HTTP不安全警告
}

// ==================== HTTP 不安全警告 ====================
function checkHttpWarning() {
    // 检测是否为HTTP且非localhost
    const isHttp = window.location.protocol === 'http:';
    const isLocalhost = window.location.hostname === 'localhost' || 
                        window.location.hostname === '127.0.0.1' ||
                        window.location.hostname.endsWith('.local');
    
    // 检查用户是否已经关闭过警告（本次会话）
    const dismissed = sessionStorage.getItem('httpWarningDismissed');
    
    if (isHttp && !isLocalhost && !dismissed) {
        const warning = document.getElementById('httpWarning');
        if (warning) {
            warning.style.display = 'flex';
            // 给内容区域添加底部padding
            document.querySelector('.content')?.style.setProperty('padding-bottom', '60px');
        }
    }
}

function dismissHttpWarning() {
    const warning = document.getElementById('httpWarning');
    if (warning) {
        warning.style.display = 'none';
        sessionStorage.setItem('httpWarningDismissed', 'true');
        document.querySelector('.content')?.style.removeProperty('padding-bottom');
    }
}

// ==================== 时间提醒开关 ====================
function initTimeBadge() {
    updateTimeBadgeUI();
}

function toggleTimeBadge() {
    showTimeBadge = !showTimeBadge;
    localStorage.setItem('showTimeBadge', showTimeBadge);
    updateTimeBadgeUI();
    renderCards(); // 重新渲染卡片
    showToast(showTimeBadge ? '⏰️ 时间提醒已开启' : '😴 时间提醒已关闭');
}

function updateTimeBadgeUI() {
    // PC端更多菜单中的图标和状态
    const menuIcon = document.getElementById('menuTimeBadgeIcon');
    const menuStatus = document.getElementById('menuTimeBadgeStatus');
    // 移动端更多菜单中的图标和状态
    const mobileIcon = document.getElementById('mobileTimeBadgeIcon');
    const mobileStatus = document.getElementById('mobileTimeBadgeStatus');
    
    const iconText = showTimeBadge ? '⏰️' : '😴';
    const statusText = showTimeBadge ? '开' : '关';
    const statusClass = 'toggle-status ' + (showTimeBadge ? 'on' : 'off');
    
    if (menuIcon) menuIcon.textContent = iconText;
    if (menuStatus) {
        menuStatus.textContent = statusText;
        menuStatus.className = statusClass;
    }
    if (mobileIcon) mobileIcon.textContent = iconText;
    if (mobileStatus) {
        mobileStatus.textContent = statusText;
        mobileStatus.className = statusClass;
    }
}

// ==================== 安全检查 ====================
async function checkSecurity() {
    // 公共密钥检测已由 install.sh 自动处理
    // 保留此函数以备后续扩展
}

function showSecurityModal(title, htmlContent) {
    const warningHtml = `
    <div style="position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;">
        <div style="background:#18181b;border:2px solid #ef4444;border-radius:16px;padding:30px;max-width:500px;text-align:center;box-shadow:0 0 50px rgba(239,68,68,0.5);">
            <div style="font-size:4rem;margin-bottom:20px;">☢️</div>
            <h2 style="color:#ef4444;margin-bottom:20px;font-size:1.5rem;">${title}</h2>
            <div style="color:#e4e4e7;text-align:left;line-height:1.6;font-size:0.95rem;background:rgba(239,68,68,0.1);padding:15px;border-radius:8px;">${htmlContent}</div>
            <div style="margin-top:25px;font-size:0.85rem;color:#71717a;">修改密钥后重启容器，此警告将自动消失。</div>
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

// 移动端单按钮切换视图
function toggleViewMode() {
    const newMode = currentViewMode === 'card' ? 'list' : 'card';
    setViewMode(newMode);
    // 更新移动端按钮图标
    const btn = document.getElementById('mobileViewBtn');
    if (btn) btn.textContent = newMode === 'card' ? '🃏' : '☰';
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


/* ============================================
   主题切换 - 赛博金库动画版
   ============================================ */
let currentTheme = localStorage.getItem('theme') || 'dark';
let isThemeSwitching = false;

function initTheme() {
    // 设置主题
    document.documentElement.setAttribute('data-theme', currentTheme === 'light' ? 'light' : '');
    
    // 更新按钮图标
    ['themeBtn', 'themeBtn2'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            const icon = el.querySelector('.icon');
            if (icon) icon.textContent = currentTheme === 'light' ? '☀️' : '🌙';
            else el.textContent = currentTheme === 'light' ? '☀️' : '🌙';
        }
    });
}

function createPulseRings(cx, cy, toLight) {
    const colors = toLight 
        ? ['rgba(251, 191, 36, 0.5)', 'rgba(124, 58, 237, 0.3)']
        : ['rgba(139, 92, 246, 0.5)', 'rgba(99, 102, 241, 0.3)'];
    const sizes = [80, 120];
    colors.forEach((color, i) => {
        const ring = document.createElement('div');
        ring.className = 'pulse-ring';
        ring.style.cssText = `left:${cx}px;top:${cy}px;width:${sizes[i]}vmax;height:${sizes[i]}vmax;border:2px solid ${color};box-shadow:0 0 20px ${color};`;
        document.body.appendChild(ring);
        setTimeout(() => ring.classList.add('burst'), i * 50);
        setTimeout(() => ring.remove(), 500);
    });
}

// 主界面用：View Transition API 圆形扩散（Telegram同款）
// 备用方案：遮罩冻结（兼容旧浏览器）
function toggleTheme(event) {
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    // 获取点击坐标（如果有事件），否则使用屏幕中心
    let x, y;
    if (event && event.clientX !== undefined) {
        x = event.clientX;
        y = event.clientY;
    } else {
        x = window.innerWidth / 2;
        y = window.innerHeight / 2;
    }
    
    // 真正执行切换的函数
    const doSwitch = () => {
        currentTheme = newTheme;
        localStorage.setItem('theme', currentTheme);
        initTheme();
    };
    
    // 方案一：View Transition API（推荐）
    if (document.startViewTransition) {
        const transition = document.startViewTransition(doSwitch);
        
        // 计算从点击点到最远角落的距离
        const endRadius = Math.hypot(
            Math.max(x, window.innerWidth - x),
            Math.max(y, window.innerHeight - y)
        );
        
        // 圆形扩散动画
        transition.ready.then(() => {
            document.documentElement.animate(
                {
                    clipPath: [
                        `circle(0px at ${x}px ${y}px)`,
                        `circle(${endRadius}px at ${x}px ${y}px)`
                    ]
                },
                {
                    duration: 400,
                    easing: 'ease-out',
                    pseudoElement: '::view-transition-new(root)'
                }
            );
        }).catch(() => {});
        return;
    }
    
    // 方案二：遮罩冻结（备用）
    // 获取当前真实背景色（关键！避免色差）
    const currentBg = getComputedStyle(document.body).backgroundColor;
    
    const mask = document.createElement('div');
    Object.assign(mask.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        bottom: '0',
        backgroundColor: currentBg,
        zIndex: '99999',
        pointerEvents: 'none',
        transition: 'opacity 0.25s ease-out',
        opacity: '1'
    });
    
    document.body.appendChild(mask);
    
    // 强制渲染一帧，确保遮罩显示
    requestAnimationFrame(() => {
        // 在遮罩掩护下切换主题
        doSwitch();
        
        // 下一帧开始淡出
        requestAnimationFrame(() => {
            mask.style.opacity = '0';
        });
        
        // 动画结束后清理
        setTimeout(() => {
            mask.remove();
        }, 250);
    });
}

// 登录页用：带脉冲动画的主题切换
function switchThemeWithEffect(event) {
    if (isThemeSwitching) return;
    isThemeSwitching = true;

    const btn = event.currentTarget;
    const rect = btn.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    const toLight = newTheme === 'light';

    // 按钮旋转动画
    btn.classList.add('switching');

    // 创建脉冲环
    createPulseRings(cx, cy, toLight);

    // 闪光效果
    const flash = document.getElementById('flashOverlay');
    if (flash) {
        flash.style.setProperty('--cx', cx + 'px');
        flash.style.setProperty('--cy', cy + 'px');
        flash.className = 'flash-overlay ' + (toLight ? 'to-light' : 'to-dark') + ' flash';
    }

    // 切换主题
    setTimeout(() => {
        currentTheme = newTheme;
        localStorage.setItem('theme', currentTheme);
        initTheme();
    }, 50);

    // 清理
    setTimeout(() => {
        btn.classList.remove('switching');
        if (flash) flash.className = 'flash-overlay';
        isThemeSwitching = false;
    }, 400);
}

// ==================== 季节主题系统 ====================
let currentSeason = localStorage.getItem('season') || 'auto';
let particlesEnabled = localStorage.getItem('seasonParticles') !== 'false';
let seasonParticleElements = [];

// 季节图标映射
const SEASON_ICONS = {
    'auto': '🔄',
    'spring': '🌸',
    'summer': '🌴',
    'autumn': '🍂',
    'winter': '❄️',
    'none': '🚫'
};

const SEASON_NAMES = {
    'auto': '自动',
    'spring': '春',
    'summer': '夏',
    'autumn': '秋',
    'winter': '冬',
    'none': '关闭'
};

// 获取真实季节（根据当前日期）
function getRealSeason() {
    const month = new Date().getMonth() + 1;
    if (month >= 3 && month <= 5) return 'spring';
    if (month >= 6 && month <= 8) return 'summer';
    if (month >= 9 && month <= 11) return 'autumn';
    return 'winter';
}

// 获取当前应该显示的季节
function getEffectiveSeason() {
    if (currentSeason === 'auto') {
        return getRealSeason();
    }
    return currentSeason;
}

// 初始化季节主题
function initSeason() {
    const effectiveSeason = getEffectiveSeason();
    document.body.setAttribute('data-season', effectiveSeason);
    
    // 更新UI显示
    updateSeasonUI();
    
    // 初始化粒子效果
    if (particlesEnabled && effectiveSeason !== 'none') {
        createSeasonParticles(effectiveSeason);
    } else {
        document.body.classList.toggle('no-particles', !particlesEnabled);
    }
    
    // 更新季节弹窗选中状态
    updateSeasonCardActive();
}

// 更新季节UI显示
function updateSeasonUI() {
    const iconEl = document.getElementById('seasonIcon');
    const statusEl = document.getElementById('seasonStatus');
    
    // 显示当前生效的季节图标（none时显示关闭图标）
    const effectiveSeason = getEffectiveSeason();
    if (iconEl) {
        if (currentSeason === 'none') {
            iconEl.textContent = '🚫';
        } else {
            iconEl.textContent = SEASON_ICONS[effectiveSeason] || SEASON_ICONS['auto'];
        }
    }
    if (statusEl) {
        if (currentSeason === 'none') {
            statusEl.textContent = '关闭';
        } else if (currentSeason === 'auto') {
            statusEl.textContent = '自动(' + SEASON_NAMES[getRealSeason()] + ')';
        } else {
            statusEl.textContent = SEASON_NAMES[currentSeason] || '自动';
        }
    }
    
    // 更新粒子开关按钮
    updateParticleToggleBtn();
}

// 更新粒子开关按钮状态
function updateParticleToggleBtn() {
    const btn = document.getElementById('particleToggleBtn');
    const text = document.getElementById('particleToggleText');
    if (btn) {
        btn.classList.toggle('off', !particlesEnabled);
    }
    if (text) {
        text.textContent = particlesEnabled ? '开启' : '关闭';
    }
}

// 更新季节卡片选中状态
function updateSeasonCardActive() {
    document.querySelectorAll('.season-card[data-season]').forEach(card => {
        card.classList.toggle('active', card.dataset.season === currentSeason);
    });
}

// 打开季节选择弹窗
function openSeasonPicker() {
    const modal = document.getElementById('seasonModal');
    if (modal) {
        modal.classList.add('show');
        updateSeasonCardActive();
        updateParticleToggleBtn();
    }
}

// 关闭季节选择弹窗
function closeSeasonPicker() {
    const modal = document.getElementById('seasonModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// 设置季节
function setSeason(season) {
    currentSeason = season;
    localStorage.setItem('season', season);
    
    const effectiveSeason = getEffectiveSeason();
    document.body.setAttribute('data-season', effectiveSeason);
    
    // 更新UI
    updateSeasonUI();
    updateSeasonCardActive();
    
    // 重新创建粒子
    clearSeasonParticles();
    if (particlesEnabled && effectiveSeason !== 'none') {
        createSeasonParticles(effectiveSeason);
    }
    
    // 关闭弹窗
    closeSeasonPicker();
    
    // 显示提示
    if (season === 'none') {
        showToast('🚫 已关闭季节主题效果');
    } else if (season === 'auto') {
        showToast('🔄 已切换到自动模式 (' + SEASON_NAMES[getRealSeason()] + ')');
    } else {
        showToast(SEASON_ICONS[season] + ' 已切换到' + SEASON_NAMES[season] + '季主题');
    }
}

// 切换粒子效果
function toggleSeasonParticles() {
    particlesEnabled = !particlesEnabled;
    localStorage.setItem('seasonParticles', particlesEnabled);
    
    document.body.classList.toggle('no-particles', !particlesEnabled);
    
    // 更新UI
    updateParticleToggleBtn();
    
    // 创建或清除粒子
    clearSeasonParticles();
    const effectiveSeason = getEffectiveSeason();
    if (particlesEnabled && effectiveSeason !== 'none') {
        createSeasonParticles(effectiveSeason);
    }
    
    showToast(particlesEnabled ? '✨ 粒子效果已开启' : '💤 粒子效果已关闭');
}

// 清除所有季节粒子
function clearSeasonParticles() {
    const container = document.getElementById('seasonParticles');
    if (container) {
        container.innerHTML = '';
    }
    seasonParticleElements = [];
}

// 创建季节粒子
function createSeasonParticles(season) {
    const container = document.getElementById('seasonParticles');
    if (!container || season === 'none') return;
    
    // 清除旧粒子
    clearSeasonParticles();
    
    // 粒子数量：5-8个，保持淡雅
    const particleCount = 6;
    
    for (let i = 0; i < particleCount; i++) {
        const particle = document.createElement('div');
        particle.className = 'season-particle-' + season;
        
        // 随机初始位置
        particle.style.left = Math.random() * 100 + '%';
        
        // 随机大小变化 (0.7-1.3)
        const scale = 0.7 + Math.random() * 0.6;
        particle.style.transform = 'scale(' + scale + ')';
        
        // 随机动画时长和延迟
        let duration, delay;
        
        switch (season) {
            case 'spring': // 樱花：缓慢飘落 15-20秒
                duration = 15 + Math.random() * 5;
                delay = Math.random() * 10;
                break;
            case 'summer': // 萤火虫：漂浮 8-15秒
                duration = 8 + Math.random() * 7;
                delay = Math.random() * 8;
                break;
            case 'autumn': // 枫叶：飘落 12-18秒
                duration = 12 + Math.random() * 6;
                delay = Math.random() * 8;
                break;
            case 'winter': // 雪花：缓慢飘落 18-25秒
                duration = 18 + Math.random() * 7;
                delay = Math.random() * 12;
                break;
            default:
                duration = 15;
                delay = Math.random() * 10;
        }
        
        particle.style.animationDuration = duration + 's';
        particle.style.animationDelay = '-' + delay + 's';
        
        // 随机透明度 (0.25-0.45)
        particle.style.opacity = (0.25 + Math.random() * 0.2).toString();
        
        container.appendChild(particle);
        seasonParticleElements.push(particle);
    }
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
            credentials: 'same-origin',
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
            credentials: 'same-origin',
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
    fetch(API + '/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
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
        // 先显示骨架屏
        showSkeletonCards();
        await Promise.all([loadAccountTypes(), loadPropertyGroups(), loadAccounts()]);
        renderSidebar(); renderCards();
        // 初始化邮箱验证码功能
        initEmailFeature();
    } catch (e) {
        console.error('loadData错误:', e);
    }
}

// 显示骨架屏
function showSkeletonCards(count = 6) {
    const skeletonHtml = Array(count).fill(0).map(() => `
        <div class="skeleton-card">
            <div class="skeleton-header">
                <div class="skeleton-icon"></div>
                <div class="skeleton-lines">
                    <div class="skeleton-line"></div>
                    <div class="skeleton-line"></div>
                </div>
            </div>
            <div class="skeleton-footer">
                <div class="skeleton-btn"></div>
                <div class="skeleton-btn"></div>
                <div class="skeleton-btn"></div>
            </div>
        </div>
    `).join('');
    document.getElementById('cardsList').innerHTML = skeletonHtml;
}

async function loadAccounts() {
    try { 
        const res = await apiRequest('/accounts');
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
        const res = await apiRequest('/account-types');
        if (!res.ok) return;
        const data = await res.json(); 
        accountTypes = data.types || [];
    } catch (e) {
        console.error('loadAccountTypes错误:', e);
    }
}

async function loadPropertyGroups() {
    try { 
        const res = await apiRequest('/property-groups');
        if (!res.ok) return;
        const data = await res.json(); 
        propertyGroups = data.groups || [];
    } catch (e) {
        console.error('loadPropertyGroups错误:', e);
    }
}

// 侧边栏
function renderSidebar() {
    // 保存当前折叠状态
    const collapsedGroups = new Set();
    document.querySelectorAll('.collapsible-group.collapsed').forEach(el => {
        const header = el.querySelector('.group-header span:nth-child(2)');
        if (header) collapsedGroups.add(header.textContent);
    });
    
    let typesHtml = `<div class="collapsible-group"><div class="group-header" onclick="toggleGroup(this)"><span class="group-arrow">▼</span><span>账号类型</span><span class="group-actions"><button class="btn-tiny" onclick="event.stopPropagation();openTypeManager()">⚙</button></span></div><div class="group-content">`;
    accountTypes.forEach(t => {
        const count = accounts.filter(a => a.type_id === t.id).length;
        if (count === 0) return; // 跳过没有账号的类型
        const isSelected = currentFilters['type_' + t.id];
        const isExcluded = currentExcludes['type_' + t.id];
        const stateClass = isSelected ? ' active' : isExcluded ? ' excluded' : '';
        typesHtml += `<div class="nav-item${stateClass}" onclick="filterByType(${t.id})" oncontextmenu="excludeType(${t.id}, event)"><span class="nav-icon" style="color:${escapeAttr(t.color)}">${escapeHtml(t.icon)}</span><span class="nav-label">${escapeHtml(t.name)}</span><span class="nav-count">${count}</span></div>`;
    });
    typesHtml += '</div></div>';
    document.getElementById('sidebarTypes').innerHTML = typesHtml;

    let propsHtml = '';
    propertyGroups.forEach((g, idx) => {
        // 第一个属性组默认展开，其他默认折叠（除非之前手动展开过）
        const wasCollapsed = collapsedGroups.has(g.name);
        const shouldCollapse = idx > 0 && !wasCollapsed && !document.querySelector(`[data-group-id="${g.id}"]`);
        const collapsedClass = (wasCollapsed || shouldCollapse) ? ' collapsed' : '';
        
        propsHtml += `<div class="collapsible-group${collapsedClass}" data-group-id="${g.id}"><div class="group-header" onclick="toggleGroup(this)"><span class="group-arrow">▼</span><span>${escapeHtml(g.name)}</span><span class="group-actions"><button class="btn-tiny" onclick="event.stopPropagation();openPropertyManager()">⚙</button></span></div><div class="group-content">`;
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
            const isExcluded = currentExcludes['propval_' + v.id];
            const stateClass = isSelected ? ' active' : isExcluded ? ' excluded' : '';
            propsHtml += `<div class="prop-item${stateClass}" onclick="filterByProperty(${g.id},${v.id})" oncontextmenu="excludeProperty(${g.id},${v.id},event)"><span class="prop-dot" style="background:${escapeAttr(v.color)}"></span><span class="prop-label">${escapeHtml(v.name)}</span><span class="prop-count">${count}</span></div>`;
        });
        propsHtml += '</div></div>';
    });
    document.getElementById('sidebarProperties').innerHTML = propsHtml;

    document.getElementById('countAll').textContent = accounts.length;
    document.getElementById('countFav').textContent = accounts.filter(a => a.is_favorite).length;
    document.getElementById('countNoCombo').textContent = accounts.filter(a => !a.combos || a.combos.length === 0 || a.combos.every(c => !c || c.length === 0)).length;
    
    // 更新视图项的选中/排除状态
    const favItem = document.querySelector('.view-section .nav-item[data-view="favorites"]');
    const nocomboItem = document.querySelector('.view-section .nav-item[data-view="nocombo"]');
    
    if (favItem) {
        favItem.classList.remove('active', 'excluded');
        if (currentFilters['view_favorites']) {
            favItem.classList.add('active');
        } else if (currentExcludes['view_favorites']) {
            favItem.classList.add('excluded');
        }
    }
    if (nocomboItem) {
        nocomboItem.classList.remove('active', 'excluded');
        if (currentFilters['view_nocombo']) {
            nocomboItem.classList.add('active');
        } else if (currentExcludes['view_nocombo']) {
            nocomboItem.classList.add('excluded');
        }
    }
}

// 卡片渲染
function renderCards() {
    const scrollY = window.scrollY;
    const cardsList = document.getElementById('cardsList');
    const filtered = getFilteredAccounts(), sorted = sortAccounts(filtered);
    if (sorted.length === 0) { 
        // 可爱的空状态插画
        cardsList.innerHTML = `
            <div class="empty-state">
                <svg class="empty-illustration" viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <ellipse cx="100" cy="160" rx="60" ry="15" fill="var(--border)" opacity="0.3"/>
                    <path d="M60 80 L60 140 Q60 160 100 160 Q140 160 140 140 L140 80 Q140 60 100 60 Q60 60 60 80Z" fill="var(--bg-card)" stroke="var(--border)" stroke-width="2"/>
                    <path d="M65 80 L65 85 Q65 90 100 90 Q135 90 135 85 L135 80" fill="var(--yellow)" opacity="0.3"/>
                    <ellipse cx="100" cy="60" rx="40" ry="12" fill="var(--bg-hover)" stroke="var(--border)" stroke-width="2"/>
                    <path d="M85 90 Q85 110 90 115 Q95 120 95 125" stroke="var(--yellow)" stroke-width="3" stroke-linecap="round" opacity="0.6"/>
                    <circle cx="100" cy="35" r="25" fill="var(--bg-card)" stroke="var(--border)" stroke-width="2"/>
                    <circle cx="80" cy="15" r="10" fill="var(--bg-card)" stroke="var(--border)" stroke-width="2"/>
                    <circle cx="120" cy="15" r="10" fill="var(--bg-card)" stroke="var(--border)" stroke-width="2"/>
                    <circle cx="92" cy="32" r="3" fill="var(--text-muted)"/>
                    <circle cx="108" cy="32" r="3" fill="var(--text-muted)"/>
                    <ellipse cx="100" cy="40" rx="4" ry="3" fill="var(--text-muted)"/>
                    <text x="150" y="50" font-size="24" fill="var(--accent)" opacity="0.6">?</text>
                </svg>
                <div class="empty-title">这里空空如也~</div>
                <div class="empty-text">快去添加第一个账号吧 🍯</div>
                <button class="empty-action" onclick="openAddModal()">➕ 添加账号</button>
            </div>`;
        return; 
    }

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
            const values = firstGroup.values || [];
            const firstValueId = values[0]?.id;
            const lastValueId = values[values.length - 1]?.id;
            let allFirst = true, allLast = true, hasStatus = false;
            for (const combo of combos) {
                const statusValue = values.find(v => combo.includes(v.id));
                if (statusValue) {
                    hasStatus = true;
                    if (statusValue.id !== firstValueId) allFirst = false;
                    if (statusValue.id !== lastValueId) allLast = false;
                }
            }
            if (hasStatus && allLast) cardClass += ' frozen';
            else if (hasStatus && !allFirst) cardClass += ' mixed';
        }

        // 渲染组合标签
        let combosHtml = '';
        combos.forEach(combo => {
            // 使用normalizeCombo规范化顺序，确保显示一致
            const normalized = normalizeCombo(combo);
            const parts = [];
            let color = '#8b5cf6'; // 默认颜色
            let isFirst = true;
            let firstValueName = ''; // 备用：如果所有都hidden，显示第一个
            // 遍历规范化后的combo中的每个值ID
            normalized.forEach(vid => {
                const v = valueMap[vid];
                if (v) {
                    if (isFirst) { 
                        color = v.color; 
                        isFirst = false; 
                        firstValueName = v.name;
                    }
                    // 只有非hidden的属性值才显示文字
                    if (!v.hidden) {
                        parts.push(v.name);
                    }
                }
            });
            // 如果所有都hidden，显示第一个的名称
            if (parts.length === 0 && firstValueName) {
                parts.push(firstValueName);
            }
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
        const cardClickHandler = batchMode ? `onclick="toggleAccountSelection(${acc.id}, event)"` : `onclick="dismissDoneTimers(this)"`;
        
        // 最近使用时间徽章（根据开关状态显示）
        let timeBadgeHtml = '';
        if (showTimeBadge && acc.last_used) {
            const lastUsedTime = new Date(acc.last_used).getTime();
            const now = Date.now();
            const daysDiff = Math.floor((now - lastUsedTime) / (1000 * 60 * 60 * 24));
            
            if (daysDiff > 90) {
                timeBadgeHtml = `<div class="card-time-badge danger">💤 ${daysDiff}天未使用</div>`;
            } else if (daysDiff > 30) {
                timeBadgeHtml = `<div class="card-time-badge warning">⏰ ${daysDiff}天前</div>`;
            }
        }

        return `<div class="${cardClass} ${favoriteClass}" data-id="${acc.id}" ${cardClickHandler}>
            ${timeBadgeHtml}
            <div class="card-body">
                <div class="card-header">
                    ${checkboxHtml}
                    <div class="card-icon" style="background:linear-gradient(135deg,${escapeAttr(type.color)},${adjustColor(type.color,-20)})">${escapeHtml(type.icon)}</div>
                    <div class="card-info" ${!batchMode ? `onclick="copyEmail('${escapeHtml(acc.email)}')" title="点击复制邮箱"` : ''}><div class="card-name">${escapeHtml(acc.customName || acc.email)}</div><div class="card-email">${escapeHtml(acc.email)}</div></div>
                    <div class="card-combos">${combosHtml}</div>
                    <div class="card-meta">
                        <div class="meta-top">
                            <span class="card-country">${getCountryDisplay(acc.country)}</span>
                            ${!batchMode ? `<div class="card-menu" onclick="event.stopPropagation()">
                                <button class="btn-menu-dots" onclick="toggleCardMenu(${acc.id})">⋮</button>
                                <div class="card-menu-dropdown">
                                    <div class="menu-item" onclick="toggleFavorite(${acc.id});closeAllMenus()">${acc.is_favorite ? '💔 取消收藏' : '💌 收藏'}</div>
                                    <div class="menu-item" onclick="openEditModal(${acc.id});closeAllMenus()">✏️ 编辑</div>
                                    <div class="menu-item" onclick="openSingleTimerDialog(${acc.id});closeAllMenus()">⏰ 定时</div>
                                    <div class="menu-item danger" onclick="deleteAccount(${acc.id});closeAllMenus()">🗑️ 删除</div>
                                </div>
                            </div>` : ''}
                        </div>
                        ${renderTimers(acc)}
                    </div>
                </div>
                ${(acc.tags||[]).length ? `<div class="card-tags">${acc.tags.map(t => `<span class="free-tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
            </div>
            <div class="card-footer">
                <button class="btn-action" onclick="event.stopPropagation();copyPassword(${acc.id})" title="复制密码">🔑 密码</button>
                <button class="btn-action btn-2fa${acc.has_2fa ? ' active' : ''}${acc.has_backup_codes ? ' has-backup' : ''}" onclick="event.stopPropagation();${acc.has_2fa ? `show2FAPopup(${acc.id})` : `open2FAConfig(${acc.id})`}" title="${acc.has_2fa ? (acc.has_backup_codes ? '有备份码' : '查看2FA') : '设置2FA'}">🛡️ 2FA</button>
                <button class="btn-action" onclick="event.stopPropagation();copyEmail('${escapeHtml(acc.email)}')" title="复制邮箱">📋 复制</button>
                <button class="btn-action" onclick="event.stopPropagation();loginTest(${acc.id})" title="登录测试">🔗 登录</button>
            </div>
        </div>`;
    }).join('');
    
    // 应用视图模式
    updateViewModeClass();
    // 恢复滚动位置
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
}

function getFilteredAccounts() {
    let result = [...accounts];
    // 同时检查PC端和移动端搜索框
    const pcSearch = document.getElementById('searchInput')?.value || '';
    const mobileSearch = document.getElementById('mobileSearchInput')?.value || '';
    const search = (pcSearch || mobileSearch).toLowerCase();
    if (currentView === 'favorites') result = result.filter(a => a.is_favorite);
    else if (currentView === 'nocombo') result = result.filter(a => !a.combos || a.combos.length === 0 || a.combos.every(c => !c || c.length === 0));
    
    // ========== 选中筛选（包含） ==========
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
    // 视图筛选（收藏、无属性组）
    Object.keys(currentFilters).forEach(key => {
        if (key === 'view_favorites') {
            result = result.filter(a => a.is_favorite);
        } else if (key === 'view_nocombo') {
            result = result.filter(a => !a.combos || a.combos.length === 0 || a.combos.every(c => !c || c.length === 0));
        }
    });
    
    // ========== 排除筛选（不包含） ==========
    // 排除账号类型
    Object.keys(currentExcludes).forEach(key => {
        if (key.startsWith('type_')) {
            const typeId = currentExcludes[key];
            result = result.filter(a => a.type_id !== typeId);
        }
    });
    
    // 排除收藏
    if (currentExcludes['view_favorites']) {
        result = result.filter(a => !a.is_favorite);
    }
    
    // 排除无属性组
    if (currentExcludes['view_nocombo']) {
        result = result.filter(a => a.combos && a.combos.length > 0 && a.combos.some(c => c && c.length > 0));
    }
    
    // 排除"未设置"属性组
    Object.keys(currentExcludes).forEach(key => {
        if (key.startsWith('noprop_')) {
            const groupId = parseInt(currentExcludes[key]);
            const group = propertyGroups.find(g => g.id === groupId);
            if (group) {
                const groupValueIds = (group.values || []).map(v => v.id);
                // 排除 = 只保留设置了该属性组的账号
                result = result.filter(a => {
                    const combos = a.combos || [];
                    return combos.some(combo => {
                        if (!Array.isArray(combo)) return false;
                        return combo.some(vid => groupValueIds.includes(Number(vid)) || groupValueIds.includes(String(vid)));
                    });
                });
            }
        }
    });
    
    // 排除属性值
    Object.keys(currentExcludes).forEach(key => {
        if (key.startsWith('propval_')) {
            const valueId = currentExcludes[key];
            result = result.filter(a => {
                const combos = a.combos || [];
                // 排除 = 不包含此属性值
                return !combos.some(combo => {
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
            return dir * (bTime - aTime) || dir * (new Date(b.created_at) - new Date(a.created_at)) || a.id - b.id;
        });
    } else if (currentSort === 'name') {
        sorted.sort((a, b) => dir * (a.customName || a.email).localeCompare(b.customName || b.email) || a.id - b.id);
    } else if (currentSort === 'created') {
        sorted.sort((a, b) => dir * (new Date(b.created_at) - new Date(a.created_at)) || a.id - b.id);
    }
    // Frozen cards sink to bottom
    if (propertyGroups.length > 0) {
        const fg = propertyGroups[0];
        const fgValues = fg.values || [];
        const lastVId = fgValues[fgValues.length - 1]?.id;
        if (lastVId) {
            sorted.sort((a, b) => {
                const aHasStatus = (a.combos || []).some(c => fgValues.some(v => c.includes(v.id)));
                const aFrozen = aHasStatus && (a.combos || []).every(c => { const sv = fgValues.find(v => c.includes(v.id)); return !sv || sv.id === lastVId; });
                const bHasStatus = (b.combos || []).some(c => fgValues.some(v => c.includes(v.id)));
                const bFrozen = bHasStatus && (b.combos || []).every(c => { const sv = fgValues.find(v => c.includes(v.id)); return !sv || sv.id === lastVId; });
                if (aFrozen === bFrozen) return 0;
                return aFrozen ? 1 : -1;
            });
        }
    }
    return sorted;
}

// 视图筛选 - 三态循环：正常 → 选中 → 排除 → 正常
function setView(view) {
    // 全部账号直接切换，不参与三态循环
    if (view === 'all') {
        currentView = 'all';
        currentFilters = {};
        currentExcludes = {};
        lastClickedFilter = null;
        document.querySelectorAll('.view-section .nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === 'all'));
        updatePageTitle();
        renderSidebar();
        renderFiltersBar();
        renderCardsWithTransition();
        return;
    }
    
    const key = 'view_' + view;
    const isSelected = currentFilters[key];
    const isExcluded = currentExcludes[key];
    
    // 三态循环：正常 → 选中 → 排除 → 正常
    if (!isSelected && !isExcluded) {
        // 正常 → 选中
        currentFilters[key] = true;
    } else if (isSelected) {
        // 选中 → 排除
        delete currentFilters[key];
        currentExcludes[key] = true;
    } else {
        // 排除 → 正常
        delete currentExcludes[key];
    }
    
    // 保持在全部账号视图
    currentView = 'all';
    document.querySelectorAll('.view-section .nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.view === 'all');
    });
    
    updatePageTitle();
    renderSidebar();
    renderFiltersBar();
    renderCardsWithTransition();
}

// 右键排除视图（PC端快捷操作，直接跳到排除状态）
function excludeView(view, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    
    const key = 'view_' + view;
    
    // 如果已经排除，则取消排除
    if (currentExcludes[key]) {
        delete currentExcludes[key];
    } else {
        // 清除选中，添加排除
        delete currentFilters[key];
        currentExcludes[key] = true;
    }
    
    currentView = 'all';
    document.querySelectorAll('.view-section .nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.view === 'all');
    });
    
    updatePageTitle();
    renderSidebar();
    renderFiltersBar();
    renderCardsWithTransition();
}

// 账号类型筛选 - 三态循环：正常 → 选中 → 排除 → 正常
function filterByType(typeId) {
    const key = 'type_' + typeId;
    const isSelected = currentFilters[key];
    const isExcluded = currentExcludes[key];
    
    // 三态循环：正常 → 选中 → 排除 → 正常
    if (!isSelected && !isExcluded) {
        // 正常 → 选中（账号类型互斥，先清除其他类型的选中）
        Object.keys(currentFilters).forEach(k => {
            if (k.startsWith('type_')) delete currentFilters[k];
        });
        currentFilters[key] = typeId;
    } else if (isSelected) {
        // 选中 → 排除
        delete currentFilters[key];
        currentExcludes[key] = typeId;
    } else {
        // 排除 → 正常
        delete currentExcludes[key];
    }
    
    updatePageTitle();
    renderSidebar();
    renderFiltersBar(); 
    renderCardsWithTransition();
}

// 右键排除账号类型（PC端快捷操作）
function excludeType(typeId, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    
    const key = 'type_' + typeId;
    
    // 如果已经排除，则取消排除
    if (currentExcludes[key]) {
        delete currentExcludes[key];
    } else {
        // 先清除该类型的选中状态
        delete currentFilters[key];
        // 添加排除
        currentExcludes[key] = typeId;
    }
    
    updatePageTitle();
    renderSidebar();
    renderFiltersBar();
    renderCardsWithTransition();
}

// 属性值筛选 - 三态循环：正常 → 选中 → 排除 → 正常
function filterByProperty(groupId, valueId) {
    const key = 'propval_' + valueId;
    const isSelected = currentFilters[key];
    const isExcluded = currentExcludes[key];
    
    // 查找属性值名称
    let valueName = '';
    for (const g of propertyGroups) {
        const v = (g.values || []).find(v => v.id === valueId);
        if (v) { valueName = v.name; break; }
    }
    
    // 三态循环：正常 → 选中 → 排除 → 正常
    if (!isSelected && !isExcluded) {
        // 正常 → 选中
        currentFilters[key] = valueId;
        lastClickedFilter = { type: 'propval', id: valueId, name: valueName };
    } else if (isSelected) {
        // 选中 → 排除
        delete currentFilters[key];
        currentExcludes[key] = valueId;
        lastClickedFilter = null;
    } else {
        // 排除 → 正常
        delete currentExcludes[key];
    }
    
    updatePageTitle();
    renderSidebar();
    renderFiltersBar(); 
    renderCardsWithTransition();
}

// 右键排除属性值（PC端快捷操作）
function excludeProperty(groupId, valueId, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    
    const key = 'propval_' + valueId;
    
    // 如果已经排除，则取消排除
    if (currentExcludes[key]) {
        delete currentExcludes[key];
    } else {
        // 先清除该属性的选中状态
        delete currentFilters[key];
        if (lastClickedFilter && lastClickedFilter.type === 'propval' && lastClickedFilter.id === valueId) {
            lastClickedFilter = null;
        }
        // 添加排除
        currentExcludes[key] = valueId;
    }
    
    updatePageTitle();
    renderSidebar();
    renderFiltersBar();
    renderCardsWithTransition();
}

// "未设置"属性组筛选 - 三态循环：正常 → 选中 → 排除 → 正常
function filterByNoProperty(groupId) {
    const key = 'noprop_' + groupId;
    const g = propertyGroups.find(g => g.id === groupId);
    const isSelected = currentFilters[key];
    const isExcluded = currentExcludes[key];
    
    // 三态循环：正常 → 选中 → 排除 → 正常
    if (!isSelected && !isExcluded) {
        // 正常 → 选中
        currentFilters[key] = groupId;
        lastClickedFilter = { type: 'noprop', id: groupId, name: (g?.name || '属性') + ' - 未设置' };
    } else if (isSelected) {
        // 选中 → 排除
        delete currentFilters[key];
        currentExcludes[key] = groupId;
        lastClickedFilter = null;
    } else {
        // 排除 → 正常
        delete currentExcludes[key];
    }
    
    updatePageTitle();
    renderSidebar();
    renderFiltersBar(); 
    renderCardsWithTransition();
}

// 右键排除"未设置"属性组（PC端快捷操作）
function excludeNoProperty(groupId, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    
    const key = 'noprop_' + groupId;
    
    // 如果已经排除，则取消排除
    if (currentExcludes[key]) {
        delete currentExcludes[key];
    } else {
        // 先清除该属性组的选中状态
        delete currentFilters[key];
        if (lastClickedFilter && lastClickedFilter.type === 'noprop' && lastClickedFilter.id === groupId) {
            lastClickedFilter = null;
        }
        // 添加排除
        currentExcludes[key] = groupId;
    }
    
    updatePageTitle();
    renderSidebar();
    renderFiltersBar();
    renderCardsWithTransition();
}

function updatePageTitle() {
    const viewName = currentView === 'all' ? '全部账号' : currentView === 'favorites' ? '所有收藏' : '无属性组';
    
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
    const container = document.getElementById('activeFilters');
    const hasFilters = Object.keys(currentFilters).length > 0;
    const hasExcludes = Object.keys(currentExcludes).length > 0;
    const has = hasFilters || hasExcludes;
    
    container.classList.toggle('show', has);
    if (!has) { container.innerHTML = ''; return; }
    let html = '';
    
    // ===== 选中标签（蓝色） =====
    // 视图选中标签
    if (currentFilters['view_favorites']) {
        html += `<div class="filter-tag filter-include"><span class="dot" style="background:var(--accent)"></span>收藏<span class="remove" onclick="removeFilter('view_favorites')">✕</span></div>`;
    }
    if (currentFilters['view_nocombo']) {
        html += `<div class="filter-tag filter-include"><span class="dot" style="background:#9ca3af"></span>无属性组<span class="remove" onclick="removeFilter('view_nocombo')">✕</span></div>`;
    }
    
    // 账号类型标签
    Object.keys(currentFilters).forEach(key => {
        if (key.startsWith('type_')) {
            const typeId = currentFilters[key];
            const t = accountTypes.find(t => t.id === typeId);
            if (t) html += `<div class="filter-tag filter-include"><span class="dot" style="background:${escapeAttr(t.color)}"></span>${escapeHtml(t.name)}<span class="remove" onclick="removeFilter('${key}')">✕</span></div>`;
        }
    });
    
    // 属性值标签
    Object.keys(currentFilters).forEach(key => {
        if (key.startsWith('noprop_')) {
            const groupId = currentFilters[key];
            const g = propertyGroups.find(g => g.id === groupId);
            if (g) {
                html += `<div class="filter-tag filter-include"><span class="dot" style="background:#9ca3af"></span>${escapeHtml(g.name)} - 未设置<span class="remove" onclick="removeFilter('${key}')">✕</span></div>`;
            }
        }
        if (key.startsWith('propval_')) {
            const valueId = currentFilters[key];
            for (const g of propertyGroups) {
                const v = (g.values || []).find(v => v.id === valueId);
                if (v) {
                    html += `<div class="filter-tag filter-include"><span class="dot" style="background:${escapeAttr(v.color)}"></span>${escapeHtml(v.name)}<span class="remove" onclick="removeFilter('${key}')">✕</span></div>`;
                    break;
                }
            }
        }
    });
    
    // ===== 排除标签（红色） =====
    // 视图排除标签
    if (currentExcludes['view_favorites']) {
        html += `<div class="filter-tag filter-exclude"><span class="dot" style="background:var(--red)"></span>收藏<span class="remove" onclick="removeExclude('view_favorites')">✕</span></div>`;
    }
    if (currentExcludes['view_nocombo']) {
        html += `<div class="filter-tag filter-exclude"><span class="dot" style="background:var(--red)"></span>无属性组<span class="remove" onclick="removeExclude('view_nocombo')">✕</span></div>`;
    }
    
    // 排除账号类型标签
    Object.keys(currentExcludes).forEach(key => {
        if (key.startsWith('type_')) {
            const typeId = currentExcludes[key];
            const t = accountTypes.find(t => t.id === typeId);
            if (t) html += `<div class="filter-tag filter-exclude"><span class="dot" style="background:var(--red)"></span>${escapeHtml(t.name)}<span class="remove" onclick="removeExclude('${key}')">✕</span></div>`;
        }
    });
    
    // 排除属性值标签
    Object.keys(currentExcludes).forEach(key => {
        if (key.startsWith('noprop_')) {
            const groupId = currentExcludes[key];
            const g = propertyGroups.find(g => g.id === groupId);
            if (g) {
                html += `<div class="filter-tag filter-exclude"><span class="dot" style="background:var(--red)"></span>${escapeHtml(g.name)} - 未设置<span class="remove" onclick="removeExclude('${key}')">✕</span></div>`;
            }
        }
        if (key.startsWith('propval_')) {
            const valueId = currentExcludes[key];
            for (const g of propertyGroups) {
                const v = (g.values || []).find(v => v.id === valueId);
                if (v) {
                    html += `<div class="filter-tag filter-exclude"><span class="dot" style="background:var(--red)"></span>${escapeHtml(v.name)}<span class="remove" onclick="removeExclude('${key}')">✕</span></div>`;
                    break;
                }
            }
        }
    });
    
    html += `<button class="clear-filters" onclick="clearAllFilters()">清除全部</button>`;
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

function removeExclude(key) {
    delete currentExcludes[key];
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

function clearAllFilters() {
    currentFilters = {};
    currentExcludes = {};
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

function filterAccounts() { renderCardsWithTransition(); }

// 带过渡效果的渲染
function renderCardsWithTransition() {
    const cardsList = document.getElementById('cardsList');
    cardsList.classList.add('transitioning');
    setTimeout(() => {
        renderCards();
        cardsList.classList.remove('transitioning');
    }, 150);
}

// 账号操作
async function toggleFavorite(id) {
    try { const res = await apiRequest(`/accounts/${id}/favorite`, { method: 'POST' }); if (res.ok) { const data = await res.json(); const acc = accounts.find(a => a.id === id); if (acc) acc.is_favorite = data.is_favorite; renderSidebar(); renderCards(); } } catch {}
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
    try { await apiRequest(`/accounts/${id}/use`, { method: 'POST' }); acc.last_used = new Date().toISOString(); } catch {}
    copyToClipboard(acc.email).then(ok => ok && showToast('已复制邮箱'));
    const type = accountTypes.find(t => t.id === acc.type_id);
    if (type?.login_url) { let url = type.login_url; if (url.includes('Email=')) url += encodeURIComponent(acc.email); setTimeout(() => window.open(url, '_blank'), 300); }
}

async function deleteAccount(id) {
    if (!confirm('确定删除此账号?')) return;
    // 先播放删除动画
    const card = document.querySelector(`.account-card[data-id="${id}"]`);
    if (card) {
        card.classList.add('removing');
        await new Promise(r => setTimeout(r, 250));
    }
    try { 
        const res = await apiRequest(`/accounts/${id}`, { method: 'DELETE' });
        if (res.ok) {
            accounts = accounts.filter(a => a.id !== id); 
            showToast('已删除'); 
            renderSidebar(); 
            renderCards(); 
        } else {
            // 删除失败，移除动画类
            if (card) card.classList.remove('removing');
        }
    } catch { 
        if (card) card.classList.remove('removing');
        showToast('删除失败', true); 
    }
}

// 账号模态框
function openAddModal() {
    editingAccountId = null; editingTags = []; editingCombos = [];
    document.getElementById('accountModalTitle').textContent = '添加账号';
    document.getElementById('accType').innerHTML = accountTypes.map(t => `<option value="${t.id}">${escapeHtml(t.icon)} ${escapeHtml(t.name)}</option>`).join('');
    ['accName', 'accEmail', 'accPassword', 'accNotes'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('accCountry').value = '🌍';
    // 收起展开面板
    ['fieldExpandName', 'fieldExpandNotes'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    ['btnToggleName', 'btnToggleNotes'].forEach(id => { const el = document.getElementById(id); if (el) { el.classList.remove('active', 'has-content'); } });
    // 辅助邮箱清空，显示输入框模式
    const backupEmail = document.getElementById('accBackupEmail');
    if (backupEmail) backupEmail.value = '';
    showBackupEmailInput();
    // 密码默认隐藏
    const pwdField = document.getElementById('accPassword');
    if (pwdField) { pwdField.classList.add('pwd-hidden'); }
    updateTogglePwdBtn(false);
    // 添加模式：2FA 按钮可见但提示需先保存
    const btn2FA = document.getElementById('btn2FAConfig');
    if (btn2FA) {
        btn2FA.textContent = '🛡️ 设置 2FA';
        btn2FA.classList.remove('has-2fa');
        btn2FA.onclick = function() { showToast('请先保存账号，再设置 2FA', 'info'); };
    }
    // 添加模式：隐藏备份码按钮
    const btnBackup = document.getElementById('btnBackupCodes');
    if (btnBackup) btnBackup.style.display = 'none';
    renderCombosBox(); renderTagsBox();
    document.getElementById('accountModal').classList.add('show');
    requestAnimationFrame(syncFieldToggleHeight);
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
    // 展开面板：默认收起，有内容时按钮标绿
    ['fieldExpandName', 'fieldExpandNotes'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
    ['btnToggleName', 'btnToggleNotes'].forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove('active'); });
    updateFieldToggleStates();
    // 辅助邮箱：已绑定时展示文本，未绑定时显示输入框
    const backupEmailVal = acc.backup_email || '';
    const backupInput = document.getElementById('accBackupEmail');
    if (backupInput) backupInput.value = backupEmailVal;
    if (backupEmailVal) {
        showBackupEmailDisplay(backupEmailVal);
    } else {
        showBackupEmailInput();
    }
    // 密码默认隐藏
    const pwdField = document.getElementById('accPassword');
    if (pwdField) { pwdField.classList.add('pwd-hidden'); }
    updateTogglePwdBtn(false);
    // 编辑模式：2FA 按钮显示状态
    const btn2FA = document.getElementById('btn2FAConfig');
    if (btn2FA) {
        btn2FA.textContent = acc.has_2fa ? '🛡️ 2FA ✓' : '🛡️ 设置 2FA';
        btn2FA.classList.toggle('has-2fa', !!acc.has_2fa);
        btn2FA.onclick = function() { open2FAConfig(editingAccountId); };
    }
    // 编辑模式：备份码按钮（有 2FA 时始终显示）
    const btnBackup = document.getElementById('btnBackupCodes');
    if (btnBackup) {
        btnBackup.style.display = acc.has_2fa ? 'inline-flex' : 'none';
        btnBackup.classList.toggle('has-codes', !!acc.has_backup_codes);
    }
    renderCombosBox(); renderTagsBox();
    document.getElementById('accountModal').classList.add('show');
    requestAnimationFrame(syncFieldToggleHeight);
}

// 组合标签渲染
function renderCombosBox() {
    const container = document.getElementById('accCombosBox');
    // 过滤掉无效的combo（属性值已被删除的）
    const validCombos = [];
    const invalidCount = editingCombos.filter(combo => {
        const display = getComboDisplay(combo);
        if (display.invalid) return true;
        validCombos.push(combo);
        return false;
    }).length;
    
    let html = validCombos.map((combo, idx) => {
        const display = getComboDisplay(combo);
        return `<span class="combo-tag" style="background:${hexToRgba(display.color,0.12)};color:${display.color}"><span class="combo-dot" style="background:${display.color}"></span>${display.text}<span class="remove" onclick="removeCombo(${idx})">✕</span></span>`;
    }).join('');
    
    // 如果有无效的combo，显示清理提示
    if (invalidCount > 0) {
        html += `<span class="combo-tag invalid" style="background:rgba(239,68,68,0.1);color:#ef4444" onclick="cleanInvalidCombos()" title="点击清理">⚠️ ${invalidCount}个失效属性 ✕</span>`;
    }
    
    html += '<button class="btn-add-combo" onclick="openComboSelector()">+ 添加</button>';
    container.innerHTML = html;
    
    // 更新 editingCombos 为有效的
    editingCombos = validCombos;
}

// 清理无效的combo
function cleanInvalidCombos() {
    editingCombos = editingCombos.filter(combo => !getComboDisplay(combo).invalid);
    renderCombosBox();
    showToast('已清理失效属性');
}

/**
 * 【统一规范化combo数组】
 * 按属性组顺序排序combo中的值ID，确保：
 * 1. 无论用户点击顺序如何，相同的属性组合生成相同的数组
 * 2. 第一个属性组的值始终在前面，保证颜色显示一致
 * 3. 便于精确匹配和去重
 */
function normalizeCombo(combo) {
    if (!Array.isArray(combo) || combo.length === 0) return combo;
    
    // 构建 valueId -> 属性组顺序 的映射
    const valueOrderMap = new Map();
    propertyGroups.forEach((g, groupIndex) => {
        (g.values || []).forEach((v, valueIndex) => {
            // 属性组顺序 * 10000 + 组内顺序，确保按属性组优先排序
            valueOrderMap.set(v.id, groupIndex * 10000 + valueIndex);
        });
    });
    
    // 按属性组顺序排序
    return [...combo].sort((a, b) => {
        const orderA = valueOrderMap.get(a) ?? 999999;
        const orderB = valueOrderMap.get(b) ?? 999999;
        return orderA - orderB;
    });
}

/**
 * 比较两个combo是否相等（规范化后比较）
 */
function combosEqual(combo1, combo2) {
    if (!Array.isArray(combo1) || !Array.isArray(combo2)) return false;
    if (combo1.length !== combo2.length) return false;
    const n1 = normalizeCombo(combo1);
    const n2 = normalizeCombo(combo2);
    return n1.every((v, i) => v === n2[i]);
}

function getComboDisplay(combo) {
    // 先规范化combo顺序，确保显示一致
    const normalized = normalizeCombo(combo);
    let color = '#8b5cf6', parts = [], isFirst = true;
    // 遍历combo中的每个值ID，按顺序查找
    normalized.forEach(vid => {
        // 在所有属性组中查找这个值ID
        for (const g of propertyGroups) {
            const v = (g.values || []).find(v => v.id === vid);
            if (v) {
                // 颜色始终取第一个（即使hidden也影响颜色）
                if (isFirst) { color = v.color; isFirst = false; }
                // 只有非hidden的属性值才显示文字
                if (!v.hidden) {
                    parts.push(v.name);
                }
                break;
            }
        }
    });
    // 如果所有属性都hidden了，显示第一个的名称作为备用
    if (parts.length === 0 && normalized.length > 0) {
        for (const g of propertyGroups) {
            const v = (g.values || []).find(v => v.id === normalized[0]);
            if (v) {
                parts.push(v.name);
                break;
            }
        }
    }
    if (parts.length === 0) return { color, text: '', invalid: true };
    return { color, text: parts.join(' '), invalid: false };
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
    // 【修复】使用normalizeCombo规范化，确保与批量修改逻辑一致
    const rawCombo = Array.from(selected).map(el => parseInt(el.dataset.vid));
    const combo = normalizeCombo(rawCombo);
    if (combo.length > 0) {
        editingCombos.push(combo);
        renderCombosBox();
    }
    cancelComboSelector();
}

// 修改 app.js 中的 renderTagsBox 函数
// 获取所有已使用的标签（历史标签）
function getAllUsedTags() {
    const tagSet = new Set();
    accounts.forEach(acc => {
        (acc.tags || []).forEach(t => tagSet.add(t));
    });
    return Array.from(tagSet).sort();
}

// 标签历史记录 - 保存到localStorage
function getTagHistory() {
    try {
        return JSON.parse(localStorage.getItem('tagHistory') || '[]');
    } catch { return []; }
}

function addToTagHistory(tag) {
    let history = getTagHistory();
    // 移除已存在的（去重），然后添加到开头
    history = history.filter(t => t !== tag);
    history.unshift(tag);
    // 只保留最近50个
    history = history.slice(0, 50);
    localStorage.setItem('tagHistory', JSON.stringify(history));
}

function removeFromTagHistory(tag) {
    let history = getTagHistory();
    history = history.filter(t => t !== tag);
    localStorage.setItem('tagHistory', JSON.stringify(history));
    renderTagSuggestions(document.getElementById('accTagInput')?.value || '');
}

// 渲染标签建议
function renderTagSuggestions(filter = '') {
    const suggestionsEl = document.getElementById('tagSuggestions');
    if (!suggestionsEl) return;
    
    const history = getTagHistory();
    const allTags = getAllUsedTags();
    // 合并历史和已用标签，历史优先
    let suggestions = [...history];
    allTags.forEach(t => { if (!suggestions.includes(t)) suggestions.push(t); });
    
    // 过滤掉已添加的和不匹配搜索的
    const filterLower = filter.toLowerCase();
    suggestions = suggestions.filter(t => 
        !editingTags.includes(t) && 
        (filter === '' || t.toLowerCase().includes(filterLower))
    );
    
    if (suggestions.length === 0) {
        suggestionsEl.innerHTML = '';
        suggestionsEl.style.display = 'none';
        return;
    }
    
    // 只显示前10个
    suggestions = suggestions.slice(0, 10);
    
    suggestionsEl.innerHTML = suggestions.map(t => `
        <span class="tag-suggestion" onclick="selectTagSuggestion('${escapeHtml(t)}')">
            ${escapeHtml(t)}
            <span class="remove-history" onclick="event.stopPropagation(); removeFromTagHistory('${escapeHtml(t)}')" title="从历史中移除">✕</span>
        </span>
    `).join('');
    suggestionsEl.style.display = 'flex';
}

function selectTagSuggestion(tag) {
    if (!editingTags.includes(tag)) {
        editingTags.push(tag);
        addToTagHistory(tag);
        renderTagsBox();
    }
}

function renderTagsBox() {
    // 1. 渲染现有的标签
    const tagsHtml = editingTags.map(t => 
        `<span class="tag-badge">${escapeHtml(t)}<span class="remove" onclick="removeTag('${escapeHtml(t)}')">✕</span></span>`
    ).join('');
    
    // 2. 渲染输入框和建议区域
    const inputFormHtml = `
    <form action="javascript:void(0)" onsubmit="handleTagSubmit(event)" style="display:contents">
        <input type="text" class="tag-input" id="accTagInput" 
               placeholder="回车添加" autocomplete="off" data-lpignore="true" data-form-type="other"
               onkeydown="handleTagInput(event)"
               oninput="renderTagSuggestions(this.value)"
               onfocus="renderTagSuggestions(this.value)">
        <input type="submit" style="display:none"/> 
    </form>
    <div class="tag-suggestions" id="tagSuggestions"></div>`;
    
    document.getElementById('accTagsBox').innerHTML = tagsHtml + inputFormHtml;
    
    // 只在用户操作标签后才自动聚焦（添加/删除标签），打开模态框时不聚焦
    if (window._tagJustEdited) {
        window._tagJustEdited = false;
        setTimeout(() => {
            const input = document.getElementById('accTagInput');
            const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
            if(input && !isMobile) input.focus();
        }, 0);
    }
}

// 邮箱行 emoji 按钮 — 高度同步 input
function syncFieldToggleHeight() {
    const emailInput = document.getElementById('accEmail');
    if (!emailInput) return;
    const h = emailInput.offsetHeight;
    document.querySelectorAll('.btn-field-toggle').forEach(btn => {
        btn.style.height = h + 'px';
    });
}

// 邮箱行 emoji 按钮展开/收起
function toggleFieldExpand(field) {
    const panel = document.getElementById(field === 'name' ? 'fieldExpandName' : 'fieldExpandNotes');
    const btn = document.getElementById(field === 'name' ? 'btnToggleName' : 'btnToggleNotes');
    if (!panel || !btn) return;
    const visible = panel.style.display !== 'none';
    panel.style.display = visible ? 'none' : 'block';
    btn.classList.toggle('active', !visible);
    if (!visible) {
        const input = panel.querySelector('input, textarea');
        if (input) setTimeout(() => input.focus(), 50);
    }
    updateFieldToggleStates();
}
function updateFieldToggleStates() {
    const notesVal = document.getElementById('accNotes')?.value?.trim();
    const btnNotes = document.getElementById('btnToggleNotes');
    if (btnNotes) btnNotes.classList.toggle('has-content', !!notesVal);
}
// 输入时实时更新按钮状态
document.addEventListener('input', function(e) {
    if (e.target.id === 'accName' || e.target.id === 'accNotes') updateFieldToggleStates();
});

function handleTagInput(e) { if (e.key === 'Enter') { e.preventDefault(); const val = e.target.value.trim(); if (val && !editingTags.includes(val)) { editingTags.push(val); addToTagHistory(val); window._tagJustEdited = true; renderTagsBox(); } e.target.value = ''; } }
function removeTag(tag) { editingTags = editingTags.filter(t => t !== tag); window._tagJustEdited = true; renderTagsBox(); }
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
        notes: document.getElementById('accNotes').value,
        backup_email: document.getElementById('accBackupEmail')?.value || ''
    };
    try {
        const isEdit = !!editingAccountId;
        const res = await apiRequest(isEdit ? `/accounts/${editingAccountId}` : '/accounts', { method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(data) });
        if (res.ok) {
            showToast(isEdit ? '已更新' : '已添加');
            closeAccountModal();
            if (isEdit) {
                // 编辑模式：只更新内存数据，不重排序，避免卡片位置跳动
                const updated = await res.json();
                const idx = accounts.findIndex(a => a.id === editingAccountId);
                if (idx !== -1 && updated) {
                    // 保留原有的排序关键字段，只更新编辑字段
                    const old = accounts[idx];
                    Object.assign(old, {
                        type_id: data.type_id, email: data.email, password: data.password,
                        country: data.country, customName: data.customName,
                        combos: data.combos, tags: data.tags, notes: data.notes,
                        backup_email: data.backup_email
                    });
                }
                renderCards();
            } else {
                // 新增模式：需要完整reload获取新ID
                await loadAccounts();
                renderSidebar();
                renderCards();
            }
        }
        else { const err = await res.json(); showToast(err.detail || '保存失败', true); }
    } catch(e) { console.error('保存错误:', e); showToast('网络错误', true); }
}

// 属性组管理
function openPropertyManager() { 
    renderPropertyEditor(); 
    document.getElementById('propertyModal').classList.add('show'); 
    hidePropertyHelp(); // 打开时默认隐藏帮助
}
function closePropertyManager() { 
    document.getElementById('propertyModal').classList.remove('show'); 
    hidePropertyHelp();
}

// 帮助气泡控制
function togglePropertyHelp() {
    const bubble = document.getElementById('propertyHelpBubble');
    const btn = document.getElementById('propHelpBtn');
    const isShow = bubble.classList.toggle('show');
    btn.classList.toggle('active', isShow);
}

function hidePropertyHelp() {
    const bubble = document.getElementById('propertyHelpBubble');
    const btn = document.getElementById('propHelpBtn');
    if (bubble) bubble.classList.remove('show');
    if (btn) btn.classList.remove('active');
}

// 点击外部关闭帮助气泡
document.addEventListener('click', (e) => {
    const bubble = document.getElementById('propertyHelpBubble');
    const btn = document.getElementById('propHelpBtn');
    if (bubble && btn && !bubble.contains(e.target) && !btn.contains(e.target)) {
        hidePropertyHelp();
    }
});

function renderPropertyEditor() {
    let html = '<div id="propertyGroupList" class="property-group-list">';
    propertyGroups.forEach((g, idx) => {
        const isCollapsed = localStorage.getItem(`propGroup_${g.id}_collapsed`) === 'true';
        html += `<div class="prop-group-card ${isCollapsed ? 'collapsed' : ''}" draggable="true" data-group-id="${g.id}" data-group-idx="${idx}">
            <div class="prop-group-header">
                <span class="drag-handle" title="拖拽排序">⋮⋮</span>
                <input type="text" class="prop-group-name" value="${escapeHtml(g.name)}" onchange="updateGroupName(${g.id}, this.value)">
                <div class="prop-group-actions">
                    <button class="prop-icon-btn" onclick="toggleGroupCollapse(${g.id}, this)" title="折叠/展开">▾</button>
                    <button class="prop-icon-btn danger" onclick="deleteGroup(${g.id})" title="删除">🗑</button>
                </div>
            </div>
            <div class="prop-value-list">`;
        (g.values || []).forEach(v => {
            const isHidden = v.hidden === 1 || v.hidden === true;
            html += `<div class="prop-value-row">
                <div class="prop-color-wrap">
                    <div class="prop-color-display" style="background:${v.color}"></div>
                    <input type="color" value="${v.color}" onchange="updateValue(${v.id}, null, this.value)">
                </div>
                <input type="text" class="prop-value-name" value="${escapeHtml(v.name)}" onchange="updateValue(${v.id}, this.value, null)">
                <span class="prop-value-preview" style="--tag-color:${v.color}">
                    <span class="dot"></span>${escapeHtml(v.name)}
                </span>
                <button class="prop-visibility-btn ${isHidden ? 'hidden' : ''}" onclick="toggleValueVisibility(${v.id}, ${isHidden ? 0 : 1})" title="${isHidden ? '点击显示' : '点击隐藏'}">${isHidden ? '🙈' : '👁'}</button>
                <button class="prop-delete-btn" onclick="deleteValue(${v.id})">✕</button>
            </div>`;
        });
        html += `<button class="prop-add-value-btn" onclick="addValue(${g.id})">+ 添加属性值</button>
            </div>
        </div>`;
    });
    html += '</div>';
    // 底部工具栏
    html += `<div class="prop-editor-footer">
        <button class="prop-footer-btn primary" onclick="addGroup()">
            <span>＋</span>添加属性组
        </button>
        <button class="prop-footer-btn secondary" onclick="cleanupInvalidCombos()">
            <span>🧹</span>清理失效
        </button>
    </div>`;
    document.getElementById('propertyEditorBody').innerHTML = html;
    initPropertyGroupDragSort();
}

// 折叠/展开属性组
function toggleGroupCollapse(groupId, btn) {
    const card = btn.closest('.prop-group-card');
    const isCollapsed = card.classList.toggle('collapsed');
    localStorage.setItem(`propGroup_${groupId}_collapsed`, isCollapsed);
}

// 切换属性值隐藏状态
async function toggleValueVisibility(valueId, hidden) {
    try {
        await apiRequest(`/property-values/${valueId}`, {
            method: 'PUT',
            body: JSON.stringify({ hidden: hidden })
        });
        await loadPropertyGroups();
        renderPropertyEditor();
        renderSidebar();
        renderCards();
    } catch (e) {
        showToast('❌ 更新失败', true);
    }
}

// 属性组拖拽排序
function initPropertyGroupDragSort() {
    const list = document.getElementById('propertyGroupList');
    if (!list) return;
    
    let draggedItem = null;
    
    list.querySelectorAll('.prop-group-card').forEach(item => {
        item.addEventListener('dragstart', e => {
            draggedItem = item;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            hidePropertyHelp(); // 拖拽时隐藏帮助
        });
        
        item.addEventListener('dragend', e => {
            item.classList.remove('dragging');
            draggedItem = null;
            savePropertyGroupOrder();
        });
        
        item.addEventListener('dragover', e => {
            e.preventDefault();
            if (!draggedItem || draggedItem === item) return;
            
            const rect = item.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            
            if (e.clientY < midY) {
                item.parentNode.insertBefore(draggedItem, item);
            } else {
                item.parentNode.insertBefore(draggedItem, item.nextSibling);
            }
        });
    });
}

// 保存属性组顺序
async function savePropertyGroupOrder() {
    const list = document.getElementById('propertyGroupList');
    if (!list) return;
    
    const newOrder = Array.from(list.querySelectorAll('.prop-group-card')).map((el, idx) => ({
        id: parseInt(el.dataset.groupId),
        sort_order: idx
    }));
    
    try {
        const res = await apiRequest('/property-groups/reorder', {
            method: 'POST',
            body: JSON.stringify({ order: newOrder })
        });
        if (res.ok) {
            await loadPropertyGroups();
            renderSidebar();
            renderCards();
            showToast('✅ 顺序已保存');
        }
    } catch (e) {
        showToast('❌ 保存顺序失败', true);
    }
}

// 清理所有账号中的失效属性
async function cleanupInvalidCombos() {
    if (!confirm('确定要清理所有账号中引用已删除属性值的记录吗？')) return;
    try {
        showToast('⏳ 正在清理...');
        const res = await apiRequest('/cleanup-invalid-combos', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
            showToast(`✅ ${data.message}`);
            await loadAccounts();
            renderSidebar();
            renderCards();
        } else {
            showToast('❌ ' + (data.detail || '清理失败'), true);
        }
    } catch (e) {
        showToast('❌ 网络错误', true);
    }
}

async function addGroup() { const name = prompt('属性组名称:'); if (!name) return; try { await apiRequest('/property-groups', { method: 'POST', body: JSON.stringify({ name }) }); await loadPropertyGroups(); renderPropertyEditor(); renderSidebar(); } catch {} }
async function updateGroupName(id, name) { try { await apiRequest(`/property-groups/${id}`, { method: 'PUT', body: JSON.stringify({ name }) }); await loadPropertyGroups(); renderSidebar(); } catch {} }
async function deleteGroup(id) { if (!confirm('删除此属性组?')) return; try { await apiRequest(`/property-groups/${id}`, { method: 'DELETE' }); await loadPropertyGroups(); renderPropertyEditor(); renderSidebar(); } catch {} }
async function addValue(groupId) { const name = prompt('属性值名称:'); if (!name) return; try { await apiRequest('/property-values', { method: 'POST', body: JSON.stringify({ group_id: groupId, name, color: '#8b5cf6' }) }); await loadPropertyGroups(); renderPropertyEditor(); renderSidebar(); } catch {} }
async function updateValue(id, name, color) { const data = {}; if (name !== null) data.name = name; if (color !== null) data.color = color; try { await apiRequest(`/property-values/${id}`, { method: 'PUT', body: JSON.stringify(data) }); await loadPropertyGroups(); renderSidebar(); renderCards(); } catch {} }
async function deleteValue(id) { if (!confirm('删除此属性值?')) return; try { await apiRequest(`/property-values/${id}`, { method: 'DELETE' }); await loadPropertyGroups(); renderPropertyEditor(); renderSidebar(); } catch {} }

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
        await apiRequest('/account-types', { method: 'POST', body: JSON.stringify({ name, icon, color, login_url: '' }) });
        await loadAccountTypes(); 
        renderTypeEditor(); 
        renderSidebar(); 
        showToast('添加成功');
    } catch {} 
}
async function updateType(id, field, value) { try { await apiRequest(`/account-types/${id}`, { method: 'PUT', body: JSON.stringify({ [field]: value }) }); await loadAccountTypes(); renderSidebar(); renderCards(); } catch {} }
async function deleteType(id) { if (!confirm('删除此类型?')) return; try { await apiRequest(`/account-types/${id}`, { method: 'DELETE' }); await loadAccountTypes(); renderTypeEditor(); renderSidebar(); } catch {} }

// 导入导出
function openImportModal() {
    document.getElementById('importFile').value = '';
    document.getElementById('importCsv').value = '';
    document.getElementById('importModal').classList.add('show');
    initDropZone();
    initImportPaste();
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
        const res = await apiRequest('/import', { method: 'POST', body: JSON.stringify({ ...importData, import_mode: option }) });
        const result = await res.json();
        showToast(result.message || '导入成功');
        closeImportModal(); loadData();
    } catch { showToast('导入失败', true); }
}

function initImportPaste() {
    const modal = document.getElementById('importModal');
    if (!modal || modal.dataset.pasteInit) return;
    modal.dataset.pasteInit = 'true';
    modal.addEventListener('contextmenu', showImportContextMenu);
}

function showImportContextMenu(e) {
    e.preventDefault();
    document.querySelectorAll('.qr-context-menu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'qr-context-menu';
    menu.innerHTML = `
        <div class="qr-menu-item" onclick="pasteToImport()">
            <span>📋</span>
            <span>粘贴</span>
            <span class="shortcut">Ctrl+V</span>
        </div>
        <div class="qr-menu-item" onclick="clearImportText()">
            <span>🗑️</span>
            <span>清空</span>
        </div>
    `;
    menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:100001;`;
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', closeImportContextMenu, { once: true }), 0);
}

function closeImportContextMenu() {
    document.querySelectorAll('.qr-context-menu').forEach(m => m.remove());
}

function clearImportText() {
    document.getElementById('importCsv').value = '';
    closeImportContextMenu();
}

async function pasteToImport() {
    closeImportContextMenu();
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            const textarea = document.getElementById('importCsv');
            textarea.value = textarea.value ? textarea.value + '\n' + text : text;
            showToast('已粘贴');
        } else {
            showToast('剪贴板为空', true);
        }
    } catch {
        showToast('无法读取剪贴板，请用 Ctrl+V 粘贴', true);
    }
}

async function doImport() {
    const csv = document.getElementById('importCsv').value.trim();
    if (csv) { try { const res = await apiRequest('/import-csv', { method: 'POST', body: JSON.stringify({ csv }) }); const result = await res.json(); if (result.errors?.length) { showToast(result.message + '（' + result.errors[0] + '）', true); } else { showToast(result.message); } closeImportModal(); loadData(); } catch { showToast('导入失败', true); } }
    else showToast('请选择文件或粘贴CSV', true);
}

async function exportData() {
    // 询问是否包含邮箱配置
    const includeEmails = authorizedEmails.length > 0 ? confirm(
        '📬 检测到已授权邮箱 即将导出：\n\n' +
        '• OAuth 应用凭证（Client ID / Secret）\n' +
        '• 待授权邮箱列表\n\n' +
        '请注意：\n' +
        '• 不会导出邮箱访问令牌（Access Token）\n' +
        '• 导入新环境后需要重新授权每个邮箱\n' +
        '• 不同域名/地址 需要添加新的 URI 具体请查看教程\n' +
        '点击「确定」导出邮箱配置，点击「取消」仅导出账号数据'
    ) : false;
    
    // 安全提醒（保持原版格式）
    if (!confirm('⚠️ 安全提醒\n\n导出的 JSON 文件中密码是【明文】存储的！\n\n请注意：\n• 妥善保管导出文件，不要分享给他人\n• 使用后建议删除本地文件\n• 如需安全备份，请使用「数据备份」功能\n\n确定要导出吗？')) {
        return;
    }
    
    // 确保 token 存在
    if (!token) token = localStorage.getItem('token');
    if (!token) {
        showToast('登录已过期，请重新登录', true);
        setTimeout(() => doLogout(), 500);
        return;
    }
    
    try {
        const endpoint = includeEmails ? '/export?include_emails=true' : '/export';
        const res = await apiRequest(endpoint);

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
        const suffix = includeEmails ? '_with_email_config' : '';
        a.download = `accounts_backup${suffix}_${new Date().toISOString().slice(0,10)}.json`; 
        a.click();
        
        let msg = `✅ 导出成功，共 ${data.accounts.length} 个账号`;
        if (includeEmails && data.oauth_configs) {
            msg += `，${data.oauth_configs.length} 个OAuth配置`;
            if (data.email_addresses?.length > 0) {
                msg += `（${data.email_addresses.length} 个邮箱待重新授权）`;
            }
        }
        showToast(msg);
    } catch (e) { 
        console.error('导出错误:', e);
        showToast('导出失败', true); 
    }
}

// 工具
function toggleSidebar() { const s = document.getElementById('sidebar'); s.classList.toggle('collapsed'); s.classList.toggle('open'); }
function toggleGroup(el) { el.closest('.collapsible-group').classList.toggle('collapsed'); }
function showToast(msg, isError = false) { const t = document.getElementById('toast'); t.textContent = msg; t.className = 'toast show' + (isError ? ' error' : ''); setTimeout(() => t.classList.remove('show'), 2000); }
function escapeHtml(str) { return str ? str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;') : ''; }
const escapeAttr = escapeHtml;
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
            const res = await apiRequest(`/accounts/${id}`, { method: 'DELETE' });

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
        const res = await apiRequest('/change-password', {
            method: 'POST',
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
        const res = await apiRequest('/update-avatar', {
            method: 'POST',
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
        // 生成后显示密码（移除隐藏class）
        input.classList.remove('pwd-hidden');
        updateTogglePwdBtn(true);
        // 3秒后自动隐藏（添加隐藏class）
        setTimeout(() => {
            input.classList.add('pwd-hidden');
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
    const isHidden = input.classList.contains('pwd-hidden');
    if (isHidden) {
        input.classList.remove('pwd-hidden');
    } else {
        input.classList.add('pwd-hidden');
    }
    updateTogglePwdBtn(isHidden);
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
    
    // 先创建弹窗，立即显示loading状态
    const popup = document.createElement('div');
    popup.className = 'totp-popup';
    popup.id = `totp-popup-${accountId}`;
    popup.innerHTML = `<div class="totp-popup-content">
        <div class="totp-header"><span class="totp-issuer">${acc.email}</span><button class="totp-close" onclick="close2FAPopup(${accountId})">✕</button></div>
        <div class="totp-code-wrapper">
            <div class="totp-code loading" id="totp-code-${accountId}" onclick="copyTOTPCode(${accountId})" style="cursor:pointer">------</div>
            <svg class="totp-timer" viewBox="0 0 36 36"><path class="totp-timer-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/><path class="totp-timer-progress" id="totp-progress-${accountId}" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/></svg>
        </div>
        <div class="totp-actions"><button class="totp-copy-btn" onclick="copyTOTPCode(${accountId})">📋 复制</button><span class="totp-remaining" id="totp-remaining-${accountId}"></span></div>
    </div>`;
    document.body.appendChild(popup);
    popup.addEventListener('click', e => { if (e.target === popup) close2FAPopup(accountId); });
    
    try {
        // 异步获取配置和验证码
        const configRes = await apiRequest(`/accounts/${accountId}/totp`);
        if (!configRes.ok) throw new Error();
        const data = await configRes.json();
        
        // 更新issuer
        popup.querySelector('.totp-issuer').textContent = data.issuer || acc.email;
        popup.totpData = data;
        
        // 获取验证码并显示
        await updateTOTPDisplayFromBackend(accountId, data);
        
        // 移除loading，添加loaded动画
        const codeEl = document.getElementById(`totp-code-${accountId}`);
        if (codeEl) {
            codeEl.classList.remove('loading');
            codeEl.classList.add('loaded');
        }
        
        // 自动复制验证码
        if (codeEl && codeEl.dataset.code) {
            copyToClipboard(codeEl.dataset.code).then(ok => {
                if (ok) {
                    showToast('✓ 验证码已复制');
                    if (clipboardTimeout) clearTimeout(clipboardTimeout);
                    clipboardTimeout = setTimeout(() => clearClipboard(), 60000);
                }
            });
        }
        
        totpIntervals[accountId] = setInterval(() => updateTOTPDisplayFromBackend(accountId, data), 1000);
    } catch { 
        close2FAPopup(accountId);
        showToast('获取2FA失败', true); 
    }
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

function updateEditModal2FAButton(accountId) {
    const btn2FA = document.getElementById('btn2FAConfig');
    const btnBackup = document.getElementById('btnBackupCodes');
    const acc = accounts.find(a => a.id === accountId);
    if (!acc || !btn2FA) return;
    btn2FA.textContent = acc.has_2fa ? '🛡️ 2FA ✓' : '🛡️ 设置 2FA';
    btn2FA.classList.toggle('has-2fa', !!acc.has_2fa);
    if (btnBackup) {
        btnBackup.style.display = acc.has_2fa ? 'inline-flex' : 'none';
        btnBackup.classList.toggle('has-codes', !!acc.has_backup_codes);
    }
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

// ==================== 备份码功能 ====================
// ==================== 备份码独立弹窗 ====================
let backupCodesPopupAccountId = null;
let backupCodesCache = []; // 当前加载的备份码

function getUsedBackupCodes(accountId) {
    try { return JSON.parse(localStorage.getItem(`backup_used_${accountId}`) || '[]'); } catch { return []; }
}
function setUsedBackupCodes(accountId, usedList) {
    localStorage.setItem(`backup_used_${accountId}`, JSON.stringify(usedList));
}

async function openBackupCodesPopup() {
    const accountId = editingAccountId;
    if (!accountId) return;

    backupCodesPopupAccountId = accountId;
    backupCodesCache = [];

    // 显示弹窗，切换到查看模式
    showBackupViewMode();
    document.getElementById('backupCodesViewMode').innerHTML = '<div class="backup-codes-empty">加载中...</div>';
    document.getElementById('backupCodesModal').classList.add('show');

    try {
        const res = await apiRequest(`/accounts/${accountId}/totp`);
        if (res.ok) {
            const data = await res.json();
            backupCodesCache = data.backup_codes || [];
        }
    } catch {}

    if (backupCodesCache.length === 0) {
        document.getElementById('backupCodesViewMode').innerHTML = '<div class="backup-codes-empty">暂无备份码，点击 ✏️ 添加</div>';
        document.getElementById('backupCodesUsedCount').textContent = '';
        return;
    }
    renderBackupCodesGrid();
    initBackupDropZone();
}

function renderBackupCodesGrid() {
    const view = document.getElementById('backupCodesViewMode');
    const usedSet = new Set(getUsedBackupCodes(backupCodesPopupAccountId));

    view.innerHTML = '<div class="backup-codes-grid">' + backupCodesCache.map((code, i) => {
        const isUsed = usedSet.has(code);
        return `<div class="backup-code-item${isUsed ? ' used' : ''}" data-code="${escapeHtml(code)}" onclick="toggleBackupCode(this)">
            <span class="code-num">${i + 1}.</span>
            <span class="code-text">${escapeHtml(code)}</span>
            <span class="code-status">${isUsed ? '✓' : ''}</span>
        </div>`;
    }).join('') + '</div>';

    updateBackupCodesCount(backupCodesCache.length, usedSet.size);
}

function toggleBackupCode(el) {
    const code = el.dataset.code;
    const accountId = backupCodesPopupAccountId;
    const usedList = getUsedBackupCodes(accountId);
    const idx = usedList.indexOf(code);

    if (el.classList.contains('used')) {
        el.classList.remove('used');
        el.querySelector('.code-status').textContent = '';
        if (idx !== -1) usedList.splice(idx, 1);
    } else {
        copyToClipboard(code);
        showToast('📋 已复制: ' + code);
        el.classList.add('used');
        el.querySelector('.code-status').textContent = '✓';
        if (idx === -1) usedList.push(code);
    }

    setUsedBackupCodes(accountId, usedList);
    const total = document.querySelectorAll('#backupCodesViewMode .backup-code-item').length;
    updateBackupCodesCount(total, usedList.length);
}

function updateBackupCodesCount(total, used) {
    const el = document.getElementById('backupCodesUsedCount');
    if (el) el.textContent = used > 0 ? `已用 ${used}/${total}` : `共 ${total} 个`;
}

function resetAllBackupCodes() {
    const accountId = backupCodesPopupAccountId;
    if (!accountId) return;
    setUsedBackupCodes(accountId, []);
    document.querySelectorAll('#backupCodesViewMode .backup-code-item').forEach(el => {
        el.classList.remove('used');
        el.querySelector('.code-status').textContent = '';
    });
    updateBackupCodesCount(backupCodesCache.length, 0);
    showToast('↩️ 已全部重置');
}

// 编辑模式切换
function toggleBackupEditMode() {
    const editMode = document.getElementById('backupCodesEditMode');
    if (editMode.style.display === 'none') {
        // 进入编辑模式
        document.getElementById('backupCodesTextarea').value = backupCodesCache.join('\n');
        showBackupEditMode();
        initBackupDropZone();
    } else {
        // 退出编辑模式
        showBackupViewMode();
    }
}

function showBackupEditMode() {
    document.getElementById('backupCodesViewMode').style.display = 'none';
    document.getElementById('backupCodesEditMode').style.display = 'block';
    document.getElementById('btnBackupReset').style.display = 'none';
    document.getElementById('backupViewFooter').style.display = 'none';
    document.getElementById('btnBackupCancel').style.display = '';
    document.getElementById('btnBackupSave').style.display = '';
    document.getElementById('btnBackupEdit').textContent = '📋';
    document.getElementById('btnBackupEdit').title = '查看';
}

function showBackupViewMode() {
    document.getElementById('backupCodesViewMode').style.display = '';
    document.getElementById('backupCodesEditMode').style.display = 'none';
    document.getElementById('btnBackupReset').style.display = '';
    document.getElementById('backupViewFooter').style.display = '';
    document.getElementById('btnBackupCancel').style.display = 'none';
    document.getElementById('btnBackupSave').style.display = 'none';
    document.getElementById('btnBackupEdit').textContent = '✏️';
    document.getElementById('btnBackupEdit').title = '编辑';
}

function cancelBackupEdit() {
    showBackupViewMode();
}

async function saveBackupCodes() {
    const accountId = backupCodesPopupAccountId;
    if (!accountId) return;

    const text = document.getElementById('backupCodesTextarea').value;
    const codes = text.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));

    try {
        const res = await apiRequest(`/accounts/${accountId}/totp`);
        if (!res.ok) { showToast('无法读取 2FA 配置', true); return; }
        const data = await res.json();

        // 用现有 2FA 配置 + 新备份码保存
        const config = {
            secret: data.secret,
            issuer: data.issuer || '',
            totp_type: data.type || 'totp',
            algorithm: data.algorithm || 'SHA1',
            digits: data.digits || 6,
            period: data.period || 30,
            backup_codes: codes
        };

        const saveRes = await apiRequest(`/accounts/${accountId}/totp`, {
            method: 'POST',
            body: JSON.stringify(config)
        });

        if (saveRes.ok) {
            backupCodesCache = codes;
            const acc = accounts.find(a => a.id === accountId);
            if (acc) acc.has_backup_codes = codes.length > 0;
            // 更新编辑界面按钮
            const btnBackup = document.getElementById('btnBackupCodes');
            if (btnBackup) {
                btnBackup.style.display = codes.length > 0 ? 'inline-flex' : 'none';
                btnBackup.classList.toggle('has-codes', codes.length > 0);
            }
            renderCards();
            showBackupViewMode();
            if (codes.length > 0) {
                renderBackupCodesGrid();
                showToast(`✅ 已保存 ${codes.length} 个备份码`);
            } else {
                document.getElementById('backupCodesViewMode').innerHTML = '<div class="backup-codes-empty">暂无备份码，点击 ✏️ 添加</div>';
                document.getElementById('backupCodesUsedCount').textContent = '';
                showToast('备份码已清空');
            }
        } else {
            showToast('保存失败', true);
        }
    } catch {
        showToast('保存失败', true);
    }
}

function initBackupDropZone() {
    const zone = document.getElementById('backupCodesZone2');
    if (!zone || zone.dataset.initialized) return;
    zone.dataset.initialized = 'true';

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
        zone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); });
    });
    zone.addEventListener('dragenter', () => zone.classList.add('drag-over'));
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
        zone.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file && file.name.endsWith('.txt')) {
            const reader = new FileReader();
            reader.onload = ev => {
                const codes = ev.target.result.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
                if (codes.length > 0) {
                    document.getElementById('backupCodesTextarea').value = codes.join('\n');
                    showToast(`📄 已导入 ${codes.length} 个备份码`);
                }
            };
            reader.readAsText(file);
        }
    });
}

function closeBackupCodesPopup() {
    document.getElementById('backupCodesModal').classList.remove('show');
    backupCodesPopupAccountId = null;
    showBackupViewMode();
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
    
    // 新增：支持 Ctrl+V 粘贴图片
    document.addEventListener('paste', handleQRPaste);
    
    // 新增：右键菜单粘贴
    zone.addEventListener('contextmenu', showQRContextMenu);
}

// 处理剪贴板粘贴（Ctrl+V）
async function handleQRPaste(e) {
    // 仅在2FA模态框打开时处理
    const modal = document.getElementById('twoFAConfigModal');
    if (!modal || !modal.classList.contains('show')) return;
    
    // 如果焦点在输入框，不拦截
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
        // 但如果是密钥输入框且粘贴的是图片，还是要处理
        if (activeEl.id !== 'totp2FASecret') return;
    }
    
    const items = e.clipboardData?.items;
    if (!items) return;
    
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            e.preventDefault();
            const file = item.getAsFile();
            if (file) {
                showToast('📷 正在识别粘贴的图片...');
                scanQRFromFile(file);
            }
            return;
        }
    }
}

// 右键菜单
function showQRContextMenu(e) {
    e.preventDefault();
    
    // 移除已有菜单
    document.querySelectorAll('.qr-context-menu').forEach(m => m.remove());
    
    const menu = document.createElement('div');
    menu.className = 'qr-context-menu';
    menu.innerHTML = `
        <div class="qr-menu-item" onclick="pasteQRFromClipboard()">
            <span>📋</span>
            <span>粘贴图片</span>
            <span class="shortcut">Ctrl+V</span>
        </div>
        <div class="qr-menu-item" onclick="document.getElementById('qrFileInput').click();closeQRContextMenu()">
            <span>📁</span>
            <span>选择文件</span>
        </div>
    `;
    menu.style.cssText = `
        position: fixed;
        left: ${e.clientX}px;
        top: ${e.clientY}px;
        z-index: 100001;
    `;
    document.body.appendChild(menu);
    
    // 点击其他地方关闭
    setTimeout(() => {
        document.addEventListener('click', closeQRContextMenu, { once: true });
    }, 0);
}

function closeQRContextMenu() {
    document.querySelectorAll('.qr-context-menu').forEach(m => m.remove());
}

// 从剪贴板读取图片
async function pasteQRFromClipboard() {
    closeQRContextMenu();
    
    try {
        // 使用 Clipboard API 读取
        if (navigator.clipboard && navigator.clipboard.read) {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                for (const type of item.types) {
                    if (type.startsWith('image/')) {
                        const blob = await item.getType(type);
                        showToast('📷 正在识别粘贴的图片...');
                        scanQRFromFile(blob);
                        return;
                    }
                }
            }
            showToast('剪贴板中没有图片', true);
        } else {
            showToast('请使用 Ctrl+V 粘贴，或拖拽图片', true);
        }
    } catch (err) {
        console.error('读取剪贴板失败:', err);
        showToast('无法访问剪贴板，请使用 Ctrl+V', true);
    }
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
        if (period) {
            // 周期参数，后端会使用
        }
    } catch (e) {
        console.error('解析 otpauth URI 失败:', e);
    }
}

async function save2FAConfig() {
    const secret = document.getElementById('totp2FASecret').value.trim();
    if (!secret) { showToast('请输入密钥或扫描二维码', true); return; }
    if (secret.length < 8) { showToast('密钥长度不足', true); return; }

    // 先读取现有备份码（备份码已独立管理，保存 2FA 时不覆盖）
    let existingBackupCodes = [];
    try {
        const existing = await apiRequest(`/accounts/${current2FAAccountId}/totp`);
        if (existing.ok) {
            const d = await existing.json();
            existingBackupCodes = d.backup_codes || [];
        }
    } catch {}

    const config = {
        secret: secret,
        issuer: document.getElementById('totp2FAIssuer').value.trim(),
        totp_type: document.getElementById('totp2FAType').value,
        algorithm: document.getElementById('totp2FAAlgorithm').value,
        digits: parseInt(document.getElementById('totp2FADigits').value) || 6,
        period: 30,
        backup_codes: existingBackupCodes
    };

    try {
        const res = await apiRequest(`/accounts/${current2FAAccountId}/totp`, {
            method: 'POST',
            body: JSON.stringify(config)
        });

        if (res.ok) {
            showToast('✅ 2FA 配置成功');
            const savedId = current2FAAccountId;
            close2FAConfigModal();
            const acc = accounts.find(a => a.id === savedId);
            if (acc) {
                acc.has_2fa = true;
                acc.has_backup_codes = existingBackupCodes.length > 0;
            }
            renderCards();
            updateEditModal2FAButton(savedId);
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
            const savedId = current2FAAccountId;
            close2FAConfigModal();
            const acc = accounts.find(a => a.id === savedId);
            if (acc) {
                acc.has_2fa = false;
                acc.has_backup_codes = false;
            }
            renderCards();
            updateEditModal2FAButton(savedId);
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

// ==================== 批量修改属性功能 ====================
let batchPropsToAdd = [];
let batchPropsToRemove = [];
let batchAddAsCombo = true; // 新增：是否作为复合属性组添加

function openBatchPropsModal() {
    if (selectedAccounts.size === 0) {
        showToast('请先选择账号', true);
        return;
    }
    
    batchPropsToAdd = [];
    batchPropsToRemove = [];
    batchAddAsCombo = true; // 默认作为复合属性组
    
    const existing = document.getElementById('batchPropsOverlay');
    if (existing) existing.remove();
    
    let html = `
    <div id="batchPropsOverlay" class="combo-overlay">
        <div class="combo-dialog" style="max-width:500px">
            <div class="combo-dialog-header">
                <span>🏷️ 批量修改属性</span>
                <button class="combo-close" onclick="closeBatchPropsModal()">✕</button>
            </div>
            <div class="combo-dialog-body">
                <div class="hint-box" style="margin-bottom:16px">
                    <p>已选择 <b>${selectedAccounts.size}</b> 个账号</p>
                    <p style="margin-top:8px;font-size:0.9em">
                        点击属性：<span style="color:#22c55e">添加(绿)</span> → <span style="color:#ef4444">移除(红)</span> → 取消
                    </p>
                </div>
                <div class="batch-mode-toggle" style="margin-bottom:16px;padding:12px;background:var(--bg-hover);border-radius:8px;">
                    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                        <input type="checkbox" id="batchComboMode" checked onchange="batchAddAsCombo=this.checked;updateBatchModeHint()">
                        <span><b>复合属性组模式</b></span>
                    </label>
                    <p id="batchModeHint" style="margin-top:6px;font-size:0.85em;color:var(--text-muted)">
                        添加：多个属性合并为一个复合组，如"备用 正常"<br>
                        移除：只移除完全匹配的复合组
                    </p>
                </div>`;
    
    propertyGroups.forEach(g => {
        html += `<div class="combo-group">
            <div class="combo-group-name">${escapeHtml(g.name)}</div>
            <div class="combo-group-options">`;
        (g.values || []).forEach(v => {
            html += `<div class="combo-option" data-vid="${v.id}" data-gid="${g.id}" onclick="toggleBatchProp(this, ${v.id})">
                <span class="combo-check-dot" style="background:${escapeAttr(v.color)}"></span>
                ${escapeHtml(v.name)}
            </div>`;
        });
        html += '</div></div>';
    });
    
    html += `
                <div id="batchPreview" style="margin-top:16px;padding:12px;background:var(--bg-hover);border-radius:8px;display:none;">
                    <div style="font-size:0.9em;color:var(--text-muted);margin-bottom:8px;">预览：</div>
                    <div id="batchPreviewContent"></div>
                </div>
            </div>
            <div class="combo-dialog-footer">
                <button class="combo-btn" onclick="closeBatchPropsModal()">取消</button>
                <button class="combo-btn primary" onclick="applyBatchProps()">应用更改</button>
            </div>
        </div>
    </div>`;
    
    document.body.insertAdjacentHTML('beforeend', html);
}

function updateBatchModeHint() {
    const hint = document.getElementById('batchModeHint');
    if (hint) {
        hint.innerHTML = batchAddAsCombo 
            ? '添加：多个属性合并为一个复合组，如"备用 正常"<br>移除：只移除完全匹配的复合组'
            : '添加：每个属性分别添加为独立标签<br>移除：只移除单独的标签，不影响复合组';
    }
    updateBatchPreview();
}

function updateBatchPreview() {
    const preview = document.getElementById('batchPreview');
    const content = document.getElementById('batchPreviewContent');
    if (!preview || !content) return;
    
    let html = '';
    
    // 预览要添加的
    if (batchPropsToAdd.length > 0) {
        if (batchAddAsCombo) {
            // 复合模式：显示为一个组合（使用normalizeCombo规范化）
            const normalized = normalizeCombo(batchPropsToAdd);
            const display = getComboDisplay(normalized);
            html += `<span style="color:#22c55e">+ </span><span class="combo-badge" style="background:${hexToRgba(display.color,0.12)};color:${display.color}"><span class="combo-dot" style="background:${display.color}"></span>${display.text}</span> `;
        } else {
            // 独立模式：分别显示
            batchPropsToAdd.forEach(vid => {
                const display = getComboDisplay([vid]);
                html += `<span style="color:#22c55e">+ </span><span class="combo-badge" style="background:${hexToRgba(display.color,0.12)};color:${display.color}"><span class="combo-dot" style="background:${display.color}"></span>${display.text}</span> `;
            });
        }
    }
    
    // 预览要移除的
    if (batchPropsToRemove.length > 0) {
        if (batchAddAsCombo) {
            // 复合模式：显示为一个要移除的组合（使用normalizeCombo规范化）
            const normalized = normalizeCombo(batchPropsToRemove);
            const display = getComboDisplay(normalized);
            html += `<span style="color:#ef4444">- </span><span class="combo-badge" style="background:rgba(239,68,68,0.12);color:#ef4444;text-decoration:line-through"><span class="combo-dot" style="background:#ef4444"></span>${display.text}</span> `;
        } else {
            // 独立模式：分别显示
            batchPropsToRemove.forEach(vid => {
                const display = getComboDisplay([vid]);
                html += `<span style="color:#ef4444">- </span><span class="combo-badge" style="background:rgba(239,68,68,0.12);color:#ef4444;text-decoration:line-through"><span class="combo-dot" style="background:#ef4444"></span>${display.text}</span> `;
            });
        }
    }
    
    if (html) {
        preview.style.display = 'block';
        content.innerHTML = html;
    } else {
        preview.style.display = 'none';
    }
}

function closeBatchPropsModal() {
    const overlay = document.getElementById('batchPropsOverlay');
    if (overlay) overlay.remove();
}

function toggleBatchProp(el, vid) {
    const isAdd = batchPropsToAdd.includes(vid);
    const isRemove = batchPropsToRemove.includes(vid);
    
    if (!isAdd && !isRemove) {
        // 第一次点击：添加（绿色）
        batchPropsToAdd.push(vid);
        el.style.borderColor = '#22c55e';
        el.style.background = 'rgba(34, 197, 94, 0.15)';
        el.style.color = '#22c55e';
        el.style.textDecoration = '';
    } else if (isAdd) {
        // 第二次点击：移除（红色+删除线）
        batchPropsToAdd = batchPropsToAdd.filter(v => v !== vid);
        batchPropsToRemove.push(vid);
        el.style.borderColor = '#ef4444';
        el.style.background = 'rgba(239, 68, 68, 0.15)';
        el.style.color = '#ef4444';
        el.style.textDecoration = 'line-through';
    } else {
        // 第三次点击：取消（恢复原样）
        batchPropsToRemove = batchPropsToRemove.filter(v => v !== vid);
        el.style.borderColor = '';
        el.style.background = '';
        el.style.color = '';
        el.style.textDecoration = '';
    }
    
    // 更新预览
    updateBatchPreview();
}

async function applyBatchProps() {
    if (batchPropsToAdd.length === 0 && batchPropsToRemove.length === 0) {
        showToast('未选择任何属性变更', true);
        return;
    }
    
    const selectedIds = Array.from(selectedAccounts);
    let successCount = 0;
    
    for (const accId of selectedIds) {
        const acc = accounts.find(a => a.id === accId);
        if (!acc) continue;
        
        let newCombos = [...(acc.combos || [])];
        
        // 添加属性
        if (batchPropsToAdd.length > 0) {
            if (batchAddAsCombo) {
                // 复合模式：将所有选中的属性作为一个复合组添加
                // 使用normalizeCombo规范化，确保顺序一致
                const normalizedAdd = normalizeCombo(batchPropsToAdd);
                // 检查是否已存在相同的复合组（使用combosEqual比较）
                const exists = newCombos.some(combo => combosEqual(combo, normalizedAdd));
                if (!exists) {
                    newCombos.push([...normalizedAdd]);
                }
            } else {
                // 独立模式：每个属性单独添加
                batchPropsToAdd.forEach(vid => {
                    const hasIt = newCombos.some(combo => Array.isArray(combo) && combo.includes(vid));
                    if (!hasIt) newCombos.push([vid]);
                });
            }
        }
        
        // 移除属性
        if (batchPropsToRemove.length > 0) {
            if (batchAddAsCombo) {
                // 复合模式：只移除完全匹配的复合组（使用combosEqual比较）
                const normalizedRemove = normalizeCombo(batchPropsToRemove);
                newCombos = newCombos.filter(combo => !combosEqual(combo, normalizedRemove));
            } else {
                // 独立模式：只移除单独的标签 [vid]，不影响复合组
                batchPropsToRemove.forEach(vid => {
                    newCombos = newCombos.filter(combo => {
                        if (!Array.isArray(combo)) return true;
                        // 只移除恰好是 [vid] 的单独标签
                        return !(combo.length === 1 && combo[0] === vid);
                    });
                });
            }
        }
        
        try {
            const res = await apiRequest(`/accounts/${accId}`, {
                method: 'PUT',
                body: JSON.stringify({ combos: newCombos })
            });
            if (res.ok) successCount++;
        } catch (e) {
            console.error('批量修改属性失败:', accId, e);
        }
    }
    
    closeBatchPropsModal();
    await loadAccounts();
    renderSidebar();
    renderCards();
    showToast(`✅ 已更新 ${successCount} 个账号的属性`);
}

init();

// 新增：专门处理标签输入框的回车提交
function handleTagSubmit(e) {
    e.preventDefault(); // 阻止刷新
    const input = document.getElementById('accTagInput');
    if (!input) return;
    
    const val = input.value.trim();
    if (val && !editingTags.includes(val)) {
        editingTags.push(val); // 添加标签
        addToTagHistory(val);  // 添加到历史
        renderTagsBox();       // 重新渲染
    }
    // 手机端提交后，通常建议让输入框失去焦点，收起键盘，不然用户会困惑
    input.blur(); 
}

// 密码强度验证函数
function validatePasswordStrength(password) {
    const errors = [];
    if (password.length < 8) errors.push('密码至少需要8个字符');
    if (!/[a-zA-Z]/.test(password)) errors.push('密码必须包含字母');
    if (!/\d/.test(password)) errors.push('密码必须包含数字');
    if (errors.length > 0) {
        showToast('⚠️ ' + errors.join('，'), true);
        return false;
    }
    return true;
}

// 点击弹窗外部关闭
document.addEventListener('click', (e) => {
    const modal = document.getElementById('backupModal');
    if (e.target === modal) closeBackupModal();
});


// ==================== 数据备份功能 ====================

let autoBackupTimer = null;

function showBackupModal() {
    document.getElementById('backupModal').classList.add('show');
    loadBackupPath();
    loadAutoBackupSettings();
    loadKeyInfo();
    updateBackupCount(); // 只更新数量，不加载完整列表
}

function closeBackupModal() {
    document.getElementById('backupModal').classList.remove('show');
}

function showBackupListModal() {
    document.getElementById('backupListModal').classList.add('show');
    listBackups();
}

function closeBackupListModal() {
    document.getElementById('backupListModal').classList.remove('show');
}

function loadBackupPath() {
    // 路径由后端环境变量控制，前端不需要处理
}

function getBackupPath() {
    return null;
}

async function createBackup() {
    try {
        showToast('⏳ 正在备份...');
        const resp = await apiRequest('/backup', {
            method: 'POST',
            body: JSON.stringify({})
        });
        const data = await resp.json();
        if (resp.ok) {
            showToast('✅ 备份完成');
            updateBackupCount();
            if (document.getElementById('backupListModal')?.classList.contains('show')) {
                listBackups();
            }
        } else {
            showToast('❌ ' + (data.detail || '备份失败'), true);
        }
    } catch (e) {
        showToast('❌ 网络错误', true);
    }
}

async function downloadBackupToLocal() {
    try {
        showToast('⏳ 正在打包...');
        
        const resp = await apiRequest('/backup/download');
        
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || '下载失败');
        }
        
        const blob = await resp.blob();
        const url = window.URL.createObjectURL(blob);
        
        // 生成文件名
        const date = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
        const filename = `accbox_backup_${date}.db`;
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        
        showToast('✅ 已下载到本地');
    } catch (e) {
        showToast('❌ ' + e.message, true);
    }
}

async function updateBackupCount() {
    const count = document.getElementById('backupCount');
    try {
        const resp = await apiRequest('/backups');
        const data = await resp.json();
        if (resp.ok && count) {
            count.textContent = data.backups.length + ' 个';
        }
    } catch (e) {
        if (count) count.textContent = '-- 个';
    }
}

async function listBackups() {
    const container = document.getElementById('backupListContainer');
    const count = document.getElementById('backupCount');
    
    if (container) container.innerHTML = '<div class="backup-empty">加载中...</div>';
    
    try {
        const resp = await apiRequest('/backups');
        const data = await resp.json();
        if (resp.ok) {
            if (count) count.textContent = data.backups.length + ' 个';
            
            if (data.backups.length === 0) {
                container.innerHTML = `
                    <div class="backup-empty">
                        暂无备份<br>
                        <span style="font-size:12px;color:var(--text-muted)">点击「备份到服务器」创建第一个备份</span>
                    </div>
                    <div class="backup-download-tip">
                        💡 建议定期下载备份到本地电脑，防止数据丢失
                    </div>`;
            } else {
                // 最多显示 50 个
                const backups = data.backups.slice(0, 50);
                container.innerHTML = backups.map(b => {
                    // 解析文件名获取时间
                    const timeMatch = b.filename.match(/backup_(\d{8})_(\d{6})/);
                    let timeStr = b.filename;
                    if (timeMatch) {
                        const d = timeMatch[1], t = timeMatch[2];
                        timeStr = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)} ${t.slice(0,2)}:${t.slice(2,4)}`;
                    }
                    const sizeKB = (b.size / 1024).toFixed(1);
                    const isAuto = b.filename.includes('_auto');
                    const isBeforeRestore = b.filename.includes('_before_restore');
                    
                    let typeIcon = '📦';
                    let typeText = '';
                    if (isBeforeRestore) { typeIcon = '🔄'; typeText = '恢复前'; }
                    else if (isAuto) { typeIcon = '⏰'; typeText = '自动'; }
                    
                    return `
                    <div class="backup-item">
                        <div class="backup-item-info">
                            <span class="backup-item-icon">${typeIcon}</span>
                            <div class="backup-item-details">
                                <div class="backup-item-name">${timeStr}</div>
                                <div class="backup-item-meta">${sizeKB} KB${typeText ? ' · ' + typeText : ''}</div>
                            </div>
                        </div>
                        <div class="backup-item-actions">
                            <button class="btn btn-download" onclick="downloadExistingBackup('${b.filename}')" title="下载到本地">⬇️</button>
                            <button class="btn btn-restore" onclick="restoreBackup('${b.filename}')">恢复</button>
                            <button class="btn btn-delete" onclick="deleteBackup('${b.filename}')">🗑️</button>
                        </div>
                    </div>`;
                }).join('');
                
                // 添加下载提示和图标说明
                container.innerHTML += `
                    <div class="backup-download-tip">
                        💡 建议定期点击 ⬇️ 下载到本地电脑
                    </div>
                    <div class="backup-legend">
                        📦 手动备份 &nbsp;｜&nbsp; ⏰ 定时备份 &nbsp;｜&nbsp; 🔄 恢复前自动备份
                    </div>`;
                
                if (data.backups.length > 50) {
                    container.innerHTML += `<div class="backup-empty" style="padding:15px">仅显示最近 50 条，共 ${data.backups.length} 条</div>`;
                }
            }
        }
    } catch (e) {
        console.error('获取备份列表失败:', e);
        if (container) container.innerHTML = '<div class="backup-empty">加载失败，请重试</div>';
    }
}

// 下载备份文件到本地
async function downloadExistingBackup(filename) {
    try {
        showToast('⏳ 正在下载...');
        
        const resp = await apiRequest(`/backups/${encodeURIComponent(filename)}/download`);
        
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || '下载失败');
        }
        
        const blob = await resp.blob();
        const url = window.URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        
        showToast('✅ 已下载到本地');
    } catch (e) {
        console.error('下载备份失败:', e);
        showToast('❌ ' + e.message, true);
    }
}

async function restoreBackup(filename) {
    if (!confirm('⚠️ 确定要恢复此备份吗？\n\n当前数据将被覆盖，此操作不可撤销！')) return;
    try {
        showToast('⏳ 正在恢复...');
        const resp = await apiRequest('/backups/' + encodeURIComponent(filename) + '/restore', {
            method: 'POST',
            body: JSON.stringify({})
        });
        const data = await resp.json();
        if (resp.ok) {
            showToast('✅ 恢复成功，即将刷新页面');
            setTimeout(() => location.reload(), 1500);
        } else {
            showToast('❌ ' + (data.detail || '恢复失败'), true);
        }
    } catch (e) {
        showToast('❌ 网络错误', true);
    }
}

async function deleteBackup(filename) {
    if (!confirm('确定要删除此备份吗？')) return;
    try {
        const resp = await apiRequest('/backups/' + encodeURIComponent(filename), { method: 'DELETE' });
        const data = await resp.json();
        if (resp.ok) {
            showToast('✅ 已删除');
            updateBackupCount();
            listBackups();
        } else {
            showToast('❌ ' + (data.detail || '删除失败'), true);
        }
    } catch (e) {
        showToast('❌ 网络错误', true);
    }
}


// ==================== 定时备份功能（后端执行） ====================

async function loadAutoBackupSettings() {
    const intervalSelect = document.getElementById('autoBackupInterval');
    const keepSelect = document.getElementById('autoBackupKeep');
    
    try {
        const resp = await apiRequest('/backup/settings');
        if (resp.ok) {
            const settings = await resp.json();
            if (intervalSelect) intervalSelect.value = settings.interval_hours || '0';
            if (keepSelect) keepSelect.value = settings.keep_count || '10';
            updateAutoBackupStatus(settings);
        }
    } catch (e) {
        console.log('加载备份设置失败，使用默认值');
        updateAutoBackupStatus({});
    }
}

async function saveAutoBackupSettings() {
    const interval = parseInt(document.getElementById('autoBackupInterval').value);
    const keep = parseInt(document.getElementById('autoBackupKeep').value);
    
    try {
        const resp = await apiRequest('/backup/settings', {
            method: 'POST',
            body: JSON.stringify({ interval_hours: interval, keep_count: keep })
        });
        
        if (resp.ok) {
            const result = await resp.json();
            updateAutoBackupStatus(result.settings);
            
            if (interval > 0) {
                showToast(`✅ 定时备份已启用：每 ${interval} 小时`);
            } else {
                showToast('定时备份已关闭');
            }
        } else {
            showToast('❌ 保存设置失败', true);
        }
    } catch (e) {
        console.error('保存备份设置失败:', e);
        showToast('❌ 网络错误', true);
    }
}

function updateAutoBackupStatus(settings) {
    const status = document.getElementById('autoBackupStatus');
    if (!status) return;
    
    const interval = settings?.interval_hours || 0;
    const lastBackup = settings?.last_backup;
    
    if (interval > 0) {
        let statusText = `✅ 定时备份已启用：每 ${interval} 小时`;
        if (lastBackup) {
            const lastTime = new Date(lastBackup);
            statusText += `（上次: ${lastTime.toLocaleString('zh-CN').replace(/:\d{2}$/, '')}）`;
        } else {
            statusText += `，首次备份将在 ${interval} 小时后`;
        }
        status.textContent = statusText;
        status.classList.add('active');
    } else {
        status.textContent = '定时备份：未启用';
        status.classList.remove('active');
    }
}

// ==================== 密钥管理功能 ====================

async function loadKeyInfo() {
    const container = document.getElementById('keyInfoContainer');
    if (!container) return;
    
    try {
        const resp = await apiRequest('/encryption-key/info');
        if (resp.ok) {
            const info = await resp.json();
            
            // 只有一种情况：密钥在 .env 文件中
            if (info.source === 'environment') {
                container.innerHTML = '<div class="backup-key-tip">🔑 您的密钥配置在 .env 文件中，迁移时请一并备份</div>';
            }
        }
    } catch (e) {
        // 静默失败
    }
}

// 保存推送设置
function savePushSettings() {
    pushSettings = {
        notify: document.getElementById('pushNotify')?.checked ?? true,
        toast: document.getElementById('pushToast')?.checked ?? true
    };
    localStorage.setItem('pushSettings', JSON.stringify(pushSettings));
    showToast('✅ 设置已保存');
}

// 初始化推送设置UI
function initPushSettingsUI() {
    document.getElementById('pushNotify').checked = pushSettings.notify;
    document.getElementById('pushToast').checked = pushSettings.toast;
}


// ==================== 键盘快捷键 ====================

document.addEventListener('keydown', (e) => {
    // 如果在输入框中，不触发快捷键（除了 Escape）
    const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    const isModalOpen = document.querySelector('.modal-overlay.show') || document.querySelector('.totp-popup');
    
    // Escape - 关闭弹窗/退出模式
    if (e.key === 'Escape') {
        if (document.querySelector('.totp-popup')) {
            document.querySelector('.totp-popup .totp-close')?.click();
            return;
        }
        if (document.querySelector('.modal-overlay.show')) {
            document.querySelector('.modal-overlay.show .btn-close')?.click();
            return;
        }
        if (batchMode) {
            toggleBatchMode();
            return;
        }
        // 清空搜索
        const searchInput = document.getElementById('searchInput');
        if (searchInput && searchInput.value) {
            searchInput.value = '';
            filterAccounts();
            return;
        }
    }
    
    // 以下快捷键在输入框中不触发
    if (isInput) return;
    
    // 以下快捷键在弹窗打开时不触发
    if (isModalOpen) return;
    
    // Ctrl/Cmd + K 或 / - 聚焦搜索框
    if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || e.key === '/') {
        e.preventDefault();
        document.getElementById('searchInput')?.focus();
        return;
    }
    
    // Ctrl/Cmd + N - 新建账号
    if (e.key === 'n' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        openAddModal();
        return;
    }
    
    // B - 切换批量模式
    if (e.key === 'b' || e.key === 'B') {
        toggleBatchMode();
        return;
    }
    
    // R - 刷新数据
    if (e.key === 'r' || e.key === 'R') {
        loadData();
        showToast('🔄 刷新中...');
        return;
    }
    
    // ? - 显示快捷键帮助
    if (e.key === '?' && e.shiftKey) {
        showShortcutsHelp();
        return;
    }
});

// 显示快捷键帮助
function showShortcutsHelp() {
    const shortcuts = [
        ['/', '聚焦搜索框'],
        ['Ctrl + K', '聚焦搜索框'],
        ['Ctrl + N', '新建账号'],
        ['B', '切换批量模式'],
        ['R', '刷新数据'],
        ['Esc', '关闭弹窗 / 退出模式 / 清空搜索'],
        ['Shift + ?', '显示此帮助']
    ];
    
    const html = `
        <div class="shortcuts-help" onclick="this.remove()">
            <div class="shortcuts-content" onclick="event.stopPropagation()">
                <div class="shortcuts-header">
                    <span>⌨️ 键盘快捷键</span>
                    <button class="btn-close" onclick="this.closest('.shortcuts-help').remove()">✕</button>
                </div>
                <div class="shortcuts-list">
                    ${shortcuts.map(([key, desc]) => `
                        <div class="shortcut-item">
                            <kbd>${key}</kbd>
                            <span>${desc}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
}

// ==================== Ripple 点击效果 ====================

function createRipple(event) {
    const element = event.currentTarget;
    
    // 移除旧的 ripple
    const oldRipple = element.querySelector('.ripple');
    if (oldRipple) oldRipple.remove();
    
    const rect = element.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = event.clientX - rect.left - size / 2;
    const y = event.clientY - rect.top - size / 2;
    
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.cssText = `width:${size}px;height:${size}px;left:${x}px;top:${y}px;`;
    
    element.appendChild(ripple);
    
    // 动画结束后移除
    setTimeout(() => ripple.remove(), 600);
}

// 给需要 ripple 效果的元素绑定事件（使用事件委托）
document.addEventListener('click', (e) => {
    const target = e.target.closest('.btn-action, .btn-toolbar, .btn-primary, .btn-toolbar-sm, .nav-item, .prop-item');
    if (target && !target.classList.contains('no-ripple')) {
        createRipple({ currentTarget: target, clientX: e.clientX, clientY: e.clientY });
    }
});

// 卡片角标功能已移除

// 立即获取验证码，并进入1分钟高频轮询模式
let fastModeTimer = null;

async function fetchEmailsNow() {
    if (authorizedEmails.length === 0) {
        showToast('请先授权邮箱', true);
        return;
    }
    
    const btn = document.getElementById('btnRefreshEmails');
    
    // 开始心跳动画
    if (btn) btn.classList.add('beating');
    
    showToast('💓 已开启1分钟加速模式');
    
    // 设置1分钟后结束高频模式
    fastModeEndTime = Date.now() + 1 * 60 * 1000;
    
    // 清除之前的计时器
    if (fastModeTimer) clearTimeout(fastModeTimer);
    
    // 1分钟后停止动画
    fastModeTimer = setTimeout(() => {
        if (btn) btn.classList.remove('beating');
        showToast('⏱️ 加速模式已结束');
    }, 1 * 60 * 1000);
    
    // 立即获取一次
    await checkNewEmails();
}

// 页面关闭时停止轮询
window.addEventListener('beforeunload', () => {
    stopEmailPolling();
});

function updateNotifyBadge() {
    const unreadCount = verificationCodes.filter(c => !c.is_read).length;
    const badge = document.getElementById('notifyBadge');
    const mobileBadge = document.getElementById('mobileNotifyBadge');
    
    [badge, mobileBadge].forEach(b => {
        if (b) {
            if (unreadCount > 0) {
                b.textContent = unreadCount > 9 ? '9+' : unreadCount;
                b.style.display = 'flex';
            } else {
                b.style.display = 'none';
            }
        }
    });
}

async function copyCode(code) {
    const success = await copyToClipboard(code);
    if (success) {
        showToast('📋 验证码已复制');
    }
}

function markAllCodesRead() {
    verificationCodes.forEach(c => c.is_read = true);
    renderCodesList();
    updateNotifyBadge();
    // 可选：同步到服务器
    apiRequest('/emails/codes/read-all', { method: 'POST' }).catch(() => {});
}

// === 验证码弹窗 Toast ===
function showCodeToast(code) {
    if (!pushSettings.toast) return;
    
    const toast = document.getElementById('codeToast');
    document.getElementById('toastService').textContent = code.service || '验证码';
    document.getElementById('toastAccount').textContent = code.account_name || code.email;
    document.getElementById('toastCode').textContent = code.code;
    
    toast.classList.add('show');
    
    // 开始倒计时
    let remaining = code.expires_at ? Math.floor((new Date(code.expires_at) - new Date()) / 1000) : 300;
    updateToastTimer(remaining);
    
    if (codeToastTimer) clearInterval(codeToastTimer);
    codeToastTimer = setInterval(() => {
        remaining--;
        updateToastTimer(remaining);
        if (remaining <= 0) {
            clearInterval(codeToastTimer);
            closeCodeToast();
        }
    }, 1000);
    
    // 10秒后自动关闭
    setTimeout(() => {
        closeCodeToast();
    }, 10000);
}

function updateToastTimer(seconds) {
    const timer = document.getElementById('toastTimer');
    if (timer) {
        timer.textContent = `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
    }
}

function closeCodeToast() {
    const toast = document.getElementById('codeToast');
    if (toast) toast.classList.remove('show');
    if (codeToastTimer) {
        clearInterval(codeToastTimer);
        codeToastTimer = null;
    }
}

function copyToastCode() {
    const code = document.getElementById('toastCode').textContent;
    copyCode(code);
}

// === 智能轮询（根据页面可见性调整频率） ===

// setupVisibilityDetection: removed, visibilitychange no longer restarts polling

// 重启轮询（根据当前状态调整间隔）
function restartEmailPolling() {
    stopEmailPolling();
    if (authorizedEmails.length > 0) {
        startEmailPolling();
    }
}

// 已弹过 toast 的验证码（sessionStorage 持久化，刷新页面不重复弹）
const _toastedCodes = new Set(JSON.parse(sessionStorage.getItem('toasted_codes') || '[]'));
function _markToasted(key) {
    _toastedCodes.add(key);
    // 只保留最近 50 条防止膨胀
    const arr = [..._toastedCodes];
    if (arr.length > 50) { _toastedCodes.clear(); arr.slice(-30).forEach(k => _toastedCodes.add(k)); }
    sessionStorage.setItem('toasted_codes', JSON.stringify([..._toastedCodes]));
}

// 执行一次邮件检查（学注册机：直接从 refresh 响应解析码，内存去重）
async function checkNewEmails() {
    if (authorizedEmails.length === 0) return;

    try {
        const res = await apiRequest('/emails/refresh', {
            method: 'POST',
            body: JSON.stringify({})
        });
        if (!res.ok) return;

        const data = await res.json();
        const allCodes = data.new_codes || [];
        if (allCodes.length === 0) return;

        const now = new Date();
        const existingSet = new Set(verificationCodes.map(c => c.code + '|' + c.email));
        let hasNew = false;

        allCodes.forEach(code => {
            if (code.expires_at && new Date(code.expires_at) < now) return;

            const key = code.code + '|' + code.email;
            if (!existingSet.has(key)) {
                existingSet.add(key);
                verificationCodes.unshift(code);
                hasNew = true;

                // 只有从未弹过的码才弹 toast
                if (!_toastedCodes.has(key)) {
                    _markToasted(key);
                    if (pushSettings.notify) {
                        showToast(`📬 ${code.service || '验证码'}: ${code.code}`);
                    }
                    if (pushSettings.toast) {
                        showCodeToast(code);
                    }
                }
            }
        });

        if (hasNew) {
            verificationCodes = verificationCodes.slice(0, 15);
            renderCodesList();
            updateNotifyBadge();
        }
    } catch (err) {
        // 静默失败
    }
}

// 清理过期验证码
function cleanExpiredCodes() {
    const now = new Date();
    const beforeCount = verificationCodes.length;
    verificationCodes = verificationCodes.filter(code => {
        if (!code.expires_at) return true;
        return new Date(code.expires_at) > now;
    });
    
    if (verificationCodes.length !== beforeCount) {
        renderCodesList();
        updateNotifyBadge();
    }
}

function startEmailPolling() {
    if (emailPollingInterval) clearInterval(emailPollingInterval);
    
    // 立即执行一次
    checkNewEmails();
    
    // 使用动态间隔：每次执行后根据当前模式决定下次间隔
    function scheduleNext() {
        const interval = Date.now() < fastModeEndTime ? pollingIntervalFast : pollingInterval;
        
        emailPollingInterval = setTimeout(async () => {
            await checkNewEmails(); // checkNewEmails 现在已包含 DB 同步，不需要单独 cleanExpiredCodes
            scheduleNext();
        }, interval);
    }
    
    scheduleNext();
}

function stopEmailPolling() {
    if (emailPollingInterval) {
        clearTimeout(emailPollingInterval);
        emailPollingInterval = null;
    }
}

// === 更多菜单 (PC端和移动端) ===
function toggleMoreMenu() {
    const isMobile = window.innerWidth <= 768;
    
    if (isMobile) {
        // 移动端：显示底部面板
        const overlay = document.getElementById('mobileMenuOverlay');
        const panel = document.getElementById('mobileMenuPanel');
        overlay?.classList.toggle('show');
        panel?.classList.toggle('show');
    } else {
        // PC端：显示下拉菜单
        const menu = document.getElementById('moreMenu');
        menu?.classList.toggle('show');
    }
}

function closeMoreMenu() {
    // 关闭PC端菜单
    document.getElementById('moreMenu')?.classList.remove('show');
    // 关闭移动端面板
    document.getElementById('mobileMenuOverlay')?.classList.remove('show');
    document.getElementById('mobileMenuPanel')?.classList.remove('show');
}

// === 移动端搜索框切换 ===
function toggleMobileSearch() {
    const searchBar = document.getElementById('mobileSearchBar');
    const searchInput = document.getElementById('mobileSearchInput');
    
    if (searchBar) {
        searchBar.classList.toggle('show');
        if (searchBar.classList.contains('show')) {
            searchInput?.focus();
        } else {
            // 关闭时清空搜索
            if (searchInput) searchInput.value = '';
            filterAccounts();
        }
    }
}

// === 通知面板切换 ===
function toggleNotificationPanel(e) {
    e?.stopPropagation();
    const panel = document.getElementById('notificationPanel');
    if (!panel) return;
    
    // 先关闭其他面板
    document.getElementById('mobileMenuPanel')?.classList.remove('show');
    document.getElementById('mobileMenuOverlay')?.classList.remove('show');
    document.getElementById('mobileSearchBar')?.classList.remove('show');
    document.getElementById('moreMenu')?.classList.remove('show');
    
    panel.classList.toggle('show');
    
    if (panel.classList.contains('show')) {
        setTimeout(() => {
            document.addEventListener('click', closeNotificationPanelOnClickOutside);
        }, 10);
    } else {
        document.removeEventListener('click', closeNotificationPanelOnClickOutside);
    }
}

// 手机端和PC端共用同一个函数
function toggleMobileNotificationPanel(e) {
    toggleNotificationPanel(e);
}

function closeNotificationPanelOnClickOutside(e) {
    const panel = document.getElementById('notificationPanel');
    const btn = document.getElementById('notifyBtn');
    const mobileBtn = document.getElementById('mobileNotifyBtn');
    
    if (panel && !panel.contains(e.target) && !btn?.contains(e.target) && !mobileBtn?.contains(e.target)) {
        panel.classList.remove('show');
        document.removeEventListener('click', closeNotificationPanelOnClickOutside);
    }
}

// === 邮箱授权管理模态框 ===
function openEmailManager() {
    const modal = document.getElementById('emailManagerModal');
    if (modal) {
        modal.classList.add('show');
        renderAuthorizedEmails();
        renderPendingEmails();
    } else {
        showToast('📬 邮箱授权功能即将上线', false);
    }
}

function closeEmailManager() {
    document.getElementById('emailManagerModal')?.classList.remove('show');
}

function openAddEmailModal() {
    document.getElementById('addEmailModal')?.classList.add('show');
    // 重置状态：收起所有面板，清空输入
    document.querySelectorAll('.provider-item').forEach(item => {
        item.classList.remove('expanded');
    });
    // 清空所有输入框
    ['gmailClientId', 'gmailClientSecret', 'outlookClientId', 'outlookClientSecret',
     'qqEmail', 'qqPassword', 'imapEmail', 'imapServer', 'imapPassword',
     'cfWorkerDomain', 'cfEmailDomain', 'cfAdminPassword', 'cfEmailAddress'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const imapPort = document.getElementById('imapPort');
    if (imapPort) imapPort.value = '993';
    
    // 异步检查OAuth配置状态并自动填充
    checkAndUpdateOAuthStatus();
}

// 检查OAuth配置状态并更新UI（自动填充已保存的凭证）
async function checkAndUpdateOAuthStatus() {
    for (const provider of ['gmail', 'outlook']) {
        const configDiv = document.getElementById(`${provider}OauthConfig`);
        if (!configDiv) continue;
        
        try {
            const status = await checkOAuthConfig(provider);
            if (status.configured) {
                const providerName = provider === 'gmail' ? 'Gmail' : 'Outlook';
                
                // 统一显示已配置状态（无论来源是环境变量还是数据库）
                configDiv.innerHTML = `
                    <div class="oauth-configured-hint">
                        <span class="configured-icon">✅</span>
                        <span>OAuth 凭证已配置</span>
                        <button class="btn-reconfigure" onclick="showOAuthInputs('${provider}')">重新配置</button>
                        <button class="btn-help-small" onclick="showHelpModal('${provider}')" title="查看教程">❓</button>
                    </div>
                    <div class="oauth-next-step">
                        <span class="next-step-icon">👇</span>
                        <span>点击下方按钮授权你的 ${providerName} 邮箱，可授权多个</span>
                    </div>
                `;
            }
        } catch (e) {}
    }
}

// 显示OAuth输入框（重新配置时）
function showOAuthInputs(provider) {
    const configDiv = document.getElementById(`${provider}OauthConfig`);
    if (!configDiv) return;
    
    const placeholderText = provider === 'gmail' 
        ? '从 Google Cloud Console 获取' 
        : '从 Azure Portal 获取';
    
    const credentialsUrl = provider === 'gmail' 
        ? 'https://console.cloud.google.com/apis/credentials' 
        : 'https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade';
    
    configDiv.innerHTML = `
        <div class="form-group">
            <label class="form-label">Client ID</label>
            <input type="text" class="form-input" id="${provider}ClientId" placeholder="${placeholderText}">
        </div>
        <div class="form-group">
            <label class="form-label">Client Secret</label>
            <input type="password" class="form-input" id="${provider}ClientSecret" placeholder="${placeholderText}">
        </div>
        <div class="oauth-help-actions">
            <button type="button" class="btn-help" onclick="showHelpModal('${provider}')" title="查看详细教程">❓ 教程</button>
            <a href="${credentialsUrl}" target="_blank" class="btn-get-credentials">🔗 前往获取</a>
        </div>
    `;
}

function closeAddEmailModal() {
    document.getElementById('addEmailModal')?.classList.remove('show');
}

// 切换展开/收起provider面板
function toggleProviderPanel(provider) {
    const item = document.querySelector(`.provider-item[data-provider="${provider}"]`);
    if (!item) return;
    
    const isCurrentlyExpanded = item.classList.contains('expanded');
    
    // 收起所有面板
    document.querySelectorAll('.provider-item').forEach(i => {
        i.classList.remove('expanded');
    });
    
    // 如果当前不是展开状态，则展开
    if (!isCurrentlyExpanded) {
        item.classList.add('expanded');
    }
}

// 填充IMAP预设配置
function fillImapPreset(preset) {
    const serverInput = document.getElementById('imapServer');
    const portInput = document.getElementById('imapPort');
    
    const presets = {
        '163': { server: 'imap.163.com', port: 993 },
        '126': { server: 'imap.126.com', port: 993 },
        'sina': { server: 'imap.sina.com', port: 993 }
    };
    
    if (presets[preset] && serverInput && portInput) {
        serverInput.value = presets[preset].server;
        portInput.value = presets[preset].port;
    }
}

// 开始指定provider的授权
async function startProviderAuth(provider) {
    const btn = document.querySelector(`.provider-item[data-provider="${provider}"] .btn-provider-auth`);
    if (!btn) return;
    
    const originalText = btn.textContent;
    
    try {
        btn.disabled = true;
        btn.textContent = '⏳ 处理中...';
        
        if (provider === 'gmail' || provider === 'outlook') {
            const clientId = document.getElementById(`${provider}ClientId`)?.value.trim();
            const clientSecret = document.getElementById(`${provider}ClientSecret`)?.value.trim();
            
            if (clientId && clientSecret) {
                const saveRes = await apiRequest('/emails/oauth/config', {
                    method: 'POST',
                    body: JSON.stringify({
                        provider: provider,
                        client_id: clientId,
                        client_secret: clientSecret
                    })
                });
                
                if (!saveRes.ok) {
                    const errData = await saveRes.json();
                    showToast('❌ 保存凭证失败: ' + (errData.detail || '未知错误'), true);
                    return;
                }
                showToast('✅ OAuth 凭证已保存');
            }
            
            const res = await apiRequest('/emails/oauth/start', {
                method: 'POST',
                body: JSON.stringify({ provider: provider, origin: window.location.origin })
            });
            
            if (res.ok) {
                const data = await res.json();
                if (data.auth_url) {
                    window.open(data.auth_url, 'oauth', 'width=600,height=700');
                    showToast('🔗 请在弹出窗口中完成授权');
                    
                    const checkAuth = setInterval(async () => {
                        try {
                            const statusRes = await apiRequest('/emails/oauth/status?state=' + data.state);
                            if (statusRes.ok) {
                                const statusData = await statusRes.json();
                                if (statusData.status === 'success') {
                                    clearInterval(checkAuth);
                                    showToast('✅ 授权成功！');
                                    closeAddEmailModal();
                                    loadEmailData();
                                    renderAuthorizedEmails();
                                } else if (statusData.status === 'error') {
                                    clearInterval(checkAuth);
                                    showToast('❌ 授权失败: ' + (statusData.message || '未知错误'), true);
                                }
                            }
                        } catch (e) {}
                    }, 2000);
                    
                    setTimeout(() => clearInterval(checkAuth), 30000);
                } else {
                    showToast('❌ 无法获取授权链接', true);
                }
            } else {
                const errData = await res.json();
                showToast('❌ ' + (errData.detail || '授权启动失败'), true);
            }
        } else if (provider === 'qq') {
            const email = document.getElementById('qqEmail')?.value.trim();
            const password = document.getElementById('qqPassword')?.value;
            
            if (!email || !password) {
                showToast('请填写邮箱和授权码', true);
                return;
            }
            
            const res = await apiRequest('/emails/imap/add', {
                method: 'POST',
                body: JSON.stringify({ provider: 'qq', email: email, password: password })
            });
            
            if (res.ok) {
                showToast('✅ QQ邮箱添加成功！');
                closeAddEmailModal();
                loadEmailData();
                renderAuthorizedEmails();
            } else {
                const errData = await res.json();
                showToast('❌ ' + (errData.detail || '连接失败'), true);
            }
        } else if (provider === 'imap') {
            const email = document.getElementById('imapEmail')?.value.trim();
            const server = document.getElementById('imapServer')?.value.trim();
            const port = parseInt(document.getElementById('imapPort')?.value) || 993;
            const password = document.getElementById('imapPassword')?.value;
            
            if (!email || !server || !password) {
                showToast('请填写完整的IMAP配置', true);
                return;
            }
            
            const res = await apiRequest('/emails/imap/add', {
                method: 'POST',
                body: JSON.stringify({ provider: 'imap', email, server, port, password })
            });
            
            if (res.ok) {
                showToast('✅ 邮箱添加成功！');
                closeAddEmailModal();
                loadEmailData();
                renderAuthorizedEmails();
            } else {
                const errData = await res.json();
                showToast('❌ ' + (errData.detail || '连接失败'), true);
            }
        } else if (provider === 'cloudflare') {
            const workerDomain = document.getElementById('cfWorkerDomain')?.value.trim();
            const emailDomain = document.getElementById('cfEmailDomain')?.value.trim();
            const adminPassword = document.getElementById('cfAdminPassword')?.value;
            const emailAddress = document.getElementById('cfEmailAddress')?.value.trim();

            if (!workerDomain || !emailDomain || !adminPassword) {
                showToast('请填写 Worker 域名、邮箱域名和管理密码', true);
                return;
            }

            const res = await apiRequest('/emails/cloudflare/add', {
                method: 'POST',
                body: JSON.stringify({
                    worker_domain: workerDomain,
                    email_domain: emailDomain,
                    admin_password: adminPassword,
                    email_address: emailAddress || null
                })
            });

            if (res.ok) {
                const data = await res.json();
                showToast('✅ ' + (data.message || 'Cloudflare 邮箱添加成功'));
                closeAddEmailModal();
                loadEmailData();
                renderAuthorizedEmails();
            } else {
                const errData = await res.json();
                showToast('❌ ' + (errData.detail || '添加失败'), true);
            }
        }
    } catch (e) {
        console.error('邮箱授权错误:', e);
        showToast('❌ 网络错误', true);
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

// 兼容旧版selectProvider调用
async function selectProvider(provider) {
    toggleProviderPanel(provider);
}

// 检查OAuth是否已配置
async function checkOAuthConfig(provider) {
    try {
        const res = await apiRequest(`/emails/oauth/config-status?provider=${provider}`);
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {}
    return { configured: false };
}

// startEmailAuth: removed, replaced by startProviderAuth()

// 从待授权列表授权邮箱
function authorizeEmail(email) {
    // 自动填充邮箱地址并打开授权模态框
    openAddEmailModal();
    
    // 根据邮箱后缀自动展开对应面板
    setTimeout(() => {
        if (email.endsWith('@gmail.com')) {
            toggleProviderPanel('gmail');
        } else if (email.endsWith('@outlook.com') || email.endsWith('@hotmail.com') || email.endsWith('@live.com')) {
            toggleProviderPanel('outlook');
        } else if (email.endsWith('@qq.com')) {
            toggleProviderPanel('qq');
            const qqEmail = document.getElementById('qqEmail');
            if (qqEmail) qqEmail.value = email;
        } else {
            toggleProviderPanel('imap');
            const imapEmail = document.getElementById('imapEmail');
            if (imapEmail) imapEmail.value = email;
        }
    }, 100);
}

function togglePushSettingsPopup(event) {
    event?.stopPropagation();
    const popup = document.getElementById('pushSettingsPopup');
    if (popup) {
        popup.classList.toggle('show');
        
        // 点击外部关闭
        if (popup.classList.contains('show')) {
            setTimeout(() => {
                document.addEventListener('click', closePushSettingsOnClickOutside);
            }, 0);
        }
    }
}

function closePushSettingsOnClickOutside(e) {
    const popup = document.getElementById('pushSettingsPopup');
    const btn = document.querySelector('.btn-push-settings');
    if (popup && !popup.contains(e.target) && !btn?.contains(e.target)) {
        popup.classList.remove('show');
        document.removeEventListener('click', closePushSettingsOnClickOutside);
    }
}

function renderAuthorizedEmails() {
    const container = document.getElementById('authorizedEmailsList');
    if (!container) return;
    
    if (authorizedEmails.length === 0) {
        container.innerHTML = '<div class="emails-empty">暂无已授权邮箱</div>';
        return;
    }
    
    container.innerHTML = authorizedEmails.map(email => `
        <div class="email-item">
            <div class="email-item-icon ${email.provider || 'imap'}">📧</div>
            <div class="email-item-info">
                <div class="email-item-address copyable" onclick="navigator.clipboard.writeText('${escapeAttr(email.address)}').then(()=>showToast('邮箱已复制'))" title="点击复制">${escapeHtml(email.address)}</div>
                <div class="email-item-status">
                    <span class="dot ${email.status || 'active'}"></span>
                    ${email.status === 'error' ? '连接失败' : '已连接'}
                </div>
            </div>
            <div class="email-item-actions">
                <button class="btn-email-action danger" onclick="removeEmail('${email.id}')">移除</button>
            </div>
        </div>
    `).join('');
}

async function removeEmail(emailId) {
    if (!confirm('确定要移除这个授权邮箱吗？')) return;
    try {
        const res = await apiRequest(`/emails/${emailId}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('已移除');
            authorizedEmails = authorizedEmails.filter(e => String(e.id) !== String(emailId));
            renderAuthorizedEmails();
        } else {
            showToast('移除失败', true);
        }
    } catch (e) {
        showToast('网络错误', true);
    }
}

function renderPendingEmails() {
    const container = document.getElementById('pendingEmailsList');
    if (!container) return;
    
    if (pendingEmails.length === 0) {
        container.innerHTML = '<div class="emails-empty">暂无待授权邮箱</div>';
        return;
    }
    
    container.innerHTML = pendingEmails.map(email => `
        <div class="email-item">
            <div class="email-item-icon">📨</div>
            <div class="email-item-info">
                <div class="email-item-address">${escapeHtml(email)}</div>
                <div class="email-item-status">
                    <span class="dot pending"></span>
                    待授权
                </div>
            </div>
            <div class="email-item-actions">
                <button class="btn-email-auth" onclick="authorizeEmail('${escapeHtml(email)}')">授权</button>
            </div>
        </div>
    `).join('');
}

// 点击外部关闭更多菜单
document.addEventListener('click', (e) => {
    const moreBtn = document.getElementById('moreBtn');
    const moreMenu = document.getElementById('moreMenu');
    if (moreMenu?.classList.contains('show') && 
        !moreBtn?.contains(e.target) && 
        !moreMenu?.contains(e.target)) {
        closeMoreMenu();
    }
});

// === 辅助邮箱展示/切换 ===

function showBackupEmailDisplay(emailAddr) {
    const display = document.getElementById('backupEmailDisplay');
    const inputWrapper = document.getElementById('backupEmailInputWrapper');
    const addrEl = document.getElementById('backupEmailAddr');
    const statusEl = document.getElementById('backupEmailStatus');
    if (!display || !inputWrapper) return;

    addrEl.textContent = emailAddr;
    // 检查是否已授权
    const isAuthorized = authorizedEmails.some(e => e.address?.toLowerCase() === emailAddr.toLowerCase());
    statusEl.textContent = isAuthorized ? '✅ 已授权' : '';
    statusEl.className = 'backup-email-status' + (isAuthorized ? ' authorized' : '');

    display.style.display = '';
    inputWrapper.style.display = 'none';
}

function showBackupEmailInput() {
    const display = document.getElementById('backupEmailDisplay');
    const inputWrapper = document.getElementById('backupEmailInputWrapper');
    if (display) display.style.display = 'none';
    if (inputWrapper) inputWrapper.style.display = '';
}

function switchToBackupEmailInput() {
    showBackupEmailInput();
    const input = document.getElementById('accBackupEmail');
    if (input) input.focus();
}

function copyBackupEmail() {
    const addrEl = document.getElementById('backupEmailAddr');
    if (!addrEl) return;
    navigator.clipboard.writeText(addrEl.textContent).then(() => showToast('辅助邮箱已复制'));
}

// === 辅助邮箱自动联想功能 ===

// 获取所有可用的辅助邮箱建议（已授权 + 历史使用）
function getBackupEmailSuggestions() {
    const suggestions = [];
    const seen = new Set();
    
    // 1. 已授权的邮箱（优先显示）
    authorizedEmails.forEach(email => {
        const addr = email.address?.toLowerCase();
        if (addr && !seen.has(addr)) {
            suggestions.push({ email: email.address, type: 'authorized', provider: email.provider });
            seen.add(addr);
        }
    });
    
    // 2. 待授权的邮箱
    pendingEmails.forEach(email => {
        const addr = email?.toLowerCase();
        if (addr && !seen.has(addr)) {
            suggestions.push({ email: email, type: 'pending' });
            seen.add(addr);
        }
    });
    
    // 3. 从现有账号中收集辅助邮箱
    accounts.forEach(acc => {
        if (acc.backup_email) {
            const addr = acc.backup_email.toLowerCase();
            if (!seen.has(addr)) {
                suggestions.push({ email: acc.backup_email, type: 'history' });
                seen.add(addr);
            }
        }
    });
    
    return suggestions;
}

// 辅助邮箱输入事件处理
function onBackupEmailInput(input) {
    showBackupEmailSuggestions(input);
}

function onBackupEmailFocus(input) {
    showBackupEmailSuggestions(input);
}

function showBackupEmailSuggestions(input) {
    const value = input.value.trim().toLowerCase();
    const suggestionsEl = document.getElementById('backupEmailSuggestions');

    if (!suggestionsEl) return;

    const allSuggestions = getBackupEmailSuggestions();
    if (allSuggestions.length === 0) {
        suggestionsEl.classList.remove('show');
        suggestionsEl.innerHTML = '';
        return;
    }

    // 无输入时显示全部，有输入时过滤匹配
    const filtered = value
        ? allSuggestions.filter(s => s.email.toLowerCase().includes(value)).slice(0, 8)
        : allSuggestions.slice(0, 8);
    
    if (filtered.length === 0) {
        suggestionsEl.classList.remove('show');
        suggestionsEl.innerHTML = '';
        return;
    }
    
    // 渲染建议列表
    suggestionsEl.innerHTML = filtered.map(s => {
        let icon = '📧';
        let hint = '';
        let className = 'suggestion-email';
        
        if (s.type === 'authorized') {
            icon = '✅';
            hint = '已授权';
            className += ' authorized';
        } else if (s.type === 'pending') {
            icon = '⏳';
            hint = '待授权';
            className += ' pending';
        } else {
            icon = '📝';
            hint = '历史';
            className += ' history';
        }
        
        return `
            <div class="${className}" onclick="selectBackupEmailSuggestion('${escapeHtml(s.email)}')">
                <span class="suggestion-icon">${icon}</span>
                <span class="suggestion-text">${escapeHtml(s.email)}</span>
                <span class="suggestion-hint">${hint}</span>
            </div>
        `;
    }).join('');
    
    suggestionsEl.classList.add('show');
}

// 选择辅助邮箱建议
function selectBackupEmailSuggestion(email) {
    const input = document.getElementById('accBackupEmail');
    const suggestionsEl = document.getElementById('backupEmailSuggestions');
    
    if (input) {
        input.value = email;
        input.focus();
    }
    
    if (suggestionsEl) {
        suggestionsEl.classList.remove('show');
        suggestionsEl.innerHTML = '';
    }
}

// 点击外部关闭辅助邮箱建议
document.addEventListener('click', (e) => {
    const wrapper = e.target.closest('.backup-email-wrapper');
    const suggestionsEl = document.getElementById('backupEmailSuggestions');
    
    if (!wrapper && suggestionsEl) {
        suggestionsEl.classList.remove('show');
    }
});

// collectPendingEmails: removed, now manual-only

async function pullPendingEmails() {
    try {
        const res = await apiRequest('/emails/pending/pull', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast(`拉取完成，新增 ${data.added} 个`);
            await loadEmailData();
            renderPendingEmails();
        }
    } catch (err) {
        showToast('拉取失败: ' + err.message, true);
    }
}

async function clearPendingEmails() {
    if (!confirm('确定清空所有待授权邮箱？')) return;
    try {
        const res = await apiRequest('/emails/pending', { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            pendingEmails = [];
            renderPendingEmails();
            showToast('已清空');
        }
    } catch (err) {
        showToast('清空失败: ' + err.message, true);
    }
}

// 同步待授权邮箱到后端
async function syncPendingEmails() {
    try {
        await apiRequest('/emails/pending', {
            method: 'POST',
            body: JSON.stringify({ emails: pendingEmails })
        });
    } catch (err) {
        console.log('同步待授权邮箱失败:', err.message);
    }
}

// === 邮箱数据加载 ===
async function loadEmailData() {
    try {
        const res = await apiRequest('/emails');
        if (res.ok) {
            const data = await res.json();
            authorizedEmails = data.authorized || [];
            pendingEmails = data.pending || [];
            
            // 更新邮箱计数提示
            const countHint = document.getElementById('emailCountHint');
            const mobileCountHint = document.getElementById('mobileEmailBadge');
            
            if (authorizedEmails.length > 0) {
                if (countHint) countHint.textContent = `${authorizedEmails.length} 个`;
                if (mobileCountHint) {
                    mobileCountHint.textContent = authorizedEmails.length;
                    mobileCountHint.style.display = 'inline-flex';
                }
            } else {
                if (countHint) countHint.textContent = '未启用';
                if (mobileCountHint) mobileCountHint.style.display = 'none';
            }
            
            // collectPendingEmails removed, now manual-only
        }
    } catch (err) {
        console.log('邮箱数据加载失败（可能未启用此功能）:', err.message);
        // 静默失败，功能未启用时不显示错误
    }
}

async function loadVerificationCodes() {
    try {
        const res = await apiRequest('/emails/codes');
        if (res.ok) {
            const data = await res.json();
            verificationCodes = data.codes || [];
            renderCodesList();
            updateNotifyBadge();
        }
    } catch (err) {
        console.log('验证码加载失败（可能未启用此功能）:', err.message);
        // 静默失败
    }
}

function renderCodesList() {
    const container = document.getElementById('codesPanelBody');
    if (!container) return;
    
    if (verificationCodes.length === 0) {
        container.innerHTML = '<div class="codes-empty">暂无验证码</div>';
        return;
    }
    
    const html = verificationCodes.map(code => {
        const isExpired = code.expires_at && new Date(code.expires_at) < new Date();
        const remaining = code.expires_at ? Math.max(0, Math.floor((new Date(code.expires_at) - new Date()) / 1000)) : 300;
        const timerClass = remaining < 60 ? 'danger' : remaining < 180 ? 'warning' : '';
        const timerText = `${Math.floor(remaining / 60)}:${(remaining % 60).toString().padStart(2, '0')}`;
        
        return `
            <div class="code-item ${isExpired ? 'expired' : ''} ${code.is_read ? '' : 'unread'}" onclick="copyCode('${escapeHtml(code.code)}')">
                <div class="code-item-header">
                    <span class="code-service">${escapeHtml(code.service || '验证码')}</span>
                    ${!isExpired ? `<span class="code-timer ${timerClass}">${timerText}</span>` : ''}
                </div>
                <div class="code-value-row">
                    <span class="code-value">${escapeHtml(code.code)}</span>
                    ${isExpired ? '<span class="code-expired-tag">已过期</span>' : ''}
                </div>
                <div class="code-account">${escapeHtml(code.account_name || code.email || '')}</div>
            </div>
        `;
    }).join('');
    
    container.innerHTML = html;
}

// === 初始化 ===
// 在用户登录后调用
async function initEmailFeature() {
    await loadEmailData();      // 等待邮箱数据加载完成
    await loadVerificationCodes(); // 必须 await，防止跟首次 poll 竞态
    startEmailPolling();
}

// 页面卸载时停止轮询
window.addEventListener('beforeunload', stopEmailPolling);

// ============================================
// 邮箱配置帮助教程
// ============================================

const helpContents = {
    gmail: {
        title: 'Gmail OAuth 配置教程',
        content: `
            <div class="help-section">
                <div class="help-step">
                    <div class="help-step-num">1</div>
                    <div class="help-step-content">
                        <div class="help-step-title">打开 Google Cloud Console</div>
                        <div class="help-step-desc">
                            访问 <a href="https://console.cloud.google.com/" target="_blank">console.cloud.google.com</a>，使用你的 Google 账号登录
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">2</div>
                    <div class="help-step-content">
                        <div class="help-step-title">创建新项目</div>
                        <div class="help-step-desc">
                            点击顶部的项目选择器 → <strong>新建项目</strong> → 输入项目名称（如 "AccBox"）→ 点击<strong>创建</strong>
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">3</div>
                    <div class="help-step-content">
                        <div class="help-step-title">启用 Gmail API</div>
                        <div class="help-step-desc">
                            左侧菜单选择 <strong>API和服务</strong> → <strong>库</strong> → 搜索 "Gmail API" → 点击进入 → 点击<strong>启用</strong>
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">4</div>
                    <div class="help-step-content">
                        <div class="help-step-title">配置 OAuth 权限请求页面</div>
                        <div class="help-step-desc">
                            左侧菜单 → <strong>OAuth 权限请求页面</strong> → 选择<strong>外部</strong> → 填写应用名称 → 填写用户支持邮箱 → 填写开发者邮箱 → 点击<strong>保存并继续</strong>（作用域页面直接跳过）
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">5</div>
                    <div class="help-step-content">
                        <div class="help-step-title">添加测试用户</div>
                        <div class="help-step-desc">
                            左侧菜单 → <strong>OAuth 权限请求页面</strong> → 下拉选择<strong>目标对象</strong> → 在测试用户下点击<strong>+ ADD USERS</strong> → 输入你要授权的 Gmail 地址 → 保存
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">6</div>
                    <div class="help-step-content">
                        <div class="help-step-title">创建 OAuth 凭证</div>
                        <div class="help-step-desc">
                            左侧菜单 → <strong>凭据</strong> → 点击顶部<strong>+ 创建凭据</strong> → 选择 <strong>OAuth 客户端 ID</strong> → 应用类型选<strong>Web 应用</strong> → 输入名称
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">7</div>
                    <div class="help-step-content">
                        <div class="help-step-title">添加重定向 URI</div>
                        <div class="help-step-desc">
                            在"已授权的重定向 URI"处点击<strong>添加 URI</strong>，填入你的回调地址：
                            <div class="help-copy-box">
                                <code id="gmailRedirectUri">http://你的域名:9111/api/emails/oauth/callback</code>
                                <button class="btn btn-copy" onclick="copyHelpText('gmailRedirectUri')">复制</button>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">8</div>
                    <div class="help-step-content">
                        <div class="help-step-title">复制凭证</div>
                        <div class="help-step-desc">
                            点击<strong>创建</strong>后会弹出窗口，复制 <strong>Client ID</strong> 和 <strong>Client Secret</strong>，粘贴到上方输入框
                        </div>
                    </div>
                </div>
                
            </div>
        `
    },
    
    outlook: {
        title: 'Outlook OAuth 配置教程',
        content: `
            <div class="help-section">
                <div class="help-step">
                    <div class="help-step-num">1</div>
                    <div class="help-step-content">
                        <div class="help-step-title">打开 Azure 门户</div>
                        <div class="help-step-desc">
                            访问 <a href="https://portal.azure.com/" target="_blank">portal.azure.com</a>，使用你的 Microsoft 账号登录
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">2</div>
                    <div class="help-step-content">
                        <div class="help-step-title">进入应用注册</div>
                        <div class="help-step-desc">
                            搜索并进入 <strong>Microsoft Entra ID</strong>（原 Azure AD）→ 左侧菜单选择<strong>应用注册</strong> → 点击<strong>+ 新注册</strong>
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">3</div>
                    <div class="help-step-content">
                        <div class="help-step-title">注册应用</div>
                        <div class="help-step-desc">
                            输入应用名称（如 "AccBox"）→ 账户类型选<strong>任何组织目录中的账户和个人 Microsoft 账户</strong> → 重定向 URI 类型选 <strong>Web</strong>，填入：
                            <div class="help-copy-box">
                                <code id="outlookRedirectUri">http://你的域名:9111/api/emails/oauth/callback</code>
                                <button class="btn btn-copy" onclick="copyHelpText('outlookRedirectUri')">复制</button>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">4</div>
                    <div class="help-step-content">
                        <div class="help-step-title">复制 Client ID</div>
                        <div class="help-step-desc">
                            点击<strong>注册</strong>后，在概述页面复制<strong>应用程序(客户端) ID</strong>，这就是 Client ID
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">5</div>
                    <div class="help-step-content">
                        <div class="help-step-title">创建 Client Secret</div>
                        <div class="help-step-desc">
                            左侧菜单 → <strong>证书和密码</strong> → <strong>客户端密码</strong>标签 → 点击<strong>+ 新客户端密码</strong> → 输入描述 → 选择有效期 → 点击<strong>添加</strong>
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">6</div>
                    <div class="help-step-content">
                        <div class="help-step-title">复制 Secret 值</div>
                        <div class="help-step-desc">
                            <strong>立即复制</strong>"值"列的内容（不是"密码 ID"），这就是 Client Secret。离开页面后无法再查看！
                        </div>
                    </div>
                </div>
                
                <div class="help-warning">
                    <div class="help-warning-title">⚠️ 重要</div>
                    <div class="help-warning-content">
                        Client Secret 只显示一次，创建后必须立即复制保存。如果忘记了只能重新创建一个新的。
                    </div>
                </div>
            </div>
        `
    },
    
    qq: {
        title: 'QQ邮箱授权码获取教程',
        content: `
            <div class="help-section">
                <div class="help-step">
                    <div class="help-step-num">1</div>
                    <div class="help-step-content">
                        <div class="help-step-title">登录 QQ 邮箱</div>
                        <div class="help-step-desc">
                            访问 <a href="https://mail.qq.com" target="_blank">mail.qq.com</a>，使用 QQ 账号登录网页版邮箱
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">2</div>
                    <div class="help-step-content">
                        <div class="help-step-title">进入设置</div>
                        <div class="help-step-desc">
                            点击页面顶部的<strong>设置</strong> → 选择<strong>账户</strong>标签页
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">3</div>
                    <div class="help-step-content">
                        <div class="help-step-title">开启 IMAP 服务</div>
                        <div class="help-step-desc">
                            向下滚动找到 <strong>POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV服务</strong> → 开启 <strong>IMAP/SMTP服务</strong>
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">4</div>
                    <div class="help-step-content">
                        <div class="help-step-title">验证身份</div>
                        <div class="help-step-desc">
                            按照提示用手机 QQ 扫码或发送短信验证身份
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">5</div>
                    <div class="help-step-content">
                        <div class="help-step-title">获取授权码</div>
                        <div class="help-step-desc">
                            验证成功后会显示一个 <strong>16位授权码</strong>，复制并填入上方"授权码"输入框
                        </div>
                    </div>
                </div>
                
                <div class="help-tip">
                    <div class="help-tip-title">💡 提示</div>
                    <div class="help-tip-content">
                        授权码不是你的 QQ 密码，是专门用于第三方客户端登录的独立密码。每次生成的授权码都不同，可以随时生成新的或撤销旧的。
                    </div>
                </div>
            </div>
        `
    },
    
    cloudflare: {
        title: 'Cloudflare Worker 邮箱配置教程',
        content: `
            <div class="help-section">
                <div class="help-step">
                    <div class="help-step-num">1</div>
                    <div class="help-step-content">
                        <div class="help-step-title">前提条件</div>
                        <div class="help-step-desc">
                            一个域名，NS 已指向 Cloudflare（域名状态显示「活动」）
                        </div>
                    </div>
                </div>

                <div class="help-step">
                    <div class="help-step-num">2</div>
                    <div class="help-step-content">
                        <div class="help-step-title">开启 Email Routing</div>
                        <div class="help-step-desc">
                            Cloudflare Dashboard → 你的域名 → 左侧 <strong>Email → Email Routing</strong> → 点击 Get started 启用。CF 会自动添加 MX 和 SPF 记录。
                        </div>
                    </div>
                </div>

                <div class="help-step">
                    <div class="help-step-num">3</div>
                    <div class="help-step-content">
                        <div class="help-step-title">创建 KV 命名空间</div>
                        <div class="help-step-desc">
                            左侧菜单 构建 → 存储和数据库 <strong>Workers KV</strong> → Create Instance → 名称填 <code>KV</code>
                        </div>
                    </div>
                </div>

                <div class="help-step">
                    <div class="help-step-num">4</div>
                    <div class="help-step-content">
                        <div class="help-step-title">创建Email Worker 并部署代码</div>
                        <div class="help-step-desc">
                            Email Routing → 你的域名 → Destination Workers → Create Worker → Create my own → 部署后点击...选择「编辑代码」→ 全选删除 → 粘贴以下代码并点击 部署 ：
                            <div class="help-copy-box" style="margin-top:8px">
                                <pre id="cfWorkerCode" style="white-space:pre-wrap;font-size:12px;max-height:300px;overflow-y:auto;margin:0">export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const PASS = env.ADMIN_PASSWORD || "";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-auth",
        },
      });
    }

    const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", message: "Email Worker is running" }), { headers: cors });
    }

    if (url.pathname === "/admin/new_address" && request.method === "POST") {
      if ((request.headers.get("x-admin-auth") || "") !== PASS) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors });
      }
      const body = await request.json();
      if (!body.name || !body.domain) {
        return new Response(JSON.stringify({ error: "Missing name or domain" }), { status: 400, headers: cors });
      }
      const address = body.name + "@" + body.domain;
      const token = btoa(JSON.stringify({ address, created: Date.now(), secret: PASS }));
      await env.KV.put("addr:" + address, JSON.stringify({ address, created: Date.now(), mails: [] }), { expirationTtl: 3600 });
      return new Response(JSON.stringify({ address, jwt: token }), { headers: cors });
    }

    if (url.pathname === "/api/mails" && request.method === "GET") {
      let address = "";
      try {
        const token = (request.headers.get("Authorization") || "").replace("Bearer ", "");
        const decoded = JSON.parse(atob(token));
        if (decoded.secret !== PASS) throw new Error();
        address = decoded.address;
      } catch { return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401, headers: cors }); }
      const data = await env.KV.get("addr:" + address, "json");
      return new Response(JSON.stringify({ results: data ? data.mails || [] : [] }), { headers: cors });
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: cors });
  },

  async email(message, env) {
    const to = message.to;
    let rawBody = "";
    try {
      const reader = message.raw.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        rawBody += decoder.decode(value, { stream: true });
      }
    } catch (e) { rawBody = "Error: " + e.message; }

    const key = "addr:" + to;
    let data = await env.KV.get(key, "json");
    if (!data) data = { address: to, created: Date.now(), mails: [] };
    data.mails.push({
      id: "mail_" + Date.now(),
      source: message.from,
      subject: message.headers.get("subject") || "",
      raw: rawBody,
      received_at: new Date().toISOString(),
    });
    await env.KV.put(key, JSON.stringify(data), { expirationTtl: 3600 });
  },
};</pre>
                                <button class="btn btn-copy" onclick="copyHelpText('cfWorkerCode')">复制代码</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="help-step">
                    <div class="help-step-num">5</div>
                    <div class="help-step-content">
                        <div class="help-step-title">Worker 设置</div>
                        <div class="help-step-desc">
                            <strong>绑定 KV：</strong>Workers 和 Pages → 点击你的woker 绑定 → KV命名空间 → 添加绑定 → 变量名称 填 <code>KV</code>（全大写）KV命名空间选你创建好的KV<br><br>
                            <strong>启用域：</strong>Workers 和 Pages → 点击你的woker → 设置 → 域和路由 → workers.dev 点选...启用<br><br>
                            <strong>设置密码：</strong>Workers 和 Pages → 点击你的woker 设置 → 变量和机密 → 添加 → 类型 文本 变量名称 <code>ADMIN_PASSWORD</code> → 值填你的管理密码
                            
                        </div>
                    </div>
                </div>

                <div class="help-step">
                    <div class="help-step-num">6</div>
                    <div class="help-step-content">
                        <div class="help-step-title">配置 Catch-All</div>
                        <div class="help-step-desc">
                            电子邮件路由 → 你的域名 → <strong>Routing rules</strong> →  ...编辑 → Action 选 <strong>Send to a Worker</strong> → 选你的 Worker → Save → Status 打开变Active
                        </div>
                    </div>
                </div>

                <div class="help-step">
                    <div class="help-step-num">7</div>
                    <div class="help-step-content">
                        <div class="help-step-title">回到 AccBox 填写配置</div>
                        <div class="help-step-desc">
                            <ul style="margin:4px 0 0 20px;color:var(--text-secondary)">
                                <li><strong>Worker 域名：</strong>你的 Worker 地址，如 <code>my-worker.username.workers.dev</code>（不带 https://）</li>
                                <li><strong>邮箱域名：</strong>你的裸域名，如 <code>example.com</code></li>
                                <li><strong>管理密码：</strong>上一步设置的 ADMIN_PASSWORD</li>
                                <li><strong>邮箱地址：</strong>留空则自动创建随机邮箱</li>
                            </ul>
                        </div>
                    </div>
                </div>

                <div class="help-tip">
                    <div class="help-tip-title">💡 提示</div>
                    <div class="help-tip-content">
                        Worker 是通用的，一个 Worker 可以服务多个域名。换域名时只需在 Cloudflare 配置新域名的 Email Routing 和 Catch-All，Worker 代码不用改。
                    </div>
                </div>
            </div>
        `
    },

    imap: {
        title: '通用 IMAP 配置说明',
        content: `
            <div class="help-section">
                <div class="help-step">
                    <div class="help-step-num">1</div>
                    <div class="help-step-content">
                        <div class="help-step-title">确认邮箱支持 IMAP</div>
                        <div class="help-step-desc">
                            登录你的邮箱网页版，在设置中确认已开启 IMAP 服务。大部分邮箱默认开启，但有些需要手动启用。
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">2</div>
                    <div class="help-step-content">
                        <div class="help-step-title">获取 IMAP 服务器地址</div>
                        <div class="help-step-desc">
                            常见邮箱的 IMAP 服务器地址：
                            <ul style="margin: 8px 0 0 20px; color: var(--text-secondary);">
                                <li>163邮箱：<code>imap.163.com</code></li>
                                <li>126邮箱：<code>imap.126.com</code></li>
                                <li>新浪邮箱：<code>imap.sina.com</code></li>
                                <li>阿里企业邮箱：<code>imap.qiye.aliyun.com</code></li>
                            </ul>
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">3</div>
                    <div class="help-step-content">
                        <div class="help-step-title">获取密码或授权码</div>
                        <div class="help-step-desc">
                            部分邮箱（如163、126）需要在邮箱设置中单独开启 IMAP 并生成<strong>客户端授权码</strong>，用授权码代替邮箱密码登录。
                        </div>
                    </div>
                </div>
                
                <div class="help-step">
                    <div class="help-step-num">4</div>
                    <div class="help-step-content">
                        <div class="help-step-title">填写配置</div>
                        <div class="help-step-desc">
                            在上方填入邮箱地址、IMAP服务器地址、端口（默认993）、密码或授权码，点击验证连接。
                        </div>
                    </div>
                </div>
                
                <div class="help-tip">
                    <div class="help-tip-title">💡 快速配置</div>
                    <div class="help-tip-content">
                        点击上方的 <strong>163</strong>、<strong>126</strong>、<strong>新浪</strong> 按钮可以自动填入对应的服务器地址和端口。
                    </div>
                </div>
            </div>
        `
    }
};

function showHelpModal(provider) {
    const modal = document.getElementById('helpModal');
    const title = document.getElementById('helpModalTitle');
    const content = document.getElementById('helpModalContent');
    
    const help = helpContents[provider];
    if (!help) return;
    
    title.textContent = help.title;
    content.innerHTML = help.content;
    
    // 替换回调地址中的域名为实际地址
    const currentHost = window.location.origin;
    const redirectUri = `${currentHost}/api/emails/oauth/callback`;
    
    const gmailUri = document.getElementById('gmailRedirectUri');
    const outlookUri = document.getElementById('outlookRedirectUri');
    
    if (gmailUri) gmailUri.textContent = redirectUri;
    if (outlookUri) outlookUri.textContent = redirectUri;
    
    modal.classList.add('show');
}

function closeHelpModal() {
    document.getElementById('helpModal')?.classList.remove('show');
}

function copyHelpText(elementId) {
    const element = document.getElementById(elementId);
    if (!element) return;
    
    const text = element.textContent;
    navigator.clipboard.writeText(text).then(() => {
        showToast('✅ 已复制');
    }).catch(() => {
        // 降级方案
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showToast('✅ 已复制');
    });
}

// 点击弹窗外部关闭
document.addEventListener('click', function(e) {
    const helpModal = document.getElementById('helpModal');
    if (e.target === helpModal) {
        closeHelpModal();
    }
});

// ==================== Timer Functions ====================

function renderTimers(acc) {
    const timers = acc.timers ? (typeof acc.timers === 'string' ? JSON.parse(acc.timers) : acc.timers) : [];
    if (!timers.length) return '';
    const now = Math.floor(Date.now() / 1000);
    const parts = timers.map(t => {
        const remaining = t.expires_at - now;
        const targetMs = t.expires_at * 1000;
        if (remaining <= 0) {
            return `<span class="meta-timer done" data-target="${targetMs}"><span class="t-label">${t.label || ''}</span> <span class="t-icon">⏱️</span> <span class="t-time">0m</span></span>`;
        }
        return `<span class="meta-timer" data-target="${targetMs}">${t.label ? `<span class="t-label">${t.label}</span> ` : ''}<span class="t-icon">⏱️</span> <span class="t-time">${formatDuration(remaining)}</span></span>`;
    });
    return `<div class="meta-timers">${parts.join('')}</div>`;
}

function formatDuration(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return h > 0 ? d + 'd' + h + 'h' : d + 'd';
    if (h > 0) return m > 0 ? h + 'h' + m + 'm' : h + 'h';
    return m + 'm';
}

function parseDuration(str) {
    const match = str.match(/(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?/);
    if (!match || (!match[1] && !match[2] && !match[3])) return null;
    return (parseInt(match[1] || 0) * 86400) + (parseInt(match[2] || 0) * 3600) + (parseInt(match[3] || 0) * 60);
}

// Timer modal state
let timerTargetAccountId = null;
let timerBatchMode = false;

function openSingleTimerDialog(accountId) {
    timerTargetAccountId = accountId;
    timerBatchMode = false;
    document.getElementById('timerModalTitle').textContent = '添加定时';
    document.getElementById('timerLabel').value = '';
    document.getElementById('timerDuration').value = '';
    document.getElementById('timerModal').classList.add('show');
}

function openBatchTimerDialog() {
    if (selectedAccounts.size === 0) { showToast('请先选择账号'); return; }
    timerBatchMode = true;
    document.getElementById('timerModalTitle').textContent = '批量定时 (' + selectedAccounts.size + '个)';
    document.getElementById('timerLabel').value = '';
    document.getElementById('timerDuration').value = '';
    document.getElementById('timerModal').classList.add('show');
}

function closeTimerModal() {
    document.getElementById('timerModal').classList.remove('show');
}

async function submitTimer() {
    const label = document.getElementById('timerLabel').value.trim();
    const durationStr = document.getElementById('timerDuration').value.trim();
    if (!durationStr) { showToast('请输入时长'); return; }
    const duration = parseDuration(durationStr);
    if (!duration) { showToast('时长格式错误'); return; }

    if (timerBatchMode) {
        await apiRequest('/batch-timers', {
            method: 'POST',
            body: JSON.stringify({ account_ids: [...selectedAccounts], label, duration: durationStr })
        });
    } else {
        const acc = accounts.find(a => a.id === timerTargetAccountId);
        if (!acc) return;
        const timers = acc.timers ? (typeof acc.timers === 'string' ? JSON.parse(acc.timers) : acc.timers) : [];
        timers.push({ label, expires_at: Math.floor(Date.now() / 1000) + duration });
        await apiRequest('/accounts/' + timerTargetAccountId, {
            method: 'PUT',
            body: JSON.stringify({ timers: timers })
        });
        // 就地更新内存数据，不重载
        acc.timers = timers;
    }
    closeTimerModal();
    renderCards();
    showToast('定时已添加');
}

// Dismiss done timers on card click
function dismissDoneTimers(card) {
    const doneTimers = card.querySelectorAll('.meta-timer.done');
    if (!doneTimers.length) return;
    doneTimers.forEach(t => {
        t.classList.add('flash-out');
        t.addEventListener('animationend', () => t.remove());
    });
    // Also remove from backend
    const accId = parseInt(card.dataset.id);
    const acc = accounts.find(a => a.id === accId);
    if (acc) {
        const timers = acc.timers ? (typeof acc.timers === 'string' ? JSON.parse(acc.timers) : acc.timers) : [];
        const now = Math.floor(Date.now() / 1000);
        const active = timers.filter(t => t.expires_at > now);
        if (active.length !== timers.length) {
            apiRequest('/accounts/' + accId, {
                method: 'PUT',
                body: JSON.stringify({ timers: active })
            });
            acc.timers = active;
        }
    }
}

// Timer countdown refresh - only update timer text, don't re-render entire card list
setInterval(() => {
    const timerEls = document.querySelectorAll('.meta-timer:not(.done)');
    if (!timerEls.length) return;

    timerEls.forEach(el => {
        const target = parseInt(el.dataset.target);
        if (!target) return;
        const remaining = Math.max(0, target - Date.now());
        const mins = Math.floor(remaining / 60000);
        const timeEl = el.querySelector('.t-time');
        if (timeEl) {
            if (remaining <= 0) {
                timeEl.textContent = '0m';
                el.classList.add('done');
            } else if (mins >= 60) {
                timeEl.textContent = Math.floor(mins / 60) + 'h' + (mins % 60) + 'm';
            } else {
                timeEl.textContent = mins + 'm';
            }
        }
    });
}, 60000);
