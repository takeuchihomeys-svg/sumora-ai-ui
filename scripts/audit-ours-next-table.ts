// scripts/audit-ours-next-table.ts — 「こちらが言った事 → 次の一手」の表を、本番の実送信で数える（読むだけ・LLM なし・DB に書かない）
//
// 2026-11-21 作業員K2（竹内さん 11/21「2通目も、何度も同じ返信をするのを改善する。自分が言った事に対する次の返信の考えが弱い可能性が高い。
//   土台が無ければ作って、細分化して改善する」・統括役の割り振り）。
//   縦: こちらが前の塊で言った事の種類＝作業員L の our_items の種類（our-part-types の OUR_PART_KINDS 7つ: question・fact・promise・proposal・invite・property・aix）
//       ＋ 種類の無い2つ（締めのご査収 receipt・挨拶 greet）。細かい型は OUR_PARTS の鍵（splitOurPartsFine）。
//   横: 次の塊のつながり＝作業員M の LinkKind（next-send-link: answer_then_advance・keep_promise・invite_reply・reshape_no_reply・same_property・other_property・new_topic）。
//       本番の記録（meta.next_send_link）はブレインの判断なので、ここでは実送信から決まった計算で読む（下の linkOf・網は候補）。
//   外れ（同じ事の言い直し）: 次の塊に、前の塊と同じ細かい型（OUR_PARTS の鍵）が出た／同じ文（3字の重なり 0.6 以上）が出た／
//       前に聞いた事をお客様が答えた後にまた聞いた（答え済みの聞き直し）／ご査収・挨拶を続けて重ねた。
//   書き手: 次の塊の最初の手打ちの通の staff_writer（takeuchi＝竹内さん／それ以外＝スタッフ・AI の下書きを送った文を含む）。
//   出力: 書き手ごとの表（行×列の番の数と言い直しの数）・行ごとの言い直しの型の内訳。名前・番号・お客様の文は出さない。
// 実行（重い読み＝22〜8時だけ・統括役に知らせてから）: npx tsx --env-file=<鍵のある .env> scripts/audit-ours-next-table.ts [--days=30] [--out=<json>] [--show=0]
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { splitOurPartsFine, OUR_PART_KINDS, conditionKeysOf, type OurPart } from "../app/lib/our-part-types";
import { isTestConversation } from "../app/lib/test-conversations";
import { isMaterialOnlyText } from "../app/lib/daily-greeting";
import { maskPII } from "../app/lib/pii-mask";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "30"));
const OUT = arg("out", "");
const SHOW = Number(arg("show", "0"));
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();

type Msg = { conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null; staff_writer: string | null };
export const ROWS = [...OUR_PART_KINDS, "receipt", "greet"] as const;
export const LINKS = ["answer_then_advance", "keep_promise", "invite_reply", "reshape_no_reply", "same_property", "other_property", "new_topic"] as const;
type Link = typeof LINKS[number];

const RECEIPT = /お手隙の際に(?:ごゆっくり)?(?:ご査収|ご確認)/;
const GREET = /お世話になっております|はじめまして/;
const FULFIL = /確認(?:させて頂きました|致しました|いたしました)(?:ところ)?|お送りさせて頂きました|ピックアップさせて頂きました|御見積書(?:を)?同封|最大限割引しました/;
const ACCEPT_OR_DAY = /[0-9０-９]{1,2}(?:日|時)|曜|大丈夫|お願いします|お願い致します|了解|わかりました|分かりました|かしこまりました|行けます|いけます/;
// 挨拶・受け・結びの定型（お世話になっております・かしこまりました・何卒・ありがとうございます・ご査収）は「同じ文」に数えない（挨拶・ご査収は別の型で数える）
const STOCK = /お世話になっております|かしこまりました|何卒|ありがとうございま|ご査収|ご確認ください|お気軽に/;
const sents = (t: string) => t.normalize("NFKC").split(/(?<=[。！!？?\n])/).filter((s) => !STOCK.test(s)).map((s) => s.replace(/[\s😊😌🌟✨！!。、]/g, "")).filter((s) => s.length >= 10);
const tri = (s: string) => { const o = new Set<string>(); for (let i = 0; i + 3 <= s.length; i++) o.add(s.slice(i, i + 3)); return o; };
const jac = (a: Set<string>, b: Set<string>) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / Math.max(1, a.size + b.size - n); };
const propsOf = (t: string) => { const s = new Set<string>(); for (const m of t.matchAll(/【([^】\n]{2,30})】|🌟([^\n！!。、\s]{2,30})|([ァ-ヴーA-Za-z一-龥・]{3,20})\s*[0-9０-９]{2,4}号室/g)) { const n = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\s*[0-9０-９A-Za-z-]{1,5}号室$/, "").replace(/\s+/g, ""); if (n.length >= 2 && !/円|割引|初期費用/.test(n)) s.add(n); } return s; };

