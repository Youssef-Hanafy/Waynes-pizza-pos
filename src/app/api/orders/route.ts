import { createClient } from "@supabase/supabase-js";
import { getPublicSupabaseEnvironment } from "@/lib/supabase/env";
import { checkoutInputSchema, orderCreatedSchema } from "@/lib/orders/schemas";
import { checkoutRateLimitKey } from "@/lib/orders/rate-limit";

export async function POST(request: Request) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "Invalid order request." }, { status: 400 });
  }
  const parsed = checkoutInputSchema.safeParse(input);
  if (!parsed.success)
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Check the order details." },
      { status: 400 },
    );

  const environment = getPublicSupabaseEnvironment();
  const supabase = createClient(
    environment.NEXT_PUBLIC_SUPABASE_URL,
    environment.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data: allowed, error: rateLimitError } = await supabase.rpc(
    "wayne_consume_public_order_rate_limit",
    { client_key: checkoutRateLimitKey(request.headers) },
  );
  // Fail closed: checkout writes must not become an unbounded anonymous API if
  // its abuse protection cannot be reached.
  if (rateLimitError || allowed !== true)
    return Response.json(
      { error: "Too many order attempts. Please wait a few minutes and try again." },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "300" } },
    );
  const { data, error } = await supabase.rpc("wayne_create_test_order", {
    payload: parsed.data,
  });
  if (error)
    return Response.json(
      { error: customerSafeOrderError(error.message) },
      { status: 400 },
    );
  const result = orderCreatedSchema.safeParse(data);
  if (!result.success)
    return Response.json(
      { error: "The order could not be confirmed. Please call Wayne's Pizza." },
      { status: 500 },
    );
  return Response.json(result.data, {
    status: result.data.duplicate ? 200 : 201,
    headers: { "Cache-Control": "no-store" },
  });
}

function customerSafeOrderError(message: string) {
  const expected = [
    "currently closed",
    "currently unavailable",
    "unavailable right now",
    "Choose",
    "required",
    "valid",
    "minimum",
    "modifier",
    "variant",
    "Cart",
    "quantity",
    "Promotion",
    "Tip",
    "Test ordering",
  ];
  return expected.some((part) => message.includes(part))
    ? message
    : "The order could not be placed. Please review it and try again.";
}
