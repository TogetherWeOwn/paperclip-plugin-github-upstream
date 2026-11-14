#!/usr/bin/env python3
"""Verify and extract the two immutable lifecycle-test packages.

Run outside the downloaded archive directories. The output directories must not
exist: this avoids mixing stale files with the trees the stock host will load.
"""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile
import zipfile

PACKAGE = "togetherweown-paperclip-plugin-github-upstream-0.1.0.tgz"
CANDIDATE_SHA256 = "b5f449ab4c0941bd5b5f4031bd3f372dd3aabb1b57b44c7043a9c3c110344726"
ROLLBACK_SHA256 = "04a4b4ddfb1255f39b739c4b227854ba2e336cc255ab8d12ad8d4d7761dd0f9d"
MAX_ARCHIVE = 2 * 1024 * 1024
MAX_EXPANDED = 16 * 1024 * 1024


def extract_package(data, expected, destination):
    if len(data) > MAX_ARCHIVE or hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("package digest or size mismatch")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        members = archive.getmembers()
        seen = set()
        total = 0
        for member in members:
            path = PurePosixPath(member.name)
            parts = member.name.split("/")
            if (path.is_absolute() or len(parts) < 2 or parts[0] != "package"
                    or any(part in ("", ".", "..") for part in parts)
                    or not member.isfile() or member.name in seen):
                raise ValueError("unsafe or duplicate package member")
            seen.add(member.name)
            total += member.size
            if total > MAX_EXPANDED or len(seen) > 1024:
                raise ValueError("package inventory exceeds limits")
        if not {"package/package.json", "package/dist/worker.js"} <= seen:
            raise ValueError("package lacks required entrypoints")
        destination.mkdir(parents=False, exist_ok=False)
        inventory = {}
        for member in members:
            target = destination.joinpath(*member.name.split("/")[1:])
            target.parent.mkdir(parents=True, exist_ok=True)
            source = archive.extractfile(member)
            if source is None:
                raise ValueError("missing package member content")
            contents = source.read()
            inventory[member.name.removeprefix("package/")] = hashlib.sha256(contents).hexdigest()
            with target.open("xb") as output:
                output.write(contents)
            os.chmod(target, 0o444)
        return inventory


def prepare(candidate_zip, rollback_tgz, output):
    with zipfile.ZipFile(candidate_zip) as archive:
        matches = [entry for entry in archive.infolist() if entry.filename == PACKAGE]
        if len(matches) != 1 or matches[0].file_size > MAX_ARCHIVE:
            raise ValueError("candidate zip has no unique bounded package")
        candidate = archive.read(matches[0])
    with Path(rollback_tgz).open("rb") as source:
        rollback = source.read(MAX_ARCHIVE + 1)
    if len(rollback) > MAX_ARCHIVE:
        raise ValueError("package digest or size mismatch")
    root = Path(output)
    if root.exists():
        raise ValueError("output already exists")
    root.mkdir(parents=False)
    inventories = {
        "candidate": extract_package(candidate, CANDIDATE_SHA256, root / "candidate"),
        "rollback": extract_package(rollback, ROLLBACK_SHA256, root / "rollback"),
    }
    (root / "inventories.json").write_text(json.dumps(inventories, sort_keys=True), encoding="utf8")
    print("Verified and extracted candidate and rollback SHA-256 pins")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: prepare_artifacts.py CANDIDATE.zip ROLLBACK.tgz NEW_OUTPUT_DIR")
    prepare(*sys.argv[1:])
