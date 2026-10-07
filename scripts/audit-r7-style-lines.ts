// scripts/audit-r7-style-lines.ts — 7巡目: 文の表面の型ごとに「スタッフの多数派」と「今の決まり（決定論）が人の文にどれだけ合うか」を数える（読むだけ・LLM なし）
//   番 = お客様の連投の頭 → その後の最初のスタッフの文（AIX の文・画像だけを除く・次のお客様の発言まで）
//   ①挨拶: resolveGreeting の予測（standard=挨拶あり／none=なし）× スタッフの実際（お世話になっております）を分岐ごとに
//   ②開口語: 場面ごとのスタッフの開口語・質問の番で classifyReplyBody（答え→はい／動く→かしこまりました）が人に合う率
//   ③絵文字で終わる文に ！！ が続くか・物件を送ってきた番の「お部屋お送り頂きありがとうございます」・呼び名の後の改行・日付「M/D日は」
// 実行: npx tsx --env-file=.env.local scripts/audit-r7-style-lines.ts [--days=180] [--samples=8]
import { createClient } from "@supabase/supabase-js";
import { resolveGreeting, classifyReplyBody, detectOpener } from "../app/lib/greeting";
import { resolveReplyScene, REPLY_SCENE_JA, type ReplyScene } from "../app/lib/reply-scene";
import { isTestConversation } from "../app/lib/test-conversations";
import { openerKindOf, OPENER_JA } from "../app/lib/text-diff-types";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "180"));
const SAMPLES = Number(arg("samples", "8"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
type M = { conversation_id: string; sender: string; created_at: string; text: string | null; is_aix_generated: boolean | null };

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const msgs = await readAll<M>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, t));
  console.log(`messages ${msgs.length}（${since.slice(0, 10)}〜）`);
  const by = new Map<string, M[]>();
  for (const m of msgs) { if (isTestConversation(m.conversation_id)) continue; if (!by.has(m.conversation_id)) by.set(m.conversation_id, []); by.get(m.conversation_id)!.push(m); }

  type Turn = { cid: string; scene: ReplyScene; cust: string; staff: string; staffAt: string; greetPred: string; greetReason: string; prevStaffSameDayAsReply: boolean; gapH: number; custGreets: boolean; custSameDay: boolean; delayH: number; staffLen: number };
  const turns: Turn[] = [];
  for (const [cid, list] of by) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].sender !== "customer" || (i > 0 && list[i - 1].sender === "customer")) continue;
      let j = i; while (j + 1 < list.length && list[j + 1].sender === "customer") j++;
      const custText = list.slice(i, j + 1).map((m) => m.text ?? "").join("\n");
      // 最初のスタッフの文（AIX・画像だけ・スタンプを除く）
      let k = j + 1; let staff: M | null = null;
      for (; k < list.length && list[k].sender !== "customer"; k++) {
        const t = (list[k].text ?? "").trim();
        if (list[k].sender !== "staff" || list[k].is_aix_generated || !t || /^\[(?:画像|動画|スタンプ|ファイル)\]/.test(t)) continue;
        staff = list[k]; break;
      }
      if (!staff) continue;
      // その時点までの履歴（AIX も含む・今の返事は含まない）
      const hist = list.slice(0, k).map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.created_at, isAix: !!m.is_aix_generated }));
      const now = Date.parse(staff.created_at) - 1000;
      const jstDay = (ms: number) => Math.floor((ms + 9 * 3600_000) / 86_400_000);
      const prevStaff = [...hist].reverse().find((m) => m.sender === "staff" && m.text && !/^\[(?:画像|動画)\]$/.test(m.text));
      const alreadyGreetedToday = hist.some((m) => m.sender === "staff" && m.text && !/^\[(?:画像|動画)\]$/.test(m.text) && jstDay(Date.parse(m.createdAt)) === jstDay(now));
      const isFirstEver = !hist.some((m) => m.sender === "staff" && !m.isAix && m.text);
      const g = resolveGreeting({ customerName: "X", isFirstEverReply: isFirstEver, alreadyGreetedToday, recentMessages: hist, jstHour: 12, now, isSubstantive: () => true, customerKind: null });
      turns.push({
        cid, scene: resolveReplyScene({ customerText: custText }).scene, cust: custText, staff: staff.text!, staffAt: staff.created_at,
        greetPred: g.kind, greetReason: g.reason, prevStaffSameDayAsReply: !!prevStaff && jstDay(Date.parse(prevStaff.createdAt)) === jstDay(now),
        gapH: prevStaff ? (now - Date.parse(prevStaff.createdAt)) / 3600_000 : -1, custGreets: /お世話になっております|お世話になります|こんにちは|こんばんは|おはようございます/.test(custText),
        custSameDay: jstDay(Date.parse(list[j].created_at)) === jstDay(now), delayH: (now - Date.parse(list[j].created_at)) / 3600_000, staffLen: staff.text!.length,
      });
    }
  }
  console.log(`番 ${turns.length}`);

  // ① 挨拶
  console.log(`\n■① 挨拶（スタッフが「お世話になっております」を書いた率）× resolveGreeting の分岐`);
  const greets = (t: Turn) => /お世話になっております|お世話になります/.test(t.staff);
  const groups = new Map<string, Turn[]>();
  for (const t of turns) { const k = t.greetReason.slice(0, 40); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(t); }
  for (const [k, l] of [...groups].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${k} … n=${l.length} 挨拶 ${pct(l.filter(greets).length, l.length)}（予測 ${l[0].greetPred}）`);
  // 会話の続き（none）・標準（standard）を細かく: お客様の挨拶・間の時間
  const cont = turns.filter((t) => /会話の続き/.test(t.greetReason));
  const std = turns.filter((t) => /継続会話・当日未挨拶/.test(t.greetReason));
  const cut = (l: Turn[], label: string) => {
    console.log(`  [${label}] n=${l.length}`);
    const cells: Array<[string, (t: Turn) => boolean]> = [
      ["お客様が挨拶した", (t) => t.custGreets], ["お客様が挨拶していない", (t) => !t.custGreets],
      ["前のこちらの発言から 0-6h", (t) => t.gapH >= 0 && t.gapH < 6], ["6-12h", (t) => t.gapH >= 6 && t.gapH < 12], ["12-24h", (t) => t.gapH >= 12 && t.gapH < 24], ["24h-", (t) => t.gapH >= 24],
      ["お客様の最後の発言と返事が同じ日", (t) => t.custSameDay], ["お客様の発言の翌日以降に返事", (t) => !t.custSameDay],
      ["返事まで 1h 未満", (t) => t.delayH < 1], ["1-6h", (t) => t.delayH >= 1 && t.delayH < 6], ["6h-", (t) => t.delayH >= 6],
      ["同じ日・1h 未満", (t) => t.custSameDay && t.delayH < 1], ["同じ日・1h-", (t) => t.custSameDay && t.delayH >= 1], ["翌日以降・1h 未満", (t) => !t.custSameDay && t.delayH < 1], ["翌日以降・1h-", (t) => !t.custSameDay && t.delayH >= 1],
      ["本文 60字未満", (t) => t.staffLen < 60], ["60-120字", (t) => t.staffLen >= 60 && t.staffLen < 120], ["120字-", (t) => t.staffLen >= 120],
    ];
    for (const [n, f] of cells) { const s = l.filter(f); console.log(`    ${n}: n=${s.length} 挨拶 ${pct(s.filter(greets).length, s.length)}`); }
    for (const sc of ["ack", "question", "conditions", "property_share", "cost", "viewing", "apply", "considering", "other"] as ReplyScene[]) { const s = l.filter((t) => t.scene === sc); if (s.length >= 10) console.log(`    場面 ${REPLY_SCENE_JA[sc]}: n=${s.length} 挨拶 ${pct(s.filter(greets).length, s.length)}`); }
  };
  cut(cont, "会話の続き＝予測なし"); cut(std, "標準＝予測あり");

  // ② 開口語（場面ごと）
  console.log(`\n■② 開口語（挨拶・名前の行を除いた最初の語）`);
  const stripHead = (s: string) => s.replace(/^[^\n！!。]{0,15}(?:さん|様)[、,\s]*\n?/, "").replace(/^(?:お世話になっております|お世話になります)[😊😌]*[！!。]*\s*/, "").trim();
  for (const sc of ["ack", "considering", "question", "conditions", "property_share", "cost", "viewing", "apply", "other"] as ReplyScene[]) {
    const l = turns.filter((t) => t.scene === sc); const m = new Map<string, number>();
    for (const t of l) { const k = OPENER_JA[openerKindOf(stripHead(t.staff))]; m.set(k, (m.get(k) ?? 0) + 1); }
    console.log(`  ${REPLY_SCENE_JA[sc]} n=${l.length}: ${[...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, l.length)}`).join("・")}`);
  }
  // 質問の番: 本文の中身（答え／動く）× スタッフの開口語
  const q = turns.filter((t) => t.scene === "question");
  const cell = new Map<string, number>();
  const exMis: string[] = [];
  for (const t of q) {
    const rest = stripHead(t.staff); const op = detectOpener(rest);
    const body = op ? rest.slice(op.match.length).trim() : rest;
    const kind = classifyReplyBody(body); const k = `${kind}×${op ? op.opener : "本題から"}`;
    cell.set(k, (cell.get(k) ?? 0) + 1);
    if (kind === "undertake" && op?.opener === "hai" && exMis.length < SAMPLES) exMis.push(rest.slice(0, 90).replace(/\n/g, "⏎"));
  }
  console.log(`  質問の番の 中身×開口語: ${[...cell].sort().map(([k, v]) => `${k} ${v}`).join("・")}`);
  console.log(`  例（動く中身なのに はい）:`); for (const e of exMis) console.log(`    ${e}`);
  // 「可能です」「大丈夫です」で始まる答え（可否の質問への答え）の開口語
  const kanou = q.filter((t) => /可能(?:です|でござい)|大丈夫です|問題(?:ござい|あり)ません/.test(stripHead(t.staff)) && !/させて(?:頂|いただ)き|確認(?:致し|し|させて)|ピックアップ|お送り/.test(stripHead(t.staff)));
  const km = new Map<string, number>(); for (const t of kanou) { const op = detectOpener(stripHead(t.staff)); const k = op ? op.opener : "本題から"; km.set(k, (km.get(k) ?? 0) + 1); }
  console.log(`  質問の番で「可能です・大丈夫です」だけ（動く語なし）n=${kanou.length}: ${[...km].map(([k, v]) => `${k} ${v}`).join("・")}`);

  // ③ 表面
  console.log(`\n■③ 表面`);
  const all = turns.map((t) => t.staff);
  const lines = all.flatMap((s) => s.split("\n")).filter((l) => /\p{Extended_Pictographic}[\u{FE0F}]*$/u.test(l.trim()));
  const linesBang = all.flatMap((s) => s.split("\n")).filter((l) => /\p{Extended_Pictographic}[\u{FE0F}]*[！!]+$/u.test(l.trim()));
  console.log(`  行の終わり: 絵文字で終わる ${lines.length}・絵文字＋！で終わる ${linesBang.length}（！なし率 ${pct(lines.length, lines.length + linesBang.length)}）`);
  const ps = turns.filter((t) => t.scene === "property_share");
  const thanks = ps.filter((t) => /お部屋?お送り(?:頂|いただ)きありがとう|お送り(?:頂|いただ)きありがとう/.test(t.staff));
  console.log(`  物件を送ってきた番 n=${ps.length}: 「お送り頂きありがとう」${pct(thanks.length, ps.length)}・冒頭が かしこまりました ${pct(ps.filter((t) => /^かしこまりました/.test(stripHead(t.staff))).length, ps.length)}`);
  const nameLine = all.filter((s) => /^[^\n、！!。]{1,14}さん(?:\n|、|お世話|！|!)/.test(s));
  console.log(`  呼び名で始まる ${nameLine.length}: 呼び名の後で改行 ${pct(nameLine.filter((s) => /^[^\n、！!。]{1,14}さん\n/.test(s)).length, nameLine.length)}・続けて書く ${pct(nameLine.filter((s) => /^[^\n、！!。]{1,14}さん(?:お世話|、)/.test(s)).length, nameLine.length)}`);
  const date = all.filter((s) => /\d{1,2}\/\d{1,2}(?:日|\(|（)?[^\n]{0,6}何卒/.test(s));
  console.log(`  日付＋何卒 ${date.length}: 「M/D日」${pct(date.filter((s) => /\d{1,2}\/\d{1,2}日/.test(s)).length, date.length)}・「M/D(曜)」${pct(date.filter((s) => /\d{1,2}\/\d{1,2}[（(]/.test(s)).length, date.length)}・「M/D」だけ ${pct(date.filter((s) => /\d{1,2}\/\d{1,2}(?![日（(\d])/.test(s)).length, date.length)}`);
  const firstIntro = all.filter((s) => /はじめまして/.test(s) && /鈴木と申します/.test(s));
  console.log(`  初回の自己紹介 ${firstIntro.length}: 3文を1行 ${pct(firstIntro.filter((s) => /はじめまして[^\n]*この度[^\n]*申します/.test(s)).length, firstIntro.length)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
