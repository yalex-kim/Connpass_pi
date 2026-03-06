import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? join(__dirname, "../data/connpass.db");

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
db.exec(schema);

// 마이그레이션: generating 컬럼 (기존 DB 호환)
try { db.exec("ALTER TABLE sessions ADD COLUMN generating INTEGER NOT NULL DEFAULT 0"); } catch { /* 이미 존재 */ }

export default db;
