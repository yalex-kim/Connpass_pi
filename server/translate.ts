import { streamSimple } from "@mariozechner/pi-ai";
import type { WebSocket } from "ws";
import { models } from "./models.js";

interface TranslateConfig {
  model: string;
  targetLang: "KO" | "EN" | "JA" | "ZH";
  translatePrompt: string;
}

const DEFAULT_TRANSLATE_PROMPT = `You are a professional translator.
- Detect the source language automatically
- Translate to: {{target_lang}}
- Output ONLY the translated text, no explanations, no preamble
- Preserve all formatting: markdown, code blocks, line breaks, bullet points
- For BT/WiFi technical terms (HCI error codes, spec references, command names), keep the original English unless a standard Korean translation exists
- Korean style: formal (합쇼체)`;

function buildTranslatePrompt(config: TranslateConfig): string {
  const prompt = config.translatePrompt || DEFAULT_TRANSLATE_PROMPT;
  return prompt.replace("{{target_lang}}", config.targetLang);
}

export async function translateDirect(
  ws: WebSocket,
  sessionId: string,
  text: string,
  config: TranslateConfig,
  signal: AbortSignal
): Promise<void> {
  const model = models[config.model] ?? models["Kimi-K2.5"];
  const stream = streamSimple(
    model,
    {
      systemPrompt: buildTranslatePrompt(config),
      messages: [{ role: "user", content: text, timestamp: Date.now() }],
    },
    { signal }
  );

  try {
    for await (const event of stream) {
      if (event.type === "text_delta") {
        ws.send(JSON.stringify({ type: "token", sessionId, delta: event.delta }));
      } else if (event.type === "done") {
        ws.send(JSON.stringify({
          type: "agent_end",
          sessionId,
          totalTokens: event.message.usage.totalTokens,
        }));
      } else if (event.type === "error") {
        if (event.reason !== "aborted") {
          ws.send(JSON.stringify({
            type: "error",
            sessionId,
            message: event.error?.errorMessage ?? "번역 중 오류 발생",
            code: "TRANSLATE_ERROR",
          }));
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      ws.send(JSON.stringify({
        type: "error",
        sessionId,
        message: String(err),
        code: "TRANSLATE_ERROR",
      }));
    }
  }
}
