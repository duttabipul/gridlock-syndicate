(() => {
  'use strict';
  const API_BASE = ''; // Same Worker origin. Otherwise use your HTTPS Worker URL.
  const STORAGE = 'gridlock.phase2.session'; // Preserve existing Phase II seats.
  const $ = selector => document.querySelector(selector);
  const buttons = [...document.querySelectorAll('#controls [data-dir]')];
  const empty = () => ({ roomCode:'',players:[],player1Name:'',player2Name:'',activeRole:null,
    systemTimer:60,gameStarted:false,playerPos:null,keyCollected:false,gameWon:false,
    phase:'lobby',map:null,deadline:null,matchId:null,moveSeq:0,version:-1,
    stageIndex:0,stage:null,clearedStages:[],totalSecondsRemaining:0,performanceRank:null });
  let state=empty(), session=null, pending=null, busy=false, inFlight=false;
  let generation=0, failures=0, pollTimer=null, remaining=60, receivedAt=0, serverAt=0, gridSignature='';
  try { session=JSON.parse(sessionStorage.getItem(STORAGE)); } catch {}
  if(!session || !/^[A-Z0-9]{4}$/.test(session.roomCode||'') || !/^[a-f0-9]{64}$/.test(session.token||'')) session=null;
  if(session?.pending) pending=session.pending;
  const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
  const randomCode=()=>Array.from(crypto.getRandomValues(new Uint8Array(4)),v=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[v%32]).join('');
  function save(){try{session?sessionStorage.setItem(STORAGE,JSON.stringify({...session,pending})):sessionStorage.removeItem(STORAGE);}catch{}}
  function announce(text){$('#connection-status').textContent=text;}
  async function api(action,body,token){
    const abort=new AbortController(), timeout=setTimeout(()=>abort.abort(),7000);
    try{
      const response=await fetch(`${API_BASE}/api/${action}`,{method:'POST',cache:'no-store',signal:abort.signal,
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(body)});
      let data;try{data=await response.json();}catch{throw new Error('Invalid API response. Check the Worker deployment.');}
      if(!response.ok)throw Object.assign(new Error(data.error||'Request failed.'),{status:response.status});
      return data;
    }finally{clearTimeout(timeout);}
  }
  function update(data){
    if(data.version<state.version)return; // A delayed response cannot roll state back.
    const changed=state.matchId!==data.matchId;
    state=data;receivedAt=performance.now();serverAt=data.serverNow;failures=0;
    if(changed && data.phase==='playing') {
      $('#gameplay').classList.remove('stage-enter');
      requestAnimationFrame(()=>$('#gameplay').classList.add('stage-enter'));
    }
    if(pending && (pending.matchId!==state.matchId || state.moveSeq>=pending.seq || state.phase!=='playing')){pending=null;save();}
    render();
  }
  function reset(){generation++;clearTimeout(pollTimer);session=null;pending=null;state=empty();gridSignature='';save();render();}
  function paintGrid(){
    const grid=$('#game-grid'), navigator=state.activeRole==='Navigator';
    const signature=JSON.stringify([state.activeRole,state.map,state.playerPos,state.keyCollected]);
    if(signature===gridSignature)return;gridSignature=signature;grid.replaceChildren();
    grid.classList.toggle('blind',!navigator);$('#map-legend').hidden=!navigator;$('#coordinate-label').hidden=!navigator;
    if(!navigator){
      grid.setAttribute('aria-label','Blind Operator display. No map data available.');
      const label=document.createElement('p');label.className='blind-label';
      grid.style.removeProperty('--grid-size');
      label.textContent='VISUAL OVERRIDE STATE ACTIVE';grid.append(label);return;
    }
    if(!state.map||!state.playerPos)return;
    const size=state.map.size;
    grid.style.setProperty('--grid-size',size);
    grid.setAttribute('aria-label',`${size} by ${size} security grid. North is up.`);
    const is=(p,x,y)=>p[0]===x&&p[1]===y;
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){
      const cell=document.createElement('div');cell.className='cell';
      const coord=document.createElement('span');coord.className='coord';coord.textContent=String.fromCharCode(65+x)+(y+1);
      const symbol=document.createElement('span');symbol.className='symbol';symbol.setAttribute('aria-hidden','true');
      const descriptions=[coord.textContent];
      if(state.map.obstacles.some(p=>is(p,x,y))){cell.classList.add('obstacle');symbol.textContent='×';descriptions.push('Security barrier');}
      if(!state.keyCollected&&is(state.map.key,x,y)){cell.classList.add('key');symbol.textContent='⚿';descriptions.push('Matrix Key');}
      if(is(state.map.exit,x,y)){cell.classList.add('exit');symbol.textContent='▣';descriptions.push(state.keyCollected?'Unlocked exit':'Locked exit');}
      cell.append(coord,symbol);
      if(is(state.playerPos,x,y)){const tracker=document.createElement('span');tracker.className='tracker';tracker.textContent='●';tracker.setAttribute('aria-hidden','true');cell.append(tracker);descriptions.push('Operator');}
      cell.setAttribute('role','img');cell.setAttribute('aria-label',descriptions.join(', '));grid.append(cell);
    }
    $('#coordinate-label').textContent=`Operator: ${String.fromCharCode(65+state.playerPos[0])}${state.playerPos[1]+1} · North ↑`;
  }
  function clock(){
    remaining=state.deadline?Math.max(0,Math.ceil((state.deadline-(serverAt+performance.now()-receivedAt))/1000)):(state.stage?.seconds||60);
    if(state.phase==='lost')remaining=0;
    const label=state.phase==='won'?'ESCAPED':`${String(Math.floor(remaining/60)).padStart(2,'0')}:${String(remaining%60).padStart(2,'0')}`;
    $('#mission-timer').textContent=label;$('#mission-timer').classList.toggle('urgent',remaining<=10&&state.phase==='playing');
    buttons.forEach(b=>b.disabled=state.activeRole!=='Operator'||state.phase!=='playing'||remaining===0||!!pending||busy||failures>0);
  }
  function render(){
    const theme=state.stage||{bg:'#0c1013',signal:'#d4f36b'};
    document.documentElement.style.setProperty('--bg',theme.bg);
    document.documentElement.style.setProperty('--signal',theme.signal);
    document.documentElement.style.setProperty('--signal-ink',state.stageIndex===0?'#142000':'#fff');
    document.body.dataset.stage=String(state.stageIndex||0);
    $('#mission-title').textContent=`Stage ${(state.stageIndex||0)+1} / 3 — ${state.stage?.name||'Green Terminal'}`;
    $('#stage-details').textContent=state.stage?`${state.stage.difficulty} · ${state.stage.size}×${state.stage.size} · ${state.stage.count} barriers · ${state.stage.seconds}s`:'';
    $('#campaign-score').textContent=`Banked time: ${(state.totalSecondsRemaining||0).toFixed(1)}s`;
    const connected=!!session, playing=connected&&state.phase!=='lobby';
    $('.landing').hidden=connected;$('#lobby').hidden=!connected||playing;$('#gameplay').hidden=!playing;
    $('#create-room').disabled=$('#join-room').disabled=busy||connected;
    $('#operator-name').disabled=$('#room-code').disabled=busy||connected;
    $('#copy-code').disabled=!connected;$('#leave-room').disabled=$('#exit-mission').disabled=busy||!connected;
    $('.room-code').textContent=state.roomCode||session?.roomCode||'----';
    const list=$('.players');list.replaceChildren();
    for(const role of ['Navigator','Operator']){
      const player=state.players.find(p=>p.role===role),li=document.createElement('li');li.className='player';
      const icon=document.createElement('span');icon.className='avatar';icon.textContent=role[0];icon.setAttribute('aria-hidden','true');
      const body=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('p');
      name.textContent=player?`${player.name}${role==='Navigator'?' · Host':''}`:`Waiting for ${role}`;
      detail.textContent=player?`${role} · ${player.connected?'Connected':'Reconnecting'}`:'Share the room code with your partner.';
      body.append(name,detail);li.append(icon,body);list.append(li);
    }
    const ready=state.players.length===2&&state.players.every(p=>p.connected);
    $('#seat-status').textContent=ready?'Both seats filled':state.players.length===2?'Partner reconnecting':'Waiting for Operator';
    $('#start-mission').disabled=busy||!ready||state.activeRole!=='Navigator'||failures>0;
    $('#start-mission').textContent=state.activeRole==='Operator'?'Waiting for Navigator to start':ready?'Start campaign · 3 stages':'Waiting for Operator';
    $('#role-label').textContent=`${state.activeRole||''} · Room ${state.roomCode}`;
    $('#role-instructions').textContent=state.activeRole==='Navigator'?'Read the map and call out directions. You cannot move the Operator.':'Your map is hidden. Listen to your Navigator. Tap one direction at a time, or use arrow keys.';
    $('#mission-link').textContent=ready?'Voice link: nearby conversation or your separate call.':'Partner connection interrupted. The mission clock continues.';
    $('#inventory').textContent=state.keyCollected?'Inventory: Matrix Key acquired':'Inventory: empty';
    $('#game-feedback').textContent=state.feedback||'';
    const finished=['won','lost'].includes(state.phase);$('#outcome').hidden=!finished;
    $('#outcome').classList.toggle('loss',state.phase==='lost');
    $('#outcome-title').textContent=state.gameWon?'CAMPAIGN COMPLETE':'SYSTEM FAILURE / MISSION FAILED';
    $('#outcome-text').textContent=state.gameWon?`Syndicate Performance Rating: ${state.performanceRank} Rank · ${(state.totalSecondsRemaining||0).toFixed(1)} seconds banked.`:state.feedback||'';
    $('#stage-scorecard').replaceChildren();
    for(const stage of state.clearedStages||[]) {
      const row=document.createElement('li');row.textContent=`Stage ${stage.stage} · ${stage.name}: ${stage.secondsRemaining.toFixed(1)}s remaining`;
      $('#stage-scorecard').append(row);
    }
    $('#rematch').disabled=busy||state.activeRole!=='Navigator';
    $('#rematch').textContent=state.activeRole==='Navigator'?'Restart campaign · return to lobby':'Waiting for Navigator to restart';
    if(playing)paintGrid();clock();
  }
  function schedule(ms){clearTimeout(pollTimer);if(session)pollTimer=setTimeout(sync,ms);}
  async function sync(){
    if(!session)return;if(inFlight||busy){schedule(100);return;}
    const epoch=generation,auth=session;inFlight=true;
    try{
      const data=await api(pending?'move':'state',{roomCode:auth.roomCode,...(pending||{})},auth.token);
      if(epoch!==generation)return;update(data);announce('Live room connected.');
    }catch(e){
      if(epoch!==generation)return;
      if([401,404].includes(e.status)){reset();announce(e.message);return;}
      if(e.status&&pending){pending=null;save();}
      failures++;announce(e.status?e.message:'Connection interrupted. Retrying automatically…');render();
    }finally{inFlight=false;if(epoch===generation&&session)schedule(failures?Math.min(8000,500*2**failures):pending?0:state.phase==='playing'?200:1000);}
  }
  async function enter(action){
    if(busy||session)return;
    const name=$('#operator-name').value.trim();let roomCode=$('#room-code').value.trim().toUpperCase();
    if(!name||name.length>24){announce('Enter a callsign of 1–24 characters.');return;}
    if(action==='join'&&!/^[A-Z0-9]{4}$/.test(roomCode)){announce('Enter a four-character room code.');return;}
    if(action==='create')roomCode=randomCode();const token=randomToken();busy=true;render();announce('Connecting…');
    try{
      let data;
      for(let attempt=0;attempt<4;attempt++){
        try{data=await api(action,{name,roomCode},token);break;}
        catch(e){if(action==='create'&&e.status===409)roomCode=randomCode();else if(e.status||attempt===3)throw e;}
      }
      if(!data)throw new Error('Could not reserve room. Retry.');
      generation++;session={roomCode:data.roomCode,token};state=empty();save();update(data);announce('Room connected.');schedule(0);
    }catch(e){announce(e.message);}finally{busy=false;render();}
  }
  async function command(action){
    if(!session||busy)return;busy=true;render();const epoch=generation;
    try{
      const data=await api(action,{roomCode:session.roomCode},session.token);
      if(epoch!==generation)return;
      if(action==='leave'){reset();announce('You left the room.');}
      else{update(data);announce('Room synchronized.');}
    }catch(e){if(epoch===generation){if([401,404].includes(e.status))reset();announce(e.message||'Action failed. Reconnecting…');}}
    finally{busy=false;render();schedule(0);}
  }
  function move(direction){
    if(!session||pending||busy||failures||state.activeRole!=='Operator'||state.phase!=='playing'||remaining===0)return;
    pending={direction,matchId:state.matchId,seq:state.moveSeq+1};save();
    const button=buttons.find(b=>b.dataset.dir===direction);button.classList.add('tapped');setTimeout(()=>button.classList.remove('tapped'),180);
    clock();schedule(0); // Send immediately; no client-side coordinate guessing.
  }
  $('#create-room').onclick=()=>enter('create');$('#join-room').onclick=()=>enter('join');
  $('form').onsubmit=e=>{e.preventDefault();enter($('#room-code').value.trim()?'join':'create');};
  $('#room-code').oninput=e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4);
  $('#start-mission').onclick=()=>command('start');$('#rematch').onclick=()=>command('rematch');
  $('#refresh-leaderboard').onclick=async()=>{
    const button=$('#refresh-leaderboard');button.disabled=true;
    try {
      const data=await api('leaderboard',{},session?.token||randomToken());
      const list=$('#leaderboard-list');list.replaceChildren();
      for(const entry of data.scores) {
        const row=document.createElement('li');
        row.textContent=`${entry.navigator} + ${entry.operator} — ${entry.score.toFixed(1)}s · ${entry.rank}`;list.append(row);
      }
      $('#leaderboard-status').textContent=data.scores.length?'Top 20 completed campaigns on this deployment.':'No completed campaigns yet.';
    } catch {$('#leaderboard-status').textContent='Leaderboard unavailable. Your campaign is unaffected.';}
    finally {button.disabled=false;}
  };
  async function leave(){if(state.activeRole==='Navigator'&&!confirm('Leaving closes this room for both players. Continue?'))return;await command('leave');}
  $('#leave-room').onclick=$('#exit-mission').onclick=leave;
  $('#copy-code').onclick=async()=>{try{await navigator.clipboard.writeText(session.roomCode);announce('Room code copied.');}catch{announce(`Room code: ${session?.roomCode||''}`);}};
  buttons.forEach(button=>button.onclick=()=>move(button.dataset.dir));
  document.addEventListener('keydown',event=>{
    const direction={ArrowUp:'North',ArrowDown:'South',ArrowLeft:'West',ArrowRight:'East'}[event.key];
    if(!direction||event.repeat||event.target.closest('input,textarea,select,button,a,[contenteditable]'))return;
    if(state.activeRole==='Operator'&&state.phase==='playing'){event.preventDefault();move(direction);}
  });
  window.addEventListener('online',()=>schedule(0));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule(0);});
  setInterval(clock,100);render();
  if(session){announce('Restoring your connection…');schedule(0);}else announce('Enter a callsign to create or join a room.');
})();
