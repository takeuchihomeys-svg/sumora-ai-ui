// scripts/ext-release.ts — 拡張を直した時の「反映の鎖」を1本にする（2.8.314・竹内さん 2026-11-27「ミスが見つかったら改善して反映される仕組み・土台強化」）
//
//   これまでは「試験→型→コミット→push→本番を待つ→attach-playbook→check-playbook-sync→拡張再読込→自動1回」を
//   人が思い出しながら1つずつやっていて、順番の入れ違い・抜け（記録の更新忘れ・版の不揃い・本番を待たずに attach・
//   実機の確認待ちを忘れる）が起こり得た。この道具が鎖の全部を決まった順で通し、抜けがあれば先へ進まない。
//
//   npx tsx --env-file=.env.local scripts/ext-release.ts            … 出す前の点検だけ（何も書かない・push しない）
//   npx tsx --env-file=.env.local scripts/ext-release.ts --push     … 点検が通ったら main と cursor-ext へ push（force しない）
//   npx tsx --env-file=.env.local scripts/ext-release.ts --attach   … 本番が手元の版になるのを待ち→手順書を DB へ（控えはリポジトリの外）→同期の点検
//   npx tsx --env-file=.env.local scripts/ext-release.ts --all      … --push と --attach を続けて
//
//   決まり:
//    ・点検が1つでも赤なら push しない（コミットしていない・版が揃わない・記録が無い・新しい赤の試験・型エラー増・main に追いつけない）
//    ・push も attach も、このコマンドに --push／--attach を付けた時だけ（付けなければ読むだけ）
//    ・終わりに「人にしかできない実機の手」を必ず出す（拡張再読込→自動2客以上→⑧）。実機で確かめるまで「反映済み」と言わない
//    ・DB へ書くのは attach-playbook（控え必須）だけ。鍵・名前は出さない
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(`--${f}`);
const DO_PUSH = has("push") || has("all");
const DO_ATTACH = has("attach") || has("all");
const ROOT = process.cwd();
const PROD = process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";
const OK = "✅", NG = "❌", WA = "⚠";
const bad: string[] = [];
const say = (s: string) => console.log(s);

