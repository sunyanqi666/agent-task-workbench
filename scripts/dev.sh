#!/usr/bin/env bash
# 同时启动 API（3000）与 Web（5173）开发服务器；Ctrl+C 时一并退出。
# 兼容 macOS 自带 bash 3.2：不使用 wait -n，轮询检测子进程退出。
set -euo pipefail
cd "$(dirname "$0")/.."

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

pnpm dev:api & pids+=("$!")
pnpm dev:web & pids+=("$!")

# 任一子进程退出即结束脚本，由 cleanup 终止另一个
while kill -0 "${pids[0]}" 2>/dev/null && kill -0 "${pids[1]}" 2>/dev/null; do
  sleep 1
done
