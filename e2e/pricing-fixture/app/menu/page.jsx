import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { OrderMenuClient } from '@/app/menu/order-menu-client';
import { BrandMark } from '@/components/site/brand-mark';
import { SiteNavigation } from '@/components/site/site-navigation';
export const dynamic = 'force-dynamic';
export default async function Page() {
  const {data,error}=await createServerSupabaseClient().rpc('wayne_public_menu');
  if(error) throw new Error(error.message);
  return <div className="storefront"><header className="site-header"><div className="site-container header-inner"><Link className="site-logo" href="/"><BrandMark badgeLabel="Wayne’s" name="Wayne’s Pizza" city="Worcester, MA" /></Link><SiteNavigation /></div></header><main id="main-content"><OrderMenuClient menu={data} initialFulfillment="pickup" orderingOpen={true} pickupEnabled={true} deliveryEnabled={false} timezone="America/New_York" pickupMinutes={15} deliveryMinutes={45} /></main></div>;
}
