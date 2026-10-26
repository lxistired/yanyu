"""Contract test: auto is detected once, then frozen across all chunk calls."""
import io,json,runpy,sys,tempfile,types,hashlib,time
from pathlib import Path
from contextlib import redirect_stdout
from unittest.mock import patch
import numpy as np
script=Path(__file__).with_name('recognize_long.py')
for requested in ('auto','zh','en'):
    calls=[]
    def decode(source,fmt,pcm,*args):
        pcm.write_bytes(b'\0'*(61*32000));return 61*16000
    class Model:
        def __init__(self,*args,**kwargs): assert kwargs['local_files_only'] is True
        def transcribe(self,chunk,**kwargs):
            calls.append(kwargs['language'])
            return [],types.SimpleNamespace(language='zh',language_probability=.91)
    with tempfile.TemporaryDirectory() as d:
        source=Path(d)/'input';source.write_bytes(b'synthetic contract fixture')
        (Path(d)/'pending.json').write_text(json.dumps({'id':'synthetic-language-policy','format':'wav','language':requested,'maximum':7200,'byteLimit':268435456,'sourceHash':hashlib.sha256(source.read_bytes()).hexdigest(),'expiresAt':time.time()*1000+60000}))
        model=Path(d)/'model';model.mkdir();(model/'model.bin').write_bytes(b'synthetic model identity')
        output=io.StringIO()
        with patch.dict(sys.modules,{'long_decode':types.SimpleNamespace(decode_to_disk=decode),'faster_whisper':types.SimpleNamespace(WhisperModel=Model),'model_config':types.SimpleNamespace(model_path=lambda:model)}),patch.object(sys,'argv',[str(script),d+'/input','wav','7200','268435456',requested]),redirect_stdout(output):runpy.run_path(str(script),run_name='__main__')
        expected='zh' if requested=='auto' else requested
        assert calls==[None if requested=='auto' else requested,expected,expected],calls
        records=[json.loads(s) for s in output.getvalue().splitlines()]
        assert records[-1]['language']==expected
        assert records[-1]['requested_language']==requested
        assert records[-1]['language_probability']==(.91 if requested=='auto' else None)
print('3 language policy cases passed: fixed language across 3 chunks; auto only once')
