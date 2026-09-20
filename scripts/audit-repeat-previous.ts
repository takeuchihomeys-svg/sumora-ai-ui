// 生成文が「直前に自分が送った文の焼き直し」になっていないか（読み取りのみ）
//
// 2026-09-21 竹内（スクショ: ゆーたさん 13:39 の実送信）
//   「生成した文は送った内容と同じ内容を再度送っていた形となるので、これを防ぐ。
//    全く同じ内容いれたら文がおかしいので、ここの根本的な原因を見つける」
//
// 【測り方】設計知見「繰り返しの検査は締めの1文だけにする（定型は数えない）」に従う。
//   全文一致で測ると誤警告になる（180日で同じ会話に2回以上出る文の上位は全部定型:
//   お手隙の際にご査収ください145会話 / 日割家賃の注記69 / 何卒49 / 箇条書き38 / 御見積書同封27）。
//   そこで **述部の集合**（phrase-shape.predicateOf）で見て、次の2つに分ける:
//     ① 焼き直し  = 生成文の述部が全部「直前のスタッフ送信」に有る（＝新しい述部が0個）
//     ② 中身あり  = 直前に無い述部が1つ以上ある
//   定型だけの文（「はい／何卒よろしくお願い致します」）は述部が定型でも、
//   **直前にも同じ定型しか無い時だけ**①になる＝定型そのものでは警告にならない。
//
// 【線の引き方】実送信の連続2通（スタッフ→スタッフ）で同じ測り方をして基準率を出す。
//   実送信でほぼ0%なら、生成側に出ている分が「直したい形」。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-repeat-previous.ts
import { createClient } from "@supabase/supabase-js";
import { predicateOf, splitClauses, maskVariables, messageSimilarity } from "../app/lib/phrase-shape";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function page(table: string, select: string, order: string, days: number | null): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    let q = sb.from(table).select(select).order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (days) q = q.gte(order, new Date(Date.now() - days * 86400_000).toISOString());
    const { data, error } = await q;
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

/** 文 → 述部の集合（言い回しの指紋）。※定型も含める（定型は「直前にも有る」時だけ重なる） */
function predicateSet(text: string): Set<string> {
  const s = new Set<string>();
  for (const c of splitClauses(text)) {
    const p = predicateOf(c, 8);
    if (p && p.length >= 4) s.add(p);
  }
  return s;
}

/** 生成文が直前の焼き直しか。新しい述部が0個なら焼き直し */
function reuseOf(cur: string, prev: string): { total: number; fresh: string[]; isReuse: boolean } {
  const a = predicateSet(cur), b = predicateSet(prev);
  const fresh = [...a].filter((p) => !b.has(p));
  return { total: a.size, fresh, isReuse: a.size > 0 && fresh.length === 0 };
}

/** 本文まるごとの一致（マスク後）。焼き直しの中でも一番きつい形 */
const whole = (s: string) => maskVariables(splitClauses(s).join(""));

/**
 * ⚠ 2026-09-21 測り直し: ai_reply_examples.created_at は**送信後**の記録なので、
 *   「created_at より前の最後のスタッフ送信」を素直に取ると **その下書き自身が送られた物**を拾う。
 *   （最初の測定で41%と出たのはこれ。見積書・申込フォームが一字一句同じ＝自分と自分を比べていた）
 *   除外する条件:
 *     ・その行の sent_reply と本文が同じ（＝この下書きの送信結果）
 *     ・下書き本文そのものと同じ
 *     ・created_at の 20分前より後（送信〜記録のずれの幅。スプリット送信も入る）
 */
const SELF_WINDOW_MS = 20 * 60_000;
function isSelfSend(prevText: string, draft: string, sentReply: string, prevAt: string, exAt: string): boolean {
  const p = whole(prevText);
  if (!p) return false;
  if (p === whole(draft)) return true;
  if (sentReply && p === whole(sentReply)) return true;
  return new Date(exAt).getTime() - new Date(prevAt).getTime() < SELF_WINDOW_MS;
}

const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様|さま)/g, "〈お客様〉").replace(/\n/g, " ／ ");

