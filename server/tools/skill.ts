import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const FLASK_URL = process.env.FLASK_API_URL ?? "http://localhost:5000";

const skillRunParams = Type.Object({
  skillId: Type.String({ description: "실행할 Skill ID" }),
  input: Type.Optional(Type.String({ description: "Skill에 전달할 추가 입력" })),
});

export function skillTool(): AgentTool<typeof skillRunParams> {
  return {
    name: "run_skill",
    label: "Skill 실행",
    description: "등록된 Skill(워크플로우)를 실행합니다. 반복 업무 자동화에 사용합니다.",
    parameters: skillRunParams,
    execute: async (toolCallId, params, signal) => {
      const res = await fetch(`${FLASK_URL}/api/skills/${params.skillId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: params.input }),
        signal,
      });
      if (!res.ok) return { content: [{ type: "text", text: `Skill 실행 실패: ${res.status}` }], details: { error: true } };
      const data = await res.json() as { result: string };
      return {
        content: [{ type: "text", text: data.result }],
        details: { skillId: params.skillId },
      };
    },
  };
}
