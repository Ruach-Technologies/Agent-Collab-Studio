import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { Database, openDb, LEGACY_SCHEMA, LEGACY_WORKSPACE_ID, hubIdentity } from '../src/db.js';
import { TokenRegistry } from '../src/tokens.js';
import { buildServer, type BuiltHub } from '../src/server.js';

let dir: string;
let hub: BuiltHub | undefined;
const sockets: WebSocket[] = [];
beforeEach(() => { dir=mkdtempSync(join(tmpdir(),'collab-workspaces-')); });
afterEach(async () => { for (const socket of sockets.splice(0)) socket.terminate(); await hub?.app.close(); hub=undefined; rmSync(dir,{recursive:true,force:true}); });
const auth=(token:string)=>({authorization:`Bearer ${token}`});
function workspace(db: ReturnType<typeof openDb>, name='Other') {
  const id='wks_1111111111111111';
  db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run(id,name,new Date().toISOString());
  return id;
}
async function fixture() {
  hub=await buildServer({HUB_DATA_DIR:join(dir,'data'),HUB_WORKSPACES_DIR:join(dir,'workspaces'),HUB_WEB_DIST:join(dir,'missing'),HUB_LOG_LEVEL:'silent'});
  const registry=new TokenRegistry(hub.services.db);
  const other=workspace(hub.services.db);
  const left=registry.issue('operator','supervisor');
  const right=registry.issue('operator','supervisor',other);
  const room=hub.services.rooms.create({name:'Shared name'},left.agent.id).id;
  const foreign=hub.services.rooms.create({name:'Shared name'},right.agent.id).id;
  return { hub,registry,other,left,right,room,foreign };
}

describe('workspace migration',()=>{
  it('preserves populated legacy data, rowids, hashes and instance identity with a private consistent backup',()=>{
    const path=join(dir,'hub.sqlite');
    const old=new Database(path); old.exec(LEGACY_SCHEMA);
    const now='2026-01-01T00:00:00.000Z';
    old.prepare('INSERT INTO agents VALUES (?,?,?,?,?)').run('agt_aaaaaaaaaaaaaaaa','legacy','agent',now,null);
    old.prepare('INSERT INTO tokens VALUES (?,?,?,?,?,?,?)').run('tok_aaaaaaaaaaaaaaaa','agt_aaaaaaaaaaaaaaaa','agent','hash-unchanged',now,null,null);
    old.prepare('INSERT INTO rooms VALUES (?,?,?,?,?,?,?)').run('room_aaaaaaaaaaaaaaaa','Legacy room','legacy-room','Project','agt_aaaaaaaaaaaaaaaa',now,null);
    old.prepare('INSERT INTO members VALUES (?,?,?)').run('room_aaaaaaaaaaaaaaaa','agt_aaaaaaaaaaaaaaaa',now);
    old.prepare('INSERT INTO messages (rowid,id,room_id,sender_id,recipient_id,body,created_at) VALUES (41,?,?,?,?,?,?)').run('msg_aaaaaaaaaaaaaaaa','room_aaaaaaaaaaaaaaaa','agt_aaaaaaaaaaaaaaaa',null,'preserved',now);
    old.prepare('INSERT INTO events (id,type,room_id,actor_id,payload,created_at) VALUES (73,?,?,?,?,?)').run('message.created','room_aaaaaaaaaaaaaaaa','agt_aaaaaaaaaaaaaaaa','{"keep":true}',now);
    old.close();
    const db=openDb(path);
    expect(db.prepare('SELECT rowid,body FROM messages').get()).toEqual({rowid:41,body:'preserved'});
    expect(db.prepare('SELECT id,payload,workspace_id FROM events').get()).toEqual({id:73,payload:'{"keep":true}',workspace_id:LEGACY_WORKSPACE_ID});
    expect(db.prepare('SELECT token_hash,workspace_id FROM tokens').get()).toEqual({token_hash:'hash-unchanged',workspace_id:LEGACY_WORKSPACE_ID});
    expect(db.pragma('foreign_key_check')).toEqual([]);
    const identity=hubIdentity(db); expect(identity.instance_id).toMatch(/^hub_[a-f0-9]{32}$/);
    db.close();
    const backup=readdirSync(dir).find(name=>name.includes('.pre-workspaces-'))!;
    expect(statSync(join(dir,backup)).mode & 0o777).toBe(0o600);
    const original=new Database(join(dir,backup),{readonly:true});
    expect(original.pragma('user_version',{simple:true})).toBe(0);
    expect(original.prepare('SELECT rowid FROM messages').get()).toEqual({rowid:41}); original.close();
    const reopened=openDb(path); expect(hubIdentity(reopened)).toEqual(identity); reopened.close();
    expect(readdirSync(dir).filter(name=>name.includes('.pre-workspaces-'))).toHaveLength(1);
  });
  it('refuses a legacy server startup without explicit migration approval',async()=>{
    const data=dir; const path=join(dir,'hub.sqlite'); const db=new Database(path); db.exec(LEGACY_SCHEMA); db.close();
    await expect(buildServer({HUB_DATA_DIR:data,HUB_WORKSPACES_DIR:join(dir,'workspaces'),HUB_LOG_LEVEL:'silent'})).rejects.toThrow('explicitly approved stopped cutover');
    const unchanged=new Database(path); expect(unchanged.pragma('user_version',{simple:true})).toBe(0); unchanged.close();
    expect(readdirSync(dir).filter(name=>name.includes('.pre-workspaces-'))).toEqual([]);
  });
  it('rolls back the complete migration when existing foreign references are invalid',()=>{
    const path=join(dir,'invalid.sqlite'); const db=new Database(path); db.exec(LEGACY_SCHEMA); db.pragma('foreign_keys = OFF');
    db.prepare('INSERT INTO tokens VALUES (?,?,?,?,?,?,?)').run('tok_a','missing','agent','hash','now',null,null); db.close();
    expect(()=>openDb(path)).toThrow('foreign-key validation');
    const after=new Database(path); expect(after.pragma('user_version',{simple:true})).toBe(0);
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name='workspaces'").get()).toBeUndefined();
    expect(after.prepare('SELECT token_hash FROM tokens').get()).toEqual({token_hash:'hash'}); after.close();
  });
});

