.PHONY: demo app test check sources

demo:
	python3 -m caret preview --fixture fixtures/meeting.json

app:
	python3 scripts/run_mac.py

test:
	python3 -m unittest discover -s tests -v

check: test
	python3 scripts/check_sources.py
	swift build --package-path apps/mac

sources:
	git submodule update --init --depth 1 packages/keytype packages/jev-ultrafast
