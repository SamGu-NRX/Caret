.PHONY: demo app install dmg test check sources

PYTHON := $(shell for p in python3 python3.13 python3.12; do if $$p -c 'import sys; sys.exit(0 if sys.version_info>=(3,11) else 1)' 2>/dev/null; then echo $$p; break; fi; done)

demo:
	$(PYTHON) -m caret preview --fixture fixtures/meeting.json

app:
	CARET_INSTALL_APPLICATIONS=1 $(PYTHON) scripts/run_mac.py

install:
	$(PYTHON) scripts/package_mac.py --install

dmg:
	$(PYTHON) scripts/package_mac.py --dmg

test:
	$(PYTHON) -m unittest discover -s tests -v

check: test
	$(PYTHON) scripts/check_sources.py
	swift build --package-path apps/mac

sources:
	git submodule update --init --depth 1 packages/keytype packages/ghosttype packages/computer-use-jev
