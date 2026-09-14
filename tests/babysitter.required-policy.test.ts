import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequiredPolicyReader, classifyRequiredChecks, type RequiredPolicy } from '../server/babysitter.required-policy.ts'
import { PullRequestInbox } from '../server/babysitter.inbox.ts'
const repo = 'vite-hub/vitehub'
const classic = { contexts: ['ci'], checks: [{ context: 'ci', app_id: 15368 }], strict: false }
const policy: RequiredPolicy = { repository: repo, branch: 'main', status: 'known', source: 'github-rest-rules-and-protection', fetchedAt: '2026-09-13T00:00:00Z', required: [{ context: 'ci', appId: 15368 }] }

test('empty rulesets still honor classic protection and preserve app binding', async () => {
 const reader = createRequiredPolicyReader(async path => ({ status: 200, data: path.includes('/rules/') ? [] : classic }))
 const result = await reader(repo, 'main')
 assert.equal(result.status, 'known')
 assert.deepEqual(result.required, [{ context: 'ci', appId: 15368 }])
})

test('rulesets and classic contexts union without dropping integration constraints', async () => {
 const reader = createRequiredPolicyReader(async path => ({ status: 200, data: path.includes('/rules/') ? [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci', integration_id: 15368 }, { context: 'security', integration_id: null }, { context: 'ci', integration_id: 99 }] } }] : classic }))
 const result = await reader(repo, 'main')
 assert.deepEqual(result.required, [{ context: 'ci', appId: 15368 }, { context: 'security', appId: null }, { context: 'ci', appId: 99 }])
})

test('permission failures and ambiguous404 returnunknown; verifiedunprotected branch permits emptyclassic', async () => {
 for (const protectedBranch of [true, undefined]) {
  const reader = createRequiredPolicyReader(async path => path.includes('/rules/') ? { status:200, data:[] } : path.endsWith('/required_status_checks') ? { status:404 } : { status:200, data:{ protected:protectedBranch } })
  assert.equal((await reader(repo,'main')).status, 'unknown')
 }
 const unprotected = createRequiredPolicyReader(async path => path.includes('/rules/') ? { status:200, data:[] } : path.endsWith('/required_status_checks') ? { status:404 } : { status:200, data:{ protected:false } })
 assert.deepEqual((await unprotected(repo,'main')).required, [])
 assert.equal((await unprotected(repo,'main')).status, 'known')
 const denied=createRequiredPolicyReader(async path=>path.includes('/rules/')?{status:200,data:[]}:{status:403})
 assert.equal((await denied(repo,'main')).status,'unknown')
})

test('required workflows and incompletepayload never masquerade as knownempty policy', async () => {
 for (const data of [{}, [{type:'workflows'}], [{type:'required_status_checks',parameters:{}}]]) {
  const reader=createRequiredPolicyReader(async path=>({status:200,data:path.includes('/rules/')?data:classic}))
  assert.equal((await reader(repo,'main')).status,'unknown')
 }
})

test('cache shares concurrent reads per branch, knownTTL5m and failureTTL2m', async () => {
 let now=0, reads=0, deny=false
 const reader=createRequiredPolicyReader(async path=>{reads++;await Promise.resolve();return deny?{status:403}:{status:200,data:path.includes('/rules/')?[]:classic}}, {clock:()=>now})
 await Promise.all([reader(repo,'main'),reader(repo,'main')]);assert.equal(reads,2)
 now=299999;await reader(repo,'main');assert.equal(reads,2)
 now=300000;deny=true;assert.equal((await reader(repo,'main')).status,'unknown');assert.equal(reads,4)
 now=419999;await reader(repo,'main');assert.equal(reads,4)
 now=420000;deny=false;await reader(repo,'main');assert.equal(reads,6)
 await reader(repo,'release/next');assert.equal(reads,8)
})

function snapshot() {
 const inbox=new PullRequestInbox(':memory:',[repo])
 const s=inbox.seed(repo,{number:1,state:'open',user:{login:'onmax'},head:{sha:'current',ref:'feature'},base:{ref:'main'}})
 inbox.close();return s
}

test('missing required currenthead check is pending; oldhead and wrongapp do not satisfy requirement', () => {
 const s=snapshot()
 s.checks={a:{id:1,name:'ci',head_sha:'old',status:'completed',conclusion:'success',app:{id:15368}},b:{id:2,name:'ci',head_sha:'current',status:'completed',conclusion:'success',app:{id:99}}}
 assert.deepEqual(classifyRequiredChecks(s,policy),{state:'pending',checks:[{context:'ci',appId:15368,state:'pending'}],missing:['ci']})
})

test('currenthead latest appbound CI transitions pending to failed to passed', () => {
 const s=snapshot()
 s.checks={a:{id:1,name:'ci',head_sha:'current',status:'queued',app:{id:15368}}}
 assert.equal(classifyRequiredChecks(s,policy).state,'pending')
 s.checks.a!.status='completed';s.checks.a!.conclusion='failure';assert.equal(classifyRequiredChecks(s,policy).state,'failed')
 s.checks.b={id:2,name:'ci',head_sha:'current',status:'completed',conclusion:'success',app:{id:15368}}
 assert.equal(classifyRequiredChecks(s,policy).state,'passed')
 assert.equal(classifyRequiredChecks(s,{...policy,status:'unknown'}).state,'unknown')
 assert.equal(classifyRequiredChecks(s,{...policy,branch:'elsewhere'}).state,'unknown')
})

test('same-name check and status both required to pass for anysource context', () => {
 const s=snapshot(),any={...policy,required:[{context:'ci',appId:null}]}
 s.checks={a:{id:1,name:'ci',head_sha:'current',status:'completed',conclusion:'success',app:{id:15368}}}
 s.statuses={ci:{sha:'current',context:'ci',state:'pending'}}
 assert.equal(classifyRequiredChecks(s,any).state,'pending')
 s.statuses.ci!.state='error';assert.equal(classifyRequiredChecks(s,any).state,'failed')
 s.statuses.ci!.state='success';assert.equal(classifyRequiredChecks(s,any).state,'passed')
})

test('Contents-read branch summary supplies complete required checks when admin endpoint denies access', async () => {
 for (const status of [403,404]) {
  const reader=createRequiredPolicyReader(async path=>path.includes('/rules/')?{status:200,data:[]}:path.endsWith('/required_status_checks')?{status}:{status:200,data:{protected:true,protection:{enabled:true,required_status_checks:{...classic,enforcement_level:'everyone'}}}})
  const result=await reader(repo,'main')
  assert.equal(result.status,'known')
  assert.equal(result.classicSource,'branch-summary')
  assert.deepEqual(result.required,[{context:'ci',appId:15368}])
 }
})

test('partial branch summaries cannot erase missing app identity or disabled ambiguity', async () => {
 for(const summary of [{contexts:['ci'],enforcement_level:'everyone'},{contexts:['ci'],checks:[],enforcement_level:'everyone'},{...classic,enforcement_level:'off'}]) {
  const reader=createRequiredPolicyReader(async path=>path.includes('/rules/')?{status:200,data:[]}:path.endsWith('/required_status_checks')?{status:403}:{status:200,data:{protected:true,protection:{enabled:true,required_status_checks:summary}}})
  assert.equal((await reader(repo,'main')).status,'unknown')
 }
})
