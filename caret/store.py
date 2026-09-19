"""SQLite run records and local tentative holds; no external calendar writes."""

import json
import sqlite3
from pathlib import Path
from uuid import uuid4


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY, preview TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS holds (
                run_id TEXT NOT NULL REFERENCES runs(id), option_id TEXT NOT NULL,
                start TEXT NOT NULL, end TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('tentative', 'confirmed', 'released')),
                PRIMARY KEY(run_id, option_id)
            );
        """)

    def close(self):
        self.db.close()

    def save_preview(self, preview: dict) -> str:
        run_id = str(uuid4())
        with self.db:
            self.db.execute("INSERT INTO runs VALUES (?, ?)", (run_id, json.dumps(preview)))
        return run_id

    def hold(self, run_id: str) -> list[dict]:
        row = self.db.execute("SELECT preview FROM runs WHERE id = ?", (run_id,)).fetchone()
        if row is None:
            raise ValueError("Unknown run ID")
        with self.db:
            for option in json.loads(row[0])["options"]:
                self.db.execute(
                    "INSERT OR IGNORE INTO holds VALUES (?, ?, ?, ?, 'tentative')",
                    (run_id, option["id"], option["hold_start"], option["hold_end"]),
                )
        return self.holds(run_id)

    def confirm(self, run_id: str, option_id: str) -> list[dict]:
        rows = self.holds(run_id)
        selected = next((row for row in rows if row["option_id"] == option_id), None)
        if selected is None or selected["status"] == "released":
            raise ValueError("Select an existing tentative hold")
        with self.db:
            self.db.execute(
                "UPDATE holds SET status = CASE WHEN option_id = ? THEN 'confirmed' ELSE 'released' END WHERE run_id = ?",
                (option_id, run_id),
            )
        return self.holds(run_id)

    def holds(self, run_id: str) -> list[dict]:
        return [dict(zip(("option_id", "start", "end", "status"), row)) for row in self.db.execute(
            "SELECT option_id, start, end, status FROM holds WHERE run_id = ? ORDER BY start", (run_id,)
        )]
