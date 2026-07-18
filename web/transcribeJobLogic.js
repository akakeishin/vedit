const TERMINAL = new Set(['success', 'error', 'cancelled']);
const ACTIVE_RANK = { queued: 0, running: 1, cancelling: 2 };

export function isTerminalTranscribeJob(job) {
  return Boolean(job && TERMINAL.has(job.status));
}

function timestamp(job) {
  const raw = job?.updatedAt ?? job?.finishedAt ?? job?.startedAt;
  const value = Date.parse(raw ?? '');
  return Number.isFinite(value) ? value : null;
}

/**
 * Reconcile snapshots arriving through independent HTTP and WebSocket
 * channels. A delayed POST /api/transcribe response may still say `queued`
 * after the WS has already delivered `error`/`cancelled`/`success`; terminal
 * truth is therefore monotonic. Within the same terminal/active class, the
 * server's updatedAt wins, with active status rank as a legacy fallback.
 */
export function mergeTranscribeJob(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (existing.taskId && incoming.taskId && existing.taskId !== incoming.taskId) return incoming;

  const existingTerminal = isTerminalTranscribeJob(existing);
  const incomingTerminal = isTerminalTranscribeJob(incoming);
  if (existingTerminal !== incomingTerminal) return existingTerminal ? existing : incoming;

  const oldTime = timestamp(existing);
  const newTime = timestamp(incoming);
  if (oldTime != null && newTime != null && oldTime !== newTime) {
    return newTime > oldTime ? incoming : existing;
  }

  if (!existingTerminal) {
    const oldRank = ACTIVE_RANK[existing.status] ?? -1;
    const newRank = ACTIVE_RANK[incoming.status] ?? -1;
    if (oldRank !== newRank) return newRank > oldRank ? incoming : existing;
  }
  // Equal-time snapshots can differ in optional detail. Prefer the incoming
  // shape while retaining fields (notably error/finishedAt) it omitted.
  return { ...existing, ...incoming };
}
