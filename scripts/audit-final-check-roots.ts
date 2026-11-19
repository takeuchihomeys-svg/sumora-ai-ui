// scripts/audit-final-check-roots.ts — 最終チェックの根の直し（final-check-roots.ts・FC_SEVERITY_TABLE）が効く番を数える（読むだけ・LLM なし）
//
// 2026-11-12 作業員20（統括役「DB での数え（誤止め・本番の件数）は 22時以降に、audit-final-check-revision-loss.ts と同じ型で」）。
//   送った例（ai_reply_examples）の reply_context_snapshot->preRevisionCodes（書き直し前の指摘・"CODE:severity"）と、お客様の発言・送った文を並べる。数えるのは:
//   ① AIX_BOUNDARY_APPLICATION の指摘が出た番のうち、お客様が手続き・書類・審査の流れを聞いていた番（★＝FC_APPLICATION_ANSWER=on で外れる見込み）
//   ② 誤りを含む style の block（CONFIRM_NO_OBJECT・CONFIRM_SUBJECT_THEFT・GOCHOUGO_STAFF_TASK・GOCHOUGO_REVERSED・UKETAMAWARI_OBJECT_UNANCHORED）が出た番
//      （FC_SEVERITY_TABLE=off では画面から消える＝on で画面に残る数）
//   ③ 内覧の聞き方の指摘（GOCHOUGO_NO_CONDITION・GOCHOUGO_AFTER_DATE・GUIDE_POSSIBLE_NO_DATE）の数（FC_SUGGESTION_ALIGN の修正案・V12 の対象）
//   判定（正しかった／誤止めだった）は目で読む（件数だけ見ない）。1,000番の誤止めの数え直しはこの一覧の★を目で読んでから。
// 実行（営業時間 9〜22時は避ける・--force で外す）: npx tsx --env-file=.env.local scripts/audit-final-check-roots.ts [--days=14] [--json=<外のパス>] [--force]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { PROCEDURE_QUESTION_RE } from "../app/lib/final-check-roots";
import { ERROR_BEARING_STYLE_CODES } from "../app/lib/final-check-scope";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "14"));
const JSON_OUT = arg("json", "");
const SINCE = new Date(Date.now() - DAYS * 864e5).toISOString();
const TEST_IDS = new Set(["dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"]);
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const jstHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "numeric", hour12: false }).format(new Date())) % 24;
if (jstHour >= 9 && jstHour < 22 && !process.argv.includes("--force")) {
  console.log(`営業時間（JST ${jstHour}時）は DB の全件読みをしない決まり。22時以降に流す（--force で外す）`);
  process.exit(0);
}
const VIEWING_ASK_CODES = ["GOCHOUGO_NO_CONDITION", "GOCHOUGO_AFTER_DATE", "GUIDE_POSSIBLE_NO_DATE"];

async function main() {
  const out: Row[] = [];
  for (let p = 0; p < 20; p++) {
    const { data, error } = await sb.from("ai_reply_examples")
      .select("id, created_at, conversation_id, customer_message, sent_reply, reply_context_snapshot->preRevisionCodes")
      .gte("created_at", SINCE).order("created_at").range(p * 500, p * 500 + 499);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    for (const r of (data ?? []) as Row[]) {
      if (TEST_IDS.has(r.conversation_id)) continue;
      const codes: string[] = Array.isArray(r.preRevisionCodes) ? (r.preRevisionCodes as string[]) : [];
      const has = (pred: (c: string, sev: string) => boolean) => codes.some((x) => { const [c, sev] = String(x).split(":"); return pred(c, sev); });
      const app = has((c) => c === "AIX_BOUNDARY_APPLICATION");
      const errStyle = codes.filter((x) => { const [c, sev] = String(x).split(":"); return ERROR_BEARING_STYLE_CODES.has(c) && sev === "block"; });
      const viewing = VIEWING_ASK_CODES.filter((c) => has((cc) => cc === c));
      if (!app && !errStyle.length && !viewing.length) continue;
      out.push({
        id: String(r.id).slice(0, 8), at: r.created_at, codes: codes.slice(0, 12),
        app, appStar: app && PROCEDURE_QUESTION_RE.test(String(r.customer_message ?? "").normalize("NFKC")), errStyle, viewing,
        customer: String(r.customer_message ?? "").slice(0, 120), sent: String(r.sent_reply ?? "").slice(0, 200),
      });
    }
    if ((data ?? []).length < 500) break;
  }
  const n = (f: (x: Row) => boolean) => out.filter(f).length;
  console.log(`期間 ${DAYS}日・① 申込の境界の指摘 ${n((x) => x.app)}番（★お客様が手続き・書類を聞いていた ${n((x) => x.appStar)}）・② 誤りを含む style の block ${n((x) => x.errStyle.length > 0)}番・③ 内覧の聞き方の指摘 ${n((x) => x.viewing.length > 0)}番`);
  for (const x of out) {
    console.log(`${x.appStar ? "★" : " "} ${x.id} ${String(x.at).slice(0, 10)} ${x.app ? "[申込境界]" : ""}${x.errStyle.length ? `[誤りstyle:${x.errStyle.join(",")}]` : ""}${x.viewing.length ? `[内覧:${x.viewing.join(",")}]` : ""}`);
    console.log(`   客: ${x.customer.replace(/\s+/g, " ")}`);
    console.log(`   送: ${x.sent.replace(/\s+/g, " ")}`);
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
}
main();
