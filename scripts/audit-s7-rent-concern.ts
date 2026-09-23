// 場面 S7「家賃が高い・安いと嬉しい・予算オーバー・割引頑張って・フリーレント」の実測（読み取りのみ・DB は書かない）
//
// 2026-09-23 竹内「実際の成約データや直近の今月のLINEをお手本にして 生成される文にギャップが生まれないか確認する」
//
// 【S7 の定義】お客様の発言に「家賃が高い／安くなったら嬉しい／予算オーバー／割引頑張って／フリーレント／値下げ・交渉」の語がある発言
//   （条件フォームは除く。フォームの「家賃⇒」は場面ではない）。
//   その発言に対するスタッフの次の返信（実送信）と、同じ発言に対する AI の下書き（ai_reply_examples）を並べる。
//
// 【数える物】（設計知見の型③「実送信で線を引く」・⑦「全件監査は目で読む」）
//   1) 家賃交渉の予告（isRentNegotiationPromise）… 実送信 0 が線。AI 下書きは何件か
//   2) 代わりの答え: 初期費用の割引・抑える／別物件のピックアップ／フリーレントの答え／断り
//   3) 行の役割・長さ・禁止語・申込導線  4) 3時間以内に押した AIX
//   (c) 純関数の今月全件当て: brain_decision_logs.digest.dir に stripRentNegotiation／ai_reply_examples.ai_draft・実送信に isRentNegotiationPromise
//
// 実行: npx tsx --env-file=.env.local scripts/audit-s7-rent-concern.ts [MONTH=2026-09] [SHOW=20] [DUMP=1]
import { createClient } from "@supabase/supabase-js";
import { classifySentKind, customerSceneOf } from "../app/lib/sent-shape";
import { isRentNegotiationPromise, stripRentNegotiation, isRentNegotiationTopic, customerAskedRentNegotiation } from "../app/lib/rent-negotiation-guard";
import { matchCompanyFacts } from "../app/lib/company-facts";
import { isShortAckOnly } from "../app/lib/previous-send-note";
import { isConditionFormMessage } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const MONTH = process.env.MONTH ?? "2026-09";
const SHOW = Number(process.env.SHOW ?? 20);
const since = `${MONTH}-01T00:00:00+09:00`;
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
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

// ── S7 の抽出（一次分類。❌ は本文を読んで確定する） ─────────────────────
const RENT_CONCERN_RE = new RegExp([
  "(?:家賃|賃料)[^\\n]{0,12}(?:高|安く|安い|安か|下げ|抑え|オーバー|厳し|きつ|予算|交渉|値引|値下|減額)",
  "予算[^\\n]{0,8}(?:オーバー|超え|越え|厳し|きつ|上回)",
  "(?:割引|値引|値下げ|減額|交渉)",
  "フリーレント",
  "(?:もう少し|もうちょっと|少し|ちょっと|もっと)[^\\n]{0,6}(?:安く|安い|安け|下げ|抑え)",
  "(?:ちょっと|少し|少々|やや|かなり|結構)(?:お)?(?:高い|高め|高くて|高かっ)",
].join("|"));
/** 家賃・費用の文脈でない「交渉・割引」（例: 車の交渉）を除くための最小の文脈語 */
const MONEY_CTX_RE = /家賃|賃料|費用|予算|金額|円|万|割引|フリーレント|礼金|敷金|安/;

