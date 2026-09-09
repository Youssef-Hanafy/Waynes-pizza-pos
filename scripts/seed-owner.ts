import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const environmentSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  WAYNES_OWNER_EMAIL: z.email(),
  WAYNES_OWNER_INITIAL_PASSWORD: z.string().min(12)
});

async function main() {
  const environment = environmentSchema.parse(process.env);
  const supabase = createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const email = environment.WAYNES_OWNER_EMAIL.trim().toLowerCase();
  const { data: listed, error: listError } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1_000 });
  if (listError) throw listError;

  let user = listed.users.find((candidate) => candidate.email?.toLowerCase() === email);
  if (!user) {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: environment.WAYNES_OWNER_INITIAL_PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "Wayne's Pizza Owner" }
    });
    if (error) throw error;
    user = data.user;
  }

  const { data: ownerRole, error: roleError } = await supabase.from("roles").select("id").eq("code", "owner").single();
  if (roleError) throw roleError;

  const { error: profileError } = await supabase.from("profiles").upsert({
    id: user.id,
    display_name: "Wayne's Pizza Owner",
    role_id: ownerRole.id,
    active: true
  });
  if (profileError) throw profileError;

  console.log(`Owner account ready: ${email}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown owner seed error";
  console.error(`Owner seed failed: ${message}`);
  process.exitCode = 1;
});
