import "server-only";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  adminCalendarDaySchema,
  adminOrderDetailSchema,
  adminOrderSearchResultSchema,
} from "./admin-schemas";

export type AdminOrderFilters = {
  search?: string;
  from?: string;
  through?: string;
  fulfillment?: string;
  source?: string;
  status?: string;
  payment?: string;
  page?: number;
};

export async function getAdminOrders(filters: AdminOrderFilters) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_admin_orders", {
    search_text: filters.search || null,
    from_date: filters.from || null,
    through_date: filters.through || null,
    fulfillment_filter: filters.fulfillment || null,
    source_filter: filters.source || null,
    status_filter: filters.status || null,
    payment_filter: filters.payment || null,
    page_size: 50,
    page_offset: Math.max(0, ((filters.page ?? 1) - 1) * 50),
  });
  if (error) throw new Error(`Order search failed: ${error.message}`);
  return adminOrderSearchResultSchema.parse(data);
}

export async function getAdminOrderCalendar(month: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_admin_order_calendar", {
    target_month: `${month}-01`,
  });
  if (error) throw new Error(`Order calendar failed: ${error.message}`);
  return adminCalendarDaySchema.array().parse(data);
}

export async function getAdminOrderDetail(id: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_admin_order_detail", {
    target_order_id: id,
  });
  if (error) throw new Error(`Order detail failed: ${error.message}`);
  if (data === null) return null;
  return adminOrderDetailSchema.parse(data);
}
