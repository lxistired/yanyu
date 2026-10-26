import os,json,time,wave
from pathlib import Path
os.environ.update(HF_HUB_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',UCX_VFS_ENABLE='n',OPENBLAS_NUM_THREADS='1')
import numpy as np
from faster_whisper import WhisperModel
p=Path(__file__).parent
with wave.open(str(p/'synthetic-long.wav'),'rb') as w: audio=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2').astype(np.float32)/32768
model=WhisperModel(str(p.resolve().parents[2]/'lesson-audio/models/models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120'),device='cpu',compute_type='int8',cpu_threads=4,num_workers=1,local_files_only=True)
def run(audio,offset=0):
 segments,_=model.transcribe(audio,language='en',beam_size=5,vad_filter=False,condition_on_previous_text=False,word_timestamps=True)
 return [{'start':round(offset+w.start,3),'end':round(offset+w.end,3),'text':w.word} for s in segments for w in s.words or []]
full=run(audio)
chunks=[run(audio[int(i*29*16000):int((i*29+30)*16000)],i*29) for i in range(3)]
(p/'BOUNDARY_REFERENCE_RESULT.json').write_text(json.dumps({'duration':75,'sourceText':(p/'synthetic-text.txt').read_text(),'sourceRepetitionSeconds':12.4,'continuous':full,'rawChunks':chunks},indent=2))
print('Reference comparison complete')
