"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { logger } from "@/lib/logging/logger";
import { getPlatformWorkspace, getPlatformWorkspaceIntegrations, requirePlatformUser } from "@/lib/platform/queries";
import { savePaymentConnectionInputSchema, savePaymentConnectionResultSchema } from "@/lib/platform/integrations";
import { paymentConnectionSchema } from "@/lib/payments/capabilities";
import { testPaymentConnection } from "@/lib/payments/registry";
import {
  platformErrorMessage,
  setMemberInputSchema,
  setServiceInputSchema,
  setServiceResultSchema,
  startSupportInputSchema,
} from "@/lib/platform/schemas";
import { saveMessagingInputSchema, saveMessagingResultSchema } from "@/lib/platform/messaging";
import { saveHardwareInputSchema } from "@/lib/platform/hardware";
import { billingIntervals, billingResultSchema, paymentMethods } from "@/lib/platform/billing";
import { parseDollarsToCents } from "@/lib/platform/money";
import { provisionInputSchema, provisionResultSchema, statusResultSchema, weekDays } from "@/lib/platform/provisioning";
import { z } from "zod";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server";
import { ACTIVE_WORKSPACE_COOKIE, activeWorkspaceCookieOptions } from "@/lib/tenancy/active-workspace";
import { zonedLocalToUtcIso } from "@/lib/time/zoned";

const text = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};

function back(path: string, message: string, key: "error" | "saved" = "error", extra: Record<string, string> = {}): never {
  const params = new URLSearchParams({ ...extra, [key]: message });
  redirect(`${path}?${params.toString()}`);
}

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const workspacePath = (slug: string, tab = "") => (slugPattern.test(slug) ? `/platform/workspaces/${slug}${tab}` : "/platform/workspaces");

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------
export async function setWorkspaceService(form: FormData) {
  const workspace = text(form, "workspace");
  const path = workspacePath(workspace, "/services");
  await requirePlatformUser({ manage: true, nextPath: path });

  const parsed = setServiceInputSchema.safeParse({
    workspace,
    service: text(form, "service"),
    status: text(form, "status"),
    source: text(form, "source") || "manual",
    starts_on: text(form, "starts_on"),
    ends_on: text(form, "ends_on"),
    reason: text(form, "reason"),
    confirmed: text(form, "confirmed") === "yes",
  });
  if (!parsed.success) back(path, parsed.error.issues[0]?.message ?? "Check the service details.");
  const input = parsed.data;

  // Dates are whole days on the business's own clock.
  const detail = await getPlatformWorkspace(input.workspace);
  const startsAt = input.starts_on ? zonedLocalToUtcIso(`${input.starts_on}T00:00`, detail.timezone) : null;
  const endsAt = input.ends_on ? zonedLocalToUtcIso(`${input.ends_on}T00:00`, detail.timezone) : null;

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_platform_set_service", {
    target_workspace_slug: input.workspace,
    service_code: input.service,
    new_status: input.status,
    new_source: input.source,
    new_starts_at: startsAt,
    new_ends_at: endsAt,
    change_reason: input.reason,
    confirmed: input.confirmed,
  });
  if (error) back(path, platformErrorMessage(error.message));
  const result = setServiceResultSchema.safeParse(data);
  if (!result.success) back(path, "The change could not be confirmed. Refresh and check the service.");

  if (result.data.status === "needs_confirmation") {
    // Ask again with the same values and the consequences spelled out.
    back(path, "Confirm this change", "error", {
      confirm: input.service,
      status: input.status,
      source: input.source,
      starts_on: input.starts_on ?? "",
      ends_on: input.ends_on ?? "",
      reason: input.reason,
      warnings: JSON.stringify(result.data.warnings.slice(0, 8)),
    });
  }
  revalidatePath(`/platform/workspaces/${input.workspace}`, "layout");
  revalidatePath("/platform");
  if (result.data.status === "unchanged") back(path, "Nothing changed.", "saved");
  back(path, `${detail.service_catalog.find((service) => service.code === input.service)?.name ?? input.service} is now ${input.status}${result.data.effective ? "" : " (not active right now)"}.`, "saved");
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
export async function setWorkspaceMember(form: FormData) {
  const workspace = text(form, "workspace");
  const path = workspacePath(workspace, "/users");
  await requirePlatformUser({ manage: true, nextPath: path });

  const parsed = setMemberInputSchema.safeParse({
    workspace,
    email: text(form, "email"),
    role: text(form, "role"),
    status: text(form, "status") || "active",
    reason: text(form, "reason"),
    display_name: text(form, "display_name"),
    password: text(form, "password"),
  });
  if (!parsed.success) back(path, parsed.error.issues[0]?.message ?? "Check the user details.");
  const input = parsed.data;

  const supabase = await createServerSupabaseClient();
  const save = () => supabase.rpc("hanafy_platform_set_member", {
    target_workspace_slug: input.workspace,
    member_email: input.email,
    role_code: input.role,
    member_status: input.status,
    change_reason: input.reason,
  });

  let { error } = await save();
  let created = false;
  if (error?.message.includes("No account uses that email")) {
    if (!input.password) back(path, "No account uses that email. Add a name and a temporary password to create one.");
    const service = (() => {
      try {
        return createServiceSupabaseClient();
      } catch {
        return null;
      }
    })();
    if (!service) back(path, "Creating sign-ins needs SUPABASE_SERVICE_ROLE_KEY on the server.");
    // The new account starts with no access anywhere; the audited RPC below grants it.
    const createdUser = await service.auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: { display_name: input.display_name ?? input.email.split("@")[0] },
    });
    if (createdUser.error || !createdUser.data.user) {
      logger.warn("platform.member_create_failed", { code: createdUser.error?.code ?? null });
      back(path, "The sign-in could not be created.");
    }
    created = true;
    ({ error } = await save());
  }
  if (error) back(path, platformErrorMessage(error.message));

  revalidatePath(`/platform/workspaces/${input.workspace}`, "layout");
  back(path, created
    ? `${input.email} can now sign in. Share the temporary password privately and ask them to change it.`
    : `${input.email} is now ${input.status === "active" ? input.role : "suspended"}.`, "saved");
}

