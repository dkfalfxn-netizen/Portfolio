-- Supabase SQL 편집기에서 한 번 실행하세요.
-- 동기화 키별로 서버 스냅샷 복사본을 쌓습니다(「백업 받기」 API).

create table if not exists public.portfolio_snapshot_backups (
  id uuid primary key default gen_random_uuid(),
  sync_key text not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists portfolio_snapshot_backups_sync_key_created_at_idx
  on public.portfolio_snapshot_backups (sync_key, created_at desc);

alter table public.portfolio_snapshot_backups enable row level security;

create policy "deny anon portfolio_snapshot_backups"
  on public.portfolio_snapshot_backups for all using (false);
