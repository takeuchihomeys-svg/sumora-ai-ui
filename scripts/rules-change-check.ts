/**
 * 手順書の変更チェック（2026-11-26 竹内さん「順に改善」・A／D／E の道具）
 *
 *   A（変更時の確認）: 挙動を変えたら、変えた言葉で決まりと骨組みを探し、本文が直ったかを1件ずつ出す
 *     npx tsx scripts/rules-change-check.ts --words=外す,リセット,30秒 [--base=HEAD] [--strict]
 *     ・--base の版（既定 HEAD＝最後のコミット）と比べて、本文が変わっていない物は「要確認」
 *     ・--strict: 要確認が1件でもあれば終了コード 1（コミット前に使う）
 *
 *   B（廃止された手順が残っていないか）: 毎回出る（試験 playbook-retired-phrases と同じ判定）
 *
 *   D（版の比較）: --drift で、リセット（2.8.305）より古い外しの決まりで、リセットに触れない物を出す
 *
 *   E（反映の確認）: --sync で本番の手順書と手元の差を出す（check-playbook-sync・DB を読むだけ）
 *
 *   ⚠ 直したら「push → Vercel 本番が Ready → attach-playbook --apply（控え付き）→ check-playbook-sync」の順。
 *     本文を変えると rules_v が変わるので、本番の手順書は attach し直すまで古いまま。
 */
import { execSync, spawnSync } from "node:child_process";
import { AUTO_RULES } from "../app/lib/auto-procedure-rules";
import {
  PLAYBOOK_EXTRA_GUIDES,
  PLAYBOOK_FLOW_SERIES,
  PLAYBOOK_LIST_AD_SORT_STEPS,
  PLAYBOOK_SEARCH_GRASP_STEPS,
  PLAYBOOK_AREA_CONFIRM_STEPS,
  PLAYBOOK_COND_GUIDE_STEPS,
} from "../app/lib/action-playbook";
import { retiredPhraseIssues, driftFlags } from "../app/lib/playbook-retired";

const RULE_FILE = "app/lib/auto-procedure-rules.ts";
const PLAYBOOK_FILE = "app/lib/action-playbook.ts";

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith("--" + name + "="));
  if (hit) return hit.slice(name.length + 3);
  return process.argv.includes("--" + name) ? "" : null;
}

/** 版（base）の時点のファイル本文。無ければ空（＝全部が新しい扱い） */
function baseText(rev: string, file: string): string {
  try {
    return execSync(`git show ${rev}:${file}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

type Item = { kind: "決まり" | "骨組み"; where: string; text: string; file: string };

function collectItems(): Item[] {
  const out: Item[] = [];
  for (const r of AUTO_RULES) out.push({ kind: "決まり", where: r.id + "（" + r.scene + "・" + (r.since || "版なし") + "）", text: r.text, file: RULE_FILE });
  for (const g of PLAYBOOK_EXTRA_GUIDES) g.steps.forEach((s, i) => out.push({ kind: "骨組み", where: g.id + " ①" + (i + 1), text: s, file: PLAYBOOK_FILE }));
  for (const p of PLAYBOOK_FLOW_SERIES) out.push({ kind: "骨組み", where: "一連 " + p.id, text: p.label, file: PLAYBOOK_FILE });
  const sets: Array<[string, ReadonlyArray<string>]> = [
    ["一覧", PLAYBOOK_LIST_AD_SORT_STEPS],
    ["検索", PLAYBOOK_SEARCH_GRASP_STEPS],
    ["所在地", PLAYBOOK_AREA_CONFIRM_STEPS],
    ["条件", PLAYBOOK_COND_GUIDE_STEPS],
  ];
  for (const [name, steps] of sets) steps.forEach((s, i) => out.push({ kind: "骨組み", where: name + " ①" + (i + 1), text: s, file: PLAYBOOK_FILE }));
  return out;
}

function main() {
  const items = collectItems();

  // ── B: 廃止された手順（毎回） ──
  const issues = retiredPhraseIssues(items.map((i) => ({ where: i.where, text: i.text })));
  console.log("■ B 廃止された手順（1つずつ外すを保険と断らず書いていないか）");
  if (issues.length) issues.forEach((s) => console.log("  ❌ " + s));
  else console.log("  ✅ 無し（" + items.length + " 件）");

  // ── A: 変えた言葉で探す ──
  const words = (arg("words") || "").split(",").map((w) => w.trim()).filter(Boolean);
  let unchangedHits = 0;
  if (words.length) {
    const base = arg("base") || "HEAD";
    const baseRule = baseText(base, RULE_FILE);
    const basePb = baseText(base, PLAYBOOK_FILE);
    console.log("\n■ A 変えた言葉（" + words.join("・") + "）で探した決まり・骨組み（版 " + base + " と比べる）");
    for (const it of items) {
      if (!words.some((w) => it.text.includes(w))) continue;
      const before = it.file === RULE_FILE ? baseRule : basePb;
      const changed = !before.includes(it.text);
      if (!changed) unchangedHits++;
      console.log("  " + (changed ? "✅ 本文が変わった" : "⚠ 本文は変わっていない（要確認）") + "  " + it.kind + " " + it.where);
    }
    if (unchangedHits === 0) console.log("  （該当は全部、本文が変わっている）");
  } else {
    console.log("\n■ A は --words=... を付けると、変えた言葉で決まりと骨組みを探せます");
  }

  // ── D: 版の比較 ──
  if (process.argv.includes("--drift")) {
    const flags = driftFlags(AUTO_RULES);
    console.log("\n■ D 版の比較（リセットより古い外しの決まりで、リセットに触れない物）");
    if (flags.length) flags.forEach((s) => console.log("  ⚠ " + s));
    else console.log("  ✅ 食い違いの疑い 0 件");
  }

  // ── E: 反映（DB を読むだけ） ──
  if (process.argv.includes("--sync")) {
    console.log("\n■ E 本番の手順書との差（check-playbook-sync）");
    spawnSync("npx", ["tsx", "--env-file=.env.local", "scripts/check-playbook-sync.ts"], { stdio: "inherit", shell: true });
  }

  if (issues.length) process.exitCode = 1;
  if (process.argv.includes("--strict") && unchangedHits > 0) process.exitCode = 1;
}

main();