// ---------------------------------------------------------------------------
// Support sessions (§8.4)
// ---------------------------------------------------------------------------
export async function startSupportSession(form: FormData) {
  const workspace = text(form, "workspace");
  const path = workspacePath(workspace);
  await requirePlatformUser({ support: true, nextPath: path });

  const parsed = startSupportInputSchema.safeParse({
    workspace,
    reason: text(form, "reason"),
    ticket: text(form, "ticket"),
    minutes: text(form, "minutes") || "60",
  });
  if (!parsed.success) back(path, parsed.error.issues[0]?.message ?? "Check the support details.");

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("hanafy_platform_start_support", {
    target_workspace_slug: parsed.data.workspace,
    support_reason: parsed.data.reason,
    ticket_reference: parsed.data.ticket,
    duration_minutes: parsed.data.minutes,
  });
  if (error) back(path, platformErrorMessage(error.message));

  // Work in that business from now on (the slug is re-validated on every request).
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WORKSPACE_COOKIE, parsed.data.workspace, activeWorkspaceCookieOptions);
  revalidatePath("/", "layout");
  redirect(`/w/${parsed.data.workspace}`);
}

export async function endSupportSession(form: FormData) {
  await requirePlatformUser();
  const sessionId = text(form, "session_id");
  const returnTo = text(form, "return_to");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("hanafy_platform_end_support", {
    target_session_id: /^[0-9a-f-]{36}$/i.test(sessionId) ? sessionId : null,
  });
  const path = returnTo.startsWith("/platform") && !returnTo.startsWith("//") ? returnTo.split("?")[0] ?? "/platform" : "/platform";
  if (error) back(path, platformErrorMessage(error.message));

  if (!sessionId) {
    // Own session ended: stop pointing the back office at that business.
    const cookieStore = await cookies();
    cookieStore.delete(ACTIVE_WORKSPACE_COOKIE);
  }
  revalidatePath("/", "layout");
  back(path, "Support session ended.", "saved");
}

