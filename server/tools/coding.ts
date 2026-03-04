import {
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";

export function getCodingTools(cwd: string = process.cwd()): AgentTool[] {
  return [
    createBashTool(cwd) as AgentTool,
    createReadTool(cwd) as AgentTool,
    createWriteTool(cwd) as AgentTool,
    createEditTool(cwd) as AgentTool,
    createGrepTool(cwd) as AgentTool,
    createFindTool(cwd) as AgentTool,
    createLsTool(cwd) as AgentTool,
  ];
}
