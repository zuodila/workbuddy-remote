#!/bin/bash
cd "$(dirname "$0")" || exit 1

echo "=================================================="
echo "  WorkBuddy Remote · macOS 安装包构建（Apple Silicon）"
echo "=================================================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 没有检测到 Node.js"
  echo
  echo "请先安装 Node.js（选 LTS 版本，Apple 芯片版）："
  echo "   https://nodejs.org/zh-cn"
  echo
  echo "安装完后再双击本文件即可。"
  echo
  read -n 1 -s -r -p "按任意键关闭..."
  exit 1
fi

echo "✅ Node 版本：$(node -v)"
echo
echo "① 正在安装打包依赖（首次约 1~3 分钟，取决于网速）..."
npm install --registry=https://registry.npmmirror.com --no-audit --no-fund || {
  echo
  echo "❌ 依赖安装失败，请检查网络后重试。"
  read -n 1 -s -r -p "按任意键关闭..."
  exit 1
}

echo
echo "② 正在生成 .dmg 安装包 ..."
npx electron-builder --mac dmg --arm64 || {
  echo
  echo "❌ 打包失败，请把上面的错误信息截图反馈。"
  read -n 1 -s -r -p "按任意键关闭..."
  exit 1
}

echo
echo "=================================================="
echo "🎉 完成！安装包已生成："
ls -1 dist/*.dmg 2>/dev/null
echo
echo "双击 .dmg，把应用拖进「应用程序」即可。"
echo "首次打开若提示“无法验证开发者”，右键点图标 → 打开。"
echo "=================================================="
open dist 2>/dev/null
echo
read -n 1 -s -r -p "按任意键关闭..."
