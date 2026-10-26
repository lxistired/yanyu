"""Synthetic mocked-model tests; no real audio, model, browser, network, or secrets."""
import ast, contextlib, hashlib, io, json, os, pathlib, runpy, sys, tempfile, types, unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).parent
WORKER=ROOT/'local-asr/recognize_long.py'

def worker(directory):
    model=directory.parent/'model'; model.mkdir(exist_ok=True); (model/'model.bin').write_bytes(b'synthetic-model')
    def decode(source,fmt,destination,*args): destination.write_bytes(bytes(32000)); return 16000
    class Array:
        def astype(self,*args): return self
        def __truediv__(self,*args): return self
    class Model:
        def __init__(self,*args,**kwargs): pass
        def transcribe(self,*args,**kwargs):
            w=types.SimpleNamespace(start=0,end=.5,word=' synthetic')
            return [types.SimpleNamespace(words=[w])],types.SimpleNamespace(language='en',language_probability=1.0)
    modules={'numpy':types.SimpleNamespace(frombuffer=lambda *a,**k:Array(),float32=float),
             'ctranslate2':types.SimpleNamespace(set_random_seed=lambda n:None),
             'long_decode':types.SimpleNamespace(decode_to_disk=decode),
             'merge_words':types.SimpleNamespace(merge_words=lambda prior,current,offset:(prior+current,'synthetic')),
             'faster_whisper':types.SimpleNamespace(WhisperModel=Model),
             'model_config':types.SimpleNamespace(model_path=lambda:model)}
    output=io.StringIO(); code=0
    with patch.dict(sys.modules,modules),patch('importlib.metadata.version',return_value='synthetic'),patch('threading.Thread.start'),patch.object(sys,'argv',[str(WORKER),str(directory/'input'),'wav','10','100000','en']),contextlib.redirect_stdout(output):
        try: runpy.run_path(str(WORKER),run_name='__main__')
        except SystemExit as exc: code=exc.code
    return code,output.getvalue()

def setup(directory):
    directory.mkdir(); (directory/'input').write_bytes(b'synthetic input')
    manifest={'id':'a'*36,'format':'wav','language':'en','maximum':10,'byteLimit':100000,'sourceHash':hashlib.sha256(b'synthetic input').hexdigest(),'expiresAt':9999999999999}
    (directory/'pending.json').write_text(json.dumps(manifest)); return manifest

def mutate_checkpoint(directory,mutate):
    p=directory/'checkpoint.json'; envelope=json.loads(p.read_text()); mutate(envelope['payload']);
    envelope['sha256']=hashlib.sha256(json.dumps(envelope['payload'],sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest();p.write_text(json.dumps(envelope))

class Integrity(unittest.TestCase):
    def test_atomic_does_not_follow_predictable_temp_symlink(self):
        source=ast.parse(WORKER.read_text()); node=next(n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='atomic')
        namespace={'json':json,'hashlib':hashlib,'os':os,'tempfile':tempfile};exec(compile(ast.Module(body=[node],type_ignores=[]),str(WORKER),'exec'),namespace)
        with tempfile.TemporaryDirectory(dir=ROOT,prefix='owned-') as tmp:
            d=pathlib.Path(tmp); victim=d/'unrelated-synthetic.txt';victim.write_text('unchanged'); (d/'checkpoint.tmp').symlink_to(victim)
            namespace['atomic'](d/'checkpoint.json',{'synthetic':True})
            self.assertEqual(victim.read_text(),'unchanged')
    def test_requested_language_must_match_saved_language(self):
        with tempfile.TemporaryDirectory(dir=ROOT,prefix='owned-') as tmp:
            d=pathlib.Path(tmp)/'job';setup(d);self.assertEqual(worker(d)[0],0)
            mutate_checkpoint(d,lambda state:state.update(language='zh'))
            code,out=worker(d);self.assertEqual(code,1,out);self.assertIn('language mismatch',out)
    def test_checkpoint_binds_job_id(self):
        with tempfile.TemporaryDirectory(dir=ROOT,prefix='owned-') as tmp:
            d=pathlib.Path(tmp)/'job';manifest=setup(d);self.assertEqual(worker(d)[0],0)
            manifest['id']='b'*36;(d/'pending.json').write_text(json.dumps(manifest))
            code,out=worker(d);self.assertEqual(code,1,out);self.assertIn('identity changed',out)
    def test_pre_job_binding_checkpoint_is_rejected(self):
        with tempfile.TemporaryDirectory(dir=ROOT,prefix='owned-') as tmp:
            d=pathlib.Path(tmp)/'job';setup(d);self.assertEqual(worker(d)[0],0)
            mutate_checkpoint(d,lambda state:state['identity'].pop('jobId'))
            code,out=worker(d);self.assertEqual(code,1,out);self.assertIn('identity changed',out)
    def test_unchanged_resume(self):
        with tempfile.TemporaryDirectory(dir=ROOT,prefix='owned-') as tmp:
            d=pathlib.Path(tmp)/'job';setup(d);code,out=worker(d);self.assertEqual(code,0,out)
            code,resumed=worker(d);self.assertEqual(code,0,resumed)
            initial=json.loads(out.splitlines()[-1]);final=json.loads(resumed.splitlines()[-1]);self.assertEqual(initial['segments'],final['segments'])
if __name__=='__main__':unittest.main()
