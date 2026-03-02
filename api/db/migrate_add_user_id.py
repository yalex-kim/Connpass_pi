"""
Migration: llm_model_configs 테이블에 user_id 컬럼 추가.
기존 DB가 있을 경우 실행. 새 DB는 schema.sql에서 자동 생성됨.

Usage:
    python -m api.db.migrate_add_user_id
    # 또는
    python api/db/migrate_add_user_id.py data/connpass.db
"""
import sys
import sqlite3
import os


def migrate(db_path: str):
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "ALTER TABLE llm_model_configs ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_llm_model_configs_user_id ON llm_model_configs(user_id)"
        )
        conn.commit()
        print(f"[migrate] user_id 컬럼 추가 완료: {db_path}")
    except sqlite3.OperationalError as e:
        if "duplicate column name" in str(e):
            print(f"[migrate] 이미 존재함, 건너뜀: {db_path}")
        else:
            raise
    finally:
        conn.close()


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(__file__), "../../data/connpass.db"
    )
    migrate(os.path.normpath(path))
