export const validPdfStoreScope=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export class PdfStoreMismatch extends Error {
 constructor(){super('文档库范围已变化或无法核实。草稿仅保留在当前阅读器中，请先复制草稿，再关闭并从最新文档列表重新打开。');}
}
export function assertPdfStoreResponse(data:any,scope:string,status:number,ok:boolean){
 if(status===409&&data?.error?.code==='DOCUMENT_STORE_MISMATCH')throw new PdfStoreMismatch();
 if(ok&&(!validPdfStoreScope(scope)||data?.storeScope!==scope))throw new PdfStoreMismatch();
}
