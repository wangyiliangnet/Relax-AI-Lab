import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from .config import ROOT
from .costs import PRICE_VERSION, builtin_pricing, cost_for_run, cost_summary, select_pricing
from .models import Options, Profile


def pricing_key(rule):
    return (rule["provider"], rule["model"], rule["period"], rule["baseURL"])


class Store:
    def __init__(self, directory: Path, provider="mock", model="deepseek-flash"):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = directory / "lab.sqlite3"
        self.prompt_dir = directory / "prompts"
        self.prompt_dir.mkdir(exist_ok=True, mode=0o700)
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, payload TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
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
                    run["cost"] = cost_for_run(run)
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
        if not row:
            return None
        run = json.loads(row[0])
        run.setdefault("cost", cost_for_run(run))
        return run

    def custom_pricing(self):
        with self.connect() as db:
            row = db.execute("SELECT payload FROM state WHERE key='pricing'").fetchone()
        rules = json.loads(row[0]) if row else []
        # Supersede the former manually labelled Flash price with the two scheduled defaults.
        return [
            {**rule, "period": rule.get("period", "all_day"), "source": "custom"}
            for rule in rules
            if not (
                rule["provider"] == "deepseek"
                and rule["model"] == "deepseek-flash"
                and "period" not in rule
                and rule.get("baseURL") == "https://api.deepseek.com"
            )
        ]

    def pricing(self):
        rules = {pricing_key(rule): rule for rule in builtin_pricing()}
        for rule in self.custom_pricing():
            rules[pricing_key(rule)] = rule
        with self.connect() as db:
            deleted = {pricing_key(rule) for rule in self.pricing_deletions(db)}
        return [rule for key, rule in rules.items() if key not in deleted]

    def pricing_deletions(self, db):
        row = db.execute("SELECT payload FROM state WHERE key='pricing_deleted'").fetchone()
        return json.loads(row[0]) if row else []

    def delete_pricing(self, target):
        if not any(pricing_key(rule) == pricing_key(target) for rule in self.pricing()):
            return False
        with self.connect() as db:
            # Keep source tariffs and suppress the whole identity, including any built-in fallback.
            deleted = self.pricing_deletions(db)
            deleted.append(target)
            db.execute(
                "INSERT INTO state VALUES ('pricing_deleted', ?) "
                "ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
                (json.dumps(deleted, ensure_ascii=False),),
            )
        return True

    def save_pricing(self, rule: dict):
        rules = [item for item in self.custom_pricing() if pricing_key(item) != pricing_key(rule)]
        rules.append(rule)
        with self.connect() as db:
            db.execute(
                "INSERT INTO state VALUES ('pricing', ?) "
                "ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
                (json.dumps(rules, ensure_ascii=False),),
            )
            deleted = [item for item in self.pricing_deletions(db) if pricing_key(item) != pricing_key(rule)]
            db.execute(
                "INSERT INTO state VALUES ('pricing_deleted', ?) "
                "ON CONFLICT(key) DO UPDATE SET payload=excluded.payload",
                (json.dumps(deleted, ensure_ascii=False),),
            )

    def backfill_builtin_pricing(self, base_url):
        if base_url != "https://api.deepseek.com":
            return
        migration = f"pricing-backfill:{PRICE_VERSION}"
        with self.connect() as db:
            if db.execute("SELECT 1 FROM state WHERE key=?", (migration,)).fetchone():
                return
            updated = 0
            for run_id, payload in db.execute("SELECT id,payload FROM runs").fetchall():
                run = json.loads(payload)
                pricing = select_pricing(run["options"], run.get("createdAt"), builtin_pricing(), base_url)
                if pricing is None or run["status"] == "running":
                    continue
                previous = run.get("pricing")
                if previous and previous.get("baseURL", base_url) != base_url:
                    continue
                applied_at = datetime.now(UTC).isoformat()
                run.setdefault("costRevisions", []).append(
                    {
                        "pricing": previous,
                        "cost": run.get("cost"),
                        "repricedAt": applied_at,
                        "reason": PRICE_VERSION,
                    }
                )
                run["pricing"] = {**pricing, "appliedToHistory": True, "appliedAt": applied_at}
                run["cost"] = cost_for_run(run)
                db.execute(
                    "UPDATE runs SET payload=? WHERE id=?", (json.dumps(run, ensure_ascii=False), run_id)
                )
                updated += 1
            db.execute("INSERT INTO state VALUES (?,?)", (migration, json.dumps({"updated": updated})))

    def costs(self):
        with self.connect() as db:
            rows = db.execute("SELECT payload FROM runs ORDER BY rowid DESC")
            return cost_summary(json.loads(payload) for (payload,) in rows)

    def recent_runs(self):
        with self.connect() as db:
            rows = db.execute("SELECT payload FROM runs ORDER BY rowid DESC LIMIT 100").fetchall()
        return [self.run_summary(json.loads(payload)) for (payload,) in rows]

    @staticmethod
    def run_summary(run):
        keys = (
            "id",
            "createdAt",
            "status",
            "source",
            "options",
            "durationMs",
            "usage",
            "error",
            "feedback",
            "promptEdited",
            "promptHash",
            "batchID",
        )
        return {
            **{key: run.get(key) for key in keys},
            "caseID": (run.get("case") or {}).get("id"),
            "verdict": (run.get("caseEvaluation") or {}).get("verdict"),
            "cost": run.get("cost") or cost_for_run(run),
            "goalTitle": run["input"]["goal"]["title"],
            "goalID": run["input"]["goal"]["id"],
            "validTaskCount": sum(
                len(plan["suggestions"]) for plan in (run.get("result") or {}).get("plans", [])
            ),
            "filteredCount": len(run.get("issues", [])),
        }

    def query_runs(
        self,
        page=1,
        page_size=8,
        query="",
        status="all",
        source="all",
        provider=None,
        prompt_version=None,
        model=None,
        prompt_hash=None,
        case_id=None,
        batch_id=None,
    ):
        clauses, values = [], []
        if query:
            fields = [
                "$.input.goal.title",
                "$.id",
                "$.options.promptVersion",
                "$.options.model",
                "$.promptHash",
                "$.case.id",
                "$.batchID",
            ]
            clauses.append(
                "("
                + " OR ".join(
                    f"instr(lower(coalesce(json_extract(payload, '{field}'), '')), lower(?)) > 0"
                    for field in fields
                )
                + ")"
            )
            values.extend([query] * len(fields))
        if status == "failed":
            clauses.append("json_extract(payload, '$.status') IN ('failed','interrupted')")
        elif status != "all":
            clauses.append("json_extract(payload, '$.status') = ?")
            values.append(status)
        filters = {
            "$.source": None if source == "all" else source,
            "$.options.provider": provider,
            "$.options.promptVersion": prompt_version,
            "$.options.model": model,
            "$.promptHash": prompt_hash,
            "$.case.id": case_id,
            "$.batchID": batch_id,
        }
        for path, value in filters.items():
            if value is not None:
                clauses.append(f"json_extract(payload, '{path}') = ?")
                values.append(value)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with self.connect() as db:
            total = db.execute("SELECT count(*) FROM runs" + where, values).fetchone()[0]
            pages = max(1, (total + page_size - 1) // page_size)
            page = min(page, pages)
            rows = db.execute(
                "SELECT payload FROM runs" + where + " ORDER BY rowid DESC LIMIT ? OFFSET ?",
                [*values, page_size, (page - 1) * page_size],
            ).fetchall()
        return {
            "items": [self.run_summary(json.loads(payload)) for (payload,) in rows],
            "total": total,
            "page": page,
            "pageSize": page_size,
            "totalPages": pages,
        }

    def create_batch(self, batch):
        with self.connect() as db:
            db.execute(
                "INSERT INTO batches VALUES (?,?)", (batch["id"], json.dumps(batch, ensure_ascii=False))
            )

    def batch(self, batch_id):
        with self.connect() as db:
            row = db.execute("SELECT payload FROM batches WHERE id=?", (batch_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def update_batch(self, batch_id, mutate):
        # Claims, stop requests and results merge against the latest row in one
        # transaction. Never overwrite an in-flight stop with a stale snapshot.
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT payload FROM batches WHERE id=?", (batch_id,)).fetchone()
            if row is None:
                return None
            batch = json.loads(row[0])
            mutate(batch)
            db.execute(
                "UPDATE batches SET payload=? WHERE id=?", (json.dumps(batch, ensure_ascii=False), batch_id)
            )
            return batch

    def batches(self, page=1, page_size=8):
        with self.connect() as db:
            total = db.execute("SELECT count(*) FROM batches").fetchone()[0]
            pages = max(1, (total + page_size - 1) // page_size)
            page = min(page, pages)
            rows = db.execute(
                "SELECT payload FROM batches ORDER BY rowid DESC LIMIT ? OFFSET ?",
                (page_size, (page - 1) * page_size),
            ).fetchall()
        return {
            "items": [json.loads(payload) for (payload,) in rows],
            "total": total,
            "page": page,
            "pageSize": page_size,
            "totalPages": pages,
        }

    def unfinished_batches(self):
        with self.connect() as db:
            rows = db.execute(
                "SELECT payload FROM batches WHERE json_extract(payload, '$.phase') = 'running'"
            ).fetchall()
        return [json.loads(payload) for (payload,) in rows]

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
