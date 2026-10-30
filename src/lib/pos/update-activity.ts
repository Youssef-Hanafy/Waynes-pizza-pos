/** Process-wide lifecycle shared by HTTP, native hardware, printing and update checks. */
const active = new Map<string, number>();
const uncertain = new Set<string>();
const guards = new Map<string, () => string[]>();
let revision = 0;
export function noteRegisterActivity() { revision++; }
export function beginCriticalWork(kind: string) {
 active.set(kind, (active.get(kind) ?? 0) + 1); revision++;
 let finished = false;
 return () => { if (finished) return; finished = true; const n = (active.get(kind) ?? 1) - 1; if (n) active.set(kind,n); else active.delete(kind); revision++; };
}
export function markUncertainWork(key: string) { uncertain.add(key); revision++; }
export function resolveUncertainWork(key: string) { if (uncertain.delete(key)) revision++; }
export function registerUpdateGuard(key: string, read: () => string[]) { guards.set(key,read); return () => { guards.delete(key); }; }
export function updateSafety() {
 const blockers = [...active.keys()].map(key => `${key} is in progress`);
 if (uncertain.size) blockers.push("an operation has no confirmed outcome; reconcile the payment or printer result before updating");
 for (const read of guards.values()) { try { blockers.push(...read()); } catch { blockers.push("register state could not be verified"); } }
 return { blockers: [...new Set(blockers)], revision };
}
