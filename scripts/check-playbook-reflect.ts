// scripts/check-playbook-reflect.ts — 手順書が「コード → DB の手順書 → 拡張 → 自動の動き」まで反映されているかを確かめる（読むだけ・2026-11-20）
//
// 竹内さん「改善したのは手順書にちゃんと反映されるようになっているのか」「改善したら手順書が改善されるように仕組みをちゃんと」。
// 実行:
//   npx tsx --env-file=.env.local scripts/check-playbook-reflect.ts                 （リアプロ・直近8回）
//   npx tsx --env-file=.env.local scripts/check-playbook-reflect.ts --scope=all --runs=12
// ⚠ 書かない。揃っていない時の直し方:
//   DB の手順書が古い → scripts/attach-playbook.ts（確かめてから --apply --backup-dir=<リポジトリの外>）
//   拡張が古い       → 拡張を読み込み直す（chrome://extensions）→ ポップアップで学習を取り直す → 自動を1回

import { fetchPlaybookReflect } from "../app/lib/playbook-reflect-server";
import { AUTO_RULES, RULE_SCENE_JA, autoRulesVersion } from "../app/lib/auto-procedure-rules";

const args = process.argv.slice(2);
const scope = args.find((a) => a.startsWith("--scope="))?.slice(8) ?? "realpro";
const runs = Number(args.find((a) => a.startsWith("--runs="))?.slice(7) ?? 8) || 8;

async function main() {
  console.log(`■ コードの決まり: ${AUTO_RULES.length}件（版 ${autoRulesVersion()}）`);
  for (const r of AUTO_RULES) console.log(`  ・[${RULE_SCENE_JA[r.scene]}] ${r.id}${r.since ? `（${r.since}〜）` : ""}: ${r.text}`);

  const rep = await fetchPlaybookReflect(process.env, { scope, runs });
  console.log();
  console.log(`■ DB の手順書（${rep.scope}・束 id ${rep.bundle_id ?? "無"}・${rep.bundle_at?.slice(0, 16) ?? "-"}）`);
  for (const f of rep.reflect.facts) console.log("  ・" + f);
  console.log(`■ 反映: ${rep.reflect.ok ? "✅ 揃っている" : "❌ 揃っていない"}`);
  for (const w of rep.reflect.why) console.log("  ・" + w);

  console.log();
  console.log(`■ 直近の自動 ${rep.runs.length}回（新しい順）`);
  for (const r of rep.runs) {
    const seen = r.seen === null ? "印なし" : r.seen === "none" ? "手順書が届いていない" : `手順書 ${r.seen.version}・決まり ${r.seen.have}/${r.seen.rules}`;
    console.log(`  ・${r.at.slice(5, 16)} ${r.run_id.slice(0, 18)} 拡張 ${r.ext_version ?? "-"}｜${seen}｜守れた ${r.ok}・守れていない ${r.ng.length}・確かめられない ${r.no_data}`);
    for (const g of r.ng) console.log(`      ✗ ${g.id}: ${g.why}`);
  }
  console.log();
  console.log("■ 決まりごと（直近の合計・確かめられない回は ok に数えない）");
  for (const p of rep.per_rule) {
    if (!p.ok && !p.ng) continue;
    console.log(`  ・${p.id}: 守れた ${p.ok}・守れていない ${p.ng}${p.last_ng ? `（例 ${p.last_ng}）` : ""}`);
  }
  if (!rep.reflect.ok) process.exitCode = 2;
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
