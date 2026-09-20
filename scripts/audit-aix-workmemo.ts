// AI の作業メモ・思考過程が下書きに出ている件（読み取りのみ）
//
// 2026-09-20 竹内「AIX で送ったあとの AIX テンプレートの文の質を上げる」→ 差分を読むと
//   生成文の先頭に **AI の思考過程がそのまま**出ていた:
//     「まず物件情報を確認します。／- 物件名：…／- 敷金：なし　礼金：なし → 敷金礼金なし ✅」
//     「いくつか確認してから出力します。／**築年確認：**／→ お客様の「築30年以内」という希望を超えています。」
//     「物件資料を確認します。／- 物件名：フレンシアノイエ難波南 308号室 …」
//   竹内さんの絶対ルール「AI作業メモは下書き欄に絶対入れない」（2回指摘済み）に違反する形。
//
// 設計知見「おかしな文を1通見つけた時」の順番でやる:
//   ①実物を持ってくる（上の3通）②出所を追う ③実送信で線を引く ④誤削除0の線 ⑤入口か出口か
//   ここは ②③④ の材料を出す。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/**
 * 作業メモの形（実物から取る）。
 * ⚠ 出口に使うなら「実送信に0通」でなければ入れられないので、実送信での件数も同時に数える。
 */
const MEMO: Array<{ key: string; re: RegExp }> = [
  { key: "A 〜を確認します／確認してから出力します で始まる", re: /^[^\n]{0,20}(?:確認します|確認してから出力します|確認いたします)[。\s]*$/m },
  { key: "B 「まず」で始まる前置き", re: /^まず[^\n]{0,40}(?:します|ます)[。\s]*$/m },
  { key: "C 見出し「**〇〇確認：**」", re: /\*\*[^\n*]{1,14}確認[：:]\*\*/ },
  { key: "D 箇条書きの資料転記（- 物件名：/ - 家賃：）", re: /^-\s*(?:物件名|家賃|敷金|礼金|間取り|築年|交通)[：:]/m },
  { key: "E チェック印 ✅ ／ 矢印での判定", re: /→[^\n]{0,30}(?:✅|OK|超えています|満たして)/ },
  { key: "F お客様の希望と照らす独り言", re: /お客様の「[^」]{1,20}」という(?:希望|ご希望|条件)/ },
  { key: "G 出力の宣言", re: /(?:以下|次)(?:に|の(?:とおり|通り))[^\n]{0,14}出力|として出力(?:し|いたし)ます/ },
  { key: "H できない宣言", re: /出力(?:は|を)?行(?:い|え)ま?せん|入力内容が存在しない|情報が(?:不足|足りません)/ },
];

const looksLikeMemo = (t: string) => MEMO.some((m) => m.re.test(t));

async function page(table: string, select: string, order: string, days: number): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 12; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = Number(process.env.DAYS ?? 180);

  // ── ① 生成文（ai_draft）に何件あるか ──
  const ex = await page("ai_reply_examples", "id, conversation_id, ai_draft, sent_reply, entry_source, aix_action, created_at", "created_at", days);
  const drafts = ex.filter((r) => {
    const d = String(r.ai_draft ?? "");
    return d && d !== "__SHOWN__" && d.length > 6;
  });
  const memoDrafts = drafts.filter((r) => looksLikeMemo(String(r.ai_draft)));
  console.log(`=== ① 生成文（ai_reply_examples.ai_draft）${drafts.length}件 ===`);
  console.log(`   作業メモの形を含む: ${memoDrafts.length}件 (${drafts.length ? ((memoDrafts.length / drafts.length) * 100).toFixed(1) : "-"}%)\n`);
  console.log(`   ${"形".padEnd(44)} 生成文  実送信`);
  const sentAll = ex.map((r) => String(r.sent_reply ?? "")).filter((s) => s && s.length > 6);
  for (const m of MEMO) {
    const a = drafts.filter((r) => m.re.test(String(r.ai_draft))).length;
    const b = sentAll.filter((s) => m.re.test(s)).length;
    console.log(`   ${m.key.padEnd(44)} ${String(a).padStart(5)}  ${String(b).padStart(5)}${b === 0 ? "  ← 実送信0（出口に使える）" : "  ⚠ 実送信にもある"}`);
  }

  // ── ② どの経路・どの AIX で起きているか ──
  console.log(`\n=== ② どこで起きているか ===`);
  const byKey = new Map<string, number>();
  for (const r of memoDrafts) {
    const k = `${r.entry_source ?? "?"} / ${r.aix_action ?? "-"}`;
    byKey.set(k, (byKey.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`     ${String(n).padStart(4)}件  ${k}`);

  // ── ③ いつから増えたか（DeepSeek 切り替え等との相関を見る）──
  console.log(`\n=== ③ 月別（いつから出ているか）===`);
  const byMonth = new Map<string, { n: number; memo: number }>();
  for (const r of drafts) {
    const mth = String(r.created_at ?? "").slice(0, 7);
    if (!byMonth.has(mth)) byMonth.set(mth, { n: 0, memo: 0 });
    byMonth.get(mth)!.n++;
    if (looksLikeMemo(String(r.ai_draft))) byMonth.get(mth)!.memo++;
  }
  for (const [k, v] of [...byMonth.entries()].sort()) {
    console.log(`     ${k}  生成 ${String(v.n).padStart(4)}件 / 作業メモ ${String(v.memo).padStart(4)}件 (${((v.memo / v.n) * 100).toFixed(1)}%)`);
  }

  // ── ④ 実物（出所を追うために全文の冒頭を読む）──
  console.log(`\n=== ④ 実物（10件・冒頭200字）===`);
  for (const r of memoDrafts.slice(0, 10)) {
    const hits = MEMO.filter((m) => m.re.test(String(r.ai_draft))).map((m) => m.key[0]).join("");
    console.log(`\n   ── [${r.entry_source} / ${r.aix_action ?? "-"}] 形=${hits} ${String(r.created_at).slice(0, 10)}`);
    console.log(`   ${String(r.ai_draft).replace(/\n/g, " ／ ").slice(0, 200)}`);
  }

  // ── ⑤ 送られてしまった物はあるか（下書きのまま送信された＝最悪の形）──
  console.log(`\n=== ⑤ 実際にお客様へ送られたか ===`);
  const sentMemo = ex.filter((r) => {
    const s = String(r.sent_reply ?? "");
    return s && s.length > 6 && looksLikeMemo(s);
  });
  console.log(`   実送信に作業メモの形が入っている: ${sentMemo.length}件`);
  for (const r of sentMemo.slice(0, 5)) {
    console.log(`     [${r.entry_source} / ${r.aix_action ?? "-"}] ${String(r.sent_reply).replace(/\n/g, " ／ ").slice(0, 150)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
