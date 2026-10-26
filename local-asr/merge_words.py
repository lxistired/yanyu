"""Bounded overlap alignment. Never creates words absent from model output."""
import re

def normalized(word): return re.sub(r'[^\w]','',word['text']).casefold()

def merge_words(prior,current,offset):
    if not prior: return current, 'first'
    # Compare actual repeated tokens near the shared second. The decoder can
    # timestamp a boundary word differently in each window, so midpoint alone
    # can lose a word recognized by both windows.
    tail=[w for w in prior if w['end']>=offset-2][-12:]
    head=[w for w in current if w['start']<=offset+2][:12]
    for length in range(min(len(tail),len(head)),0,-1):
        if [normalized(w) for w in tail[-length:]]==[normalized(w) for w in head[:length]]:
            return prior+current[length:], 'token-aligned'
    # No reliable token agreement: deterministic ownership, explicitly marked
    # uncertain. Never manufacture a word to bridge the gap.
    cut=offset+.5
    return ([w for w in prior if (w['start']+w['end'])/2<cut]+
            [w for w in current if (w['start']+w['end'])/2>=cut]), 'uncertain-midpoint'