describe('workspace authorization',()=>{
  it('scopes identity, duplicate names/slugs, catalogs, messages, audits, files and sandbox tools for every role',async()=>{
    const {hub,registry,other,left,right,room,foreign}=await fixture();
    const leftRoom=hub.services.rooms.get(room)!; const rightRoom=hub.services.rooms.get(foreign)!;
    expect(leftRoom.slug).toBe(rightRoom.slug);
    const message=hub.services.rooms.postMessage(foreign,right.agent.id,'FOREIGN-SENTINEL');
    const sandbox='sbx_2222222222222222';
    hub.services.db.prepare("INSERT INTO sandboxes (id,room_id,container_name,image,status,created_at,updated_at) VALUES (?,?,?,?,'running',?,?)").run(sandbox,foreign,'foreign','test','now','now');
    const effects=vi.spyOn(hub.services.sandbox,'exec');
    for (const role of ['supervisor','agent','observer'] as const) {
      const identity=registry.issue(`viewer-${role}`,role);
      if (role!=='observer') hub.services.rooms.join(room,identity.agent.id);
      const who=await hub.app.inject({url:'/v1/whoami',headers:auth(identity.token)});
      expect(who.json()).toMatchObject({agent:{workspace_id:LEGACY_WORKSPACE_ID},workspace:{id:LEGACY_WORKSPACE_ID},instance_id:hubIdentity(hub.services.db).instance_id});
      for (const path of ['/v1/agents','/v1/rooms','/v1/events']) {
        const reply=await hub.app.inject({url:path,headers:auth(identity.token)});
        expect(reply.statusCode).toBe(200); expect(reply.body).not.toContain(other); expect(reply.body).not.toContain('FOREIGN-SENTINEL');
      }
      for (const path of [`/v1/rooms/${foreign}/members`,`/v1/rooms/${foreign}/messages`,`/v1/rooms/${foreign}/sandbox`,
        `/v1/sandboxes/${sandbox}/files`,`/v1/sandboxes/${sandbox}/file?path=x`,`/v1/sandboxes/${sandbox}/execs`]) {
        expect((await hub.app.inject({url:path,headers:auth(identity.token)})).statusCode).toBe(404);
      }
      for (const path of [`/v1/rooms/${foreign}/join`,`/v1/rooms/${foreign}/messages`,`/v1/rooms/${foreign}/sandbox`,`/v1/sandboxes/${sandbox}/exec`]) {
        const response=await hub.app.inject({method:'POST',url:path,headers:auth(identity.token),payload:path.endsWith('/messages') ? {body:'no'} : path.endsWith('/exec') ? {cmd:'pwd'} : {}});
        expect([403,404]).toContain(response.statusCode);
      }
      expect((await hub.app.inject({method:'PUT',url:`/v1/sandboxes/${sandbox}/file`,headers:auth(identity.token),payload:{path:'x',content:'no'}})).statusCode).toBe(role==='observer'?403:404);
      expect(hub.services.rooms.join(foreign,identity.agent.id)).toBe(false);
      expect(()=>hub.services.rooms.postMessage(foreign,identity.agent.id,'no')).toThrow('Room not found');
      expect(()=>hub.services.rooms.messages(foreign,identity.agent)).toThrow('Room not found');
    }
    expect(effects).not.toHaveBeenCalled();
    expect(message.room_id).toBe(foreign);
    const changed=await hub.app.inject({method:'POST',url:'/v1/rooms',headers:auth(left.token),payload:{name:'escape',workspace_id:other}});
    expect(changed.statusCode).toBe(400);
  });
  it('rejects cross-workspace relational links and immutable scope updates in the database',async()=>{
    const {hub,left,right,room,foreign}=await fixture(); const db=hub.services.db;
    expect(()=>db.prepare('INSERT INTO members VALUES (?,?,?)').run(foreign,left.agent.id,'now')).toThrow('workspace mismatch');
    expect(()=>db.prepare('UPDATE agents SET workspace_id=? WHERE id=?').run(right.agent.workspace_id,left.agent.id)).toThrow('immutable workspace');
    expect(()=>db.prepare('UPDATE tokens SET workspace_id=? WHERE agent_id=?').run(right.agent.workspace_id,left.agent.id)).toThrow('immutable token');
    expect(()=>db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run('msg_x',room,left.agent.id,right.agent.id,'no','now')).toThrow('workspace mismatch');
    expect(()=>hub.services.events.append({type:'message.created',room_id:room,actor_id:right.agent.id})).toThrow('workspace mismatch');
  });
  it('does not reveal foreign WS presence/events and refreshes role and revocation without reconnecting',async()=>{
    const {hub,registry,right,room,foreign}=await fixture();
    const viewer=registry.issue('live-observer','observer');
    await hub.app.listen({port:0,host:'127.0.0.1'}); const address=hub.app.server.address();
    if (!address || typeof address==='string') throw new Error('No port');
    const connect=async(token:string)=>{
      const socket=new WebSocket(`ws://127.0.0.1:${address.port}/v1/ws`); sockets.push(socket);
      const frames: any[]=[]; socket.on('message',data=>frames.push(JSON.parse(data.toString())));
      await once(socket,'open'); socket.send(JSON.stringify({t:'hello',token}));
      await vi.waitFor(()=>expect(frames.some(frame=>frame.t==='hello.ok')).toBe(true)); return {socket,frames};
    };
    const own=await connect(viewer.token); const peer=await connect(right.token);
    hub.services.rooms.postMessage(foreign,right.agent.id,'FOREIGN-WS-SENTINEL');
    peer.socket.send(JSON.stringify({t:'ping'})); await vi.waitFor(()=>expect(peer.frames.some(frame=>frame.t==='pong')).toBe(true));
    expect(JSON.stringify(own.frames)).not.toContain(foreign); expect(JSON.stringify(own.frames)).not.toContain('FOREIGN-WS-SENTINEL');
    expect(own.frames.find(frame=>frame.t==='hello.ok')).toMatchObject({workspace:{id:LEGACY_WORKSPACE_ID},instance_id:hubIdentity(hub.services.db).instance_id});
    own.socket.send(JSON.stringify({t:'subscribe',rooms:[foreign]}));
    await vi.waitFor(()=>expect(own.frames.some(frame=>frame.t==='error' && frame.code==='ROOM_NOT_FOUND')).toBe(true));
    hub.services.db.prepare("UPDATE agents SET role='agent' WHERE id=?").run(viewer.agent.id);
    const before=own.frames.length;
    hub.services.events.append({type:'room.created',room_id:room,payload:{marker:'AFTER-DOWNGRADE'}});
    own.socket.send(JSON.stringify({t:'ping'})); await vi.waitFor(()=>expect(own.frames.slice(before).some(frame=>frame.t==='pong')).toBe(true));
    expect(JSON.stringify(own.frames)).not.toContain('AFTER-DOWNGRADE');
    registry.revoke(viewer.agent.id);
    const closed=once(own.socket,'close'); own.socket.send(JSON.stringify({t:'ping'})); expect((await closed)[0]).toBe(4008);
  });
});

