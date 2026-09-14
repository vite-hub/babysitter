import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createClaimStopCheck } from '../server/babysitter.scheduler-state.ts'
import { execFileSync, spawn } from 'node:child_process'
import { prepareProviderGit, createProviderProofLaunch, readProviderHeadProof, selectProviderHeadProof, providerGitEnvironment } from '../server/babysitter.provider-checkout.ts'
import { snapshotPrompt } from '../server/babysitter.snapshot-prompt.ts'
import { PullRequestInbox } from '../server/babysitter.inbox.ts'
test('provider starts at real head with remote and pushes a descendant commit', async t => {
 const root=await mkdtemp(join(tmpdir(),'babysitter-git-test-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const source=join(root,'source'),target=join(root,'provider'),remote=join(root,'remote.git')
 await mkdir(source);await mkdir(target)
 const git=(cwd: string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
 git(root,'init','--bare',remote);git(source,'init');git(source,'config','user.name','Test');git(source,'config','user.email','test@example.invalid')
 git(source,'remote','add','origin',remote);await writeFile(join(source,'file.txt'),'original\n');git(source,'add','file.txt');git(source,'commit','-m','initial');const head=git(source,'rev-parse','HEAD')
 git(source,'push','origin','HEAD:refs/heads/fix');git(source,'config','remote.origin.push','HEAD:refs/heads/fix')
 git(target,'init');await writeFile(join(target,'.git','stale-provider-state'),'old');await writeFile(join(target,'file.txt'),'original\n')
 await assert.rejects(prepareProviderGit(source,source),/must be separate/)
 await prepareProviderGit(source,target);assert.equal(git(target,'rev-parse','HEAD'),head);assert.equal(git(target,'remote','get-url','origin'),remote)
 await assert.rejects(readFile(join(target,'.git','stale-provider-state')), {code:'ENOENT'})
 await writeFile(join(target,'file.txt'),'repair\n');git(target,'add','file.txt');git(target,'commit','-m','repair');git(target,'push','origin')
 assert.equal(git(target,'rev-parse','HEAD^'),head)
 assert.equal(git(source,'rev-parse','HEAD'),head)
 assert.equal(await readFile(join(source,'file.txt'),'utf8'),'original\n')
})
test('prompt compaction is handled separately from provider checkout', t => {
 const inbox=new PullRequestInbox(':memory:',['vite-hub/vitehub']);t.after(()=>inbox.close())
 const snapshot=inbox.seed('vite-hub/vitehub',{number:1,state:'open',user:{login:'onmax'},head:{sha:'a',ref:'fix'},base:{ref:'main'}})
 snapshot.comments['1']={id:1,body:'x'.repeat(2_000_000)}
 const prompt=snapshotPrompt(snapshot)
 assert.match(prompt, /body omitted after (?:400|2000) characters/);assert.ok(prompt.includes('fullContextRetainedInInbox'));assert.equal(snapshot.comments['1'].body.length,2_000_000)
})

test('provider exit preserves protocol/status and head proof survives cleanup before first watcher read', async t => {
 const root=await mkdtemp(join(tmpdir(),'babysitter-proof-test-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const source=join(root,'source'),target=join(root,'provider');await mkdir(source);await mkdir(target)
 const git=(cwd: string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
 git(source,'init');git(source,'config','user.name','Test');git(source,'config','user.email','test@example.invalid');git(source,'remote','add','origin',source)
 await writeFile(join(source,'file.txt'),'base');git(source,'add','.');git(source,'commit','-m','base');const base=git(source,'rev-parse','HEAD')
 await writeFile(join(target,'file.txt'),'base');await prepareProviderGit(source,target)
 await writeFile(join(target,'file.txt'),'repair');git(target,'add','.');git(target,'commit','-m','repair');const repaired=git(target,'rev-parse','HEAD')
 const launch=await createProviderProofLaunch(source,target,process.execPath)
 const child=spawn(launch.command,[...launch.args,'-e',"process.stdin.once('data',data=>{process.stdout.write(data);process.exitCode=7})"],{stdio:['pipe','pipe','pipe']})
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.end('protocol-message\n')
 const [code,signal]=await once(child,'exit');assert.equal(code,7);assert.equal(signal,null);assert.equal(stdout,'protocol-message\n');assert.equal(stderr,'')
 // Model commits have finished, but provider cleanup may restore old Git state.
 git(target,'reset','--hard',base)
 const readLive=async()=>git(target,'rev-parse','HEAD')
 assert.equal(await readLive(),base)
 const selected=await selectProviderHeadProof(target,launch.proofPath,readLive)
 assert.deepEqual(selected,{head:repaired,source:'provider-exit'})
 assert.deepEqual(await selectProviderHeadProof(target,undefined,readLive),{head:base,source:'live-git'})
 assert.deepEqual(await selectProviderHeadProof(join(root,'different'),launch.proofPath,readLive),{head:base,source:'live-git'})
 await rm(target,{recursive:true,force:true})
 const inbox=new PullRequestInbox(':memory:',['vite-hub/vitehub']);t.after(()=>inbox.close())
 inbox.seed('vite-hub/vitehub',{number:1,state:'open',user:{login:'onmax'},head:{sha:base,ref:'fix'},base:{ref:'main'}})
 const claim=inbox.claim(1)[0]!,current=structuredClone(claim.snapshot);current.pr!.head.sha=repaired
 const check=createClaimStopCheck(claim,()=>current,async()=>(await selectProviderHeadProof(target,launch.proofPath,readLive)).head)
 assert.equal(await check(),undefined)
 current.pr!.head.sha='external';assert.match((await check())!,/differs from remote/)
 assert.equal(await readProviderHeadProof(launch.proofPath,join(root,'other')),undefined)
})

test('provider wrapper forwards SIGTERM without orphaning child and keeps signal exit', async t => {
 const root=await mkdtemp(join(tmpdir(),'babysitter-proof-signal-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const source=join(root,'source'),target=join(root,'provider');await mkdir(source);await mkdir(join(source,'.git'));await mkdir(target)
 const launch=await createProviderProofLaunch(source,target,process.execPath)
 const child=spawn(launch.command,[...launch.args,'-e',"process.stdout.write(String(process.pid)+'\\n');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','pipe']})
 const exit=once(child,'exit');const [data]=await once(child.stdout,'data');const pid=Number(String(data).trim())
 assert.ok(pid>0);child.kill('SIGTERM');const [code,signal]=await exit
 assert.equal(code,null);assert.equal(signal,'SIGTERM');assert.throws(()=>process.kill(pid,0),{code:'ESRCH'})
})

test('provider spawn failure exits127 without creating Git proof', async t => {
 const root=await mkdtemp(join(tmpdir(),'babysitter-proof-error-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const source=join(root,'source'),target=join(root,'provider');await mkdir(source);await mkdir(join(source,'.git'));await mkdir(target)
 const launch=await createProviderProofLaunch(source,target,join(root,'nonexistent-provider'))
 const child=spawn(launch.command,launch.args,{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b)
 const [code]=await once(child,'exit');assert.equal(code,127);assert.equal(output,'');assert.equal(await readProviderHeadProof(launch.proofPath,target),undefined)
})


test('scoped GitHub environment cannot redirect provider commits into prepared clone Git metadata', async t => {
 const root=await mkdtemp(join(tmpdir(),'babysitter-git-env-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const source=join(root,'source'),target=join(root,'provider');await mkdir(source);await mkdir(target)
 const git=(cwd: string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
 git(source,'init');git(source,'config','user.name','Test');git(source,'config','user.email','test@example.invalid');git(source,'remote','add','origin',source)
 await writeFile(join(source,'file.txt'),'base');git(source,'add','.');git(source,'commit','-m','base');const base=git(source,'rev-parse','HEAD')
 await writeFile(join(target,'file.txt'),'base');await prepareProviderGit(source,target)
 const scoped={...process.env,GIT_DIR:join(source,'.git'),GIT_WORK_TREE:'.',GIT_INDEX_FILE:join(source,'.git','index'),GIT_COMMON_DIR:join(source,'.git'),GH_TOKEN:'synthetic-token',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'credential.helper',GIT_CONFIG_VALUE_0:'test-credential-helper'}
 const sanitized=providerGitEnvironment(scoped)
 assert.equal(sanitized.GH_TOKEN,'synthetic-token');assert.equal(sanitized.GIT_CONFIG_VALUE_0,'test-credential-helper')
 for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR'])assert.equal(sanitized[key],undefined)
 assert.equal(scoped.GIT_DIR,join(source,'.git'))
 const code="const {writeFileSync}=require('node:fs');const {execFileSync}=require('node:child_process');writeFileSync('file.txt','repair');execFileSync('git',['add','file.txt']);execFileSync('git',['commit','-m','repair'],{stdio:'ignore'});process.stdout.write(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}))"
 // Red control: the deployed environment writes the preparation clone's
 // Git refs even though every command reports the provider as its cwd.
 const misdirected=execFileSync(process.execPath,['-e',code],{cwd:target,env:scoped,encoding:'utf8'}).trim()
 assert.notEqual(misdirected,base)
 assert.equal(git(source,'rev-parse','HEAD'),misdirected)
 assert.equal(git(target,'rev-parse','HEAD'),base)
 git(source,'reset','--hard',base)
 const reported=execFileSync(process.execPath,['-e',code],{cwd:target,env:sanitized,encoding:'utf8'}).trim()
 assert.notEqual(reported,base)
 assert.equal(git(target,'rev-parse','HEAD'),reported)
 assert.equal(git(source,'rev-parse','HEAD'),base)
 assert.equal(await readFile(join(source,'file.txt'),'utf8'),'base')
})
