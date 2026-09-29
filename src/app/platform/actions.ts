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
