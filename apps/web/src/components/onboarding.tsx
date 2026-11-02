'use client';
import { useUiLanguage } from '@/lib/i18n';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ArrowRight, Clock3, ShieldCheck, Stethoscope, UserRound } from 'lucide-react';
import { request } from '@/lib/api';
import type { IdentityState } from '../../../../packages/contracts/src/identity';
import { AuthGate, useIdentity } from './auth-context';
import { IdentityShell } from './identity-shell';
import { Button, ErrorBanner, Spinner } from './shared';

export function OnboardingChoice() {
  const {t} = useUiLanguage();
  return <AuthGate mode="onboarding"><IdentityShell title="Welcome to CareLoop" description="Choose how you will use CareLoop. Clinical access requires an administrator’s approval."><div className="onboarding-choices">
    <Link href="/onboarding/patient" className="onboarding-choice panel"><UserRound size={28}/><h2>{t("I am a patient")}</h2><p>{t("Set up your profile and access your own care updates.")}</p><span className="text-link">{t("Complete patient profile")}<ArrowRight size={16}/></span></Link>
    <Link href="/onboarding/clinician" className="onboarding-choice panel"><Stethoscope size={28}/><h2>{t("I am a clinician")}</h2><p>{t("Request clinical access. Patient records stay unavailable until approval and assignment.")}</p><span className="text-link">{t("Request clinician access")}<ArrowRight size={16}/></span></Link>
  </div><p className="identity-note">{t("Administrator, coordinator and receiving-provider access is provisioned through trusted administration. Public registration cannot grant those permissions.")}</p></IdentityShell></AuthGate>;
}
export function PatientOnboarding() {
  const {t,language,setLanguage} = useUiLanguage();
  const {identity, refresh} = useIdentity();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();setBusy(true);setError('');
    const fields = new FormData(event.currentTarget);
    try {
      const result = await request<IdentityState>('/onboarding/patient', {method:'POST',body:JSON.stringify({name:fields.get('name'),birthDate:fields.get('birthDate'),language:fields.get('language'),consent:fields.get('consent')==='on',privacyAcknowledged:fields.get('privacy')==='on'})});
      setLanguage(fields.get('language')==='hi'?'hi':'en');
      const current = await refresh();
      if (current) router.replace(result.destination);
    } catch (failure) {setError(failure instanceof Error?failure.message:'Your profile could not be saved.');}
    finally {setBusy(false);}
  }
  return <AuthGate mode="onboarding"><IdentityShell title="Your patient profile" description="Add the minimum details your care team needs. You can choose optional reminders separately."><section className="panel onboarding-panel"><form onSubmit={submit} className="identity-form">
    <label>{t("Full name")}<input name="name" defaultValue={identity?.user.name??''} autoComplete="name" minLength={2} maxLength={120} required/></label>
    <label>{t("Date of birth")}<input name="birthDate" type="date" autoComplete="bday" max={new Date().toISOString().slice(0,10)} required/></label>
    <label>{t("Preferred interface language")}<select name="language" defaultValue={language}><option value="en">{t("English")}</option><option value="hi">हिन्दी</option></select></label>
    <label className="checkbox-label"><input name="consent" type="checkbox"/>{t("I allow optional email and SMS reminders. Delivery is simulated in this demonstration.")}</label>
    <div className="clinical-notice"><ShieldCheck size={20}/><p>{t("Your identity is managed by Clerk. Care information stays in CareLoop\u2019s protected database. Use synthetic information for this demonstration; do not enter real medical records.")}</p></div>
    <label className="checkbox-label"><input name="privacy" type="checkbox" required/>{t("I have read the privacy information and understand this is a synthetic demonstration.")}</label>
    {error?<ErrorBanner message={error}/>:null}<div className="auth-actions"><Link href="/onboarding">{t("Back")}</Link><Button type="submit" disabled={busy}>{busy?<Spinner/>:null}{t("Save profile and continue")}<ArrowRight size={16}/></Button></div>
  </form></section></IdentityShell></AuthGate>;
}
export function ClinicianOnboarding() {
  const {t} = useUiLanguage();
  const {identity, refresh} = useIdentity();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();setBusy(true);setError('');const fields=new FormData(event.currentTarget);
    try {
      const result=await request<IdentityState>('/onboarding/clinician',{method:'POST',body:JSON.stringify({professionalName:fields.get('professionalName'),specialty:fields.get('specialty'),registrationIdentifier:fields.get('registrationIdentifier'),institution:fields.get('institution'),privacyAcknowledged:fields.get('privacy')==='on'})});
      const current=await refresh();if(current)router.replace(result.destination);
    }catch(failure){setError(failure instanceof Error?failure.message:'Your access request could not be saved.');}finally{setBusy(false);}
  }
  return <AuthGate mode="onboarding"><IdentityShell title="Request clinician access" description="An administrator must review your request before any clinical permissions are granted."><section className="panel onboarding-panel"><form onSubmit={submit} className="identity-form">
    <label>{t("Professional name")}<input name="professionalName" autoComplete="name" defaultValue={identity?.user.name??''} minLength={2} maxLength={120} required/></label>
    <label>{t("Specialty")}<input name="specialty" minLength={2} maxLength={120} required/></label>
    <label>{t("Professional registration identifier")}<input name="registrationIdentifier" minLength={2} maxLength={120} required/><span className="field-hint">{t("Use a fictional identifier for this synthetic demonstration.")}</span></label>
    <label>{t("Affiliated institution (optional)")}<input name="institution" maxLength={160}/></label>
    <div className="clinical-notice"><ShieldCheck size={20}/><p>{t("Approval grants access within this demonstration only. It is not independent professional credential verification. Clinical records require a separate authorized care-team assignment.")}</p></div>
    <label className="checkbox-label"><input name="privacy" type="checkbox" required/>{t("I understand the demonstration approval and privacy boundaries.")}</label>
    {error?<ErrorBanner message={error}/>:null}<div className="auth-actions"><Link href="/onboarding">{t("Back")}</Link><Button type="submit" disabled={busy}>{busy?<Spinner/>:null}{t("Submit access request")}</Button></div>
  </form></section></IdentityShell></AuthGate>;
}
export function ClinicianPending() {
  const {t} = useUiLanguage();
  const {identity, refresh}=useIdentity();const router=useRouter();const[busy,setBusy]=useState(false);
  const rejected=identity?.onboarding.status==='rejected';
  async function check(){setBusy(true);const state=await refresh();if(state&&state.destination!=='/onboarding/clinician/pending')router.replace(state.destination);setBusy(false);}
  return <AuthGate mode="onboarding"><IdentityShell title={rejected?'Your access request was not approved':'Your request is awaiting review'} description="Clinical access remains unavailable until an administrator approves your request."><section className="panel onboarding-panel"><div className="identity-form"><Clock3 size={32}/><h2>{t(rejected?'Request rejected':'Pending demo approval')}</h2><p>{rejected?'Contact the platform administrator if your professional information needs correction or reconsideration.':'You can manage your account while the administrator reviews your request. Approval does not automatically grant access to patients.'}</p>{identity?.clinicianProfile?.reviewReason?<div className="clinical-notice"><p>{identity.clinicianProfile.reviewReason}</p></div>:null}<dl className="metadata-list"><div><dt>{t("Professional name")}</dt><dd>{identity?.clinicianProfile?.professionalName??identity?.user.name}</dd></div><div><dt>{t("Specialty")}</dt><dd>{identity?.clinicianProfile?.specialty??'Not supplied'}</dd></div></dl><div className="auth-actions"><Button onClick={()=>void check()} disabled={busy}>{busy?<Spinner/>:null}{t("Check request status")}</Button><Link href="/account">{t("Manage account")}</Link></div></div></section></IdentityShell></AuthGate>;
}
