import {parentPort,workerData} from 'node:worker_threads';
// PDF.js diagnostics can include attacker-controlled document text. This isolated
// worker communicates bounded codes and data only; no library output enters logs.
console.log=console.info=console.warn=console.error=()=>{};
let document,loadingTask;
try {
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 loadingTask=getDocument({data:new Uint8Array(workerData.bytes),isEvalSupported:false,disableFontFace:true,useSystemFonts:true,useWorkerFetch:false,verbosity:0,stopAtErrors:true,maxImageSize:25_000_000});
 document=await loadingTask.promise;
 if(document.numPages>workerData.maxPages)throw new Error('PDF_PAGE_LIMIT');
 if(document.isPureXfa||await document.hasJSActions()||await document.getJSActions()||await document.getAttachments())throw new Error('PDF_ACTIVE_CONTENT');
 const pages=[];let total=0;
 for(let pageNumber=1;pageNumber<=document.numPages;pageNumber++){
  const page=await document.getPage(pageNumber);
  if(await page.getJSActions())throw new Error('PDF_ACTIVE_CONTENT');
  const annotations=await page.getAnnotations({intent:'display'});
  if(annotations.some(annotation=>annotation.actions||annotation.attachment||annotation.subtype==='FileAttachment'||/^\s*(?:javascript|data|vbscript|file):/i.test(annotation.unsafeUrl??'')))throw new Error('PDF_ACTIVE_CONTENT');
  const viewport=page.getViewport({scale:1});
  const content=await page.getTextContent({disableNormalization:true});
  const rows=[];
  for(const item of content.items){
   if(!('str' in item)||!item.str.trim())continue;
   const x=item.transform[4],y=viewport.height-item.transform[5],height=Math.abs(item.height)||10;
   let row=rows.find(value=>Math.abs(value.y-y)<=Math.max(2,height*0.2));
   if(!row){row={y,height,items:[]};rows.push(row);}
   row.items.push({text:item.str,x,width:item.width,height});total+=item.str.length;
   if(total>workerData.maxCharacters)throw new Error('PDF_TEXT_LIMIT');
  }
  const lines=rows.sort((a,b)=>a.y-b.y).map(row=>{
   const items=row.items.sort((a,b)=>a.x-b.x);
   let text='';let right=0;
   for(const item of items){const gap=item.x-right;text+=(text?(gap>16?'  ':' '):'')+item.text;right=item.x+item.width;}
   return {text,page:pageNumber,location:{x:items[0].x,y:row.y,width:right-items[0].x,height:row.height},cells:items};
  });
  pages.push({page:pageNumber,width:viewport.width,height:viewport.height,lines});page.cleanup();
 }
 parentPort.postMessage({ok:true,pages});
} catch(error){
 const known=new Set(['PDF_PAGE_LIMIT','PDF_TEXT_LIMIT','PDF_ACTIVE_CONTENT']);
 parentPort.postMessage({ok:false,code:known.has(error?.message)?error.message:'INVALID_PDF'});
} finally {await loadingTask?.destroy();}
