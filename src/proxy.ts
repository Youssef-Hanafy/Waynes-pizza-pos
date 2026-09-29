import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isProtectedPath } from "@/lib/auth/routes";
import { routeByHost, softwareHost } from "@/lib/hosts";
import { ACTIVE_WORKSPACE_COOKIE, activeWorkspaceCookieOptions, workspaceSlugFromPath } from "@/lib/tenancy/active-workspace";

export async function proxy(request: NextRequest) {
  // The software lives on the Hanafy address; each business's own address
  // only serves its customer website (see src/lib/hosts.ts).
  const decision = routeByHost({
    host: request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "",
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    softwareHost: softwareHost(),
  });
  if (decision.action === "redirect") return NextResponse.redirect(decision.location, 308);
  if (decision.action === "not_found") return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

  if (!isProtectedPath(request.nextUrl.pathname)) return NextResponse.next();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return redirectToLogin(request, "Supabase is not configured.");

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      }
    }
  });

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return redirectToLogin(request);

  // Opening a workspace remembers it (slug only; the database re-validates
  // membership on every request, so this is never an authorization).
  const selected = workspaceSlugFromPath(request.nextUrl.pathname);
  if (selected && request.cookies.get(ACTIVE_WORKSPACE_COOKIE)?.value !== selected) {
    response.cookies.set(ACTIVE_WORKSPACE_COOKIE, selected, activeWorkspaceCookieOptions);
  }
  return response;
}

function redirectToLogin(request: NextRequest, error?: string) {
  const target = request.nextUrl.clone();
  target.pathname = "/login";
  target.search = "";
  target.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  if (error) target.searchParams.set("error", error);
  return NextResponse.redirect(target);
}

// Every page (host routing), but not static files or build assets.
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.[a-zA-Z0-9]+$).*)"] };
