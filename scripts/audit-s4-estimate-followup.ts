// 場面 S4「見積書後の反応」（了承・並行の依頼・条件の再確認）の実測（読み取りのみ・DB は書かない）
//
// 2026-09-23 竹内「実際の成約データや直近の今月のLINEをお手本にして 生成される文にギャップが生まれないか確認する」
//
// 【S4 の定義】お客様の発言の直前のスタッフ送信が「御見積書」の同封（AIX【見積書】相当）である発言。
//   その発言に対するスタッフの次の返信（実送信）と、同じ発言に対する AI の下書き（ai_reply_examples）を並べる。
//
// 【数える物】（設計知見の型③「実送信で線を引く」・⑦「全件監査は目で読む」）
//   1) 申込導線（APPLY_CTA）の率  2) 行の役割（受け・お礼・報告・次工程・締め）  3) 約束の宣言の種類
//   4) 長さ（字数・行数・空行）  5) 禁止語  6) 会社の事実の当たり  7) 家賃交渉の予告  8) 総額の断言
//   9) 3時間以内にスタッフが押した AIX（aix_usage_logs）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-s4-estimate-followup.ts [MONTH=2026-09] [SHOW=12]
import { createClient } from "@supabase/supabase-js";
import { classifySentKind, customerSceneOf } from "../app/lib/sent-shape";
import { detectRecommendApplyLine } from "../app/lib/apply-line-rates";
import { isRentNegotiationPromise } from "../app/lib/rent-negotiation-guard";
import { matchCompanyFacts } from "../app/lib/company-facts";
import { isShortAckOnly } from "../app/lib/previous-send-note";
import { isConditionFormMessage } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const MONTH = process.env.MONTH ?? "2026-09";
const SHOW = Number(process.env.SHOW ?? 12);
const since = `${MONTH}-01T00:00:00+09:00`;
const WON_STATUSES = new Set(["closed_won", "applying", "screening", "application", "contract", "approved"]);
const MARK = /^\s*(\[AIX誘導中\]|__SHOWN__|\[返信不要\])\s*$/;
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "  —  ");

/** 本名・電話・URL を伏せる */
function maskWith(names: string[]) {
  return (s: string) => {
    let t = s;
    for (const n of names) if (n && n.length >= 2) t = t.split(n).join("〈お客様〉");
    return t.replace(/[ぁ-んァ-ヶー一-龥A-Za-z]{1,8}(?:さん|様|さま)/g, "〈お客様〉").replace(/\d{2,4}-\d{2,4}-\d{3,4}/g, "〈電話〉").replace(/https?:\/\/\S+/g, "〈URL〉");
  };
}

