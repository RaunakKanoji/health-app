'use client';

import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {FileText,History,Plus,RefreshCw,Search,ShieldAlert,Trash2,X} from 'lucide-react';
import {documentApi,documentError,documentLabel,documentStages,documentTypes,readableBytes,type DocumentDetailResponse,type DocumentFilters,type DocumentListResponse,type ManagedDocument} from '@/lib/document-api';
import {date} from '@/lib/utils';
import {useUiLanguage} from '@/lib/i18n';
import {Button,ErrorBanner,Spinner} from '../shared';
import {DocumentDialog,DocumentStatus,MetadataFields,readMetadata,useDocumentMutationKey,type DocumentEncounter} from './document-shared';
import {DocumentUploader} from './document-uploader';
import {DocumentViewer} from './document-viewer';
import {DocumentReviewPanel} from './document-review';
import {DocumentHistory} from './document-history';
import styles from './documents.module.css';

type WorkspaceProps={patientId:string;canUpload:boolean;canEdit:boolean;consultations:DocumentEncounter[]};
const pendingStages=new Set(['uploading','security_checks','extracting']);
/** A patient switch remounts every child, including in-memory file previews and pending requests. */
export function DocumentWorkspace(props:WorkspaceProps){return <DocumentWorkspaceContent key={props.patientId} {...props}/>;}

function useBoundedPolling(active:boolean,identity:string,refresh:()=>void){
  const [stopped,setStopped]=useState(false);
  useEffect(()=>{setStopped(false);if(!active)return;const started=Date.now();const interval=window.setInterval(()=>{if(Date.now()-started>=120000){window.clearInterval(interval);setStopped(true);return;}if(document.visibilityState==='visible')refresh();},5000);return()=>window.clearInterval(interval);},[active,identity,refresh]);
  return stopped;
}

