// 「頂く」（漢字）と「いただく」（ひらがな）— AI とスタッフで使い分けが違わないか（読み取りのみ）
//
// 2026-09-21 竹内「文の質が上がっていないってことは実際のスタッフが送るような文が生成されていない可能性があるってこと？」
//
// scripts/audit-draft-vs-staff.ts で、スタッフが直した時に
//   **消される1位** = 「内させて頂きます」（ご案内させて頂きます）201回
//   **足される1位** = 「せていただきます」（探させていただきます）262回
// と出た。**同じ意味なのに表記が違う**（頂く／いただく）のが混ざっている疑い。
// 述部8字で見ると別物になるので、上の集計では「消して足した」ように見える。
//
// ここでは表記だけを取り出して、①実送信 ②AI の下書き で比率を比べる。
// 設計知見「必須にしてよいのは過半数が守っている形だけ」「実送信で線を引く」
//
// 実行: npx tsx --env-file=.env.local scripts/audit-itadaku-notation.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
async function page(table: string, select: string, order: string, days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}
const pct = (a: number, b: number) => b ? `${(a / b * 100).toFixed(1)}%` : "-";
const count = (texts: string[], re: RegExp) => texts.reduce((a, t) => a + (t.match(re)?.length ?? 0), 0);

/** 比べる表記の組（同じ意味・違う書き方） */
const PAIRS: Array<{ name: string; kanji: RegExp; kana: RegExp }> = [
  { name: "〜させて頂く / いただく", kanji: /させて頂(?:き|く|け)/g, kana: /させていただ(?:き|く|け)/g },
  { name: "〜して頂く / いただく", kanji: /(?<!さ)せて頂(?:き|く|け)|して頂(?:き|く|け)/g, kana: /(?<!さ)せていただ(?:き|く|け)|していただ(?:き|く|け)/g },
  { name: "致します / いたします", kanji: /致します/g, kana: /いたします/g },
  { name: "御座います / ございます", kanji: /御座います/g, kana: /ございます/g },
  { name: "下さい / ください", kanji: /下さい/g, kana: /ください/g },
  { name: "出来る / できる", kanji: /出来(?:る|ます|ました)/g, kana: /でき(?:る|ます|ました)/g },
  { name: "何時でも / いつでも", kanji: /何時でも/g, kana: /いつでも/g },
];

async function main() {
  const days = Number(process.env.DAYS ?? 120);
  const msgs = await page("messages", "sender, text, created_at", "created_at", days);
  const staff = msgs.filter((m) => String(m.sender) === "staff").map((m) => String(m.text ?? "")).filter(Boolean);
  const ex = await page("ai_reply_examples", "ai_draft, sent_reply, created_at", "created_at", days);
  const drafts = ex.map((r) => String(r.ai_draft ?? "")).filter((t) => t && !/^\[|^__/.test(t));
  console.log(`=== 材料: スタッフ実送信 ${staff.length}通 / AI の下書き ${drafts.length}通（直近${days}日）===\n`);

  console.log(`=== 表記の使い分け（漢字 vs ひらがな）===`);
  console.log(`   ${"".padEnd(24)} 実送信(スタッフ)        AI の下書き           ずれ`);
  const gaps: Array<{ name: string; staffKana: number; aiKana: number; diff: number; sK: number; sH: number; aK: number; aH: number }> = [];
  for (const p of PAIRS) {
    const sK = count(staff, p.kanji), sH = count(staff, p.kana);
    const aK = count(drafts, p.kanji), aH = count(drafts, p.kana);
    const sTot = sK + sH, aTot = aK + aH;
    if (sTot < 30 || aTot < 20) continue;
    const staffKana = sH / sTot, aiKana = aH / aTot;
    gaps.push({ name: p.name, staffKana, aiKana, diff: staffKana - aiKana, sK, sH, aK, aH });
  }
  for (const g of gaps.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))) {
    const mark = Math.abs(g.diff) >= 0.15 ? "  ⚠ 大きい" : "";
    console.log(`   ${g.name.padEnd(24)} かな ${pct(g.sH, g.sH + g.sK).padStart(6)} (漢${g.sK}/かな${g.sH})   かな ${pct(g.aH, g.aH + g.aK).padStart(6)} (漢${g.aK}/かな${g.aH})   ${(g.diff * 100).toFixed(1).padStart(6)}pt${mark}`);
  }
  console.log(`\n   ずれ ＝ スタッフのひらがな率 − AI のひらがな率（＋なら AI が漢字に寄りすぎ）`);

  // 禁止語が下書きに残っていないか（「お待たせ致しました」は全廃のはず）
  console.log(`\n=== 禁止語が AI の下書きに残っていないか ===`);
  for (const [name, re] of [
    ["お待たせ致しました", /お待たせ(?:致|いた)?しました/g],
    ["夜分遅くに失礼", /夜分?(?:遅く)?に失礼/g],
    ["ありがとうございますだけの書き出し", /^ありがとうございます[！!。\s]*$/gm],
  ] as Array<[string, RegExp]>) {
    const inDraft = drafts.filter((t) => re.test(t)).length;
    const inSent = staff.filter((t) => re.test(t)).length;
    console.log(`   ${name.padEnd(30)} 下書き ${String(inDraft).padStart(4)}通 (${pct(inDraft, drafts.length)})  ／ 実送信 ${String(inSent).padStart(4)}通 (${pct(inSent, staff.length)})`);
  }

  // 直近だけで見る（直した効果は時系列で）
  console.log(`\n=== 直近14日だけで見る（古い下書きに薄められないように）===`);
  const recentDrafts = ex.filter((r) => Date.now() - new Date(String(r.created_at)).getTime() < 14 * 86400_000)
    .map((r) => String(r.ai_draft ?? "")).filter((t) => t && !/^\[|^__/.test(t));
  console.log(`   直近14日の下書き ${recentDrafts.length}通`);
  for (const p of PAIRS.slice(0, 3)) {
    const aK = count(recentDrafts, p.kanji), aH = count(recentDrafts, p.kana);
    if (aK + aH < 10) continue;
    console.log(`   ${p.name.padEnd(24)} かな ${pct(aH, aH + aK).padStart(6)} (漢${aK}/かな${aH})`);
  }
  const waited = recentDrafts.filter((t) => /お待たせ(?:致|いた)?しました/.test(t)).length;
  console.log(`   「お待たせ致しました」: ${waited}通 (${pct(waited, recentDrafts.length)})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
