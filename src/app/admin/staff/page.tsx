import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requirePermission } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { getStoreSettings } from "@/lib/content/queries";
import { formatAdminDateTime } from "@/lib/orders/admin-format";
import { staffDirectorySchema } from "@/lib/staff/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createStaffMember, resetStaffPassword, updateStaffMember } from "./actions";

export const metadata: Metadata = { title: "Staff" };
export const dynamic = "force-dynamic";

export default async function StaffPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const access = await requirePermission("staff.view", "/admin/staff");
  const canManage = hasPermission(access, "staff.manage");
  const [params, supabase, settings] = await Promise.all([searchParams, createServerSupabaseClient(), getStoreSettings()]);
  const { data, error } = await supabase.rpc("wayne_admin_staff");
  if (error) throw new Error(`Staff directory failed: ${error.message}`);
  const directory = staffDirectorySchema.parse(data);
  const pending = directory.staff.filter((member) => !member.active);

  return <main className="mx-auto max-w-6xl px-5 py-10">
    <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">People</p>
    <h1 className="mt-3 text-4xl font-black">Staff & roles</h1>
    <p className="mt-3 max-w-3xl text-wayne-muted">Give every person their own sign-in so tickets, discounts, cancellations, and changes are attributed to them. Role and access changes are recorded in the audit log.{canManage ? "" : " Only the owner can change staff access."}</p>
    {params.saved ? <p role="status" className="mt-5 rounded-xl bg-wayne-ok-soft p-4 font-bold text-wayne-ok">{params.saved}</p> : null}
    {params.error ? <p role="alert" className="mt-5 rounded-xl bg-wayne-alert-soft p-4 font-bold text-wayne-alert">{params.error}</p> : null}
    {pending.length ? <p className="mt-5 rounded-xl border border-wayne-warn/40 bg-wayne-warn-soft p-4"><strong>{pending.length} account{pending.length === 1 ? "" : "s"} without access.</strong> New sign-ins start inactive until an owner turns them on here.</p> : null}

    {canManage ? <Card className="mt-7 p-5"><h2 className="text-xl font-black">Add a staff member</h2><form action={createStaffMember} className="mt-4 grid gap-4 md:grid-cols-2">
      <Input autoComplete="off" label="Name shown on tickets" maxLength={120} name="display_name" required />
      <Input autoComplete="off" label="Email (their sign-in)" name="email" required type="email" />
      <label className="grid gap-2 text-sm font-semibold">Role<select className="min-h-11 rounded-lg border border-wayne-border bg-white px-3 font-normal" defaultValue="cashier" name="role">{directory.roles.map((role) => <option key={role.code} value={role.code}>{role.name}</option>)}</select></label>
      <Input autoComplete="new-password" label="Temporary password (12+ characters, upper, lower, number)" minLength={12} name="password" required type="password" />
      <Button className="md:col-span-2">Create account</Button></form></Card> : null}

    <h2 className="mt-9 text-2xl font-black">Team</h2>
    <div className="mt-4 grid gap-4">{directory.staff.map((member) => {
      const self = member.id === access.profile_id;
      return <Card className="p-5" key={member.id}>
        <div className="flex flex-wrap items-start justify-between gap-3"><div><strong className="text-lg">{member.display_name}</strong>{self ? <span className="ml-2 text-sm text-wayne-muted">(you)</span> : null}<p className="text-sm text-wayne-muted">{member.email ?? "No email"} · last sign-in {member.last_sign_in_at ? formatAdminDateTime(member.last_sign_in_at, settings.timezone) : "never"}</p></div><div className="flex gap-2"><Badge>{member.role_name}</Badge>{member.active ? <Badge className="bg-wayne-ok-soft text-wayne-ok">Active</Badge> : <Badge className="bg-wayne-cream-deep text-wayne-muted">No access</Badge>}</div></div>
        {canManage ? <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_20rem]">
          <form action={updateStaffMember} className="grid gap-3 sm:grid-cols-[1fr_12rem_auto_auto] sm:items-end"><input name="id" type="hidden" value={member.id} />
            <Input defaultValue={member.display_name} label="Name" maxLength={120} name="display_name" id={`name-${member.id}`} />
            <label className="grid gap-2 text-sm font-semibold">Role<select className="min-h-11 rounded-lg border border-wayne-border bg-white px-3 font-normal" defaultValue={member.role} disabled={self} name="role">{directory.roles.map((role) => <option key={role.code} value={role.code}>{role.name}</option>)}</select>{self ? <input name="role" type="hidden" value={member.role} /> : null}</label>
            <label className="flex min-h-11 items-center gap-2 text-sm font-semibold"><input defaultChecked={member.active} disabled={self} name="active" type="checkbox" />Active{self ? <input name="active" type="hidden" value="on" /> : null}</label>
            <Button variant="secondary">Save</Button></form>
          <form action={resetStaffPassword} className="grid gap-2"><input name="id" type="hidden" value={member.id} /><Input autoComplete="new-password" id={`password-${member.id}`} label={self ? "Change my password" : "New temporary password"} minLength={12} name="password" required type="password" /><Button variant="secondary">{self ? "Change password" : "Reset password"}</Button>{self ? <p className="text-xs text-wayne-muted">You cannot change your own role or deactivate yourself.</p> : null}</form>
        </div> : null}
      </Card>;
    })}</div>

    <h2 className="mt-9 text-2xl font-black">What each role can do</h2>
    <div className="mt-4 grid gap-4 md:grid-cols-2">{directory.roles.map((role) => <Card className="p-5" key={role.code}><h3 className="text-lg font-black">{role.name}</h3><p className="text-sm text-wayne-muted">{role.description}</p><p className="mt-3 text-sm">{role.permissions.length ? role.permissions.join(" · ") : "No permissions"}</p></Card>)}</div>
  </main>;
}
