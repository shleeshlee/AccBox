# AccBox 代码问题排查报告

## 🔴 高优先级问题

### 1. XSS 安全风险 - 动态内容未转义

多处使用 `innerHTML` 插入用户可控数据时未调用 `escapeHtml()`：

**位置及问题代码：**

```javascript
// 第 344 行 - 账号类型名称和图标未转义
typesHtml += `...${t.icon}...${t.name}...`

// 第 352 行 - 属性组名称未转义  
propsHtml += `...${g.name}...`

// 第 363 行 - 属性值名称未转义
propsHtml += `...${v.name}...`

// 第 639 行 - 筛选标签类型名称未转义
html += `...${t.name}...`

// 第 649 行 - 筛选标签属性组名称未转义
html += `...${g.name}...`

// 第 657 行 - 筛选标签属性值名称未转义
html += `...${v.name}...`

// 第 755, 770 行 - 下拉选项未转义
accountTypes.map(t => `<option>...${t.icon} ${t.name}...</option>`)

// 第 826, 831 行 - 组合选择器未转义
html += `...${g.name}...${v.name}...`
```

**风险：** 如果用户通过 API 或导入功能注入恶意脚本到类型名称/属性名称中，会导致 XSS 攻击。

---

### 2. 账号模态框会触发自动填充

账号编辑模态框中的邮箱和密码输入框会被浏览器识别并自动填充。

**位置：** `index.html` 第 155-158 行

```html
<input type="text" class="form-input" id="accEmail">
<input type="text" class="form-input" id="accPassword">
```

**修复：** 添加 `autocomplete="off"` 或使用更语义化的 name 属性。

---

## 🟡 中优先级问题

### 3. 密码输入框类型问题

账号密码输入框使用 `type="text"` 而非 `type="password"`，密码会明文显示。

**位置：** `index.html` 第 158 行

```html
<input type="text" class="form-input" id="accPassword">
```

**建议：** 改为 `type="password"` 并提供显示/隐藏切换按钮。

---

### 4. 颜色值注入风险

`v.color` 和 `t.color` 直接插入 style 属性，未做校验：

```javascript
// 第 363 行
style="background:${v.color}"

// 第 344 行  
style="color:${t.color}"
```

**风险：** 虽然不是 XSS，但恶意颜色值可能导致样式注入。

**建议：** 添加颜色格式校验函数。

---

### 5. 注册表单可能被自动填充干扰

注册表单的用户名和密码输入框可能被浏览器错误地填充已保存的凭据。

**位置：** `index.html` 第 27-29 行

**建议：** 给注册表单添加 `autocomplete="new-password"` 等属性。

---

## 🟢 低优先级/建议

### 6. Console.log 调试信息残留

生产环境代码中残留了调试用的 `console.log`：

```javascript
// 第 1246-1247 行
console.log('当前 token:', token);
console.log('localStorage token:', localStorage.getItem('token'));
```

**建议：** 移除或改为条件编译。

---

### 7. 错误处理不统一

部分 API 调用使用 `apiRequest()` 带自动 401 处理，部分直接用 `fetch()`：

```javascript
// 使用 apiRequest (自动处理401)
const res = await apiRequest(`/accounts/${accountId}/totp`);

// 直接 fetch (需手动处理)
const res = await fetch(API + '/accounts', { headers: { Authorization: 'Bearer ' + token } });
```

**建议：** 统一使用 `apiRequest()` 函数。

---

### 8. 2FA Secret 输入框应禁用自动填充

2FA 配置的密钥输入框可能被浏览器错误识别：

**位置：** `index.html` 第 291 行

```html
<input type="text" class="form-input" id="totp2FASecret" ...>
```

---

## 修复优先级建议

1. **立即修复：** XSS 风险（所有未转义的动态内容）
2. **尽快修复：** 表单自动填充问题
3. **计划修复：** 密码明文显示、颜色校验
4. **可选修复：** 调试日志清理、错误处理统一
