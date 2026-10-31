import { createServerSupabaseClient } from '@/lib/supabase/server';
import { OrderMenuClient } from '@/app/menu/order-menu-client';
export const dynamic = 'force-dynamic';
export default async function Page() {
  const {data,error}=await createServerSupabaseClient().rpc('wayne_public_menu');
  if(error) throw new Error(error.message);
  return <OrderMenuClient menu={data} initialFulfillment="pickup" orderingOpen={true} pickupEnabled={true} deliveryEnabled={false} timezone="America/New_York" pickupMinutes={15} deliveryMinutes={45} />;
}
