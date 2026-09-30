import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const environmentSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  HANAFY_PLATFORM_ADMIN_EMAIL: z.email(),
  HANAFY_PLATFORM_ADMIN_INITIAL_PASSWORD: z.string().min(12).optional()
});

function createServiceClient(environment: z.infer<typeof environmentSchema>) {
  return createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

async function findUserIdByEmail(email: string, environment: z.infer<typeof environmentSchema>) {
  const supabase = createServiceClient(environment);
  let page = 1;
  while (page <= 100) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1_000 });
    if (error) throw error;
    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
    if (user) return user.id;
    if (!data.nextPage) return null;
    page = data.nextPage;
  }
  throw new Error("Could not search the account directory.");
}

async function main() {
  const environment = environmentSchema.parse({
    HANAFY_PLATFORM_ADMIN_EMAIL: process.env.HANAFY_PLATFORM_ADMIN_EMAIL,
    HANAFY_PLATFORM_ADMIN_INITIAL_PASSWORD: process.env.HANAFY_PLATFORM_ADMIN_INITIAL_PASSWORD
  });
  const email = environment.HANAFY_PLATFORM_ADMIN_EMAIL.toLowerCase();
  const supabase = createServiceClient(environment);
  let userId = await findUserIdByEmail(email, environment);

  if (!userId) {
    if (!environment.HANAFY_PLATFORM_ADMIN_INITIAL_PASSWORD) {
      throw new Error("HANAFY_PLATFORM_ADMIN_INITIAL_PASSWORD is required when this email does not already have an account.");
    }
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: environment.HANAFY_PLATFORM_ADMIN_INITIAL_PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: "Hanafy Platform Admin" }
    });
    if (error || !data.user) throw error ?? new Error("Platform administrator account could not be created.");
    userId = data.user.id;
  }

  const { error } = await supabase.from("platform_users").upsert({ user_id: userId, role: "platform_admin", active: true });
  if (error) throw error;
  console.log(`Platform administrator ready: ${email}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Platform administrator setup failed.");
  process.exitCode = 1;
});
