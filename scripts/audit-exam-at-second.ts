// scripts/audit-exam-at-second.ts — 試験の問題の時刻（at）の丸めで、お客様の通が落ちていないかを DB と突き合わせて数える（読むだけ・LLM なし）
//
// 2026-10-28: q197〜q199 の at が秒の下で切り捨てられ、その秒の中のお客様の最後の通が場面から落ちていた（.lte("created_at", at)）。
//   DB の created_at はマイクロ秒まで持つ＝ミリ秒で書いた at でも「.102」と「.102345」で落ちる事がある。全問を確かめる道具。
// 使い方: npx tsx --env-file=.env.local scripts/audit-exam-at-second.ts [--spec=path] [--extra-spec=path] [--problems=path]
//   ① 落ちた: at より後・1秒以内のお客様の通（場面から消えている）
//   ② 続き（参考）: at より後・次のスタッフの通より前・10分以内のお客様の通（問題の作りで切ったかも知れない・落ちとは別に数える）
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
type P = { id: string; conv: string; at: string; customer?: string };
const load = (f: string): P[] => { const j = JSON.parse(fs.readFileSync(f, "utf8")); return Array.isArray(j) ? j : (j.problems ?? Object.values(j)); };

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");

async function main() {
  const sets: Array<[string, P[]]> = [["spec", load(arg("spec") ?? "scripts/brain-exam/spec.json")]];
  const extra = arg("extra-spec"); if (extra) sets.push(["extra", load(extra)]);
  const prob = arg("problems") ?? "scripts/brain-exam/problems.json"; if (fs.existsSync(prob)) sets.push(["problems", load(prob)]);
  const seen = new Map<string, string>();
  for (const [name, list] of sets) {
    const dropped: string[] = [], cont: string[] = [];
    let n = 0;
    for (const p of list) {
      const key = `${p.id}|${p.at}`;
      if (name !== "spec" && seen.has(key)) continue;
      seen.set(key, name); n++;
      const atMs = Date.parse(p.at);
      const { data, error } = await sb.from("messages").select("sender, created_at, text").eq("conversation_id", p.conv)
        .gt("created_at", p.at).lte("created_at", new Date(atMs + 10 * 60_000).toISOString()).order("created_at").limit(30);
      if (error) { console.log(`  ${p.id} 読めない: ${error.message}`); continue; }
      const rows = (data ?? []) as Array<{ sender: string; created_at: string; text: string | null }>;
      const inSec = rows.filter((r) => r.sender === "customer" && Date.parse(r.created_at) - atMs < 1000);
      if (inSec.length) dropped.push(`${p.id}  at=${p.at}  落ちた通 ${inSec.length}（${inSec.map((r) => `${r.created_at.slice(11, 26)}・${(r.text ?? "[画像等]").length}字`).join(" / ")}）`);
      const firstStaff = rows.findIndex((r) => r.sender !== "customer");
      const after = (firstStaff < 0 ? rows : rows.slice(0, firstStaff)).filter((r) => r.sender === "customer" && Date.parse(r.created_at) - atMs >= 1000);
      if (after.length) cont.push(`${p.id}  続き ${after.length}通（最初 +${Math.round((Date.parse(after[0].created_at) - atMs) / 1000)}秒）`);
    }
    console.log(`\n== ${name}（${n}問）==\n① 同じ秒の中で落ちた: ${dropped.length}問`);
    for (const d of dropped) console.log("  " + d);
    console.log(`② at の後・スタッフの前・10分以内のお客様の続き（参考）: ${cont.length}問`);
    for (const c of cont) console.log("  " + c);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
