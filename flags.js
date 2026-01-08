// 国家代码到国旗的映射
// 使用 Twemoji CDN 的 SVG 图片，保证全平台显示

const COUNTRY_DATA = {
    'US': { name: 'US', code: '1f1fa-1f1f8' },
    'JP': { name: 'JP', code: '1f1ef-1f1f5' },
    'TW': { name: '台湾', code: '1f1f9-1f1fc' },
    'HK': { name: 'HK', code: '1f1ed-1f1f0' },
    'SG': { name: 'SG', code: '1f1f8-1f1ec' },
    'KR': { name: 'KR', code: '1f1f0-1f1f7' },
    'GB': { name: 'GB', code: '1f1ec-1f1e7' },
    'DE': { name: 'DE', code: '1f1e9-1f1ea' },
    'FR': { name: 'FR', code: '1f1eb-1f1f7' },
    'AU': { name: 'AU', code: '1f1e6-1f1fa' },
    'CA': { name: 'CA', code: '1f1e8-1f1e6' },
    'IN': { name: 'IN', code: '1f1ee-1f1f3' },
    'VN': { name: '越南', code: '1f1fb-1f1f3' },
    'TH': { name: '泰国', code: '1f1f9-1f1ed' },
    'MY': { name: 'MY', code: '1f1f2-1f1fe' },
    'ID': { name: 'ID', code: '1f1ee-1f1e9' },
    'PH': { name: 'PH', code: '1f1f5-1f1ed' },
    'BR': { name: 'BR', code: '1f1e7-1f1f7' },
    'RU': { name: 'RU', code: '1f1f7-1f1fa' },
    'CN': { name: 'CN', code: '1f1e8-1f1f3' },
    'NL': { name: 'NL', code: '1f1f3-1f1f1' },
    'IT': { name: 'IT', code: '1f1ee-1f1f9' },
    'ES': { name: 'ES', code: '1f1ea-1f1f8' },
    'MX': { name: 'MX', code: '1f1f2-1f1fd' },
    'AR': { name: 'AR', code: '1f1e6-1f1f7' },
    'TR': { name: 'TR', code: '1f1f9-1f1f7' },
    'SA': { name: 'SA', code: '1f1f8-1f1e6' },
    'AE': { name: 'AE', code: '1f1e6-1f1ea' },
    'PL': { name: 'PL', code: '1f1f5-1f1f1' },
    'SE': { name: 'SE', code: '1f1f8-1f1ea' }
};

// Twemoji CDN 基础URL
const TWEMOJI_BASE = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/';

// 获取国旗SVG URL
function getFlagUrl(countryCode) {
    const data = COUNTRY_DATA[countryCode?.toUpperCase()];
    if (data) {
        return `${TWEMOJI_BASE}${data.code}.svg`;
    }
    return null;
}

// 获取国家显示名称
function getCountryName(countryCode) {
    const data = COUNTRY_DATA[countryCode?.toUpperCase()];
    return data ? data.name : countryCode;
}

// 生成国家选项HTML（用于下拉框）
function generateCountryOptions() {
    let html = '<option value="🌍">🌍 全球</option>';
    Object.keys(COUNTRY_DATA).forEach(code => {
        const data = COUNTRY_DATA[code];
        html += `<option value="${code}">${data.name}</option>`;
    });
    return html;
}

// 生成国旗HTML（用于显示）
function getFlagHtml(countryCode, size = 20) {
    if (!countryCode || countryCode === '🌍') {
        return '<span style="font-size: 1.1rem;">🌍</span>';
    }
    
    const url = getFlagUrl(countryCode);
    const name = getCountryName(countryCode);
    
    if (url) {
        return `<img src="${url}" alt="${name}" class="flag-icon" style="width:${size}px;height:${Math.round(size*0.75)}px;border-radius:2px;object-fit:cover;vertical-align:middle;">`;
    }
    
    return `<span>${countryCode}</span>`;
}

// 兼容旧版本的COUNTRY_FLAGS
const COUNTRY_FLAGS = {};
Object.keys(COUNTRY_DATA).forEach(code => {
    // 用于兼容，但实际显示使用getFlagHtml
    COUNTRY_FLAGS[code] = code;
});
