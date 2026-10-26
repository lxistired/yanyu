import json
from pathlib import Path
from merge_words import merge_words,normalized
p=Path(__file__).parent;d=json.loads((p/'BOUNDARY_REFERENCE_RESULT.json').read_text())
words=[];methods=[]
for i,chunk in enumerate(d['rawChunks']):
 words,method=merge_words(words,chunk,i*29);methods.append(method)
text=' '.join(normalized(w) for w in words)
assert 'monday please bring' in text
assert text.count('please')==6, text
assert text.count('schedule')==6,text
assert methods==['first','token-aligned','token-aligned'],methods
# Real hallucination is preserved and attributed, not silently rewritten.
assert 'alright' in text
(p/'MERGE_REGRESSION_RESULT.json').write_text(json.dumps({'passed':True,'methods':methods,'pleaseCount':6,'scheduleCount':6,'text':text,'knownRawModelInsertion':'alright'},indent=2))
print('Real raw-chunk overlap regression passed')
