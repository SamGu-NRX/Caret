"""Check manifest URLs and pins against Git's staged submodule records."""

import configparser
import json
from pathlib import Path
import re
import subprocess


def main():
    sources = json.loads(Path("sources.json").read_text())
    modules = configparser.ConfigParser()
    modules.read(".gitmodules")
    entries = subprocess.check_output(["git", "ls-files", "--stage"], text=True)
    pins = {}
    for line in entries.splitlines():
        metadata, path = line.split("\t", 1)
        mode, sha, stage = metadata.split()
        if mode == "160000":
            if stage != "0":
                raise ValueError(f"Conflicted submodule: {path}")
            pins[path] = sha
    if len(sources) != len({source["path"] for source in sources}):
        raise ValueError("Duplicate source path")
    expected = {source["path"]: source["commit"] for source in sources}
    if pins != expected:
        raise ValueError("sources.json does not match the staged submodule pins")
    module_paths = {modules[section]["path"] for section in modules.sections()}
    if module_paths != set(expected):
        raise ValueError(".gitmodules does not match the source manifest")
    for source in sources:
        if not re.fullmatch(r"[0-9a-f]{40}", source["commit"]):
            raise ValueError(f"Invalid commit: {source['path']}")
        section = next(modules[s] for s in modules.sections() if modules[s]["path"] == source["path"])
        if section["url"] != source["url"]:
            raise ValueError(f"Mismatched URL: {source['path']}")
    print(f"Verified {len(sources)} pinned public sources")


if __name__ == "__main__":
    main()
