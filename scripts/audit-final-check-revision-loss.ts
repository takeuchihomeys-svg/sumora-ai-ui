// scripts/audit-final-check-revision-loss.ts — 最終チェックの書き直し・作り直しで消えた／足された文と、スタッフが送った文を並べる（読むだけ・LLM なし）
//
// 2026-11-12 作業員15（竹内さん「ファイナルチェックの部分ボトルネックになっていないかも確認」）。
//   送った例（ai_reply_examples）の tpo_debug.postprocess.exitEdits のうち final_check_revision（書き直し）・final_check_regen（作り直し・11/12 から記録）を出し、
//   消えた文がスタッフの実送信に残っていたか（文字の近さ）を横に付ける。判定（正しかった／ブレインの判断を落とした）は目で読む（件数だけ見ない）。
//   FC_ANSWER_KEEP=on で、段階の語の網（審査・契約・鍵）の指摘を書き直しに渡さなくなる例に印 ★ を付ける（final-check-answer-keep.ts・ブレインの本質は要約しか残らないのでお客様の質問の網で近似）。
// 実行（営業時間 9〜22時は避ける）: npx tsx --env-file=.env.local scripts/audit-final-check-revision-loss.ts [--days=14] [--json=<外のパス>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { MOVE_IN_TIMING_QUESTION_RE, MOVE_IN_ANSWER_SENT_RE } from "../app/lib/final-check-answer-keep";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "14"));
const JSON_OUT = arg("json", "");
const SINCE = new Date(Date.now() - DAYS * 864e5).toISOString();
const TEST_IDS = new Set(["dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"]);
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const grams = (s: string) => { const t = s.normalize("NFKC").replace(/[\s！!。、😊😌🌟✨]/g, ""); return new Set(Array.from({ length: Math.max(t.length - 1, 0) }, (_, i) => t.slice(i, i + 2))); };
/** 消えた文がスタッフの送った文のどれかの文に近いか（Dice 0.6 以上） */
function keptByStaff(removed: string, sent: string): boolean {
  const g = grams(removed);
  if (g.size < 4) return false;
  return sent.split(/\n|(?<=[。！!？?])/).some((s) => { const h = grams(s); let hit = 0; for (const x of g) if (h.has(x)) hit++; return (2 * hit) / (g.size + h.size) >= 0.6; });
}

async function main() {
  const out: Row[] = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("id, created_at, conversation_id, customer_message, sent_reply, reply_context_snapshot->postprocess->exitEdits, reply_context_snapshot->preRevisionCodes")
      .gte("created_at", SINCE).order("created_at").range(p * 500, p * 500 + 499);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    for (const r of (data ?? []) as Row[]) {
      if (TEST_IDS.has(r.conversation_id)) continue;
      const edits: Row[] = Array.isArray(r.exitEdits) ? (r.exitEdits as Row[]) : [];
      for (const e of edits) {
        if (!e || e.exit !== "final_check_revision" && e.exit !== "final_check_regen") continue;
        const removed: string[] = e.removed ?? [];
        const kept = removed.map((s) => keptByStaff(s, r.sent_reply ?? ""));
        const star = (r.preRevisionCodes ?? []).some((c: string) => c.startsWith("TIMING_VOCAB_MISMATCH"))
          && MOVE_IN_TIMING_QUESTION_RE.test(String(r.customer_message ?? "").normalize("NFKC"))
          && removed.some((s) => MOVE_IN_ANSWER_SENT_RE.test(s));
        out.push({ id: String(r.id).slice(0, 8), at: r.created_at, exit: e.exit, gen: e.gen, why: e.why ?? [], removed, added: e.added ?? [], keptByStaff: kept, star, sent: String(r.sent_reply ?? "").slice(0, 200) });
      }
    }
    if ((data ?? []).length < 500) break;
  }
  const n = out.length;
  const lostToStaff = out.filter((x) => x.keptByStaff.some(Boolean)).length;
  console.log(`期間 ${DAYS}日・書き直し／作り直しの記録 ${n}件・消えた文をスタッフが送った文に残していた ${lostToStaff}件・★（FC_ANSWER_KEEP で渡さなくなる見込み） ${out.filter((x) => x.star).length}件\n`);
  for (const x of out) {
    console.log(`${x.star ? "★" : " "} ${x.id} ${String(x.at).slice(0, 10)} ${x.exit}#${x.gen} [${x.why.join(",")}]`);
    x.removed.forEach((s: string, i: number) => console.log(`   − ${x.keptByStaff[i] ? "(スタッフも送った) " : ""}${s}`));
    x.added.forEach((s: string) => console.log(`   ＋ ${s}`));
    console.log(`   送: ${x.sent.replace(/\s+/g, " ")}`);
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
}
main();
