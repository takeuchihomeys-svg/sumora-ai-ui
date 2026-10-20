-- scripts/brain-self-review-migration.sql — ブレインの自己点検の表（2026-10-18 設計・2026-10-18 夜 竹内さん OK「毎晩の自己点検を朝の報告に載せる」）
--
-- 親が流す（Supabase の SQL エディタ・1回だけ・何回流しても同じ＝if not exists）。表が無い間は scripts/brain-self-review.ts は手元のファイル
--   （<倉庫の根>/.claude/exam-cache/self-review/<JST の日付>/ の proposals.json・report.md・morning-line.txt）だけで動き、朝の報告にも出ない。
--
-- 流れ（表を作った後）:
--   ① 毎晩 JST 1:40 の SumoraExamNight（scripts/exam-brain.ts --run-queue）の最後に scripts/brain-self-review.ts --nightly が流れる（1日の上限 $10 の内・1回 $1 まで）
--   ② self-review が brain_self_review_runs に1日1行（朝の報告の1行・案の数・竹内さんに聞く事）を upsert、
--      brain_self_review_proposals に1束1行を upsert（bundle_key で同じ原因を1行に・日ごとの数 day_counts の和が n＝同じ日を流し直しても二重に数えない）
--   ③ /api/cron/morning-report（毎朝）が brain_self_review_runs の直近（2日以内）1行と、status='open' の竹内さんに聞く事を読んで「🧠 自己点検」の段を出す
--   ④ 竹内さんが「入れる」「入れない」「聞く事の答え」を決めたら status と decision を書く（直しは人が入れる・自動では入れない）
--
-- 個人情報を入れない決まり:
--   ・文は原因の名前・案・直す所（部品・見出し・決まりの名前）・竹内さんに聞く事だけ。お客様の発言・材料の引用は入れない（引用は手元の explanations.jsonl だけ）
--   ・問題は id（spec.json の q001 等）と弱い所の鍵（箱|場面|型）だけ。会話 id・お客様名は持たない
--   ・RLS を入れ、方針（policy）は作らない＝anon / authenticated からは読めない・書けない。道具と cron（service role）だけが使う
--   ・申込以降の会話は対象外のまま（self-review が出さない）

create table if not exists public.brain_self_review_proposals (
  id             uuid primary key default gen_random_uuid(),
  bundle_key     text not null unique check (char_length(bundle_key) <= 120),     -- 直しの種類|外れの場所|原因の芯（causeCore）
  fix_kind       text not null check (fix_kind in ('知識を足す','材料をつなぐ','決まりを変える','出口を直す','お手本を足す','竹内さんに聞く')),
  where_failed   text not null check (where_failed in ('材料に無かった','材料にあったのに読めなかった','判断は合っていて下書きで崩れた','決まり・出口が上書きした','人しか知らない事（AIX の番）','採点・問題の側','分けられない')),
  cause_keys     text[] not null default '{}',                                     -- 原因の名前（20字×数個）
  plans          text[] not null default '{}' check (coalesce(array_length(plans, 1), 0) <= 5),  -- 具体案（300字まで・最大5）
  targets        text[] not null default '{}',                                     -- 直す所（部品・見出し・決まりの名前）
  problem_ids    text[] not null default '{}',                                     -- 効く問題（q001・弱い所の鍵）
  kb_ids         uuid[] not null default '{}',                                     -- 関係する設計知見（system_design_thinking.id）
  needs_takeuchi boolean not null default false,
  questions      text[] not null default '{}',                                     -- 竹内さんに聞く事
  n              integer not null default 1 check (n >= 1),                        -- 束ねた件数（day_counts の和）
  day_counts     jsonb not null default '{}'::jsonb,                               -- {"2026-10-19": 2, …}（同じ日を流し直しても上書き＝二重に数えない）
  first_seen     date not null default (now() at time zone 'Asia/Tokyo')::date,
  last_seen      date not null default (now() at time zone 'Asia/Tokyo')::date,
  status         text not null default 'open' check (status in ('open','accepted','rejected','done')),
  decision       text check (char_length(decision) <= 500),                        -- 竹内さんの決定・聞く事の答え
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- 前の設計で表を作ってあった時のため（day_counts は後から足した列）
alter table public.brain_self_review_proposals add column if not exists day_counts jsonb not null default '{}'::jsonb;
create index if not exists brain_self_review_proposals_open on public.brain_self_review_proposals (status, n desc, last_seen desc);
alter table public.brain_self_review_proposals enable row level security;

-- 1日1行（朝の報告が読む・JST の日付が鍵）
create table if not exists public.brain_self_review_runs (
  day           date primary key,
  morning_line  text not null check (char_length(morning_line) <= 300),          -- 「🧠 自己点検 <日付>: 説明 N件／一番多い原因「…」／竹内さんに聞く M件」
  explained     integer not null default 0 check (explained >= 0),               -- 説明した件数
  proposals     integer not null default 0 check (proposals >= 0),               -- 直しの案（束）の数
  ask_count     integer not null default 0 check (ask_count >= 0),               -- 竹内さんに聞く束の数
  questions     text[] not null default '{}' check (coalesce(array_length(questions, 1), 0) <= 5),  -- 竹内さんに聞く事（200字まで・最大5）
  top_cause     text check (char_length(top_cause) <= 120),                      -- 一番多い原因→直しの種類（N件）
  usd           numeric(8, 4) not null default 0,                                -- その日の説明の費用
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.brain_self_review_runs enable row level security;