function DocumentWorkspaceContent({patientId,canUpload,canEdit,consultations}:WorkspaceProps){
  const {language}=useUiLanguage();const c=(en:string,hi:string)=>language==='hi'?hi:en;
  const [data,setData]=useState<DocumentListResponse|null>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [revision,setRevision]=useState(0);const [historyRevision,setHistoryRevision]=useState(0);
  const [filters,setFilters]=useState<DocumentFilters>({sort:'newest',limit:12,offset:0,deleted:'false'});const [reviewQueue,setReviewQueue]=useState(false);const [selected,setSelected]=useState<string|null>(null);const [uploading,setUploading]=useState(false);const [history,setHistory]=useState(false);
  const refresh=useCallback(()=>setRevision(value=>value+1),[]);
  const changed=useCallback(()=>{setRevision(value=>value+1);setHistoryRevision(value=>value+1);},[]);
  useEffect(()=>{const controller=new AbortController();setLoading(true);setError('');(reviewQueue?documentApi.reviewQueue:documentApi.list)(patientId,filters,controller.signal).then(result=>{if(!controller.signal.aborted)setData(result);}).catch(failure=>{if(!controller.signal.aborted){setData(null);setError(documentError(failure));}}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[patientId,filters,revision,reviewQueue]);
  const pollingStopped=useBoundedPolling(Boolean(data?.documents.some(value=>pendingStages.has(value.processingStage))),patientId,refresh);
  function filter(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=new FormData(event.currentTarget);const text=(name:string)=>String(form.get(name)??'');const from=text('from'),to=text('to');if(from&&to&&from>to){setError('Choose a start date on or before the end date.');return;}setReviewQueue(false);setFilters({q:text('q'),type:text('type') as DocumentFilters['type']||undefined,status:text('status') as DocumentFilters['status']||undefined,from:from||undefined,to:to||undefined,sort:text('sort') as DocumentFilters['sort'],deleted:form.get('deleted')?'true':'false',limit:12,offset:0});}
  return <section className={`panel ${styles.workspace}`} aria-label={c('Medical documents','चिकित्सीय दस्तावेज़')}>
    <header className={styles.workspaceHeader}><div><h2>{c('Medical documents','चिकित्सीय दस्तावेज़')}</h2><p>{c('Your health records, reports and medical history in one secure place.','आपके स्वास्थ्य रिकॉर्ड, रिपोर्ट और चिकित्सा इतिहास एक सुरक्षित स्थान पर।')}</p></div><div className={styles.actions}><Button variant="outline" size="sm" onClick={()=>setHistory(value=>!value)} aria-expanded={history}><History size={15}/>{history?'Hide timeline':'Timeline & trends'}</Button><Button variant="outline" size="icon" onClick={refresh} disabled={loading} aria-label="Refresh documents"><RefreshCw size={16}/></Button>{canUpload?<Button size="sm" onClick={()=>setUploading(value=>!value)} disabled={data?.storageAvailable===false}><Plus size={16}/>{c('Upload document','दस्तावेज़ अपलोड करें')}</Button>:null}</div></header>
    <div className={styles.workspaceBody}>
      {data?<div className={styles.stats} aria-label="Document totals">{[[c('Total documents','कुल दस्तावेज़'),data.counts.total],['Laboratory reports',data.counts.laboratory],['Prescriptions',data.counts.prescriptions],['Consultation records',data.counts.consultations],['Awaiting review',data.counts.awaitingReview]].map(([label,count])=><div key={label}><strong>{count}</strong><span>{label}</span></div>)}</div>:null}
      {data?.storageAvailable===false?<div className={styles.warning} role="status"><ShieldAlert size={18}/><p>Private document storage is not configured. Existing metadata remains available; uploads and file retrieval need the storage configuration.</p></div>:null}
      {uploading&&canUpload?<DocumentUploader patientId={patientId} encounters={consultations} onChanged={changed} onClose={()=>setUploading(false)}/>:null}
      <form className={styles.filters} onSubmit={filter}>
        <label className={styles.search}>Search documents<div><Search size={16}/><input name="q" maxLength={200} placeholder="Title, provider or indexed text"/></div></label>
        <label>Type<select name="type"><option value="">All types</option>{documentTypes.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label>Status<select name="status" defaultValue=""><option value="">All statuses</option>{documentStages.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
        <label>From<input type="date" name="from"/></label><label>To<input type="date" name="to"/></label>
        <label>Sort<select name="sort" defaultValue="newest"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label><Button type="submit" variant="outline" size="sm">Apply filters</Button>
        <label className={styles.checkbox}><input type="checkbox" name="deleted"/>Show removed documents</label>
      </form>
      {canEdit&&data?.counts.awaitingReview?<div className={styles.reviewQueue}><strong>{data.counts.awaitingReview} documents await clinical review</strong><Button variant="outline" size="sm" onClick={()=>{setReviewQueue(true);setFilters({sort:'oldest',limit:12,offset:0,deleted:'false'});}}>Open review queue</Button><span className={styles.muted}>Open a report to see unresolved verification items.</span></div>:null}
      {error?<ErrorBanner message={error} onRetry={refresh}/>:null}
      {loading&&!data?<div className={styles.loading} role="status"><Spinner/>Loading medical documents…</div>:null}
      {data?<><div className={styles.row}><p className={styles.muted} role="status">{data.pagination.total?`${data.pagination.offset+1}–${Math.min(data.pagination.offset+data.documents.length,data.pagination.total)} of ${data.pagination.total} matching documents`:'No matching documents'}{reviewQueue?' · Awaiting review queue':''}</p>{loading?<Spinner/>:null}</div>
        <div className={styles.documentList} aria-busy={loading}>{data.documents.map(document=><DocumentCard key={document.id} document={document} selected={selected===document.id} onOpen={()=>setSelected(document.id)}/>)}</div>
        {!data.documents.length?<div className={styles.empty}><FileText size={30}/><h3>{filters.q||filters.type||filters.status||filters.from||filters.to?'No documents match these filters':'No medical documents in this view'}</h3><p>Upload a report to start its secure processing and review workflow.</p></div>:null}
        <div className={styles.pagination}><Button variant="outline" size="sm" disabled={!data.pagination.offset||loading} onClick={()=>setFilters(value=>({...value,offset:Math.max(0,Number(value.offset??0)-12)}))}>Previous</Button><span>Page {Math.floor(data.pagination.offset/data.pagination.limit)+1}</span><Button variant="outline" size="sm" disabled={data.pagination.offset+data.documents.length>=data.pagination.total||loading} onClick={()=>setFilters(value=>({...value,offset:Number(value.offset??0)+12}))}>Next</Button></div>
      </>:null}
      {pollingStopped?<p className={styles.muted}>Automatic status checks paused after two minutes. Use Refresh documents to check longer-running work.</p>:null}
      {selected?<DocumentDetail key={selected} patientId={patientId} documentId={selected} revision={revision} encounters={consultations} onClose={()=>setSelected(null)} onChanged={changed}/>:null}
      {history?<DocumentHistory patientId={patientId} revision={historyRevision} encounters={consultations} onOpen={setSelected}/>:null}
    </div>
  </section>;
}

function DocumentCard({document,selected,onOpen}:{document:ManagedDocument;selected:boolean;onOpen:()=>void}){
  return <article className={styles.documentCard} data-selected={selected}><FileText size={24}/><div className={styles.grow}><button className={styles.documentTitle} onClick={onOpen} aria-expanded={selected}>{document.title}</button><p>{documentLabel(document.documentType)} · {document.documentDate?date(document.documentDate,false):'Document date not supplied'}</p><small>{document.healthcareProviderName||'Provider not supplied'} · Uploaded {date(document.createdAt,false)} · {readableBytes(document.fileSize)}</small>{document.tags.length?<div className={styles.tags}>{document.tags.map(tag=><span key={tag}>{tag}</span>)}</div>:null}</div><div className={styles.cardStatuses}><DocumentStatus status={document.processingStage}/><DocumentStatus status={document.clinicalReviewStatus}/>{document.deletedAt?<DocumentStatus status="removed"/>:null}<Button variant="ghost" size="sm" onClick={onOpen}>View document</Button></div></article>;
}

function DocumentDetail({patientId,documentId,revision,encounters,onClose,onChanged}:{patientId:string;documentId:string;revision:number;encounters:DocumentEncounter[];onClose:()=>void;onChanged:()=>void}){
  const [detail,setDetail]=useState<DocumentDetailResponse|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [editing,setEditing]=useState(false);const [removing,setRemoving]=useState(false);const [newVersion,setNewVersion]=useState(false);const [version,setVersion]=useState('');const [sourcePage,setSourcePage]=useState<number|undefined>();const [sourceRequest,setSourceRequest]=useState(0);const sourcePanel=useRef<HTMLDivElement>(null);const section=useRef<HTMLElement>(null);const [localRevision,setLocalRevision]=useState(0);const mutation=useDocumentMutationKey();
  const refresh=useCallback(()=>setLocalRevision(value=>value+1),[]);
  useEffect(()=>{section.current?.scrollIntoView({behavior:'smooth',block:'start'});},[documentId]);
  useEffect(()=>{const controller=new AbortController();documentApi.detail(patientId,documentId,controller.signal).then(result=>{if(!controller.signal.aborted){setDetail(result);setError('');}}).catch(failure=>{if(!controller.signal.aborted){setDetail(null);setError(documentError(failure));}});return()=>controller.abort();},[patientId,documentId,revision,localRevision]);
  const pollingStopped=useBoundedPolling(Boolean(detail&&pendingStages.has(detail.document.processingStage)),documentId,refresh);
  async function action(kind:'restore'|'retry'|'process'|'request-review'){setBusy(true);setError('');try{await documentApi.action(patientId,documentId,kind,mutation.key({kind,documentId}));mutation.clear();onChanged();}catch(failure){setError(documentError(failure));}finally{setBusy(false);}}
  const selectedVersion=version||detail?.document.currentVersionId||'';
  const versionRecord=detail?.versions.find(value=>value.id===selectedVersion);
  const doc=detail?.document;const jobs=detail?.jobs.filter(value=>value.documentVersionId===selectedVersion)??[];
  return <section ref={section} className={styles.documentDetail} aria-label="Medical document details">
    <header className={styles.row}><div><h3>{doc?.title??'Document details'}</h3>{doc?<p className={styles.muted}>{documentLabel(doc.documentType)} · {doc.filename}</p>:null}</div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close document details"><X size={20}/></Button></header>
    {error?<ErrorBanner message={error} onRetry={refresh}/>:null}
    {!detail&&!error?<div className={styles.loading}><Spinner/>Loading document details…</div>:null}
    {detail&&doc?<>
      <div className={styles.actions}><DocumentStatus status={doc.processingStage}/><DocumentStatus status={doc.securityStatus}/><DocumentStatus status={doc.clinicalReviewStatus}/><Button size="sm" variant="ghost" onClick={refresh} disabled={busy}><RefreshCw size={14}/>Refresh status</Button>{detail.capabilities.canEdit&&!doc.deletedAt?<><Button size="sm" variant="outline" onClick={()=>setEditing(true)}>Edit metadata</Button><Button size="sm" variant="ghost" onClick={()=>setRemoving(true)}><Trash2 size={14}/>Remove</Button></>:null}{detail.capabilities.canUploadVersion&&!doc.deletedAt?<Button size="sm" variant="outline" onClick={()=>setNewVersion(value=>!value)}>Upload new version</Button>:null}{doc.deletedAt&&detail.capabilities.canEdit?<Button size="sm" variant="outline" disabled={busy} onClick={()=>void action('restore')}>Restore document</Button>:null}{detail.capabilities.canRetry&&doc.securityStatus!=='infected'&&!doc.deletedAt?<Button size="sm" variant="outline" disabled={busy} onClick={()=>void action('retry')}>Retry processing</Button>:null}{detail.capabilities.canEdit&&!doc.deletedAt&&doc.securityStatus==='safe'&&!['pending_review','approved'].includes(doc.clinicalReviewStatus)?<Button size="sm" variant="outline" disabled={busy} onClick={()=>void action('request-review')}>Request review</Button>:null}</div>
      {doc.processingStage==='legacy'?<div className={styles.warning}><ShieldAlert size={19}/><p>This existing record predates secure document processing. Its metadata is preserved, but the file must pass security checks before preview, extraction or clinical use.</p></div>:null}
      {newVersion?<DocumentUploader patientId={patientId} document={doc} encounters={encounters} onChanged={onChanged} onClose={()=>setNewVersion(false)}/>:null}
      <div className={styles.detailGrid}>
        <div ref={sourcePanel} className={styles.sourcePanel}><h3>Original document</h3>{detail.versions.length?<label>Document version<select value={selectedVersion} onChange={event=>{setVersion(event.target.value===doc.currentVersionId?'':event.target.value);setSourcePage(undefined);}}>{detail.versions.map(value=><option key={value.id} value={value.id}>Version {value.versionNumber} · {date(value.createdAt,false)}{value.id===doc.currentVersionId?' · Current':''}</option>)}</select></label>:null}
          <DocumentViewer key={selectedVersion} patientId={patientId} documentId={documentId} title={doc.title} canPreview={!doc.deletedAt&&(selectedVersion!==doc.currentVersionId?versionRecord?.securityStatus==='safe':detail.capabilities.canPreview)} blockedReason={doc.deletedAt?'This document has been removed. Restore it before requesting access.':['infected','quarantined'].includes(doc.securityStatus)?'This file is quarantined. It cannot be previewed, downloaded or processed.':doc.processingStage==='legacy'?'This legacy file has not completed the current security checks.':'Security checks have not cleared this file. Check the processing details or retry when the required service is available.'} versionId={selectedVersion||undefined} requestedPage={sourcePage} sourceRequest={sourceRequest}/>
          <dl className={styles.metadata}><div><dt>Document date</dt><dd>{doc.documentDate?date(doc.documentDate,false):'Not supplied'}</dd></div><div><dt>Provider</dt><dd>{doc.healthcareProviderName||'Not supplied'}</dd></div><div><dt>Uploaded</dt><dd>{date(doc.createdAt)}</dd></div><div><dt>File</dt><dd>{versionRecord?.mimeType??doc.mimeType} · {readableBytes(versionRecord?.fileSize??doc.fileSize)}</dd></div>{doc.description?<div><dt>Description</dt><dd>{doc.description}</dd></div>:null}{doc.encounterId?<div><dt>Consultation</dt><dd>{encounters.find(value=>value.id===doc.encounterId)?.chiefComplaint??doc.encounterId}</dd></div>:null}{doc.tags.length?<div><dt>Tags</dt><dd>{doc.tags.join(', ')}</dd></div>:null}</dl>
          {versionRecord?<details className={styles.history}><summary>Immutable version information</summary><p>{versionRecord.changeReason||'Initial upload'}</p><small>Uploaded by {versionRecord.createdBy} · {date(versionRecord.createdAt)}</small><p className={styles.checksum}>SHA-256: {versionRecord.checksumSha256}</p></details>:null}
          <section className={styles.processing}><h4>Processing details</h4>{jobs.length?jobs.map(job=><article key={job.id}><div className={styles.row}><strong>{documentLabel(job.processingType)}</strong><DocumentStatus status={job.status}/></div><p className={styles.muted}>Attempt {job.attempts} of {job.maxAttempts}{job.provider?` · ${job.provider}`:''}</p>{job.sanitizedFailureMessage?<p className={styles.error}>{job.sanitizedFailureMessage}</p>:null}{job.failureCode?<small className={styles.muted}>Reference: {job.failureCode}</small>:null}</article>):<p className={styles.muted}>No processing job has been recorded for this version.</p>}{pollingStopped?<p className={styles.muted}>Automatic checks paused. Refresh status to check again.</p>:null}</section>
        </div>
        {selectedVersion?<DocumentReviewPanel key={selectedVersion} patientId={patientId} detail={detail} versionId={selectedVersion} onSourcePage={page=>{setSourcePage(page);setSourceRequest(value=>value+1);sourcePanel.current?.scrollIntoView({behavior:'smooth',block:'start'});}} onChanged={onChanged}/>:<div className={styles.empty}>Structured review becomes available after a version has completed secure processing.</div>}
      </div>
      {editing?<EditMetadataDialog patientId={patientId} document={doc} encounters={encounters} onClose={()=>setEditing(false)} onSaved={()=>{setEditing(false);onChanged();}}/>:null}
      {removing?<RemoveDocumentDialog patientId={patientId} document={doc} onClose={()=>setRemoving(false)} onSaved={()=>{setRemoving(false);onChanged();}}/>:null}
    </>:null}
  </section>;
}

function EditMetadataDialog({patientId,document,encounters,onClose,onSaved}:{patientId:string;document:ManagedDocument;encounters:DocumentEncounter[];onClose:()=>void;onSaved:()=>void}){
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const mutation=useDocumentMutationKey();
  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError('');try{const input=readMetadata(new FormData(event.currentTarget));await documentApi.metadata(patientId,document.id,input,mutation.key(input));mutation.clear();onSaved();}catch(failure){setError(documentError(failure));}finally{setBusy(false);}}
  return <DocumentDialog title="Edit document details" onClose={onClose} busy={busy}><form onSubmit={event=>void submit(event)}><div className="dialog-body"><fieldset disabled={busy}><MetadataFields value={document} encounters={encounters}/></fieldset>{error?<ErrorBanner message={error}/>:null}</div><div className="dialog-actions"><Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button><Button disabled={busy} type="submit">{busy?<Spinner/>:null}Save details</Button></div></form></DocumentDialog>;
}

function RemoveDocumentDialog({patientId,document,onClose,onSaved}:{patientId:string;document:ManagedDocument;onClose:()=>void;onSaved:()=>void}){
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const mutation=useDocumentMutationKey();
  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const reason=String(new FormData(event.currentTarget).get('reason')??'').trim();setBusy(true);setError('');try{await documentApi.remove(patientId,document.id,reason,mutation.key(reason));mutation.clear();onSaved();}catch(failure){setError(documentError(failure));}finally{setBusy(false);}}
  return <DocumentDialog title="Remove document" onClose={onClose} busy={busy}><form onSubmit={event=>void submit(event)}><div className="dialog-body"><p>Remove “{document.title}” from the active document list? The record and audit history are retained. Retention rules may prevent removal of reviewed records.</p><label>Reason<textarea name="reason" required minLength={5} maxLength={2000} rows={3} disabled={busy}/></label>{error?<ErrorBanner message={error}/>:null}</div><div className="dialog-actions"><Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="destructive" type="submit" disabled={busy}>{busy?<Spinner/>:null}Remove document</Button></div></form></DocumentDialog>;
}