const APPLY_CTA = /お気に召され[^\n]{0,24}お?申込|お?申込(?:み)?(?:で|し|して)?[^\n]{0,12}(?:抑え|押さえ|確保)|お申込(?:み)?(?:是非|ぜひ|いかが|ご検討|も可能|でお部屋)|お申込(?:み)?から(?:審査|最短)|申込(?:後|から)最短|お申込(?:み)?手続き|申込(?:み)?(?:の)?(?:ご)?希望|申込(?:み)?(?:を)?(?:させて|進め)/;
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
/** S7 で「会社の本当の答え」になる形（実送信で引く） */
const ANSWERS: Array<[string, RegExp]> = [
  ["初期費用の割引・抑える", /初期費用[^\n]{0,20}(?:割引|抑え|お安く|安く|削減|下げ)|(?:最大限|出来る限り|できる限り)[^\n]{0,8}割引|割引[^\n]{0,12}(?:初期費用|御見積|見積)/],
  ["別物件・ピックアップ", /ピックアップ|お探し|探して|(?:別|他|ほか)の(?:お)?(?:部屋|物件)|(?:お)?部屋[^\n]{0,10}お送り/],
  ["フリーレントに触れる", /フリーレント/],
  ["家賃の安い物件を", /(?:家賃|賃料)[^\n]{0,10}(?:抑え|安い|お安い|低い|下げた)/],
  ["交渉の断り・できない", /(?:交渉|値下げ|値引き|減額|家賃)[^\n]{0,12}(?:難し|(?:出来|でき)かね|お受け(?:出来|でき)|お断り|承(?:れ|る事が出来)ません|(?:出来|でき)ません|不可)/],
  ["敷金礼金・管理費の交渉", /(?:敷金|礼金|管理費|共益費)[^\n]{0,10}(?:交渉|値下げ|減額|相談)/],
  ["代表の許可・仕組みの説明", /代表|許可|仕組み|報酬|還元/],
  ["見積書", /御見積書|お見積書|見積書/],
];

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

export type S7Case = {
  convId: string; customerName: string; status: string; won: boolean;
  prevStaff: Msg | null; customerMsg: Msg; customerBurst: Msg[]; staffReply: Msg | null; staffReplies: Msg[];
  replyMinutes: number | null;
  aixWithin3h: Array<{ aix_type: string; check_pattern: string | null; at: string }>;
  example: Ex | null;
  customerAsked: boolean;
};

function textStats(t: string) {
  const lines = t.replace(/\r/g, "").split("\n");
  const nonEmpty = lines.filter((l) => l.trim());
  const blanks = lines.length - nonEmpty.length;
  return { chars: t.replace(/\s/g, "").length, lines: nonEmpty.length, hasBlank: nonEmpty.length >= 2 && blanks > 0 };
}
function median(xs: number[]) { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; }
const sentences = (t: string) => t.split(/[\n。！!？?]/).map((s) => s.trim()).filter(Boolean);
const hasPromise = (t: string) => sentences(t).some(isRentNegotiationPromise);

