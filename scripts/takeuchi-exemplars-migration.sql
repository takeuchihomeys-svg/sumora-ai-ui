-- 2026-11-12 作業員23（竹内さん 11/12「今の設計からブレインと文の生成で足りていない部分を強化していく」）:
--   takeuchi_exemplars … 竹内さんの手本（1通＝1文ずつの役目・なぜ・ブレインの欄）。文の統括が 場面×潜在の型×誘導先 で1つ引き、
--     設計図の注記に「役目の並び・なぜ・事実の種類」だけ渡す（app/lib/takeuchi-exemplar.ts・-server.ts・TAKEUCHI_EXEMPLAR=on の時だけ・既定 off）。
--   文の本文（text）とお客様の発言は入れない（sentences の中に text の鍵があれば DB が断る）。名前・住所などの値は入れる前に伏せる。
--   入れるのは夜の読み scripts/takeuchi-exemplars-load.ts（申込の門 turn-application-gate で外れる番は入れない・JST 9〜22時は止まる）。
--   読み書きはサーバーの鍵だけ（RLS 有効・ポリシーなし・anon／authenticated の権限なし）。同じ文を app/api/migrate-schema/route.ts にも入れてある。
CREATE TABLE IF NOT EXISTS takeuchi_exemplars (
  id TEXT PRIMARY KEY,                                  -- 手本の id（今は元の番の messages.id と同じ）
  scene TEXT NOT NULL,                                  -- 場面（resolveReplyScene の scene）
  latent TEXT NOT NULL,                                 -- 潜在の型（LATENT_KEYS）
  lead TEXT NOT NULL,                                   -- 誘導先（LEAD_TO）
  hand BOOLEAN NOT NULL DEFAULT false,                  -- 手で読んだ手本か
  sentences JSONB NOT NULL DEFAULT '[]'::jsonb,         -- [{role, why, brainField}]（文の本文 text は入れない）
  latent_four JSONB,                                    -- {trigger, part, feeling, want}（伏せ済み）
  fact TEXT,                                            -- 先回りに使った事実の種類（伏せ済み）
  source_turn TEXT NOT NULL,                            -- 元の番（こちらの送信の messages.id・外部キーは付けない＝片付けで消えない）
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT takeuchi_exemplars_sentences_array CHECK (jsonb_typeof(sentences) = 'array'),
  CONSTRAINT takeuchi_exemplars_no_text CHECK (NOT jsonb_path_exists(sentences, '$[*].text'))
);
CREATE INDEX IF NOT EXISTS takeuchi_exemplars_key_idx ON takeuchi_exemplars (scene, latent, lead);
CREATE INDEX IF NOT EXISTS takeuchi_exemplars_latent_idx ON takeuchi_exemplars (latent, lead);
CREATE INDEX IF NOT EXISTS takeuchi_exemplars_lead_idx ON takeuchi_exemplars (lead);
ALTER TABLE takeuchi_exemplars ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON takeuchi_exemplars FROM anon, authenticated;
