import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { isSignedIn } from "@/lib/auth/access";
import { listMyWorkspaces } from "@/lib/tenancy/context";

export const metadata: Metadata = { title: "Choose a business", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Workspace picker.  A user with one business goes straight to it; a user with
 * several chooses explicitly, so nothing is ever done in a business by guess.
 */
export default async function WorkspacePickerPage() {
  if (!(await isSignedIn())) redirect("/login?next=/w");
  const workspaces = await listMyWorkspaces();
  if (workspaces.length === 1 && workspaces[0]) redirect(`/w/${workspaces[0].slug}`);

  return (
    <main className="mx-auto min-h-screen max-w-3xl bg-wayne-cream px-5 py-12">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-muted">Hanafy Platform</p>
      <h1 className="mt-3 text-4xl font-black">Choose a business</h1>
      {workspaces.length === 0 ? (
        <Card className="mt-8 p-6">
          <p className="font-bold">Your account is not part of a business yet.</p>
          <p className="mt-2 text-sm text-wayne-muted">Ask the business owner to add you, or contact Hanafy Media.</p>
        </Card>
      ) : (
        <div className="mt-8 grid gap-3">
          {workspaces.map((workspace) => (
            <Link className="block" href={`/w/${workspace.slug}`} key={workspace.id}>
              <Card className="flex items-center justify-between gap-4 p-5 transition hover:border-wayne-green">
                <span>
                  <strong className="block text-xl font-black">{workspace.name}</strong>
                  <span className="text-sm text-wayne-muted">{workspace.is_member ? `Your role: ${workspace.role ?? "member"}` : "Hanafy platform access"}</span>
                </span>
                {workspace.status === "active" ? null : <Badge tone="warn">{workspace.status}</Badge>}
              </Card>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
