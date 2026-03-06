import { Router } from "express";
import { readdirSync, readFileSync, mkdirSync, rmSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import multer from "multer";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });

const SHARED_SKILLS_DIR = process.env.SKILLS_DIR ? join(process.env.SKILLS_DIR) : join(process.cwd(), "skills");
const USER_SKILLS_BASE = process.env.USER_SKILLS_DIR ? join(process.env.USER_SKILLS_DIR) : join(process.cwd(), "skills-user");

function uid(req: import("express").Request): string {
  return (req.headers["x-user-id"] as string) ?? "default";
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("---", 3);
  if (end === -1) return {};
  const fm: Record<string, string> = {};
  for (const line of content.slice(3, end).split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fm;
}

function scanDir(baseDir: string, source: string): unknown[] {
  try { statSync(baseDir); } catch { return []; }
  const skills: unknown[] = [];
  for (const entry of readdirSync(baseDir).sort()) {
    const skillDir = join(baseDir, entry);
    const skillFile = join(skillDir, "SKILL.md");
    try {
      statSync(skillDir);
      statSync(skillFile);
    } catch { continue; }
    try {
      const content = readFileSync(skillFile, "utf-8");
      const fm = parseFrontmatter(content);
      if (!fm["description"]) continue;
      skills.push({ dir_name: entry, name: fm["name"] ?? entry, description: fm["description"], source, content });
    } catch { continue; }
  }
  return skills;
}

// GET /api/skills
router.get("/skills", (req, res) => {
  const shared = scanDir(SHARED_SKILLS_DIR, "shared");
  const user = scanDir(join(USER_SKILLS_BASE, uid(req)), "user");
  res.json({ skills: [...shared, ...user] });
});

// POST /api/skills/upload
router.post("/skills/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "파일이 없습니다" });
  if (!req.file.originalname.endsWith(".md")) return res.status(400).json({ error: ".md 파일만 업로드 가능합니다" });

  let content: string;
  try { content = req.file.buffer.toString("utf-8"); }
  catch { return res.status(400).json({ error: "파일 인코딩 오류 (UTF-8 필요)" }); }

  const fm = parseFrontmatter(content);
  const name = (fm["name"] ?? "").trim();
  const description = (fm["description"] ?? "").trim();
  if (!name) return res.status(400).json({ error: "frontmatter에 name이 필요합니다" });
  if (!description) return res.status(400).json({ error: "frontmatter에 description이 필요합니다" });

  let dirName = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
  if (!dirName) return res.status(400).json({ error: "유효하지 않은 skill 이름입니다" });

  const userDir = join(USER_SKILLS_BASE, uid(req), dirName);
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, "SKILL.md"), content, "utf-8");
  res.status(201).json({ dir_name: dirName, name, source: "user" });
});

// DELETE /api/skills/:dir_name
router.delete("/skills/:dir_name", (req, res) => {
  if (!/^[a-z0-9-]+$/.test(req.params.dir_name))
    return res.status(400).json({ error: "유효하지 않은 skill 이름입니다" });
  const userDir = join(USER_SKILLS_BASE, uid(req), req.params.dir_name);
  try { statSync(userDir); } catch { return res.status(404).json({ error: "Skill을 찾을 수 없거나 공유 Skill은 삭제할 수 없습니다" }); }
  rmSync(userDir, { recursive: true, force: true });
  res.json({ deleted: req.params.dir_name });
});

export default router;
