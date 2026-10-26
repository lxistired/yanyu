// Dedicated bounded decoder. JSON.parse is used only on isolated string/number tokens,
// never on an object whose duplicate keys could already have been lost.
export function parseInventoryJson(text){
 let i=0;const bad=()=>{throw Object.assign(new Error('Invalid inventory request'),{code:'INVALID_REQUEST'})};
 const ws=()=>{while(/[ \t\r\n]/.test(text[i]??'x'))i++};
 const string=()=>{const start=i++;while(i<text.length){const c=text[i++];if(c==='"'){try{return JSON.parse(text.slice(start,i))}catch{bad()}}if(c==='\\')i++;}bad()};
 function value(depth){
  if(depth>16)bad();ws();const c=text[i];
  if(c==='"')return string();
  if(c==='{'){i++;ws();const result=Object.create(null),seen=new Set();if(text[i]==='}'){i++;return result}for(;;){ws();if(text[i]!=='"')bad();const key=string();if(seen.has(key))bad();seen.add(key);ws();if(text[i++]!==':')bad();result[key]=value(depth+1);ws();if(text[i]==='}'){i++;return result}if(text[i++]!==',')bad();}}
  if(c==='['){i++;ws();const result=[];if(text[i]===']'){i++;return result}for(;;){result.push(value(depth+1));ws();if(text[i]===']'){i++;return result}if(text[i++]!==',')bad();}}
  const match=/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));if(!match)bad();i+=match[0].length;return JSON.parse(match[0]);
 }
 const result=value(0);ws();if(i!==text.length||!result||typeof result!=='object'||Array.isArray(result))bad();return result;
}
const operations=new Set(['capabilities','preview','execute','operation','result','history']);
const safeCodes=new Set(['INVALID_REQUEST','KEY_CONFLICT','AUTHORITY_UNAVAILABLE','SOURCE_UNAVAILABLE','RESULT_ACCESS_UNAVAILABLE','HISTORY_UNAVAILABLE','BUDGET_EXCEEDED','DEFINITION_CONFLICT','UNSUPPORTED_DEFINITION','SELECTION_CONFLICT','INVENTORY_CHANGED','INVENTORY_TOO_LARGE','INVALID_METADATA','RESULT_TOO_LARGE']);
export function manualInventoryRoutes(domain,context){
 return Object.freeze({async handle(req,send,fail,sendBuffered){
  const raw=req.url??'';if(!raw.startsWith('/api/manual-inventory/'))return false;
  const match=/^\/api\/manual-inventory\/([a-z]+)$/.exec(raw);
  if(!match||!operations.has(match[1])){fail(404,'NOT_FOUND','Operation not admitted');return true;}
  if(req.method!=='POST'){fail(405,'INVALID_REQUEST','POST required');return true;}
  if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']??'')||req.headers['content-encoding']){fail(415,'INVALID_REQUEST','Plain JSON required');return true;}
  let held;
  try {
   let bytes=0;const parts=[];
   if(req.headers['content-length']&&(!/^[0-9]+$/.test(req.headers['content-length'])||Number(req.headers['content-length'])>4096))throw Object.assign(new Error(),{code:'INVALID_REQUEST'});
   for await(const chunk of req){bytes+=chunk.length;if(bytes>4096)throw Object.assign(new Error(),{code:'INVALID_REQUEST'});parts.push(chunk);}
   let text;
   try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(parts));}
   catch{throw Object.assign(new Error('Invalid inventory request'),{code:'INVALID_REQUEST'});}
   const input=parseInventoryJson(text),ctx=context();
   if(match[1]==='result'){
    held=domain.result(ctx,input);
    // Encode before the second access checkpoint; no async gap before headers.
    const buffer=Buffer.from(held.encoded,'utf8');if(buffer.length>262144)throw Object.assign(new Error(),{code:'RESULT_ACCESS_UNAVAILABLE'});
    held.publish();sendBuffered(buffer);
   }else send(200,domain[match[1]](ctx,input));
  }catch(error){const code=safeCodes.has(error?.code)?error.code:'SOURCE_UNAVAILABLE';fail(code==='INVALID_REQUEST'?400:code==='KEY_CONFLICT'?409:503,code,'Manual inventory operation unavailable');}
  finally{held?.close();}
  return true;
 }});
}
