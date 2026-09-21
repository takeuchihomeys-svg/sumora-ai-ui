// 開口語・「何卒よろしくお願い致します」・改行の型を実送信から測る（読み取りのみ）
//
// 2026-09-21 竹内:
//   「最終チェックの部分でかしこまりましたで文送る指摘あるのに改善されていない。
//     なぜかしこまりましたにへんこうできていなかったのか」
//   「何卒よろしくお願い致します！！ で文終わる場面と、いれない場面あるからそこの違いもちゃんと学習する」
//   「文の改行している場所を実際の送っている文から特徴把握して改善する」
//
// ① なぜ「かしこまりました」にならなかったか:
//    greeting.ts の conditionFormThanks（竹内 2026-09-12 あや事例）が
//    **先頭に必ず「ご条件お送り頂きありがとうございます😊！！」を足す**作りになっている。
//    一方 final-check は「条件提示・断り受け止めの場面の開口語は かしこまりました！！ 一択」と言う。
//    ＝ 同じ事実について「書け」と「書くな」を別の場所から渡している（設計知見が最も危険とする形）。
//    どちらが正しいかは**実送信で決める**。それがこの監査。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-opening-closing-newline.ts
import { createClient } from "@supabase/supabase-js";
import { isConditionFormMessage } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function page(table: string, select: string, order: string, days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様|さま)/g, "〈お客様〉");
const pct = (a: number, b: number) => b ? `${(a / b * 100).toFixed(1)}%` : "-";

/** 開口語の種類（本文の1行目で見る） */
function openerOf(text: string): string {
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  if (/^かしこまりました/.test(first)) return "かしこまりました";
  if (/^[はハ]い/.test(first)) return "はい";
  if (/ご?条件[^\n。！!]{0,8}お送り(?:頂|いただ)き[^\n。！!]{0,4}ありがとう|ご(?:入力|記入)(?:頂|いただ)き[^\n。！!]{0,4}ありがとう/.test(first)) return "ご条件お送り頂きありがとうございます";
  if (/^(?:承知|了解)/.test(first)) return "承知／了解";
  if (/お世話になっております/.test(first)) return "お世話になっております";
  if (/はじめまして/.test(first)) return "はじめまして（初回）";
  if (/ありがとうございます/.test(first)) return "ありがとうございます（目的語なし）";
  return "その他（本題から）";
}

