#!/usr/bin/env bash
# 冒烟测试：等待服务就绪 → 健康检查 → 管理员登录 → 状态接口版本 → 演示数据已加载
# 用法：smoke.sh <服务地址> <期望版本> <管理员密码>
# ci 工作流（直接启动 Node）与镜像发布工作流（启动构建好的镜像）共用
set -euo pipefail

BASE="$1"
WANT="$2"
PW="$3"
jar="$(mktemp)"
trap 'rm -f "$jar"' EXIT

fail() { echo "::error::$*"; exit 1; }

for _ in $(seq 1 60); do
  curl -fsS "$BASE/readyz" >/dev/null 2>&1 && break
  sleep 1
done
[ "$(curl -fsS "$BASE/healthz" || true)" = "ok" ] || fail "/healthz 异常"
[ "$(curl -fsS "$BASE/readyz" || true)" = "ready" ] || fail "/readyz 异常（数据库不可用）"

code=$(curl -sS -o /dev/null -w '%{http_code}' -c "$jar" -H 'Content-Type: application/json' \
  -d "$(jq -cn --arg p "$PW" '{username: "admin", password: $p}')" "$BASE/api/login")
[ "$code" = "200" ] || fail "管理员登录失败（HTTP $code）"

status=""
for _ in $(seq 1 30); do
  status=$(curl -fsS -b "$jar" "$BASE/api/status")
  [ "$(jq -r '.data.dailyLines // 0' <<<"$status")" -gt 0 ] && break
  sleep 1
done
ver=$(jq -r '.version' <<<"$status")
[ "$ver" = "$WANT" ] || fail "运行中的版本为 $ver，期望 $WANT"
[ "$(jq -r '.demo' <<<"$status")" = "true" ] || fail "演示模式未开启"
lines=$(jq -r '.data.dailyLines // 0' <<<"$status")
[ "$lines" -gt 0 ] || fail "演示数据未加载（日账单 0 行）"

today=$(jq -r '.today' <<<"$status")
rows=$(curl -fsS -b "$jar" "$BASE/api/data?mode=month&cycle=${today:0:7}" | jq '.lines.rows | length')
[ "$rows" -ge 0 ] || fail "分析数据接口异常"

echo "冒烟通过：版本 ${ver}，日账单 ${lines} 行，本月账单 ${rows} 行"
