const handlePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A direct message, or a literal @handle in a room-wide post. */
export function addressedTo(message, agentId, handle) {
  if (message.from_agent_id === agentId) return false;
  if (message.to_agent_id) return message.to_agent_id === agentId;
  if (!handlePattern.test(handle ?? '')) return false;
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_@-])@${escaped}(?![A-Za-z0-9_@-])`, 'i').test(message.body);
}

