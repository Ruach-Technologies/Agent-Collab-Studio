import type { DbHandle, EventRow } from './db.js';
import type { Agent } from './types.js';

export function canObserveAll(agent: Agent): boolean {
  return agent.role === 'supervisor' || agent.role === 'observer';
}

export function canReadRoom(db: DbHandle, agent: Agent, roomId: string): boolean {
  if (!db.prepare('SELECT 1 FROM rooms WHERE id=? AND workspace_id=? AND archived_at IS NULL').get(roomId,agent.workspace_id)) return false;
  return canObserveAll(agent) || !!db.prepare(
    'SELECT 1 FROM members WHERE room_id = ? AND agent_id = ?',
  ).get(roomId, agent.id);
}

export function canViewEvent(db: DbHandle, agent: Agent, event: EventRow): boolean {
  if (event.workspace_id !== agent.workspace_id) return false;
  if (canObserveAll(agent)) return true;
  if (!event.room_id) return event.actor_id === agent.id;
  if (!canReadRoom(db, agent, event.room_id)) return false;
  return event.type !== 'message.created' || event.target_id === null ||
    event.actor_id === agent.id || event.target_id === agent.id;
}
