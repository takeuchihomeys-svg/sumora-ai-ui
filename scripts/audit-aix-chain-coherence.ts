// AIX の1通目と、その直後に送るテンプレート（2通目）は噛み合っているか（読み取りのみ）
//
// 2026-09-20 竹内「AIX テンプレート、AIX の内容との関係性での生成が重要なので、そこも調査・テストして改善」
//
// ■ 見つけた非対称（コード）
//   画面（TemplateModal）は postAixContext.sentMessage ＝**直前に AIX で送った本文**を持っていて、
//   推薦 API（recommend-templates）には sent_message として渡している。
//   しかし**生成 API（aix-template-generate）には渡していない**（actionType / recentMessages だけ）。
//   設計知見「出口を5回足しても形を変えて出続けた — AI が『材料が無い』と言い出したら、それは入口の問題」
//   （見積書の2通目に物件名を1つも渡していなかった事例）と**まったく同じ構造**。
//
// ■ ここで測ること
//   実送信で「AIX の1通目 → その直後のスタッフ送信（2通目）」のペアを作り、
//   ①スタッフは2通目に何を書いているか（＝正解の型）
//   ②生成文（ai_reply_examples の aix_template 由来）は1通目と噛み合っているか
//   ③噛み合っていない形（重複宣言・時制のねじれ・挨拶の重ね）が何件あるか
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 1通目が「もう済んだ」と言っている形（2通目で未来形にすると重複宣言になる） */
const DONE_RE = {
  pickup: /ピックアップ(?:させて(?:頂|いただ)き|いたし|致し)ました|お送り(?:させて(?:頂|いただ)き|いたし|致し)ました/,
  check: /確認(?:させて(?:頂|いただ)き|いたし|致し)ました|募集(?:が)?(?:御座|ござ)いません(?:でした)?/,
  estimate: /(?:御|お)?見積(?:書|り)?[^\n。！!]{0,10}(?:お送り|送付)(?:させて(?:頂|いただ)き|いたし|致し)ました|初期費用[：:]/,
  receipt: /ご査収/,
  greet: /お世話になっております|お待たせ(?:致|いた)?しました|はじめまして/,
};
/** 2通目が「これからやる」と言っている形 */
const FUTURE_RE = {
  pickup: /ピックアップ[^\n。！!]{0,14}(?:させて(?:頂|いただ)き|いたし|致し|し)ます|お送り(?:させて(?:頂|いただ)き|いたし|致し|し)ます|お探し(?:させて(?:頂|いただ)き|いたし|致し|し)ます/,
  check: /確認(?:させて(?:頂|いただ)き|いたし|致し|し)ます/,
  estimate: /(?:御|お)?見積(?:書|り)?[^\n。！!]{0,14}(?:作成|お送り|ご用意)(?:させて(?:頂|いただ)き|いたし|致し|し)ます/,
};

