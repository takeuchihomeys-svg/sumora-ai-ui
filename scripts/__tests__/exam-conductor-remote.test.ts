// scripts/__tests__/exam-conductor-remote.test.ts — tsc-remote（ビルドのログの読み・上げる前の確かめ）
//   実行: npx tsx scripts/__tests__/exam-conductor-remote.test.ts（この作業ツリーの上がる一覧も確かめる）
import { remoteTypeErrors, REMOTE_IGNORE, REMOTE_FORBIDDEN, remoteUploadCheck } from "../exam-conductor";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
(async () => {
  const log = ["Creating an optimized production build ...", "Failed to compile.", "./app/lib/x.ts:12:5", "Type error: Property 'a' does not exist on type 'B'.", "", "scripts/y.ts(3,1): error TS2304: Cannot find name 'z'."].join("\n");
  const e = remoteTypeErrors(log);
  t("型エラーを2つ拾う・場所を前に付ける", e.length === 2 && e[0].startsWith("./app/lib/x.ts:12:5 Type error:") && e[1].includes("error TS2304"));
  t("型エラーが無ければ空", remoteTypeErrors("Build Completed\nREADY").length === 0);
  t("最大3つ", remoteTypeErrors(Array(5).fill("Type error: x").join("\n")).length === 3);
  t("送らない物に .env と試験の控え", REMOTE_IGNORE.includes(".env*") && REMOTE_IGNORE.includes("scripts/brain-exam/results") && REMOTE_IGNORE.includes(".claude") && REMOTE_IGNORE.includes("scratchpad"));
  t("上げてはいけない物の見分け", REMOTE_FORBIDDEN(".env.local") && REMOTE_FORBIDDEN("a/.env.prod") && !REMOTE_FORBIDDEN(".env.example") && REMOTE_FORBIDDEN(".claude/x") && REMOTE_FORBIDDEN("x/exam-cache/y.json") && !REMOTE_FORBIDDEN("app/lib/env-check.ts"));
  const r = await remoteUploadCheck(process.cwd());
  console.log(`  （この作業ツリー: ${r.why}）`);
  t("この作業ツリーの上がる一覧に .env 系が無い", r.ok && r.bad.length === 0 && r.files > 100);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
