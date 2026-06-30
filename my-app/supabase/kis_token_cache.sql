-- KIS 액세스 토큰 캐시 (Vercel 서버리스는 stateless라 토큰을 공유 저장해 분당 1회 발급제한 회피).
-- 단일 행(id='default')에 토큰과 만료시각(epoch sec)을 보관. service_role로만 접근.
create table if not exists public.kis_token_cache (
  id text primary key default 'default',
  access_token text not null,
  expires_at bigint not null,          -- epoch seconds
  updated_at timestamptz default now()
);

-- RLS 켜고 정책 없음 → anon/공개 접근 차단. 서버의 service_role 키는 RLS를 우회하므로 정상 동작.
alter table public.kis_token_cache enable row level security;
