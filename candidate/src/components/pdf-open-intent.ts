import {pdfOpenSelection, type PdfOpenSelection} from './pdf-open-selection';
/** In-memory one-shot admission, never serialized into navigation or storage. */
export type PdfOpenIntent = {readonly selection:PdfOpenSelection; readonly epoch:number; pending:boolean; current:()=>boolean};
export function createPdfOpenIntent(value:unknown,epoch:number,owns:()=>boolean):PdfOpenIntent|null {
 const selection=pdfOpenSelection(value);if(!selection)return null;
 const intent:PdfOpenIntent={selection,epoch,pending:true,current:()=>intent.pending&&owns()};
 return intent;
}