// ---------------------------------------------------------------------------
// Messaging (Phase 7)
// ---------------------------------------------------------------------------
export async function saveWorkspaceMessaging(form: FormData) {
  const workspace = text(form, "workspace");
  const path = workspacePath(workspace, "/messaging");
  await requirePlatformUser({ manage: true, nextPath: path });

  // The confirmation step re-posts the first submission as JSON.
  let payload: Record<string, unknown>;
  const pendingJson = text(form, "pending_payload");
  if (pendingJson) {
    try {
      payload = JSON.parse(pendingJson) as Record<string, unknown>;
    } catch {
      back(path, "The confirmation expired. Make the change again.");
    }
  } else {
    const bool = (key: string) => (text(form, key) === "yes" ? true : text(form, key) === "no" ? false : undefined);
    const identityFields = ["identity_id", "phone_number", "provider_identity_arn", "identity_type", "identity_message_type", "identity_status"];
    const hasIdentity = identityFields.some((key) => text(form, key).trim() !== "");
    payload = {
      status: text(form, "status") || undefined,
      aws_region: text(form, "aws_region"),
      provider_account_ref: text(form, "provider_account_ref"),
      registration_status: text(form, "registration_status"),
      production_access_status: text(form, "production_access_status"),
      dispatch_mode: text(form, "dispatch_mode") || undefined,
      live_sending: bool("live_sending"),
      secret_reference: text(form, "secret_reference"),
      ...(hasIdentity
        ? {
            identity: {
              id: text(form, "identity_id"),
              phone_number: text(form, "phone_number"),
              provider_identity_arn: text(form, "provider_identity_arn"),
              identity_type: text(form, "identity_type"),
              message_type: text(form, "identity_message_type") || undefined,
              status: text(form, "identity_status") || undefined,
              is_default: bool("identity_default"),
            },
          }
        : {}),
    };
  }
  const parsed = saveMessagingInputSchema.safeParse({ workspace, reason: text(form, "reason"), confirmed: text(form, "confirmed") === "yes", payload });
  if (!parsed.success) back(path, parsed.error.issues[0]?.message ?? "Check the messaging details.");

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_platform_save_messaging", {
    target_workspace_slug: parsed.data.workspace,
    payload: parsed.data.payload,
    change_reason: parsed.data.reason,
    confirmed: parsed.data.confirmed,
  });
  if (error) back(path, platformErrorMessage(error.message));
  const result = saveMessagingResultSchema.safeParse(data);
  if (!result.success) back(path, "The change could not be confirmed. Refresh and check.");
  if (result.data.status === "needs_confirmation") {
    back(path, "Confirm this change", "error", {
      confirm: "messaging",
      reason: parsed.data.reason,
      pending_payload: JSON.stringify(parsed.data.payload),
      warnings: JSON.stringify(result.data.warnings.slice(0, 8)),
    });
  }
  revalidatePath(path);
  back(path, "Messaging saved.", "saved");
}

// ---------------------------------------------------------------------------
// Automations cut-over (Phase 8)
// ---------------------------------------------------------------------------
export async function adoptLegacyAutomations(form: FormData) {
  const workspace = text(form, "workspace");
  const path = workspacePath(workspace, "/messaging");
  await requirePlatformUser({ manage: true, nextPath: path });
  const reason = text(form, "reason").trim();
  if (reason.length < 5) back(path, "Give a reason (at least 5 characters).");
  if (text(form, "confirmed") !== "yes") back(path, "Tick the box to confirm the old CRM automations are paused.");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_platform_adopt_legacy_automations", { target_workspace_slug: workspace, change_reason: reason });
  if (error) back(path, platformErrorMessage(error.message));
  revalidatePath(path);
  back(path, `${Number(data ?? 0)} automations now run on the platform. Switch each one on in the business's Automations screen.`, "saved");
}

