#!/usr/bin/env node
/**
 * connpass CLI launcher
 *
 * tsx를 통해 cli.ts 소스를 직접 실행합니다.
 * 빌드 없이 항상 최신 소스가 반영됩니다.
 *
 * 사용법:
 *   npm link   # 최초 1회만
 *   connpass   # 이후 자동으로 최신 cli.ts 실행
 */

import { spawn } from "child_process";
import { dirname, resolve, join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(__dirname, "..");
const cliTs = join(serverDir, "cli.ts");

// node_modules/.bin/tsx 경로 (npm link 후에도 서버 디렉토리 기준으로 찾음)
const tsxBin = join(serverDir, "node_modules", ".bin", "tsx");

if (!existsSync(tsxBin)) {
  console.error("[connpass] tsx를 찾을 수 없습니다. 서버 디렉토리에서 npm install을 실행하세요.");
  console.error(`  경로: ${serverDir}`);
  process.exit(1);
}

if (!existsSync(cliTs)) {
  console.error("[connpass] cli.ts를 찾을 수 없습니다.");
  console.error(`  경로: ${cliTs}`);
  process.exit(1);
}

const child = spawn(tsxBin, [cliTs, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: serverDir,
});

child.on("error", (err) => {
  console.error("[connpass] 실행 오류:", err.message);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
