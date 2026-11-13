"""Independently assembled raw headers for the provisional header policy."""
import importlib.util
from pathlib import Path
import tarfile
import unittest

spec = importlib.util.spec_from_file_location("policy", Path(__file__).with_name("tar-header-policy.py"))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def seal(header):
    header = bytearray(header)
    header[148:156] = b" " * 8
    header[148:156] = ("%06o\0 " % sum(header)).encode("ascii")
    return bytes(header)


def fixture(name=b"file", prefix=b"", size=2):
    header = bytearray(512)
    header[:len(name)] = name
    header[100:108] = b"0000644\0"
    header[108:124] = b"0000000\0" * 2
    header[124:136] = ("%011o\0" % size).encode("ascii")
    header[136:148] = b"00000000000\0"
    header[156] = ord("0")
    header[257:265] = b"ustar\0" + b"00"
    header[345:345 + len(prefix)] = prefix
    return seal(header)


class HeaderPolicyTest(unittest.TestCase):
    def test_canonical_values(self):
        cases = [(b"file", b"", 0), (b"a", b"package/sub", 2),
                 (b"file", b"", 512), (b"a" * 100, b"p" * 155, 513),
                 ("café".encode(), b"package", 1)]
        for name, prefix, size in cases:
            with self.subTest(name=name, prefix=prefix, size=size):
                expected = ((prefix + b"/" if prefix else b"") + name).decode("utf-8")
                self.assertEqual(policy.parse_header(fixture(name, prefix, size)), (expected, size))

    def test_wrong_lengths_and_checksum(self):
        good = fixture()
        broken = bytearray(good)
        broken[0] ^= 1
        for header in (good[:-1], good + b"x", bytes(broken)):
            with self.subTest(length=len(header)):
                with self.assertRaises(ValueError):
                    policy.parse_header(header)

    def test_signed_checksum_is_rejected(self):
        unsigned = fixture("café".encode(), b"package")
        header = bytearray(unsigned)
        header[148:156] = b" " * 8
        signed_sum = sum(byte if byte < 128 else byte - 256 for byte in header)
        header[148:156] = ("%06o\0 " % signed_sum).encode("ascii")
        signed = bytes(header)
        self.assertNotEqual(signed[148:156], unsigned[148:156])
        self.assertEqual(tarfile.TarInfo.frombuf(signed, "utf-8", "strict").name, "package/café")
        self.assertEqual(policy.parse_header(unsigned), ("package/café", 2))
        with self.assertRaises(ValueError):
            policy.parse_header(signed)

    def test_noncanonical_fields(self):
        cases = [(124, b"\x80" + bytes(10) + b"\x02"),
                 (124, b"          2\0"), (124, b"00000000002 "),
                 (124, b"00000000008\0"), (156, b"\0"), (156, b"x"),
                 (257, b"ustar  \0"), (263, b"01"), (257, b"x"),
                 (0, b"a\0hidden"), (345, b"dir\0hidden"), (0, b"\xff")]
        for offset, value in cases:
            header = bytearray(fixture())
            header[offset:offset + len(value)] = value
            with self.subTest(offset=offset, value=value):
                with self.assertRaises(ValueError):
                    policy.parse_header(seal(header))
        empty_name = bytearray(fixture())
        empty_name[:100] = bytes(100)
        with self.assertRaises(ValueError):
            policy.parse_header(seal(empty_name))

    def test_other_fields_follow_standard_library_parsing(self):
        for offset, value in ((100, b"invalid\0"), (157, b"\xff"), (265, b"\xff")):
            header = bytearray(fixture())
            header[offset:offset + len(value)] = value
            with self.subTest(offset=offset):
                with self.assertRaises(ValueError):
                    policy.parse_header(seal(header))

        header = bytearray(fixture())
        header[100:108] = b"\x80" + bytes(6) + b"\x01"
        self.assertEqual(policy.parse_header(seal(header)), ("file", 2))

    def test_noncanonical_checksum_terminator(self):
        header = bytearray(fixture())
        header[154] = ord(" ")
        with self.assertRaises(ValueError):
            policy.parse_header(bytes(header))


if __name__ == "__main__":
    unittest.main()
