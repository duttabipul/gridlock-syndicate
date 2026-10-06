const TTL = 2 * 60 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const reply = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (message, status) => { throw Object.assign(new Error(message), { status }); };
const code = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), n => ALPHABET[n % 32]).join('');

const DIRECTIONS = { North:[0,-1], South:[0,1], East:[1,0], West:[-1,0] };
const same = (a,b) => a[0] === b[0] && a[1] === b[1];
export const STAGES = [
  {name:'Green Terminal',difficulty:'Easy',size:5,count:3,seconds:60,bg:'#0c1013',signal:'#d4f36b'},
  {name:'Cyberpunk Subversives',difficulty:'Medium',size:7,count:6,seconds:45,bg:'#050914',signal:'#ff007f'},
  {name:'Meltdown Threat',difficulty:'Hard',size:9,count:12,seconds:30,bg:'#110909',signal:'#ff3c00'}
];
// Reserve a guaranteed route: left edge -> key row -> right edge -> exit.
// Random barriers never occupy that route, the start, the key, or the exit.
function level(index) {
  const {size,count}=STAGES[index], mid=Math.floor(size/2), candidates=[];
  for(let y=0;y<size;y++)for(let x=0;x<size;x++)
    if(!(x===0&&y<=mid || y===mid || x===size-1&&y>=mid))candidates.push([x,y]);
  for(let i=candidates.length-1;i>0;i--){const j=crypto.getRandomValues(new Uint32Array(1))[0]%(i+1);[candidates[i],candidates[j]]=[candidates[j],candidates[i]];}
  return {size,obstacles:candidates.slice(0,count),key:[mid,mid],exit:[size-1,size-1]};
}
function beginStage(room,index,now) {
  Object.assign(room,{stageIndex:index,map:level(index),playerPos:[0,0],keyCollected:false,
    systemTimer:STAGES[index].seconds,deadline:now+STAGES[index].seconds*1000,
    matchId:crypto.randomUUID(),moveSeq:0,stageStartedAt:now,
    feedback:`Stage ${index+1}: ${STAGES[index].name}. Collect the key, then reach the hatch.`});
}
function initialize(room) {
  Object.assign(room, { phase:'lobby', gameStarted:false, gameWon:false, systemTimer:60,
    playerPos:[0,0], keyCollected:false, map:level(0), deadline:null, matchId:null,
    campaignVersion:1,stageIndex:0,clearedStages:[],totalSecondsRemaining:0,performanceRank:null,
    moveSeq:0, feedback:'Collect the Matrix Key, then reach the exit hatch.' });
}
export class Room {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const body = await request.json();
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        const now=Date.now();
        // Only the Worker can send record; no public record endpoint exists.
        if(body.action==='record' || body.action==='leaderboard') {
          let scores=await this.ctx.storage.get('scores')||[];
          if(body.action==='record') {
            if(!scores.some(s=>s.id===body.entry.id)) {
              scores.push(body.entry);scores.sort((a,b)=>b.score-a.score||a.completedAt-b.completedAt);
              scores=scores.slice(0,20);await this.ctx.storage.put('scores',scores);
            }
          }
          return reply({scores});
        }
        let room=await this.ctx.storage.get('room');
        if(room && now>=room.expiresAt) room=null;
        const {action,token,name,roomCode}=body;
        const player=room?.players.find(p=>p.token===token);
        if(action==='create') {
          if(room) {
            if(player?.role==='Navigator') return reply(this.snapshot(room,player,now));
            fail('Code already in use.',409);
          }
          room={roomCode,players:[{id:crypto.randomUUID(),name,role:'Navigator',token,lastSeen:now}],version:0,expiresAt:now+TTL};
          initialize(room);
        } else {
          if(!room) fail('Room not found or expired.',404);
          // Upgrade an existing Phase II lobby in place.
          if(!room.phase || room.campaignVersion!==1) initialize(room);
          if(action==='join' && !player) {
            if(room.phase!=='lobby' || room.players.length>=2) fail('Room full or mission in progress.',409);
            room.players.push({id:crypto.randomUUID(),name,role:'Operator',token,lastSeen:now});
          } else {
            if(!player) fail('Your seat is no longer available.',401);
            if(room.phase==='playing' && now>=room.deadline) {
              room.phase='lost'; room.feedback='Time expired. The hatch is sealed.';
            }
            if(action==='leave') {
              if(player.role==='Navigator') { await this.ctx.storage.deleteAll(); return reply({left:true}); }
              room.players=room.players.filter(p=>p.id!==player.id);
              if(room.phase==='playing') { room.phase='lost'; room.feedback='Operator left the mission.'; }
            } else if(action==='start') {
              if(player.role!=='Navigator') fail('Only the Navigator can start.',403);
              if(room.phase==='lobby') {
                if(room.players.length!==2 || room.players.some(p=>now-p.lastSeen>=15000)) fail('Both players must be connected.',409);
                initialize(room); room.phase='playing';room.gameStarted=true;
                beginStage(room,0,now);
              }
            } else if(action==='move') {
              if(player.role!=='Operator') fail('Only the Operator can move.',403);
              if(body.matchId!==room.matchId) fail('This action belongs to an older mission.',409);
              if(!Number.isSafeInteger(body.seq) || body.seq<1 || !Object.hasOwn(DIRECTIONS,body.direction)) fail('Invalid movement command.',400);
              if(room.phase==='playing' && body.seq>room.moveSeq) {
                if(body.seq!==room.moveSeq+1) fail('Movement out of order. Refresh state.',409);
                const [dx,dy]=DIRECTIONS[body.direction];
                const next=[room.playerPos[0]+dx,room.playerPos[1]+dy];
                room.moveSeq=body.seq;
                if(next.some(v=>v<0 || v>=room.map.size)) room.feedback='Boundary reached. Choose another direction.';
                else if(room.map.obstacles.some(p=>same(p,next))) room.feedback='Security barrier. Movement blocked.';
                else {
                  room.playerPos=next;room.feedback='Movement confirmed.';
                  if(same(next,room.map.key) && !room.keyCollected) {room.keyCollected=true;room.feedback='Matrix Key collected.';}
                  if(same(next,room.map.exit)) {
                    if(room.keyCollected) {
                      const secondsRemaining=Math.max(0,(room.deadline-now)/1000);
                      room.clearedStages.push({stage:room.stageIndex+1,name:STAGES[room.stageIndex].name,secondsRemaining});
                      room.totalSecondsRemaining+=secondsRemaining;
                      if(room.stageIndex<STAGES.length-1)beginStage(room,room.stageIndex+1,now);
                      else {
                        room.phase='won';room.gameWon=true;
                        room.performanceRank=room.totalSecondsRemaining>60?'Gold':room.totalSecondsRemaining>30?'Silver':'Bronze';
                        room.feedback='All three stages cleared. Extraction complete.';
                      }
                    }
                    else room.feedback='Hatch locked. Find the Matrix Key first.';
                  }
                }
              }
              // Repeated sequence numbers and moves after expiry never move twice.
            } else if(action==='rematch') {
              if(player.role!=='Navigator') fail('Only the Navigator can reopen the lobby.',403);
              if(!['won','lost','lobby'].includes(room.phase)) fail('Finish the current mission first.',409);
              initialize(room);
            } else if(!['state','join'].includes(action)) fail('Unsupported action.',400);
          }
        }
        const me=room.players.find(p=>p.token===token);
        if(me) me.lastSeen=now;
        room.version++;room.expiresAt=now+TTL;
        await this.ctx.storage.put('room',room);
        await this.ctx.storage.setAlarm(room.expiresAt);
        return reply(action==='leave'?{left:true}:this.snapshot(room,me,now));
      } catch(e) { return reply({error:e.status?e.message:'Room service failed. Retry shortly.'},e.status||500); }
    });
  }
  snapshot(room,me,now) {
    return { roomCode:room.roomCode,
      players:room.players.map(({id,name,role,lastSeen})=>({id,name,role,connected:now-lastSeen<15000})),
      player1Name:room.players.find(p=>p.role==='Navigator')?.name||'',
      player2Name:room.players.find(p=>p.role==='Operator')?.name||'', activeRole:me.role,
      phase:room.phase||'lobby', systemTimer:room.phase==='playing'?Math.max(0,Math.ceil((room.deadline-now)/1000)):room.phase==='lost'?0:room.systemTimer,
      stageIndex:room.stageIndex,stage:STAGES[room.stageIndex],clearedStages:room.clearedStages,
      totalSecondsRemaining:room.totalSecondsRemaining,performanceRank:room.performanceRank,
      gameStarted:room.gameStarted,playerPos:me.role==='Navigator'?room.playerPos:null,
      map:me.role==='Navigator'?room.map:null,keyCollected:room.keyCollected,gameWon:room.gameWon,
      deadline:room.deadline,matchId:room.matchId,moveSeq:room.moveSeq,feedback:room.feedback,
      version:room.version,serverNow:now };
  }
  async alarm() {
    const room=await this.ctx.storage.get('room');
    if(!room || room.expiresAt<=Date.now()) await this.ctx.storage.deleteAll();
    else await this.ctx.storage.setAlarm(room.expiresAt);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const origin = request.headers.get('Origin');
    const allowed = new Set([url.origin, ...(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)]);
    if (origin && !allowed.has(origin)) return reply({ error: 'Frontend origin is not allowed.' }, 403);
    const cors = { 'Access-Control-Allow-Origin': origin || url.origin, 'Vary': 'Origin',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let response;
    try {
      if (request.method !== 'POST') fail('Use POST.', 405);
      if (!['/api/create','/api/join','/api/state','/api/leave','/api/start','/api/move','/api/rematch','/api/leaderboard'].includes(url.pathname)) fail('Unknown endpoint.', 404);
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
      if (!/^[a-f0-9]{64}$/.test(token || '')) fail('Missing or invalid session credential.', 401);
      const raw = await request.text();
      if (raw.length > 2048) fail('Request too large.', 413);
      let input;
      try { input = JSON.parse(raw); } catch { fail('Invalid JSON.', 400); }
      if (!input || typeof input !== 'object') fail('Invalid request.', 400);
      const action = url.pathname.slice(5);
      if(action==='leaderboard') {
        const stub=env.ROOMS.get(env.ROOMS.idFromName('__campaign_leaderboard__'));
        response=await stub.fetch(new Request('https://room.internal/',{method:'POST',body:JSON.stringify({action})}));
        const result=new Response(response.body,response);
        for(const [key,value] of Object.entries(cors))result.headers.set(key,value);
        return result;
      }
      const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
      if (['create','join'].includes(action) && (!name || name.length > 24 || /[\u0000-\u001f\u007f]/.test(name))) fail('Enter a callsign of 1–24 characters.', 400);
      let roomCode = typeof input.roomCode === 'string' ? input.roomCode.trim().toUpperCase() : '';
      if (roomCode && !/^[A-Z0-9]{4}$/.test(roomCode)) fail('Use a four-character room code.', 400);
      if (action !== 'create' && !roomCode) fail('Room code required.', 400);
      // Supplying the original code makes create retries idempotent.
      const fixedCode = !!roomCode;
      for (let attempt = 0; attempt < 8; attempt++) {
        if (!fixedCode) roomCode = code();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(roomCode));
        response = await stub.fetch(new Request('https://room.internal/', { method:'POST',
          body: JSON.stringify({ action, token, name, roomCode, direction: input.direction, matchId: input.matchId, seq: input.seq }) }));
        if (action !== 'create' || fixedCode || response.status !== 409) break;
      }
      if(response.ok && action==='move') {
        const data=await response.clone().json();
        if(data.gameWon) {
          const board=env.ROOMS.get(env.ROOMS.idFromName('__campaign_leaderboard__'));
          // Score comes from authoritative room state, never from the client.
          try { await board.fetch(new Request('https://room.internal/',{method:'POST',body:JSON.stringify({action:'record',entry:{
            id:data.matchId,navigator:data.player1Name,operator:data.player2Name,
            score:data.totalSecondsRemaining,rank:data.performanceRank,completedAt:Date.now()
          }})})); } catch { /* Gameplay success must survive leaderboard unavailability. */ }
        }
      }
    } catch (e) { response = reply({ error: e.status ? e.message : 'Service unavailable.' }, e.status || 500); }
    const result = new Response(response.body, response);
    for (const [key, value] of Object.entries(cors)) result.headers.set(key, value);
    return result;
  }
};
