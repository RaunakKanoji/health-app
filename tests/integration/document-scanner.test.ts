import {describe,expect,it} from 'vitest';
import {createServer,type AddressInfo} from 'node:net';
import {createDocumentScanner} from '../../packages/workflows/src/documents/scanner.ts';

describe('ClamD INSTREAM adapter',()=>{
 it.each([['stream: OK\0','safe'],['stream: Synthetic.Test FOUND\0','infected'],['stream: untrusted diagnostic\0','unavailable']] as const)('handles a bounded %s verdict without persisting scanner text',async(response,status)=>{
  const payload=Buffer.from('Synthetic scanner transport fixture'),received:Buffer[]=[];
  const server=createServer(socket=>{let bytes=Buffer.alloc(0),command=false;socket.on('data',chunk=>{
   bytes=Buffer.concat([bytes,chunk]);if(!command){if(bytes.length<10)return;expect(bytes.subarray(0,10).toString()).toBe('zINSTREAM\0');bytes=bytes.subarray(10);command=true;}
   while(bytes.length>=4){const length=bytes.readUInt32BE(0);if(bytes.length<length+4)return;if(!length){socket.end(response);return;}received.push(bytes.subarray(4,4+length));bytes=bytes.subarray(4+length);}
  });});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try{const port=(server.address() as AddressInfo).port;const result=await createDocumentScanner({CLAMAV_HOST:'127.0.0.1',CLAMAV_PORT:String(port)}).scan(payload);expect(result.status).toBe(status);expect(result.provider).toBe('clamav');expect(JSON.stringify(result)).not.toContain('untrusted diagnostic');expect(Buffer.concat(received)).toEqual(payload);}
  finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
 });
});