/** 塊の文（文字だけ・資料だけの通を除く）から、こちらが言った事の行の種類と細かい型 */
export function partsOfBlock(texts: ReadonlyArray<string>, at: string): { rows: Set<string>; keys: Set<string>; parts: OurPart[] } {
  const parts = texts.flatMap((t) => splitOurPartsFine(t, at));
  const rows = new Set<string>(parts.map((p) => p.kind));
  if (texts.some((t) => RECEIPT.test(t))) rows.add("receipt");
  if (texts.some((t) => GREET.test(t))) rows.add("greet");
  return { rows, keys: new Set(parts.map((p) => p.key)), parts };
}

/** 次の塊のつながり（決まった計算・網は候補） */
export function linkOf(o: { prevKeys: Set<string>; prevRows: Set<string>; prevText: string; custText: string | null; nextText: string; nextAix: boolean }): Link {
  if (o.custText == null) return "reshape_no_reply";
  const promiseOpen = [...o.prevKeys].some((k) => k.startsWith("promise."));
  if (promiseOpen && (FULFIL.test(o.nextText) || o.nextAix)) return "keep_promise";
  const invited = o.prevRows.has("invite") || o.prevKeys.has("proposal.viewing") || o.prevKeys.has("question.schedule");
  if (invited && ACCEPT_OR_DAY.test(o.custText) && !/[?？]/.test(o.custText)) return "invite_reply";
  const asked = [...o.prevKeys].some((k) => k.startsWith("question."));
  if (asked && !/[?？]|でしょうか|ですか/.test(o.custText)) return "answer_then_advance";
  const pp = propsOf(o.prevText), np = propsOf(o.nextText);
  if (np.size && [...np].some((x) => pp.has(x))) return "same_property";
  if (np.size) return "other_property";
  return "new_topic";
}

/** 言い直しの型（前の塊 → 次の塊） */
export function repeatsOf(o: { prev: { keys: Set<string>; texts: string[] }; next: { keys: Set<string>; texts: string[] }; custText: string | null }): string[] {
  const out: string[] = [];
  const same = [...o.next.keys].filter((k) => o.prev.keys.has(k) && k !== "fact.answer");
  for (const k of same) {
    if (k.startsWith("question.") && o.custText && !/[?？]|でしょうか|ですか/.test(o.custText)) out.push(`答え済みの聞き直し:${k}`);
    // 11/21 本物の番を読んだ分け: お客様が新しい条件・物件（URL・画像・条件の語）を足した番の同じ型の約束は「新しい依頼への約束」（竹内さんも同じ）＝言い直しに数えない
    else if (k.startsWith("promise.") && o.custText && (/https?:\/\/|\[画像\]|【物件の画面/.test(o.custText) || conditionKeysOf(o.custText).length > 0)) continue;
    // 催促（いつ・まだ）への同じ約束の言い直し＝果たす番（AIX で送る）か、目安を伝える番
    else if (k.startsWith("promise.") && o.custText && /いつ|まだ|どう(?:なり|でしょう)|進捗|頂けますか|いただけますか/.test(o.custText)) out.push(`催促への約束の言い直し:${k}`);
    else out.push(`同じ型:${k}`);
  }
  const A = o.prev.texts.flatMap(sents).map(tri), B = o.next.texts.flatMap(sents).map(tri);
  if (A.some((x) => B.some((y) => jac(x, y) >= 0.6))) out.push("同じ文");
  if (o.prev.texts.some((t) => RECEIPT.test(t)) && o.next.texts.some((t) => RECEIPT.test(t)) && o.custText == null) out.push("ご査収の重ね");
  if (o.prev.texts.some((t) => GREET.test(t)) && o.next.texts.some((t) => GREET.test(t)) && o.custText == null) out.push("挨拶の重ね");
  return out;
}

