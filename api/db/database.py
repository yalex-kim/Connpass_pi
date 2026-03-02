import sqlite3
import os
from pathlib import Path
from flask import g

DB_PATH = os.getenv("DB_PATH", "./data/connpass.db")


def get_db():
    if "db" not in g:
        db_path = os.getenv("DB_PATH", DB_PATH)
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        g.db = sqlite3.connect(db_path, detect_types=sqlite3.PARSE_DECLTYPES)
        g.db.row_factory = sqlite3.Row
    return g.db


def close_db(e=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db(app):
    schema_path = Path(__file__).parent / "schema.sql"
    with app.app_context():
        db = get_db()
        db.executescript(schema_path.read_text(encoding="utf-8"))
        db.commit()
    app.teardown_appcontext(close_db)
