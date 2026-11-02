'use client';

import {useEffect,useState} from 'react';
import {Activity,Clock3} from 'lucide-react';
import {documentApi,documentError,type DocumentTimelineEntry,type DocumentTrend} from '@/lib/document-api';
import {date,human} from '@/lib/utils';
import {Button,ErrorBanner,Spinner} from '../shared';
import type {DocumentEncounter} from './document-shared';
import styles from './documents.module.css';

export function DocumentHistory({patientId,revision,encounters,onOpen}:{patientId:string;revision:number;encounters:DocumentEncounter[];onOpen:(documentId:string)=>void}){
  const [timeline,setTimeline]=useState<DocumentTimelineEntry[]>([]);const [trends,setTrends]=useState<DocumentTrend[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [retry,setRetry]=useState(0);
  const [selected,setSelected]=useState('');const [oldest,setOldest]=useState(false);const [group,setGroup]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');setTimeline([]);setTrends([]);
    void Promise.allSettled([documentApi.timeline(patientId,controller.signal),documentApi.trends(patientId,controller.signal)]).then(results=>{
      if(controller.signal.aborted)return;
      if(results[0].status==='fulfilled')setTimeline(results[0].value.entries);
      if(results[1].status==='fulfilled')setTrends(results[1].value.trends);
      const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')setError(documentError(failed.reason));setLoading(false);
    });return()=>controller.abort();
  },[patientId,revision,retry]);
  const trend=trends.find(value=>value.key===selected)??trends[0];
  const ordered=[...timeline].sort((a,b)=>oldest?a.createdAt.localeCompare(b.createdAt):b.createdAt.localeCompare(a.createdAt));
  const groups=group?ordered.reduce<Record<string,DocumentTimelineEntry[]>>((all,entry)=>{(all[entry.encounterId??'unlinked']??=[]).push(entry);return all;},{}):{all:ordered};
  return <div className={styles.historyGrid}>
    <section className={styles.historyCard} aria-label="Verified laboratory trends"><h3><Activity size={18}/>Verified laboratory trends</h3><p className={styles.muted}>Only verified observations from approved current reports. Different units and methods are kept separate. Points show recorded measurements.</p>
      {loading?<div className={styles.loading}><Spinner/>Loading verified results…</div>:trend?<><label>Measurement<select value={trend.key} onChange={event=>setSelected(event.target.value)}>{trends.map(value=><option key={value.key} value={value.key}>{value.testName} · {value.unit||'unit not supplied'}{value.method?` · ${value.method}`:''}</option>)}</select></label><LabTrendChart trend={trend} onOpen={onOpen}/></>:<div className={styles.empty}>No verified, comparable measurements are available yet.</div>}
    </section>
    <section className={styles.historyCard} aria-label="Document timeline"><header className={styles.row}><h3><Clock3 size={18}/>Document timeline</h3><Button variant="ghost" size="sm" onClick={()=>setOldest(value=>!value)}>{oldest?'Oldest first':'Newest first'}</Button></header><label className={styles.checkbox}><input type="checkbox" checked={group} onChange={event=>setGroup(event.target.checked)}/>Group by consultation</label>
      {loading?<div className={styles.loading}><Spinner/>Loading timeline…</div>:ordered.length?<div className={styles.timeline}>{Object.entries(groups).map(([key,entries])=><section key={key}>{group?<h4>{key==='unlinked'?'No linked consultation':encounters.find(value=>value.id===key)?.chiefComplaint??'Linked consultation'}</h4>:null}<ol>{entries.map(entry=><li key={entry.id}><span className={styles.timelineDot}/><div><button className={styles.textButton} onClick={()=>onOpen(entry.documentId)}>{entry.title}</button><p>{human(entry.eventType)}</p><time dateTime={entry.createdAt}>{date(entry.createdAt)}</time></div></li>)}</ol></section>)}</div>:<p className={styles.empty}>No document events have been recorded.</p>}
    </section>
    {error?<ErrorBanner message={error} onRetry={()=>setRetry(value=>value+1)}/>:null}
  </div>;
}

export function LabTrendChart({trend,onOpen}:{trend:DocumentTrend;onOpen:(documentId:string)=>void}){
  const points=trend.points.filter(point=>Number.isFinite(Number(point.value))&&Number.isFinite(Date.parse(point.date))).sort((a,b)=>a.date.localeCompare(b.date));
  if(!points.length)return <p className={styles.empty}>This measurement has no dated numeric results.</p>;
  const values=points.flatMap(point=>[point.value,point.referenceLow,point.referenceHigh].filter((value):value is string=>value!==null).map(Number).filter(Number.isFinite));
  const minimum=Math.min(...values);const maximum=Math.max(...values);const padding=Math.max((maximum-minimum)*.15,Math.abs(maximum)*.05,.1);const low=minimum-padding;const high=maximum+padding;
  const first=Date.parse(points[0]!.date);const last=Date.parse(points.at(-1)!.date);
  const x=(value:string)=>last===first?300:55+(Date.parse(value)-first)/(last-first)*490;
  const y=(value:string)=>185-(Number(value)-low)/(high-low)*155;
  return <div className={styles.trend}>
    <svg viewBox="0 0 600 225" role="img" aria-label={`${trend.testName} in ${trend.unit}. ${points.length} verified measurements. Details and source links follow.`}>
      {[low,(low+high)/2,high].map((value,index)=><g key={index}><line x1="55" x2="555" y1={y(String(value))} y2={y(String(value))} stroke="#dce6df"/><text x="48" y={y(String(value))+4} textAnchor="end" fontSize="11" fill="currentColor">{Number(value.toPrecision(3))}</text></g>)}
      {points.map(point=><g key={point.observationId}>{point.referenceLow!==null&&point.referenceHigh!==null?<line x1={x(point.date)} x2={x(point.date)} y1={y(point.referenceLow)} y2={y(point.referenceHigh)} stroke="#bfd8ca" strokeWidth="10"><title>Report reference range: {point.referenceLow}–{point.referenceHigh} {trend.unit}</title></line>:null}<circle cx={x(point.date)} cy={y(point.value)} r="6" fill="#197566" stroke="white" strokeWidth="2" role="button" tabIndex={0} aria-label={`${point.value} ${trend.unit}, ${date(point.date,false)}. Open source report.`} onClick={()=>onOpen(point.documentId)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onOpen(point.documentId);}}}><title>{point.value} {trend.unit} · {date(point.date,false)}</title></circle></g>)}
      <text x="55" y="211" fontSize="11" fill="currentColor">{date(points[0]!.date,false)}</text><text x="555" y="211" fontSize="11" textAnchor="end" fill="currentColor">{date(points.at(-1)!.date,false)}</text>
    </svg>
    <p className={styles.muted}>Green points: verified results. Pale bars: that report’s reference range, when supplied.</p>
    <details><summary>View {points.length} measurements and sources</summary><div className={styles.tableScroll}><table className={styles.observations}><thead><tr><th scope="col">Date</th><th scope="col">Result</th><th scope="col">Source reference range</th><th scope="col">Source</th></tr></thead><tbody>{points.map(point=><tr key={point.observationId}><td>{date(point.date,false)}</td><td>{point.value} {trend.unit}</td><td>{point.referenceLow??'—'} – {point.referenceHigh??'—'}</td><td><button className={styles.textButton} onClick={()=>onOpen(point.documentId)}>Open report</button></td></tr>)}</tbody></table></div></details>
  </div>;
}
