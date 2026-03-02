#!/usr/bin/env bash
# mcp-atlassian 로컬 MCP 서버 시작 (Jira + Confluence)
# Transport: streamable-http --stateless → POST /mcp
# 포트: 9001

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env.mcp-atlassian"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ 설정 파일이 없습니다: $ENV_FILE"
  echo "   .env.mcp-atlassian.example 을 복사해서 값을 채우세요."
  exit 1
fi

# Docker 방식
if command -v docker &>/dev/null; then
  echo "▶ Docker로 mcp-atlassian 시작 (포트 9001)"
  docker run --rm -p 9001:9001 --env-file "$ENV_FILE" \
    ghcr.io/sooperset/mcp-atlassian:latest \
    --transport streamable-http --stateless --port 9001
# uvx 방식 (Python 환경)
elif command -v uvx &>/dev/null; then
  echo "▶ uvx로 mcp-atlassian 시작 (포트 9001)"
  export $(grep -v '^#' "$ENV_FILE" | xargs)
  uvx mcp-atlassian --transport streamable-http --stateless --port 9001
else
  echo "❌ Docker 또는 uvx(pip) 중 하나가 필요합니다."
  echo "   Docker: https://docs.docker.com/get-docker/"
  echo "   uvx:    pip install uv"
  exit 1
fi
