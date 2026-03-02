"""Flask API 실행 헬퍼 — 워크트리 루트에서 실행 가능하도록 경로 설정"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from api.app import create_app

if __name__ == "__main__":
    app = create_app()
    app.run(debug=True, port=5000, host="0.0.0.0")
