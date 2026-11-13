"""Synthetic tar framing cases; these are not observed npm output."""
import importlib.util
from pathlib import Path
import unittest


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


framing = load("framing", "tar-framing-policy.py")
headers = load("header_fixtures", "tar-header-policy.test.py")
ZERO = bytes(512)


def member(name, body):
    padding = bytes((-len(body)) % 512)
    return headers.fixture(name.encode(), size=len(body)) + body + padding


class TarFramingTest(unittest.TestCase):
    def test_members_and_offsets(self):
        archive = member("package/a", b"abc") + member("package/b", bytes(512)) + ZERO * 2
        self.assertEqual(framing.inspect_framing(archive),
                         [("package/a", 512, 3), ("package/b", 1536, 512)])
        self.assertEqual(framing.inspect_framing(ZERO * 2), [])

    def test_rejects_truncation_padding_and_trailing_data(self):
        entry = member("package/a", b"abc")
        cases = [(entry + ZERO, "missing tar terminator"),
                 (entry[:-1], "unaligned tar length"),
                 (entry[:515] + b"x" + entry[516:] + ZERO * 2, "nonzero member padding"),
                 (entry + ZERO + member("other", b"") + ZERO * 2, "nonzero bytes after terminator"),
                 (entry + ZERO * 2 + b"x" + bytes(511), "nonzero bytes after terminator"),
                 (headers.fixture(b"a", size=4096) + ZERO * 2, "truncated tar member")]
        for archive, reason in cases:
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError, reason):
                framing.inspect_framing(archive)

    def test_duplicate_header_and_member_limit(self):
        entry = member("a", b"")
        with self.assertRaisesRegex(ValueError, "duplicate tar member"):
            framing.inspect_framing(entry * 2 + ZERO * 2)
        unsplit = headers.fixture(b"package/file", size=0)
        split = headers.fixture(b"file", prefix=b"package", size=0)
        with self.assertRaisesRegex(ValueError, "duplicate tar member"):
            framing.inspect_framing(unsplit + split + ZERO * 2)
        many = b"".join(member("f%d" % i, b"") for i in range(framing.MAX_MEMBERS))
        self.assertEqual(len(framing.inspect_framing(many + ZERO * 2)), framing.MAX_MEMBERS)
        with self.assertRaisesRegex(ValueError, "too many tar members"):
            framing.inspect_framing(many + member("extra", b"") + ZERO * 2)
        corrupt = bytearray(entry)
        corrupt[0] ^= 1
        with self.assertRaisesRegex(ValueError, "checksum"):
            framing.inspect_framing(bytes(corrupt) + ZERO * 2)

    def test_input_bounds(self):
        self.assertEqual(framing.inspect_framing(bytes(framing.MAX_BYTES)), [])
        with self.assertRaisesRegex(ValueError, "missing tar terminator"):
            framing.inspect_framing(ZERO)
        with self.assertRaisesRegex(ValueError, "invalid or oversized"):
            framing.inspect_framing(bytearray(1024))
        with self.assertRaisesRegex(ValueError, "invalid or oversized"):
            framing.inspect_framing(bytes(framing.MAX_BYTES + 512))


if __name__ == "__main__":
    unittest.main()
