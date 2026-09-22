#!/bin/bash
# 发布脚本：推送到 GitHub，并让 jsdelivr 立刻拿到新代码。
#
# 为什么需要这一步：
#   页面本体在 GitHub Pages 上，但 JS 模块与数据库引擎走 jsdelivr（国内访问快几十倍）。
#   jsdelivr 的 @main 有约 12 小时边缘缓存 —— 不主动清，你 push 完自己要看半天才看到新版。
#
# 用法：./deploy.sh "这次改了什么"
set -u
cd "$(dirname "$0")"
REPO="hailanmg-bit/business-flow"
MSG="${1:-更新}"

echo "① 提交并推送…"
git add -A
git commit -m "$MSG" || echo "   （没有需要提交的改动）"
git push origin main

echo
echo "② 通知 jsdelivr 刷新缓存…"
curl -s --max-time 30 "https://purge.jsdelivr.net/gh/${REPO}@main/" | head -c 400
echo

echo
echo "③ 等 GitHub Pages 重建（约 60 秒）…"
sleep 60

echo "④ 验证线上资源："
for p in / /app.js /js/db.js /vendor/sql-wasm.wasm; do
  printf "   %s  %s\n" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://hailanmg-bit.github.io/${REPO}${p}")" "$p"
done

echo
echo "完成。打开：https://hailanmg-bit.github.io/${REPO}/"
echo "建议再跑一次真浏览器验证："
echo "  node test/ui_check.mjs https://hailanmg-bit.github.io/${REPO}/"