// ---------------------------------------------------------------------------
// Payments & integrations (Phase 9)
// ---------------------------------------------------------------------------
export async function savePaymentConnection(form: FormData) {
  const workspace = text(form, "workspace");
  const path = workspacePath(workspace, "/integrations");
  await requirePlatformUser({ manage: true, nextPath: path });

  let payload: Record<string, unknown>;
  const pendingJson = text(form, "pending_payload");
  if (pendingJson) {
    try {
      payload = JSON.parse(pendingJson) as Record<string, unknown>;
    } catch {
      back(path, "The confirmation expired. Make the change again.");
    }
  } else {
    const publicConfiguration: Record<string, string | boolean> = {};
    for (const key of ["application_id", "provider_location_id", "notification_url", "processor_name"]) {
      const value = text(form, `config_${key}`).trim();
      if (value) publicConfiguration[key] = value;
    }
    for (const key of ["online_card_enabled", "terminal_card_enabled"]) {
      const value = text(form, `config_${key}`);
      if (value === "yes" || value === "no") publicConfiguration[key] = value === "yes";
    }
    payload = {
      id: text(form, "id"),
      provider: text(form, "provider"),
      purpose: text(form, "purpose"),
      connection_mode: text(form, "connection_mode"),
      status: text(form, "status"),
      environment: text(form, "environment"),
      merchant_reference: text(form, "merchant_reference"),
      location_id: text(form, "location_id"),
      secret_reference: text(form, "secret_reference"),
      terminal_label: text(form, "terminal_label"),
      ...(Object.keys(publicConfiguration).length ? { public_configuration: publicConfiguration } : {}),
    };
  }
  const parsed = savePaymentConnectionInputSchema.safeParse({ workspace, reason: text(form, "reason"), confirmed: text(form, "confirmed") === "yes", payload });
  if (!parsed.success) back(path, parsed.error.issues[0]?.message ?? "Check the payment connection.");

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_platform_save_payment_connection", {
    target_workspace_slug: parsed.data.workspace,
    payload: parsed.data.payload,
    change_reason: parsed.data.reason,
    confirmed: parsed.data.confirmed,
  });
  if (error) back(path, platformErrorMessage(error.message));
  const result = savePaymentConnectionResultSchema.safeParse(data);
  if (!result.success) back(path, "The change could not be confirmed. Refresh and check.");
  if (result.data.status === "needs_confirmation") {
    back(path, "Confirm this change", "error", {
      confirm: "payment",
      reason: parsed.data.reason,
      pending_payload: JSON.stringify(parsed.data.payload),
      warnings: JSON.stringify(result.data.warnings.slice(0, 8)),
    });
  }
  revalidatePath(path);
  back(path, "Payment connection saved. API connections show connected only after a successful test.", "saved");
}

/** A real, read-only provider call; only its success marks a connection connected. */
export async function testWorkspacePaymentConnection(form: FormData) {
  const workspace = text(form, "workspace");
  const path = workspacePath(workspace, "/integrations");
  await requirePlatformUser({ manage: true, nextPath: path });
  const connectionId = text(form, "id");
  // Read through the caller's own session so the platform role is checked,
  // and only a connection of THIS business can be tested.
  const integrations = await getPlatformWorkspaceIntegrations(workspace);
  const listed = integrations.payment_connections.find((item) => item.id === connectionId);
  if (!listed) back(path, "Payment connection not found for this business.");
  const connection = paymentConnectionSchema.parse({
    id: listed.id,
    workspace_id: (await getPlatformWorkspace(workspace)).id,
    location_id: listed.location_id,
    provider: listed.provider,
    connection_mode: listed.connection_mode,
    status: listed.status,
    environment: listed.environment,
    merchant_reference: listed.merchant_reference,
    capabilities: listed.capabilities,
    public_configuration: listed.public_configuration,
    secret_reference: listed.secret_reference,
    purpose: listed.purpose,
  });
  const outcome = await testPaymentConnection(connection);
  const { error } = await createServiceSupabaseClient().rpc("hanafy_payment_connection_record_check", {
    target_connection_id: connection.id,
    succeeded: outcome.ok,
    note: outcome.note,
  });
  if (error) back(path, platformErrorMessage(error.message));
  revalidatePath(path);
  back(path, outcome.note, outcome.ok ? "saved" : "error");
}

