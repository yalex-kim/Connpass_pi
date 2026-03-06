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

async function buildMcpTools(
  server: McpServerConfig
): Promise<AgentTool<ReturnType<typeof Type.Record>>[]> {
  // tools/list: 연결해서 툴 목록 가져온 뒤 연결 종료
  const listClient = await connectClient(server);
  const { tools: mcpTools } = await listClient.listTools();
  await listClient.close().catch(() => {});

  return mcpTools.map((mcpTool): AgentTool<ReturnType<typeof Type.Record>> => ({
    name: `mcp_${server.id.replace(/-/g, "_")}_${mcpTool.name}`,
    label: `[${server.name}] ${mcpTool.name}`,
    description: mcpTool.description ?? "",
    parameters: schemaToTypeBox((mcpTool.inputSchema ?? {}) as Record<string, unknown>),
    execute: async (_toolCallId, params, _signal) => {
      let client: Client | null = null;
      try {
        client = await connectClient(server);
        const result = await client.callTool({
          name: mcpTool.name,
          arguments: params as Record<string, unknown>,
        });
        const text = (result.content as Array<{ type: string; text?: string }>)
          .filter(c => c.type === "text")
          .map(c => c.text ?? "")
          .join("\n");
        return {
          content: [{ type: "text", text: text || JSON.stringify(result.content) }],
          details: {},
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `[${server.name}] ${mcpTool.name} 실행 실패: ${String(e)}` }],
          details: { error: true },
        };
      } finally {
        if (client) await client.close().catch(() => {});
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
