import os, sys, json, io, wave
os.environ['HF_HUB_OFFLINE']='1'
os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
os.environ['UCX_VFS_ENABLE']='n'
from pathlib import Path
import numpy as np
from faster_whisper import WhisperModel
import time
from model_config import model_path as configured_model_path
model_path=configured_model_path()
try:
 requested_language=sys.argv[2] if len(sys.argv)>2 else 'auto'
 if requested_language not in ('auto','zh','en'): raise ValueError('Language must be auto, zh or en')
 from audio_decode import decode_audio, _compressed_format
 data=sys.stdin.buffer.read(4194305)
 if len(data)>4194304: raise ValueError('Audio exceeds 4 MiB')
 actual='wav' if data.startswith(b'RIFF') and data[8:12]==b'WAVE' else _compressed_format(data)
 if actual!=sys.argv[1]: raise ValueError('Audio content does not match declared format')
 audio=decode_audio(data)
 model=WhisperModel(str(model_path),device='cpu',compute_type='int8',cpu_threads=4,num_workers=1,local_files_only=True)
 start=time.monotonic()
 segments,info=model.transcribe(audio,language=None if requested_language=='auto' else requested_language,beam_size=5,vad_filter=False,condition_on_previous_text=False)
 parts=[{'start':s.start,'end':s.end,'text':s.text} for s in segments]
 print(json.dumps({'text':''.join(x['text'] for x in parts).strip(),'segments':parts,'duration_seconds':len(audio)/16000,'inference_seconds':time.monotonic()-start,'language':info.language,'requested_language':requested_language,'language_source':'first-chunk-detection' if requested_language=='auto' else 'user-selected','language_probability':info.language_probability if requested_language=='auto' else None}))
except Exception as e:
 print(json.dumps({'error':str(e)}));sys.exit(1)
