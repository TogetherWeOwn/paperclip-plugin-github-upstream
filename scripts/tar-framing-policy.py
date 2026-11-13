"""Provisional framing check for an already-decompressed tar byte string.

This does not decompress, extract, validate paths or approve a package. Its
caller must independently bound decompression before allocating these bytes.
It is not connected to the packaging route.
"""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "tar_header_policy", Path(__file__).with_name("tar-header-policy.py")
)
header_policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(header_policy)

BLOCK = 512
MAX_BYTES = 16 * 1024 * 1024
MAX_MEMBERS = 200


def inspect_framing(data):
    if type(data) is not bytes or len(data) > MAX_BYTES:
        raise ValueError("invalid or oversized tar bytes")
    if len(data) % BLOCK:
        raise ValueError("unaligned tar length")
    offset = 0
    members = []
    names = set()
    while True:
        if offset + 2 * BLOCK > len(data):
            raise ValueError("missing tar terminator")
        block = data[offset:offset + BLOCK]
        if block == bytes(BLOCK):
            if any(data[offset:]):
                raise ValueError("nonzero bytes after terminator")
            return members
        if len(members) == MAX_MEMBERS:
            raise ValueError("too many tar members")
        name, size = header_policy.parse_header(block)
        if name in names:
            raise ValueError("duplicate tar member")
        names.add(name)
        start = offset + BLOCK
        end = start + size
        padded_end = start + ((size + BLOCK - 1) // BLOCK) * BLOCK
        if padded_end > len(data):
            raise ValueError("truncated tar member")
        if any(data[end:padded_end]):
            raise ValueError("nonzero member padding")
        members.append((name, start, size))
        offset = padded_end
