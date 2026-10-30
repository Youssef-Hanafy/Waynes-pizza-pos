/** Additive HTTP contract: legacy clients remain supported during this rollout. */
export const CLIENT_CONTRACT = 1;
export type Release = { build: string; commit: string; builtAt: string; contract: number; minimumClient: number; minimumBridge: number };
export function currentRelease(): Release {
  return { build: process.env.WAYNE_BUILD_ID ?? "", commit: process.env.WAYNE_COMMIT ?? "", builtAt: process.env.WAYNE_BUILT_AT ?? "", contract: CLIENT_CONTRACT, minimumClient: 0, minimumBridge: 1 };
}
export function parseRelease(value: unknown): Release | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.build !== "string" || !/^[a-zA-Z0-9_-]{1,150}$/.test(v.build) || typeof v.commit !== "string" || !/^[a-f0-9]{7,40}$/.test(v.commit) || typeof v.builtAt !== "string" || !Number.isFinite(Date.parse(v.builtAt))) return null;
  if (![v.contract,v.minimumClient,v.minimumBridge].every(n => Number.isSafeInteger(n) && Number(n) >= 0)) return null;
  if (Number(v.minimumClient) > Number(v.contract)) return null;
  return v as Release;
}

export function acceptsClientContract(header:string|null, release:Release) {
 const contract=header===null ? 0 : Number(header);
 return Number.isSafeInteger(contract) && contract>=release.minimumClient && contract<=release.contract;
}
