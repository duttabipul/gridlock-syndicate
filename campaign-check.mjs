import assert from 'node:assert/strict';
import worker,{Room,STAGES} from './worker.mjs';
function context(){const data=new Map();let queue=Promise.resolve();return {storage:{get:async k=>structuredClone(data.get(k)),put:async(k,v)=>data.set(k,structuredClone(v)),deleteAll:async()=>data.clear(),setAlarm:async()=>{}},blockConcurrencyWhile(fn){const job=queue.then(fn);queue=job.catch(()=>{});return job;}};}
const objects=new Map(),tokens=['a'.repeat(64),'b'.repeat(64)];
const env={ROOMS:{idFromName:x=>x,get(x){if(!objects.has(x))objects.set(x,new Room(context()));return objects.get(x);}},ASSETS:{fetch:()=>new Response('html')}};
async function call(action,body={},operator=false){const res=await worker.fetch(new Request('https://game.test/api/'+action,{method:'POST',headers:{Authorization:'Bearer '+tokens[+operator]},body:JSON.stringify({roomCode:'TEST',...body})}),env);return {status:res.status,...await res.json()};}
await call('create',{name:'Navigator'});await call('join',{name:'Operator'},true);
assert.equal((await call('start',{},true)).status,403);
await call('start');
const ids=[];
for(let i=0;i<3;i++){
  const state=await call('state'),spec=STAGES[i];ids.push(state.matchId);
  assert.equal(state.stageIndex,i);assert.equal(state.map.size,spec.size);assert.equal(state.map.obstacles.length,spec.count);
  assert.equal(state.systemTimer,spec.seconds);
  const blind=await call('state',{},true);assert.equal(blind.map,null);assert.equal(blind.playerPos,null);
  assert.equal(blind.stageIndex,i);
  let seq=0;
  const move=direction=>call('move',{direction,matchId:state.matchId,seq:++seq},true);
  await move('North');assert.deepEqual((await call('state')).playerPos,[0,0]);
  await move('South');
  await call('move',{direction:'South',matchId:state.matchId,seq},true);
  assert.deepEqual((await call('state')).playerPos,[0,1]);
  const mid=Math.floor(spec.size/2);
  for(let y=1;y<mid;y++)await move('South');
  for(let x=0;x<spec.size-1;x++)await move('East');
  for(let y=mid;y<spec.size-1;y++)await move('South');
  const next=await call('state');assert.equal(next.clearedStages.length,i+1);
  assert.equal(next.phase,i===2?'won':'playing');
  if(i<2){assert.equal(next.keyCollected,false);assert.deepEqual(next.playerPos,[0,0]);assert.equal(next.moveSeq,0);}
  assert.equal((await call('move',{direction:'South',matchId:state.matchId,seq:1},false)).status,403);
  if(i<2)assert.equal((await call('move',{direction:'South',matchId:state.matchId,seq:99},true)).status,409);
}
let final=await call('state');assert.equal(final.gameWon,true);assert.equal(final.performanceRank,'Gold');
assert.equal(new Set(ids).size,3);assert.ok(final.totalSecondsRemaining>60&&final.totalSecondsRemaining<=135);
assert.equal((await call('leaderboard')).scores.length,1);
await call('move',{direction:'South',matchId:final.matchId,seq:final.moveSeq},true);
assert.equal((await call('leaderboard')).scores.length,1);
await call('rematch');assert.equal((await call('state')).players.length,2);assert.equal((await call('state')).totalSecondsRemaining,0);
await call('start');
const roomObject=objects.get('TEST'),room=await roomObject.ctx.storage.get('room');room.deadline=Date.now()-1;await roomObject.ctx.storage.put('room',room);
assert.equal((await call('state')).phase,'lost');assert.equal((await call('state',{},true)).phase,'lost');
assert.equal((await call('record')).status,404);
console.log('PASS: three stages, dimensions/barrier counts, guaranteed route, blind projection, stage clocks, duplicate and stale moves, authorization, final rank, leaderboard deduplication, restart, mutual timeout. Mock Durable Object storage; not a deployed integration test.');
