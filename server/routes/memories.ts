import { Router } from "express";
import {
  listMemories,
  getMemory,
  createMemory,
  updateMemory,
  deleteMemory,
  deleteAllMemories,
} from "../memory.js";
import db from "../db.js";

const router = Router();

function uid(req: import("express").Request): string {
  return (req.headers["x-user-id"] as string) ?? "default";
}

// GET /api/memories?type=preference&limit=50&offset=0
router.get("/", (req, res) => {
  try {
    const type = req.query["type"] as string | undefined;
    const limit = parseInt(req.query["limit"] as string ?? "100");
    const offset = parseInt(req.query["offset"] as string ?? "0");

    let memories = listMemories(uid(req), type);

    // 간단한 페이지네이션
    const total = memories.length;
    memories = memories.slice(offset, offset + limit);

    // embedding BLOB은 응답에서 제외 (전송 불필요)
    const rows = memories.map(m => ({ ...m, embedding: undefined }));
    res.json({ memories: rows, total });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/memories/stats
router.get("/stats", (req, res) => {
  try {
    const stats = db.prepare(
      `SELECT memory_type, COUNT(*) as count, AVG(importance) as avg_importance
       FROM user_memories WHERE user_id = ? GROUP BY memory_type ORDER BY count DESC`
    ).all(uid(req)) as Array<{ memory_type: string; count: number; avg_importance: number }>;

    const total = db.prepare("SELECT COUNT(*) as n FROM user_memories WHERE user_id = ?")
      .get(uid(req)) as { n: number };

    res.json({ total: total.n, by_type: stats });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/memories/:id
router.get("/:id", (req, res) => {
  try {
    const memory = getMemory(uid(req), req.params["id"]);
    if (!memory) return res.status(404).json({ error: "기억을 찾을 수 없습니다" });
    res.json({ ...memory, embedding: undefined });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/memories — 수동 추가
router.post("/", async (req, res) => {
  try {
    const body = req.body ?? {};
    if (!body.content?.trim()) return res.status(400).json({ error: "content는 필수입니다" });

    const validTypes = ["preference", "issue", "project", "feature", "fact"];
    const memType = validTypes.includes(body.memory_type) ? body.memory_type : "fact";

    const memory = await createMemory(uid(req), {
      content: String(body.content).trim(),
      memory_type: memType,
      topic_key: body.topic_key ? String(body.topic_key).trim() : null,
      importance: Math.min(5, Math.max(1, parseInt(body.importance ?? "3"))),
    });
    res.status(201).json({ ...memory, embedding: undefined });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /api/memories/:id — 수정
router.put("/:id", async (req, res) => {
  try {
    const body = req.body ?? {};
    const patch: { content?: string; importance?: number } = {};
    if (body.content !== undefined) patch.content = String(body.content).trim();
    if (body.importance !== undefined) patch.importance = Math.min(5, Math.max(1, parseInt(body.importance)));

    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "수정할 필드가 없습니다" });

    const updated = await updateMemory(uid(req), req.params["id"], patch);
    if (!updated) return res.status(404).json({ error: "기억을 찾을 수 없습니다" });
    res.json({ ...updated, embedding: undefined });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/memories — 전체 삭제 (type 지정 시 해당 타입만)
router.delete("/", (req, res) => {
  try {
    const type = req.query["type"] as string | undefined;
    const deleted = deleteAllMemories(uid(req), type);
    res.json({ deleted });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/memories/:id — 단건 삭제
router.delete("/:id", (req, res) => {
  try {
    const ok = deleteMemory(uid(req), req.params["id"]);
    if (!ok) return res.status(404).json({ error: "기억을 찾을 수 없습니다" });
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

export default router;
