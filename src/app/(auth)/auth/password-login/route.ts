import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/auth/routes";

/**
 * A normal HTML form fallback for the staff login screen.
 *
 * The React client normally intercepts the form and signs in directly with
 * Supabase. Some managed Android WebViews render the page but do not start its
 * JavaScript bundle; keeping this POST route means those registers can still
 * sign in without exposing credentials in a URL or the Android shell.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const email = typeof form.get("email") === "string" ? String(form.get("email")).trim() : "";
  const password = typeof form.get("password") === "string" ? String(form.get("password")) : "";
  const nextPath = safeNextPath(typeof form.get("next") === "string" ? String(form.get("next")) : null);

  if (!email || !password) return loginError(request, nextPath, "Enter your email and password.");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return loginError(request, nextPath, "Sign-in is temporarily unavailable.");

  const response = NextResponse.redirect(new URL(nextPath, request.url), 303);
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return error ? loginError(request, nextPath, "Invalid email or password.") : response;
}

function loginError(request: NextRequest, nextPath: string, message: string) {
  const url = new URL("/login", request.url);
  url.searchParams.set("next", nextPath);
  url.searchParams.set("error", message);
  return NextResponse.redirect(url, 303);
}
