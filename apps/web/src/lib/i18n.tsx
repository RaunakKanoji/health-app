'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import hindi from './hi.json';
export type InterfaceLanguage = 'en' | 'hi';
const messages: Record<string,string> = hindi;
export function translateInterface(text:string,language:InterfaceLanguage):string { return language === 'hi' ? messages[text] ?? text : text; }
type Locale = {language:InterfaceLanguage;setLanguage:(language:InterfaceLanguage)=>void;t:(text:string)=>string};
const LocaleContext=createContext<Locale>({language:'en',setLanguage:()=>{},t:text=>text});
export function LanguageProvider({children}:{children:ReactNode}) {
 const [language,setCurrentLanguage]=useState<InterfaceLanguage>('en');
 useEffect(()=>{try{if(localStorage.getItem('careloop.interface.language.v1')==='hi')setCurrentLanguage('hi');}catch{/* Storage is optional. */}},[]);
 useEffect(()=>{document.documentElement.lang=language;},[language]);
 const setLanguage=useCallback((next:InterfaceLanguage)=>{setCurrentLanguage(next);try{localStorage.setItem('careloop.interface.language.v1',next);}catch{/* In-memory selection remains available. */}},[]);
 const t=useCallback((text:string)=>translateInterface(text,language),[language]);
 const value=useMemo(()=>({language,setLanguage,t}),[language,setLanguage,t]);
 return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
export function useUiLanguage(){return useContext(LocaleContext);}
