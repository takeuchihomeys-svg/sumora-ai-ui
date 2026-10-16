-- scripts/exam-rag-migration.sql — 試験の問題の札と、問題 ↔ 設計知見の紐付けの表（2026-10-16 設計・まだ流さない）
--
-- 竹内さんの OK が出るまで本番に流さない（DB の書き込み・表の作成は竹内さんの承認が要る）。
-- 表が無い間は scripts/lib/exam-rag-store.ts が <倉庫の根>/.claude/exam-cache/brain-exam-rag/ の同じ形のファイルで動く。
-- 表を作ると（select が通ると）自動で表を読む・書く（止める: EXAM_RAG_STORE=local）。既存の控えを表に入れる: scripts/exam-rag.ts --index（文が変わっていない問題は埋め直さない＝費用はほぼ0）
--
-- 個人情報を入れない決まり:
--   ・words / answer は伏せた物だけ（scripts/lib/brain-exam-mask.maskExamText → app/lib/pii-mask.maskForEmbedding の2重）。名前は YUMA、電話・メール・生年月日・郵便番号・番号は伏せ字。
--   ・会話の id は入れない（conv_hash＝sha256("conv:"+id) の先頭16字。元の会話に戻れない）。お客様名・物件の部屋番号の列は持たない。
--   ・RLS を入れ、方針（policy）は作らない＝anon / authenticated からは読めない・書けない。試験の道具（service role）だけが使う。
--   ・words / answer の長さを上限で縛る（会話の全文を入れない）。

create extension if not exists vector;

create table if not exists public.exam_problem_index (
  id             text primary key check (id ~ '^[A-Za-z0-9_-]{1,40}$'),   -- 問題 id（spec.json の q001 等）
  spec_hash      text not null,                                            -- 正解（spec.json の1問）の hash。正解を直したら変わる＝札を作り直す
  type           text not null,                                            -- 場面の型（出し切り・約束・物件オススメ 等）
  sub            text not null default '',                                 -- 小場面（reply-subscene）
  tags           text[] not null default '{}',                             -- 札（お手本＝竹内さんの実送信から足した問題 等）
  stage          text not null check (stage in ('brain','draft')),         -- 効く段: brain＝ブレインまで／draft＝下書きまで
  words          text not null check (char_length(words) <= 600),          -- 言葉: お客様の今の発言＋直前のこちらの送信（伏せた物）
  answer         text not null default '' check (char_length(answer) <= 400), -- 正解: 竹内さんの実送信（伏せた物）
  accept         text[] not null default '{}',                             -- 正解の道（返信・2段:〇・AIX:〇）
  parts          jsonb not null default '{"files":[],"actions":[]}',       -- 効く部品: 段の入口のファイル・録音で見た名札（brain_full・final_check_* 等）
  conv_hash      text not null default '',                                 -- 会話の id の hash（id そのものは入れない）
  added_at       text,                                                     -- spec の addedAt（足した日）
  source         text not null default 'spec' check (source in ('spec','takeuchi_send')),
  embedding      vector(1536),                                             -- text-embedding-3-small（設計知見と同じ作り方）
  embedding_hash text,                                                     -- 埋めた文の hash（文が変われば埋め直す）
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table public.exam_problem_index is '試験の問題の札（RAG で関係する問題だけ選ぶ）。伏せた言葉だけ・会話 id は hash・RLS で service role だけ';
create index if not exists exam_problem_index_type_idx on public.exam_problem_index (type);
create index if not exists exam_problem_index_tags_idx on public.exam_problem_index using gin (tags);
-- 問題は数百行＝全件比較で足りる（索引は無くてよい）。千を超えたら hnsw を足す:
-- create index exam_problem_index_emb_idx on public.exam_problem_index using hnsw (embedding vector_cosine_ops);

create table if not exists public.exam_problem_kb_links (
  problem_id  text not null references public.exam_problem_index(id) on delete cascade,
  kb_id       uuid not null references public.system_design_thinking(id) on delete cascade,
  kind        text not null check (kind in ('auto','fixed')),   -- auto＝埋め込みの近さの候補／fixed＝直して試験が通った時に結んだ物（必ず選ばれる）
  score       double precision not null default 0,              -- 近さ（fixed は 1）
  -- 知見の題・本文の写しは持たない（KB の本文に会話の名前が残っている行がある＝写すと個人情報の置き場が増える）。読む時に kb_id で KB から引いて伏せる
  note        text check (note is null or char_length(note) <= 200), -- どの試験で結んだか（label 等）
  created_at  timestamptz not null default now(),
  primary key (problem_id, kb_id)
);
create index if not exists exam_problem_kb_links_kb_idx on public.exam_problem_kb_links (kb_id);

alter table public.exam_problem_index enable row level security;
alter table public.exam_problem_kb_links enable row level security;
-- 方針は作らない（service role だけ）

-- 近い問題（読むだけ・試験の道具が差分の言葉の埋め込みで引く）
create or replace function public.match_exam_problems(query_embedding vector, match_count integer default 40)
returns table(id text, similarity double precision)
language sql stable security invoker as $$
  select p.id, 1 - (p.embedding <=> query_embedding) as similarity
  from public.exam_problem_index p
  where p.embedding is not null
  order by p.embedding <=> query_embedding
  limit match_count
$$;
revoke all on function public.match_exam_problems(vector, integer) from anon, authenticated;
