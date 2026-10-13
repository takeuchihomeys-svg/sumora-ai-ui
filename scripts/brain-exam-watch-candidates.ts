// scripts/brain-exam-watch-candidates.ts — 見張りで外れた番を、ブレインの試験の問題の候補にする（毎日・LLM なし・本番 DB は読むだけ）
//
// 2026-10-13 竹内さんの承認（見張りの結果をブレインと試験に戻す・その3）。
//   源: line_watch_turns（毎晩 JST 20:40 の line-watch-eval が判定）の直近 --days 日で、道が外れた番（different かつ
//       aix_other・text_but_aix・aix_but_text・text_but_staff_fact・no_reply_needed_but_sent＝app/lib/brain-judge-examples.PATH_MISS_REASONS）
//   外す: テストの会話・申込以降（場面の対象外・申込フォームを送った後）・申込の書類や個人の値を含む番・もう試験に入っている番（同じ会話の6時間以内）
//   分け方:
//     ・自動（--apply で scripts/brain-exam-add.ts --add-batch に渡す）= 正解が「台帳と押した AIX」で決まる番だけ:
//         スタッフが返事のまとまりで AIX を押した番（aix_other＝ブレインは別の AIX／text_but_aix＝ブレインは返信）で、従業員の手打ちが混ざらない番。
//         正解 accept=押した AIX（AIX:<種類>[/<ピッカー>]）・言ってはいけない mustNot=ブレインの道。依頼（asks）は書かない（人が後で足す）
//     ・人が読む候補（--out の JSON の review）= 手打ちの番（aix_but_text・text_but_staff_fact 等）。正解は会話を読んで決める（brain-exam-add --add-batch）
//   1回に足すのは --max（既定5）まで・竹内さんの番を先に
// 毎日の手順（見張りの cron の後・JST 21時以降）:
//   npx tsx --env-file=.env.local scripts/brain-exam-watch-candidates.ts --days=2                 # 見るだけ
//   npx tsx --env-file=.env.local scripts/brain-exam-watch-candidates.ts --days=2 --apply         # 自動の分を問題に足す（spec.json・problems.json を書く）
//   → 足した問題は git の差分で読み、正解が会話と合わなければ spec.json から消す（作り話の正解を入れない）
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { isTestConversation } from "../app/lib/test-conversations";
import { APPLY_FORM_RE } from "../app/lib/customer-sim-shadow";
import { applicationMaterialReason } from "../app/lib/test-pii-guard";
import { PATH_MISS_REASONS } from "../app/lib/brain-judge-examples";
import { maskExamText } from "./lib/brain-exam-mask";
import { SPEC_FILE, type ExamSpec } from "./brain-exam-add";
import { autoAnswerOf } from "./lib/brain-exam-watch";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "2"));
const MAX = Number(arg("max", "5"));
const APPLY = process.argv.includes("--apply");
const OUT = arg("out", "scripts/.replay-out/brain-exam-watch-candidates.json");
const P = (s: string) => Date.parse(s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

type Row = { conversation_id: string; customer_turn_at: string; customer_last_at: string | null; conv_status: string | null; brain_action: string | null; brain_reply_mode: string | null; brain_check_pattern: string | null; scene_key: string | null; verdict: string | null; verdict_detail: Record<string, unknown> | null; staff_aix: Array<{ aix_type: string; check_pattern: string | null; at: string; burst: boolean }> | null; staff_texts: Array<{ at: string; burst: boolean; text: string }> | null };
type Msg = { sender: string; text: string | null; created_at: string; staff_writer?: string | null };

(async () => {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const { data, error } = await sb.from("line_watch_turns").select("conversation_id, customer_turn_at, customer_last_at, conv_status, brain_action, brain_reply_mode, brain_check_pattern, scene_key, verdict, verdict_detail, staff_aix, staff_texts")
    .gte("customer_turn_at", since).eq("verdict", "different").order("customer_turn_at", { ascending: false }).limit(2000);
  if (error) throw new Error(error.message);
  const spec = (existsSync(SPEC_FILE) ? JSON.parse(readFileSync(SPEC_FILE, "utf8")) : []) as ExamSpec[];
  const skip: Record<string, number> = {};
  const sk = (k: string) => { skip[k] = (skip[k] ?? 0) + 1; };
  const auto: Array<Omit<ExamSpec, "id"> & { _writer: string }> = [];
  const review: Array<Record<string, unknown>> = [];
  for (const r of (data ?? []) as Row[]) {
    const reason = String(r.verdict_detail?.reason ?? "");
    if (!PATH_MISS_REASONS.has(reason)) { sk("道の外れでない"); continue; }
    if (isTestConversation(r.conversation_id)) { sk("テスト会話"); continue; }
    if (String(r.scene_key ?? "").startsWith("対象外")) { sk("申込以降"); continue; }
    const custLast = r.customer_last_at ?? r.customer_turn_at;
    if (spec.some((s) => s.conv === r.conversation_id && Math.abs(P(s.at) - P(custLast)) < 6 * 3600_000)) { sk("もう入っている"); continue; }
    const { data: mm } = await sb.from("messages").select("sender, text, created_at, staff_writer").eq("conversation_id", r.conversation_id).lte("created_at", new Date(P(custLast) + 3 * 3600_000).toISOString()).order("created_at", { ascending: false }).limit(60);
    const msgs = ((mm ?? []) as Msg[]).reverse();
    const before = msgs.filter((m) => P(m.created_at) <= P(custLast));
    if (before.some((m) => m.sender !== "customer" && APPLY_FORM_RE.test(m.text ?? ""))) { sk("申込以降（申込フォームの後）"); continue; }
    const cust = before.filter((m) => m.sender === "customer" && P(m.created_at) >= P(r.customer_turn_at));
    const burst = (r.staff_texts ?? []).filter((x) => x.burst).map((x) => x.text);
    if ([...cust.map((m) => m.text ?? ""), ...burst].some((t) => applicationMaterialReason(t))) { sk("申込の書類・個人の値"); continue; }
    const after = msgs.filter((m) => P(m.created_at) > P(custLast) && m.sender !== "customer");
    const writers = new Set(after.map((m) => m.staff_writer).filter(Boolean));
    const writer = writers.has("employee") ? "employee" : writers.has("takeuchi") ? "takeuchi" : String(r.verdict_detail?.staff_writer ?? "unknown");
    const brain = r.brain_reply_mode === "aix" ? `AIX:${r.brain_action ?? "?"}${r.brain_check_pattern ? `/${r.brain_check_pattern}` : ""}` : "返信";
    const ans = writer === "employee" ? null : autoAnswerOf(r);
    const base = {
      conv: r.conversation_id, at: cust[cust.length - 1]?.created_at ?? custLast, reason, brain, writer,
      customer: oneLine(maskExamText(cust.map((m) => m.text ?? "").join("\n"), null)).slice(0, 200),
      staff: oneLine(maskExamText(burst.join("\n―\n"), null)).slice(0, 300),
      pressed: (r.staff_aix ?? []).map((p) => `${p.aix_type}${p.check_pattern ? `/${p.check_pattern}` : ""}${p.burst ? "" : "(後)"}`),
    };
    if (ans) {
      auto.push({
        conv: base.conv, at: base.at, type: ans.type, tags: ["見張り"], accept: ans.accept, mustNot: ans.mustNot,
        source: `見張り（line_watch_turns ${reason}・ブレイン ${brain} → スタッフは返事のまとまりで ${base.pressed.join(",")}）`,
        why: `見張りの道の外れ（${reason}）。スタッフ（${writer === "takeuchi" ? "竹内さん" : "書き手不明"}）が返事のまとまりで AIX【${ans.accept[0].slice(4)}】を押した＝正解は押した AIX（台帳と押下で決まる・自動で足した・依頼の要点は未記入）`,
        addedBy: "brain-exam-watch-candidates（自動）", _writer: writer,
      });
    } else review.push({ ...base, note: "正解は会話を読んで決める（手打ち・従業員・2種類以上の押下）" });
  }
  auto.sort((a, b) => (a._writer === "takeuchi" ? 0 : 1) - (b._writer === "takeuchi" ? 0 : 1) || P(b.at) - P(a.at));
  const pick = auto.slice(0, MAX);
  console.log(`# 見張りの外れ → 試験の候補（直近 ${DAYS}日・different ${(data ?? []).length}）`);
  console.log(`外した: ${Object.entries(skip).map(([k, v]) => `${k} ${v}`).join("・") || "0"}`);
  console.log(`自動で足せる ${auto.length}（今回 ${pick.length}）・人が読む候補 ${review.length}`);
  for (const a of pick) console.log(`  [自動] ${a.conv.slice(0, 8)} ${a.at.slice(0, 16)} ${a.type} 正解=${a.accept.join("|")} 言ってはいけない=${(a.mustNot ?? []).join("|")}（${a._writer}）`);
  for (const v of review.slice(0, 15)) console.log(`  [読む] ${String(v.conv).slice(0, 8)} ${String(v.at).slice(0, 16)} ${v.reason} ブレイン=${v.brain} 押下=${(v.pressed as string[]).join(",") || "-"}\n         客「${String(v.customer).slice(0, 90)}」\n         人「${String(v.staff).slice(0, 110)}」`);
  writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), days: DAYS, auto: pick.map(({ _writer, ...x }) => x), review }, null, 1));
  console.log(`\n書いた: ${OUT}`);
  if (!APPLY) { console.log("（--apply で自動の分を brain-exam-add --add-batch に渡す）"); return; }
  if (!pick.length) return;
  const batch = OUT.replace(/\.json$/, "-batch.json");
  writeFileSync(batch, JSON.stringify(pick.map(({ _writer, ...x }) => x), null, 1));
  execSync(`npx tsx --env-file=.env.local scripts/brain-exam-add.ts --add-batch="${batch}"`, { stdio: "inherit" });
})().catch((e) => { console.error(e); process.exit(1); });
