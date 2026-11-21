import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultSettings, storeSettingsSchema } from "../src/lib/content/schemas";
import { isStoreOpenNow } from "../src/lib/content/store-status";
import { startTipPostgres, ownerId } from "./helpers/tip-postgres";

describe("independent online ordering hours", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  beforeAll(async () => { db = await startTipPostgres(); }, 180000);
  afterAll(async () => { await db?.stop(); });

  it("seeds Wayne's schedule without changing physical store hours", async () => {
    const { rows: [row] } = await db.admin.query("select business_hours, online_ordering_hours from public.store_settings");
    expect(row.online_ordering_hours.sunday).toEqual({ closed: false, open: "13:00", close: "19:30" });
    expect(row.online_ordering_hours.monday).toEqual({ closed: false, open: "11:00", close: "21:30" });
    const { rows: [location] } = await db.admin.query("select configuration from public.location_settings where workspace_id=public.hanafy_legacy_workspace_id()");
    expect(location.configuration.online_ordering_hours).toEqual(row.online_ordering_hours);
    expect(location.configuration.business_hours).toEqual(row.business_hours);
  });

  it.each([
    ["2026-11-23T15:59:00Z", false], // Monday 10:59 EST
    ["2026-11-23T16:00:00Z", true],
    ["2026-11-24T02:29:00Z", true],
    ["2026-11-24T02:30:00Z", false],
    ["2026-11-21T16:00:00Z", true], // Saturday
    ["2026-11-22T17:59:00Z", false], // Sunday 12:59 EST
    ["2026-11-22T18:00:00Z", true],
    ["2026-11-23T00:29:00Z", true],
    ["2026-11-23T00:30:00Z", false],
  ])("matches checkout and database enforcement at %s", async (date, expected) => {
    const { rows: [row] } = await db.admin.query("select online_ordering_hours from public.store_settings");
    const settings = { ...defaultSettings, online_ordering_hours: row.online_ordering_hours };
    expect(isStoreOpenNow(settings, new Date(date))).toBe(expected);
    const { rows: [result] } = await db.admin.query("select public.wayne_store_is_open($1) open", [date]);
    expect(result.open).toBe(expected);
  });

  it("saves edited hours through the authenticated settings action RPC and mirrors them", async () => {
    await db.admin.query("begin; set local role authenticated");
    await db.admin.query("select set_config('request.jwt.claim.sub',$1,true)", [ownerId]);
    try {
      const hours = { ...defaultSettings.business_hours, monday: { closed: false, open: "12:00", close: "20:00" } };
      await db.admin.query("select public.hanafy_save_location_settings($1::jsonb,null::text)", [JSON.stringify({ online_ordering_hours: hours })]);
      const { rows: [row] } = await db.admin.query("select online_ordering_hours from public.store_settings");
      expect(row.online_ordering_hours).toEqual(hours);
    } finally { await db.admin.query("rollback"); }
  });

  it("honors the ordering switch and holiday closures in the database", async () => {
    await db.admin.query("begin");
    try {
      await db.admin.query("update public.store_settings set ordering_open=false");
      expect((await db.admin.query("select public.wayne_store_is_open('2026-11-23T16:00:00Z') open")).rows[0].open).toBe(false);
      await db.admin.query("update public.store_settings set ordering_open=true");
      await db.admin.query("insert into public.store_special_hours(service_date,label,closed) values('2026-11-23','Holiday',true)");
      expect((await db.admin.query("select public.wayne_store_is_open('2026-11-23T16:00:00Z') open")).rows[0].open).toBe(false);
    } finally { await db.admin.query("rollback"); }
  });

  it("supports existing settings that do not yet have separate ordering hours", () => {
    const legacy: Record<string, unknown> = { ...defaultSettings };
    delete legacy.online_ordering_hours;
    const settings = storeSettingsSchema.parse(legacy);
    expect(isStoreOpenNow(settings, new Date("2026-11-23T16:00:00Z"))).toBe(true);
  });
});