describe('local JSON workspace management',()=>{
  function run(path:string,request:unknown) { return spawnSync(process.execPath,[resolve('scripts/manage.mjs')],{env:{...process.env,HUB_DB:path},input:JSON.stringify(request),encoding:'utf8'}); }
  it('creates workspaces with their owner, staff only, and refuses foreign or bot identities without leaking secrets',()=>{
    const path=join(dir,'hub.sqlite'); const db=openDb(path);
    try {
      const invoke=(request:unknown)=>JSON.parse(run(path,request).stdout);
      const one=invoke({command:'create-workspace',name:'Project one',ownerName:'Ben'});
      const two=invoke({command:'create-workspace',name:'Project two',ownerName:'Ben'});
      expect(one.token).toMatch(/^ach_/); expect(one.agent).toMatchObject({name:'Ben',role:'supervisor'});
      expect(invoke({command:'create-workspace',name:'project ONE',ownerName:'Ben'})).toMatchObject({ok:false,message:'A workspace with that name already exists.'});
      const staff=invoke({command:'add-staff',workspaceId:one.workspace.id,name:'same-name',role:'observer'});
      expect(staff.ok).toBe(true);
      expect(invoke({command:'add-staff',workspaceId:two.workspace.id,name:'same-name',role:'supervisor'}).ok).toBe(true);
      for (const role of ['agent','root']) expect(invoke({command:'add-staff',workspaceId:one.workspace.id,name:'bot',role}).ok).toBe(false);
      expect(invoke({command:'create-agent',workspaceId:one.workspace.id,name:'bot',role:'agent'}).ok).toBe(false);
      expect(invoke({command:'join-room',workspaceId:one.workspace.id}).ok).toBe(false);
      expect(JSON.stringify(db.prepare('SELECT * FROM tokens').all())).not.toContain(staff.token);
      const listed=run(path,{command:'list',workspaceId:one.workspace.id}); expect(listed.stdout).not.toContain('token_hash'); expect(listed.stdout).not.toContain(staff.token);
      expect(JSON.parse(listed.stdout).people.map((p:{name:string;kind:string})=>[p.name,p.kind])).toEqual([['Ben','staff'],['same-name','staff']]);
      expect(invoke({command:'issue-token',workspaceId:two.workspace.id,agentId:staff.agent.id}).ok).toBe(false);
      expect(invoke({command:'revoke-person',workspaceId:two.workspace.id,agentId:staff.agent.id}).ok).toBe(false);
      expect(invoke({command:'revoke-person',workspaceId:one.workspace.id,agentId:staff.agent.id})).toMatchObject({ok:true,revoked:1});
      expect(invoke({command:'issue-token',workspaceId:one.workspace.id,agentId:staff.agent.id}).ok).toBe(false);
      expect(invoke({command:'rename-workspace',workspaceId:one.workspace.id,name:'Project two'}).ok).toBe(false);
      expect(invoke({command:'rename-workspace',workspaceId:one.workspace.id,name:'Renamed'}).workspace.name).toBe('Renamed');
      expect(JSON.parse(run(path,{command:'list',token:'SENTINEL-SECRET'}).stdout).ok).toBe(false);
      expect(JSON.stringify(db.prepare('SELECT * FROM events').all())).not.toContain(staff.token);
    } finally { db.close(); }
  });
  it('creates rooms, invites and archives only in the selected workspace',()=>{
    const path=join(dir,'hub.sqlite'); const db=openDb(path);
    try {
      const invoke=(request:unknown)=>JSON.parse(run(path,request).stdout);
      const one=invoke({command:'create-workspace',name:'Rooms one',ownerName:'Ben'}).workspace;
      const two=invoke({command:'create-workspace',name:'Rooms two',ownerName:'Ben'}).workspace;
      const created=invoke({command:'create-room',workspaceId:one.id,name:'Collaboration'});
      expect(created.ok).toBe(true); expect(created.room).toMatchObject({workspace_id:one.id,slug:'collaboration'});
      const duplicate=invoke({command:'create-room',workspaceId:one.id,name:'Collaboration'}); expect(duplicate.room.slug).toBe('collaboration-2');
      expect(invoke({command:'create-room',workspaceId:two.id,name:'Collaboration'}).room.slug).toBe('collaboration');
      const invite=invoke({command:'create-invite',workspaceId:one.id,roomId:created.room.id,label:'Dana'});
      expect(invite.path).toMatch(/^\/join#achi_[A-Za-z0-9_-]{32}$/);
      expect(invoke({command:'create-invite',workspaceId:two.id,roomId:created.room.id}).ok).toBe(false);
      expect(JSON.stringify(db.prepare('SELECT * FROM invites').all())).not.toContain(invite.path.split('#')[1]);
      const listed=invoke({command:'list',workspaceId:one.id}); expect(listed.instance_id).toBe(hubIdentity(db).instance_id);
      expect(listed.workspaces.map((item:{id:string})=>item.id)).toEqual(expect.arrayContaining([one.id,two.id]));
      expect(invoke({command:'list'}).workspaces.map((item:{id:string})=>item.id)).toEqual(expect.arrayContaining([LEGACY_WORKSPACE_ID,one.id,two.id]));
      expect(listed.rooms).toHaveLength(2); expect(listed.invites).toMatchObject([{label:'Dana',state:'open'}]);
      expect(invoke({command:'revoke-invite',workspaceId:two.id,inviteId:invite.invite.id}).revoked).toBe(0);
      expect(invoke({command:'revoke-invite',workspaceId:one.id,inviteId:invite.invite.id}).revoked).toBe(1);
      // Archiving is scoped to the workspace, hides the room everywhere and keeps its history.
      expect(invoke({command:'archive-room',workspaceId:two.id,roomId:duplicate.room.id}).ok).toBe(false);
      expect(invoke({command:'archive-room',workspaceId:one.id,roomId:duplicate.room.id})).toMatchObject({ok:true,archived:true});
      expect(invoke({command:'archive-room',workspaceId:one.id,roomId:duplicate.room.id}).ok).toBe(false);
      expect(invoke({command:'list',workspaceId:one.id}).rooms.map((item:{id:string})=>item.id)).toEqual([created.room.id]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='room.archived' AND room_id=?").get(duplicate.room.id)).toEqual({n:1});
      db.prepare("INSERT INTO sandboxes (id,room_id,container_name,image,status,created_at,updated_at) VALUES ('sbx_0000000000000001',?,'c','i','running','t','t')").run(created.room.id);
      expect(invoke({command:'archive-room',workspaceId:one.id,roomId:created.room.id}).ok).toBe(false);
    } finally { db.close(); }
  });
  it('never creates or migrates missing or older databases',()=>{
    const missing=join(dir,'missing.sqlite'); expect(JSON.parse(run(missing,{command:'list'}).stdout).ok).toBe(false); expect(readdirSync(dir)).not.toContain('missing.sqlite');
    const path=join(dir,'old.sqlite'); const db=new Database(path); db.exec(LEGACY_SCHEMA); db.close();
    expect(JSON.parse(run(path,{command:'list'}).stdout).ok).toBe(false);
    const unchanged=new Database(path); expect(unchanged.pragma('user_version',{simple:true})).toBe(0); expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name='workspaces'").get()).toBeUndefined(); unchanged.close();
  });
});
