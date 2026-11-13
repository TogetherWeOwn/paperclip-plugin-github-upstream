"""Provisional policy for selected fields of one ustar regular-file header.

Only magic/version, type, size and checksum encodings and name fields are
constrained here; other fields are not checked for canonical encoding. The
standard-library parser also parses numeric and text fields and can reject
malformed values in those fields; acceptance depends on its parser behavior.
This unit does not validate an archive or enforce paths, limits, or provenance.
It is not wired into the package inspector.
"""
import re
import tarfile


def parse_header(header):
    if len(header) != 512:
        raise ValueError("header must be exactly 512 bytes")
    if header[257:265] != b"ustar\0" + b"00" or header[156:157] != b"0":
        raise ValueError("unsupported format or type")
    if not re.fullmatch(rb"[0-7]{6}\x00 ", header[148:156]):
        raise ValueError("noncanonical checksum")
    if int(header[148:154], 8) != sum(header[:148]) + 8 * 32 + sum(header[156:]):
        raise ValueError("invalid unsigned checksum")
    if not re.fullmatch(rb"[0-7]{11}\x00", header[124:136]):
        raise ValueError("noncanonical size")
    try:
        tarfile.TarInfo.frombuf(header, encoding="utf-8", errors="strict")
    except (tarfile.HeaderError, UnicodeError) as exc:
        raise ValueError("invalid header") from exc

    def decode_field(raw):
        value, _, suffix = raw.partition(b"\0")
        if any(suffix):
            raise ValueError("hidden name bytes")
        return value.decode("utf-8", "strict")

    name = decode_field(header[:100])
    prefix = decode_field(header[345:500])
    if not name:
        raise ValueError("empty name")
    return (prefix + "/" + name if prefix else name, int(header[124:135], 8))
