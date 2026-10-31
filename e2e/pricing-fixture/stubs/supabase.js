import { createClient } from '@supabase/supabase-js';
export function createServerSupabaseClient() {
  if (!process.env.PRICING_FIXTURE_URL?.startsWith('http://127.0.0.1:')) throw new Error('Local fixture required');
  return createClient(process.env.PRICING_FIXTURE_URL, 'isolated-fixture-only', { auth: { persistSession: false } });
}
export const createServiceSupabaseClient = createServerSupabaseClient;
