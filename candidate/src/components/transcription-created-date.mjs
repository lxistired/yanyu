// Original local contract, not an assertion about any upstream service.
// Calendar bounds: Gregorian years 0001–9999, UTC, canonical YYYY-MM-DD only.
export function utcCalendarStart(value) {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.slice(0,4)==='0000')return null;
 const milliseconds=Date.parse(`${value}T00:00:00.000Z`);
 return Number.isFinite(milliseconds)&&new Date(milliseconds).toISOString().slice(0,10)===value?milliseconds:null;
}
export function createdDateBounds(from,through) {
 const start=from===undefined?null:utcCalendarStart(from);
 const end=through===undefined?null:utcCalendarStart(through);
 if((from!==undefined&&start===null)||(through!==undefined&&end===null)||(start!==null&&end!==null&&start>end))return null;
 return {start,endExclusive:end===null?null:end+86400000};
}
// Historical YYYY-MM-DD rows remain midnight UTC. Unsupported/malformed TEXT
// values remain visible without a date filter, but are excluded when filtering.
export function storedCreatedInstant(value) {
 if(typeof value!=='string')return null;
 if(value.length===10)return utcCalendarStart(value);
 if(value.length===20&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value))value=value.slice(0,-1)+'.000Z';
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)||utcCalendarStart(value.slice(0,10))===null)return null;
 const milliseconds=Date.parse(value);
 return Number.isFinite(milliseconds)&&new Date(milliseconds).toISOString()===value?milliseconds:null;
}
