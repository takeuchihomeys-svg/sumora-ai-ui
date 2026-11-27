/**
 * 拡張のパネルの言葉の写しを、流れの地図から作り直す（2.8.323・竹内さん 2026-11-27
 *   「改善したらパネルも改善される仕組みちゃんとつくる／パネルに記載されている文字ちゃんと改善したながれにする」）。
 *
 * 正本: app/lib/loop-flow-map.ts の各手の panel。書き換える先（手で直さない）:
 *   ・chrome-extension/bulk-panel-grasp.js   … var PANEL_PHASE_WORDS（枠の「いま／つぎ」を作る側・拡張の裏と画面で共用）
 *   ・chrome-extension/page-script.js        … var _AXLX_PANEL_WORDS（画面の中の MAIN から配る側。import できないので写す）
 *   「PANEL_WORDS:BEGIN」から「PANEL_WORDS:END」の目印の間だけを書き換える。
 *
 *   npx tsx scripts/gen-panel-words.ts          … 書き換える
 *   npx tsx scripts/gen-panel-words.ts --check  … 古ければ終了コード1（書き換えない）
 *
 * 流れ（地図）を変えたら、この順: ① 地図の panel を直す ② これを回す ③ 試験 panel-from-flow-map.test.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkPanelWords, checkWaits, renderPanelWordsJs, renderWaitWordsJs } from "../app/lib/loop-flow-map";

type Target = { file: string; varName: string; marker: "PANEL_WORDS" | "WAIT_WORDS"; render: (varName: string) => string };
const TARGETS: Target[] = [
  { file: "chrome-extension/bulk-panel-grasp.js", varName: "PANEL_PHASE_WORDS", marker: "PANEL_WORDS", render: (v) => renderPanelWordsJs(undefined, v) },
  { file: "chrome-extension/page-script.js", varName: "_AXLX_PANEL_WORDS", marker: "PANEL_WORDS", render: (v) => renderPanelWordsJs(undefined, v) },
  { file: "chrome-extension/bulk-dl.js", varName: "WAIT_WORDS", marker: "WAIT_WORDS", render: (v) => renderWaitWordsJs(v) },
];

/** 目印の間を作り直した本文（目印が無ければ null）。試験からも使う */
export function regenerate(src: string, varName: string, render: (v: string) => string = (v) => renderPanelWordsJs(undefined, v), marker: "PANEL_WORDS" | "WAIT_WORDS" = "PANEL_WORDS"): string | null {
  const s = src.replace(/\r\n/g, "\n");
  const BEGIN = `/* ${marker}:BEGIN */`;
  const END = `/* ${marker}:END */`;
  const bi = s.indexOf(BEGIN);
  const ei = s.indexOf(END);
  if (bi < 0 || ei < 0 || ei < bi) return null;
  return s.slice(0, bi + BEGIN.length) + "\n" + render(varName) + "\n  " + s.slice(ei);
}

function main() {
  const bad = [...checkPanelWords(), ...checkWaits()];
  if (bad.length) {
    console.error("❌ 地図の言葉（パネル・待ち）が正しくない:\n" + bad.map((b) => "  ・" + b).join("\n"));
    process.exit(2);
  }
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const t of TARGETS) {
    const path = join(process.cwd(), t.file);
    const raw = readFileSync(path, "utf8");
    const crlf = raw.includes("\r\n");
    const next = regenerate(raw, t.varName, t.render, t.marker);
    if (next === null) {
      console.error(`❌ ${t.file} に ${t.marker} の BEGIN／END が無い`);
      process.exit(2);
    }
    if (next === raw.replace(/\r\n/g, "\n")) {
      console.log(`✅ ${t.file} は地図と同じ`);
      continue;
    }
    stale++;
    if (check) {
      console.error(`❌ ${t.file} が地図と違う（npx tsx scripts/gen-panel-words.ts で作り直す）`);
      continue;
    }
    writeFileSync(path, crlf ? next.replace(/\n/g, "\r\n") : next);
    console.log(`✍ ${t.file} を地図から作り直した`);
  }
  if (check && stale) process.exit(1);
}

if (process.argv[1] && /gen-panel-words\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) main();
