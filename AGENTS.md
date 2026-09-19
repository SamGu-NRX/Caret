# Project Memory

Shared memory for this repository is managed through SumMem.

## At Session Start: Activating SumMem (mandatory)

Run `python3 .summem/summem wake` from the repository root. If you can see a prior project-root SumMem wake in this conversation's history, do not run it again.

## While Working: Register Memories

When something matches the write rule below, record it with SumMem's `note`.

One short line another contributor needs to work on this repository: gotchas, norms, failed approaches, lore and tribal knowledge, etc. Not merely "news" - e.g. that a PR opened, checks passed, or a task completed. Personal, machine-local, and user preference facts stay out. Do not record secrets, live credentials, or personal threads. Skip if nothing qualifies or it is already remembered.

# Agent context

Tracked agent-facing project knowledge lives under `memory-bank/`. Prefer those files over inventing project facts.

## Persistent files

- `memory-bank/productContext.md` — business context: users, use cases, success criteria, constraints
- `memory-bank/systemPatterns.md` — architecture and naming patterns in use
- `memory-bank/techContext.md` — stack, tools, and how to work in this repo

## Archives

Completed work is summarized under `memory-bank/archive/<kind>/YYYYMMDD-<task-id>.md`.

## Active work

`memory-bank/active/` holds the current-task execution trace. If those files exist, an in-flight task may be underway — consult them before starting work that could collide.

## When to load

When the task needs project, architecture, or stack context, read the relevant persistent file(s). Do not load every memory-bank file on every chat.

# Caret contributor instructions

- Start with README.md, docs/integrations.md, and `memory-bank/` when you need project, architecture, or stack context. Keep the native Swift + Python + SQLite starter simple.
- The supported hackathon scope ends before payment. Do not add purchases, hotel search or multi-party polling.
- Fixture content is synthetic and cannot be sent. Drop failed-source options; never invent facts in a draft.
- Keep external credentials and personal data out of Git. Source integrations need explicit configuration.
- Treat packages/ as pinned upstream code. Preserve authorship and licenses; do not bulk rename upstream files.
- Run make check on Mac, or make test plus python3 scripts/check_sources.py for core-only Linux work.
- Preserve other contributors' changes. Use branches and PRs after the initial repository setup.
