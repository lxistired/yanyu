"""Synthetic snapshot-only validation; rejects before any model inference."""
import hashlib,json,os,shutil,subprocess,sys,tempfile
from pathlib import Path
snapshot=Path(sys.argv[1]);worker=Path(__file__).with_name('recognize_long.py');checks=[]
for name,mutate in [('decode-temperature',lambda e:e['identity']['settings'].update(temperature=1.0)),('merge-algorithm',lambda e:e['identity']['algorithm'].update({'merge_words.py':'changed'}))]:
 with tempfile.TemporaryDirectory(prefix='resume-identity-') as tmp:
  directory=Path(tmp)/'pending';shutil.copytree(snapshot,directory);path=directory/'checkpoint.json';e=json.loads(path.read_text());mutate(e['payload']);e['sha256']=hashlib.sha256(json.dumps(e['payload'],sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest();path.write_text(json.dumps(e));m=json.loads((directory/'pending.json').read_text());r=subprocess.run([sys.executable,str(worker),str(directory/'input'),m['format'],str(m['maximum']),str(m['byteLimit']),m['language']],capture_output=True,text=True);assert r.returncode==1,(name,r.stdout,r.stderr);assert 'identity changed' in r.stdout,(name,r.stdout);checks.append(name)
print(json.dumps({'passed':True,'checks':checks,'modelInference':False}))
