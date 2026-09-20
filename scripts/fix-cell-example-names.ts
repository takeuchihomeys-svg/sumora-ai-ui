// 往復文脈セルの例文に残った他のお客様の実名を {name} スロットに直す（1回限りの書き換え）
//
// 2026-09-20 竹内（まりあさん事例）「他のお客さんのデータがはいりこんでいるのか」
//   → PAIR_MATRIX の example は成約データの実文をそのまま採っていたため、実名が25件残っていた。
//     fillNameSlot が面倒を見るのは {name} と 〇〇さん だけなので、実名は素通りで生成プロンプトに入る。
//   コメント行（// で始まる）の事例名（「みく事例」等）は履歴として残す。
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "app/lib/reply-context.ts";
const NAMES = ["みく", "あや", "瑞希", "あみ", "タクミ", "あい", "愛乃", "慶次"];

const src = readFileSync(FILE, "utf8");
const lines = src.split("\n");
let changed = 0;
const out = lines.map((line, i) => {
  if (line.trim().startsWith("//") || line.trim().startsWith("*")) return line; // コメントは触らない
  let l = line;
  for (const n of NAMES) {
    const re = new RegExp(`${n}さん`, "g");
    if (re.test(l)) {
      l = l.replace(re, "{name}");
      changed++;
      console.log(`  ${i + 1}: 「${n}さん」→ {name}`);
    }
  }
  return l;
});
if (changed === 0) { console.log("変更なし"); process.exit(0); }
writeFileSync(FILE, out.join("\n"), "utf8");
console.log(`\n✅ ${changed}箇所を {name} に置き換えた`);
