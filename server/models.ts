import { getModel } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";
import db from "./db.js";

// ── 모델 설정 TTL 캐시 (60초) ─────────────────────────────────────────────────
const _modelCache = new Map<string, { resolved: ResolvedModelConfig; at: number }>();
const MODEL_CACHE_TTL = 60_000;

export function invalidateModelCache(modelId?: string) {
  if (modelId) _modelCache.delete(modelId);
  else _modelCache.clear();
}

// 모델 기본값 (서버 URL 제외)
type ModelBase = Omit<Model<"openai-completions">, "baseUrl" | "maxTokens">;

const modelBases: Record<string, ModelBase & { defaultMaxTokens: number; defaultCtx: number }> = {
  "GLM4.7": {
    id: "GLM4.7",
    name: "GLM4.7",
    api: "openai-completions",
    provider: "internal",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    defaultMaxTokens: 8192,
    defaultCtx: 128000,
  },
  "Kimi-K2.5": {
    id: "Kimi-K2.5",
    name: "Kimi-K2.5",
    api: "openai-completions",
    provider: "internal",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    defaultMaxTokens: 4096,
    defaultCtx: 32000,
  },
  "GPT-OSS-120B": {
    id: "GPT-OSS-120B",
    name: "GPT-OSS-120B",
    api: "openai-completions",
    provider: "internal",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    defaultMaxTokens: 8192,
    defaultCtx: 128000,
  },
};

interface LlmModelConfig {
  model_id: string;
  base_url: string;
  api_key: string;
  temperature: number;
  max_tokens: number;
  context_window: number;
}

export interface ResolvedModelConfig {
  model: Model<"openai-completions">;
  temperature: number;
  apiKey: string;
}

/**
 * Flask에서 모델 설정을 읽어와 Model 객체 + temperature + apiKey를 반환한다.
 * 실패 시 환경변수 기반 기본값으로 폴백.
 */
export async function resolveModel(modelId: string): Promise<ResolvedModelConfig> {
  // 캐시 히트
  const hit = _modelCache.get(modelId);
  if (hit && Date.now() - hit.at < MODEL_CACHE_TTL) return hit.resolved;

  // 알려진 모델이 없으면 generic vLLM base를 사용
  const base = modelBases[modelId] ?? {
    id: modelId,
    name: modelId,
    api: "openai-completions" as const,
    provider: "internal",
    reasoning: false,
    input: ["text"] as ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    defaultMaxTokens: 4096,
    defaultCtx: 128000,
  };
  const fallbackUrl = process.env.VLLM_BASE_URL ?? "http://vllm.internal/v1";

  try {
    const cfg = db.prepare("SELECT * FROM llm_model_configs WHERE model_id = ?").get(modelId) as LlmModelConfig | undefined;
    if (cfg) {
      const { defaultMaxTokens, defaultCtx, ...rest } = base;
      const resolved: ResolvedModelConfig = {
        model: {
          ...rest,
          id: modelId,
          contextWindow: cfg.context_window || defaultCtx,
          baseUrl: cfg.base_url || fallbackUrl,
          maxTokens: cfg.max_tokens || defaultMaxTokens,
        },
        temperature: cfg.temperature ?? 0.7,
        apiKey: cfg.api_key || "",
      };
      _modelCache.set(modelId, { resolved, at: Date.now() });
      return resolved;
    }
  } catch {
    // DB 조회 실패 시 폴백
  }

  const { defaultMaxTokens, defaultCtx, ...rest } = base;
  const resolved: ResolvedModelConfig = {
    model: {
      ...rest,
      id: modelId,
      contextWindow: defaultCtx,
      baseUrl: fallbackUrl,
      maxTokens: defaultMaxTokens,
    },
    temperature: 0.7,
    apiKey: "",
  };
  _modelCache.set(modelId, { resolved, at: Date.now() });
  return resolved;
}

// OpenAI 모델 (사외 테스트용 — OPENAI_API_KEY 필요)
const openaiModels: Record<string, Model> = {
  "gpt-4o": getModel("openai", "gpt-4o"),
  "gpt-4o-mini": getModel("openai", "gpt-4o-mini"),
};

// 정적 fallback (resolveModel을 사용할 수 없는 경우용)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const models: Record<string, Model<any>> = {
  "GLM4.7": {
    ...(() => { const { defaultMaxTokens, defaultCtx, ...r } = modelBases["GLM4.7"]; return { ...r, maxTokens: defaultMaxTokens, contextWindow: defaultCtx }; })(),
    baseUrl: process.env.VLLM_BASE_URL ?? "http://vllm.internal/v1",
  },
  "Kimi-K2.5": {
    ...(() => { const { defaultMaxTokens, defaultCtx, ...r } = modelBases["Kimi-K2.5"]; return { ...r, maxTokens: defaultMaxTokens, contextWindow: defaultCtx }; })(),
    baseUrl: process.env.VLLM_BASE_URL ?? "http://vllm.internal/v1",
  },
  "GPT-OSS-120B": {
    ...(() => { const { defaultMaxTokens, defaultCtx, ...r } = modelBases["GPT-OSS-120B"]; return { ...r, maxTokens: defaultMaxTokens, contextWindow: defaultCtx }; })(),
    baseUrl: process.env.VLLM_BASE_URL ?? "http://vllm.internal/v1",
  },
  ...openaiModels,
};

export type ModelId = "GLM4.7" | "Kimi-K2.5" | "GPT-OSS-120B" | "gpt-4o" | "gpt-4o-mini";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";
