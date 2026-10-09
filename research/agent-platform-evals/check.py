#!/usr/bin/env python3
"""Validate sources.json for the agent-platform-evals research packet.

Checks:
  - file parses as a non-empty JSON array
  - every entry has all required fields, with the right types
  - ids are unique, slug-formatted
  - urls are unique and well-formed http(s)
  - dates present and plausibly formatted (YYYY-MM-DD, YYYY-MM, or YYYY)
  - type and status use the documented enum values

Exit 0 prints PASS; any failure prints FAIL with reasons and exits 1.
"""

import json
import re
import sys
from pathlib import Path

REQUIRED_KEYS = ["id", "title", "publisher", "url", "date", "type", "status", "evidence"]
ALLOWED_TYPES = {"paper", "blog", "docs", "site", "forum", "video"}
ALLOWED_STATUS = {"fetched", "search-snippet"}
SLUG_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
DATE_RE = re.compile(r"^\d{4}(-\d{2})?(-\d{2})?$")
URL_RE = re.compile(r"^https://[^\s\"']+$")


def main() -> int:
    path = Path(__file__).resolve().parent / "sources.json"
    problems = []

    try:
        entries = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"FAIL: cannot parse {path}: {exc}")
        return 1

    if not isinstance(entries, list) or not entries:
        print("FAIL: sources.json must be a non-empty JSON array")
        return 1

    seen_ids: set[str] = set()
    seen_urls: set[str] = set()

    for i, entry in enumerate(entries):
        label = f"entry[{i}]"
        if not isinstance(entry, dict):
            problems.append(f"{label}: not an object")
            continue

        for key in REQUIRED_KEYS:
            if key not in entry:
                problems.append(f"{label}: missing required key '{key}'")
            elif not isinstance(entry[key], str) or not entry[key].strip():
                problems.append(f"{label}: '{key}' must be a non-empty string")

        sid = entry.get("id", "")
        if sid:
            label = f"entry[{i}] ({sid})"
            if sid in seen_ids:
                problems.append(f"{label}: duplicate id")
            seen_ids.add(sid)
            if not SLUG_RE.match(sid):
                problems.append(f"{label}: id is not slug-formatted")

        url = entry.get("url", "")
        if url:
            if url in seen_urls:
                problems.append(f"{label}: duplicate url")
            seen_urls.add(url)
            if not URL_RE.match(url):
                problems.append(f"{label}: malformed url '{url}'")

        date = entry.get("date", "")
        if date and not DATE_RE.match(date):
            problems.append(f"{label}: malformed date '{date}' (use YYYY-MM-DD, YYYY-MM, or YYYY)")

        if entry.get("type") not in ALLOWED_TYPES:
            problems.append(f"{label}: type must be one of {sorted(ALLOWED_TYPES)}")
        if entry.get("status") not in ALLOWED_STATUS:
            problems.append(f"{label}: status must be one of {sorted(ALLOWED_STATUS)}")

    fetched = sum(1 for e in entries if isinstance(e, dict) and e.get("status") == "fetched")
    print(f"{len(entries)} sources ({fetched} fetched full-text, {len(entries) - fetched} search-snippet)")

    if problems:
        print(f"FAIL: {len(problems)} problem(s):")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("PASS: sources.json is valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
