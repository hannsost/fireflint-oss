#!/usr/bin/env python3
"""Check credential/state exclusion and source identity without accessing real configuration."""
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

from package_saas_release import freeze


class SourcePackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        self.repo = self.parent / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        for name in ("Cargo.toml", "Cargo.lock", "admin/package.json", "admin/package-lock.json",
                     "deploy/saas/api.Dockerfile", "deploy/saas/admin.Dockerfile", "crates/api/src/lib.rs"):
            self.put(name, "public build fixture\n")

    def put(self, name, content):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def test_uncommitted_inputs_are_reproducible_and_state_is_excluded(self):
        excluded = [".env", "admin/.env.production", "admin/node_modules/pkg/index.ts",
                    "admin/dist/runtime.json", "deploy/saas/customer-secret.yaml", "data/customers.json",
                    "crates/api/key.pem", "admin/test-results/session.json"]
        for name in excluded:
            self.put(name, "must never enter release\n")
        first, second = [freeze(self.repo, self.parent / name) for name in ("a", "b")]
        self.assertEqual(first, second)
        self.assertTrue(first["working_tree_dirty"])
        included = {entry["path"] for entry in first["files"]}
        self.assertIn("crates/api/src/lib.rs", included)
        self.assertFalse(included.intersection(excluded))
        with tarfile.open(self.parent / "a/source.tar.gz") as archive:
            self.assertEqual({member.name for member in archive}, {"source/" + name for name in included})
        self.put("crates/api/src/lib.rs", "changed source\n")
        changed = freeze(self.repo, self.parent / "c")
        self.assertNotEqual(first["source_sha256"], changed["source_sha256"])

    def test_symlink_is_rejected_without_reading_target(self):
        target = self.parent / "private.json"
        target.write_text("never copy")
        (self.repo / "admin/src").mkdir()
        (self.repo / "admin/src/config.json").symlink_to(target)
        with self.assertRaisesRegex(ValueError, "Symlinks"):
            freeze(self.repo, self.parent / "bad")
        self.assertFalse((self.parent / "bad").exists())

    def test_candidate_cannot_overwrite_an_existing_release(self):
        output = self.parent / "candidate"
        manifest = freeze(self.repo, output)
        with self.assertRaisesRegex(ValueError, "must not exist"):
            freeze(self.repo, output)
        self.assertEqual(json.loads((output / "manifest.json").read_text()), manifest)
        with self.assertRaisesRegex(ValueError, "outside"):
            freeze(self.repo, self.repo / "release")


if __name__ == "__main__":
    unittest.main()
