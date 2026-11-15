// scripts/linkage-switch-defaults.ts — 連携の地図のスイッチのコードの既定をソースから読み、app/lib/linkage-switch-defaults.ts を作り直す（LLM なし・DB なし）
//
// 2026-11-15 作業員L。地図（app/lib/linkage-map.ts）にスイッチを足したら、これを流してコミットする（毎朝の見張りは本番で動くのでソースを読めない＝作った物を読む）。
// 実行: npx tsx scripts/linkage-switch-defaults.ts [--write] [--check]
//   --check: 今のファイルとずれていたら止まる（テストと同じ）
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mapSwitchNames } from "../app/lib/linkage-map";
import { scanSwitchDefaults } from "./lib/switch-default-scan";

const ROOT = resolve(__dirname, "..");
const OUT = join(ROOT, "app/lib/linkage-switch-defaults.ts");
function walk(dir: string, acc: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === "node_modules" || f.startsWith(".")) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(f) && !/linkage-switch-defaults\.ts$/.test(f)) acc.push(p);
  }
  return acc;
}
export function buildDefaultsFile(): string {
  const sources = walk(join(ROOT, "app")).map((p) => ({ path: p, text: readFileSync(p, "utf8") }));
  const res = scanSwitchDefaults(mapSwitchNames(), sources);
  const lines = res.map((r) => `  ${r.name}: ${JSON.stringify(r.def)},${r.split ? " // 読み方が割れている" : ""}${r.def === "なし" ? " // コードに無い名前" : r.def === "?" ? " // 既定が読めない形" : ""}`);
  return `// app/lib/linkage-switch-defaults.ts — 作った物（手で直さない）: scripts/linkage-switch-defaults.ts --write が app/ のソースから読んだスイッチのコードの既定
// 連携の地図（linkage-map.ts）の行のスイッチだけ。"なし"＝コードに無い名前・"?"＝既定が読めない形。
export const LINKAGE_SWITCH_DEFAULTS: Readonly<Record<string, string>> = {
${lines.join("\n")}
};
`;
}
if (require.main === module) {
  const text = buildDefaultsFile();
  if (process.argv.includes("--check")) {
    let cur = ""; try { cur = readFileSync(OUT, "utf8"); } catch { /* 無い */ }
    if (cur.replace(/\r\n/g, "\n") !== text) { console.error("app/lib/linkage-switch-defaults.ts が古い: npx tsx scripts/linkage-switch-defaults.ts --write"); process.exit(1); }
    console.log("ok");
  } else if (process.argv.includes("--write")) { writeFileSync(OUT, text); console.log(`書いた ${OUT}`); }
  else console.log(text);
}