// ── 判定（正規表現は一次分類。❌ は本文を読んで確定する） ─────────────────────
const ESTIMATE_SENT_RE = /御見積書|お見積書|見積書(?:同封|お送り|を作成|作成)/;
const APPLY_CTA = /お気に召され[^\n]{0,24}お?申込|お?申込(?:み)?(?:で|し|して)?[^\n]{0,12}(?:抑え|押さえ|確保)|お申込(?:み)?(?:是非|ぜひ|いかが|ご検討|も可能|でお部屋)|お申込(?:み)?から(?:審査|最短)|申込(?:後|から)最短|お申込(?:み)?手続き|申込(?:み)?(?:の)?(?:ご)?希望|申込(?:み)?(?:を)?(?:させて|進め)/;
const APPLY_ANY = /お申込|申込/;
const VIEW_CTA = /ご案内(?:させて(?:頂|いただ)き|いたし|致し)|ご内覧|内覧(?:日程|のご|も可能|可能)|ご都合[^\n]{0,12}(?:お日にち|日程)/;
const PARALLEL_RE = /並行|同時に|も抑え|も押さえ|も審査|も申込/;
const ROLE = {
  受け: /^(?:かしこまりました|はい|承知|了解|ありがとうございます)/m,
  お礼: /ありがとうございます|ご返信(?:頂|いただ)き/,
  報告答え: /となります|でございます|のみとなり|可能です|不可|出来ます|できます|です[！!。]/,
  次工程宣言: /(?:確認|審査|ご案内|お送り|ピックアップ|作成|申込|抑え|押さえ|調整)(?:させて(?:頂|いただ)き|いたし|致し|し)ます/,
  締め: /何卒|ご査収|お気軽に|ご確認ください|お待ちしております/,
};
const FORBIDDEN: Array<[string, RegExp]> = [
  ["お待たせ致しました", /お待たせ(?:致|いた)?しました/],
  ["全力サポート", /全力(?:で)?サポート/],
  ["いつでもお気軽に", /いつでもお気軽に/],
  ["作業メモ", /への返信です|^#+ |^---+$|<<<[A-Z_]{3,}:/m],
];
/** 総額の断言（本文で合計金額を言い切る）。見積書後は「見積書を送り直す」が型 */
const TOTAL_CLAIM_RE = /(?:総額|合計|お支払い?(?:総額|合計)?|初期費用)[^\n]{0,10}(?:は|が|で)?[^\n]{0,6}[0-9０-９,，]{2,}(?:万)?円/;
const PROMISE_RE = /(?:[^\n。！!]{0,30}?(?:確認|交渉|お送り|ご案内|ピックアップ|作成|審査|申込|抑え|押さえ|調整|お伝え|ご連絡)(?:させて(?:頂|いただ)き|いたし|致し|し|かけさせて(?:頂|いただ)き)ます[^\n。！!]{0,6})/g;

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null };
type Ex = { id: string; conversation_id: string | null; customer_message: string | null; sent_reply: string | null; ai_draft: string | null; was_ai_used: boolean | null; aix_action: string | null; created_at: string; sent_at: string | null; reply_context_snapshot: Record<string, unknown> | null };

async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

export type S4Case = {
  convId: string; customerName: string; status: string; won: boolean;
  estimateMsg: Msg; customerMsg: Msg; customerBurst: Msg[]; staffReply: Msg | null;
  replyMinutes: number | null;
  aixWithin3h: Array<{ aix_type: string; check_pattern: string | null; at: string }>;
  example: Ex | null;
};

function textStats(t: string) {
  const lines = t.replace(/\r/g, "").split("\n");
  const nonEmpty = lines.filter((l) => l.trim());
  const blanks = lines.length - nonEmpty.length;
  return { chars: t.replace(/\s/g, "").length, lines: nonEmpty.length, hasBlank: nonEmpty.length >= 2 && blanks > 0 };
}
function median(xs: number[]) { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; }

