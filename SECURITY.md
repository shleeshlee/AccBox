# 安全策略

## 报告漏洞

如果您发现安全漏洞，请通过以下方式报告：

1. **不要**公开披露漏洞详情
2. 发送邮件至项目维护者
3. 或在 GitHub 上创建私密安全报告

我们会在确认漏洞后尽快修复，并在修复后致谢报告者。

## 支持的版本

| 版本 | 支持状态 |
|------|---------|
| 5.1.x | ✅ 支持 |
| 5.0.x | ⚠️ 有已知漏洞，建议升级 |
| < 5.0 | ❌ 不支持 |

## 已知安全问题 (已在 v5.1 修复)

| 问题 | 严重程度 | 修复版本 |
|------|----------|---------|
| SHA256 无盐哈希 | 🔴 高危 | v5.1 |
| CORS `allow_origins=*` | 🟠 中危 | v5.1 |
| Token 无过期时间 | 🟠 中危 | v5.1 |
| 密码强度过低 | 🟡 低危 | v5.1 |
| `javascript:` XSS | 🟠 中危 | v5.1 |

## 安全最佳实践

### 部署建议

1. **使用 HTTPS**
   - 强烈建议在生产环境使用 HTTPS
   - 可以使用 Let's Encrypt 免费证书

2. **设置环境变量**
   ```bash
   export APP_MASTER_KEY="至少32字符的随机密钥"
   export JWT_SECRET_KEY="另一个随机密钥"
   export PRODUCTION=true
   ```

3. **限制 CORS**
   ```bash
   export ALLOWED_ORIGINS="https://yourdomain.com"
   ```

4. **定期备份**
   - 使用内置备份功能
   - 将备份文件下载到本地保存

5. **更新依赖**
   ```bash
   pip install --upgrade fastapi uvicorn passlib python-jose
   ```

### 密钥管理

- ⚠️ **不要**将密钥提交到 Git
- ⚠️ **不要**在日志中打印密钥
- ✅ 使用环境变量或密钥管理服务
- ✅ 定期轮换密钥

## 安全审计

v5.1 版本经过以下安全审计：
- Anthropic Claude 代码审查
- Google Gemini 代码审查

审计报告见 `docs/` 目录。
