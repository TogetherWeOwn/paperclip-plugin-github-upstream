import hashlib
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

from prepare_artifacts import extract_package


def package(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, contents in entries:
            info = tarfile.TarInfo(name)
            info.size = len(contents)
            archive.addfile(info, io.BytesIO(contents))
    return output.getvalue()


class ArtifactExtractionTest(unittest.TestCase):
    def test_extracts_only_pinned_safe_members(self):
        data = package([("package/package.json", b"{}"), ("package/dist/worker.js", b"worker")])
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "candidate"
            extract_package(data, hashlib.sha256(data).hexdigest(), dest)
            self.assertEqual((dest / "dist/worker.js").read_bytes(), b"worker")
            with self.assertRaises(FileExistsError):
                extract_package(data, hashlib.sha256(data).hexdigest(), dest)

    def test_rejects_bad_digest_and_path_traversal(self):
        data = package([("package/package.json", b"{}"), ("package/dist/worker.js", b"worker"),
                        ("package/../../escape", b"bad")])
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                extract_package(data, "0" * 64, Path(tmp) / "bad-digest")
            with self.assertRaises(ValueError):
                extract_package(data, hashlib.sha256(data).hexdigest(), Path(tmp) / "bad-path")
            self.assertFalse((Path(tmp) / "escape").exists())

    def test_rejects_duplicate_members(self):
        data = package([("package/package.json", b"{}"), ("package/dist/worker.js", b"a"),
                        ("package/dist/worker.js", b"b")])
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                extract_package(data, hashlib.sha256(data).hexdigest(), Path(tmp) / "duplicate")


if __name__ == "__main__":
    unittest.main()
