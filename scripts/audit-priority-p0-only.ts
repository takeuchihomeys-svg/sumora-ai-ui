// scripts/audit-priority-p0-only.ts — BRAIN_PRIORITY_KB_P0_ONLY の確かめ（読むだけ・LLM なし）
//   2026-11-10 作業員8: 全行を読んだ時と priority=0 の行だけを読んだ時で、ブレインに渡す引いた行（pickPulledRows・P1 off）が同じか、読む時間はどれだけか。
//   実行: npx tsx --env-file=.env.local scripts/audit-priority-p0-only.ts
import { createClient } from "@supabase/supabase-js";
import { loadRagRows } from "../app/lib/design-knowledge-rag-server";
import { pickPulledRows, priorityKbP0OnlyRead } from "../app/lib/brain-priority-server";
import type { RagRow } from "../app/lib/design-knowledge-rag";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
(async () => {
  let t = Date.now();
  const all = await loadRagRows(sb);
  const msAll = Date.now() - t;
  t = Date.now();
  const { data, error } = await sb.from("system_design_thinking").select("id, title, insight, tags, is_current, created_at, priority")
    .eq("is_current", true).eq("priority", 0).order("created_at", { ascending: true }).limit(200);
  if (error) throw new Error(error.message);
  const p0 = (data ?? []) as unknown as RagRow[];
  const msP0 = Date.now() - t;
  const now = new Date().toISOString();
  let same = 0, diff = 0;
  for (const scene of [null, "viewing", "cost", "ack", "other"]) for (const text of ["内覧したいです", "初期費用はいくらですか", "ありがとうございます"]) {
    const a = pickPulledRows(all, scene, text, now, { p1: false }).map((r) => r.id).join(",");
    const b = pickPulledRows(p0, scene, text, now, { p1: false }).map((r) => r.id).join(",");
    if (a === b) same++; else { diff++; console.log("違う:", scene, text, a, "|", b); }
  }
  console.log(`全行 ${all.length}行 ${msAll}ms ／ P0 だけ ${p0.length}行 ${msP0}ms ／ 引いた行 同じ ${same}・違う ${diff}`);
  const ok = [priorityKbP0OnlyRead({ p1On: false, env: {} }) === false, priorityKbP0OnlyRead({ p1On: false, env: { BRAIN_PRIORITY_KB_P0_ONLY: "on" } }) === true, priorityKbP0OnlyRead({ p1On: true, env: { BRAIN_PRIORITY_KB_P0_ONLY: "on" } }) === false];
  console.log(`スイッチ: 既定 off・on で P0 だけ・P1 on の時は全行 → ${ok.every(Boolean) ? "OK" : "NG " + JSON.stringify(ok)}`);
  process.exit(diff || !ok.every(Boolean) ? 1 : 0);
})();
