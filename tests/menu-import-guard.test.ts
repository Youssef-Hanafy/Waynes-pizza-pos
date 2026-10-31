import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
it('refuses a legacy full-menu import before any write when an active menu exists',async()=>{
  const methods:string[]=[];
  const server=createServer((req,res)=>{methods.push(req.method!);res.setHeader('content-type','application/json');res.end(JSON.stringify([{id:'synthetic-existing-menu'}]));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('No test port');
  try{
    const child=spawn(process.execPath,['scripts/load-menu-full.mjs'],{env:{...process.env,NEXT_PUBLIC_SUPABASE_URL:`http://127.0.0.1:${address.port}`,SUPABASE_SERVICE_ROLE_KEY:'isolated-fixture-key'}});
    let output='';child.stderr.on('data',chunk=>output+=chunk);child.stdout.resume();
    const exit=await new Promise(resolve=>child.on('exit',resolve));
    expect(exit).toBe(1);expect(output).toContain('Import refused to preserve staff price edits');expect(methods).toEqual(['GET']);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
