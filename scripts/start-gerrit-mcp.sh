#!/usr/bin/env bash
# gerrit-mcp-server (stdio) → supergateway로 streamable-http 래핑
# Transport: streamable-http → POST /mcp
# 포트: 9002
#
# 사전 설치:
#   pip install gerrit-mcp-server
#   npm install -g supergateway   (또는 npx 사용)
#
# 설정:
#   scripts/gerrit_config.json 파일 준비 (gerrit_config.json.example 참고)

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/gerrit_config.json"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "❌ 설정 파일이 없습니다: $CONFIG_FILE"
  echo "   gerrit_config.json.example 을 복사해서 값을 채우세요."
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo "❌ python3 가 필요합니다."
  exit 1
fi

if ! python3 -c "import gerrit_mcp_server" &>/dev/null; then
  echo "❌ gerrit-mcp-server 가 설치되지 않았습니다."
  echo "   pip install gerrit-mcp-server"
  exit 1
fi

echo "▶ gerrit-mcp-server → supergateway (포트 9002, streamable-http)"
npx -y supergateway \
  --port 9002 \
  --baseUrl "http://localhost:9002" \
  --transportType streamableHttp \
  -- python3 -m gerrit_mcp_server --config "$CONFIG_FILE"
