'use client';
import { SignIn, SignUp, useAuth, useSession } from '@clerk/nextjs';
import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Activity, Check, CircleCheck, FlaskConical, Globe2, HeartHandshake, ShieldCheck, Stethoscope, Users } from 'lucide-react';
import { Logo } from './shared';
import { AuthLoading } from './auth-context';
import { safeReturnPath } from '@/lib/auth-routing';
import { useUiLanguage } from '@/lib/i18n';

// The borderless form needs room for field focus rings and Clerk's "Last used" badge.
const authAppearance = {
  elements: {
    cardBox: { overflow: 'visible' },
    card: { marginInline: 0, marginBlockStart: 0 },
  },
} as const;

export function Login({mode='sign-in'}: {mode?:'sign-in'|'sign-up'}) {
  const {language,setLanguage}=useUiLanguage();const hi=language==='hi';
  const {isLoaded,isSignedIn}=useAuth({treatPendingAsSignedOut:true});const {session}=useSession();const router=useRouter();const search=useSearchParams();
  const next=safeReturnPath(search.get('next'));
  const continuation=`/auth/continue${next?`?next=${encodeURIComponent(next)}`:''}`;
  const pendingTask=session?.status==='pending';
  useEffect(()=>{
    // Clerk's prebuilt SignIn resumes required session tasks before CareLoop opens.
    if(isLoaded&&pendingTask&&mode==='sign-up')router.replace(`/sign-in${next?`?next=${encodeURIComponent(next)}`:''}`);
    else if(isLoaded&&isSignedIn)router.replace(continuation);
  },[isLoaded,isSignedIn,pendingTask,mode,next,continuation,router]);
  if(isSignedIn||(pendingTask&&mode==='sign-up'))return <AuthLoading/>;
  return <main className="login-page">
    <section className="login-story" lang={language}><Logo light/><div className="story-body"><span className="story-eyebrow"><span/>{hi?'शुरू से अंत तक जुड़ी देखभाल':'CONNECTED CARE, FROM START TO FINISH'}</span><h1>{hi?'हर परिणाम के बाद':'Every result deserves'}<br/>{hi?'अगला कदम ज़रूरी है।':'a next step.'}</h1><p>{hi?'लोगों, प्रदाताओं और प्रमाणों को साथ लाएँ।':'Bring people, providers and evidence together.'}<br/>{hi?'ताकि कोई भी देखभाल से वंचित न रहे।':'Make sure no one falls through the gaps.'}</p>
      <div className="loop-illustration" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit-center"><HeartHandshake size={45}/></div><div className="orbit-node node-a"><Activity size={19}/><span>{hi?'परिणाम मिला':'Result received'}</span><Check size={14}/></div><div className="orbit-node node-b"><Stethoscope size={19}/><span>{hi?'डॉक्टर की समीक्षा':'Clinician reviewed'}</span><Check size={14}/></div><div className="orbit-node node-c"><CircleCheck size={19}/><span>{hi?'देखभाल सत्यापित':'Care verified'}</span><Check size={14}/></div></div>
      <div className="story-points"><span><ShieldCheck size={17}/>{hi?'डॉक्टर की निगरानी':'Clinician governed'}</span><span><Users size={17}/>{hi?'जुड़ी हुई टीमें':'Connected teams'}</span><span><CircleCheck size={17}/>{hi?'प्रमाण आधारित':'Evidence led'}</span></div>
    </div><div className="story-footer">CARELOOP AI <span>{hi?'स्क्रीनिंग → फॉलो-अप → सत्यापित देखभाल':'SCREENING → FOLLOW-UP → VERIFIED CARE'}</span></div></section>
    <section className="login-form-panel" lang={language}><button type="button" className="language-toggle" onClick={()=>setLanguage(hi?'en':'hi')}><Globe2 size={16}/>{hi?'English':'हिन्दी'}</button><div className="login-demo"><FlaskConical size={15}/>{hi?'काल्पनिक प्रदर्शन':'SYNTHETIC DEMONSTRATION'}</div><div className="login-form-wrap clerk-login-wrap"><span className="eyebrow">{hi?'आपकी देखभाल समन्वय कार्यस्थली':'YOUR CARE COORDINATION WORKSPACE'}</span><h2>{hi?'CareLoop में आपका स्वागत है':'Welcome to CareLoop'}</h2><p className="login-intro">{hi?'आगे की जानकारी देखने के लिए साइन इन करें।':'Secure access to your care coordination workspace.'}</p>
      {mode==='sign-in'?<SignIn appearance={authAppearance} routing="path" path="/sign-in" signUpUrl="/sign-up" forceRedirectUrl={continuation} signUpForceRedirectUrl={continuation} fallback={<AuthLoading/>}/>:<SignUp appearance={authAppearance} routing="path" path="/sign-up" signInUrl="/sign-in" forceRedirectUrl={continuation} signInForceRedirectUrl={continuation} fallback={<AuthLoading/>}/>}
      <div className="login-boundary"><ShieldCheck size={19}/><p>{hi?'सभी रिकॉर्ड काल्पनिक हैं। नए डॉक्टरों को व्यवस्थापक की अनुमति चाहिए।':'All care records are synthetic. New clinicians require administrator approval and patient-specific access.'}</p></div>
    </div><footer className="login-footer">{hi?'देखभाल समन्वय प्रोटोटाइप':'Care coordination prototype'} <span>{hi?'चिकित्सीय उपयोग के लिए स्वीकृत नहीं':'Not approved for clinical use'}</span></footer></section>
  </main>;
}
