// The REST helper table the sidekick tools call through. The hub supplies an in-process request
// function that replays each call against its own routes as the verified sidekick, so every role,
// membership, workspace, validation, rate-limit and audit rule applies unchanged.
export class HubClientError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'HubClientError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * The REST helper table over any `request(path, { method, body, signal })` function.
 * The hub's own MCP endpoint supplies an in-process request function instead of fetch.
 */
export function hubClientMethods(request) {
  return {
    request,
    whoami: (options) => request('/v1/whoami', options),
    listAgents: (options) => request('/v1/agents', options),
    listRooms: (options) => request('/v1/rooms', options),
    createRoom: (input, options) => request('/v1/rooms', { ...options, method: 'POST', body: input }),
    joinRoom: (roomId, options) => request(`/v1/rooms/${encodeURIComponent(roomId)}/join`, { ...options, method: 'POST' }),
    listMembers: (roomId, options) => request(`/v1/rooms/${encodeURIComponent(roomId)}/members`, options),
    getRoomSandbox: (roomId, options) => request(`/v1/rooms/${encodeURIComponent(roomId)}/sandbox`, options),
    provisionSandbox: (roomId, options) => request(`/v1/rooms/${encodeURIComponent(roomId)}/sandbox`, { ...options, method: 'POST' }),
    execSandbox: (sandboxId, input, options) =>
      request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`, { ...options, method: 'POST', body: input }),
    listExecs: (sandboxId, options) => request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/execs`, options),
    listFiles: (sandboxId, path = '.', options) => request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/files?path=${encodeURIComponent(path)}`, options),
    readFile: (sandboxId, path, options) => request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/file?path=${encodeURIComponent(path)}`, options),
    writeFile: (sandboxId, path, content, options) => request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/file`, { ...options, method: 'PUT', body: { path, content } }),
    installDependencies: (sandboxId, input = {}, options) =>
      request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/install`, { ...options, method: 'POST', body: input }),
    cloneRepo: (sandboxId, input, options) =>
      request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/repos`, { ...options, method: 'POST', body: input }),
    openPullRequest: (sandboxId, input, options) =>
      request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/pulls`, { ...options, method: 'POST', body: input }),
    getDevServer: (sandboxId, options) => request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/dev-server`, options),
    startDevServer: (sandboxId, input = {}, options) =>
      request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/dev-server`, { ...options, method: 'POST', body: input }),
    stopDevServer: (sandboxId, options) => request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/dev-server`, { ...options, method: 'DELETE' }),
    devServerLogs: (sandboxId, { bytes, ...options } = {}) =>
      request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/dev-server/logs${bytes === undefined ? '' : `?bytes=${encodeURIComponent(bytes)}`}`, options),
    devServerTicket: (sandboxId, input = {}, options) =>
      request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/dev-server/ticket`, { ...options, method: 'POST', body: input }),
    devServerFetch: (sandboxId, path, options) =>
      request(`/v1/sandboxes/${encodeURIComponent(sandboxId)}/dev-server/fetch`, { ...options, method: 'POST', body: { path } }),
    listMessages: (roomId, { since, ...options } = {}) => {
      const query = since === undefined ? '' : `?since=${encodeURIComponent(since)}`;
      return request(`/v1/rooms/${encodeURIComponent(roomId)}/messages${query}`, options);
    },
    roomFeed: (roomId, { since, limit, ...options } = {}) => {
      const query = new URLSearchParams();
      if (since !== undefined) query.set('since', String(since));
      if (limit !== undefined) query.set('limit', String(limit));
      const text = query.toString();
      return request(`/v1/rooms/${encodeURIComponent(roomId)}/feed${text ? `?${text}` : ''}`, options);
    },
    postMessage: (roomId, input, options) =>
      request(`/v1/rooms/${encodeURIComponent(roomId)}/messages`, { ...options, method: 'POST', body: input }),
    listEvents: ({ since, limit, room, type, ...options } = {}) => {
      const query = new URLSearchParams();
      if (since !== undefined) query.set('since', String(since));
      if (limit !== undefined) query.set('limit', String(limit));
      if (room !== undefined) query.set('room', room);
      if (type !== undefined) query.set('type', type);
      const suffix = query.size ? `?${query}` : '';
      return request(`/v1/events${suffix}`, options);
    },
  };
}
