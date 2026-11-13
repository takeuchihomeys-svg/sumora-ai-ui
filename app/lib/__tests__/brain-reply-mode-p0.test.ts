// app/lib/__tests__/brain-reply-mode-p0.test.ts — reply_mode の指示（BRAIN_REPLY_MODE_P0）（実行: npx tsx app/lib/__tests__/brain-prompt-rules-1112.test.ts）
// 実物の STATIC_BRAIN_SYSTEM（brain-core）を on／off の別プロセスで作って比べる
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { applyReplyModeP0, replyModeP0Enabled, REPLY_MODE_P0_EDITS } from "../brain-prompt-rules-1112";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) pass++; else { fail++; console.log("NG:", name); } };

if (process.argv[2] === "dump") {
  import("../brain-core").then((m) => { process.stdout.write(m.STATIC_BRAIN_SYSTEM); process.exit(0); });
} else {
  const run = (v: string) => execFileSync("npx", ["tsx", `"${__filename}"`, "dump"], { env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: "http://localhost:1", NEXT_PUBLIC_SUPABASE_ANON_KEY: "dummy", ANTHROPIC_API_KEY: "dummy", BRAIN_REPLY_MODE_P0: v }, maxBuffer: 64 * 1024 * 1024, shell: true, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
  const off = run("off"), on = run("on");
  const h = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 8);
  t("既定は on（off で戻す）", replyModeP0Enabled({}) && !replyModeP0Enabled({ BRAIN_REPLY_MODE_P0: "off" }));
  t("off の時は何も変えない（文が同じ）", applyReplyModeP0("abc", { BRAIN_REPLY_MODE_P0: "off" }) === "abc");
  t("実物 off: 古い3つの文が残っている（差し替え前の確認）", REPLY_MODE_P0_EDITS.every((e) => off.includes(e.from)));
  t("実物 on: 古い3つの文が消えている", REPLY_MODE_P0_EDITS.every((e) => !on.includes(e.from)));
  t("実物 on: 新しい3つの文が入っている", REPLY_MODE_P0_EDITS.every((e) => on.includes(e.to)));
  t("実物 on: 「判断に迷う時は必ずaix」が無い・P0 の問いが入る", !/判断に迷う時は必ずaix/.test(on) && /判断に迷う時は必ずaix/.test(off) && /スタッフだけが知る情報/.test(on));
  t("実物 on: 線引きルール該当時は aix が残る", /線引きルール該当時は aix/.test(on));
  t("on と off の違いは差し替えた所だけ（長さの差＝新旧の差の合計）", on.length - off.length === REPLY_MODE_P0_EDITS.reduce((a, e) => a + e.to.length - e.from.length, 0));
  t("元の文が無い時は黙って飛ばす", applyReplyModeP0("無関係", { BRAIN_REPLY_MODE_P0: "on" }) === "無関係");
  console.log(`off ${h(off)} (${off.length}字) / on ${h(on)} (${on.length}字)`);
  console.log(`pass ${pass} / fail ${fail}`);
  process.exit(fail ? 1 : 0);
}
