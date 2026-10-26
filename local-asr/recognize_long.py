import sys
sys.dont_write_bytecode = True
from worker_fence import validated_fds
WRITER_FDS = validated_fds()
from worker_fence import watch_owner
watch_owner()
import os, sys, json, time, math, hashlib, importlib.metadata, threading, tempfile
from pathlib import Path
os.environ.update(HF_HUB_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',UCX_VFS_ENABLE='n')
import numpy as np
import ctranslate2
from long_decode import decode_to_disk
from merge_words import merge_words
from public_errors import public_error

def emit(value): print(json.dumps(value),flush=True)
def digest(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''): h.update(block)
    return h.hexdigest()
def atomic(path,value):
    data=json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
    if len(data)>16700000: raise ValueError('Checkpoint output limit exceeded; re-upload required')
    envelope={'sha256':hashlib.sha256(data).hexdigest(),'payload':value}
    fd,temporary=tempfile.mkstemp(prefix='.checkpoint-',suffix='.tmp',dir=path.parent)
    try:
        with os.fdopen(fd,'w') as f:
            json.dump(envelope,f,allow_nan=False); f.flush(); os.fsync(f.fileno())
        os.replace(temporary,path)
        fd=os.open(path.parent,os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if os.path.lexists(temporary): os.unlink(temporary)
def load(path):
    if path.stat().st_size>16777216: raise ValueError('Checkpoint too large')
    value=json.loads(path.read_text())
    raw=json.dumps(value['payload'],sort_keys=True,separators=(',',':'),allow_nan=False).encode()
    if hashlib.sha256(raw).hexdigest()!=value['sha256']: raise ValueError('Checkpoint checksum mismatch')
    return value['payload']
try:
    source,fmt,maximum,byte_limit,requested_language=sys.argv[1:]
    if requested_language not in ('auto','zh','en'): raise ValueError('Language must be auto, zh or en')
    language=None if requested_language=='auto' else requested_language
    probability=None
    pcm=Path(source).parent/'decoded.pcm'
    directory=Path(source).parent
    manifest=json.loads((directory/'pending.json').read_text())
    if time.time()*1000>=manifest['expiresAt']: raise ValueError('Pending audio expired; re-upload required')
    if manifest['format']!=fmt or manifest['language']!=requested_language or manifest['maximum']!=int(maximum) or manifest['byteLimit']!=int(byte_limit): raise ValueError('Settings changed; re-upload required')
    from faster_whisper import WhisperModel
    from model_config import model_path as configured_model_path
    model_path=configured_model_path()
    identity={'jobId':manifest['id'],'model':{f.name:digest(f) for f in sorted(model_path.iterdir()) if f.is_file()},
              'algorithm':{f:digest(Path(__file__).parent/f) for f in ('recognize_long.py','long_decode.py','merge_words.py','model_config.py','worker_fence.py')},
              'packages':{p:importlib.metadata.version(p) for p in ('faster-whisper','ctranslate2','numpy','av')},
              'settings':{'device':'cpu','compute_type':'int8','beam_size':5,'temperature':0.0,'vad_filter':False,'condition_on_previous_text':False,'word_timestamps':True,'cpu_threads':4,'num_workers':1,'window':30,'stride':29,'language':requested_language},
              'sourceHash':manifest['sourceHash'],'samplingSeedPolicy':'ctranslate2-sha256-source-chunk-v1'}
    checkpoint=directory/'checkpoint.json'
    if checkpoint.exists():
        state=load(checkpoint)
        if state['identity']!=identity: raise ValueError('Model, source or algorithm identity changed; re-upload required')
        if digest(pcm)!=state['pcmHash']: raise ValueError('Source PCM hash mismatch; re-upload required')
        samples=state['samples']; chunks=state['chunks']; language=state['language']; probability=state['probability']
        if pcm.stat().st_size!=samples*2 or not 0<samples<=int(maximum)*16000: raise ValueError('Invalid checkpoint sample count')
    else:
        if digest(source)!=manifest['sourceHash']: raise ValueError('Source hash mismatch; re-upload required')
        pcm.unlink(missing_ok=True)
        samples=decode_to_disk(source,fmt,pcm,int(byte_limit),int(maximum))
        with open(pcm,'rb') as f: os.fsync(f.fileno())
        chunks=[]
        state={'identity':identity,'pcmHash':digest(pcm),'samples':samples,'chunks':chunks,'language':language,'probability':probability}
        atomic(checkpoint,state)
    Path(source).unlink(missing_ok=True)
    duration=samples/16000; step=29; total=max(1,math.ceil(max(0,duration-1)/step))
    if len(chunks)>total or [c['index'] for c in chunks]!=list(range(len(chunks))): raise ValueError('Invalid checkpoint chunk sequence')
    if requested_language!='auto' and language!=requested_language: raise ValueError('Checkpoint language mismatch')
    for saved in chunks:
        for word in saved['words']:
            if word['chunk']!=saved['index'] or not isinstance(word['text'],str) or not all(isinstance(word[k],(int,float)) and math.isfinite(word[k]) for k in ('start','end')) or not 0<=word['start']<=word['end']<=duration: raise ValueError('Invalid checkpoint word')
    emit({'type':'progress','completedChunks':len(chunks),'totalChunks':total,'durationSeconds':duration,'requested_language':requested_language,'language':language,'language_probability':probability})
    model=WhisperModel(str(model_path),device='cpu',compute_type='int8',cpu_threads=4,num_workers=1,local_files_only=True)
    start=time.monotonic(); words=[]; boundaries=[]
    with open(pcm,'rb') as audio:
        for saved in chunks:
            words,method=merge_words(words,saved['words'],saved['index']*step)
            if saved['index']: boundaries.append({'offset':saved['index']*step,'method':method})
        for index in range(len(chunks),total):
            offset=index*step
            audio.seek(offset*32000)
            chunk=np.frombuffer(audio.read(30*32000),dtype='<i2').astype(np.float32)/32768.0
            seed_material=f"ctranslate2-sha256-source-chunk-v1:{manifest['sourceHash']}:{index}"
            ctranslate2.set_random_seed(int(hashlib.sha256(seed_material.encode()).hexdigest()[:8],16))
            segments,info=model.transcribe(chunk,language=language,beam_size=5,temperature=0.0,vad_filter=False,condition_on_previous_text=False,word_timestamps=True)
            if language is None:
                language=info.language
                probability=float(info.language_probability)
            current=[]
            for segment in segments:
                for word in segment.words or []:
                    a=max(0,min(duration,offset+word.start)); b=max(a,min(duration,offset+word.end))
                    if word.word.strip():
                        current.append({'start':round(a,3),'end':round(b,3),'text':word.word,'chunk':index})
            chunks.append({'index':index,'words':current})
            state.update(chunks=chunks,language=language,probability=probability)
            atomic(checkpoint,state)
            words,method=merge_words(words,current,offset)
            if index: boundaries.append({'offset':offset,'method':method})
            emit({'type':'progress','completedChunks':index+1,'totalChunks':total,'durationSeconds':duration,'requested_language':requested_language,'language':language,'language_probability':probability})
    end=0
    for word in words:
        word['start']=max(end,word['start']); word['end']=max(word['start'],word['end']); end=word['end']
    emit({'type':'result','text':''.join(w['text'] for w in words).strip(),'segments':words,'duration_seconds':duration,'inference_seconds':time.monotonic()-start,'language':language,'requested_language':requested_language,'language_probability':probability,'language_source':'first-chunk-detection' if requested_language=='auto' else 'user-selected','chunks':total,'chunk_receipts':[{'index':c['index'],'sha256':hashlib.sha256(json.dumps(c,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()} for c in chunks],'merge':'bounded token overlap alignment; uncertain boundaries use midpoint ownership','boundaries':boundaries})
except Exception as exc:
    emit(public_error(exc)); sys.exit(1)
