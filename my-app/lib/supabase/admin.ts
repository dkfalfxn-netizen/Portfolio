import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** 서버 전용 — Route Handler에서만 사용 (서비스 롤 키) */
export function createSupabaseAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
