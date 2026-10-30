"use client";

import { useEffect, useState } from "react";
import { requestAppUpdate, useAppUpdateState } from "@/stores/app-update";
import { Button } from "@/components/ui/button";
import { useAppBuild, isBehindServer } from "@/stores/app-build";
import { describeNativeApp } from "@/stores/stripe-reader";
import { getDeviceId } from "@/stores/draft-sync";
import { useTipDrafts } from "@/stores/tip-drafts";
import { unsyncedTipDrafts } from "@/lib/tips/drafts";

/**
 * POS → More → "This app" (owner, 2026-10-28: "add a visible, reliable app
 * build/version identifier … so we can confirm exactly which version each
 * tablet is running").  Read it off the screen and compare with the release
 * notes / Vercel deploy: website build + commit, what the server runs, the
 * Android app version and code, its signing key, the WebView, and whether
 * this screen came from the offline copy.
 */
type NativeInfo = { version?: string; versionCode?: number; package?: string; buildType?: string; signer?: string; installedAt?: number; updatedAt?: number; webView?: string; model?: string; android?: number };

const date = (value: string | number | undefined) => {
  if (value === undefined || value === "" || value === 0) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

export function AppInfoPanel() {
  const build = useAppBuild();
  const update = useAppUpdateState();
  const [loadedUrl, setLoadedUrl] = useState("");
  const { drafts } = useTipDrafts();
  const [native, setNative] = useState<NativeInfo | null>(null);
  const [webView, setWebView] = useState("");
  const [device, setDevice] = useState("");
  const [worker, setWorker] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const info = describeNativeApp() as { app_info?: unknown };
      setNative(info.app_info && typeof info.app_info === "object" ? info.app_info as NativeInfo : null);
      setWebView(/Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? "");
      setDevice(getDeviceId());
      setLoadedUrl(`${window.location.origin}${window.location.pathname}`);
      setWorker("serviceWorker" in navigator ? navigator.serviceWorker.controller ? "on" : "not yet (opens offline after the next online start)" : "not supported");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const behind = isBehindServer(build);
  const waitingTips = unsyncedTipDrafts(drafts).length;
  const rows: [string, string][] = [
    ["Website build", build.current ? `${build.current}${build.commit ? ` · commit ${build.commit.slice(0, 7)}` : ""}${build.builtAt ? ` · built ${date(build.builtAt)}` : ""}` : "local build (no deploy id)"],
    ["Server is on", !build.live ? "checking…" : behind ? `${build.live} — different build; check update status below` : "the same build ✓"],
    ["Opened from", build.offlineCopy ? `the saved offline copy${build.savedAt ? ` (saved ${date(build.savedAt)})` : ""}` : "the server ✓"],
    ["Android app", native ? `${native.version ?? "?"}${native.versionCode ? ` (code ${native.versionCode})` : " (1.5 or older)"}${native.buildType ? ` · ${native.buildType}` : ""}` : "not in the Android app (browser)"],
    ...(native?.package ? [["App id", native.package] as [string, string]] : []),
    ...(native?.signer ? [["Signing key", native.signer] as [string, string]] : []),
    ...(native?.updatedAt ? [["Installed / updated", `${date(native.installedAt)} / ${date(native.updatedAt)}`] as [string, string]] : []),
    ["WebView", native?.webView ?? (webView ? `Chrome ${webView}` : "")],
    ["Offline worker", `${worker}${build.worker ? ` · ${build.worker}` : ""}`],
    ["Tips waiting to save", waitingTips ? `${waitingTips} on this register (sending…)` : "none ✓"],
    ["Register id", device],
    ["Loaded URL", loadedUrl],
    ["Update status", `${update.status}: ${update.message}`],
    ["Last successful check", date(update.checkedAt)],
    ["Last reload", update.lastReload ? `${date(update.lastReload.at)} · ${update.lastReload.reason} · ${update.lastReload.target} · ${update.lastReload.confirmed ? "confirmed" : "unconfirmed"}` : "none recorded"],
  ];
  return <section className="rounded-3xl bg-white p-5 shadow-sm">
    <h2 className="text-xl font-black">This app</h2>
    <p className="mt-1 text-sm text-wayne-muted">Which version this register is running. Every register should show the same website build as the server.</p>
    <dl className="mt-3 divide-y divide-wayne-border text-sm">
      {rows.map(([label, value]) => <div className="flex flex-wrap justify-between gap-3 py-2" key={label}><dt className="font-bold">{label}</dt><dd className="max-w-full break-all text-right font-mono text-xs sm:text-sm">{value || "—"}</dd></div>)}
    </dl>
    {behind || build.offlineCopy ? <Button className="mt-3" onClick={requestAppUpdate} variant="secondary">Check for a safe update</Button> : null}
  </section>;
}
