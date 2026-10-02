// scripts/audit-overfire-three.ts — 最終チェックの3つの規則が人の文（スタッフの実送信）を止めていないか（読み取りのみ・LLM なし）
//
// 2026-10-02 竹内さんの指示「誤発火の3つ（FAREWELL_ON_MOVEOUT_INFO・DUPLICATE_OF_SENT・条件フォームの SENSITIVE_CASE）を実送信で線を引き直す」
//   本番の会話（messages・YUMA を除く）を順に読み、スタッフが手で送った返事ごとに「その直前のお客様の発言（連投をまとめた物）」と
//   「その前のこちらの送信3通」で本番と同じ判定を当てる。人の文に当たったら＝その場面の正しい返事を止める（誤発火）。
//   あわせて AI の下書き（ai_reply_examples.ai_draft）にも当て、規則が止めたい AI の形を新しい線でも止めているかを数える。
//   ① FAREWELL_ON_MOVEOUT_INFO … classifyMoveOutSubject(お客様)=current_home かつ 本文に会話を終える語
//   ② DUPLICATE_OF_SENT          … findNearDuplicateSent(本文, こちらの直近3通)
//   ③ SENSITIVE_CASE             … detectSensitiveCase(お客様)（条件フォーム isConditionFormMessage を別に数える）
// 実行: npx tsx --env-file=.env.local scripts/audit-overfire-three.ts [--days=365] [--detail]
import { createClient } from "@supabase/supabase-js";
import { classifyMoveOutSubject } from "../app/lib/move-out-context";
import { findNearDuplicateSent } from "../app/lib/closed-ack";
import { detectSensitiveCase, SENSITIVE_REJECT_RE, SENSITIVE_CANCEL_RE } from "../app/lib/sensitive-case";
import { isConditionFormMessage } from "../app/lib/line-reply-prompts";
import { farewellOnMoveOutHit, duplicateOfSentApplies } from "../app/lib/final-check-overfire";
/** 2026-10-02 以前の SENSITIVE_CASE（否決の仮定・物件1件をやめるも当てていた） */
const oldSensitive = (t: string) => detectSensitiveCase(t) === "クレーム" ? "クレーム" : SENSITIVE_REJECT_RE.test(t) ? "審査否決" : SENSITIVE_CANCEL_RE.test(t) ? "キャンセル・リスケ" : null;

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=365").split("=")[1]);
const DETAIL = process.argv.includes("--detail");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const MEDIA_RE = /^\s*\[(?:画像|動画|スタンプ|ファイル)\]\s*$/;
const FAREWELL_RE = /またお部屋探しの際は|この度はありがとうございました|ご縁があり|またのご縁|またの機会|お気をつけて|お元気で/;
const one = (s: string, n = 90) => String(s ?? "").replace(/\s*\n\s*/g, " / ").slice(0, n);

