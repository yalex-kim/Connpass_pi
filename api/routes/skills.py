import uuid
import datetime
import json
from flask import Blueprint, request, jsonify, g
from ..db.database import get_db

skills_bp = Blueprint("skills", __name__, url_prefix="/api/skills")


def row_to_dict(row):
    return dict(row) if row else None


def rows_to_list(rows):
    return [dict(row) for row in rows]


def parse_json_field(value):
    """JSON 문자열 필드를 파이썬 객체로 변환."""
    if not value:
        return None
    if isinstance(value, (list, dict)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return value


def serialize_json_field(value):
    """파이썬 객체를 JSON 문자열로 직렬화."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def enrich_skill(skill_dict: dict) -> dict:
    """스킬 dict의 JSON 필드들을 파이썬 객체로 변환."""
    if skill_dict is None:
        return None
    skill_dict["tools"] = parse_json_field(skill_dict.get("tools"))
    skill_dict["indexes"] = parse_json_field(skill_dict.get("indexes"))
    return skill_dict


@skills_bp.get("")
def list_skills():
    """스킬 목록 조회."""
    try:
        db = get_db()
        rows = db.execute(
            """
            SELECT id, name, description, tools, indexes, persona, enabled, created_at
            FROM skills
            WHERE user_id = ? AND enabled = 1
            ORDER BY created_at DESC
            """,
            (g.user_id,),
        ).fetchall()
        result = [enrich_skill(dict(row)) for row in rows]
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@skills_bp.post("")
def create_skill():
    """스킬 등록 (SKILL.md 형태 파싱)."""
    try:
        body = request.get_json(silent=True) or {}
        name = body.get("name")
        content = body.get("content")

        if not name or not content:
            return jsonify({"error": "name and content are required"}), 400

        skill_id = str(uuid.uuid4())
        now = datetime.datetime.utcnow().isoformat()

        description = body.get("description")
        tools = serialize_json_field(body.get("tools"))
        indexes = serialize_json_field(body.get("indexes"))
        persona = body.get("persona")

        db = get_db()
        db.execute(
            """
            INSERT INTO skills (id, user_id, name, description, content, tools, indexes, persona, enabled, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
            """,
            (skill_id, g.user_id, name, description, content, tools, indexes, persona, now),
        )
        db.commit()

        row = db.execute(
            "SELECT id, name, description, content, tools, indexes, persona, enabled, created_at FROM skills WHERE id = ?",
            (skill_id,),
        ).fetchone()
        return jsonify(enrich_skill(row_to_dict(row))), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@skills_bp.put("/<skill_id>")
def update_skill(skill_id):
    """스킬 업데이트."""
    try:
        body = request.get_json(silent=True) or {}
        db = get_db()

        row = db.execute(
            "SELECT id FROM skills WHERE id = ? AND user_id = ?",
            (skill_id, g.user_id),
        ).fetchone()
        if row is None:
            return jsonify({"error": "Skill not found"}), 404

        allowed_fields = {
            "name": str,
            "description": str,
            "content": str,
            "persona": str,
            "enabled": int,
        }
        json_fields = {"tools", "indexes"}

        updates = []
        values = []

        for field, field_type in allowed_fields.items():
            if field in body:
                updates.append(f"{field} = ?")
                values.append(field_type(body[field]) if body[field] is not None else None)

        for field in json_fields:
            if field in body:
                updates.append(f"{field} = ?")
                values.append(serialize_json_field(body[field]))

        if not updates:
            return jsonify({"error": "No fields to update"}), 400

        values.append(skill_id)
        db.execute(
            f"UPDATE skills SET {', '.join(updates)} WHERE id = ?",
            values,
        )
        db.commit()

        updated = db.execute(
            "SELECT id, name, description, content, tools, indexes, persona, enabled, created_at FROM skills WHERE id = ?",
            (skill_id,),
        ).fetchone()
        return jsonify(enrich_skill(row_to_dict(updated)))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@skills_bp.delete("/<skill_id>")
def delete_skill(skill_id):
    """스킬 삭제 (enabled=0 soft delete)."""
    try:
        db = get_db()
        row = db.execute(
            "SELECT id FROM skills WHERE id = ? AND user_id = ?",
            (skill_id, g.user_id),
        ).fetchone()
        if row is None:
            return jsonify({"error": "Skill not found"}), 404

        db.execute("UPDATE skills SET enabled = 0 WHERE id = ?", (skill_id,))
        db.commit()
        return jsonify({"deleted": skill_id, "soft_delete": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@skills_bp.post("/<skill_id>/run")
def run_skill(skill_id):
    """스킬 수동 실행 (현재는 content 반환 스텁)."""
    try:
        db = get_db()
        row = db.execute(
            "SELECT id, name, description, content, tools, indexes, persona, enabled FROM skills WHERE id = ? AND user_id = ?",
            (skill_id, g.user_id),
        ).fetchone()

        if row is None:
            return jsonify({"error": "Skill not found"}), 404

        skill = enrich_skill(row_to_dict(row))

        if not skill.get("enabled"):
            return jsonify({"error": "Skill is disabled"}), 403

        # 스텁: 실제 실행은 Node.js Agent loop에서 처리 예정
        # 현재는 스킬 content와 메타데이터 반환
        return jsonify({
            "status": "stub",
            "skill_id": skill_id,
            "name": skill["name"],
            "content": skill["content"],
            "message": "Skill execution will be handled by the Node.js Agent loop",
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
