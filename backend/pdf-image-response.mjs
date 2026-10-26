import {createHash} from 'node:crypto';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest=/^[a-f0-9]{64}$/;
const invalid=()=>{throw Object.assign(Error('Invalid PDF image response'),{status:503})};
// Internal synchronous publisher. No headers or bytes escape until every guard
// succeeds; callers may not provide a deferred/async authority check.
export function publishPdfImage(res,bytes,identity,checkPublication){
 if(!Buffer.isBuffer(bytes)||bytes.length<45||bytes.length>16*1024*1024||!identity||Object.getPrototypeOf(identity)!==Object.prototype||!Object.isFrozen(identity))invalid();
 const keys=['documentId','imageSha256','page','pages','scale','sha256','storeScope'];
 if(Reflect.ownKeys(identity).length!==keys.length||!keys.every(key=>Object.getOwnPropertyDescriptor(identity,key)?.value!==undefined))invalid();
 const {storeScope,documentId,sha256,pages,page,scale,imageSha256}=identity;
 if(typeof storeScope!=='string'||!uuid.test(storeScope)||typeof documentId!=='string'||!uuid.test(documentId)||typeof sha256!=='string'||!digest.test(sha256)||typeof imageSha256!=='string'||!digest.test(imageSha256)||!Number.isSafeInteger(pages)||pages<1||pages>40||!Number.isSafeInteger(page)||page<1||page>pages||![75,100,150].includes(scale))invalid();
 if(createHash('sha256').update(bytes).digest('hex')!==imageSha256||typeof checkPublication!=='function'||checkPublication.constructor?.name==='AsyncFunction')invalid();
 const headers={'Content-Type':'image/png','Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'X-Document-Store-Id':storeScope,'X-Document-Id':documentId,'X-Document-Sha256':sha256,'X-Document-Pages':String(pages),'X-Document-Page':String(page),'X-Document-Scale':String(scale),'X-Image-Sha256':imageSha256};
 const result=checkPublication();
 if(result!==undefined){if(result instanceof Promise)Promise.prototype.catch.call(result,()=>{});invalid()}
 res.writeHead(200,headers);res.end(bytes);
}
