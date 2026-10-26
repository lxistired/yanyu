"""Bounded local decoding; Linux FFmpeg fixture, no URLs or filename delegation.

Deliberately strict compressed profile: MPEG Layer III MP3, standalone Ogg with
EOS, and complete ISO-BMFF M4A. Not a general-purpose media/file parser sandbox.
"""
from worker_fence import validated_fds
import io
import os
from pathlib import Path
import selectors
import stat
import struct
import subprocess
import tempfile
import time
import wave
import numpy as np

MAX_BYTES = 4 * 1024 * 1024
MAX_SECONDS = 30
MAX_PCM_BYTES = 16000 * MAX_SECONDS * 2
DECODE_TIMEOUT = 10


def _read(source):
    if isinstance(source, (str, Path)):
        # Reject URLs, pipes, devices, directories and symlinks before reading.
        name = os.fspath(source)
        if '://' in name or '\x00' in name:
            raise ValueError('Local regular audio files only')
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
                raise ValueError('Invalid input file or size')
            data = handle.read(MAX_BYTES + 1)
    elif isinstance(source, (bytes, bytearray)):
        data = bytes(source)
    elif isinstance(source, io.BytesIO):
        data = source.read(MAX_BYTES + 1)
    else:
        raise ValueError('Unsupported input source')
    if not 0 < len(data) <= MAX_BYTES:
        raise ValueError('Invalid input size')
    return data


def _compressed_format(data):
    if data.startswith(b'OggS'):
        pos = 0
        eos = False
        serial = None
        seq = 0
        while pos < len(data):
            if eos or data[pos:pos+4] != b'OggS' or pos+27 > len(data) or data[pos+4] != 0:
                raise ValueError('Invalid Ogg framing')
            page_serial, page_seq = struct.unpack_from('<II', data, pos+14)
            if serial is None:
                serial = page_serial
            if page_serial != serial or page_seq != seq:
                raise ValueError('Chained/multiplexed/incomplete Ogg unsupported')
            seq += 1
            n = data[pos+26]
            if pos+27+n > len(data):
                raise ValueError('Truncated Ogg page')
            size = 27+n+sum(data[pos+27:pos+27+n])
            if pos+size > len(data):
                raise ValueError('Truncated Ogg payload')
            eos = bool(data[pos+5] & 4)
            pos += size
        if not eos:
            raise ValueError('Missing Ogg end marker')
        return 'ogg'
    if len(data) >= 12 and data[4:8] == b'ftyp':
        pos = 0
        boxes = set()
        while pos < len(data):
            if pos+8 > len(data):
                raise ValueError('Truncated M4A box')
            size = int.from_bytes(data[pos:pos+4], 'big')
            kind = data[pos+4:pos+8]
            header = 8
            if size == 1:
                if pos+16 > len(data):
                    raise ValueError('Truncated M4A box')
                size = int.from_bytes(data[pos+8:pos+16], 'big'); header = 16
            # Size-to-EOF obscures truncation; refuse it in this strict profile.
            if size < header or pos+size > len(data):
                raise ValueError('Invalid M4A box size')
            boxes.add(kind); pos += size
        if not {b'ftyp', b'moov', b'mdat'} <= boxes:
            raise ValueError('Incomplete M4A')
        return 'mov'
    # Validate every complete MPEG Layer III frame (no free-bitrate streams).
    pos = 0
    if data.startswith(b'ID3'):
        if len(data) < 10 or any(x & 128 for x in data[6:10]):
            raise ValueError('Invalid ID3 header')
        size = sum(x << (7*(3-i)) for i, x in enumerate(data[6:10]))
        pos = 10 + size + (10 if data[5] & 16 else 0)
    frames = 0
    while pos < len(data):
        if len(data)-pos == 128 and data[pos:pos+3] == b'TAG':
            pos += 128; break
        if pos+4 > len(data):
            raise ValueError('Truncated MP3 header')
        h = int.from_bytes(data[pos:pos+4], 'big')
        ver = (h >> 19) & 3; layer = (h >> 17) & 3
        bit = (h >> 12) & 15; rate = (h >> 10) & 3
        if h >> 21 != 0x7ff or ver == 1 or layer != 1 or bit in (0,15) or rate == 3:
            raise ValueError('Unsupported audio/MP3 frame')
        bitrate = ([0,32,40,48,56,64,80,96,112,128,160,192,224,256,320][bit] if ver == 3 else [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160][bit]) * 1000
        hz = [44100,48000,32000][rate] // ({3:1,2:2,0:4}[ver])
        size = (144 if ver == 3 else 72)*bitrate//hz + ((h >> 9)&1)
        if pos+size > len(data):
            raise ValueError('Truncated MP3 frame')
        if frames == 0:
            # Xing/Info byte-count catches truncation even on a frame boundary.
            mono = ((h >> 6) & 3) == 3
            side = (17 if mono else 32) if ver == 3 else (9 if mono else 17)
            offset = pos + 4 + (2 if not ((h >> 16) & 1) else 0) + side
            if data[offset:offset+4] in (b'Xing', b'Info'):
                flags = int.from_bytes(data[offset+4:offset+8], 'big')
                p = offset+8+(4 if flags&1 else 0)
                if not flags & 2 or int.from_bytes(data[p:p+4], 'big') != len(data)-pos:
                    raise ValueError('MP3 declared byte count missing/mismatch')
            else:
                raise ValueError('MP3 requires Xing/Info byte count for completeness')
        pos += size; frames += 1
    if not frames:
        raise ValueError('No audio frames')
    return 'mp3'


