-- AI·방산 등 테마(뉴스 제목 기반) AI 일일 요약 — Supabase SQL Editor에서 실행
create table if not exists macro_themes_briefings (
  id uuid primary key default gen_random_uuid(),
  report_date date not null unique,
  summary text not null,
  source_titles jsonb, -- string[] (구버전) 또는 {"title","url"}[] (신버전 RSS 출처)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function update_macro_themes_briefings_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_macro_themes_briefings_updated_at on macro_themes_briefings;
create trigger trg_macro_themes_briefings_updated_at
before update on macro_themes_briefings
for each row execute procedure update_macro_themes_briefings_updated_at();

create index if not exists idx_macro_themes_briefings_report_date
  on macro_themes_briefings (report_date desc);

alter table macro_themes_briefings enable row level security;
