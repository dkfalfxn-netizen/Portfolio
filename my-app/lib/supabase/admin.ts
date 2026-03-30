import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Vercel에 값 붙일 때 생기는 앞뒤 따옴표·공백 제거 */
function cleanEnv(s: string | undefined): string | undefined {
  if (!s) return undefined;
  let t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t || undefined;
}

/** 서버 전용 — Route Handler에서만 사용 (서비스 롤 키) */
export function createSupabaseAdmin(): SupabaseClient | null {
  const url = cleanEnv(process.env.NEXT_PUBLIC_SUPABASE_URL)?.replace(/\/+$/, "");
  const key = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
