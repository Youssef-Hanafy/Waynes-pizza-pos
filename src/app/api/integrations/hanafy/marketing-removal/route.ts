import { secureTokenEquals } from "@/lib/integrations/hanafy";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/*
 * The Hanafy CRM calls this when a contact is deleted there. Removing someone
 * from the CRM means removing them from marketing everywhere, so Wayne's drops
 * their consent and their unclaimed welcome code - but keeps the customer,
 * their orders and the consent history that proves the original opt-in.
 *
 * If they ever join the text club again they come back clean and are welcomed
 * as a new member, code and all.
 */
export async function POST(request: Request) {
  const token = process.env.INTEGRATION_INBOUND_TOKEN;
  const supplied =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!token || !secureTokenEquals(supplied, token)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let phone = "";
  try {
    const body = await request.json();
    phone = typeof body?.phone === "string" ? body.phone.trim() : "";
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const digits = phone.replace(/\D/g, "");
  const national =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) {
    return Response.json(
      { error: "A valid 10-digit US mobile number is required." },
      { status: 400 },
    );
  }

  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_remove_customer_marketing", {
    target_phone: `+1${national}`,
    source_label: "hanafy_crm_delete",
  });
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json(data ?? { ok: true }, {
    headers: { "Cache-Control": "no-store" },
  });
}
