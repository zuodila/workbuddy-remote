# 贡献指南

感谢愿意一起把它做得更好。这个项目的定位很窄：**让一个桌面应用在 Linux 主机上无头运行，并被可靠地远程使用**。提交前请确认你的改动在这个范围内。

## 可以提什么

- 部署脚本的兼容性（其它发行版、arm64、非 systemd 环境）
- 剪贴板桥的健壮性（更多 MIME 类型、超大图片、异常剪贴板所有者）
- 客户端体验（多显示器、代理、字体缩放、快捷键）
- 文档纠错、补图、翻译

## 不要提什么

- 任何第三方软件的安装包、破解、授权文件
- 含真实域名、内网 IP、账号、口令、截图里未脱敏的个人信息
- 与项目无关的功能扩张（例如把它做成通用云桌面平台）

## 提交前自检

```bash
# 1. 不要带出敏感信息
grep -rniE 'https?://[a-z0-9.-]+\.[a-z]{2,}|[0-9]{1,3}(\.[0-9]{1,3}){3}|passw|secret|token' \
  --include='*.md' --include='*.js' --include='*.py' --include='*.sh' . | head

# 2. 语法
node --check client/main.js
python3 -m py_compile scripts/clipbridge.py scripts/patch-novnc.py
sh -n scripts/install.sh scripts/start-wb.sh
```

## PR 约定

1. 一个 PR 只做一件事，描述里写清"现象 → 原因 → 改法 → 验证方式"；
2. 改了行为就同步改文档（README / docs）；
3. 涉及截图的，先脱敏（打码账号、去掉内网地址与域名）；
4. 提交信息用中文或英文都可以，但要说清动机。

## 报告问题

请附上：

- 发行版与内核：`cat /etc/os-release; uname -a`
- 相关日志：`journalctl -u wbdesktop -n 100 --no-pager`
- 剪贴板接口返回：`curl -s http://127.0.0.1:8137/clip/get`
- 复现步骤与期望行为

**提交日志前请先删掉域名、IP、账号、口令。**
