#!/usr/bin/env python3
"""Freeze reviewed SaaS build inputs, including uncommitted source, without reading .env.

This is a source manifest, not a secret scanner or a Git commit. It deliberately
excludes operational state, arbitrary deployment overlays and non-SaaS projects.
Build both images from output/source and keep manifest.json with their digests.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {"Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".dockerignore", "LICENSE"}
ADMIN_FILES = {"package.json", "package-lock.json", "index.html", "vite.config.ts",
               "playwright.config.ts", "tsconfig.json", "tsconfig.app.json",
               "tsconfig.node.json", "tsconfig.tests.json"}
DEPLOY_FILES = {"api.Dockerfile", "api.Dockerfile.dockerignore", "admin.Dockerfile",
                "admin.Dockerfile.dockerignore", "admin-entrypoint.sh",
                "nginx.conf.template", "nginx-security-headers.conf", "compose.yaml", "ops.py"}
SOURCE_SUFFIXES = {".rs", ".toml", ".lock", ".sql", ".ts", ".tsx", ".mjs", ".css",
                   ".json", ".csv", ".html", ".svg", ".png", ".ico", ".woff", ".woff2", ".md", ".txt"}
IGNORED_PARTS = {"target", "node_modules", "dist", "test-results", "playwright-report",
                 "logs", "data", "__pycache__"}
TEST_KEYS = {f"crates/sitegraph-api/tests/oidc-keys/{name}{suffix}"
             for name in ("test-key", "rotated-key") for suffix in (".pem", ".pub.pem")}


def build_input(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError("Source paths must stay inside the repository")
    if name in ROOT_FILES:
        return True
    if any(part.startswith(".") or part in IGNORED_PARTS for part in path.parts):
        return False
    if name in TEST_KEYS:  # Public, non-production fixtures documented beside the keys.
        return True
    if path.suffix in {".pem", ".key", ".p12", ".age", ".log"}:
        return False
    if path.parts[0] in {"crates", "operator"}:
        return path.suffix in SOURCE_SUFFIXES
    if path.parts[0] == "migrations":
        return path.suffix == ".sql"
    if path.parts[0] == "admin":
        return ((len(path.parts) == 2 and path.name in ADMIN_FILES)
                or (len(path.parts) > 2 and path.parts[1] in {"src", "public", "tests", "scripts"}
                    and path.suffix in SOURCE_SUFFIXES))
    if name.startswith("deploy/saas/"):
        return ((len(path.parts) == 3 and path.name in DEPLOY_FILES)
                or (name.startswith("deploy/saas/helm/fireflint/")
                    and path.suffix in {".yaml", ".json", ".tpl", ".md", ".txt"}))
    if name.startswith("adapters/flintplate-contract/fixtures/"):
        return path.suffix == ".json"
    return name in {"tools/package_saas_release.py", "tools/test_saas_release_package.py",
                    "tools/check_saas_deploy.py", "tools/test_production_lifecycle.py"}


def freeze(root, output):
    root, output = root.resolve(), output.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("Output must not exist; an existing candidate is never overwritten")
    output = output.resolve()
    if output.is_relative_to(root):
        raise ValueError("Keep release artifacts outside the source repository")
    names = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=root)
    paths = sorted({name for name in os.fsdecode(names).split("\0") if name and build_input(name)})
    for required in ("Cargo.toml", "Cargo.lock", "admin/package.json", "admin/package-lock.json",
                     "deploy/saas/api.Dockerfile", "deploy/saas/admin.Dockerfile"):
        if required not in paths or not (root / required).exists():
            raise ValueError(f"Required build input missing: {required}")
    revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, text=True, capture_output=True)
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=normal"], cwd=root))
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".fireflint-source-", dir=output.parent))
    try:
        source = temporary / "source"
        source.mkdir()
        entries = []
        for name in paths:
            original = root / name
            # Reject symlink files and ancestor directories before reading bytes.
            if any(part.is_symlink() for part in [original, *original.parents] if part != root):
                raise ValueError(f"Symlinks are not release inputs: {name}")
            if not original.exists():  # A tracked deletion is absent from this candidate.
                continue
            metadata = original.stat()
            if not stat.S_ISREG(metadata.st_mode):
                raise ValueError(f"Non-regular release input: {name}")
            data = original.read_bytes()
            mode = 0o755 if metadata.st_mode & 0o111 else 0o644
            destination = source / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            destination.chmod(mode)
            entries.append({"path": name, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "mode": mode})
        source_sha = hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        archive_path = temporary / "source.tar.gz"
        with archive_path.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w") as archive:
                for entry in entries:
                    info = tarfile.TarInfo("source/" + entry["path"])
                    info.size, info.mode, info.mtime = entry["size"], entry["mode"], 0
                    with (source / entry["path"]).open("rb") as file:
                        archive.addfile(info, file)
        manifest = {"format": "fireflint-saas-source-v1", "git_revision": revision.stdout.strip() if revision.returncode == 0 else None,
                    "working_tree_dirty": dirty, "source_sha256": source_sha,
                    "archive_sha256": hashlib.sha256(archive_path.read_bytes()).hexdigest(), "files": entries}
        (temporary / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        temporary.rename(output)
        return manifest
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        manifest = freeze(ROOT, args.output)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Release source packaging failed: {error}\n")
    print(f"Frozen {len(manifest['files'])} build inputs; source SHA256 {manifest['source_sha256']}")
    print(f"Working tree dirty: {manifest['working_tree_dirty']}; inspect {args.output / 'manifest.json'} before publishing")


if __name__ == "__main__":
    main()
