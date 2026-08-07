#!/usr/bin/env python3
"""Local static server and SQLite-backed plan API for GMU Course Map."""

from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import re
import secrets
import sqlite3
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent
DATABASE_PATH = ROOT / "data" / "plans.db"
MIGRATIONS_PATH = ROOT / "drizzle"
MAX_BODY_BYTES = 64 * 1024
MAX_COURSES = 300
COURSE_CODE_PATTERN = re.compile(r"^([A-Z]{2,6})\s*(\d{3}[A-Z]?)$")
PROGRAM_ID_PATTERN = re.compile(r"^(all|[a-z0-9][a-z0-9-]{0,79})$")
PLAN_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


class PlanError(Exception):
    """A safe, user-facing plan API error."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def normalize_plan_payload(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise PlanError("Plan data must be a JSON object.")

    name = str(value.get("name") or "").strip()
    program_id = str(value.get("program_id") or "").strip()
    completed_values = value.get("completed_codes")
    if not name or len(name) > 80:
        raise PlanError("Plan name must be between 1 and 80 characters.")
    if not PROGRAM_ID_PATTERN.fullmatch(program_id):
        raise PlanError("Choose a valid degree program.")
    if not isinstance(completed_values, list):
        raise PlanError("Completed courses must be an array.")

    completed_codes: set[str] = set()
    for raw_code in completed_values:
        if not isinstance(raw_code, str):
            raise PlanError("Every completed course must be a course code.")
        match = COURSE_CODE_PATTERN.fullmatch(raw_code.strip().upper())
        if not match:
            raise PlanError(f"Invalid course code: {raw_code}")
        completed_codes.add(f"{match.group(1)} {match.group(2)}")

    if len(completed_codes) > MAX_COURSES:
        raise PlanError(f"A plan can contain at most {MAX_COURSES} courses.")

    return {
        "name": name,
        "program_id": program_id,
        "completed_codes": sorted(completed_codes),
    }


def _hash_edit_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _public_plan(row: sqlite3.Row) -> dict[str, object]:
    return {
        "id": row["id"],
        "name": row["name"],
        "program_id": row["program_id"],
        "completed_codes": json.loads(row["completed_codes"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


class PlanStore:
    def __init__(self, database_path: Path, migrations_path: Path = MIGRATIONS_PATH):
        self.database_path = Path(database_path)
        self.migrations_path = Path(migrations_path)
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _initialize(self) -> None:
        migrations = sorted(self.migrations_path.glob("*.sql"))
        if not migrations:
            raise RuntimeError("No generated database migrations were found.")

        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute(
                "CREATE TABLE IF NOT EXISTS _migrations "
                "(name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)"
            )
            applied = {
                row["name"]
                for row in connection.execute("SELECT name FROM _migrations").fetchall()
            }
            for migration in migrations:
                if migration.name in applied:
                    continue
                connection.executescript(migration.read_text(encoding="utf-8"))
                connection.execute(
                    "INSERT INTO _migrations (name, applied_at) VALUES (?, ?)",
                    (migration.name, _timestamp()),
                )
            connection.execute("PRAGMA optimize")

    def create(self, value: object) -> tuple[dict[str, object], str]:
        payload = normalize_plan_payload(value)
        plan_id = secrets.token_urlsafe(12)
        edit_token = secrets.token_urlsafe(32)
        timestamp = _timestamp()
        with self._connect() as connection:
            connection.execute(
                """INSERT INTO plans
                   (id, edit_token_hash, name, program_id, completed_codes, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    plan_id,
                    _hash_edit_token(edit_token),
                    payload["name"],
                    payload["program_id"],
                    json.dumps(payload["completed_codes"], separators=(",", ":")),
                    timestamp,
                    timestamp,
                ),
            )
        plan = self.get(plan_id)
        if plan is None:  # Defensive: the row was inserted in the transaction above.
            raise RuntimeError("Created plan could not be read.")
        return plan, edit_token

    def get(self, plan_id: str) -> dict[str, object] | None:
        if not PLAN_ID_PATTERN.fullmatch(plan_id):
            return None
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
        return _public_plan(row) if row else None

    def update(self, plan_id: str, edit_token: str, value: object) -> dict[str, object]:
        if not PLAN_ID_PATTERN.fullmatch(plan_id):
            raise PlanError("Plan not found.", 404)
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
            if not row:
                raise PlanError("Plan not found.", 404)
            if not edit_token or not hmac.compare_digest(
                _hash_edit_token(edit_token), row["edit_token_hash"]
            ):
                raise PlanError("The edit key is not valid for this plan.", 403)

            payload = normalize_plan_payload(value)
            connection.execute(
                """UPDATE plans
                   SET name = ?, program_id = ?, completed_codes = ?, updated_at = ?
                   WHERE id = ?""",
                (
                    payload["name"],
                    payload["program_id"],
                    json.dumps(payload["completed_codes"], separators=(",", ":")),
                    _timestamp(),
                    plan_id,
                ),
            )
        updated = self.get(plan_id)
        if updated is None:
            raise RuntimeError("Updated plan could not be read.")
        return updated


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class CourseMapHandler(BaseHTTPRequestHandler):
    store: PlanStore

    def _send_json(self, value: object, status: int = 200) -> None:
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> object:
        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError as error:
            raise PlanError("Invalid request size.") from error
        if length <= 0 or length > MAX_BODY_BYTES:
            raise PlanError("Plan data is missing or too large.")
        try:
            return json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise PlanError("Plan data must be valid JSON.") from error

    def _plan_id(self) -> str | None:
        path = urlparse(self.path).path
        prefix = "/api/plans/"
        plan_id = path[len(prefix) :] if path.startswith(prefix) else ""
        return plan_id if PLAN_ID_PATTERN.fullmatch(plan_id) else None

    def _serve_static(self) -> None:
        path = unquote(urlparse(self.path).path)
        relative = "index.html" if path == "/" else path.lstrip("/")
        allowed = (
            relative == "index.html"
            or relative.startswith("src/")
            or relative in {"data/courses.json", "data/programs.json"}
        )
        target = (ROOT / relative).resolve()
        if not allowed or ROOT not in target.parents or not target.is_file():
            self.send_error(404)
            return

        body = target.read_bytes()
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {
            "application/javascript",
            "application/json",
        }:
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - http.server method name
        try:
            if urlparse(self.path).path.startswith("/api/"):
                plan_id = self._plan_id()
                if not plan_id:
                    raise PlanError("API route not found.", 404)
                plan = self.store.get(plan_id)
                if not plan:
                    raise PlanError("Plan not found.", 404)
                self._send_json({"plan": plan})
                return
            self._serve_static()
        except PlanError as error:
            self._send_json({"error": str(error)}, error.status)

    def do_POST(self) -> None:  # noqa: N802 - http.server method name
        try:
            if urlparse(self.path).path != "/api/plans":
                raise PlanError("API route not found.", 404)
            plan, edit_token = self.store.create(self._read_json())
            self._send_json({"plan": plan, "edit_token": edit_token}, 201)
        except PlanError as error:
            self._send_json({"error": str(error)}, error.status)

    def do_PUT(self) -> None:  # noqa: N802 - http.server method name
        try:
            plan_id = self._plan_id()
            if not plan_id:
                raise PlanError("API route not found.", 404)
            authorization = self.headers.get("Authorization") or ""
            edit_token = re.sub(r"^Bearer\s+", "", authorization, flags=re.IGNORECASE)
            if not edit_token:
                raise PlanError("This plan needs its private edit key.", 401)
            plan = self.store.update(plan_id, edit_token, self._read_json())
            self._send_json({"plan": plan})
        except PlanError as error:
            self._send_json({"error": str(error)}, error.status)

    def log_message(self, format_string: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}")


def main() -> None:
    CourseMapHandler.store = PlanStore(DATABASE_PATH)
    server = ThreadingHTTPServer(("127.0.0.1", 5173), CourseMapHandler)
    print("GMU Course Map available at http://127.0.0.1:5173")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