async function main() {
  const days = Number(process.env.DAYS ?? 180);

  // ── 材料 ──
  console.log(`=== 材料を集める（直近${days}日）===`);
  const msgs = await page("messages", "conversation_id, sender, text, created_at, is_aix_generated", "created_at", days);
  console.log(`   messages: ${msgs.length}件`);
  const ex = await page("ai_reply_examples", "conversation_id, ai_draft, sent_reply, entry_source, created_at", "created_at", days);
  console.log(`   ai_reply_examples: ${ex.length}件（ai_draft 有り ${ex.filter((r) => String(r.ai_draft ?? "").trim()).length}件）`);

  // 会話ごとに時系列
  const byConv = new Map<string, Array<{ sender: string; text: string; at: string; aix: boolean }>>();
  for (const m of msgs) {
    const cid = String(m.conversation_id ?? "");
    const t = String(m.text ?? "").trim();
    if (!cid || !t) continue;
    if (!byConv.has(cid)) byConv.set(cid, []);
    byConv.get(cid)!.push({ sender: String(m.sender ?? ""), text: t, at: String(m.created_at), aix: !!m.is_aix_generated });
  }
  for (const a of byConv.values()) a.sort((x, y) => x.at.localeCompare(y.at));

  // ── ① 実送信の基準率（スタッフ→スタッフの連続2通）──
  console.log(`\n=== ① 実送信の基準率: 直前の自分の送信の焼き直しは何%か ===`);
  let sPairs = 0, sReuse = 0, sWhole = 0;
  const sSamples: string[] = [];
  for (const [, arr] of byConv) {
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].sender !== "staff" || arr[i - 1].sender !== "staff") continue;
      // 同時刻のスプリット送信（3分以内）は「1通を分けた物」なので除く
      if (new Date(arr[i].at).getTime() - new Date(arr[i - 1].at).getTime() < 180_000) continue;
      const r = reuseOf(arr[i].text, arr[i - 1].text);
      if (r.total === 0) continue;
      sPairs++;
      if (r.isReuse) {
        sReuse++;
        if (whole(arr[i].text) === whole(arr[i - 1].text)) sWhole++;
        if (sSamples.length < 5) sSamples.push(`     前: ${mask(arr[i - 1].text).slice(0, 90)}\n     後: ${mask(arr[i].text).slice(0, 90)}`);
      }
    }
  }
  console.log(`   連続2通 ${sPairs}組中 焼き直し ${sReuse}組 (${sPairs ? (sReuse / sPairs * 100).toFixed(1) : "-"}%)  うち本文まるごと同じ ${sWhole}組`);
  if (sSamples.length) { console.log(`   実例（スタッフが実際にそうした物）:`); for (const s of sSamples) console.log(s); }

  // ── ② 生成文（ai_draft）は直前のスタッフ送信の焼き直しか ──
  console.log(`\n=== ② 生成文は直前のスタッフ送信の焼き直しか ===`);
  type Hit = { conv: string; at: string; src: string; prev: string; cur: string; whole: boolean; replied: boolean; month: string };
  const hits: Hit[] = [];
  let gPairs = 0, gReuse = 0, gWhole = 0, skippedSelf = 0;
  const bySrc = new Map<string, { n: number; reuse: number }>();
  const byReplied = new Map<string, { n: number; reuse: number }>();
  for (const r of ex) {
    const draft = String(r.ai_draft ?? "").trim();
    const sent = String(r.sent_reply ?? "").trim();
    const cid = String(r.conversation_id ?? "");
    if (!draft || !cid) continue;
    const arr = byConv.get(cid);
    if (!arr) continue;
    const exAt = String(r.created_at);
    const at = new Date(exAt).getTime();
    // 生成時刻より前のスタッフ送信のうち、**この下書き自身の送信結果ではない**最後の1通
    const prev = [...arr].reverse().find((m) =>
      m.sender === "staff" && new Date(m.at).getTime() < at && !isSelfSend(m.text, draft, sent, m.at, exAt));
    if (!prev) { skippedSelf++; continue; }
    const rr = reuseOf(draft, prev.text);
    if (rr.total === 0) continue;
    // その後にお客様が返信しているか（返信あり＝返事への返信／なし＝続きのメッセージ）
    const replied = arr.some((m) => m.sender === "customer"
      && new Date(m.at).getTime() > new Date(prev.at).getTime() && new Date(m.at).getTime() < at);
    gPairs++;
    const src = String(r.entry_source ?? "(null)");
    const b = bySrc.get(src) ?? { n: 0, reuse: 0 }; b.n++;
    const rk = replied ? "お客様の返信あり" : "返信なし（続きのメッセージ）";
    const rb = byReplied.get(rk) ?? { n: 0, reuse: 0 }; rb.n++;
    if (rr.isReuse) {
      gReuse++; b.reuse++; rb.reuse++;
      const w = whole(draft) === whole(prev.text);
      if (w) gWhole++;
      hits.push({ conv: cid, at: exAt, src, prev: prev.text, cur: draft, whole: w, replied, month: exAt.slice(0, 7) });
    }
    bySrc.set(src, b); byReplied.set(rk, rb);
  }
  console.log(`   （自分の送信結果を拾った分 ${skippedSelf}件は除外）`);
  console.log(`   生成 ${gPairs}件中 焼き直し ${gReuse}件 (${gPairs ? (gReuse / gPairs * 100).toFixed(1) : "-"}%)  うち本文まるごと同じ ${gWhole}件`);
  console.log(`   経路別:`);
  for (const [k, v] of [...bySrc.entries()].sort((a, b) => b[1].reuse - a[1].reuse)) {
    console.log(`     ${String(v.reuse).padStart(4)}/${String(v.n).padEnd(5)} (${(v.reuse / v.n * 100).toFixed(1)}%)  ${k}`);
  }
  console.log(`   お客様が間に返信しているか別:`);
  for (const [k, v] of [...byReplied.entries()].sort((a, b) => b[1].reuse - a[1].reuse)) {
    console.log(`     ${String(v.reuse).padStart(4)}/${String(v.n).padEnd(5)} (${(v.reuse / v.n * 100).toFixed(1)}%)  ${k}`);
  }

  // ── ③ 実物を読む（設計知見「件数だけ見ない」）──
  console.log(`\n=== ③ 焼き直しの実物（新しい月から10件）===`);
  for (const h of hits.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10)) {
    console.log(`${"─".repeat(78)}`);
    console.log(`   ${h.at.slice(0, 16)}  ${h.src}${h.whole ? "  【本文まるごと同じ】" : ""}`);
    console.log(`   直前送信: ${mask(h.prev).slice(0, 150)}`);
    console.log(`   生成文  : ${mask(h.cur).slice(0, 150)}`);
  }

  // ── ④ 月別（直した効果を後で時系列で見るため）──
  // ── ⑤ 言い換えの焼き直しはどこから始まるか（全文の近さの分布で線を引く）──
  //   述部の集合だけだと「ご質問ください→ご連絡ください」のような言い換えを見逃す。
  //   実送信の連続2通と生成を同じ物差しで並べ、実送信がほぼ0になる点を探す。
  console.log(`\n=== ⑤ 全文の近さ（言い換えを含む焼き直しの線を引く）===`);
  const simStaff: number[] = [], simGen: number[] = [];
  for (const [, arr] of byConv) {
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].sender !== "staff" || arr[i - 1].sender !== "staff") continue;
      if (new Date(arr[i].at).getTime() - new Date(arr[i - 1].at).getTime() < 180_000) continue;
      if (arr[i].text === "[画像]" || arr[i - 1].text === "[画像]") continue;
      simStaff.push(messageSimilarity(arr[i].text, arr[i - 1].text));
    }
  }
  for (const h of hits.length ? [] : []) void h;  // hits は焼き直しだけなので使わない
  for (const r of ex) {
    const draft = String(r.ai_draft ?? "").trim(); const sent = String(r.sent_reply ?? "").trim();
    const cid = String(r.conversation_id ?? ""); if (!draft || !cid) continue;
    const arr = byConv.get(cid); if (!arr) continue;
    const exAt = String(r.created_at); const at = new Date(exAt).getTime();
    const prev = [...arr].reverse().find((m) => m.sender === "staff" && new Date(m.at).getTime() < at && !isSelfSend(m.text, draft, sent, m.at, exAt));
    if (!prev || prev.text === "[画像]") continue;
    simGen.push(messageSimilarity(draft, prev.text));
  }
  console.log(`   対象: 実送信の連続2通 ${simStaff.length}組 / 生成 ${simGen.length}件`);
  console.log(`   しきい値   実送信で超える率      生成で超える率`);
  for (const th of [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9]) {
    const s = simStaff.filter((v) => v >= th).length, g = simGen.filter((v) => v >= th).length;
    console.log(`     ${th.toFixed(2)}     ${String(s).padStart(4)}組 (${(s / simStaff.length * 100).toFixed(1)}%)     ${String(g).padStart(4)}件 (${(g / simGen.length * 100).toFixed(1)}%)`);
  }

  console.log(`\n=== ④ 月別の焼き直し率（生成）===`);
  const byMonth = new Map<string, { n: number; reuse: number }>();
  for (const r of ex) {
    const draft = String(r.ai_draft ?? "").trim(); const sent = String(r.sent_reply ?? "").trim();
    const cid = String(r.conversation_id ?? "");
    if (!draft || !cid) continue;
    const arr = byConv.get(cid); if (!arr) continue;
    const exAt = String(r.created_at); const at = new Date(exAt).getTime();
    const prev = [...arr].reverse().find((m) =>
      m.sender === "staff" && new Date(m.at).getTime() < at && !isSelfSend(m.text, draft, sent, m.at, exAt));
    if (!prev) continue;
    const rr = reuseOf(draft, prev.text); if (rr.total === 0) continue;
    const mo = exAt.slice(0, 7);
    const b = byMonth.get(mo) ?? { n: 0, reuse: 0 }; b.n++; if (rr.isReuse) b.reuse++;
    byMonth.set(mo, b);
  }
  for (const [mo, v] of [...byMonth.entries()].sort()) {
    console.log(`   ${mo}  ${String(v.reuse).padStart(4)}/${String(v.n).padEnd(5)} (${(v.reuse / v.n * 100).toFixed(1)}%)`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
