-- Supabase SQL 편집기에서 한 번 실행하세요.
create table if not exists public.alert_configs (
  sync_key   text primary key references public.portfolio_snapshots(sync_key) on delete cascade,
  email      text not null,
  rules      jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.alert_configs enable row level security;

-- 서비스 롤(API Route)은 RLS를 우회합니다. anon 직접 접근은 막습니다.
create policy "deny anon" on public.alert_configs for all using (false);
