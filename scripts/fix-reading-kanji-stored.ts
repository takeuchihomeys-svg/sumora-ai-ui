// scripts/fix-reading-kanji-stored.ts — 保存済みの読み取りに混ざった中国の字形（簡体字・繁体字）を数え、日本の字形に直す（既定は数えるだけ・LLM なし・$0）
//
// 2026-10-14 P0 89bc2c3e「漢字は必ず日本語の漢字」。直し方は app/lib/ja-kanji.ts（toJapaneseKanji・形は変えず文字だけ）。
//   対象（読み取りの出力＋読み取りから作った値）:
//     image_details.lines／sent_image_properties.property_name・facts／sent_properties.property_name（source=vision の読んだ名前）／
//     property_pickups.image_lines・image_facts・image_analysis／property_sheet_facts.image_facts・text_facts
//   名前に普通にある旧字（淺・龍・澤・濱・萬・條・眞・髙・﨑・國）は直さない（ja-kanji.ts の線と同じ）。
// 実行: npx tsx --env-file=.env.local scripts/fix-reading-kanji-stored.ts [--show=5] [--apply]
//   --apply は親（承認の後）が流す。書き込みは 1行ずつ update（形はそのまま）
import { createClient } from "@supabase/supabase-js";
import { toJapaneseKanjiCount, jaKanjiDeep, CHINESE_FORM_RE } from "../app/lib/ja-kanji";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const APPLY = process.argv.includes("--apply");
const SHOW = Number((process.argv.find((a) => a.startsWith("--show=")) ?? "--show=5").split("=")[1]);

type Target = { table: string; key: string; cols: string[]; filter?: (q: any) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const TARGETS: Target[] = [
  { table: "image_details", key: "image_url", cols: ["lines"] },
  { table: "sent_image_properties", key: "image_url", cols: ["property_name", "facts"] },
  { table: "sent_properties", key: "id", cols: ["property_name"] },
  { table: "property_pickups", key: "id", cols: ["image_lines", "image_facts", "image_analysis"] },
  { table: "property_sheet_facts", key: "id", cols: ["image_facts", "text_facts"] },
];

const COMPAT = /[⺀-⿟豈-﫿]/u;
function hasForm(v: unknown): boolean {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return CHINESE_FORM_RE.test(s) || [...s].some((c) => COMPAT.test(c) && c.normalize("NFKC") !== c);
}
function countForms(v: unknown): number {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return toJapaneseKanjiCount(s).changed;
}

async function main() {
  let totalRows = 0, totalChars = 0, updated = 0, leftAfter = 0;
  for (const tg of TARGETS) {
    const rows: Array<Record<string, unknown>> = [];
    for (let f = 0; ; f += 1000) {
      const { data, error } = await sb.from(tg.table).select([tg.key, ...tg.cols].join(", ")).range(f, f + 999);
      if (error) { console.log(`${tg.table}: ${error.message}`); break; }
      rows.push(...((data ?? []) as unknown as Array<Record<string, unknown>>));
      if (!data || data.length < 1000) break;
    }
    const hits = rows.filter((r) => tg.cols.some((c) => hasForm(r[c])));
    let chars = 0, shown = 0;
    console.log(`\n== ${tg.table}: ${rows.length}行中 ${hits.length}行に中国の字形・互換漢字`);
    for (const r of hits) {
      const patch: Record<string, unknown> = {};
      for (const c of tg.cols) {
        if (!hasForm(r[c])) continue;
        chars += countForms(r[c]);
        patch[c] = jaKanjiDeep(r[c], {});
        if (hasForm(patch[c])) leftAfter++;
        if (shown < SHOW) {
          const before = typeof r[c] === "string" ? r[c] as string : JSON.stringify(r[c]);
          const after = typeof patch[c] === "string" ? patch[c] as string : JSON.stringify(patch[c]);
          const i = [...before].findIndex((ch, k) => ch !== [...after][k]);
          console.log(`   [${c}] …${[...before].slice(Math.max(0, i - 15), i + 15).join("")}… → …${[...after].slice(Math.max(0, i - 15), i + 15).join("")}…`);
          shown++;
        }
      }
      if (APPLY && Object.keys(patch).length) {
        const { error } = await sb.from(tg.table).update(patch).eq(tg.key, r[tg.key] as string);
        if (error) console.log(`   ✗ ${String(r[tg.key]).slice(-40)}: ${error.message}`); else updated++;
      }
    }
    console.log(`   直す字 ${chars}`);
    totalRows += hits.length; totalChars += chars;
  }
  console.log(`\n合計: 直す行 ${totalRows}・直す字 ${totalChars}・直した後も残る ${leftAfter}${APPLY ? `・書いた行 ${updated}` : "（数えただけ・--apply で書く）"}`);
}
main();
