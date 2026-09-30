"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/tenancy/access";
import { createWorkspaceSchema } from "@/lib/tenancy/schemas";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server";

function back(message: string, key: "error" | "saved" = "error"): never {
  redirect(`/platform?${key}=${encodeURIComponent(message)}`);
}

async function findUserIdByEmail(email: string) {
  const service = createServiceSupabaseClient();
  let page = 1;
  while (page <= 100) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 1_000 });
    if (error) throw error;
    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
    if (user) return { id: user.id, created: false };
    if (!data.nextPage) return { id: null, created: false };
    page = data.nextPage;
  }
  throw new Error("Could not search the account directory.");
}

export async function createBusiness(form: FormData) {
  await requirePlatformAdmin("/platform");
  const parsed = createWorkspaceSchema.safeParse({
    workspace_slug: form.get("workspace_slug"),
    business_name: form.get("business_name"),
    legal_name: form.get("legal_name"),
    public_email: form.get("public_email"),
    public_phone: form.get("public_phone"),
    owner_name: form.get("owner_name"),
    owner_email: form.get("owner_email"),
    owner_password: form.get("owner_password"),
    location_name: form.get("location_name"),
    timezone: form.get("timezone"),
    service_codes: form.getAll("service_codes")
  });
  if (!parsed.success) back(parsed.error.issues[0]?.message ?? "Check the business setup details.");
  const input = parsed.data;

  let owner: { id: string | null; created: boolean };
  try {
    owner = await findUserIdByEmail(input.owner_email);
  } catch {
    back("The owner account could not be checked. Try again.");
  }

  if (!owner!.id) {
    const service = createServiceSupabaseClient();
    const { data, error } = await service.auth.admin.createUser({
      email: input.owner_email,
      password: input.owner_password,
      email_confirm: true,
      user_metadata: { display_name: input.owner_name }
    });
    if (error || !data.user) back("The owner account could not be created. Check the email and password, then try again.");
    owner = { id: data.user.id, created: true };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("hanafy_create_workspace", {
    workspace_slug_value: input.workspace_slug,
    workspace_name_value: input.business_name,
    legal_name_value: input.legal_name,
    public_email_value: input.public_email,
    public_phone_value: input.public_phone,
    location_name_value: input.location_name,
    timezone_value: input.timezone,
    owner_user_id_value: owner!.id,
    service_codes_value: input.service_codes
  });
  if (error) {
    if (owner!.created && owner!.id) await createServiceSupabaseClient().auth.admin.deleteUser(owner!.id);
    back(error.code === "23505" ? "That business URL key is already in use." : "The business could not be provisioned. Try again.");
  }

  revalidatePath("/platform");
  back(`${input.business_name} is ready for its owner to begin setup.`, "saved");
}
