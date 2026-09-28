import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isProtectedPath } from "@/lib/auth/routes";
import { ACTIVE_WORKSPACE_COOKIE, activeWorkspaceCookieOptions, workspaceSlugFromPath } from "@/lib/tenancy/active-workspace";

export async function proxy(request: NextRequest) {
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

export const config = { matcher: ["/admin/:path*", "/pos/:path*", "/kitchen/:path*", "/driver/:path*", "/w", "/w/:path*"] };
