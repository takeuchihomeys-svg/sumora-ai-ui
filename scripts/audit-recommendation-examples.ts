// AIX【物件オススメ】の手本（few-shot に入る実例）の質（読み取りのみ）
//
// 2026-09-21 竹内「別のスタッフが送ってる質の悪い言い回しもあるから、そこも含めて改善する。直近の会話をみて。」
//
// ■ 設計知見
//   「実例（⭐固定シード）の偏りがフレーム選択をLLMに引き起こす」
//     → 具体的な実例の文体は**プロンプトの指示を上回る**。手本が悪いと指示で直しても戻る。
//   「生成失敗文は example-hygiene.ts の isUsableExampleText で全ての学習・few-shot から除外」
//     → 除外の仕組みは既にある。**それが今の手本で何を捕まえているか**を測る。
//
// ■ 測ること
//   ① 手本の母集団（☆付き・aix_template・property_recommendation）
//   ② 既にある関門（isUsableExampleText / isCustomerFacingExample）が何件落とすか
//   ③ 関門を通るのに質が低い形（名前だけの行・画像の注記・作業メモ・極端に短い/長い）
//   ④ 冒頭フレームの偏り（どのシナリオでも同じ言い回しに引っ張られていないか）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-recommendation-examples.ts
import { createClient } from "@supabase/supabase-js";
import { isUsableExampleText, isCustomerFacingExample } from "../app/lib/example-hygiene";
import { COMPARE_FRAME_RE, NEW_LISTING_FRAME_RE } from "../app/lib/recommendation-frame";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const mask = (s: string) => s.replace(/[^\s、。！!？?]{1,12}(?:さん|様|さま)/g, "〈お客様〉");

/** 手本として質が低い形（＝ AI が真似すると困る物） */
const LOW_QUALITY: Array<[string, (t: string) => boolean]> = [
  ["名前だけの行で終わる", (t) => /^[^\n]{1,14}(?:さん|様)\s*$/.test(t.trim())],
  ["画像・資料の注記だけ", (t) => /^[（(](?:室内|外観|間取り|図面|画像|写真)[^\n]{0,10}[）)]\s*$/.test(t.trim())],
  ["作業メモ・システム注記が混ざる", (t) => /(?:※\s*(?:AI|システム|注記)|\[.*?生成.*?\]|以下のような|ご提案します：)/.test(t)],
  ["管理会社・オーナー宛て", (t) => !isCustomerFacingExample(t)],
  ["極端に短い（20字未満）", (t) => t.trim().length < 20],
  ["極端に長い（600字超）", (t) => t.trim().length > 600],
  ["物件カードだけ（訴求文が無い）", (t) => {
    const lines = t.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return true;
    const bullets = lines.slice(1).filter((l) => /^[・◎●\-–—]/.test(l)).length;
    return /^[🌟【]/u.test(lines[0]) && (lines.length === 1 || bullets / Math.max(1, lines.length - 1) >= 0.7);
  }],
  ["伏せ字の呼びかけが残る", (t) => /〇〇さん|○○さん|＊＊さん|\[お客様名\]/.test(t)],
];

async function page(select: string) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 20; p++) {
    const q = sb.from("ai_reply_examples").select(select).eq("is_starred", true)
      .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    const { data, error } = await q;
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  // ① 手本の母集団
  const star = await page("id, sent_reply, is_starred, entry_source, aix_action, outcome_status, created_at");
  const rec = star.filter((r) => String(r.aix_action ?? "") === "property_recommendation" && String(r.sent_reply ?? "").trim());
  const tmpl = star.filter((r) => String(r.entry_source ?? "") === "aix_template" && String(r.sent_reply ?? "").trim());
  console.log(`=== ① 手本（☆付き）===`);
  console.log(`   ☆付き 全体 ${star.length}件`);
  console.log(`   うち 物件オススメ ${rec.length}件 ／ entry_source=aix_template ${tmpl.length}件\n`);

  const pool = [...new Map([...rec, ...tmpl].map((r) => [String(r.id), r])).values()];
  console.log(`   この監査で見る手本: ${pool.length}件（重複を除いた）\n`);

  // ② 既にある関門
  console.log(`=== ② 今ある関門が落とす数 ===`);
  const failUsable = pool.filter((r) => !isUsableExampleText(String(r.sent_reply)));
  const failCustomer = pool.filter((r) => !isCustomerFacingExample(String(r.sent_reply)));
  console.log(`   isUsableExampleText で落ちる       ${failUsable.length}件（${pct(failUsable.length, pool.length)}）`);
  console.log(`   isCustomerFacingExample で落ちる   ${failCustomer.length}件（${pct(failCustomer.length, pool.length)}）`);

  // ③ 関門を通るのに質が低い形
  console.log(`\n=== ③ 関門は通るのに手本として質が低い形 ===`);
  const passing = pool.filter((r) => isUsableExampleText(String(r.sent_reply)));
  let anyLow = 0;
  const seen = new Set<string>();
  for (const [label, fn] of LOW_QUALITY) {
    const hit = passing.filter((r) => fn(String(r.sent_reply)));
    console.log(`   ${label.padEnd(28)} ${String(hit.length).padStart(4)}件（${pct(hit.length, passing.length)}）`);
    for (const r of hit) seen.add(String(r.id));
    if (hit.length && anyLow < 3) {
      anyLow++;
      console.log(`       例: ${mask(String(r_first(hit))).replace(/\n/g, " ／ ").slice(0, 100)}`);
    }
  }
  console.log(`\n   ─ どれかに当たる手本: ${seen.size}件 / ${passing.length}件（${pct(seen.size, passing.length)}）`);

  // ④ 冒頭フレームの偏り
  console.log(`\n=== ④ 手本の冒頭フレームの偏り（フレーム汚染の元）===`);
  const cmp = passing.filter((r) => COMPARE_FRAME_RE.test(String(r.sent_reply))).length;
  const nl = passing.filter((r) => NEW_LISTING_FRAME_RE.test(String(r.sent_reply))).length;
  console.log(`   比較の言い回しを含む  ${cmp}件（${pct(cmp, passing.length)}）`);
  console.log(`   新着の言い回しを含む  ${nl}件（${pct(nl, passing.length)}）`);
  console.log(`   どちらも無い          ${passing.length - cmp - nl}件`);
  console.log(`   ※ 片方に大きく偏っていると、別のシナリオでもその冒頭に引っ張られる`);

  // ⑤ 質が低い手本の実物（目で読む）
  console.log(`\n=== ⑤ 質が低い手本の実物（目で読む・最大12件）===`);
  const low = passing.filter((r) => seen.has(String(r.id)));
  for (const r of low.slice(0, 12)) {
    const labels = LOW_QUALITY.filter(([, fn]) => fn(String(r.sent_reply))).map(([l]) => l);
    console.log(`   [${labels.join(" / ")}]`);
    console.log(`     ${mask(String(r.sent_reply)).replace(/\n/g, " ／ ").slice(0, 120)}`);
  }
}
function r_first(a: Array<Record<string, unknown>>): string { return String(a[0]?.sent_reply ?? ""); }
main().catch((e) => { console.error(e); process.exit(1); });
