/**
 * The workspace a signed-in user is currently working in.
 *
 * Only the workspace *slug* is remembered, in an httpOnly cookie set when the
 * user opens /w/[workspaceSlug].  It is a preference, never an authorization:
 * every request re-validates it against the user's memberships in the
 * database (hanafy_current_workspace_access), and an unknown or foreign slug
 * simply resolves to nothing.
 */
export const ACTIVE_WORKSPACE_COOKIE = "hanafy_workspace";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseWorkspaceSlug(value: string | null | undefined): string | null {
  if (!value) return null;
  const slug = value.trim().toLowerCase();
  return slug.length <= 80 && slugPattern.test(slug) ? slug : null;
}

/** /w/<slug>/anything → slug; anything else → null. */
export function workspaceSlugFromPath(pathname: string): string | null {
  const match = /^\/w\/([^/?#]+)/.exec(pathname);
  return match ? parseWorkspaceSlug(decodeURIComponent(match[1] ?? "")) : null;
}

export const activeWorkspaceCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24 * 180,
} as const;

/** Browser-side keys for drafts, carts and channels include the tenant (§37). */
export function workspaceStorageKey(workspaceId: string | null | undefined, name: string) {
  return workspaceId ? `hanafy:${workspaceId}:${name}` : `hanafy:unscoped:${name}`;
}
