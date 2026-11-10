-- 기출 오답노트 테이블 (Supabase SQL Editor에서 한 번 실행)
-- RLS를 켜고 정책을 만들지 않으므로 anon 키로는 아무것도 읽을 수 없고,
-- 서버(SUPABASE_SERVICE_ROLE_KEY)만 접근한다. 학생 간 기록 차단은 서버 API가 담당.

create table if not exists exams (
  id text primary key,
  title text not null,
  description text not null default '',
  mc jsonb not null default '[]',
  sa jsonb not null default '[]',
  links jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists students (
  id text primary key,
  name text not null unique,
  pin_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists records (
  id text primary key,
  student_id text not null references students(id) on delete cascade,
  exam_id text not null references exams(id) on delete cascade,
  date date not null,
  items jsonb not null default '[]',
  score numeric not null,
  total numeric not null,
  memo text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists records_student_idx on records(student_id);
create index if not exists records_exam_idx on records(exam_id);

alter table exams enable row level security;
alter table students enable row level security;
alter table records enable row level security;

-- 예시 시험지
insert into exams (id, title, description, mc, sa) values (
  'sample-pungmun-2025-1-2-2',
  '2025 풍문고1 2-2 [CM 19-24]',
  '2025 풍문고1 2학기 기말 공통수학2 [CM 19-24]',
  '[{"no":1,"points":2.7},{"no":2,"points":2.8},{"no":3,"points":2.9},{"no":4,"points":3},{"no":5,"points":3.1},{"no":6,"points":3.1},{"no":7,"points":3.2},{"no":8,"points":3.3},{"no":9,"points":3.4},{"no":10,"points":3.5},{"no":11,"points":3.6},{"no":12,"points":3.7},{"no":13,"points":3.8},{"no":14,"points":3.9},{"no":15,"points":4}]',
  '[{"no":1,"points":3},{"no":2,"points":4},{"no":3,"points":4},{"no":4,"points":5},{"no":5,"points":10},{"no":6,"points":11},{"no":7,"points":13}]'
) on conflict (id) do nothing;
