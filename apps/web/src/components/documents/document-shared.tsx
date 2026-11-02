'use client';

import {useEffect,useId,useRef,type ReactNode} from 'react';
import {X} from 'lucide-react';
import {documentLabel,documentTypes,type DocumentMetadataInput,type ManagedDocument} from '@/lib/document-api';
import styles from './documents.module.css';

export type DocumentEncounter={id:string;chiefComplaint:string};
export function DocumentStatus({status}:{status:string}){
  const tone=['reviewed','approved','verified','clean','safe','completed'].includes(status)?'positive':['failed','rejected','infected','quarantined'].includes(status)?'danger':['awaiting_review','pending_review','unverified','unable_to_verify','unavailable','legacy'].includes(status)?'caution':'neutral';
  return <span className={styles.badge} data-tone={tone}>{documentLabel(status)}</span>;
}
export function DocumentDialog({title,children,onClose,busy=false}:{title:string;children:ReactNode;onClose:()=>void;busy?:boolean}){
  const ref=useRef<HTMLDialogElement>(null);const titleId=useId();
  useEffect(()=>{const trigger=document.activeElement;ref.current?.showModal();return()=>{if(trigger instanceof HTMLElement&&trigger.isConnected)trigger.focus();};},[]);
  return <dialog ref={ref} className={`action-dialog ${styles.dialog}`} aria-labelledby={titleId} onCancel={event=>{event.preventDefault();if(!busy)onClose();}}><div className="dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Close dialog"><X size={20}/></button></div>{children}</dialog>;
}
export function MetadataFields({value,encounters=[],includeTitle=true}:{value?:Partial<ManagedDocument>;encounters?:DocumentEncounter[];includeTitle?:boolean}){
  return <div className={styles.fields}>
    {includeTitle?<label>Document title<input name="title" defaultValue={value?.title??''} required maxLength={200}/></label>:null}
    <div className={styles.formGrid}><label>Document type<select name="documentType" defaultValue={value?.documentType??'laboratory_report'}>{documentTypes.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><label>Document date<input name="documentDate" type="date" defaultValue={value?.documentDate?.slice(0,10)??''}/></label></div>
    <label>Healthcare provider<input name="healthcareProviderName" defaultValue={value?.healthcareProviderName??''} maxLength={200} placeholder="Hospital, clinic or laboratory"/></label>
    <label>Consultation<select name="encounterId" defaultValue={value?.encounterId??''}><option value="">No consultation link</option>{value?.encounterId&&!encounters.some(record=>record.id===value.encounterId)?<option value={value.encounterId}>Current linked consultation</option>:null}{encounters.map(record=><option key={record.id} value={record.id}>{record.chiefComplaint}</option>)}</select></label>
    <label>Description<textarea name="description" defaultValue={value?.description??''} maxLength={2000} rows={2}/></label>
    <label>Tags<input name="tags" defaultValue={value?.tags?.join(', ')??''} placeholder="Separate tags with commas" maxLength={819}/><span className={styles.muted}>Up to 20 tags, 40 characters each.</span></label>
  </div>;
}
export function readMetadata(form:FormData,title?:string):DocumentMetadataInput{
  const text=(name:string)=>String(form.get(name)??'').trim();
  const tags=[...new Set(text('tags').split(',').map(tag=>tag.trim()).filter(Boolean))];
  if(tags.length>20||tags.some(tag=>tag.length>40))throw new Error('Use up to 20 tags, each no longer than 40 characters.');
  return {title:title??text('title'),documentType:text('documentType') as DocumentMetadataInput['documentType'],documentDate:text('documentDate')||null,description:text('description'),healthcareProviderName:text('healthcareProviderName'),encounterId:text('encounterId')||null,tags};
}
/** Keep the same key when retrying an uncertain response to the same action. */
export function useDocumentMutationKey(){
  const pending=useRef<{intent:string;key:string}|null>(null);
  return {key:(intent:unknown)=>{const value=JSON.stringify(intent);if(pending.current?.intent!==value)pending.current={intent:value,key:crypto.randomUUID()};return pending.current.key;},clear:()=>{pending.current=null;}};
}
