"""Recreate stereo-opus.ogg using system libopus; no dependency in test runs.

The fixture contains 2.5 seconds of deterministic 440/660 Hz stereo tones at
48 kHz. Each page has a real Ogg CRC, and the final granule trims encoder delay.
"""

import ctypes
import ctypes.util
import math
from pathlib import Path
import struct


def ogg_crc(data):
    crc = 0
    for byte in data:
        crc ^= byte << 24
        for _ in range(8):
            crc = ((crc << 1) ^ (0x04C11DB7 if crc & 0x80000000 else 0)) & 0xFFFFFFFF
    return crc


def ogg_page(packet, sequence, granule=0, flags=0):
    lacing = bytes([255] * (len(packet) // 255) + [len(packet) % 255])
    page = bytearray(struct.pack("<4sBBQIIIB", b"OggS", 0, flags, granule,
                                 0x50524357, sequence, 0, len(lacing)) + lacing + packet)
    struct.pack_into("<I", page, 22, ogg_crc(page))
    return bytes(page)


def main():
    opus = ctypes.CDLL(ctypes.util.find_library("opus"))
    opus.opus_encoder_create.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                        ctypes.POINTER(ctypes.c_int)]
    opus.opus_encoder_create.restype = ctypes.c_void_p
    opus.opus_encoder_ctl.argtypes = [ctypes.c_void_p, ctypes.c_int]
    opus.opus_encode.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int16),
                                ctypes.c_int, ctypes.POINTER(ctypes.c_ubyte), ctypes.c_int]
    opus.opus_encoder_destroy.argtypes = [ctypes.c_void_p]
    error = ctypes.c_int()
    encoder = opus.opus_encoder_create(48000, 2, 2049, ctypes.byref(error))
    if not encoder or error.value:
        raise RuntimeError(f"Opus initialization failed: {error.value}")
    try:
        # OPUS_SET_BITRATE_REQUEST and OPUS_GET_LOOKAHEAD_REQUEST.
        if opus.opus_encoder_ctl(encoder, 4002, 192000):
            raise RuntimeError("Opus bitrate configuration failed")
        delay = ctypes.c_int()
        if opus.opus_encoder_ctl(encoder, 4027, ctypes.byref(delay)):
            raise RuntimeError("Cannot read Opus encoder delay")
        head = b"OpusHead" + struct.pack("<BBHIhB", 1, 2, delay.value, 48000, 0, 0)
        vendor = b"Preciseweb generated sine-wave test fixture"
        tags = b"OpusTags" + struct.pack("<I", len(vendor)) + vendor + struct.pack("<I", 0)
        pages = [ogg_page(head, 0, flags=2), ogg_page(tags, 1)]
        frames = 120000
        packet_frames = 960
        packet_count = math.ceil((frames + delay.value) / packet_frames)
        samples = (ctypes.c_int16 * (packet_frames * 2))()
        output = (ctypes.c_ubyte * 4000)()
        for index in range(packet_count):
            for frame in range(packet_frames):
                position = index * packet_frames + frame
                for channel, frequency in enumerate((440, 660)):
                    samples[frame * 2 + channel] = (round(math.sin(position * 2 * math.pi * frequency / 48000) * 4000)
                                                   if position < frames else 0)
            size = opus.opus_encode(encoder, samples, packet_frames, output, len(output))
            if size < 0:
                raise RuntimeError(f"Opus encoding failed: {size}")
            final = index == packet_count - 1
            granule = min((index + 1) * packet_frames, frames + delay.value)
            pages.append(ogg_page(bytes(output[:size]), index + 2, granule, 4 if final else 0))
        destination = Path(__file__).with_name("stereo-opus.ogg")
        destination.write_bytes(b"".join(pages))
        print(f"Wrote {destination.name}: {destination.stat().st_size} bytes")
    finally:
        opus.opus_encoder_destroy(encoder)


if __name__ == "__main__":
    main()
