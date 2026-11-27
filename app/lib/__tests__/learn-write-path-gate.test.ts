/**
 * 学習束の書き込み関所（2026-11-17 統括Pro）
 *
 *   抜けが後から出る構造原因: 新しい insert 経路が増えても preserve 関所が無い。
 *   → human_learn_profile へ insert するソースは、同じファイル内に
 *     inheritLinkFoundations / learn-bundle-preserve / safe_to_write のどれかが必要。
 *   → scripts から本番 fresh=1 を既定で叩くのも禁止（消す書き込みの入口）。
 *
 * 実行: npx tsx app/lib/__tests__/learn-write-path-gate.test.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: string) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};

const root = join(__dirname, "../../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(p);
  }
  return out;
}

const INSERT_RE = /human_learn_profile["']\)\.insert|from\(["']human_learn_profile["']\)[\s\S]{0,80}\.insert/;
const PRESERVE_RE = /inheritLinkFoundations|learn-bundle-preserve|safe_to_write|wipe_blocked|消す書き込み/;
/** 復元専用・点検専用は関所対象外（明示） */
const ALLOW_NO_PRESERVE = [
  "tmp-restore-link-bundle.ts",
  "tmp-wipe-trace.ts",
  "tmp-patch-foundation-supervisor.ts",
  "tmp-patch-station-scene.ts",
];

console.log("■ ① insert 経路に preserve 関所がある");
{
  const files = walk(join(root, "app")).concat(walk(join(root, "scripts")));
  const offenders: string[] = [];
  for (const f of files) {
    const base = f.replace(/\\/g, "/").split("/").pop() || "";
    if (ALLOW_NO_PRESERVE.includes(base)) continue;
    if (f.includes("__tests__")) continue;
    const src = readFileSync(f, "utf8");
    if (!INSERT_RE.test(src)) continue;
    if (!PRESERVE_RE.test(src)) offenders.push(f.replace(root, "").replace(/\\/g, "/"));
  }
  ok("insert 全経路に preserve がある", offenders.length === 0, offenders.slice(0, 8).join(" / "));
}

console.log("\n■ ①b insert 経路は手順書と名前の除去（prepareBundleForWrite）を通す（2026-11-20 竹内さん「改善したら手順書が改善されるように」）");
{
  const files = walk(join(root, "app")).concat(walk(join(root, "scripts")));
  const offenders: string[] = [];
  for (const f of files) {
    const base = f.replace(/\\/g, "/").split("/").pop() || "";
    if (ALLOW_NO_PRESERVE.includes(base)) continue;
    if (f.includes("__tests__")) continue;
    const src = readFileSync(f, "utf8");
    if (!INSERT_RE.test(src)) continue;
    if (!/prepareBundleForWrite\(/.test(src)) offenders.push(f.replace(root, "").replace(/\\/g, "/"));
  }
  ok("insert 全経路が prepareBundleForWrite を通す（古い手順書の写しを書かない）", offenders.length === 0, offenders.slice(0, 8).join(" / "));
  const route = readFileSync(join(root, "app/api/human-learn-profile/route.ts"), "utf8");
  const iCarry = route.indexOf("carryLearnedShots(supabase, scope, bundle)");
  // 引数（scope＝サイト）を渡すようになった（2026-11-26）ので、閉じ括弧の前までで探す
  const iPrep = route.indexOf("prepareBundleForWrite(bundle as unknown as Record<string, unknown>");
  const iIns = route.indexOf('from("human_learn_profile").insert({\n      scope,') >= 0
    ? route.indexOf('from("human_learn_profile").insert({\n      scope,')
    : route.indexOf('from("human_learn_profile").insert({\r\n      scope,');
  ok("API: 押す位置を継いだ後に手順書を作り、その後に書く", iCarry > 0 && iPrep > iCarry && iIns > iPrep, `carry=${iCarry} prep=${iPrep} insert=${iIns}`);
  const iRefreshPrep = route.indexOf('prepareBundleForWrite(b, "all");');
  const iRefreshIns = route.indexOf('scope: "all", source_rows: rows.length, bundle: b');
  ok("API refresh=1 も手順書を作ってから書く", iRefreshPrep > 0 && iRefreshIns > iRefreshPrep);
  ok("API: 渡す時に古い手順書をその場で作り直す（refreshPlaybookIfStale）", /refreshPlaybookIfStale\(row\.bundle/.test(route) && /bundle: servedBundle,/.test(route));
}

console.log("\n■ ② 本番 fresh=1 を既定で叩く脚本が無い（読みは touch=0）");
{
  const talk = readFileSync(join(root, "scripts/supervisor-talk.ts"), "utf8");
  const pro = readFileSync(join(root, "scripts/supervisor-pro.ts"), "utf8");
  const cronWs = readFileSync(join(root, "app/api/cron/weak-strengthen/route.ts"), "utf8");
  ok("supervisor-talk 既定は fresh=1 でない", !/human-learn-profile\?fresh=1/.test(talk));
  ok("supervisor-pro 既定は fresh オフ（--fresh のみ）", /forceFresh \? "fresh=1&" : ""/.test(pro));
  ok("cron weak-strengthen が fresh=1 を直呼びしない", !/\?fresh=1/.test(cronWs));
}

console.log("\n■ ③ 共通モジュールが存在する");
{
  const p = readFileSync(join(root, "app/lib/learn-bundle-preserve.ts"), "utf8");
  ok("safe_to_write 判定がある", /safe_to_write/.test(p));
  ok("inheritLinkFoundations がある", /export async function inheritLinkFoundations/.test(p));
  ok("minSolid 既定がある", /minSolid/.test(p));
}

console.log(`\n結果: ${pass} ok / ${fail} ng`);
if (fail) process.exit(1);