def decode_to_disk(source, fmt, destination, max_bytes, max_seconds):
    writer_fds = validated_fds()
    global MAX_BYTES
    MAX_BYTES = max_bytes
    data = _read(source)
    actual = 'wav' if data.startswith(b'RIFF') else _compressed_format(data)
    if actual != fmt:
        raise ValueError('Content and MIME mismatch')
    if fmt == 'wav':
        if len(data)<12 or data[8:12]!=b'WAVE' or int.from_bytes(data[4:8],'little')+8!=len(data):
            raise ValueError('Invalid WAV framing')
        with wave.open(io.BytesIO(data),'rb') as wav:
            n=wav.getnframes()
            if wav.getframerate()!=16000 or wav.getnchannels()!=1 or wav.getsampwidth()!=2 or wav.getcomptype()!='NONE':
                raise ValueError('Only mono 16 kHz PCM16 WAV accepted')
            if not 0<n<=16000*max_seconds or len(wav.readframes(n))!=n*2:
                raise ValueError('Invalid WAV duration or truncated payload')
    if fmt == 'wav':
        with wave.open(io.BytesIO(data),'rb') as wav, open(destination,'xb') as out:
            while True:
                block=wav.readframes(32768)
                if not block: break
                out.write(block)
        return n
    del data
    # Parent creates an exclusively-owned regular input path. No caller URL reaches FFmpeg.
    cmd=['/usr/bin/prlimit','--as=536870912','--cpu=120','--nofile=64','--fsize=0','--',
         '/usr/bin/ffmpeg','-hide_banner','-nostdin','-loglevel','warning','-xerror',
         '-max_alloc','67108864','-threads','1','-protocol_whitelist','file','-f',fmt]
    if fmt=='mov': cmd += ['-enable_drefs','0','-use_absolute_path','0']
    cmd += ['-i',str(source),'-map','0:a:0','-vn','-sn','-dn','-threads','1','-ac','1','-ar','16000',
            '-t',str(max_seconds+.1),'-f','s16le','-acodec','pcm_s16le','pipe:1']
    proc=subprocess.Popen(cmd,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                          env={'PATH':'/usr/bin:/bin','LANG':'C','OPENBLAS_NUM_THREADS':'1'}, pass_fds=writer_fds)
    size=0; errors=bytearray(); deadline=time.monotonic()+120
    try:
        with open(destination,'xb') as out, selectors.DefaultSelector() as sel:
            for stream in (proc.stdout,proc.stderr): sel.register(stream,selectors.EVENT_READ)
            while sel.get_map():
                remain=deadline-time.monotonic()
                if remain<=0: raise ValueError('Decode deadline exceeded')
                for key,_ in sel.select(min(remain,1)):
                    piece=os.read(key.fileobj.fileno(),65536)
                    if not piece: sel.unregister(key.fileobj); continue
                    if key.fileobj is proc.stdout:
                        size+=len(piece)
                        if size>max_seconds*32000: raise ValueError('Decoded PCM duration/bytes limit exceeded')
                        out.write(piece)
                    else:
                        errors.extend(piece)
                        if len(errors)>16384: raise ValueError('Decoder diagnostics limit exceeded')
            status=proc.wait(timeout=max(.001,deadline-time.monotonic()))
            if status or errors or not size or size%2: raise ValueError('Invalid, truncated or unsupported audio')
        return size//2
    finally:
        if proc.poll() is None: proc.kill()
        proc.wait(); proc.stdout.close(); proc.stderr.close()