// ---------------------------------------------------------------------------
// Hardware (Phase 10)
// ---------------------------------------------------------------------------
export async function saveHardwareDevice(form: FormData) {
  const workspace = text(form, "workspace");
  const path = workspacePath(workspace, "/hardware");
  await requirePlatformUser({ manage: true, nextPath: path });

  // Only fields actually on the submitted form are sent, so a partial form
  // (e.g. "retire") never blanks the others.
  const fields = ["id", "device_type", "name", "vendor", "model", "serial_number", "asset_tag", "status", "ownership_type", "connection_type",
    "ip_address", "mac_address", "protocol", "port", "assigned_service", "monitoring", "location_id", "notes", "payment_terminal_id"] as const;
  const payload: Record<string, unknown> = {};
  for (const key of fields) if (form.has(key)) payload[key] = text(form, key);
  if (form.has("caller_lines_present")) payload.caller_lines = form.getAll("caller_lines").map(String);

  const parsed = saveHardwareInputSchema.safeParse({ workspace, reason: text(form, "reason"), payload });
  if (!parsed.success) back(path, parsed.error.issues[0]?.message ?? "Check the device details.");
  // Cleared optional fields must reach the database as "" so they are cleared.
  const cleaned: Record<string, unknown> = { ...parsed.data.payload };
  for (const key of ["vendor", "model", "serial_number", "asset_tag", "notes", "ip_address", "mac_address", "protocol", "port"] as const) {
    if (key in payload && cleaned[key] === undefined) cleaned[key] = "";
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("hanafy_platform_save_hardware_device", {
    target_workspace_slug: parsed.data.workspace,
    payload: cleaned,
    change_reason: parsed.data.reason,
  });
  if (error) back(path, platformErrorMessage(error.message));
  revalidatePath(`/platform/workspaces/${parsed.data.workspace}`, "layout");
  back(path, cleaned.status === "retired" ? "Device retired. Its history is kept." : "Device saved.", "saved");
}

// ---------------------------------------------------------------------------
// Hanafy billing + equipment (Phase 11).  Money typed as dollars is parsed as
// text into integer cents; the database re-checks every amount.
// ---------------------------------------------------------------------------
const reasonSchema = z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a full date.");
const optionalIsoDate = z.union([isoDate, z.literal("")]).optional();

function dollars(form: FormData, key: string, path: string, options: { required?: boolean; allowNegative?: boolean } = {}): number | undefined {
  const raw = text(form, key).trim();
  if (!raw) {
    if (options.required) back(path, "Enter an amount.");
    return undefined;
  }
  const value = parseDollarsToCents(raw);
  if (value === null || (!options.allowNegative && value < 0)) back(path, `"${raw}" is not an amount in dollars and cents.`);
  return value;
}

async function billingRpc(path: string, name: string, args: Record<string, unknown>) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc(name, args);
  if (error) back(path, platformErrorMessage(error.message));
  const result = billingResultSchema.safeParse(data);
  if (!result.success) back(path, "The change could not be confirmed. Refresh and check.");
  return result.data;
}

function billingPath(form: FormData) {
  const workspace = text(form, "workspace");
  const tab = text(form, "tab") === "equipment" ? "/equipment" : "/billing";
  return { workspace, path: workspacePath(workspace, tab) };
}

