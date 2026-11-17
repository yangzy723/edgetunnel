#!/usr/bin/env python3
"""Prepare anonymous MP3 publishing copies without transcoding or changing originals."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def strip_tags(data):
    while data.startswith(b'ID3'):
        if len(data) < 10 or any(byte & 0x80 for byte in data[6:10]):
            raise ValueError('Invalid ID3 header')
        size = sum(byte << shift for byte, shift in zip(data[6:10], (21,14,7,0)))
        end = 10 + size
        if end > len(data):
            raise ValueError('Truncated ID3 tag')
        # Some ID3v2.4 writers place a footer immediately after the tag body.
        if data[end:end+3] == b'3DI':
            end += 10
        data = data[end:]
    if data[-128:-125] == b'TAG':
        data = data[:-128]
    if data[-32:-24] == b'APETAGEX':
        size = int.from_bytes(data[-20:-16], 'little')
        if size < 32 or size > len(data):
            raise ValueError('Invalid APE tag')
        end = len(data)-size
        if data[max(0,end-32):end-24] == b'APETAGEX':
            end -= 32
        data = data[:end]
    if len(data) < 4 or data[0] != 255 or data[1] & 224 != 224:
        raise ValueError('Expected MP3 audio frames after removing tags')
    return data

def prepare():
    prepared = []
    for letter in 'ABCD':
        source = ROOT / f'Test-{letter}.mp3'
        prepared.append((letter, strip_tags(source.read_bytes())))
    (ROOT/'audio').mkdir(exist_ok=True)
    for letter, content in prepared:
        (ROOT/'audio'/f'track-{letter.lower()}.mp3').write_bytes(content)
        print(f'Prepared question {letter}: {len(content)} bytes')

if __name__ == '__main__':
    prepare()
