import { createServerSupabaseClient } from '@/lib/supabase/server';
import Counter from './counter';
export const dynamic = 'force-dynamic';
export default async function Page({ params }) {
  const { id } = await params;
  const { data, error } = await createServerSupabaseClient().rpc('wayne_pos_menu');
  if(error) throw new Error(error.message);
  return <Counter item={data.flatMap(c=>c.items).find(i=>i.id===id)} />;
}
