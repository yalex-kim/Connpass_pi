import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import db from "../db.js";

interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  transport?: "streamable-http" | "sse";
  enabled: boolean;
}

// serverId → 영속적 Client 연결 풀 (프로세스 수명 동안 유지)
const clientPool = new Map<string, Client>();

function schemaToTypeBox(schema: Record<string, unknown>) {
  return Type.Record(Type.String(), Type.Unknown(), {
    description: JSON.stringify(schema),
  });
}

async function connectClient(server: McpServerConfig): Promise<Client> {
  const client = new Client(
    { name: "connpass-agent", version: "1.0.0" },
    { capabilities: {} }
  );
  const base = server.url.replace(/\/$/, "");
  if ((server.transport ?? "streamable-http") === "sse") {
    await client.connect(new SSEClientTransport(new URL(`${base}/sse`)));
  } else {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  }
  return client;
}

async function getPooledClient(server: McpServerConfig): Promise<Client> {
  const existing = clientPool.get(server.id);
  if (existing) return existing;
  const client = await connectClient(server);
  clientPool.set(server.id, client);
  return client;
}

// MCP 서버 삭제/수정 시 호출 — routes/mcp.ts에서 import
export function invalidateMcpClient(serverId: string) {
  const client = clientPool.get(serverId);
  if (client) client.close().catch(() => {});
  clientPool.delete(serverId);
}

async function buildMcpTools(
  server: McpServerConfig
): Promise<AgentTool<ReturnType<typeof Type.Record>>[]> {
  const client = await getPooledClient(server);
  const { tools: mcpTools } = await client.listTools();

  return mcpTools.map((mcpTool): AgentTool<ReturnType<typeof Type.Record>> => ({
    name: `mcp_${server.id.replace(/-/g, "_")}_${mcpTool.name}`,
    label: `[${server.name}] ${mcpTool.name}`,
    description: mcpTool.description ?? "",
    parameters: schemaToTypeBox((mcpTool.inputSchema ?? {}) as Record<string, unknown>),
    execute: async (_toolCallId, params, _signal) => {
      const callTool = async () => {
        const c = await getPooledClient(server);
        return c.callTool({ name: mcpTool.name, arguments: params as Record<string, unknown> });
      };
      try {
        const result = await callTool();
        const text = (result.content as Array<{ type: string; text?: string }>)
          .filter(c => c.type === "text")
          .map(c => c.text ?? "")
          .join("\n");
        return {
          content: [{ type: "text", text: text || JSON.stringify(result.content) }],
          details: {},
        };
      } catch {
        // 연결 오류 시 재연결 후 1회 재시도
        invalidateMcpClient(server.id);
        try {
          const result = await callTool();
          const text = (result.content as Array<{ type: string; text?: string }>)
            .filter(c => c.type === "text")
            .map(c => c.text ?? "")
            .join("\n");
          return {
            content: [{ type: "text", text: text || JSON.stringify(result.content) }],
            details: {},
          };
        } catch (e2) {
          return {
            content: [{ type: "text", text: `[${server.name}] ${mcpTool.name} 실행 실패: ${String(e2)}` }],
            details: { error: true },
          };
        }
      }
    },
  }));
}

export async function loadAllMcpTools(userId = "default"): Promise<AgentTool<ReturnType<typeof Type.Record>>[]> {
  try {
    const servers = db.prepare(
      "SELECT id, name, url, transport, enabled FROM mcp_servers WHERE user_id = ? AND enabled = 1"
    ).all(userId) as McpServerConfig[];
    const results = await Promise.allSettled(
      servers.map(s => buildMcpTools(s))
    );
    return results.flatMap(r => r.status === "fulfilled" ? r.value : []);
  } catch {
    return [];
  }
}