export async function collectS4(): Promise<S4Case[]> {
  // 今月のスタッフ送信で御見積書を同封した通
  const estimateMsgs = await all<Msg>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, image_url, created_at, is_aix_generated")
    .eq("sender", "staff").gte("created_at", since).or("text.ilike.%御見積書%,text.ilike.%お見積書%,text.ilike.%見積書同封%").order("created_at", { ascending: true }).range(a, b));
  const convIds = [...new Set(estimateMsgs.map((m) => m.conversation_id))];
  const convOf = new Map<string, { customer_name: string; status: string; is_post_apply: boolean | null }>();
  for (let i = 0; i < convIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, customer_name, status, is_post_apply").in("id", convIds.slice(i, i + 200));
    for (const c of (data ?? []) as Array<{ id: string; customer_name: string; status: string; is_post_apply: boolean | null }>) convOf.set(c.id, c);
  }
  const out: S4Case[] = [];
  for (const conv of convIds) {
    const c = convOf.get(conv); if (!c) continue;
    if (conv === "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7") continue; // YUMA は除く
    const { data: ms } = await sb.from("messages").select("id, conversation_id, sender, text, image_url, created_at, is_aix_generated")
      .eq("conversation_id", conv).gte("created_at", `${MONTH}-01T00:00:00+09:00`).order("created_at", { ascending: true }).limit(1000);
    const msgs = (ms ?? []) as Msg[];
    const { data: ax } = await sb.from("aix_usage_logs").select("aix_type, check_pattern, created_at, sent_at").eq("conversation_id", conv).gte("created_at", since);
    const aix = ((ax ?? []) as Array<{ aix_type: string; check_pattern: string | null; created_at: string; sent_at: string | null }>).map((r) => ({ aix_type: r.aix_type, check_pattern: r.check_pattern, at: r.sent_at ?? r.created_at }));
    const { data: exs } = await sb.from("ai_reply_examples").select("id, conversation_id, customer_message, sent_reply, ai_draft, was_ai_used, aix_action, created_at, sent_at, reply_context_snapshot").eq("conversation_id", conv).gte("created_at", since);
    const examples = (exs ?? []) as Ex[];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.sender !== "staff" || !ESTIMATE_SENT_RE.test(m.text ?? "")) continue;
      // 直後のお客様の発言（間にスタッフ送信が無い）
      let j = i + 1;
      while (j < msgs.length && msgs[j].sender === "staff") j++;
      if (j >= msgs.length) continue;
      // 見積書の直後ではなく別のスタッフ送信が挟まったら S4 ではない
      if (msgs.slice(i + 1, j).some((x) => x.sender === "staff")) continue;
      const cust = msgs[j];
      if (cust.sender !== "customer") continue;
      // 同じ人の連投（15分以内）をまとめる
      const burst: Msg[] = [cust];
      let k = j + 1;
      while (k < msgs.length && msgs[k].sender === "customer" && Date.parse(msgs[k].created_at) - Date.parse(burst[burst.length - 1].created_at) < 15 * 60_000) { burst.push(msgs[k]); k++; }
      const staffReply = msgs.slice(k).find((x) => x.sender === "staff") ?? null;
      const custAt = Date.parse(burst[burst.length - 1].created_at);
      const replyMinutes = staffReply ? Math.round((Date.parse(staffReply.created_at) - custAt) / 60_000) : null;
      const aixWithin3h = aix.filter((r) => { const t = Date.parse(r.at); return t >= custAt && t - custAt <= 3 * 3600_000; });
      const custText = burst.map((b) => b.text ?? "").join("\n").trim();
      const example = examples.find((e) => (e.customer_message ?? "").trim() && custText.includes((e.customer_message ?? "").trim().slice(0, 30)) && Math.abs(Date.parse(e.created_at) - custAt) < 3 * 86400_000) ?? null;
      out.push({ convId: conv, customerName: c.customer_name, status: c.status, won: WON_STATUSES.has(c.status) || !!c.is_post_apply, estimateMsg: m, customerMsg: cust, customerBurst: burst, staffReply, replyMinutes, aixWithin3h, example });
    }
  }
  return out;
}

