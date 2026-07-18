// Canonical manifest types. All times are seconds (float) in source or
// timeline domain as noted. Frame-accurate ops snap to fps at the edges.
export function isRevisionActor(value) {
    return value === 'agent' || value === 'claude' || value === 'ui' || value === 'system';
}
/** True for both current provider-neutral edits and legacy Claude edits. */
export function isAgentActor(value) {
    return value === 'agent' || value === 'claude';
}
