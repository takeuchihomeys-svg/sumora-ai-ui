// プロンプトに入る文字列に「壊れた絵文字（片方だけのサロゲート）」が無いか（読み取りのみ）
//
// 2026-09-21 YUMA の本番経路テストで、生成が **3回とも 400 で落ちた**:
//   "The request body is not valid JSON: no low surrogate in string: line 1 column 55656"
//   ＝ 絵文字の前半（high surrogate）だけがあって後半が無い文字列がプロンプトに入っている。
//
// 位置の見当: gen:blocks は system 36,926 / dbRules 32,717。
//   36,926 + 18,730 ≒ 55,656 ＝ **DB のルール（prompt_rules）の中**。
//
// ⚠ 文字列を slice / substring で切ると絵文字が割れる（設計知見「🌟 はサロゲートペア」）。
//   プロジェクトには safeSlice があるので、切る所が全部それを使っているかも合わせて見る。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-broken-surrogate.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

/** 片方だけのサロゲート（壊れた絵文字）を探す */
function findBrokenSurrogates(s: string): Array<{ index: number; code: string; around: string }> {
  const out: Array<{ index: number; code: string; around: string }> = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isHigh = c >= 0xd800 && c <= 0xdbff;
    const isLow = c >= 0xdc00 && c <= 0xdfff;
    if (!isHigh && !isLow) continue;
    if (isHigh) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { i++; continue; }  // 正しいペア
      out.push({ index: i, code: `high U+${c.toString(16)}`, around: s.slice(Math.max(0, i - 24), i + 8) });
    } else {
      out.push({ index: i, code: `low U+${c.toString(16)}`, around: s.slice(Math.max(0, i - 24), i + 8) });
    }
  }
  return out;
}

async function scan(table: string, cols: string[], idCol = "id") {
  const rows: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from(table).select([idCol, ...cols].join(", ")).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); return; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; rows.push(...r); if (r.length < 1000) break;
  }
  let broken = 0;
  const examples: string[] = [];
  for (const r of rows) {
    for (const c of cols) {
      const v = r[c];
      if (typeof v !== "string" || !v) continue;
      const hits = findBrokenSurrogates(v);
      if (hits.length === 0) continue;
      broken++;
      if (examples.length < 8) {
        examples.push(`     [${String(r[idCol]).slice(0, 8)}… / ${c}] ${hits[0].code} @${hits[0].index}\n       …${hits[0].around.replace(/\n/g, " ")}…`);
      }
    }
  }
  console.log(`   ${table.padEnd(26)} ${String(rows.length).padStart(6)}行 ／ 壊れた絵文字がある列 **${broken}件**`);
  for (const e of examples) console.log(e);
}

async function main() {
  console.log(`=== プロンプトに入るテーブルを全部見る ===\n`);
  await scan("prompt_rules", ["content"]);
  await scan("ai_reply_knowledge", ["content"]);
  await scan("ai_reply_examples", ["sent_reply", "ai_draft", "customer_message"]);
  await scan("winning_patterns", ["pattern_text"]);
  await scan("aix_templates", ["template_text"]);
  console.log(`\n※ 「壊れた絵文字」= 絵文字の前半だけ／後半だけが残った状態。`);
  console.log(`   そのまま API に送ると JSON として不正になり 400 で落ちる（生成が丸ごと失敗する）。`);
}
main().catch((e) => { console.error(e); process.exit(1); });
