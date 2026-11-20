import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/pos/closeout/route';
import { POST } from '@/app/api/pos/closeout/payout/route';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/access', () => ({ getCurrentAccess: async () => ({ workspace_id: 'workspace', location_id: 'location' }) }));
vi.mock('@/lib/auth/permissions', () => ({ hasPermission: () => true }));
vi.mock('@/lib/payments/config', () => ({ readPaymentConnection: async (purpose: string, scope: unknown) => { scopes.push({purpose,scope}); return provider ? {provider} : null; } }));
vi.mock('@/lib/supabase/server', () => ({ createServiceSupabaseClient: () => db, createServerSupabaseClient: () => db }));
let provider: string | null = 'payarc';
const scopes: unknown[] = [];
const tables: string[] = [];
const report = { day: '2026-11-20', timezone: 'America/New_York', sales: {}, tenders: {}, online: {}, in_store: {}, refunds: {}, voids: {}, unpaid: {}, drawer: {}, saved: null };
const rpc = vi.fn(async (name: string) => ({ data: name === 'wayne_day_closeout' ? report : name === 'wayne_owner_tips_paid_out' ? 0 : {day: report.day, outcome: 'empty', batch: null}, error: null }));
const db = { rpc, from: (table: string) => {
  tables.push(table);
  const query = { select: () => query, eq: () => query, order: async () => ({data: [], error: null}), maybeSingle: async () => ({data: {enabled: true, start_business_date: null}, error: null}) };
  return query;
} };
const payoutRequest = () => new Request('https://example.com/api/pos/closeout/payout', {method: 'POST', headers: {'Origin': 'https://example.com', 'Content-Type': 'application/json'}, body: JSON.stringify({day: report.day})});
beforeEach(() => { provider = 'payarc'; tables.length = 0; scopes.length = 0; rpc.mockClear(); });

describe('processor-specific tablet batch controls', () => {
  it('keeps the Payarc cash closeout report while omitting the Stripe batch panel', async () => {
    const response = await GET(new Request('https://example.com/api/pos/closeout'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.day).toBe(report.day);
    expect(body.bank_payout).toBeUndefined();
    expect(tables).toEqual([]);
    expect(scopes).toEqual([{purpose: 'online', scope: {workspaceId: 'workspace', locationId: 'location'}}]);
  });
  it.each(['payarc', 'square', null])('rejects stale tablet payout requests when active processor is %s', async active => {
    provider = active;
    expect((await POST(payoutRequest())).status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('preserves the report and explicit payout action for an active Stripe account', async () => {
    provider = 'stripe';
    const reportResponse = await GET(new Request('https://example.com/api/pos/closeout'));
    expect(reportResponse.status).toBe(200);
    expect((await reportResponse.json()).bank_payout.enabled).toBe(true);
    expect(tables).toEqual(['closeout_payout_control', 'closeout_bank_payouts']);
    const response = await POST(payoutRequest());
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('wayne_close_card_day_batch', {target_workspace_id: 'workspace', target_location_id: 'location', target_day: report.day});
  });
});
