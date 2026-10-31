import { createServerSupabaseClient } from '@/lib/supabase/server';
export async function POST(request) {
  const line=await request.json();
  const { data,error }=await createServerSupabaseClient().rpc('fixture_place_order',{line});
  return Response.json(error ? { error:error.message } : data);
}
