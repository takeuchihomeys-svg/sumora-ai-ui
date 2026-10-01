// scripts/reject-installment-contradicting-knowledge.ts — 「一括（お振込）のみ」「分割は6回が妥当」型のナレッジを却下にする（2026-10-02 竹内さんの決定）
//   行は消さない（hypothesis_status='rejected'＋rejection_reason）。読む側は全部 rejected を外している（generate-reply・brain-core・prompt-cache）。
//   既定は表示だけ。APPLY=1 で書く。
// 実行: npx tsx --env-file=.env.local scripts/reject-installment-contradicting-knowledge.ts [APPLY=1]
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
// 目で読んで決めた行（id の頭8桁）: 一括のみ 3（a41ee3a7 10/01 フレーズ・7e28f194 10/01 型・33829071 8/30 初回の型）／6回が妥当 3（ba6991ec・9a4ca172・275371d5）
const PREFIXES = ["a41ee3a7", "7e28f194", "33829071", "ba6991ec", "9a4ca172", "275371d5"];
const REASON = "2026-10-02 竹内さんの決定: 初期費用はカード払いなら分割可（カード手数料として合計金額に3.24%別途）。「一括（お振込）のみ」・分割の回数の目安（6回程が妥当）は会社の事実と食い違うため手本・ナレッジにしない（company-fact-guard credit_card）";
async function main() {
  const r = await sb.from("ai_reply_knowledge").select("id, created_at, hypothesis_status, title, content").or("content.ilike.%一括%,content.ilike.%分割%").limit(2000);
  if (r.error) throw r.error;
  const rows = (r.data ?? []).filter((x) => PREFIXES.some((p) => x.id.startsWith(p)));
  for (const x of rows) console.log(`${x.id} ${x.created_at.slice(0, 10)} ${x.hypothesis_status}｜${x.title}｜${String(x.content).replace(/\n/g, " ").slice(0, 120)}`);
  console.log(`対象 ${rows.length}/${PREFIXES.length}`);
  if (process.env.APPLY !== "1") { console.log("（表示だけ。書く時は APPLY=1）"); return; }
  const u = await sb.from("ai_reply_knowledge").update({ hypothesis_status: "rejected", rejection_reason: REASON }).in("id", rows.map((x) => x.id)).select("id, hypothesis_status");
  if (u.error) throw u.error;
  console.log("却下にした:", (u.data ?? []).map((x) => x.id.slice(0, 8)).join(", "));
}
main().catch((e) => { console.error(e); process.exit(1); });
