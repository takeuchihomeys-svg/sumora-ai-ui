// 試験の係の --after-aix-draft（scripts/lib/exam-conductor-core.ts の parseAfterAixDraft・afterAixDraftArgv）と、前（main）の子への受け渡し・構成の鍵の単体テスト
// 実行: npx tsx scripts/lib/__tests__/exam-after-aix-draft.test.ts（全 PASS で exit 0）
// 2026-11-20 作業員H（作業員M の頼み・AIX の2通目の系統 AIX_SECOND_LEAN ほかの前と今を比べる道）
import { parseAfterAixDraft, afterAixDraftArgv } from "../exam-conductor-core";
import { childArgs } from "../brain-exam-baseline";
import { readFileSync } from "node:fs";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }

// 依頼の値を読む
{
  const a = parseAfterAixDraft("hint"), b = parseAfterAixDraft("none"), c = parseAfterAixDraft(""), d = parseAfterAixDraft(undefined), e = parseAfterAixDraft("yes");
  ok("hint", "value" in a && a.value === "hint");
  ok("none", "value" in b && b.value === "none");
  ok("空・無いは付けない", "value" in c && c.value === null && "value" in d && d.value === null);
  ok("違う値は積まない（error）", "error" in e && e.error.includes("none か hint"));
}
// brain-exam に渡す引数
{
  ok("hint を渡す", afterAixDraftArgv({ afterAixDraft: "hint" }).join() === "--after-aix-draft=hint");
  ok("none を渡す", afterAixDraftArgv({ afterAixDraft: "none" }).join() === "--after-aix-draft=none");
  ok("付けていない依頼は今までの argv のまま", afterAixDraftArgv({}).length === 0 && afterAixDraftArgv({ afterAixDraft: null }).length === 0);
}
// 前（main）の子にもそのまま渡る（前と今が同じ形で下書きを作る）
{
  const ch = childArgs(["--label=x", "--only=q1", "--baseline=main", "--stage=draft", "--after-aix-draft=hint"]);
  ok("前の子にも --after-aix-draft が渡る", ch.includes("--after-aix-draft=hint"), ch.join(" "));
  ok("前の子に label・only・baseline は渡らない", !ch.some((a) => /^--(label|only|baseline)=/.test(a)), ch.join(" "));
}
// 構成の鍵に入る（付けない回の前の答えと混ぜない）＝brain-exam.ts の examConfig の args に afterAixDraft がある
{
  const src = readFileSync("scripts/brain-exam.ts", "utf8");
  ok("構成の鍵に afterAixDraft（付けた時だけ）", /\.\.\.\(AFTER_AIX_DRAFT \? \{ afterAixDraft: AFTER_AIX_DRAFT \} : \{\}\)/.test(src));
}
// 係が argv に足している
{
  const src = readFileSync("scripts/exam-conductor.ts", "utf8");
  ok("係が argv に足す", src.includes("argv.push(...afterAixDraftArgv(j));"));
  ok("--add が読む", src.includes('parseAfterAixDraft(arg("after-aix-draft"))'));
}

console.log(`exam-after-aix-draft: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