async function page(table: string, select: string, order: string, days: number): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 14; p++) {
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
  const days = Number(process.env.DAYS ?? 90);

  // AIX 送信（aix_usage_logs）とその会話のスタッフ送信
  const logs = await page("aix_usage_logs", "conversation_id, aix_type, sent_at, created_at, generated_text", "created_at", days);
  const convIds = [...new Set(logs.map((l) => String(l.conversation_id ?? "")).filter(Boolean))];
  const msgs: Array<{ conversation_id: string; text: string | null; created_at: string; is_aix_generated: boolean | null }> = [];
  for (let i = 0; i < convIds.length; i += 20) {
    const chunk = convIds.slice(i, i + 20);
    for (let p = 0; p < 10; p++) {
      const { data } = await sb.from("messages").select("conversation_id, text, created_at, is_aix_generated")
        .in("conversation_id", chunk).eq("sender", "staff")
        .gte("created_at", new Date(Date.now() - days * 86400_000).toISOString())
        .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
      const r = (data ?? []) as typeof msgs;
      if (r.length === 0) break;
      msgs.push(...r);
      if (r.length < 1000) break;
    }
  }
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }
  for (const [, l] of byConv) l.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  // ── ① 1通目 → 2通目 のペアを作る（AIX 送信の後 30分以内の次のスタッフ送信）──
  type Pair = { aix: string; first: string; second: string; gapMin: number };
  const pairs: Pair[] = [];
  for (const l of logs) {
    const c = String(l.conversation_id ?? "");
    const t = Date.parse(String(l.sent_at ?? l.created_at));
    if (!c || Number.isNaN(t)) continue;
    const list = byConv.get(c) ?? [];
    // 1通目 = AIX の時刻に最も近いスタッフ送信（±5分）
    const first = list.find((m) => Math.abs(Date.parse(m.created_at) - t) <= 5 * 60_000 && (m.text ?? "").length > 15 && !/^\[/.test(m.text ?? ""));
    if (!first) continue;
    const ft = Date.parse(first.created_at);
    const second = list.find((m) => Date.parse(m.created_at) > ft && Date.parse(m.created_at) <= ft + 30 * 60_000 && (m.text ?? "").length > 15 && !/^\[/.test(m.text ?? ""));
    if (!second) continue;
    pairs.push({ aix: String(l.aix_type ?? "?"), first: String(first.text), second: String(second.text), gapMin: Math.round((Date.parse(second.created_at) - ft) / 60_000) });
  }
  console.log(`=== ① AIX の1通目 → 30分以内の2通目 のペア: ${pairs.length}組（直近${days}日）===`);
  const byAix = new Map<string, number>();
  for (const p of pairs) byAix.set(p.aix, (byAix.get(p.aix) ?? 0) + 1);
  for (const [k, n] of [...byAix.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`     ${String(n).padStart(4)}組  ${k}`);

  if (pairs.length === 0) { console.log("   ペアが取れない（測り方を見直す）"); return; }

  // ── ② スタッフの2通目は1通目と噛み合っているか（＝正解の型）──
  console.log(`\n=== ② スタッフの2通目（${pairs.length}組）の型 ===`);
  const stat = (label: string, fn: (p: Pair) => boolean) => {
    const n = pairs.filter(fn).length;
    console.log(`   ${label.padEnd(46)} ${String(n).padStart(4)}組 (${((n / pairs.length) * 100).toFixed(1)}%)`);
  };
  stat("1通目が「ピックアップしました」（完了）", (p) => DONE_RE.pickup.test(p.first));
  stat("  → 2通目で「ピックアップします」（未来・重複宣言）", (p) => DONE_RE.pickup.test(p.first) && FUTURE_RE.pickup.test(p.second));
  stat("1通目が「確認しました」（完了）", (p) => DONE_RE.check.test(p.first));
  stat("  → 2通目で「確認します」（未来・重複宣言）", (p) => DONE_RE.check.test(p.first) && FUTURE_RE.check.test(p.second));
  stat("1通目に「ご査収」", (p) => DONE_RE.receipt.test(p.first));
  stat("  → 2通目にも「ご査収」（重ね）", (p) => DONE_RE.receipt.test(p.first) && DONE_RE.receipt.test(p.second));
  stat("1通目に挨拶（お世話に／お待たせ／はじめまして）", (p) => DONE_RE.greet.test(p.first));
  stat("  → 2通目にも挨拶（重ね）", (p) => DONE_RE.greet.test(p.first) && DONE_RE.greet.test(p.second));
  const gaps = pairs.map((p) => p.gapMin).sort((a, b) => a - b);
  console.log(`   2通目までの間隔: 中央値 ${gaps[Math.floor(gaps.length / 2)]}分（25% ${gaps[Math.floor(gaps.length * 0.25)]} / 75% ${gaps[Math.floor(gaps.length * 0.75)]}）`);

  // ── ③ スタッフの2通目は何を書いているか（言い回しの型）──
  console.log(`\n=== ③ スタッフの2通目の中身（上位の言い回し）===`);
  const PHRASE: Array<[string, RegExp]> = [
    ["内覧の誘導（ご案内させて頂きます）", /ご案内(?:させて(?:頂|いただ)き|いたし|致し)ます/],
    ["申込の誘導（お申込み…押さえ）", /お?申(?:し)?込[^\n。！!]{0,14}(?:押さえ|抑え)/],
    ["1件に絞ったオススメ（特に）", /(?:の中でも)?特に[^\n。！!]{0,20}(?:オススメ|おすすめ)/],
    ["見積書の案内", /(?:御|お)?見積(?:書|り)?/],
    ["気に召されましたら", /お気に召され/],
    ["ご質問・気になる点", /気になる点|ご不明|ご質問/],
    ["全力でサポート", /全力でサポート/],
    ["ごゆっくりご検討", /ごゆっくりご(?:検討|確認|相談)/],
    ["物件名（号室）を書く", /[0-9０-９]{2,4}号室|🌟/],
    ["条件の復唱（万・LDK・築）", /[0-9０-９]{1,3}[\.．]?[0-9０-９]{0,2}万|[0-9０-９]{1,2}[LDKSldks]{1,4}|築[0-9０-９]{1,2}/],
  ];
  for (const [label, re] of PHRASE) {
    const n = pairs.filter((p) => re.test(p.second)).length;
    console.log(`   ${label.padEnd(36)} ${String(n).padStart(4)}組 (${((n / pairs.length) * 100).toFixed(1)}%)`);
  }
  const lens = pairs.map((p) => p.second.length).sort((a, b) => a - b);
  console.log(`   2通目の長さ: 中央値 ${lens[Math.floor(lens.length / 2)]}字（25% ${lens[Math.floor(lens.length * 0.25)]} / 75% ${lens[Math.floor(lens.length * 0.75)]}）`);

  // ── ③-2 作った純関数を全件に当てる（誤検知が無いか目で読む）──
  //   設計知見「全件監査（過去の実送信に当てて、変換の前後を目で読む。件数だけ見ない）」
  {
    const { readFirstMessage, buildAixChainNote } = await import("../app/lib/aix-chain-note");
    let withNote = 0;
    const doneCount = new Map<string, number>();
    let labelTotal = 0;
    const suspiciousLabels: string[] = [];
    for (const p of pairs) {
      const f = readFirstMessage(p.first);
      if (buildAixChainNote(p.first)) withNote++;
      for (const d of f.declaredDone) doneCount.set(d, (doneCount.get(d) ?? 0) + 1);
      labelTotal += f.propertyLabels.length;
      // 物件名らしくない物が混ざっていないか（数字だけ・費用の語・長すぎ・短すぎ）
      for (const l of f.propertyLabels) {
        if (/家賃|管理費|合計|初期費用|敷金|礼金|徒歩|築|割引|節約|円/.test(l) || l.replace(/\s*\d+号室$/, "").trim().length < 2) {
          if (suspiciousLabels.length < 20) suspiciousLabels.push(l);
        }
      }
    }
    console.log(`\n=== ③-2 buildAixChainNote を1通目 ${pairs.length}件に当てた結果 ===`);
    console.log(`   指示ブロックが出る: ${withNote}件 (${((withNote / pairs.length) * 100).toFixed(1)}%)`);
    console.log(`   読み取れた「済んだこと」:`);
    for (const [k, n] of [...doneCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(5)}件  ${k}`);
    console.log(`   抽出した物件名: 合計 ${labelTotal}件`);
    console.log(`   物件名らしくない抽出（誤検知の疑い）: ${suspiciousLabels.length}件`);
    for (const l of suspiciousLabels) console.log(`     ⚠ 「${l}」`);
    if (suspiciousLabels.length === 0) console.log(`     （0件＝費用の行や数字を物件名と間違えていない）`);

    // 実物の指示ブロックを1つ読む
    const sample = pairs.find((p) => buildAixChainNote(p.first));
    if (sample) {
      console.log(`\n   --- 実際に渡る指示ブロック（1件・目で読む）---`);
      console.log(buildAixChainNote(sample.first).split("\n").map((l) => `     ${l}`).join("\n"));
    }
  }

  // ── ④ 実物（1通目と2通目を並べて読む）──
  console.log(`\n=== ④ 実物（8組・1通目と2通目を並べて読む）===`);
  for (const p of pairs.slice(0, 8)) {
    console.log(`\n   ── [${p.aix}] ${p.gapMin}分後`);
    console.log(`   1通目: ${p.first.replace(/\n/g, " ／ ").slice(0, 130)}`);
    console.log(`   2通目: ${p.second.replace(/\n/g, " ／ ").slice(0, 130)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
