'use client';

import {useEffect,useRef,useState} from 'react';
import type {PDFDocumentProxy,RenderTask} from 'pdfjs-dist';
import {ChevronLeft,ChevronRight,Download,Maximize,ShieldAlert,ZoomIn,ZoomOut} from 'lucide-react';
import {documentApi,documentError} from '@/lib/document-api';
import {Button,ErrorBanner,Spinner} from '../shared';
import styles from './documents.module.css';

export function DocumentViewer({patientId,documentId,title,canPreview,blockedReason,versionId,requestedPage,sourceRequest=0}:{patientId:string;documentId:string;title:string;canPreview:boolean;blockedReason:string;versionId?:string;requestedPage?:number;sourceRequest?:number}){
  const container=useRef<HTMLDivElement>(null);const canvas=useRef<HTMLCanvasElement>(null);
  const [pdf,setPdf]=useState<PDFDocumentProxy|null>(null);const [imageUrl,setImageUrl]=useState('');const [page,setPage]=useState(1);const [zoom,setZoom]=useState(1);
  const [loading,setLoading]=useState(false);const [rendering,setRendering]=useState(false);const [error,setError]=useState('');const [revision,setRevision]=useState(0);const [downloading,setDownloading]=useState(false);const [width,setWidth]=useState(620);
  useEffect(()=>{const target=container.current;if(!target)return;const observer=new ResizeObserver(entries=>{const available=entries[0]?.contentRect.width;if(available)setWidth(available);});observer.observe(target);return()=>observer.disconnect();},[canPreview]);
  useEffect(()=>{
    const controller=new AbortController();let instance:PDFDocumentProxy|null=null;let localImage='';let destroyLoading:(()=>void)|undefined;
    setPdf(null);setImageUrl('');setPage(1);setError('');setLoading(canPreview);
    if(canPreview)void(async()=>{
      try{
        const file=await documentApi.file(patientId,documentId,false,versionId,controller.signal);
        const response=await fetch(file.url,{signal:controller.signal,credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});
        if(!response.ok)throw new Error('The private preview link is unavailable or expired. Reload the preview.');
        if(file.mimeType==='application/pdf'){
          const bytes=new Uint8Array(await response.arrayBuffer());const pdfjs=await import('pdfjs-dist');
          if(controller.signal.aborted)return;
          pdfjs.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).toString();
          // Canvas-only rendering does not execute document JavaScript or mount interactive links/forms.
          const task=pdfjs.getDocument({data:bytes,enableXfa:false,stopAtErrors:true,useWasm:false});destroyLoading=()=>{void task.destroy();};
          instance=await task.promise;if(controller.signal.aborted){destroyLoading?.();return;}setPdf(instance);
        }else if(['image/jpeg','image/png'].includes(file.mimeType)){
          localImage=URL.createObjectURL(await response.blob());if(!controller.signal.aborted)setImageUrl(localImage);
        }else throw new Error('This document type does not have an inline preview.');
      }catch(failure){if(!controller.signal.aborted)setError(documentError(failure));}finally{if(!controller.signal.aborted)setLoading(false);}
    })();
    return()=>{controller.abort();destroyLoading?.();if(localImage)URL.revokeObjectURL(localImage);};
  },[patientId,documentId,canPreview,versionId,revision]);
  useEffect(()=>{if(requestedPage&&pdf)setPage(Math.min(pdf.numPages,Math.max(1,requestedPage)));},[requestedPage,pdf,sourceRequest]);
  useEffect(()=>{
    if(!pdf||!canvas.current)return;let active=true;let task:RenderTask|undefined;setRendering(true);
    void(async()=>{
      try{
        const source=await pdf.getPage(page);if(!active||!canvas.current)return;
        const fitScale=Math.max(.1,(width-22)/source.getViewport({scale:1}).width);
        const viewport=source.getViewport({scale:Math.min(2,window.devicePixelRatio||1)*zoom*fitScale});
        const scale=Math.min(1,Math.sqrt(8000000/(viewport.width*viewport.height)));
        const safeViewport=source.getViewport({scale:viewport.scale*scale});
        const target=canvas.current;target.width=safeViewport.width;target.height=safeViewport.height;
        target.style.width=`${safeViewport.width/Math.min(2,window.devicePixelRatio||1)}px`;
        task=source.render({canvas:target,viewport:safeViewport,annotationMode:0});await task.promise;
      }catch(failure){if(active&&!(failure instanceof Error&&failure.name==='RenderingCancelledException'))setError(documentError(failure));}finally{if(active)setRendering(false);}
    })();return()=>{active=false;task?.cancel();};
  },[pdf,page,zoom,width]);
  async function download(){
    setDownloading(true);setError('');
    try{const file=await documentApi.file(patientId,documentId,true,versionId);const link=document.createElement('a');link.href=file.url;link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';link.download=title;link.target='_blank';link.click();}catch(failure){setError(documentError(failure));}finally{setDownloading(false);}
  }
  if(!canPreview)return <div className={styles.previewBlocked}><ShieldAlert size={30}/><h4>Preview unavailable</h4><p>{blockedReason}</p><p className={styles.muted}>Only files that pass security checks can be previewed or downloaded.</p></div>;
  return <div ref={container} className={styles.viewer}>
    <div className={styles.viewerToolbar}>
      <div className={styles.actions}><Button variant="outline" size="icon" disabled={!pdf||page<=1||rendering} onClick={()=>setPage(value=>value-1)} aria-label="Previous PDF page"><ChevronLeft size={16}/></Button><span>{pdf?`Page ${page} of ${pdf.numPages}`:imageUrl?'Image':'Original document'}</span><Button variant="outline" size="icon" disabled={!pdf||page>=pdf.numPages||rendering} onClick={()=>setPage(value=>value+1)} aria-label="Next PDF page"><ChevronRight size={16}/></Button></div>
      <div className={styles.actions}><Button variant="ghost" size="icon" onClick={()=>setZoom(value=>Math.max(.5,value-.25))} disabled={loading||zoom<=.5} aria-label="Zoom out"><ZoomOut size={16}/></Button><span>{Math.round(zoom*100)}%</span><Button variant="ghost" size="icon" onClick={()=>setZoom(value=>Math.min(2.5,value+.25))} disabled={loading||zoom>=2.5} aria-label="Zoom in"><ZoomIn size={16}/></Button><Button variant="ghost" size="icon" onClick={()=>{if(container.current?.requestFullscreen)void container.current.requestFullscreen().catch(()=>setError('Full-screen preview is unavailable in this browser.'));else setError('Full-screen preview is unavailable in this browser.');}} aria-label="Open full-screen preview"><Maximize size={16}/></Button><Button variant="outline" size="sm" onClick={()=>void download()} disabled={downloading}><Download size={15}/>{downloading?'Preparing…':'Download'}</Button></div>
    </div>
    {error?<ErrorBanner message={error} onRetry={()=>{setError('');setRevision(value=>value+1);}}/>:null}
    {loading?<div className={styles.loading} role="status"><Spinner/>Loading protected preview…</div>:null}
    <div className={styles.previewCanvas} tabIndex={0} role="region" aria-label="Original document preview; use arrow keys to scroll" aria-busy={loading||rendering}>
      {pdf?<canvas ref={canvas} role="img" aria-label={`${title}, page ${page} of ${pdf.numPages}`}/>:null}
      {/* A private blob URL stays in memory and is revoked when the document closes. */}
      {imageUrl?<img src={imageUrl} alt={`Original medical document: ${title}`} style={{width:`${zoom*100}%`,maxWidth:'none'}} onError={()=>setError('The image could not be rendered. Reload the preview.')}/>:null}
    </div>
    <p className={styles.muted}>Private preview · Access is checked each time the file is opened. Do not share download links.</p>
  </div>;
}
