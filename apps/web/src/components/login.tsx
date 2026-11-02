'use client';
import { useState, type FormEvent } from 'react';
import { ArrowRight, Check, CircleCheck, HeartHandshake, LockKeyhole, ShieldCheck, Stethoscope, Users, UserRound, Building2, FlaskConical, Activity, Compass } from 'lucide-react';
import { api } from '@/lib/api';
import { Button, ErrorBanner, Logo, Spinner } from './shared';

const accounts = [
  {id:'clinician',label:'Clinician',icon:Stethoscope},
  {id:'coordinator',label:'Coordinator',icon:Users},
  {id:'patient',label:'Patient',icon:UserRound},
  {id:'receiver',label:'Receiving provider',icon:Building2},
  {id:'admin',label:'Administrator',icon:Compass},
];
export function Login({onSuccess}:{onSuccess:()=>Promise<void>}) {
  const [email,setEmail] = useState('clinician@careloop.demo');
  const [password,setPassword] = useState('CareLoop-Demo-2026!');
  const [error,setError] = useState('');
  const [loading,setLoading] = useState(false);
  async function submit(event:FormEvent) { event.preventDefault();setError('');setLoading(true);try{await api.login(email,password);await onSuccess();}catch(e){setError(e instanceof Error?e.message:'Unable to sign in.');}finally{setLoading(false);} }
  return <main className="login-page">
    <section className="login-story"><Logo light/><div className="story-body"><span className="story-eyebrow"><span/>CONNECTED CARE, FROM START TO FINISH</span><h1>Every result deserves<br/>a next step.</h1><p>Bring people, providers and evidence together.<br/>Make sure no one falls through the gaps.</p>
      <div className="loop-illustration" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit-center"><HeartHandshake size={45}/></div><div className="orbit-node node-a"><Activity size={19}/><span>Result received</span><Check size={14}/></div><div className="orbit-node node-b"><Stethoscope size={19}/><span>Clinician reviewed</span><Check size={14}/></div><div className="orbit-node node-c"><CircleCheck size={19}/><span>Care verified</span><Check size={14}/></div></div>
      <div className="story-points"><span><ShieldCheck size={17}/>Clinician governed</span><span><Users size={17}/>Connected teams</span><span><CircleCheck size={17}/>Evidence led</span></div>
    </div><div className="story-footer">CARELOOP AI <span>SCREENING → FOLLOW-UP → VERIFIED CARE</span></div></section>
    <section className="login-form-panel"><div className="login-demo"><FlaskConical size={15}/>SYNTHETIC DEMONSTRATION</div><div className="login-form-wrap"><span className="eyebrow">YOUR CARE COORDINATION WORKSPACE</span><h2>Welcome to CareLoop</h2><p className="login-intro">Sign in to keep the next step in sight.</p>
      <div className="demo-accounts"><span className="field-label">Explore a demo workspace</span><div className="account-grid">{accounts.map(a=><button key={a.id} className={email===`${a.id}@careloop.demo`?'account-option selected':'account-option'} onClick={()=>{setEmail(`${a.id}@careloop.demo`);setPassword('CareLoop-Demo-2026!');}}><a.icon size={17}/>{a.label}{email===`${a.id}@careloop.demo`?<Check size={13}/>:null}</button>)}</div></div>
      <form onSubmit={submit} className="login-form"><label>Email address<input type="email" autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)} required/></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label>{error?<ErrorBanner message={error}/>:null}<Button type="submit" disabled={loading}>{loading?<Spinner/>:<LockKeyhole size={16}/>}Sign in to workspace<ArrowRight size={16}/></Button></form>
      <div className="demo-credentials">Local demo password: <code>CareLoop-Demo-2026!</code></div><div className="login-boundary"><ShieldCheck size={19}/><p>All records are synthetic. Messages stay in the local inbox. Clinical decisions require an authorized human.</p></div>
    </div><footer className="login-footer">Care coordination prototype <span>Not approved for clinical use</span></footer></section>
  </main>;
}