export async function collectS7(): Promise<S7Case[]> {
  const custMsgs = await all<Msg>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, image_url, created_at, is_aix_generated")
    .eq("sender", "customer").gte("created_at", since).not("text", "is", null).order("created_at", { ascending: true }).range(a, b));
  const hits = custMsgs.filter((m) => m.conversation_id !== YUMA && RENT_CONCERN_RE.test(m.text ?? "") && MONEY_CTX_RE.test(m.text ?? "") && !isConditionFormMessage(m.text ?? ""));
  const convIds = [...new Set(hits.map((m) => m.conversation_id))];
  const convOf = new Map<string, { customer_name: string; status: string; is_post_apply: boolean | null }>();
  for (let i = 0; i < convIds.length; i += 200) {
    const { data } = await sb.from("conversations").select("id, customer_name, status, is_post_apply").in("id", convIds.slice(i, i + 200));
    for (const c of (data ?? []) as Array<{ id: string; customer_name: string; status: string; is_post_apply: boolean | null }>) convOf.set(c.id, c);
  }
  const out: S7Case[] = [];
  const seen = new Set<string>();
  for (const conv of convIds) {
    const c = convOf.get(conv); if (!c) continue;
    const { data: ms } = await sb.from("messages").select("id, conversation_id, sender, text, image_url, created_at, is_aix_generated")
      .eq("conversation_id", conv).gte("created_at", since).order("created_at", { ascending: true }).limit(1000);
    const msgs = (ms ?? []) as Msg[];
    const { data: ax } = await sb.from("aix_usage_logs").select("aix_type, check_pattern, created_at, sent_at").eq("conversation_id", conv).gte("created_at", since);
    const aix = ((ax ?? []) as Array<{ aix_type: string; check_pattern: string | null; created_at: string; sent_at: string | null }>).map((r) => ({ aix_type: r.aix_type, check_pattern: r.check_pattern, at: r.sent_at ?? r.created_at }));
    const { data: exs } = await sb.from("ai_reply_examples").select("id, conversation_id, customer_message, sent_reply, ai_draft, was_ai_used, aix_action, created_at, sent_at, reply_context_snapshot").eq("conversation_id", conv).gte("created_at", since);
    const examples = (exs ?? []) as Ex[];
    for (const h of hits.filter((x) => x.conversation_id === conv)) {
      const j = msgs.findIndex((m) => m.id === h.id); if (j < 0) continue;
      // 同じ人の連投（15分以内）をまとめる（先頭に戻る）
      let s = j; while (s > 0 && msgs[s - 1].sender === "customer" && Date.parse(msgs[s].created_at) - Date.parse(msgs[s - 1].created_at) < 15 * 60_000) s--;
      let k = j + 1; while (k < msgs.length && msgs[k].sender === "customer" && Date.parse(msgs[k].created_at) - Date.parse(msgs[k - 1].created_at) < 15 * 60_000) k++;
      const burst = msgs.slice(s, k);
      const burstKey = `${conv}:${burst[0].id}`; if (seen.has(burstKey)) continue; seen.add(burstKey);
      const prevStaff = msgs.slice(0, s).reverse().find((x) => x.sender === "staff") ?? null;
      // スタッフの次の返信（連投もまとめる・30分以内）
      const after = msgs.slice(k);
      const firstIdx = after.findIndex((x) => x.sender === "staff");
      const staffReplies: Msg[] = [];
      if (firstIdx >= 0) { staffReplies.push(after[firstIdx]); let q = firstIdx + 1; while (q < after.length && after[q].sender === "staff" && Date.parse(after[q].created_at) - Date.parse(after[q - 1].created_at) < 30 * 60_000) { staffReplies.push(after[q]); q++; } }
      const staffReply = staffReplies[0] ?? null;
      const custAt = Date.parse(burst[burst.length - 1].created_at);
      const replyMinutes = staffReply ? Math.round((Date.parse(staffReply.created_at) - custAt) / 60_000) : null;
      const aixWithin3h = aix.filter((r) => { const t = Date.parse(r.at); return t >= custAt && t - custAt <= 3 * 3600_000; });
      const custText = burst.map((b) => b.text ?? "").join("\n").trim();
      const example = examples.find((e) => (e.customer_message ?? "").trim() && custText.includes((e.customer_message ?? "").trim().slice(0, 30)) && Math.abs(Date.parse(e.created_at) - custAt) < 3 * 86400_000) ?? null;
      out.push({ convId: conv, customerName: c.customer_name, status: c.status, won: WON_STATUSES.has(c.status) || !!c.is_post_apply, prevStaff, customerMsg: h, customerBurst: burst, staffReply, staffReplies, replyMinutes, aixWithin3h, example, customerAsked: customerAskedRentNegotiation(burst.map((b) => b.text)) });
    }
  }
  return out.sort((a, b) => a.customerMsg.created_at.localeCompare(b.customerMsg.created_at));
}