function read(p: string): string { return fs.readFileSync(path.join(ROOT, p), "utf8"); }
function sh(cmd: string, args: string[], opts: { inherit?: boolean } = {}): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd: ROOT, shell: process.platform === "win32", encoding: "utf8", stdio: opts.inherit ? "inherit" : "pipe", maxBuffer: 1 << 26 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const git = (a: string[]) => sh("git", a);
function ver(re: RegExp, text: string): string { return (text.match(re) || [])[1] || ""; }
function cmpVer(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
function check(label: string, good: boolean, detail = "") {
  if (good) say(`  ${OK} ${label}`);
  else { say(`  ${NG} ${label}${detail ? `：${detail}` : ""}`); bad.push(label + (detail ? `（${detail}）` : "")); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  say("■ ① 版が全部同じか（manifest／page-script／itandi-page-script／決まりの見直し上限2つ）");
  const vs = {
    manifest: ver(/"version":\s*"([\d.]+)"/, read("chrome-extension/manifest.json")),
    page: ver(/_AXLX_PAGE_VER\s*=\s*"([\d.]+)"/, read("chrome-extension/page-script.js")),
    itandiPage: ver(/_AXLX_ITANDI_PAGE_VER\s*=\s*"([\d.]+)"/, read("chrome-extension/itandi-page-script.js")),
    rules: ver(/AUTO_RULES_REVIEWED_UP_TO\s*=\s*"([\d.]+)"/, read("app/lib/auto-procedure-rules.ts")),
    itandiRules: ver(/ITANDI_RULES_REVIEWED_UP_TO\s*=\s*"([\d.]+)"/, read("app/lib/auto-itandi-rules.ts")),
  };
  const version = vs.manifest;
  check(`5 か所とも ${version}`, !!version && Object.values(vs).every((v) => v === version), JSON.stringify(vs));

  say("\n■ ② 記録を更新したか（拡張を直したら memory/dept_search_tool.md に即・絶対ルール）");
  const memHead = read("memory/dept_search_tool.md").slice(0, 60000);
  check(`dept_search_tool.md の先頭近くに ${version} の記録がある`, version !== "" && memHead.includes(version));

  say("\n■ ③ コミット済みか（反映に関わる場所に未コミットが無い）");
  const st = git(["status", "--porcelain", "--", "chrome-extension", "app/lib", "app/api", "memory/dept_search_tool.md", "tests/chrome-extension", "scripts/attach-playbook.ts", "scripts/ext-test-all.ts"]);
  const dirty = st.out.split(/\r?\n/).filter(Boolean);
  check("未コミットなし", dirty.length === 0, dirty.slice(0, 3).join(" / "));

  say("\n■ ④ 拡張の試験（新しい赤・赤の中の新しい失敗が無い）");
  const t = sh("npx", ["tsx", "scripts/ext-test-all.ts"]);
  const tLine = t.out.split(/\r?\n/).find((l) => l.includes("拡張の試験")) ?? "";
  check(tLine.trim() || "拡張の試験", t.code === 0, t.out.split(/\r?\n/).filter((l) => /新しく赤|新しい失敗|✗/.test(l)).slice(0, 3).join(" / "));

  say("\n■ ⑤ 型エラーが基準より増えていないか（絶対ルール5）");
  const g = sh("npx", ["tsx", "scripts/tsc-gate.ts"]);
  check((g.out.split(/\r?\n/).find((l) => l.includes("型エラー")) ?? "型エラー").trim(), g.code === 0);

  say("\n■ ⑥ origin/main に追いつけるか（早送りで push できる）");
  git(["fetch", "origin", "main"]);
  const anc = git(["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
  check("origin/main が HEAD の祖先（force なしで入る）", anc.code === 0, "origin/main に手元に無いコミットがある＝先に取り込む");

  const sha = git(["rev-parse", "--short", "HEAD"]).out.trim();
  say(`\n  手元: ${version} @ ${sha}`);

  if (bad.length) {
    say(`\n${NG} 出せない所 ${bad.length} 件。直してから:`);
    bad.forEach((b, i) => say(`   ${i + 1}. ${b}`));
    process.exit(2);
  }
  say(`\n${OK} 出す前の点検は全部通った`);
  if (!DO_PUSH && !DO_ATTACH) {
    say("（読むだけ。--push で main と cursor-ext へ・--attach で手順書を DB へ・--all で続けて）");
    return;
  }

  if (DO_PUSH) {
    say("\n■ ⑦ push（main と cursor-ext・force しない）");
    for (const br of ["main", "cursor-ext"]) {
      const p = git(["push", "origin", `HEAD:${br}`]);
      check(`push → ${br}`, p.code === 0, p.out.split(/\r?\n/).slice(-2).join(" "));
    }
    if (bad.length) { say(`\n${NG} push で止まった`); process.exit(2); }
  }

  if (DO_ATTACH) {
    say(`\n■ ⑧ 本番が ${version} になるのを待つ（最大15分・20秒おき）`);
    let live = "";
    const until = Date.now() + 15 * 60_000;
    while (Date.now() < until) {
      try {
        const r = await fetch(`${PROD}/api/human-learn-profile?touch=0&scope=realpro`, { cache: "no-store", signal: AbortSignal.timeout(25000) });
        const j = (await r.json()) as Record<string, unknown>;
        live = j.server_rules_up_to != null ? String(j.server_rules_up_to) : "";
      } catch { live = ""; }
      if (live && cmpVer(live, version) >= 0) break;
      process.stdout.write(`  …本番=${live || "（読めない）"} 手元=${version}\n`);
      await sleep(20_000);
    }
    check(`本番の見直し上限 ${live || "-"} ≥ 手元 ${version}`, !!live && cmpVer(live, version) >= 0, "デプロイが終わっていない（Vercel を確認）");
    if (bad.length) { say(`\n${NG} 本番が古いまま。attach はしない（古い本番に新しい手順書を当てると食い違う）`); process.exit(2); }

    say("\n■ ⑨ 手順書を DB へ（控えはリポジトリの外）");
    const backup = path.join(os.homedir(), "playbook-backup");
    const a = sh("npx", ["tsx", "--env-file=.env.local", "scripts/attach-playbook.ts", "--apply", `--backup-dir=${backup}`]);
    check("attach-playbook --apply", a.code === 0, a.out.split(/\r?\n/).slice(-3).join(" "));
    a.out.split(/\r?\n/).filter((l) => /^■|名前:|版上げ|書きました/.test(l)).forEach((l) => say("   " + l.trim()));

    say("\n■ ⑩ 反映の同期点検（check-playbook-sync）");
    const s = sh("npx", ["tsx", "--env-file=.env.local", "scripts/check-playbook-sync.ts"]);
    const concl = s.out.split(/\r?\n/);
    const i0 = concl.findIndex((l) => l.includes("■ 結論"));
    (i0 >= 0 ? concl.slice(i0) : concl.slice(-12)).filter((l) => l.trim()).slice(0, 14).forEach((l) => say("   " + l.trim()));

    if (DO_PUSH) {
      const w = sh("npx", ["tsx", "--env-file=.env.local", "scripts/work-log.ts", "--add", `拡張 ${version} 反映`, "--status=waiting_owner",
        `--summary=${version} を main/cursor-ext へ push・本番・DB の手順書を揃えた（実機は未確認）`, `--next=拡張を再読込→リアプロのタブを開き直す→2客以上で自動→check-playbook-sync の④⑤⑧で確認`, `--commit=${sha}`, "--actor=作業員N"]);
      say(`  ${w.code === 0 ? OK : WA} work_log に「実機の確認待ち」を残した${w.code === 0 ? "" : "（失敗・手で足す）"}`);
    }
  }

  say("\n■ 人にしかできない手（これが済むまで「反映済み」と言わない）");
  say("   1. chrome://extensions で拡張を再読み込み（リアプロ・ITANDI のタブも開き直す）");
  say("   2. 自動を2客以上で1回回す");
  say("   3. npx tsx --env-file=.env.local scripts/check-playbook-sync.ts … ④の playbook_seen／⑤の版／⑧の新しい決まり（verified になるか）を見る");
  if (bad.length) process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