export async function saveSubscription(form: FormData) {
  const { workspace, path } = billingPath(form);
  await requirePlatformUser({ billing: true, nextPath: path });
  const parsed = z.object({
    id: z.union([z.uuid(), z.literal("")]),
    plan_id: z.union([z.uuid(), z.literal("")]),
    kind: z.enum(["base", "addon"]).or(z.literal("")),
    label: z.string().trim().max(120),
    status: z.enum(["trial", "active", "paused", "cancelled"]).or(z.literal("")),
    billing_interval: z.enum(billingIntervals).or(z.literal("")),
    start_date: optionalIsoDate,
    end_date: optionalIsoDate,
    custom_terms: z.string().max(2000),
    reason: reasonSchema,
  }).safeParse(Object.fromEntries(["id", "plan_id", "kind", "label", "status", "billing_interval", "start_date", "end_date", "custom_terms", "reason"].map((key) => [key, text(form, key)])));
  if (!parsed.success) back(path, parsed.error.issues[0]?.message ?? "Check the agreement.");
  const input = parsed.data;
  const payload: Record<string, unknown> = {};
  for (const key of ["id", "plan_id", "kind", "label", "status", "billing_interval", "start_date"] as const) if (input[key]) payload[key] = input[key];
  if (form.has("end_date")) payload.end_date = input.end_date ?? "";
  if (form.has("custom_terms")) payload.custom_terms = input.custom_terms;
  if (form.has("plan_id") && input.id) payload.plan_id = input.plan_id;
  const price = dollars(form, "price", path, { required: !input.id });
  if (price !== undefined) payload.price_cents = price;
  await billingRpc(path, "hanafy_platform_save_subscription", { target_workspace_slug: workspace, payload, change_reason: input.reason });
  revalidatePath(`/platform/workspaces/${workspace}`, "layout");
  revalidatePath("/platform");
  back(path, "Agreement saved.", "saved");
}

export async function saveInvoice(form: FormData) {
  const { workspace, path } = billingPath(form);
  await requirePlatformUser({ billing: true, nextPath: path });
  const action = text(form, "action") || "create";
  if (!["create", "update", "issue", "void"].includes(action)) back(path, "Unknown invoice action.");
  const reason = reasonSchema.safeParse(text(form, "reason"));
  if (!reason.success) back(path, reason.error.issues[0]?.message ?? "Give a reason.");
  const payload: Record<string, unknown> = { action };
  const id = text(form, "id");
  if (id) payload.id = id;
  for (const key of ["period_start", "period_end", "issue_date", "due_date"] as const) {
    const value = text(form, key);
    if (value && !isoDate.safeParse(value).success) back(path, "Use full dates.");
    if (value) payload[key] = value;
  }
  if (form.has("notes")) payload.notes = text(form, "notes").slice(0, 2000);
  if (action === "create") payload.include_agreements = text(form, "include_agreements") === "yes";
  if (action === "create" || action === "update") {
    // Up to five free-form lines from the form.
    const items: Record<string, unknown>[] = [];
    for (let index = 0; index < 5; index += 1) {
      const description = text(form, `item_${index}_description`).trim();
      const kind = text(form, `item_${index}_kind`) || "service";
      const amount = dollars(form, `item_${index}_amount`, path, { allowNegative: kind === "adjustment" });
      if (!description && amount === undefined) continue;
      if (!description || amount === undefined) back(path, "Each line needs a description and an amount.");
      const quantity = Number(text(form, `item_${index}_quantity`) || "1");
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) back(path, "Quantity is a whole number from 1.");
      items.push({ kind, description: description.slice(0, 300), quantity, unit_price_cents: amount });
    }
    if (items.length || action === "update") payload.items = items;
  }
  const result = await billingRpc(path, "hanafy_platform_save_invoice", { target_workspace_slug: workspace, payload, change_reason: reason.data });
  revalidatePath(`/platform/workspaces/${workspace}`, "layout");
  revalidatePath("/platform");
  const messages: Record<string, string> = {
    create: `Draft ${result.invoice_number ?? "invoice"} created. Check the lines, then issue it.`,
    update: "Draft updated.",
    issue: `${result.invoice_number ?? "Invoice"} issued. It now counts as unpaid until payments are recorded.`,
    void: "Invoice voided (a draft is discarded).",
  };
  back(path, messages[action] ?? "Saved.", "saved");
}

