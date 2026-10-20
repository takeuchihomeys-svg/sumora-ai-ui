-- scripts/parts-eval/exam-parts-gold.sql — パーツごとの試験の正解（4段）を DB に置く案（**まだ流していない**・竹内さんの OK が要る）
-- 今は scripts/parts-eval/gold-16.json（ファイル）で持つ。竹内さんが確認待ちの行を画面で OK／直す流れにする時に使う。
-- 個人情報は入れない（引用は伏せた物・号室の数字は ◯）。
create table if not exists exam_parts_gold (
  problem_id   text not null,                 -- exam_problem_index.id（q008 等）
  ask_id       text not null,                 -- a1 等
  quote        text not null,                 -- ① お客様の発言（伏せた物）
  label        text,                          -- spec の言い換え
  kind         text not null,                 -- request/question/concern/report/feeling
  receive      text,                          -- thanks/apology/care/anxiety/agree（受け止める事）
  properties   text[] not null default '{}',  -- 物件ごとの答え
  route        text not null,                 -- ② reply/promise/aix/none
  routes       text[] not null default '{}',
  facts        text[] not null default '{}',  -- 使う事実
  priority     int,                           -- ③ 答える順
  say          text,                          -- 言う事
  status       text not null default 'machine', -- spec（竹内さんの実送信から）/ machine（確認待ち）/ confirmed（竹内さんが OK）
  why          text,
  confirmed_at timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (problem_id, ask_id)
);
create table if not exists exam_parts_gold_turn (
  problem_id  text primary key,
  lead_with   text,                           -- ③ 先に答える項目（ask_id）
  must_not    text[] not null default '{}',   -- ③ 言ってはいけない事
  close_only  boolean not null default false,
  final_text  text not null,                  -- ④ 竹内さんの実物（伏せた物）
  pending     text[] not null default '{}',   -- 確認待ちの印
  updated_at  timestamptz not null default now()
);
alter table exam_parts_gold enable row level security;
alter table exam_parts_gold_turn enable row level security;