async function main() {
  const msgs: Msg[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("messages").select("conversation_id, sender, text, image_url, created_at, is_aix_generated, staff_writer").gte("created_at", since).order("conversation_id").order("created_at").range(f, f + 999);
    if (error) throw new Error(error.message);
    msgs.push(...((data ?? []) as Msg[]));
    if ((data ?? []).length < 1000) break;
  }
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; (byConv.get(m.conversation_id) ?? byConv.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }
  type Cell = { n: number; rep: number; types: Record<string, number> };
  const table: Record<string, Record<string, Record<string, Cell>>> = {}; // writer → row → link
  const examples: Array<{ writer: string; link: string; reps: string[]; prev: string; cust?: string | null; nextAix?: boolean; next: string }> = [];
  let turns = 0;
  for (const list of byConv.values()) {
    const cut = list.findIndex((m) => m.sender !== "customer" && /【お申込者様記入欄】/.test(m.text ?? ""));
    const L = cut >= 0 ? list.slice(0, cut) : list;
    // 塊に分ける: こちらの塊（2時間以上空いたら別の塊）・お客様の塊
    type Block = { side: "ours" | "cust"; msgs: Msg[] };
    const blocks: Block[] = [];
    for (const m of L) {
      const side = m.sender === "customer" ? "cust" : "ours";
      const last = blocks[blocks.length - 1];
      const gapOk = last && Date.parse(m.created_at) - Date.parse(last.msgs[last.msgs.length - 1].created_at) < 2 * 3600_000;
      if (last && last.side === side && (side === "cust" || gapOk)) last.msgs.push(m); else blocks.push({ side, msgs: [m] });
    }
    let prev: Block | null = null, cust: Block | null = null;
    for (const b of blocks) {
      if (b.side === "cust") { cust = b; continue; }
      const nextTexts = b.msgs.filter((m) => !m.image_url && (m.text ?? "").trim().length > 4 && !isMaterialOnlyText(m.text)).map((m) => m.text ?? "");
      const hand = b.msgs.find((m) => !m.is_aix_generated && !m.image_url && (m.text ?? "").trim().length > 4);
      // 言い直しは手打ちの通（AIX の定型の文＝物件ごとの資料・見積の文は毎回同じ形で当たり前）だけで見る
      const handTexts = b.msgs.filter((m) => !m.is_aix_generated && !m.image_url && (m.text ?? "").trim().length > 4 && !isMaterialOnlyText(m.text)).map((m) => m.text ?? "");
      if (prev && nextTexts.length && hand) {
        const prevTexts = prev.msgs.filter((m) => !m.image_url && (m.text ?? "").trim().length > 4 && !isMaterialOnlyText(m.text)).map((m) => m.text ?? "");
        if (prevTexts.length) {
          const at = prev.msgs[0].created_at;
          const P = partsOfBlock(prevTexts, at), N = partsOfBlock(handTexts, b.msgs[0].created_at);
          const custText = cust ? cust.msgs.map((m) => m.text ?? "").join("\n") : null;
          const link = linkOf({ prevKeys: P.keys, prevRows: P.rows, prevText: prevTexts.join("\n"), custText, nextText: nextTexts.join("\n"), nextAix: b.msgs.some((m) => m.is_aix_generated) });
          const reps = repeatsOf({ prev: { keys: P.keys, texts: prevTexts }, next: { keys: N.keys, texts: handTexts }, custText });
          const writer = hand.staff_writer === "takeuchi" ? "竹内さん" : "スタッフ";
          turns++;
          for (const row of P.rows) {
            const c = (((table[writer] ??= {})[row] ??= {})[link] ??= { n: 0, rep: 0, types: {} });
            c.n++;
            // その行の型に関わる言い直しだけを数える（同じ型:question.* は question の行、ご査収は receipt の行、挨拶は greet の行、同じ文は全部の行）
            const mine = reps.filter((r) => r === "同じ文" || (row === "receipt" && r === "ご査収の重ね") || (row === "greet" && r === "挨拶の重ね") || r.split(":")[1]?.startsWith(`${row}.`));
            if (mine.length) { c.rep++; for (const r of mine) c.types[r.replace(/:([a-z_]+)\..*$/, ":$1")] = (c.types[r.replace(/:([a-z_]+)\..*$/, ":$1")] ?? 0) + 1; }
          }
          if (reps.length && examples.length < 1500) examples.push({ writer, link, reps, prev: maskPII(prevTexts.join(" ／ ")).replace(/\s+/g, " ").slice(0, 140), cust: custText == null ? null : maskPII(custText).replace(/\s+/g, " ").slice(0, 100), nextAix: b.msgs.some((m) => m.is_aix_generated), next: maskPII(handTexts.join(" ／ ")).replace(/\s+/g, " ").slice(0, 140) });
        }
      }
      prev = b; cust = null;
    }
  }
  console.log(`=== ${DAYS}日・こちらの塊 → 次の塊 ${turns}番（テストの会話・申込の書類以降を除く）`);
  for (const [w, rows] of Object.entries(table)) {
    console.log(`\n## 書き手=${w}（マス＝番の数／言い直しのあった番）`);
    console.log(`| 前に言った事 ＼ 次のつながり | ${LINKS.join(" | ")} | 計 | 言い直し |`);
    for (const r of ROWS) {
      const row = rows[r] ?? {};
      const n = LINKS.reduce((a, l) => a + (row[l]?.n ?? 0), 0), rep = LINKS.reduce((a, l) => a + (row[l]?.rep ?? 0), 0);
      if (!n) continue;
      console.log(`| ${r} | ${LINKS.map((l) => (row[l] ? `${row[l].n}/${row[l].rep}` : "-")).join(" | ")} | ${n} | ${rep}（${Math.round((rep / n) * 100)}%） |`);
    }
    const types: Record<string, number> = {};
    for (const row of Object.values(rows)) for (const c of Object.values(row)) for (const [k, v] of Object.entries(c.types)) types[k] = (types[k] ?? 0) + v;
    console.log(`言い直しの型（行ごとに数えた延べ）: ${Object.entries(types).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
  }
  if (SHOW) for (const e of examples.slice(0, SHOW)) console.log(`\n[${e.writer}・${e.link}] ${e.reps.join(",")}\n  前: ${e.prev}\n  次: ${e.next}`);
  if (OUT) writeFileSync(OUT, JSON.stringify({ days: DAYS, made: new Date().toISOString(), turns, table, examples }, null, 1));
}
if (process.argv[1]?.includes("audit-ours-next-table")) main().catch((e) => { console.error(e); process.exit(1); });