export async function recordBillingPayment(form: FormData) {
  const { workspace, path } = billingPath(form);
  await requirePlatformUser({ billing: true, nextPath: path });
  const reason = reasonSchema.safeParse(text(form, "reason"));
  if (!reason.success) back(path, reason.error.issues[0]?.message ?? "Give a reason.");
  const target = text(form, "target");
  if (target !== "invoice" && target !== "equipment") back(path, "Unknown payment target.");
  const payload: Record<string, unknown> = { target };
  const voidId = text(form, "void_payment_id");
  if (voidId) {
    payload.void_payment_id = voidId;
  } else {
    const method = z.enum(paymentMethods).safeParse(text(form, "method"));
    if (!method.success) back(path, "Choose how it was paid.");
    const paidOn = text(form, "paid_on");
    if (paidOn && !isoDate.safeParse(paidOn).success) back(path, "Use a full date.");
    Object.assign(payload, {
      target_id: text(form, "target_id"),
      amount_cents: dollars(form, "amount", path, { required: true }),
      method: method.data,
      paid_on: paidOn,
      reference: text(form, "reference").slice(0, 120),
      notes: text(form, "notes").slice(0, 500),
    });
  }
  await billingRpc(path, "hanafy_platform_record_payment", { target_workspace_slug: workspace, payload, change_reason: reason.data });
  revalidatePath(`/platform/workspaces/${workspace}`, "layout");
  revalidatePath("/platform");
  back(path, voidId ? "Payment voided. The balance is owed again." : "Payment recorded.", "saved");
}

export async function saveEquipment(form: FormData) {
  const { workspace, path } = billingPath(form);
  await requirePlatformUser({ billing: true, nextPath: path });
  const reason = reasonSchema.safeParse(text(form, "reason"));
  if (!reason.success) back(path, reason.error.issues[0]?.message ?? "Give a reason.");
  const payload: Record<string, unknown> = {};
  for (const key of ["id", "hardware_device_id", "name", "vendor", "model", "serial_number", "ownership_type", "payment_schedule", "purchased_at", "assigned_at", "status", "notes", "charged_on", "charge_description"] as const) {
    if (form.has(key)) payload[key] = text(form, key).slice(0, key === "notes" ? 1000 : 300);
  }
  if (payload.ownership_type && !["customer_owned", "hanafy_owned", "financed", "leased"].includes(String(payload.ownership_type))) back(path, "Choose who owns it.");
  for (const key of ["purchased_at", "assigned_at", "charged_on"] as const) {
    if (payload[key] && !isoDate.safeParse(payload[key]).success) back(path, "Use full dates.");
  }
  const cost = dollars(form, "hanafy_cost", path);
  if (cost !== undefined) payload.hanafy_cost_cents = cost;
  const price = dollars(form, "customer_price", path);
  if (price !== undefined) payload.customer_price_cents = price;
  if (form.has("charge")) {
    const charge = dollars(form, "charge", path, { required: true, allowNegative: true });
    payload.charge_cents = charge;
  }
  if (!payload.id && !payload.hardware_device_id && !payload.name) back(path, "Name the equipment or pick its device.");
  await billingRpc(path, "hanafy_platform_save_equipment", { target_workspace_slug: workspace, payload, change_reason: reason.data });
  revalidatePath(`/platform/workspaces/${workspace}`, "layout");
  revalidatePath("/platform");
  back(path, payload.charge_cents !== undefined ? "Charge recorded." : "Equipment saved.", "saved");
}

export async function savePlan(form: FormData) {
  const path = "/platform/billing";
  await requirePlatformUser({ billing: true, nextPath: path });
  const parsed = z.object({
    id: z.union([z.uuid(), z.literal("")]),
    code: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, "Code is lowercase letters, numbers and underscores.").or(z.literal("")),
    name: z.string().trim().max(120),
    description: z.string().max(1000),
    reason: reasonSchema,
  }).safeParse(Object.fromEntries(["id", "code", "name", "description", "reason"].map((key) => [key, text(form, key)])));
  if (!parsed.success) back(path, parsed.error.issues[0]?.message ?? "Check the plan.");
  const input = parsed.data;
  if (!input.id && (!input.code || !input.name)) back(path, "A new plan needs a code and a name.");
  const payload: Record<string, unknown> = form.has("services_present") ? { services: form.getAll("services").map(String) } : {};
  if (input.id) payload.id = input.id;
  if (input.code) payload.code = input.code;
  if (input.name) payload.name = input.name;
  if (form.has("description")) payload.description = input.description;
  if (form.has("active")) payload.active = text(form, "active") === "yes";
  if (form.has("price")) {
    const price = dollars(form, "price", path);
    payload.base_monthly_price_cents = price ?? null;
  }
  await billingRpc(path, "hanafy_platform_save_plan", { payload, change_reason: input.reason });
  revalidatePath(path);
  back(path, "Plan saved.", "saved");
}

