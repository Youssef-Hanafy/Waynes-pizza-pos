import "server-only";

import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { requestHost } from "@/lib/content/queries";
import { logger } from "@/lib/logging/logger";
import { getPublicSupabaseEnvironment } from "@/lib/supabase/env";

/** A special on the website's Offers page (Admin → Menu → Specials, "Show on the website"). */
export const publicSpecialSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  note: z.string(),
  image_path: z.string().nullable(),
  image_alt: z.string(),
  price_cents: z.number().int(),
  size_count: z.number().int(),
  ends_on: z.string().nullable(),
});
export type PublicSpecial = z.infer<typeof publicSpecialSchema>;

/** Specials of the business that owns the request host; an empty list if anything goes wrong. */
export async function getPublicSpecials(): Promise<PublicSpecial[]> {
  const host = await requestHost();
  const environment = getPublicSupabaseEnvironment();
  const supabase = createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await supabase.rpc("hanafy_public_specials", { target_hostname: host });
  if (error) {
    logger.error("specials.public_failed", error);
    return [];
  }
  const parsed = publicSpecialSchema.array().safeParse(data);
  if (!parsed.success) {
    logger.error("specials.public_invalid", { issue: parsed.error.issues[0]?.message });
    return [];
  }
  return parsed.data;
}
