import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { customerDetailSchema, customerListSchema, customerSegmentSchema } from "./schemas";

export async function getCustomers(filters: { search?: string; segmentId?: string; page?: number; includeRemoved?: boolean }) { const supabase = await createServerSupabaseClient(); const { data, error } = await supabase.rpc("wayne_admin_customers", { search_text: filters.search || null, segment_filter: filters.segmentId || null, page_size: 50, page_offset: Math.max(0, ((filters.page ?? 1) - 1) * 50), include_removed: filters.includeRemoved === true }); if (error) throw new Error(`Customer search failed: ${error.message}`); return customerListSchema.parse(data); }
export async function getCustomer(id: string) { const supabase = await createServerSupabaseClient(); const { data, error } = await supabase.rpc("wayne_admin_customer_detail", { target_customer_id: id }); if (error) throw new Error(`Customer detail failed: ${error.message}`); return data === null ? null : customerDetailSchema.parse(data); }
export async function getCustomerSegments() { const supabase = await createServerSupabaseClient(); const { data, error } = await supabase.rpc("wayne_admin_customer_segments"); if (error) throw new Error(`Segment list failed: ${error.message}`); return customerSegmentSchema.array().parse(data); }
