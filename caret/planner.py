"""Pure scheduling functions. Source failures are never replaced by model output."""

from datetime import datetime, timedelta
from email import policy
from email.parser import Parser


def timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        raise ValueError("Timestamps must include a timezone offset")
    return parsed


def interval(start: str, end: str) -> tuple[datetime, datetime]:
    lower, upper = timestamp(start), timestamp(end)
    if upper <= lower:
        raise ValueError("Interval end must be after its start")
    return lower, upper


def extract_thread(raw: str) -> dict:
    """Decode a supplied RFC 822 message; Gmail thread retrieval is separate."""
    message = Parser(policy=policy.default).parsestr(raw)
    body = message.get_body(preferencelist=("plain",))
    if body is None:
        raise ValueError("The thread must contain a text/plain message")
    return {
        "subject": str(message.get("Subject", "")),
        "sender": str(message.get("From", "")),
        "body": body.get_content().strip(),
    }


def plan(fixture: dict) -> dict:
    if fixture.get("mode") != "sample":
        raise ValueError("This starter accepts labeled sample data only; connect live adapters first")
    thread = extract_thread(fixture["thread"])
    duration = fixture["duration_minutes"]
    before, after = fixture["buffer_before_minutes"], fixture["buffer_after_minutes"]
    if type(duration) is not int or duration <= 0:
        raise ValueError("duration_minutes must be a positive integer")
    if any(type(value) is not int or value < 0 for value in (before, after)):
        raise ValueError("Travel buffers must be nonnegative integer minutes")
    busy = [interval(item["start"], item["end"]) for item in fixture["busy"]]
    options, dropped = [], []
    seen = set()
    candidate_ids = set()
    for candidate in fixture["candidates"]:
        candidate_id = candidate.get("id")
        if not isinstance(candidate_id, str) or not candidate_id.strip():
            raise ValueError("Each candidate needs a nonempty string ID")
        if candidate_id in candidate_ids:
            raise ValueError(f"Duplicate candidate ID: {candidate_id}")
        candidate_ids.add(candidate_id)
        if candidate.get("status") != "ok" or not candidate.get("source"):
            dropped.append(candidate["id"])
            continue
        start = timestamp(candidate["start"])
        end = start + timedelta(minutes=duration)
        blocked_start = start - timedelta(minutes=before)
        blocked_end = end + timedelta(minutes=after)
        if start in seen or any(blocked_start < hi and lo < blocked_end for lo, hi in busy):
            dropped.append(candidate["id"])
            continue
        seen.add(start)
        options.append({
            "id": candidate["id"], "start": start.isoformat(), "end": end.isoformat(),
            "hold_start": blocked_start.isoformat(), "hold_end": blocked_end.isoformat(),
            "source": candidate["source"],
        })
    options = sorted(options, key=lambda item: timestamp(item["start"]))[:3]
    times = [f"{item['start']} to {item['end']}" for item in options]
    draft = "I can meet at one of these times:\n" + "\n".join(times) if options else ""
    return {
        "mode": "sample", "workflow": "book-calendar-link", "subject": thread["subject"],
        "thread_body": thread["body"], "options": options, "draft": draft,
        "evidence": fixture["evidence"], "dropped": dropped,
        "notice": "Synthetic development data. This draft cannot be sent. Holds are local only.",
    }
