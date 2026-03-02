import os
from flask import Flask, g, request as flask_request
from flask_cors import CORS
from dotenv import load_dotenv
from .db.database import init_db
from .routes.sessions import sessions_bp
from .routes.rag import rag_bp
from .routes.jira import jira_bp
from .routes.mcp import mcp_bp
from .routes.skills import skills_bp
from .routes.settings import settings_bp
from .routes.gerrit import gerrit_bp

load_dotenv()


def create_app():
    app = Flask(__name__)
    CORS(app)

    init_db(app)

    @app.before_request
    def set_current_user():
        g.user_id = flask_request.headers.get("X-User-Id", "default")

    app.register_blueprint(sessions_bp)
    app.register_blueprint(rag_bp)
    app.register_blueprint(jira_bp)
    app.register_blueprint(mcp_bp)
    app.register_blueprint(skills_bp)
    app.register_blueprint(settings_bp)
    app.register_blueprint(gerrit_bp)

    @app.get("/health")
    def health():
        return {"status": "ok", "service": "Connpass API"}

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(debug=True, port=5000)
