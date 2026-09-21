// 開口語を「場面 × 成約データ／直近」で数える（読み取りのみ）
//
// 2026-09-21 竹内「一択と指摘するんじゃなくて実際の成約データや直近の会話から学習して、
//   場面でいれるかどうかはブレインに判断させる。そのためにもブレインはあるのだから（文の構成等）」
//
// final-check は今こう書いてある（決めつけ）:
//   感謝返し・短い了承・強推し直後・一時保留・検討中フォロー → 「はい😊！！」一択
//   条件提示・内覧キャンセル・顧客自身の断り                → 「かしこまりました！！」一択
// これを実測に置き換える。設計知見「必須にしてよいのは過半数が守っている形だけ」。
//
// 場面は「直前のお客様の発言」で決める（final-check の TPO ラベルの代わり。
//   過去データに TPO ラベルは残っていないので、同じ材料から決め直す）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-opener-by-scene.ts
import { createClient } from "@supabase/supabase-js";
import { isShortAckOnly } from "../app/lib/previous-send-note";
import { isConditionFormMessage } from "../app/lib/reply-context";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

async function page(table: string, select: string, order: string, days: number | null) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 40; p++) {
    let q = sb.from(table).select(select).order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (days) q = q.gte(order, new Date(Date.now() - days * 86400_000).toISOString());
    const { data, error } = await q;
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

/** 開口語（本文の1行目で見る。greeting.ts の detectOpener と同じ語） */
function openerOf(text: string): string {
  const first = (text.split("\n").map((l) => l.trim()).find(Boolean) ?? "");
  if (/^かしこまりました/.test(first)) return "かしこまりました";
  if (/^[はハ]い/.test(first)) return "はい";
  if (/^(?:承知|了解)/.test(first)) return "承知／了解";
  if (/はじめまして/.test(first)) return "はじめまして（初回）";
  if (/お世話になっております/.test(first)) return "お世話になっております";
  if (/^[^\n。！!]{0,20}(?:お送り|ご連絡|ご記入|ご入力)(?:頂|いただ)き[^\n。！!]{0,4}ありがとう/.test(first)) return "〇〇頂きありがとうございます（目的語あり）";
  if (/^ありがとうございます/.test(first)) return "ありがとうございます（目的語なし）";
  return "開口語なし（本題から）";
}

/** 場面（直前のお客様の発言で決める。final-check の TPO ラベルに対応させる） */
function sceneOf(customerText: string): string {
  const t = (customerText ?? "").trim();
  if (!t) return "（不明）";
  if (isConditionFormMessage(t)) return "条件フォーム受領";
  if (/[?？]|ですか|でしょうか|いくら|どれくらい|どのくらい/.test(t)) return "質問";
  if (/見送|やめ|キャンセル|他で決め|白紙|辞退/.test(t)) return "断り・キャンセル";
  if (/(?:^|\n)[^\n]{0,40}(?:万|円|LDK|DK|駅|徒歩|ペット|駐車場|築|階)/.test(t) && t.length <= 120) return "条件提示";
  if (isShortAckOnly(t)) return "短い了承・お礼";
  if (/検討|考え|相談し|持ち帰|後で|出先|仕事中/.test(t)) return "検討中・一時保留";
  return "その他";
}

const pct = (a: number, b: number) => b ? `${(a / b * 100).toFixed(1)}%` : "-";

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const msgs = await page("messages", "conversation_id, sender, text, created_at", "created_at", days);
  const convs = await page("conversations", "id, status", "created_at", null);
  const statusOf = new Map<string, string>();
  for (const c of convs) statusOf.set(String(c.id), String(c.status ?? ""));
  console.log(`=== 材料: messages ${msgs.length}件 / conversations ${convs.length}件 ===\n`);

  const byConv = new Map<string, Array<{ sender: string; text: string; at: number }>>();
  for (const m of msgs) {
    const cid = String(m.conversation_id ?? ""); const t = String(m.text ?? "").trim();
    if (!cid || !t) continue;
    if (!byConv.has(cid)) byConv.set(cid, []);
    byConv.get(cid)!.push({ sender: String(m.sender ?? ""), text: t, at: new Date(String(m.created_at)).getTime() });
  }
  for (const a of byConv.values()) a.sort((x, y) => x.at - y.at);

  // 母集団: ① 全体 ② 成約（closed_won） ③ 直近30日
  const WON = new Set(["closed_won", "contract", "approved"]);
  const recentFrom = Date.now() - 30 * 86400_000;
  type Cell = Map<string, Map<string, number>>;   // 場面 → 開口語 → 件数
  const cells: Record<string, Cell> = { 全体: new Map(), 成約: new Map(), 直近30日: new Map() };
  const totals: Record<string, Map<string, number>> = { 全体: new Map(), 成約: new Map(), 直近30日: new Map() };

  const add = (pop: string, scene: string, opener: string) => {
    if (!cells[pop].has(scene)) cells[pop].set(scene, new Map());
    const m = cells[pop].get(scene)!;
    m.set(opener, (m.get(opener) ?? 0) + 1);
    totals[pop].set(scene, (totals[pop].get(scene) ?? 0) + 1);
  };

  for (const [cid, arr] of byConv) {
    const won = WON.has(statusOf.get(cid) ?? "");
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i].sender !== "customer") continue;
      // お客様の連投を結合 → 次のスタッフ送信
      let k = i; const cust: string[] = [];
      while (k < arr.length && arr[k].sender === "customer") { cust.push(arr[k].text); k++; }
      const next = arr[k];
      if (!next || next.sender !== "staff") continue;
      if (/^\[画像\]|^https?:\/\//.test(next.text.trim())) continue;   // 画像・URLだけは開口語が無い
      const scene = sceneOf(cust.join("\n"));
      const op = openerOf(next.text);
      add("全体", scene, op);
      if (won) add("成約", scene, op);
      if (next.at >= recentFrom) add("直近30日", scene, op);
      i = k - 1;
    }
  }

  for (const pop of ["全体", "成約", "直近30日"]) {
    console.log(`\n${"═".repeat(76)}`);
    console.log(`=== ${pop} ===`);
    const scenes = [...totals[pop].entries()].sort((a, b) => b[1] - a[1]);
    for (const [scene, n] of scenes) {
      if (n < 15) continue;
      const m = cells[pop].get(scene)!;
      const top = [...m.entries()].sort((a, b) => b[1] - a[1]);
      console.log(`\n   【${scene}】${n}件`);
      for (const [op, c] of top) {
        const bar = "█".repeat(Math.round(c / n * 30));
        console.log(`     ${pct(c, n).padStart(6)}  ${String(c).padStart(4)}件  ${op.padEnd(30)} ${bar}`);
      }
      const first = top[0];
      console.log(`     → 一番多いのは「${first[0]}」${pct(first[1], n)}${first[1] / n >= 0.5 ? "（過半数＝必須にできる）" : "（過半数に届かない＝一択にできない）"}`);
    }
  }

  // final-check が今している決めつけと突き合わせる
  console.log(`\n${"═".repeat(76)}`);
  console.log(`=== final-check の決めつけを実測で検算 ===`);
  const check = (scene: string, want: string) => {
    for (const pop of ["全体", "成約", "直近30日"]) {
      const n = totals[pop].get(scene) ?? 0;
      if (n < 15) { console.log(`   ${pop.padEnd(8)} 【${scene}】 件数不足(${n})`); continue; }
      const c = cells[pop].get(scene)!.get(want) ?? 0;
      console.log(`   ${pop.padEnd(8)} 【${scene}】 「${want}」は ${String(c).padStart(4)}/${String(n).padEnd(4)} = ${pct(c, n)}  ${c / n >= 0.5 ? "✅ 過半数" : "❌ 一択にできない"}`);
    }
  };
  console.log(`\n  ① 「感謝・了承・保留の場面の開口語は『はい😊！！』一択」`);
  check("短い了承・お礼", "はい");
  check("検討中・一時保留", "はい");
  console.log(`\n  ② 「条件提示・断り受け止めの場面の開口語は『かしこまりました！！』一択」`);
  check("条件提示", "かしこまりました");
  check("断り・キャンセル", "かしこまりました");
  check("条件フォーム受領", "かしこまりました");
}
main().catch((e) => { console.error(e); process.exit(1); });
