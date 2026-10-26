import tempfile,subprocess,json
from pathlib import Path
from long_decode import decode_to_disk
here=Path(__file__).parent
checks=[]
def reject(name,source,fmt,limit=7200):
 with tempfile.TemporaryDirectory() as d:
  try: decode_to_disk(source,fmt,Path(d)/'pcm',268435456,limit)
  except (ValueError,OSError): checks.append(name); return
  raise AssertionError(name)
with tempfile.TemporaryDirectory() as directory:
 d=Path(directory)
 for ext,fmt in [('mp3','mp3'),('m4a','mov'),('ogg','ogg')]:
  source=d/('speech.'+ext)
  subprocess.run(['ffmpeg','-v','error','-y','-i',str(here/'synthetic-long.wav'),str(source)],check=True)
  samples=decode_to_disk(source,fmt,d/('pcm-'+ext),268435456,7200)
  assert 74.9<samples/16000<75.2; checks.append('75 second '+ext+' local decode')
  reject(ext+' overduration fail closed',source,fmt,60)
  broken=d/('broken-'+ext);broken.write_bytes(source.read_bytes()[:-103]);reject(ext+' truncation fail closed',broken,fmt)
 reject('URL input rejected','https://example.invalid/audio.wav','wav')
 link=d/'link';link.symlink_to(here.resolve()/'synthetic-long.wav');reject('Symlink input rejected',link,'wav')
 reject('Directory input rejected',d,'wav')
 source=d/'hostile.m4a';source.write_bytes(b'#EXTM3U\nhttps://example.invalid/test\n'*10);reject('Playlist disguised as audio rejected',source,'mov')
 reject('WAV MIME mismatch rejected',here/'synthetic-long.wav','mp3')
print(json.dumps({'passed':True,'checks':checks,'count':len(checks)},indent=2))
