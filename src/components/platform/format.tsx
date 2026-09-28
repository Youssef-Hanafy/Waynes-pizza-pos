import { Badge } from "@/components/ui/badge";
import { formatAdminDateTime } from "@/lib/orders/admin-format";
import { serviceLabels, isServiceCode } from "@/lib/tenancy/services";

/** Hanafy's own clock, for platform-wide lists that span businesses. */
export const HANAFY_TIME_ZONE = "America/New_York";

export const when = (value: string | null | undefined, timeZone = HANAFY_TIME_ZONE) => formatAdminDateTime(value ?? null, timeZone);

export const serviceName = (code: string) => (isServiceCode(code) ? serviceLabels[code] : code);

const statusTones = { active: "ok", provisioning: "warn", suspended: "alert", archived: "neutral" } as const;

export function WorkspaceStatus({ status }: { status: keyof typeof statusTones }) {
  return <Badge tone={statusTones[status]}>{status}</Badge>;
}

export function HealthBadge({ level }: { level: "ok" | "warn" | "alert" }) {
  return <Badge tone={level}>{level === "ok" ? "Healthy" : level === "warn" ? "Needs a look" : "Problem"}</Badge>;
}

export function Flash({ saved, error }: { saved?: string; error?: string }) {
  return (
    <>
      {saved ? <p className="mt-5 rounded-xl bg-wayne-ok-soft p-4 font-bold text-wayne-ok" role="status">{saved}</p> : null}
      {error ? <p className="mt-5 rounded-xl bg-wayne-alert-soft p-4 font-bold text-wayne-alert" role="alert">{error}</p> : null}
    </>
  );
}

export const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
