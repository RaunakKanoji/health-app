import {createHash} from 'node:crypto';
import {createConnection} from 'node:net';
import {syntheticFixtureChecksums} from './synthetic-fixtures.ts';

export type ScanResult={status:'safe'|'infected'|'unavailable';provider:string;code?:string;syntheticFixture?:boolean};
export interface DocumentScanner {readonly provider:string;scan(bytes:Uint8Array):Promise<ScanResult>;}
const MAX_SCAN_BYTES=15*1024*1024;

/** ClamD INSTREAM transport is confined to a local socket/loopback; never send documents over cleartext remote TCP. */
export function createDocumentScanner(environment:Record<string,string|undefined>=process.env):DocumentScanner {
 const socketPath=environment.CLAMAV_SOCKET;
 const host=environment.CLAMAV_HOST;
 const port=Number(environment.CLAMAV_PORT??3310);
 const configured=Boolean(socketPath?.startsWith('/')||(['127.0.0.1','localhost','::1'].includes(host??'')&&Number.isInteger(port)&&port>0&&port<=65535));
 const fixtures=environment.DOCUMENT_SYNTHETIC_FIXTURES==='true'&&environment.DEMO_MODE==='true'&&['development','test'].includes(environment.DATABASE_ENVIRONMENT??'');
 return {
  provider:configured?'clamav':fixtures?'synthetic-fixture-sha256':'unconfigured',
  async scan(bytes){
   if(bytes.byteLength===0||bytes.byteLength>MAX_SCAN_BYTES)return {status:'unavailable',provider:'validation',code:'SCAN_SIZE_LIMIT'};
   const checksum=createHash('sha256').update(bytes).digest('hex');
   if(fixtures&&syntheticFixtureChecksums.has(checksum))return {status:'safe',provider:'synthetic-fixture-sha256',syntheticFixture:true};
   if(!configured)return {status:'unavailable',provider:'unconfigured',code:'SCANNER_UNAVAILABLE'};
   return new Promise<ScanResult>(resolve=>{
    const socket=socketPath?.startsWith('/')?createConnection({path:socketPath}):createConnection({host:host!,port});
    let response='',finished=false;
    const done=(result:ScanResult)=>{if(finished)return;finished=true;clearTimeout(deadline);socket.destroy();resolve(result);};
    const unavailable=()=>done({status:'unavailable',provider:'clamav',code:'SCANNER_UNAVAILABLE'});
    const deadline=setTimeout(unavailable,30000);
    socket.on('error',unavailable);
    socket.on('connect',()=>{
     socket.write('zINSTREAM\0');
     for(let offset=0;offset<bytes.byteLength;offset+=64*1024){
      const chunk=bytes.subarray(offset,Math.min(offset+64*1024,bytes.byteLength)),length=Buffer.alloc(4);length.writeUInt32BE(chunk.byteLength);socket.write(length);socket.write(chunk);
     }
     socket.write(Buffer.alloc(4));
    });
    socket.on('data',(chunk:Buffer)=>{
     response+=chunk.toString('utf8');if(response.length>2048){unavailable();return;}
     if(!response.includes('\0')&&!response.includes('\n'))return;
     const line=response.split(/[\0\n]/)[0]?.trim();
     if(line==='stream: OK')done({status:'safe',provider:'clamav'});
     else if(line?.startsWith('stream: ')&&line.endsWith(' FOUND'))done({status:'infected',provider:'clamav',code:'MALWARE_DETECTED'});
     else unavailable();
    });
    socket.on('end',()=>{if(!finished)unavailable();});
   });
  },
 };
}
