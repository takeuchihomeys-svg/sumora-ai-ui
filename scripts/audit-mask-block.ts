// 伏せ字処理を材料の塊に当てた時、塊ごと「申込」の1行に差し替わらないかの確認（読み取りのみ・書き出した実物の材料で）
// 2026-09-22 竹内（みなみさん事例）「また申込ととってしまっている。言葉だけの上っ面で判断していないか。LLM が原因の可能性が高い」
//   原因: generate-reply / AIX が材料の塊（会話履歴・手本・ルール・ブレインの判断）に mask を当てていて、
//   塊のどこかに申込の語と項目名が2つ以上あると塊全体が「[お申込み情報を受け取りました]」に差し替わっていた。
//   みなみさんの2回の生成は入力が会話を問わず同じ（キャッシュ読み 89,728・動的部分32トークン）。
// 実行: npx tsx scripts/audit-mask-block.ts <書き出した dynamic-*.txt のフォルダ>
import * as fs from "fs";
import * as path from "path";
import { createMasker, APPLICATION_FORM_PLACEHOLDER } from "../app/lib/pii-pseudonym";
import { isFilledSumoraForm } from "../app/lib/condition-format";

const dir = process.argv[2];
if (!dir) { console.error("フォルダを指定してください"); process.exit(1); }
let oldGone = 0, newGone = 0, n = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.startsWith("dynamic-"))) {
  let t = fs.readFileSync(path.join(dir, f), "utf8");
  // みなみさんと同じ状態にする: 物件検索の条件フォーム（①【ご入居の時期】…）の行を抜く
  t = t.split("\n").filter((l) => !/[①②③④⑤⑥⑦⑧]\s*【/.test(l)).join("\n");
  if (isFilledSumoraForm(t)) continue;
  n++;
  const m = createMasker({ conversationId: f, customerName: "YUMA" });
  const oldOut = m.mask(t);
  const newOut = m.maskBlock(t);
  const oldReplaced = oldOut === APPLICATION_FORM_PLACEHOLDER;
  const newReplaced = newOut.length < t.length * 0.5;
  if (oldReplaced) oldGone++;
  if (newReplaced) newGone++;
  console.log(`${f} 長さ${t.length} → 旧 mask: ${oldReplaced ? "塊ごと差し替え（" + oldOut.length + "字）" : "残る"} ／ 新 maskBlock: ${newReplaced ? "⚠ 大きく減った" : "残る（" + newOut.length + "字）"}`);
}
console.log(`\n${n}個: 旧は ${oldGone}個が塊ごと差し替わる ／ 新は ${newGone}個`);
