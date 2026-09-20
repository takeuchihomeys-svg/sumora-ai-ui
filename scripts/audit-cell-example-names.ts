// 往復文脈セルの例文に「他のお客様の名前」が残っていないか（読み取りのみ・DB 不要）
//
// 2026-09-20 竹内（まりあさん事例）「他のお客さんのデータがはいりこんでいるのか、
//   お客さん毎で状況ちゃんとせいりできているのか、その点も踏まえて原因みつける」
//
// まりあさんの1通については混入は0だった（材料は全てまりあさん自身のもの）。
// ただし PAIR_MATRIX の example は成約データの実文から採っているので、実名が残っていると
// そのまま別のお客様の生成プロンプトに入る。fillNameSlot が面倒を見るのは「{name}」と「〇〇さん」だけで、
// 実名（「タクミさん」等）は素通りする。ここを全セル分あぶり出す。
import { PAIR_MATRIX, fillNameSlot } from "../app/lib/reply-context";

/** 「〜さん」の呼びかけを全部拾う */
const HONORIFIC_RE = /([^\s、。！!？?「」\n]{1,12}?)さん/g;
/** 名前ではない（役割語・プレースホルダ） */
const NOT_A_NAME = /^(?:〇〇|○○|\{name\}|お客|皆|奥|旦那|お子|大家|管理会社|担当|業者|オーナー|ご家族|親御|保証会社)/;

function main() {
  console.log(`=== 往復文脈セル ${PAIR_MATRIX.length}件の例文・指示に残った呼びかけ ===\n`);
  let real = 0, ph = 0;
  for (const r of PAIR_MATRIX) {
    const fields: Array<[string, string]> = [
      ["direction", r.direction], ["example", r.example],
      ...(r.exampleFallback ? [["exampleFallback", r.exampleFallback] as [string, string]] : []),
      ...(r.exampleBySent ? ([["exampleBySent.none", r.exampleBySent.none], ["exampleBySent.sent", r.exampleBySent.sent]] as Array<[string, string]>) : []),
      ...r.mustInclude.map((m, i) => [`mustInclude[${i}].fix`, m.fix] as [string, string]),
    ];
    for (const [where, text] of fields) {
      for (const m of text.matchAll(HONORIFIC_RE)) {
        const who = m[1];
        if (NOT_A_NAME.test(who)) { ph++; continue; }
        real++;
        // fillNameSlot を通しても消えないことを示す（消えるならプレースホルダ扱いで安全）
        const afterFill = fillNameSlot(text, "テスト太郎");
        const survives = afterFill.includes(`${who}さん`);
        console.log(`🔴 ${r.id} (${where}): 「${who}さん」${survives ? " ← **fillNameSlot を通しても残る**" : "（置換される）"}`);
        console.log(`     「${text.replace(/\n/g, " ").slice(0, 100)}」`);
      }
    }
  }
  console.log(`\n=== 実名らしき呼びかけ ${real}件 ／ プレースホルダ・役割語 ${ph}件 ===`);
  if (real === 0) console.log("✅ 例文に他のお客様の名前は残っていない");
}
main();
