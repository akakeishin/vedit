import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
function linuxProcessStartToken(pid) {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const closeParen = stat.lastIndexOf(')');
        if (closeParen < 0)
            return null;
        // Fields after comm begin with field 3 (state); starttime is field 22.
        const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
        const startTimeTicks = fields[19];
        return startTimeTicks ? `linux-proc-start:${startTimeTicks}` : null;
    }
    catch {
        return null;
    }
}
function psProcessStartToken(pid) {
    try {
        const output = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2_000,
        }).trim();
        return output ? `ps-lstart:${output.replace(/\s+/g, ' ')}` : null;
    }
    catch {
        return null;
    }
}
/** Return the OS process-start token, or null when this platform cannot. */
export function processStartToken(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return null;
    return linuxProcessStartToken(pid) ?? psProcessStartToken(pid);
}
// Read once. A fallback remains useful for distinguishing two in-process
// daemon instances; other processes deliberately treat an unobservable
// fallback token as unknown instead of guessing that its owner is dead.
export const CURRENT_PROCESS_START_TOKEN = processStartToken(process.pid)
    ?? `node-process-start:${Date.now() - Math.round(process.uptime() * 1_000)}`;
export function createProcessLeaseOwner() {
    return {
        pid: process.pid,
        processStartToken: CURRENT_PROCESS_START_TOKEN,
        leaseToken: randomUUID(),
        acquiredAt: new Date().toISOString(),
    };
}
export function looksLikeProcessLeaseOwner(value) {
    const owner = value;
    return Boolean(owner
        && Number.isInteger(owner.pid)
        && Number(owner.pid) > 0
        && typeof owner.processStartToken === 'string'
        && owner.processStartToken.length > 0
        && typeof owner.leaseToken === 'string'
        && owner.leaseToken.length > 0
        && typeof owner.acquiredAt === 'string');
}
/**
 * Prove whether a lease owner still denotes the same process incarnation.
 * `unknown` is intentionally fail-closed: callers must not reclaim a lease
 * merely because this platform cannot inspect a live process's start token.
 */
export function processLeaseOwnerStatus(owner) {
    if (!looksLikeProcessLeaseOwner(owner))
        return 'unknown';
    if (owner.pid === process.pid) {
        return owner.processStartToken === CURRENT_PROCESS_START_TOKEN ? 'alive' : 'dead';
    }
    try {
        process.kill(owner.pid, 0);
    }
    catch (error) {
        const code = error.code;
        if (code === 'ESRCH')
            return 'dead';
        // EPERM proves that a process exists, but not that it is the same
        // incarnation. Continue to the start-token comparison when possible.
        if (code !== 'EPERM')
            return 'unknown';
    }
    const observedStart = processStartToken(owner.pid);
    if (!observedStart)
        return 'unknown';
    return observedStart === owner.processStartToken ? 'alive' : 'dead';
}
export function sameProcessLeaseOwner(a, b) {
    return a.pid === b.pid
        && a.processStartToken === b.processStartToken
        && a.leaseToken === b.leaseToken;
}