async function main() {
  console.log(`=== S4 見積書後の反応（${MONTH}・読み取りのみ）===\n`);
  const cases = await collectS4();
  const won = cases.filter((c) => c.won);
  console.log(`S4 の発言: ${cases.length}件（会話 ${new Set(cases.map((c) => c.convId)).size}）／ 成約側 ${won.length}件（会話 ${new Set(won.map((c) => c.convId)).size}）`);
  const withReply = cases.filter((c) => c.staffReply);
  const withExample = cases.filter((c) => c.example && (c.example.ai_draft ?? "").trim() && !MARK.test(c.example.ai_draft ?? ""));
  console.log(`スタッフの返信あり ${withReply.length} ／ AI 下書きが残っている ${withExample.length}（was_ai_used ${withExample.filter((c) => c.example?.was_ai_used).length}）\n`);

  // ── お客様の発言の種類 ──
  const deps = { isConditionForm: isConditionFormMessage, isShortAck: isShortAckOnly };
  const custKind = (c: S4Case) => {
    const t = c.customerBurst.map((b) => b.text ?? "").join("\n");
    if (PARALLEL_RE.test(t)) return "並行の依頼";
    if (/申込|申し込|進め|お願いします|抑え|押さえ/.test(t) && !/[?？]/.test(t)) return "申込・進めて";
    return customerSceneOf(t, deps);
  };
  const kinds = new Map<string, number>();
  for (const c of cases) kinds.set(custKind(c), (kinds.get(custKind(c)) ?? 0) + 1);
  console.log(`--- お客様の発言の種類 ---`);
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(12)} ${String(n).padStart(3)}  成約側 ${won.filter((c) => custKind(c) === k).length}`);

  // ── 実送信の形 ──
  const shape = (label: string, list: S4Case[], pick: (c: S4Case) => string | null) => {
    const texts = list.map(pick).filter((t): t is string => !!t && !MARK.test(t));
    const n = texts.length; if (!n) { console.log(`   ${label}: n=0`); return; }
    const cnt = (re: RegExp) => texts.filter((t) => re.test(t)).length;
    const st = texts.map(textStats);
    console.log(`   ${label} n=${n}`);
    console.log(`      申込CTA ${pct(cnt(APPLY_CTA), n)} ／ 申込の語 ${pct(cnt(APPLY_ANY), n)} ／ 内覧の誘導 ${pct(cnt(VIEW_CTA), n)} ／ 総額の断言 ${pct(cnt(TOTAL_CLAIM_RE), n)}`);
    console.log(`      役割: ${Object.entries(ROLE).map(([k, re]) => `${k} ${pct(cnt(re), n)}`).join(" ／ ")}`);
    console.log(`      何卒 ${pct(cnt(/何卒/), n)} ／ 絵文字 ${pct(cnt(/[😊😌🙇🙏✨🌟]/u), n)} ／ 禁止語: ${FORBIDDEN.map(([k, re]) => `${k} ${cnt(re)}`).join("・")}`);
    console.log(`      家賃交渉の予告 ${texts.filter((t) => t.split(/(?<=[。！!\n])/).some((s) => isRentNegotiationPromise(s))).length}件`);
    console.log(`      長さ: 字数中央値 ${median(st.map((s) => s.chars))} ／ 行数中央値 ${median(st.map((s) => s.lines))} ／ 空行あり ${pct(st.filter((s) => s.hasBlank).length, st.filter((s) => s.lines >= 2).length)}（2行以上のうち）`);
    const kindCnt = new Map<string, number>();
    for (const t of texts) kindCnt.set(classifySentKind(t), (kindCnt.get(classifySentKind(t)) ?? 0) + 1);
    console.log(`      種類: ${[...kindCnt].sort((a, b) => b[1] - a[1]).map(([k, n2]) => `${k} ${n2}`).join(" ／ ")}`);
  };
  console.log(`\n--- 実送信（スタッフの次の返信）---`);
  shape("全体", withReply, (c) => c.staffReply?.text ?? null);
  shape("成約側", withReply.filter((c) => c.won), (c) => c.staffReply?.text ?? null);
  console.log(`\n--- AI の下書き（同じ発言・ai_reply_examples）---`);
  shape("全体", withExample, (c) => c.example?.ai_draft ?? null);
  shape("成約側", withExample.filter((c) => c.won), (c) => c.example?.ai_draft ?? null);
  console.log(`\n--- 実送信（AI 下書きと対になる物だけ）---`);
  shape("全体", withExample, (c) => c.example?.sent_reply ?? c.staffReply?.text ?? null);

  // ── 3時間以内に押した AIX ──
  console.log(`\n--- お客様の発言から3時間以内にスタッフが押した AIX ---`);
  const aixCnt = new Map<string, number>();
  for (const c of cases) { const k = c.aixWithin3h.length ? c.aixWithin3h.map((a) => a.aix_type + (a.check_pattern ? `/${a.check_pattern}` : "")).join("→") : "（通常返信 or なし）"; aixCnt.set(k, (aixCnt.get(k) ?? 0) + 1); }
  for (const [k, n] of [...aixCnt].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`   ${String(n).padStart(3)}  ${k}`);
  console.log(`   返信までの分（中央値）: ${median(withReply.map((c) => c.replyMinutes ?? 0))}`);

  // ── 会社の事実 ──
  const factHits = cases.map((c) => ({ c, f: matchCompanyFacts(c.customerBurst.map((b) => b.text ?? "").join("\n")) })).filter((x) => x.f.length);
  console.log(`\n--- 会社の事実が当たる発言: ${factHits.length}件 ---`);
  for (const x of factHits) { const mask = maskWith([x.c.customerName]); console.log(`   [${x.f.map((f) => f.id).join(",")}] 客: ${mask(x.c.customerBurst.map((b) => b.text ?? "").join(" / ")).slice(0, 90)}`); console.log(`        店: ${mask(x.c.staffReply?.text ?? "（返信なし）").replace(/\n/g, " / ").slice(0, 140)}`); }

  // ── 約束の宣言の種類（実送信 vs AI） ──
  const promiseKinds = (t: string) => [...t.matchAll(PROMISE_RE)].map((m) => m[0].replace(/[😊😌！!]+/g, "").trim().slice(-22));
  const pc = new Map<string, number>(), pa = new Map<string, number>();
  for (const c of withReply) for (const p of promiseKinds(c.staffReply!.text ?? "")) pc.set(p, (pc.get(p) ?? 0) + 1);
  for (const c of withExample) for (const p of promiseKinds(c.example!.ai_draft ?? "")) pa.set(p, (pa.get(p) ?? 0) + 1);
  console.log(`\n--- 宣言の形（実送信 上位）---`);
  for (const [k, n] of [...pc].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`   ${String(n).padStart(3)}  ${k}`);
  console.log(`--- 宣言の形（AI 下書き 上位）---`);
  for (const [k, n] of [...pa].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`   ${String(n).padStart(3)}  ${k}`);

  // ── AI 下書きの経路別（通常返信 vs AIX）。S4 で「通常返信」として下書きが出た物だけが生成側の測定対象 ──
  console.log(`\n--- AI 下書きの経路（aix_action）---`);
  const byAction = new Map<string, { n: number; used: number }>();
  for (const c of withExample) { const k = c.example!.aix_action ?? "通常返信"; const v = byAction.get(k) ?? { n: 0, used: 0 }; v.n++; if (c.example!.was_ai_used) v.used++; byAction.set(k, v); }
  for (const [k, v] of [...byAction].sort((a, b) => b[1].n - a[1].n)) console.log(`   ${k.padEnd(32)} ${String(v.n).padStart(3)}  そのまま送信 ${v.used}（${pct(v.used, v.n)}）`);
  // 通常返信の下書きだけ（生成側の測定対象）を実送信（同じ発言へのスタッフの返信）と並べる
  const normal = withExample.filter((c) => !c.example!.aix_action);
  console.log(`\n--- 通常返信の下書き（n=${normal.length}）と、その発言へのスタッフの実送信 ---`);
  shape("AI 下書き（通常返信）", normal, (c) => c.example?.ai_draft ?? null);
  shape("実送信（同じ発言）", normal, (c) => c.staffReply?.text ?? null);
  const tpCnt = new Map<string, number>();
  for (const c of normal) { const tp = (c.example?.reply_context_snapshot as Record<string, unknown> | null)?.turnPair as Record<string, unknown> | undefined; const k = tp ? `${tp.staff}/${tp.customer}/${tp.ruleId ?? "-"}` : "(snapshotなし)"; tpCnt.set(k, (tpCnt.get(k) ?? 0) + 1); }
  console.log(`   snapshot.turnPair: ${[...tpCnt].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(" ／ ")}`);
  // 総額の断言は見積書本体（AIX）を除いて数え直す
  const nonSheet = (t: string) => classifySentKind(t) !== "見積書" && classifySentKind(t) !== "画像・URLのみ";
  const sentNS = withReply.map((c) => c.staffReply!.text ?? "").filter(nonSheet);
  const aiNS = withExample.map((c) => c.example!.ai_draft ?? "").filter(nonSheet);
  console.log(`   総額の断言（見積書本体・画像を除く）: 実送信 ${sentNS.filter((t) => TOTAL_CLAIM_RE.test(t)).length}/${sentNS.length} ／ AI ${aiNS.filter((t) => TOTAL_CLAIM_RE.test(t)).length}/${aiNS.length}`);
  // 禁止語の出所（AIX 印つきの送信か）
  for (const [k, re] of FORBIDDEN) {
    const hits = withReply.filter((c) => re.test(c.staffReply!.text ?? ""));
    if (hits.length) console.log(`   実送信の「${k}」${hits.length}件: AIX印 ${hits.filter((c) => c.staffReply!.is_aix_generated).length} ／ 手打ち ${hits.filter((c) => !c.staffReply!.is_aix_generated).length}`);
  }

  if (process.env.DUMP === "1") {
    console.log(`\n=== 全件（客の発言 → 実送信・AIX）===`);
    for (const c of [...cases].sort((a, b) => a.customerMsg.created_at.localeCompare(b.customerMsg.created_at))) {
      const mask = maskWith([c.customerName]);
      const cust = mask(c.customerBurst.map((b) => b.text ?? (b.image_url ? "[画像]" : "")).join(" / ")).replace(/\n/g, " ").slice(0, 110);
      const sent = mask(c.staffReply?.text ?? "（返信なし）").replace(/\n/g, " / ").slice(0, 170);
      console.log(`${c.customerMsg.created_at.slice(5, 16)} ${c.convId.slice(0, 8)} ${c.won ? "★" : "　"} [${custKind(c)}] AIX=${c.aixWithin3h.map((a) => a.aix_type).join(",") || "-"} ${c.example ? (c.example.aix_action ?? "通常") + (c.example.was_ai_used ? "/used" : "") : "例なし"}\n   客: ${cust}\n   店: ${sent}`);
      if (c.example?.ai_draft && !c.example.aix_action) console.log(`   AI: ${mask(c.example.ai_draft).replace(/\n/g, " / ").slice(0, 200)}`);
    }
    return;
  }

  // ── 実物（目で読む・成約側を優先・下書きが出ていた物を優先） ──
  console.log(`\n=== 実物（成約側→下書きあり の順・${SHOW}件）===`);
  const ordered = [...cases].sort((a, b) => Number(b.won) - Number(a.won) || Number(!!(b.example?.ai_draft)) - Number(!!(a.example?.ai_draft)) || a.customerMsg.created_at.localeCompare(b.customerMsg.created_at));
  for (const c of ordered.slice(0, SHOW)) {
    const mask = maskWith([c.customerName]);
    const snap = c.example?.reply_context_snapshot ?? null;
    const tp = snap && typeof snap === "object" ? (snap as Record<string, unknown>).turnPair : null;
    console.log(`\n--- ${c.customerMsg.created_at.slice(0, 16)} conv=${c.convId.slice(0, 8)} [${c.status}${c.won ? "・成約側" : ""}] AIX3h=${c.aixWithin3h.map((a) => a.aix_type).join(",") || "なし"} 返信${c.replyMinutes ?? "—"}分 ${c.example ? `例あり(was_ai_used=${c.example.was_ai_used} aix_action=${c.example.aix_action ?? "通常"})` : "例なし"}`);
    console.log(`  直前(店): ${mask(c.estimateMsg.text ?? "").replace(/\n/g, " / ").slice(0, 150)}`);
    console.log(`  客      : ${mask(c.customerBurst.map((b) => b.text ?? (b.image_url ? "[画像]" : "")).join(" / ")).slice(0, 200)}`);
    console.log(`  実送信  : ${mask(c.staffReply?.text ?? "（返信なし）").replace(/\n/g, " / ").slice(0, 260)}`);
    if (c.example?.ai_draft) console.log(`  AI下書き: ${mask(c.example.ai_draft).replace(/\n/g, " / ").slice(0, 260)}`);
    if (tp) console.log(`  snapshot.turnPair: ${JSON.stringify(tp).slice(0, 120)}`);
  }
}

if (process.argv[1] && /audit-s4-estimate-followup/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
