import test from 'node:test';
import assert from 'node:assert/strict';
import { auxiliaryStatus } from '../lib/service-health.mjs';
import { fleetRuntimeIsOperational, fleetRuntimeIsHealthy } from '../worker/fleet-availability.mjs';

test('auxiliary requires matching live process and fresh heartbeat, not a cached running flag', () => {
 const now=20000, runtime={status:'running',pid:42}, heartbeat={pid:42,at:new Date(now).toISOString()};
 const options={now,isAlive:pid=>pid===42};
 assert.equal(auxiliaryStatus(runtime,heartbeat,options).online,true);
 assert.equal(auxiliaryStatus(runtime,{...heartbeat,pid:43},options).online,false);
 assert.equal(auxiliaryStatus(runtime,{...heartbeat,at:new Date(0).toISOString()},options).online,false);
 assert.equal(auxiliaryStatus(runtime,heartbeat,{now,isAlive:()=>false}).online,false);
 assert.equal(auxiliaryStatus({status:'RUNTIME_DEPENDENCY_UNAVAILABLE'},heartbeat,options).online,false);
});
test('missing optional auxiliaries do not mark the nine stage workers disconnected', () => {
 const now=20000, names=['analyze-1','analyze-2','analyze-3','clip-1','clip-2','clip-3','render-1','render-2','render-3'];
 const runtime={status:'running',pid:1,at:new Date(now).toISOString(),members:names.map((name,i)=>({name,pid:i+2}))};
 const options={now,isAlive:pid=>pid>0};
 assert.equal(fleetRuntimeIsOperational(runtime,options),true);
 assert.equal(fleetRuntimeIsHealthy(runtime,options),false);
 runtime.members.pop();
 assert.equal(fleetRuntimeIsOperational(runtime,options),false);
});
