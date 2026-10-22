-- 2026-10-22 竹内さんの決定（設計知見 395e0064「確認事項は全部まとめて聞く・分からない事を集める DB」）＋同日「AI 開発チームの発想で質を上げる仕組み」:
--   owner_questions … 竹内さんへの質問の台帳。kind=question（普通の質問）／gold（この場面の正解はどれ？＝試験・本番の番の正解を決めてもらう）／
--     judge_check（AI の判定 line_watch_turns.verdict と竹内さんの判断を比べる）。答えは scripts/owner-questions.ts --answer で設計知見にも入る。
--   brain_unknowns … ブレインの「分からない事」を型（kind）×鍵（key）で数える。sample_ref は会話 id と時刻だけ（お客様の文・個人情報は入れない）。
--   書くのはサーバーの鍵だけ（RLS 有効・ポリシーなし＝公開キーからは読めない）。同じ文を app/api/migrate-schema/route.ts にも入れてある。
CREATE TABLE IF NOT EXISTS owner_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL DEFAULT 'question',
  topic TEXT NOT NULL DEFAULT 'その他',
  question TEXT NOT NULL,
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommended TEXT,
  why TEXT,
  source_kind TEXT,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  answered_at TIMESTAMPTZ,
  kb_id UUID,
  priority INTEGER NOT NULL DEFAULT 2,
  dedupe_key TEXT UNIQUE,
  ref_exam_qid TEXT,
  ref_watch_turn_id BIGINT,
  ai_verdict TEXT,
  owner_verdict TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT owner_questions_kind_chk CHECK (kind IN ('question', 'gold', 'judge_check')),
  CONSTRAINT owner_questions_status_chk CHECK (status IN ('open', 'answered', 'obsolete'))
);
CREATE INDEX IF NOT EXISTS idx_owner_questions_open ON owner_questions(kind, status, priority, created_at);
ALTER TABLE owner_questions ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS brain_unknowns (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT,
  sample_ref JSONB NOT NULL DEFAULT '[]'::jsonb,
  count INTEGER NOT NULL DEFAULT 0,
  first_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_question_id UUID REFERENCES owner_questions(id) ON DELETE SET NULL,
  UNIQUE (kind, key)
);
CREATE INDEX IF NOT EXISTS idx_brain_unknowns_count ON brain_unknowns(count DESC);
ALTER TABLE brain_unknowns ENABLE ROW LEVEL SECURITY;
