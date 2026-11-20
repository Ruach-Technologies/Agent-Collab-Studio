// Token registry: plaintext is returned once and only a SHA-256 hash persists.
import { randomBytes, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Agent, Role } from './types.js';
import { LEGACY_WORKSPACE_ID } from './db.js';

export interface IssuedToken {
  agent: Agent;
  token: string;
  token_id: string;
}
export function hashToken(token: string): string { return createHash('sha256').update(token, 'utf8').digest('hex'); }

export class TokenRegistry {
  constructor(private db: Database.Database) {}

  issue(name: string, role: Role, workspaceId = LEGACY_WORKSPACE_ID): IssuedToken {
    if (!name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name) || !['supervisor','agent','observer'].includes(role)) throw new Error('Invalid agent');
    return this.db.transaction(() => {
      const token = 'ach_' + randomBytes(24).toString('base64url');
      const id = 'agt_' + randomBytes(8).toString('hex');
      const token_id = 'tok_' + randomBytes(8).toString('hex');
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO agents (id,workspace_id,name,role,created_at) VALUES (?,?,?,?,?)').run(id,workspaceId,name,role,now);
      this.db.prepare('INSERT INTO tokens (id,agent_id,workspace_id,role,token_hash,created_at) VALUES (?,?,?,?,?,?)').run(token_id,id,workspaceId,role,hashToken(token),now);
      this.db.prepare('INSERT INTO events (type,workspace_id,target_id,payload,created_at) VALUES (?,?,?,?,?)')
        .run('agent.created',workspaceId,id,JSON.stringify({ via: 'local-registry', token_id }),now);
      return { agent: { id, workspace_id: workspaceId, name, role, created_at: now, last_seen_at: null }, token, token_id };
    })();
  }

  verify(token: string): { agentId: string; name: string; role: Role; workspace_id: string } | null {
    const row = this.db.prepare(`SELECT a.id,a.name,a.role,a.workspace_id FROM tokens t JOIN agents a ON a.id=t.agent_id
      WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.workspace_id=a.workspace_id`).get(hashToken(token)) as Agent | undefined;
    return row ? { agentId: row.id, name: row.name, role: row.role, workspace_id: row.workspace_id } : null;
  }

  revoke(agentId: string, workspaceId = LEGACY_WORKSPACE_ID): number {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const result = this.db.prepare('UPDATE tokens SET revoked_at=? WHERE agent_id=? AND workspace_id=? AND revoked_at IS NULL').run(now,agentId,workspaceId);
      this.db.prepare('INSERT INTO events (type,workspace_id,target_id,payload,created_at) VALUES (?,?,?,?,?)')
        .run('auth.revoked',workspaceId,agentId,JSON.stringify({ via: 'local-registry', revoked: result.changes }),now);
      return result.changes;
    })();
  }

  touchLastUsed(agentId: string): void {
    this.db.prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(new Date().toISOString(),agentId);
  }

  roster(workspaceId = LEGACY_WORKSPACE_ID): (Agent & { revoked: boolean })[] {
    return this.db.prepare(`SELECT a.*,
      NOT EXISTS (SELECT 1 FROM tokens t WHERE t.agent_id=a.id AND t.revoked_at IS NULL) AS revoked
      FROM agents a WHERE a.workspace_id=? ORDER BY a.name`).all(workspaceId) as (Agent & { revoked: boolean })[];
  }
}
