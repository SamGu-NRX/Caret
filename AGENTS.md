# Caret contributor instructions

- Start with README.md and docs/integrations.md. Keep the native Swift + Python + SQLite starter simple.
- The supported hackathon scope ends before payment. Do not add purchases, hotel search or multi-party polling.
- Fixture content is synthetic and cannot be sent. Drop failed-source options; never invent facts in a draft.
- Keep external credentials and personal data out of Git. Source integrations need explicit configuration.
- Treat packages/ as pinned upstream code. Preserve authorship and licenses; do not bulk rename upstream files.
- Run make check on Mac, or make test plus python3 scripts/check_sources.py for core-only Linux work.
- Preserve other contributors' changes. Use branches and PRs after the initial repository setup.
