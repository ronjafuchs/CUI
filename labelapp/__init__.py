import os
from flask import Flask, send_from_directory


def create_app(projects_root=None):
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    app = Flask(__name__, static_folder=os.path.join(base, "static"), static_url_path="/static")
    app.config["PROJECTS_ROOT"] = projects_root or os.path.join(base, "projects")
    app.config["MAX_CONTENT_LENGTH"] = 512 * 1024 * 1024  # 512 MB uploads
    os.makedirs(app.config["PROJECTS_ROOT"], exist_ok=True)

    from .routes import api
    app.register_blueprint(api, url_prefix="/api")

    @app.get("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    return app
