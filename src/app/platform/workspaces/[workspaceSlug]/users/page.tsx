import type { Metadata } from "next";
import { setWorkspaceMember } from "../../../actions";
import { Flash, first, when } from "@/components/platform/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getPlatformWorkspace, getPlatformWorkspaceMembers, requirePlatformUser } from "@/lib/platform/queries";

export const metadata: Metadata = { title: "Users" };
export const dynamic = "force-dynamic";

const selectClass = "min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal";

/** Users tab (§11.3): who can sign in to this business and with which role. */
export default async function PlatformWorkspaceUsersPage({ params, searchParams }: { params: Promise<{ workspaceSlug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const [me, workspace, directory] = await Promise.all([requirePlatformUser(), getPlatformWorkspace(workspaceSlug), getPlatformWorkspaceMembers(workspaceSlug)]);
  const tz = workspace.timezone;
  const roleOptions = directory.roles.map((role) => <option key={role.code} value={role.code}>{role.name}</option>);

  return (
    <div className="mt-6">
      <Flash error={first(query.error)} saved={first(query.saved)} />
      <p className="mt-4 max-w-3xl text-sm text-wayne-muted">
        Staff accounts for {workspace.name}. A business must always keep at least one active owner. Changes need a reason and appear in the business&apos;s audit log as made by Hanafy.
        {me.can_manage ? "" : " Your platform role can view users but not change them."}
      </p>

      {me.can_manage ? (
        <Card className="mt-5 p-5">
          <h2 className="text-xl font-black">Add someone</h2>
          <p className="mt-1 text-sm text-wayne-muted">If they already have a sign-in, only the email is needed. Otherwise add a name and a temporary password to create one.</p>
          <form action={setWorkspaceMember} className="mt-4 grid gap-4 md:grid-cols-2">
            <input name="workspace" type="hidden" value={workspace.slug} />
            <input name="status" type="hidden" value="active" />
            <Input autoComplete="off" id="add-email" label="Email (their sign-in)" name="email" required type="email" />
            <label className="grid gap-1.5 text-sm font-bold">Role<select className={selectClass} defaultValue="cashier" name="role">{roleOptions}</select></label>
            <Input autoComplete="off" hint="Only for a new sign-in" id="add-name" label="Name shown on tickets" maxLength={120} name="display_name" />
            <Input autoComplete="new-password" hint="Only for a new sign-in: 12+ characters with upper, lower and a number" id="add-password" label="Temporary password" minLength={12} name="password" type="password" />
            <Input className="md:col-span-2" id="add-reason" label="Reason (recorded)" maxLength={500} minLength={3} name="reason" placeholder="e.g. New manager starting Monday" required />
            <Button className="md:col-span-2" variant="brand">Add to {workspace.name}</Button>
          </form>
        </Card>
      ) : null}

      <div className="mt-6 grid gap-3">
        {directory.members.map((member) => (
          <Card className="p-5" key={member.auth_user_id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <strong className="text-lg">{member.display_name ?? member.email}</strong>
                <p className="text-sm text-wayne-muted">{member.email ?? "No email"} · last sign-in {member.last_sign_in_at ? when(member.last_sign_in_at, tz) : "never"} · added {when(member.joined_at, tz)}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge>{member.role_name}</Badge>
                <Badge tone={member.status === "active" ? "ok" : member.status === "suspended" ? "alert" : "warn"}>{member.status}</Badge>
                {member.is_platform_user ? <Badge tone="neutral">Hanafy staff</Badge> : null}
              </div>
            </div>
            {me.can_manage && member.email ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-bold">Change role or access</summary>
                <form action={setWorkspaceMember} className="mt-3 grid gap-3 md:grid-cols-[12rem_10rem_1fr_auto] md:items-end">
                  <input name="workspace" type="hidden" value={workspace.slug} />
                  <input name="email" type="hidden" value={member.email} />
                  <label className="grid gap-1.5 text-sm font-bold">Role<select className={selectClass} defaultValue={member.role} name="role">{roleOptions}</select></label>
                  <label className="grid gap-1.5 text-sm font-bold">Access
                    <select className={selectClass} defaultValue={member.status === "active" ? "active" : "suspended"} name="status"><option value="active">Active</option><option value="suspended">Suspended</option></select>
                  </label>
                  <Input id={`reason-${member.auth_user_id}`} label="Reason (recorded)" maxLength={500} minLength={3} name="reason" required />
                  <Button variant="secondary">Save</Button>
                </form>
              </details>
            ) : null}
          </Card>
        ))}
        {directory.members.length === 0 ? <Card className="p-6 text-wayne-muted">Nobody can sign in to this business yet.</Card> : null}
      </div>

      <h2 className="mt-9 text-2xl font-black">What each role can do</h2>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {directory.roles.map((role) => (
          <Card className="p-5" key={role.code}>
            <h3 className="text-lg font-black">{role.name}</h3>
            {role.description ? <p className="text-sm text-wayne-muted">{role.description}</p> : null}
            <p className="mt-3 text-sm">{role.permissions.length ? role.permissions.join(" · ") : "No permissions"}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
