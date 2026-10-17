-- scripts/brain-self-review-migration.sql — ブレインの自己点検の「直しの案」の表（2026-10-18 設計・まだ流さない）
--
-- 竹内さんの OK が出るまで本番に流さない（DB の書き込み・表の作成は竹内さんの承認が要る）。
-- 表が無い間は scripts/brain-self-review.ts が <倉庫の根>/.claude/exam-cache/self-review/<JST の日付>/ の proposals.json・report.md で動く
--   （本番の朝の報告 /api/cron/daily-brief は手元のファイルを読めない＝表を作った時だけ朝の報告に1行足せる）。
--
-- 使い方（表を作った後に足す物・今は作らない）:
--   ① scripts/brain-self-review.ts が束ねた案を1束1行で upsert（bundle_key で同じ原因を1行に・数を足す）
--   ② /api/cron/daily-brief が status='open' の上位3行を読み「🧠 自己点検: 一番多い原因 …（N件）／竹内さんに聞く M件」の1行を出す
--   ③ 竹内さんが「入れる」「入れない」「聞く事の答え」を決めたら status と decision を書く（直しは人が入れる・自動では入れない）
--
-- 個人情報を入れない決まり:
--   ・文は原因の名前・案・直す所（部品・見出し・決まりの名前）だけ。お客様の発言・材料の引用は入れない（引用は手元の explanations.jsonl だけ）
--   ・問題は id（spec.json の q001 等）と弱い所の鍵（箱|場面|型）だけ。会話 id・お客様名は持たない
--   ・RLS を入れ、方針（policy）は作らない＝anon / authenticated からは読めない・書けない。道具と cron（service role）だけが使う

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
  n              integer not null default 1 check (n >= 1),                        -- 束ねた件数（同じ原因が出るたびに足す）
  first_seen     date not null default (now() at time zone 'Asia/Tokyo')::date,
  last_seen      date not null default (now() at time zone 'Asia/Tokyo')::date,
  status         text not null default 'open' check (status in ('open','accepted','rejected','done')),
  decision       text check (char_length(decision) <= 500),                        -- 竹内さんの決定・聞く事の答え
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists brain_self_review_proposals_open on public.brain_self_review_proposals (status, n desc, last_seen desc);
alter table public.brain_self_review_proposals enable row level security;
