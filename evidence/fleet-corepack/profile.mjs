import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createSshBoxRuntime, localTransport } from '../../server/fleet/ssh-box.ts'
const output=resolve('.data/dependency-bench')
const root=await mkdtemp(join(output,'profile-'))
const checkout=join(root,'source')
execFileSync('git',['clone','-q','--shared','--no-checkout','.',checkout])
execFileSync('git',['-C',checkout,'checkout','-q','--detach','daf551151753b5ac88d96356db231a2c338d643a'])
const baselinePath=join(root,'baseline.ts')
await writeFile(baselinePath,execFileSync('git',['show','daf551151753b5ac88d96356db231a2c338d643a:server/fleet/ssh-box.ts']))
const {createSshBoxRuntime:baselineRuntime}=await import(baselinePath)
const local=localTransport()
const rows=[]
try{
 for(const [label,makeRuntime] of [['seed',createSshBoxRuntime],['baseline',baselineRuntime],['candidate',createSshBoxRuntime]]){
  const trace=join(output,`strace-${label}.txt`)
  const {spawn}=await import('node:child_process')
  const transport={start(script){return script.includes('install.log') && script.includes('pnpm install')?spawn('strace',['-f','-c','-o',trace,'sh','-c',script],{stdio:'pipe'}):local.start(script)}}
  const runtime=makeRuntime({host:'local-profile',transport,root:join(root,'fleet'),path:process.env.PATH})
  const input={cwd:checkout,identity:'profile',plan:{env:{DEBUG:async()=>'corepack'},files:{},state:[]},requirements:[]}
  const plan=await runtime.prepare(input)
  const session=await runtime.open(input,{executionAuthority:plan.executionAuthority})
  try{
   const record=JSON.parse(Buffer.from(await session.files.read(`${session.cwd}/.git/vitehub-install.json`)).toString())
   if(record.status!=='installed')throw new Error(record.reason)
   const log=Buffer.from(await session.files.read(`${session.cwd.replace(/\/work$/,'')}/run/install.log`)).toString()
   const lines=log.split('\n').filter(l=>/corepack/.test(l)).map(l=>l.replaceAll(root,'FIXTURE'))
   rows.push({label,corepack:lines,syscalls:await readFile(trace,'utf8')})
  }finally{await session.close()}
 }
 await writeFile(join(output,'profile.json'),JSON.stringify({instrumented:true,reportedLatencySamples:false,rows},null,2))
 console.log(JSON.stringify(rows.map(({label,corepack})=>({label,corepack}))))
}finally{await rm(root,{recursive:true,force:true})}
