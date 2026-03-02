import os
import requests
from flask import Blueprint, request, jsonify

rag_bp = Blueprint("rag", __name__, url_prefix="/api/rag")

RAGAAS_URL = os.getenv("RAGAAS_URL", "http://ragaas.internal")


@rag_bp.post("/search")
def search():
    """사내 RAGaaS 검색 호출."""
    try:
        body = request.get_json(silent=True) or {}
        query = body.get("query")
        indexes = body.get("indexes", [])
        top_k = body.get("topK", 5)

        if not query:
            return jsonify({"error": "query is required"}), 400

        payload = {
            "query": query,
            "indexes": indexes,
            "topK": top_k,
        }

        try:
            resp = requests.post(
                f"{RAGAAS_URL}/search",
                json=payload,
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            return jsonify(data)
        except requests.exceptions.ConnectionError as e:
            return jsonify({"results": [], "error": f"RAGaaS connection error: {str(e)}"}), 200
        except requests.exceptions.Timeout:
            return jsonify({"results": [], "error": "RAGaaS request timed out"}), 200
        except requests.exceptions.HTTPError as e:
            return jsonify({"results": [], "error": f"RAGaaS HTTP error: {str(e)}"}), 200
        except Exception as e:
            return jsonify({"results": [], "error": str(e)}), 200

    except Exception as e:
        return jsonify({"results": [], "error": str(e)}), 200


@rag_bp.get("/indexes")
def list_indexes():
    """RAGaaS 인덱스 목록 조회."""
    try:
        try:
            resp = requests.get(
                f"{RAGAAS_URL}/indexes",
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()
            return jsonify(data)
        except requests.exceptions.ConnectionError as e:
            return jsonify({"indexes": [], "error": f"RAGaaS connection error: {str(e)}"}), 200
        except requests.exceptions.Timeout:
            return jsonify({"indexes": [], "error": "RAGaaS request timed out"}), 200
        except requests.exceptions.HTTPError as e:
            return jsonify({"indexes": [], "error": f"RAGaaS HTTP error: {str(e)}"}), 200
        except Exception as e:
            return jsonify({"indexes": [], "error": str(e)}), 200

    except Exception as e:
        return jsonify({"indexes": [], "error": str(e)}), 200
