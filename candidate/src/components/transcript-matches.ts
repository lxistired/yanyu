// UTF-16 positions match textarea selection APIs. Literal, case-sensitive,
// non-overlapping scans use constant auxiliary memory, not split()/match arrays.
// Covers all well-formed text within the host's 16 MiB export ceiling, and
// the smaller 256 KiB correction limit. Oversize drafts stay editable unchanged.
export const MAX_SEARCH_CODE_UNITS = 16 * 1024 * 1024;
export function countTranscriptMatches(text:string,query:string):number|null {
 if(text.length>MAX_SEARCH_CODE_UNITS||query.length>MAX_SEARCH_CODE_UNITS)return null;
 if(!query)return 0;
 let count=0,from=0;
 while(from<=text.length-query.length){const start=text.indexOf(query,from);if(start<0)break;count++;from=start+query.length;}
 return count;
}
export function transcriptMatchRange(text:string,query:string,index:number):{start:number;end:number}|null {
 if(!query||!Number.isSafeInteger(index)||index<0||text.length>MAX_SEARCH_CODE_UNITS||query.length>MAX_SEARCH_CODE_UNITS)return null;
 let from=0;
 for(let current=0;from<=text.length-query.length;current++){
  const start=text.indexOf(query,from);if(start<0)return null;
  if(current===index)return {start,end:start+query.length};
  from=start+query.length;
 }
 return null;
}
