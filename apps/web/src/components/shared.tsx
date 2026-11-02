import type { ReactNode } from 'react';
import { AlertCircle, ArrowRight, Check, CheckCircle2, Circle, Clock3, FlaskConical, HeartPulse, Inbox, Loader2, ShieldCheck } from 'lucide-react';
import { cn, human } from '@/lib/utils';
import { Button } from './ui/button';

export function Logo({light = false}: {light?: boolean}) {
  return <div className={cn('brand', light && 'brand-light')}><span className="brand-symbol"><HeartPulse size={23} strokeWidth={2.1}/></span><span>CareLoop<span className="brand-ai"> AI</span></span></div>;
}
export function StatusBadge({status}: {status: string}) {
  const positive = ['CLOSED','COMPLETED','ACCEPTED','DELIVERED','DONE','VERIFIED'].includes(status);
  const caution = ['OVERDUE','UNREVIEWED','REQUESTED','QUEUED','PENDING'].includes(status);
  const danger = ['BLOCKED','FAILED','REJECTED','NO_SHOW'].includes(status);
  return <span className={cn('badge', positive ? 'badge-success' : danger ? 'badge-danger' : caution ? 'badge-warning' : 'badge-neutral')}><span className="badge-dot"/>{human(status)}</span>;
}
export function SyntheticLabel() { return <span className="synthetic-label"><FlaskConical size={12}/> Synthetic patient</span>; }
export function EmptyState({title, description, action}: {title: string; description: string; action?: ReactNode}) {
  return <div className="empty-state"><span className="empty-icon"><Inbox size={27}/></span><h3>{title}</h3><p>{description}</p>{action}</div>;
}
export function ErrorBanner({message, onRetry, onDismiss}: {message: string; onRetry?:()=>void; onDismiss?:()=>void}) {
  return <div className="error-banner" role="alert"><AlertCircle size={18}/><span>{message}</span>{onRetry ? <button onClick={onRetry}>Try again</button>:null}{onDismiss ? <button onClick={onDismiss}>Dismiss</button>:null}</div>;
}
export function LoadingState() { return <div className="loading-workspace" aria-busy="true" aria-label="Loading your care workspace"><div className="skeleton skeleton-title"/><div className="metric-grid">{[1,2,3,4].map(i=><div key={i} className="skeleton skeleton-card"/>)}</div><div className="skeleton skeleton-table"/><span className="sr-only">Loading your workspace</span></div>; }
export function Spinner() { return <Loader2 className="spin" size={17} aria-hidden="true"/>; }
export function PageTitle({eyebrow, title, description, action}: {eyebrow?: string; title: string; description: string; action?:ReactNode}) { return <header className="page-title"><div>{eyebrow ? <div className="eyebrow">{eyebrow}</div>:null}<h1>{title}</h1><p>{description}</p></div>{action}</header>; }
export function PanelHeading({title, subtitle, action}: {title:string;subtitle?:string;action?:ReactNode}) { return <div className="panel-heading"><div><h2>{title}</h2>{subtitle?<p>{subtitle}</p>:null}</div>{action}</div>; }
export function MetricCard({label,value,detail,icon,accent='teal'}:{label:string;value:string|number;detail:string;icon:ReactNode;accent?:string}) { return <article className="metric-card"><div className="metric-top"><span>{label}</span><span className={`metric-icon ${accent}`}>{icon}</span></div><strong>{value}</strong><div className="metric-detail">{detail}</div></article>; }
export function Step({complete,current,label}:{complete:boolean;current:boolean;label:string}) { return <div className={cn('care-step',complete && 'step-complete',current && 'step-current')}><span>{complete?<Check size={13}/>:current?<Circle size={10} fill="currentColor"/>:<Circle size={13}/>}</span><small>{label}</small></div>; }
export function SecurityNote() { return <div className="security-note"><ShieldCheck size={16}/><span>Human decisions. Traceable evidence. A complete care loop.</span></div>; }
export function TextLink({children,onClick}:{children:ReactNode;onClick:()=>void}) {return <button className="text-link" onClick={onClick}>{children}<ArrowRight size={15}/></button>;}
export function OutcomeIcon({done}:{done:boolean}) {return done?<CheckCircle2 className="text-teal" size={17}/>:<Clock3 className="text-muted" size={17}/>;}
export { Button };
