// app/lib/scene-skills-server.ts — 決まりの本を設計知見から読んで場面の技能を組む（サーバー専用・サーバーの鍵・1時間の控え）
//
// 2026-11-03 作業員6（竹内さん KB P1「100% に向けて土台の7つ」①②）。読むのは system_design_thinking の現行の P0〜P2 だけ（id・題・中身・段・札・parent・作った日）。
//   1時間の控え（プロセスの間）＝毎番 DB を読まない。鍵が無い・読めない時は空の本（ログに1行・返信は止めない）。SCENE_SKILLS（既定 off）は呼ぶ側で見る。
//   版（version）は「読んだ行の数＋一番新しい行の日」＝下書きの digest に残して、どの版の本で書いたかを後から分けられる（土台⑧①）。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildSceneSkill, type RuleRow, type SceneSkill } from "./scene-skills";
import type { KbScene } from "./design-knowledge-rag";

function serviceClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
let memo: { at: number; rows: RuleRow[]; version: string } | null = null;
const TTL = 3600_000;

export async function loadRuleRows(): Promise<{ rows: RuleRow[]; version: string }> {
  if (memo && Date.now() - memo.at < TTL) return { rows: memo.rows, version: memo.version };
  const sb = serviceClient();
  if (!sb) { console.warn(JSON.stringify({ tag: "scene-skills:no-key" })); return { rows: [], version: "none" }; }
  try {
    const rows: RuleRow[] = [];
    for (let f = 0; f < 5000; f += 1000) {
      const { data, error } = await sb.from("system_design_thinking").select("id, title, insight, priority, tags, parent, created_at")
        .eq("is_current", true).lte("priority", 2).order("created_at").range(f, f + 999);
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as RuleRow[]));
      if (!data || data.length < 1000) break;
    }
    const newest = rows.reduce((m, r) => (r.created_at > m ? r.created_at : m), "");
    const version = `kb:${rows.length}:${newest.slice(0, 10)}`;
    memo = { at: Date.now(), rows, version };
    return { rows, version };
  } catch (e) {
    console.warn(JSON.stringify({ tag: "scene-skills:read-failed", error: e instanceof Error ? e.message : String(e) }));
    return { rows: [], version: "error" };
  }
}

/** その場面の技能（決まりの本つき） */
export async function loadSceneSkill(scene: KbScene, o: { retires?: string[]; examples?: SceneSkill["writer"]["examples"] } = {}): Promise<SceneSkill> {
  const { rows, version } = await loadRuleRows();
  return buildSceneSkill(rows, scene, { ...o, version });
}
