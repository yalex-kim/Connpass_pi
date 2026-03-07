import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import db from "../db.js";

const RAGAAS_URL = process.env.RAGAAS_URL ?? "http://ragaas.internal";

async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 2): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, options);
      if (resp.ok || resp.status < 500) return resp;
      throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); // 500ms → 1s
    }
  }
  throw new Error("unreachable");
}

const ragSearchParams = Type.Object({
  query: Type.String({ description: "검색할 쿼리 문자열" }),
  indexes: Type.Optional(Type.Array(Type.String(), { description: "검색할 RAG 인덱스 ID 목록. 미지정 시 활성 인덱스 전체" })),
  topK: Type.Optional(Type.Number({ description: "반환할 최대 결과 수, 기본값 5" })),
});

const listIndexesParams = Type.Object({});

export function listRagIndexesTool(): AgentTool<typeof listIndexesParams> {
  return {
    name: "list_rag_indexes",
    label: "RAG 인덱스 목록",
    description: `사용 가능한 RAG 인덱스 목록과 각 설명을 반환합니다.
rag_search 호출 전에 먼저 이 tool로 어떤 인덱스가 있는지 확인하고,
질문과 관련 있는 2~3개 인덱스 ID만 선택해서 검색하세요.`,
    parameters: listIndexesParams,
    execute: async () => {
      try {
        const rows = db.prepare(
          "SELECT id, name, description, domain, type, version FROM rag_index_metadata WHERE enabled = 1 ORDER BY type, id"
        ).all() as Array<{ id: string; name: string; description: string; domain: string; type: string; version?: string }>;
        const text = rows.map(r => {
          const domain = (() => { try { return (JSON.parse(r.domain) as string[]).join("/"); } catch { return r.domain; } })();
          const ver = r.version ? ` v${r.version}` : "";
          return `- id: "${r.id}" [${domain}${ver}] ${r.name}: ${r.description}`;
        }).join("\n");
        return {
          content: [{ type: "text", text: text || "등록된 인덱스가 없습니다." }],
          details: { count: rows.length },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `인덱스 목록 조회 실패: ${String(e)}` }],
          details: { error: true },
        };
      }
    },
  };
}

export function ragTool(activeIndexes: string[]): AgentTool<typeof ragSearchParams> {
  return {
    name: "rag_search",
    label: "문서 검색",
    description: `사내 RAG 인덱스에서 관련 문서를 검색합니다.
BT/WiFi 스펙, Confluence 위키, Jira 이슈, Gerrit 코드, Requirement 문서 등을 검색할 수 있습니다.
현재 활성화된 인덱스: ${activeIndexes.join(", ") || "전체"}`,
    parameters: ragSearchParams,
    execute: async (toolCallId, params, signal) => {
      const indexes = params.indexes ?? activeIndexes;
      const res = await fetchWithRetry(`${RAGAAS_URL}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: params.query, indexes, topK: params.topK ?? 5 }),
        signal,
      });
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `RAG 검색 실패: ${res.status} ${res.statusText}` }],
          details: { error: true },
        };
      }
      const data = await res.json() as { results: Array<{ content: string; source: string; score: number; indexId: string }> };
      const text = data.results.map((r, i) => `[${i+1}] (출처: ${r.source}, 점수: ${r.score.toFixed(3)})\n${r.content}`).join("\n\n---\n\n");
      return {
        content: [{ type: "text", text: text || "관련 문서를 찾지 못했습니다." }],
        details: { sources: data.results.map(r => ({ source: r.source, score: r.score, indexId: r.indexId })) },
      };
    },
  };
}