/** スタッフ送信の種類（何卒・改行の型を場面で割るため。本文の中身で決める） */
function kindOf(text: string): string {
  const t = text;
  if (/^\[画像\]|^https?:\/\//.test(t.trim())) return "画像・URLのみ";
  // ⚠ 見積書を先に見る（見積書の本文は「【〇〇 202号室】」で始まるので、物件カードが先だと全部そちらに入る）
  if (/御見積書|初期費用：|初期費用さらに/.test(t)) return "見積書";
  if (/🌟|【[^】\n]{2,28}\s*[0-9０-９]{2,4}\s*号?室?】/u.test(t)) return "物件カード";
  if (/ご査収/.test(t)) return "物件・書類の送付（ご査収）";
  if (/現地エントランス|お待ち合わせ|集合場所/.test(t)) return "内覧の待ち合わせ";
  if (/ご案内させて(?:頂|いただ)き|ご内覧/.test(t)) return "内覧の案内";
  if (/ピックアップ(?:させて|し)/.test(t)) return "ピックアップの約束";
  if (/確認(?:させて|して|致し|いたし)/.test(t)) return "確認の約束";
  if (/お申込|申込フォーム|記入欄/.test(t)) return "申込";
  if (t.replace(/\s/g, "").length <= 60) return "短い返し";
  return "その他";
}

const NANITOZO_RE = /何卒(?:よろしく|宜しく)お願い(?:致します|いたします|します)/;

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const msgs = await page("messages", "conversation_id, sender, text, created_at", "created_at", days);
  console.log(`=== 材料: messages ${msgs.length}件（直近${days}日）===\n`);

  const byConv = new Map<string, Array<{ sender: string; text: string; at: number }>>();
  for (const m of msgs) {
    const cid = String(m.conversation_id ?? ""); const t = String(m.text ?? "").trim();
    if (!cid || !t) continue;
    if (!byConv.has(cid)) byConv.set(cid, []);
    byConv.get(cid)!.push({ sender: String(m.sender ?? ""), text: t, at: new Date(String(m.created_at)).getTime() });
  }
  for (const a of byConv.values()) a.sort((x, y) => x.at - y.at);

  // ═══ ① 条件フォームを送ってくれた直後、スタッフは何で書き出しているか ═══
  console.log(`=== ① お客様が条件フォームを送った直後のスタッフ返信の開口語 ===`);
  const formOpeners = new Map<string, number>();
  const formSamples: string[] = [];
  let formCases = 0;
  for (const [, arr] of byConv) {
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i].sender !== "customer" || !isConditionFormMessage(arr[i].text)) continue;
      const next = arr[i + 1];
      if (!next || next.sender !== "staff") continue;
      formCases++;
      const o = openerOf(next.text);
      formOpeners.set(o, (formOpeners.get(o) ?? 0) + 1);
      if (formSamples.length < 8) formSamples.push(`     ${mask(next.text).split("\n").slice(0, 3).join(" ／ ").slice(0, 120)}`);
    }
  }
  console.log(`   場面 ${formCases}件`);
  for (const [k, c] of [...formOpeners.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(c).padStart(4)}件 (${pct(c, formCases).padStart(6)})  ${k}`);
  }
  console.log(`   実物:`);
  for (const s of formSamples) console.log(s);

  // ═══ ② 「何卒よろしくお願い致します」を付ける場面・付けない場面 ═══
  console.log(`\n=== ② 「何卒よろしくお願い致します」の有無（スタッフ実送信）===`);
  const staff = msgs.filter((m) => String(m.sender) === "staff").map((m) => String(m.text ?? "").trim()).filter(Boolean);
  const byKind = new Map<string, { n: number; yes: number }>();
  for (const t of staff) {
    const k = kindOf(t);
    const b = byKind.get(k) ?? { n: 0, yes: 0 };
    b.n++; if (NANITOZO_RE.test(t)) b.yes++;
    byKind.set(k, b);
  }
  const allYes = staff.filter((t) => NANITOZO_RE.test(t)).length;
  console.log(`   全体 ${allYes}/${staff.length} = ${pct(allYes, staff.length)}`);
  console.log(`   場面別（多い順）:`);
  for (const [k, v] of [...byKind.entries()].sort((a, b) => b[1].yes / b[1].n - a[1].yes / a[1].n)) {
    if (v.n < 20) continue;
    console.log(`     ${pct(v.yes, v.n).padStart(6)}  ${String(v.yes).padStart(4)}/${String(v.n).padEnd(5)}  ${k}`);
  }
  // 位置（最後の行か・途中か）
  const lastLineYes = staff.filter((t) => {
    const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.length > 0 && NANITOZO_RE.test(lines[lines.length - 1]);
  }).length;
  console.log(`   「何卒」が入る文のうち、**最終行**にあるのは ${lastLineYes}/${allYes} = ${pct(lastLineYes, allYes)}`);

  // ═══ ③ 改行の型 ═══
  console.log(`\n=== ③ 改行の型（スタッフ実送信）===`);
  type Shape = { n: number; lines: number[]; blanks: number[]; lineLens: number[] };
  const shapes = new Map<string, Shape>();
  for (const t of staff) {
    const k = kindOf(t);
    const s = shapes.get(k) ?? { n: 0, lines: [], blanks: [], lineLens: [] };
    const raw = t.split("\n");
    const nonEmpty = raw.filter((l) => l.trim());
    s.n++;
    s.lines.push(nonEmpty.length);
    s.blanks.push(raw.length - nonEmpty.length);
    for (const l of nonEmpty) s.lineLens.push(l.replace(/\s/g, "").length);
    shapes.set(k, s);
  }
  const med = (a: number[]) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const q = (a: number[], p: number) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length * p)] ?? 0; };
  console.log(`   場面ごとの「行数 / 空行数 / 1行の文字数」（中央値）`);
  for (const [k, s] of [...shapes.entries()].sort((a, b) => b[1].n - a[1].n)) {
    if (s.n < 20) continue;
    console.log(`     ${String(s.n).padStart(5)}通  行${String(med(s.lines)).padStart(2)}  空行${String(med(s.blanks)).padStart(2)}  1行${String(med(s.lineLens)).padStart(3)}字（上位25% ${q(s.lineLens, 0.75)}字 / 上位10% ${q(s.lineLens, 0.9)}字）  ${k}`);
  }
  const allLens = staff.flatMap((t) => t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/\s/g, "").length));
  console.log(`\n   全体の1行の長さ: 中央値 ${med(allLens)}字 / 上位25% ${q(allLens, 0.75)}字 / 上位10% ${q(allLens, 0.9)}字 / 上位1% ${q(allLens, 0.99)}字`);
  const allLines = staff.map((t) => t.split("\n").filter((l) => l.trim()).length);
  console.log(`   全体の行数: 中央値 ${med(allLines)}行 / 上位25% ${q(allLines, 0.75)}行 / 上位10% ${q(allLines, 0.9)}行`);
  // 空行の入れ方（段落の作り方）
  const withBlank = staff.filter((t) => /\n[ \t　]*\n/.test(t)).length;
  console.log(`   空行（段落の区切り）を使っている文: ${withBlank}/${staff.length} = ${pct(withBlank, staff.length)}`);
  const multiLine = staff.filter((t) => t.split("\n").filter((l) => l.trim()).length >= 2);
  const blankInMulti = multiLine.filter((t) => /\n[ \t　]*\n/.test(t)).length;
  console.log(`   2行以上の文に限ると: ${blankInMulti}/${multiLine.length} = ${pct(blankInMulti, multiLine.length)}`);

  console.log(`\n=== ④ 改行の実物（短い返し・5通）===`);
  for (const t of staff.filter((x) => kindOf(x) === "短い返し").slice(0, 5)) {
    console.log(`${"─".repeat(70)}`);
    console.log(mask(t).split("\n").map((l) => `     |${l}`).join("\n"));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