type M = { conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const msgs: M[] = [];
  for (let p = 0; p < 200; p++) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.log(error.message); break; }
    msgs.push(...((data ?? []) as M[])); if ((data ?? []).length < 1000) break;
  }
  const byConv = new Map<string, M[]>();
  for (const m of msgs) { if (m.conversation_id === YUMA) continue; if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []); byConv.get(m.conversation_id)!.push(m); }
  type Turn = { conv: string; at: string; cust: string; staff: string; prevStaff: string[] };
  const turns: Turn[] = [];
  for (const [conv, ms] of byConv) {
    let burst: string[] = []; const staffHist: string[] = []; let lastWasStaff = true;
    for (const m of ms) {
      const t = String(m.text ?? "");
      if (m.sender === "customer") { if (lastWasStaff) burst = []; burst.push(t); lastWasStaff = false; continue; }
      if (m.sender !== "staff") continue;
      if (!lastWasStaff && burst.length && !m.is_aix_generated && t.trim() && !MEDIA_RE.test(t)) {
        turns.push({ conv, at: m.created_at, cust: burst.join("\n⁣\n"), staff: t, prevStaff: staffHist.filter((x) => !MEDIA_RE.test(x)).slice(-3) });
      }
      staffHist.push(t); lastWasStaff = true;
    }
  }
  console.log(`=== 材料: お客様の番に続くスタッフの手打ちの返事 ${turns.length}通（${DAYS}日・${byConv.size}会話・YUMA を除く）===`);

  // ① FAREWELL
  const f1Old = turns.filter((t) => classifyMoveOutSubject(t.cust) === "current_home" && FAREWELL_RE.test(t.staff));
  const f1New = turns.filter((t) => farewellOnMoveOutHit(t.cust, t.staff));
  console.log(`\n① FAREWELL_ON_MOVEOUT_INFO（人の文に当たる＝誤発火）: 旧 ${f1Old.length}通 → 新 ${f1New.length}通`);
  for (const t of f1Old) console.log(`   ${f1New.includes(t) ? "残" : "外"} 客「${one(t.cust, 70)}」→ 実「${one(t.staff, 80)}」`);
  // ② DUPLICATE
  const d2Old = turns.filter((t) => findNearDuplicateSent(t.staff, t.prevStaff).dup);
  const d2New = d2Old.filter((t) => duplicateOfSentApplies(t.cust));
  console.log(`\n② DUPLICATE_OF_SENT（人がほぼ同じ文をもう一度送った）: 旧 ${d2Old.length}通 → 新 ${d2New.length}通`);
  for (const t of d2Old.slice(0, DETAIL ? 999 : 40)) console.log(`   ${d2New.includes(t) ? "残" : "外"} 客「${one(t.cust, 60)}」→ 実「${one(t.staff, 70)}」（前「${one(findNearDuplicateSent(t.staff, t.prevStaff).matched ?? "", 50)}」）`);
  // ③ SENSITIVE
  const s3Old = turns.filter((t) => oldSensitive(t.cust));
  const s3New = turns.filter((t) => detectSensitiveCase(t.cust));
  const forms = s3Old.filter((t) => isConditionFormMessage(t.cust));
  console.log(`\n③ SENSITIVE_CASE（お客様の発言に当たる＝その番の下書きは全部 block）: 旧 ${s3Old.length}通（うち条件フォーム ${forms.length}）→ 新 ${s3New.length}通`);
  for (const t of s3Old) console.log(`   ${s3New.includes(t) ? "残" : "外"} [${oldSensitive(t.cust)}${isConditionFormMessage(t.cust) ? "・条件フォーム" : ""}] 客「${one(t.cust, 100)}」`);

  // AI の下書き（規則が止めたい形）に新しい線を当てる
  const ex: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let p = 0; p < 30; p++) {
    const { data } = await sb.from("ai_reply_examples").select("conversation_id, created_at, ai_draft, customer_message").gte("created_at", since).not("ai_draft", "is", null).order("created_at").range(p * 1000, p * 1000 + 999);
    ex.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  let aiF1Old = 0, aiF1New = 0, aiD2Old = 0, aiD2New = 0;
  const aiF1: string[] = [], aiD2: string[] = [];
  for (const e of ex) {
    if (e.conversation_id === YUMA) continue;
    const d = String(e.ai_draft ?? ""), c = String(e.customer_message ?? "");
    if (!d.trim() || !c.trim()) continue;
    if (classifyMoveOutSubject(c) === "current_home" && FAREWELL_RE.test(d)) { aiF1Old++; if (farewellOnMoveOutHit(c, d)) { aiF1New++; aiF1.push(`客「${one(c, 60)}」案「${one(d, 70)}」`); } else aiF1.push(`外 客「${one(c, 60)}」案「${one(d, 70)}」`); }
    // こちらの直近3通は「この下書きに対応するお客様の発言」より前の物（例の行は送った後に作られるので、送った文そのものを含めない）
    const cm = byConv.get(String(e.conversation_id)) ?? [];
    const lastCust = [...cm].filter((m) => m.sender === "customer" && m.created_at < e.created_at).pop();
    if (!lastCust) continue;
    const prev = cm.filter((m) => m.sender === "staff" && m.created_at < lastCust.created_at && !MEDIA_RE.test(String(m.text ?? ""))).slice(-3).map((m) => String(m.text ?? ""));
    if (findNearDuplicateSent(d, prev).dup) { aiD2Old++; if (duplicateOfSentApplies(c)) aiD2New++; aiD2.push(`${duplicateOfSentApplies(c) ? "残" : "外"} 客「${one(c, 50)}」案「${one(d, 60)}」`); }
  }
  console.log(`\n=== AI の下書き（送った例の ai_draft ${ex.length}件）に当てる ===`);
  console.log(`   ① FAREWELL: 旧 ${aiF1Old} → 新 ${aiF1New}`); for (const x of aiF1) console.log(`     ${x}`);
  console.log(`   ② DUPLICATE: 旧 ${aiD2Old} → 新 ${aiD2New}`); for (const x of aiD2.slice(0, DETAIL ? 999 : 30)) console.log(`     ${x}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
