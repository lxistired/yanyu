import {createHash,webcrypto} from 'node:crypto';
import {vi} from 'vitest';
export const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=','base64'));
export const pngSha=createHash('sha256').update(png).digest('hex');
export function installPdfCrypto(){vi.stubGlobal('crypto',webcrypto);}
export function imageResponse(path:string,sha256:string,pages:number,storeScope?:string){
 const url=new URL(path,'http://synthetic.invalid');
 return new Response(png.slice(),{headers:{'Content-Type':'image/png','Content-Length':String(png.length),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Document-Store-Id':storeScope??url.searchParams.get('storeScope')!,'X-Document-Id':url.pathname.split('/')[3],'X-Document-Sha256':sha256,'X-Document-Pages':String(pages),'X-Document-Page':url.searchParams.get('page')!,'X-Document-Scale':url.searchParams.get('scale')!,'X-Image-Sha256':pngSha}});
}
