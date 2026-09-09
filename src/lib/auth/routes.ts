const protectedPrefixes = ["/admin", "/pos", "/kitchen", "/driver"] as const;

export function isProtectedPath(pathname: string) {
  return protectedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function safeNextPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/admin";
  return isProtectedPath(value.split("?")[0] ?? "") ? value : "/admin";
}