// ---------------------------------------------------------------------------
// Add Business / provisioning (Phase 12)
// ---------------------------------------------------------------------------
export async function provisionWorkspace(form: FormData) {
  const path = "/platform/workspaces/new";
  await requirePlatformUser({ manage: true, nextPath: path });
  const parsed = provisionInputSchema.safeParse({
    reason: text(form, "reason"),
    services: form.getAll("services").map(String),
    service_source: text(form, "service_source") || "manual",
    business: {
      name: text(form, "name"), slug: text(form, "slug"), legal_name: text(form, "legal_name"), industry: text(form, "industry"),
      timezone: text(form, "timezone"), currency_code: text(form, "currency_code") || "USD",
      contact_name: text(form, "contact_name"), contact_email: text(form, "contact_email"), contact_phone: text(form, "contact_phone"),
      is_test: text(form, "is_test") === "yes",
    },
    location: {
      name: text(form, "location_name"), address_line_1: text(form, "address_line_1"), address_line_2: text(form, "address_line_2"),
      city: text(form, "city"), state_region: text(form, "state_region"), postal_code: text(form, "postal_code"),
      phone: text(form, "location_phone"), email: text(form, "location_email"), timezone: text(form, "location_timezone"),
      hours: { open: text(form, "opens") || "11:00", close: text(form, "closes") || "21:00", closed_days: form.getAll("closed_days").map(String).filter((day) => (weekDays as readonly string[]).includes(day)) },
    },
  });
  if (!parsed.success) back(path, parsed.error.issues[0]?.message ?? "Check the business details.");
  if (!parsed.data.business.is_test && text(form, "real_client_confirmed") !== "yes") {
    back(path, "Creating a real client's workspace needs the owner's go-ahead: tick the box that says it was authorized, or mark it as a test.");
  }
  const { reason, ...payload } = parsed.data;
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_platform_provision_workspace", { payload, change_reason: reason });
  if (error) back(path, platformErrorMessage(error.message));
  const result = provisionResultSchema.safeParse(data);
  if (!result.success) back(path, "The business could not be confirmed. Check Businesses before trying again.");
  revalidatePath("/platform", "layout");
  redirect(`/platform/workspaces/${result.data.slug}/setup?saved=${encodeURIComponent(`${parsed.data.business.name} is set up in provisioning. Work through the checklist, then activate it.`)}`);
}

export async function setWorkspaceStatus(form: FormData) {
  const workspace = text(form, "workspace");
  const path = workspacePath(workspace, "/setup");
  await requirePlatformUser({ manage: true, nextPath: path });
  const status = z.enum(["active", "suspended", "archived"]).safeParse(text(form, "status"));
  if (!status.success) back(path, "Choose a status.");
  const reason = z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500).safeParse(text(form, "reason"));
  if (!reason.success) back(path, reason.error.issues[0]?.message ?? "Give a reason.");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_platform_set_workspace_status", {
    target_workspace_slug: workspace, new_status: status.data, change_reason: reason.data, confirmed: text(form, "confirmed") === "yes",
  });
  if (error) back(path, platformErrorMessage(error.message));
  const result = statusResultSchema.safeParse(data);
  if (!result.success) back(path, "The change could not be confirmed. Refresh and check.");
  if (result.data.status === "needs_confirmation") {
    back(path, "Confirm this change", "error", { confirm: status.data, reason: reason.data, warnings: JSON.stringify(result.data.warnings.slice(0, 8)) });
  }
  revalidatePath("/platform", "layout");
  back(path, result.data.status === "unchanged" ? "Nothing changed." : `Business is now ${status.data}.`, "saved");
}
