import json
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .config import ROOT
from .models import Options, Profile


class Store:
    def __init__(self, directory: Path, provider="mock", model="deepseek-flash"):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = directory / "lab.sqlite3"
        self.prompt_dir = directory / "prompts"
        self.prompt_dir.mkdir(exist_ok=True, mode=0o700)
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, payload TEXT NOT NULL)")
            db.execute(
                "INSERT OR IGNORE INTO state VALUES ('profile', ?)",
                (Profile(options=Options(provider=provider, model=model)).model_dump_json(),),
            )
            for run_id, payload in db.execute("SELECT id,payload FROM runs").fetchall():
                run = json.loads(payload)
                if run["status"] == "running":
                    run.update(
                        status="interrupted",
                        error={"code": "server_restarted", "message": "服务重启，调用结果未知。"},
                    )
                    db.execute(
                        "UPDATE runs SET payload=? WHERE id=?", (json.dumps(run, ensure_ascii=False), run_id)
                    )

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def profile(self) -> Profile:
        with self.connect() as db:
            payload = db.execute("SELECT payload FROM state WHERE key='profile'").fetchone()[0]
        return Profile.model_validate_json(payload)

    def save_profile(self, profile: Profile):
        with self.connect() as db:
            db.execute("UPDATE state SET payload=? WHERE key='profile'", (profile.model_dump_json(),))

    def save_run(self, run: dict):
        with self.connect() as db:
            db.execute(
                "INSERT INTO runs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                (run["id"], json.dumps(run, ensure_ascii=False)),
            )

    def run(self, run_id: str):
        with self.connect() as db:
            row = db.execute("SELECT payload FROM runs WHERE id=?", (run_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def recent_runs(self):
        with self.connect() as db:
            rows = db.execute("SELECT payload FROM runs ORDER BY rowid DESC LIMIT 100").fetchall()
        keys = ("id", "createdAt", "status", "source", "options", "durationMs", "usage", "error", "feedback")
        return [
            {
                **{key: run.get(key) for key in keys},
                "goalTitle": run["input"]["goal"]["title"],
                "goalID": run["input"]["goal"]["id"],
                "validTaskCount": sum(
                    len(plan["suggestions"]) for plan in (run.get("result") or {}).get("plans", [])
                ),
                "filteredCount": len(run.get("issues", [])),
            }
            for (payload,) in rows
            if (run := json.loads(payload))
        ]

    def prompt(self, name: str) -> str:
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", name):
            raise ValueError("invalid prompt version")
        path = ROOT / "prompts" / "coach-v1.md" if name == "coach-v1" else self.prompt_dir / f"{name}.md"
        return path.read_text()

    def prompts(self):
        names = ["coach-v1"] + sorted(path.stem for path in self.prompt_dir.glob("*.md"))
        return [{"name": name, "content": self.prompt(name)} for name in names]

    def save_prompt(self, name: str, content: str):
        if name == "coach-v1" or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", name):
            raise FileExistsError("prompt name is reserved or invalid")
        with (self.prompt_dir / f"{name}.md").open("x") as file:
            file.write(content)