async function main() {
  console.log(`=== S7 家賃が高い・安いと嬉しい・予算オーバー（${MONTH}・読み取りのみ）===\n`);
  const cases = await collectS7();
  const won = cases.filter((c) => c.won);
  console.log(`S7 の発言: ${cases.length}件（会話 ${new Set(cases.map((c) => c.convId)).size}）／ 成約側 ${won.length}件（会話 ${new Set(won.map((c) => c.convId)).size}）／ お客様が明示的に家賃交渉を依頼 ${cases.filter((c) => c.customerAsked).length}件`);
  const withReply = cases.filter((c) => c.staffReply);
  const withExample = cases.filter((c) => c.example && (c.example.ai_draft ?? "").trim() && !MARK.test(c.example.ai_draft ?? ""));
  console.log(`スタッフの返信あり ${withReply.length} ／ AI 下書きが残っている ${withExample.length}（was_ai_used ${withExample.filter((c) => c.example?.was_ai_used).length}）\n`);

  const deps = { isConditionForm: isConditionFormMessage, isShortAck: isShortAckOnly };
  const custKind = (c: S7Case) => customerSceneOf(c.customerBurst.map((b) => b.text ?? "").join("\n"), deps);
  const kinds = new Map<string, number>();
  for (const c of cases) kinds.set(custKind(c), (kinds.get(custKind(c)) ?? 0) + 1);
  console.log(`--- お客様の発言の種類（customerSceneOf）---`);
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(12)} ${String(n).padStart(3)}  成約側 ${won.filter((c) => custKind(c) === k).length}`);

  const shape = (label: string, list: S7Case[], pick: (c: S7Case) => string | null) => {
    const texts = list.map(pick).filter((t): t is string => !!t && !MARK.test(t));
    const n = texts.length; if (!n) { console.log(`   ${label}: n=0`); return; }
    const cnt = (re: RegExp) => texts.filter((t) => re.test(t)).length;
    const st = texts.map(textStats);
    console.log(`   ${label} n=${n}`);
    console.log(`      家賃交渉の予告（isRentNegotiationPromise） ${texts.filter(hasPromise).length}件 ／ 家賃交渉の話題（isRentNegotiationTopic・入口の緩い判定） ${texts.filter((t) => sentences(t).some(isRentNegotiationTopic)).length}件`);
    console.log(`      答えの形: ${ANSWERS.map(([k, re]) => `${k} ${pct(cnt(re), n)}`).join(" ／ ")}`);
    console.log(`      申込CTA ${pct(cnt(APPLY_CTA), n)} ／ 役割: ${Object.entries(ROLE).map(([k, re]) => `${k} ${pct(cnt(re), n)}`).join(" ／ ")}`);
    console.log(`      何卒 ${pct(cnt(/何卒/), n)} ／ 絵文字 ${pct(cnt(/[😊😌🙇🙏✨🌟]/u), n)} ／ 禁止語: ${FORBIDDEN.map(([k, re]) => `${k} ${cnt(re)}`).join("・")}`);
    console.log(`      長さ: 字数中央値 ${median(st.map((s) => s.chars))} ／ 行数中央値 ${median(st.map((s) => s.lines))} ／ 空行あり ${pct(st.filter((s) => s.hasBlank).length, st.filter((s) => s.lines >= 2).length)}（2行以上のうち）`);
    const kindCnt = new Map<string, number>();
    for (const t of texts) kindCnt.set(classifySentKind(t), (kindCnt.get(classifySentKind(t)) ?? 0) + 1);
    console.log(`      種類: ${[...kindCnt].sort((a, b) => b[1] - a[1]).map(([k, n2]) => `${k} ${n2}`).join(" ／ ")}`);
  };
  const sentText = (c: S7Case) => c.staffReplies.length ? c.staffReplies.map((m) => m.text ?? "").filter((t) => t && t !== "__SHOWN__").join("\n") : null;
  console.log(`\n--- 実送信（スタッフの次の返信・30分以内の連投を合わせる）---`);
  shape("全体", withReply, sentText);
  shape("成約側", withReply.filter((c) => c.won), sentText);
  console.log(`\n--- AI の下書き（同じ発言・ai_reply_examples）---`);
  shape("全体", withExample, (c) => c.example?.ai_draft ?? null);
  shape("成約側", withExample.filter((c) => c.won), (c) => c.example?.ai_draft ?? null);

  console.log(`\n--- お客様の発言から3時間以内にスタッフが押した AIX ---`);
  const aixCnt = new Map<string, number>();
  for (const c of cases) { const k = c.aixWithin3h.length ? c.aixWithin3h.map((a) => a.aix_type + (a.check_pattern ? `/${a.check_pattern}` : "")).join("→") : "（通常返信 or なし）"; aixCnt.set(k, (aixCnt.get(k) ?? 0) + 1); }
  for (const [k, n] of [...aixCnt].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`   ${String(n).padStart(3)}  ${k}`);
  console.log(`   返信までの分（中央値）: ${median(withReply.map((c) => c.replyMinutes ?? 0))}`);
  const factHits = cases.map((c) => ({ c, f: matchCompanyFacts(c.customerBurst.map((b) => b.text ?? "").join("\n")) })).filter((x) => x.f.length);
  console.log(`   会社の事実が当たる発言: ${factHits.length}件 [${factHits.map((x) => x.f.map((f) => f.id).join(",")).join(" / ")}]`);
  console.log(`\n--- AI 下書きの経路（aix_action）---`);
  const byAction = new Map<string, { n: number; used: number }>();
  for (const c of withExample) { const k = c.example!.aix_action ?? "通常返信"; const v = byAction.get(k) ?? { n: 0, used: 0 }; v.n++; if (c.example!.was_ai_used) v.used++; byAction.set(k, v); }
  for (const [k, v] of [...byAction].sort((a, b) => b[1].n - a[1].n)) console.log(`   ${k.padEnd(32)} ${String(v.n).padStart(3)}  そのまま送信 ${v.used}（${pct(v.used, v.n)}）`);

  // ── (c) 純関数の今月全件当て ──
  console.log(`\n=== (c) 純関数の今月全件当て ===`);
  const sent = await all<{ text: string | null; is_aix_generated: boolean | null; created_at: string }>((a, b) => sb.from("messages").select("text, is_aix_generated, created_at").eq("sender", "staff").gte("created_at", since).order("created_at", { ascending: false }).range(a, b));
  const sentTexts = sent.map((r) => String(r.text ?? "")).filter((t) => t && t !== "__SHOWN__");
  const sentHit = sentTexts.filter(hasPromise);
  console.log(`実送信 ${sentTexts.length}通 → isRentNegotiationPromise が当たる（誤削除）: ${sentHit.length}通`);
  for (const t of sentHit) console.log(`   ❌ ${t.replace(/\n/g, " ").slice(0, 140)}`);
  const sentTopic = sentTexts.filter((t) => sentences(t).some(isRentNegotiationTopic));
  console.log(`実送信で家賃交渉の話題（入口の緩い判定）: ${sentTopic.length}通（目で読む）`);
  for (const t of sentTopic) console.log(`   ・ ${t.replace(/\n/g, " ").slice(0, 140)}`);
  const drafts = await all<{ ai_draft: string | null; sent_reply: string | null; created_at: string; was_ai_used: boolean | null }>((a, b) => sb.from("ai_reply_examples").select("ai_draft, sent_reply, created_at, was_ai_used").gte("created_at", since).order("created_at", { ascending: false }).range(a, b));
  const draftHit = drafts.filter((d) => hasPromise(String(d.ai_draft ?? "")));
  console.log(`\nAI 下書き ${drafts.length}件 → 当たる ${draftHit.length}件（前後を読む）`);
  for (const d of draftHit) {
    console.log(`   [${d.created_at.slice(0, 16)}] used=${d.was_ai_used}`);
    console.log(`     下書き: ${String(d.ai_draft ?? "").replace(/\n/g, " ").slice(0, 170)}`);
    console.log(`     実送信: ${String(d.sent_reply ?? "（削除・未送信）").replace(/\n/g, " ").slice(0, 170)}`);
  }
  const logs = await all<{ digest: Record<string, unknown> | null; created_at: string; conversation_id: string }>((a, b) => sb.from("brain_decision_logs").select("digest, created_at, conversation_id").gte("created_at", since).not("digest", "is", null).order("created_at", { ascending: false }).range(a, b));
  const dirs = logs.map((r) => ({ dir: String(r.digest?.dir ?? ""), drop: r.digest?.drop, at: r.created_at, conv: r.conversation_id })).filter((x) => x.dir);
  const dirHit = dirs.filter((x) => stripRentNegotiation(x.dir).dropped);
  const dropped = logs.filter((r) => r.digest?.drop);
  console.log(`\nブレインの方向（digest.dir） ${dirs.length}件 → stripRentNegotiation が当たる ${dirHit.length}件 ／ 本番で落とした記録（digest.drop） ${dropped.length}件`);
  for (const x of dirHit.slice(0, 40)) { const r = stripRentNegotiation(x.dir); console.log(`   [${x.at.slice(0, 16)} ${x.conv.slice(0, 8)}${x.conv === YUMA ? " YUMA" : ""}]\n     前: ${x.dir}\n     後: ${r.text ?? "（方向なし）"}\n     落: ${r.dropped}`); }
  for (const r of dropped.slice(0, 20)) console.log(`   drop記録 [${r.created_at.slice(0, 16)} ${r.conversation_id.slice(0, 8)}${r.conversation_id === YUMA ? " YUMA" : ""}] ${String(r.digest?.drop)} ← dir: ${String(r.digest?.dir ?? "").slice(0, 80)}`);

  if (process.env.DUMP === "1") {
    console.log(`\n=== 全件（客の発言 → 実送信・AIX）===`);
    for (const c of cases) {
      const mask = maskWith([c.customerName]);
      const cust = mask(c.customerBurst.map((b) => b.text ?? (b.image_url ? "[画像]" : "")).join(" / ")).replace(/\n/g, " ").slice(0, 150);
      const sentT = mask(sentText(c) ?? "（返信なし）").replace(/\n/g, " / ").slice(0, 220);
      console.log(`${c.customerMsg.created_at.slice(5, 16)} ${c.customerMsg.id} conv=${c.convId.slice(0, 8)} ${c.won ? "★" : "　"} [${c.status}/${custKind(c)}] AIX=${c.aixWithin3h.map((a) => a.aix_type).join(",") || "-"} ${c.example ? (c.example.aix_action ?? "通常") + (c.example.was_ai_used ? "/used" : "") : "例なし"} 返信${c.replyMinutes ?? "—"}分\n   客: ${cust}\n   店: ${sentT}`);
      if (c.example?.ai_draft && !MARK.test(c.example.ai_draft)) console.log(`   AI: ${mask(c.example.ai_draft).replace(/\n/g, " / ").slice(0, 220)}`);
    }
    return;
  }

  console.log(`\n=== 実物（成約側→下書きあり の順・${SHOW}件）===`);
  const ordered = [...cases].sort((a, b) => Number(b.won) - Number(a.won) || Number(!!(b.example?.ai_draft)) - Number(!!(a.example?.ai_draft)) || a.customerMsg.created_at.localeCompare(b.customerMsg.created_at));
  for (const c of ordered.slice(0, SHOW)) {
    const mask = maskWith([c.customerName]);
    const snap = c.example?.reply_context_snapshot ?? null;
    const tp = snap && typeof snap === "object" ? (snap as Record<string, unknown>).turnPair : null;
    console.log(`\n--- ${c.customerMsg.created_at.slice(0, 16)} msg=${c.customerMsg.id} conv=${c.convId.slice(0, 8)} [${c.status}${c.won ? "・成約側" : ""}] AIX3h=${c.aixWithin3h.map((a) => a.aix_type).join(",") || "なし"} 返信${c.replyMinutes ?? "—"}分 ${c.example ? `例あり(was_ai_used=${c.example.was_ai_used} aix_action=${c.example.aix_action ?? "通常"})` : "例なし"}`);
    console.log(`  直前(店): ${mask(c.prevStaff?.text ?? "（なし）").replace(/\n/g, " / ").slice(0, 150)}`);
    console.log(`  客      : ${mask(c.customerBurst.map((b) => b.text ?? (b.image_url ? "[画像]" : "")).join(" / ")).slice(0, 260)}`);
    console.log(`  実送信  : ${mask(sentText(c) ?? "（返信なし）").replace(/\n/g, " / ").slice(0, 420)}`);
    if (c.example?.ai_draft) console.log(`  AI下書き: ${mask(c.example.ai_draft).replace(/\n/g, " / ").slice(0, 420)}`);
    if (tp) console.log(`  snapshot.turnPair: ${JSON.stringify(tp).slice(0, 120)}`);
  }
}

if (process.argv[1] && /audit-s7-rent-concern/.test(process.argv[1])) main().catch((e) => { console.error(e); process.exit(1); });
