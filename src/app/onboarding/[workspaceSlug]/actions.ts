"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { workspaceOnboardingSchema } from "@/lib/tenancy/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

function back(slug: string, message: string, key: "error" | "saved" = "error"): never {
  redirect(`/onboarding/${encodeURIComponent(slug)}?${key}=${encodeURIComponent(message)}`);
}

export async function saveBusinessSetup(form: FormData) {
  const parsed = workspaceOnboardingSchema.safeParse({
    workspace_id: form.get("workspace_id"),
    workspace_slug: form.get("workspace_slug"),
    location_id: form.get("location_id"),
    business_name: form.get("business_name"),
    legal_name: form.get("legal_name"),
    public_email: form.get("public_email"),
    public_phone: form.get("public_phone"),
    location_name: form.get("location_name"),
    timezone: form.get("timezone"),
    address_line1: form.get("address_line1"),
    address_line2: form.get("address_line2"),
    city: form.get("city"),
    state_or_region: form.get("state_or_region"),
    postal_code: form.get("postal_code"),
    country_code: form.get("country_code"),
    complete: form.get("complete") === "on"
  });
  const rawSlug = typeof form.get("workspace_slug") === "string" ? form.get("workspace_slug") as string : "";
  if (!parsed.success) back(rawSlug || "business", parsed.error.issues[0]?.message ?? "Check the setup fields.");
  const input = parsed.data;
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("hanafy_update_workspace_onboarding", {
    target_workspace_id: input.workspace_id,
    workspace_name_value: input.business_name,
    legal_name_value: input.legal_name,
    public_email_value: input.public_email,
    public_phone_value: input.public_phone,
    location_id_value: input.location_id,
    location_name_value: input.location_name,
    timezone_value: input.timezone,
    address_line1_value: input.address_line1,
    address_line2_value: input.address_line2,
    city_value: input.city,
    state_or_region_value: input.state_or_region,
    postal_code_value: input.postal_code,
    country_code_value: input.country_code,
    complete_value: input.complete
  });
  if (error) back(input.workspace_slug, "Your setup could not be saved. Refresh and try again.");
  revalidatePath(`/onboarding/${input.workspace_slug}`);
  revalidatePath("/platform");
  back(input.workspace_slug, input.complete ? "Business profile complete." : "Business profile saved.", "saved");
}
