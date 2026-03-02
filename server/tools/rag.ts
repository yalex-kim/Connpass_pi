import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const FLASK_URL = process.env.FLASK_API_URL ?? "http://localhost:5000";

const ragSearchParams = Type.Object({
  query: Type.String({ description: "검색할 쿼리 문자열" }),
  indexes: Type.Optional(Type.Array(Type.String(), { description: "검색할 RAG 인덱스 ID 목록. 미지정 시 활성 인덱스 전체" })),
  topK: Type.Optional(Type.Number({ description: "반환할 최대 결과 수, 기본값 5" })),
});

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
      const res = await fetch(`${FLASK_URL}/api/rag/search`, {
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
