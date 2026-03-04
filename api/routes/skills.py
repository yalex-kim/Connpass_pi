import os
import re
import shutil
from flask import Blueprint, g, request, jsonify

skills_bp = Blueprint("skills", __name__)

SHARED_SKILLS_DIR = os.path.abspath(os.environ.get("SKILLS_DIR", "./skills"))
USER_SKILLS_BASE = os.path.abspath(os.environ.get("USER_SKILLS_DIR", "./skills-user"))


def _parse_frontmatter(content: str) -> dict:
    """SKILL.md frontmatter 파싱 (YAML 라이브러리 없이)."""
    if not content.startswith("---"):
        return {}
    end = content.find("---", 3)
    if end == -1:
        return {}
    fm: dict = {}
    for line in content[3:end].splitlines():
        if ":" in line:
            key, _, val = line.partition(":")
            fm[key.strip()] = val.strip()
    return fm


def _scan_dir(base_dir: str, source: str) -> list:
    """디렉토리에서 SKILL.md 파일 스캔."""
    skills = []
    if not os.path.isdir(base_dir):
        return skills
    for entry in sorted(os.listdir(base_dir)):
        skill_dir = os.path.join(base_dir, entry)
        skill_file = os.path.join(skill_dir, "SKILL.md")
        if not (os.path.isdir(skill_dir) and os.path.isfile(skill_file)):
            continue
        try:
            with open(skill_file, "r", encoding="utf-8") as f:
                content = f.read()
            fm = _parse_frontmatter(content)
            name = fm.get("name") or entry
            description = fm.get("description", "")
            if not description:
                continue  # description 없으면 스킵 (agentskills.io 스펙)
            skills.append({
                "dir_name": entry,
                "name": name,
                "description": description,
                "source": source,  # 'shared' | 'user'
                "content": content,
            })
        except Exception:
            continue
    return skills


@skills_bp.get("/api/skills")
def list_skills():
    shared = _scan_dir(SHARED_SKILLS_DIR, "shared")
    user_dir = os.path.join(USER_SKILLS_BASE, g.user_id)
    user = _scan_dir(user_dir, "user")
    return jsonify({"skills": shared + user})


@skills_bp.post("/api/skills/upload")
def upload_skill():
    if "file" not in request.files:
        return jsonify({"error": "파일이 없습니다"}), 400

    f = request.files["file"]
    if not f.filename or not f.filename.endswith(".md"):
        return jsonify({"error": ".md 파일만 업로드 가능합니다"}), 400

    try:
        content = f.read().decode("utf-8")
    except Exception:
        return jsonify({"error": "파일 인코딩 오류 (UTF-8 필요)"}), 400

    fm = _parse_frontmatter(content)
    name = fm.get("name", "").strip()
    description = fm.get("description", "").strip()

    if not name:
        return jsonify({"error": "frontmatter에 name이 필요합니다"}), 400
    if not description:
        return jsonify({"error": "frontmatter에 description이 필요합니다"}), 400

    # name → 디렉토리명 변환 (소문자, 하이픈만)
    dir_name = re.sub(r"[^a-z0-9-]", "-", name.lower()).strip("-")
    dir_name = re.sub(r"-{2,}", "-", dir_name)
    if not dir_name:
        return jsonify({"error": "유효하지 않은 skill 이름입니다"}), 400

    user_dir = os.path.join(USER_SKILLS_BASE, g.user_id, dir_name)
    os.makedirs(user_dir, exist_ok=True)

    with open(os.path.join(user_dir, "SKILL.md"), "w", encoding="utf-8") as out:
        out.write(content)

    return jsonify({"dir_name": dir_name, "name": name, "source": "user"}), 201


@skills_bp.delete("/api/skills/<dir_name>")
def delete_skill(dir_name):
    if not re.match(r"^[a-z0-9-]+$", dir_name):
        return jsonify({"error": "유효하지 않은 skill 이름입니다"}), 400

    user_dir = os.path.join(USER_SKILLS_BASE, g.user_id, dir_name)
    if not os.path.isdir(user_dir):
        return jsonify({"error": "Skill을 찾을 수 없거나 공유 Skill은 삭제할 수 없습니다"}), 404

    shutil.rmtree(user_dir)
    return jsonify({"deleted": dir_name})
