// 場面 S2（物件送付・オススメ後の反応: 費用の質問・写真の依頼・条件変更）の純関数を今月全件に当てる（読み取りのみ）
//
// 2026-09-23 竹内「学んだことを活かして、実際の成約データや直近の今月のLINEをお手本にして
//   生成される文にギャップが生まれないか確認する」
//
// ① 費用の質問（こちらの物件カード／新着オススメの直後）: ブレインの判断 vs スタッフが実際に押した AIX（24時間以内）
//    → 設計知見「費用を聞かれても先に募集状況の確認を報告してから見積書」が **この場面** に当てはまるか
// ② 物件オススメ（AIX property_recommendation）の申込の一文: apply-line-rates.detectRecommendApplyLine を今月の下書き・実送信に
// ③ 写真の依頼: company-facts.matchCompanyFacts(room_photo) が今月のお客様の発言に当たる数と、実送信の答え方
// ④ S2 の下書き・実送信に rent-negotiation-guard.isRentNegotiationPromise が当たる数（誤削除0の再確認）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-s2-scene-gap.ts [SINCE=2026-09-01]
import { createClient } from "@supabase/supabase-js";
import { detectRecommendApplyLine } from "../app/lib/apply-line-rates";
import { matchCompanyFacts } from "../app/lib/company-facts";
import { isRentNegotiationPromise } from "../app/lib/rent-negotiation-guard";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const SINCE = process.env.SINCE ?? "2026-09-01T00:00:00+09:00";
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const mask = (s: string) => s.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,8}(?:さん|様|さま)/g, "〈お客様〉").replace(/https?:\/\/\S+/g, "〈URL〉").replace(/\d{2,4}-\d{2,4}-\d{3,4}/g, "〈電話〉");
const MARK = /^\s*(\[AIX誘導中\]|__SHOWN__|\[返信不要\])\s*$/;
type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };

async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  console.log(`=== S2 の純関数を今月全件に当てる（${SINCE}〜・読み取りのみ）===\n`);
  const msgs = await all<Msg>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", SINCE).neq("conversation_id", YUMA).order("created_at").range(a, b));
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { const l = byConv.get(m.conversation_id) ?? []; l.push(m); byConv.set(m.conversation_id, l); }
  const aix = await all<{ conversation_id: string; aix_type: string; check_pattern: string | null; created_at: string }>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", SINCE).order("created_at").range(a, b));
  const brains = await all<{ conversation_id: string; suggested_action: string | null; suggested_reply_mode: string | null; created_at: string; analyzed_msg_ts: string | null }>((a, b) => sb.from("brain_decision_logs").select("conversation_id, suggested_action, suggested_reply_mode, created_at, analyzed_msg_ts").gte("created_at", SINCE).order("created_at").range(a, b));
  const OUR_CARD = /(🌟|オススメ(出来|でき)る(お部屋|新着)|新着で)/;

  // ── ① 費用の質問（こちらの物件カードの直後）──
  console.log(`① 費用の質問（直前のこちらの送信が物件カード／新着オススメ・3日以内）`);
  type Case = { m: Msg; prev: Msg; brain: string | null; first: string | null; seq: string[] };
  const cases: Case[] = [];
  const COST = /(初期費用|費用.{0,6}(いくら|どれ|教え|知りたい|出し)|見積)/;
  for (const [cid, list] of byConv) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "customer" || !m.text || /^\[画像\]/.test(m.text) || m.text.length >= 200 || !COST.test(m.text)) continue;
      const prev = [...list.slice(0, i)].reverse().find((x) => x.sender === "staff");
      if (!prev || !OUR_CARD.test(prev.text ?? "") || Date.parse(m.created_at) - Date.parse(prev.created_at) > 3 * 86400_000) continue;
      const t = Date.parse(m.created_at);
      const seq = aix.filter((a) => a.conversation_id === cid && Date.parse(a.created_at) >= t && Date.parse(a.created_at) <= t + 24 * 3600_000).map((a) => a.aix_type + (a.check_pattern ? `/${a.check_pattern}` : ""));
      const brain = brains.find((b) => b.conversation_id === cid && Date.parse(b.created_at) >= t && Date.parse(b.created_at) <= t + 2 * 3600_000)?.suggested_action ?? null;
      cases.push({ m, prev, brain, first: seq[0] ?? null, seq });
    }
  }
  const firstKind = (c: Case) => (c.first ?? "なし").split("/")[0];
  const cnt = (f: (c: Case) => boolean) => cases.filter(f).length;
  console.log(`   n=${cases.length}`);
  console.log(`   スタッフが最初に押した AIX: 見積書 ${pct(cnt((c) => firstKind(c) === "estimate_sheet"), cases.length)} ／ 物件確認した ${pct(cnt((c) => firstKind(c) === "property_check_result"), cases.length)} ／ その他 ${pct(cnt((c) => !["estimate_sheet", "property_check_result", "なし"].includes(firstKind(c))), cases.length)} ／ 24時間以内なし ${pct(cnt((c) => firstKind(c) === "なし"), cases.length)}`);
  const withBrain = cases.filter((c) => c.brain !== null);
  console.log(`   ブレインの判断（記録あり ${withBrain.length}件）: ${Object.entries(withBrain.reduce((acc, c) => { acc[c.brain ?? ""] = (acc[c.brain ?? ""] ?? 0) + 1; return acc; }, {} as Record<string, number>)).map(([k, v]) => `${k || "(空)"} ${v}`).join(" ／ ")}`);
  console.log(`   ブレイン＝最初に押した AIX の一致: ${pct(withBrain.filter((c) => c.brain === firstKind(c)).length, withBrain.length)}`);
  console.log(`   実物（新→古・10件）:`);
  for (const c of cases.slice(-10).reverse()) {
    console.log(`   ── [${c.m.created_at.slice(5, 16)}] 客「${mask(c.m.text ?? "").replace(/\n/g, " ").slice(0, 44)}」 ブレイン=${c.brain ?? "-"} → 押した: ${c.seq.slice(0, 3).join(",") || "なし"}`);
  }

  // ── ② 物件オススメの申込の一文（今月）──
  console.log(`\n② AIX【物件オススメ】の申込の一文（今月・下書きと実送信が両方ある）`);
  type Ex = { id: string; conversation_id: string | null; aix_action: string | null; ai_draft: string | null; sent_reply: string | null; created_at: string; customer_message: string | null };
  const recs = (await all<Ex>((a, b) => sb.from("ai_reply_examples").select("id, conversation_id, aix_action, ai_draft, sent_reply, created_at, customer_message").like("aix_action", "property_recommendation%").gte("created_at", SINCE).order("created_at").range(a, b)))
    .filter((r) => (r.ai_draft ?? "").trim() && (r.sent_reply ?? "").trim() && !MARK.test(r.ai_draft ?? ""));
  const kindOf = (t: string | null) => detectRecommendApplyLine(t).kind;
  const line = (label: string, k: string) => {
    const ai = recs.filter((r) => kindOf(r.ai_draft) === k).length, sent = recs.filter((r) => kindOf(r.sent_reply) === k).length;
    const removed = recs.filter((r) => kindOf(r.ai_draft) === k && kindOf(r.sent_reply) !== k).length;
    console.log(`   ${label.padEnd(14)} AI ${pct(ai, recs.length).padStart(6)}（${ai}件・消 ${removed}） ／ 実送信 ${pct(sent, recs.length).padStart(6)}（${sent}件）`);
  };
  console.log(`   n=${recs.length}（線: 実送信 4.8〜6.0%）`);
  line("two_weeks", "two_weeks"); line("apply_cta", "apply_cta"); line("apply_status", "apply_status");
  const cut = Date.parse("2026-09-23T00:00:00+09:00");
  const late = recs.filter((r) => Date.parse(r.created_at) >= cut);
  console.log(`   今日（9/23 JST）以降の対: ${late.length}件 → apply_cta AI ${late.filter((r) => kindOf(r.ai_draft) === "apply_cta").length}・実送信 ${late.filter((r) => kindOf(r.sent_reply) === "apply_cta").length}・two_weeks AI ${late.filter((r) => kindOf(r.ai_draft) === "two_weeks").length}`);
  console.log(`   AI が書いた申込の一文（実物・5件）:`);
  for (const r of recs.filter((r) => kindOf(r.ai_draft) === "apply_cta" || kindOf(r.ai_draft) === "two_weeks").slice(-5)) {
    const d = detectRecommendApplyLine(r.ai_draft);
    console.log(`   ── [${r.created_at.slice(5, 16)}] ${d.kind}: ${mask(d.sentence ?? "").slice(0, 90)} ／ 実送信に残った=${kindOf(r.sent_reply) === d.kind ? "はい" : "いいえ"}`);
  }

  // ── ③ 写真の依頼 ──
  console.log(`\n③ 写真の依頼（company-facts room_photo が当たる今月のお客様の発言）`);
  const photo = msgs.filter((m) => m.sender === "customer" && m.text && matchCompanyFacts(m.text).some((f) => f.id === "room_photo"));
  console.log(`   当たり ${photo.length}通`);
  const FORBID = /(ご用意(出来|でき)ていない|写真が(無|な)い|写真はございません|画像が(無|な)い)/;
  let answered = 0, forbid = 0;
  for (const m of photo) {
    const list = byConv.get(m.conversation_id) ?? [];
    const nexts = list.filter((x) => x.sender === "staff" && Date.parse(x.created_at) > Date.parse(m.created_at) && Date.parse(x.created_at) <= Date.parse(m.created_at) + 24 * 3600_000).slice(0, 4);
    const joined = nexts.map((x) => x.text ?? "").join("\n");
    const t = Date.parse(m.created_at);
    const pressed = aix.filter((a) => a.conversation_id === m.conversation_id && Date.parse(a.created_at) >= t && Date.parse(a.created_at) <= t + 24 * 3600_000).map((a) => a.aix_type + (a.check_pattern ? `/${a.check_pattern}` : "")).slice(0, 3);
    const ans = /(室内イメージ|室内の(写真|画像|イメージ)|https?:\/\/|\[画像\]|撮影|お送り(させて|いたし|致し))/.test(joined);
    if (ans) answered++; if (FORBID.test(joined)) forbid++;
    console.log(`   ── [${m.created_at.slice(5, 16)}] 客「${mask(m.text ?? "").replace(/\n/g, " ").slice(0, 40)}」 → 押した: ${pressed.join(",") || "なし"} ／ 次の送信: ${mask(joined).replace(/\n/g, " / ").slice(0, 80)}`);
  }
  console.log(`   実送信で写真・イメージを渡した ${pct(answered, photo.length)} ／ 「写真が無い」と断定 ${forbid}通`);

  // ── ④ 家賃交渉の予告（S2 の下書き・実送信）──
  console.log(`\n④ 家賃交渉の予告（isRentNegotiationPromise）— 今月の通常返信の下書き・実送信・スタッフ送信`);
  const plain = await all<Ex>((a, b) => sb.from("ai_reply_examples").select("id, conversation_id, aix_action, ai_draft, sent_reply, created_at, customer_message").gte("created_at", SINCE).is("aix_action", null).order("created_at").range(a, b));
  const split = (t: string | null) => (t ?? "").split(/(?<=[。！!？?\n])(?![。！!])/).map((s) => s.trim()).filter(Boolean);
  const hitD = plain.filter((r) => split(r.ai_draft).some(isRentNegotiationPromise));
  const hitS = plain.filter((r) => split(r.sent_reply).some(isRentNegotiationPromise));
  const staffAll = msgs.filter((m) => m.sender === "staff" && m.text);
  const hitStaff = staffAll.filter((m) => split(m.text).some(isRentNegotiationPromise));
  console.log(`   下書き ${hitD.length}/${plain.length} ／ 実送信（例文） ${hitS.length}/${plain.length} ／ スタッフ送信（messages） ${hitStaff.length}/${staffAll.length}`);
  for (const r of hitD.slice(0, 5)) console.log(`   ── 下書き [${r.created_at.slice(5, 16)}]: ${mask(split(r.ai_draft).find(isRentNegotiationPromise) ?? "")}`);
  for (const m of hitStaff.slice(0, 5)) console.log(`   ── ⚠ スタッフ送信 [${m.created_at.slice(5, 16)}]: ${mask(split(m.text).find(isRentNegotiationPromise) ?? "")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
