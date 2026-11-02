'use client';

import {useEffect,useRef,useState,type FormEvent} from 'react';
import {CheckCircle2,FileUp,Upload,X} from 'lucide-react';
import {documentApi,documentError,readableBytes,type DocumentUploadInitInput,type DocumentUploadSession,type ManagedDocument} from '@/lib/document-api';
import {Button,ErrorBanner,Spinner} from '../shared';
import {MetadataFields,readMetadata,type DocumentEncounter} from './document-shared';
import styles from './documents.module.css';

type UploadEntry={id:string;file:File;title:string;status:'queued'|'uploading'|'verifying'|'accepted'|'failed'|'cancelled';progress:number;error?:string;input?:DocumentUploadInitInput;session?:DocumentUploadSession;uploaded?:boolean;initKey:string;completeKey:string;cancelKey:string};
const maximumSize=15*1024*1024;
const allowedTypes=new Set(['application/pdf','image/jpeg','image/png']);

export function DocumentUploader({patientId,document,encounters,onChanged,onClose}:{patientId:string;document?:ManagedDocument;encounters:DocumentEncounter[];onChanged:()=>void;onClose:()=>void}){
  const [entries,setEntries]=useState<UploadEntry[]>([]);const entriesRef=useRef(entries);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [dragging,setDragging]=useState(false);
  const fileInput=useRef<HTMLInputElement>(null);const mounted=useRef(true);const requests=useRef(new Map<string,XMLHttpRequest>());const cancellations=useRef(new Set<string>());
  const change=(fn:(items:UploadEntry[])=>UploadEntry[])=>{entriesRef.current=fn(entriesRef.current);if(mounted.current)setEntries(entriesRef.current);};
  const update=(id:string,patch:Partial<UploadEntry>)=>change(items=>items.map(item=>item.id===id?{...item,...patch}:item));
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;for(const xhr of requests.current.values())xhr.abort();};},[]);
  function addFiles(files:FileList|File[]){
    setError('');const selected=Array.from(files);
    if(document&&selected.length+entriesRef.current.filter(entry=>entry.status!=='cancelled').length>1){setError('Select one file for each new document version.');return;}
    const rejected:string[]=[];const accepted:UploadEntry[]=[];
    for(const file of selected){
      if(!allowedTypes.has(file.type)||file.size===0||file.size>maximumSize){rejected.push(`${file.name}: use a nonempty PDF, JPEG or PNG of up to 15 MB.`);continue;}
      if(entriesRef.current.some(entry=>entry.file.name===file.name&&entry.file.size===file.size&&entry.file.lastModified===file.lastModified&&entry.status!=='cancelled')){rejected.push(`${file.name}: already in this upload queue.`);continue;}
      accepted.push({id:crypto.randomUUID(),file,title:document?.title??file.name.replace(/\.[^.]+$/,'').slice(0,200),status:'queued',progress:0,initKey:crypto.randomUUID(),completeKey:crypto.randomUUID(),cancelKey:crypto.randomUUID()});
    }
    change(items=>[...items,...accepted]);if(rejected.length)setError(rejected.join(' '));
  }
  async function cancel(entry:UploadEntry){
    cancellations.current.add(entry.id);requests.current.get(entry.id)?.abort();update(entry.id,{status:'cancelled',error:undefined});
    if(entry.session){try{await documentApi.cancel(patientId,entry.session.sessionId,entry.cancelKey);onChanged();}catch(failure){update(entry.id,{error:`Upload stopped. Server cancellation could not be confirmed: ${documentError(failure)}`});}}
  }
  async function upload(entry:UploadEntry){
    if(!entry.input||cancellations.current.has(entry.id)||!mounted.current)return;
    try{
      update(entry.id,{status:'uploading',error:undefined});
      let session=entry.session;
      if(!session){session=await documentApi.init(patientId,entry.input,entry.initKey);update(entry.id,{session});}
      if(cancellations.current.has(entry.id)||!mounted.current){await documentApi.cancel(patientId,session.sessionId,entry.cancelKey);return;}
      if(!entry.uploaded){
        if(Date.parse(session.expiresAt)<=Date.now())throw new Error('The upload link expired. Cancel this upload and select the file again.');
        await new Promise<void>((resolve,reject)=>{
          const xhr=new XMLHttpRequest();requests.current.set(entry.id,xhr);xhr.open('PUT',session.uploadUrl);xhr.withCredentials=false;xhr.timeout=120000;
          // The storage service receives only the signed upload headers, never the Clerk token.
          for(const [name,value] of Object.entries(session.headers))if(!['authorization','cookie'].includes(name.toLowerCase()))xhr.setRequestHeader(name,value);
          xhr.upload.onprogress=event=>{if(event.lengthComputable)update(entry.id,{progress:Math.min(100,Math.round(event.loaded/event.total*100))});};
          xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve():reject(new Error(`Storage upload failed (${xhr.status}). Retry the file; if it persists, check storage access and CORS configuration.`));
          xhr.onerror=()=>reject(new Error('The storage connection failed. Check your connection and retry; storage CORS may need configuration.'));
          xhr.ontimeout=()=>reject(new Error('The storage upload timed out. Retry the file.'));
          xhr.onabort=()=>reject(new Error('Upload cancelled.'));xhr.send(entry.file);
        });
        update(entry.id,{uploaded:true,progress:100});
      }
      if(cancellations.current.has(entry.id)||!mounted.current)return;
      update(entry.id,{status:'verifying'});
      await documentApi.complete(patientId,session.sessionId,entry.completeKey);
      if(!cancellations.current.has(entry.id)){update(entry.id,{status:'accepted'});onChanged();}
    }catch(failure){if(!cancellations.current.has(entry.id))update(entry.id,{status:'failed',error:documentError(failure)});}finally{requests.current.delete(entry.id);}
  }
  async function start(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setError('');
    try{
      const data=new FormData(event.currentTarget);const changeReason=String(data.get('changeReason')??'').trim();
      if(document&&changeReason.length<5)throw new Error('Explain why the document needs a new version (at least 5 characters).');
      const queued=entriesRef.current.filter(entry=>entry.status==='queued');if(!queued.length)throw new Error('Select at least one file to upload.');
      const prepared=queued.map(entry=>({...entry,input:{...(document?{title:document.title,documentType:document.documentType as DocumentUploadInitInput['documentType'],documentDate:document.documentDate,description:document.description,healthcareProviderName:document.healthcareProviderName,encounterId:document.encounterId,tags:document.tags}:readMetadata(data,entry.title.trim())),filename:entry.file.name,mimeType:entry.file.type as DocumentUploadInitInput['mimeType'],fileSize:entry.file.size,...(document?{documentId:document.id,changeReason}:{})}}));
      if(prepared.some(entry=>!entry.title.trim()))throw new Error('Give every document a title.');
      change(items=>items.map(entry=>prepared.find(item=>item.id===entry.id)??entry));setBusy(true);
      for(const entry of prepared)await upload(entry);
    }catch(failure){setError(documentError(failure));}finally{if(mounted.current)setBusy(false);}
  }
  async function retry(entry:UploadEntry){setBusy(true);await upload(entry);if(mounted.current)setBusy(false);}
  return <section className={styles.uploadPanel} aria-label={document?'Upload a new version':'Upload medical documents'}>
    <header className={styles.row}><div><h3>{document?'Upload a new version':'Upload medical documents'}</h3><p className={styles.muted}>PDF, JPEG or PNG · Up to 15 MB each. Files remain private while security checks and extraction run.</p></div><Button variant="ghost" size="icon" onClick={onClose} disabled={busy} aria-label="Close upload panel"><X size={18}/></Button></header>
    <form onSubmit={event=>void start(event)}>
      <fieldset disabled={busy} className={styles.fields}>
        <div className={styles.dropzone} data-dragging={dragging} onDragOver={event=>{event.preventDefault();if(!busy)setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={event=>{event.preventDefault();setDragging(false);if(!busy)addFiles(event.dataTransfer.files);}}>
          <FileUp size={30}/><strong>Drop your medical {document?'document':'documents'} here</strong><span className={styles.muted}>or select files from your device</span><Button type="button" variant="outline" onClick={()=>fileInput.current?.click()}><Upload size={16}/>Choose {document?'file':'files'}</Button>
          <input ref={fileInput} className={styles.visuallyHidden} type="file" accept="application/pdf,image/jpeg,image/png" multiple={!document} aria-label="Select medical documents" onChange={event=>{if(event.target.files)addFiles(event.target.files);event.target.value='';}}/>
        </div>
        {document?<p className={styles.muted}>This adds a file version to “{document.title}” with its existing document details. Use Edit metadata to change the title, category, dates or provider.</p>:<MetadataFields encounters={encounters} includeTitle={false}/>}
        {document?<label>Reason for new version<textarea name="changeReason" required minLength={5} maxLength={1000} rows={2}/></label>:null}
        {!document?<p className={styles.muted}>These details apply to every file in this batch. You can edit each document after uploading.</p>:null}
      </fieldset>
      {error?<ErrorBanner message={error}/>:null}
      <ul className={styles.uploadQueue}>{entries.map(entry=><li key={entry.id}>
        <div className={styles.row}><div className={styles.grow}>{entry.status==='queued'&&!document?<label>Document title<input value={entry.title} maxLength={200} disabled={busy} required onChange={event=>update(entry.id,{title:event.target.value})}/></label>:<strong>{entry.title}</strong>}<small className={styles.muted}>{entry.file.name} · {readableBytes(entry.file.size)}</small></div>
          {['queued','uploading','failed'].includes(entry.status)?<Button type="button" size="sm" variant="ghost" onClick={()=>void cancel(entry)}>Cancel</Button>:null}
          {entry.status==='failed'?<Button type="button" size="sm" variant="outline" disabled={busy} onClick={()=>void retry(entry)}>Retry</Button>:null}
        </div>
        <div className={styles.uploadState} role="status">{entry.status==='accepted'?<CheckCircle2 size={16}/>:['uploading','verifying'].includes(entry.status)?<Spinner/>:null}{entry.status==='accepted'?'Uploaded · Security checks queued':entry.status==='verifying'?'Upload complete · Verifying file receipt':entry.status==='uploading'?`Uploading · ${entry.progress}%`:entry.status==='queued'?'Ready to upload':entry.status==='cancelled'?'Cancelled':'Upload failed'}</div>
        {entry.status==='uploading'?<progress max={100} value={entry.progress} aria-label={`Upload progress for ${entry.title}`}/>:null}
        {entry.error?<p role="alert" className={styles.error}>{entry.error}</p>:null}
      </li>)}</ul>
      <div className={styles.actions}><Button type="submit" disabled={busy||!entries.some(entry=>entry.status==='queued')}>{busy?<Spinner/>:<Upload size={16}/>}Upload {entries.filter(entry=>entry.status==='queued').length||''} {document?'version':'documents'}</Button><p className={styles.muted}>Uploading does not verify clinical findings. A clinician must review extracted information.</p></div>
    </form>
  </section>;
}
