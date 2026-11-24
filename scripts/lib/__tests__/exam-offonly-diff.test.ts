// 2026-11-24 作業員A: main の変更が off のスイッチの中だけかの見分け（scripts/lib/exam-offonly-diff.ts）。迷う物は作り直す側
// 実行: npx tsx scripts/lib/__tests__/exam-offonly-diff.test.ts（env 不要・全 OK で exit 0）
import { parseUnifiedDiff, classifyHunk, offOnlyChange, gateSwitchesOf, newFileInert, neutralFunctionsOf, neutralHunk, type OffCtx } from "../exam-offonly-diff";

let passed = 0, failed = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log("  OK  " + name); } else { failed++; console.log("  NG  " + name + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : "")); }
}
const src = [
  'export const fooOn = (env: Env = process.env) => (env.FOO ?? "").trim().toLowerCase() === "on";',
  'export const barOn = (env: Env = process.env) => (env.BAR ?? "on").trim().toLowerCase() !== "off";',
  "export function fooLine(x: string): string {",
  "  if (!fooOn()) return \"\";",
  "  const a = x.trim();",
  "  return a + \"!\";",
  "}",
  "export function plain(x: string): string {",
  "  return x;",
  "}",
].join("\n");
const gates = gateSwitchesOf(src);
t("ゲートの関数 → スイッチ", gates.get("fooOn") === "FOO" && gates.get("barOn") === "BAR");
const ctx: OffCtx = { switchOff: (n) => n === "FOO", gateSwitch: (fn) => gates.get(fn) ?? null };
const diff = [
  "diff --git a/app/lib/x.ts b/app/lib/x.ts",
  "@@ -5 +5 @@ export function fooLine(x: string): string {",
  "-  return a + \"?\";",
  "+  return a + \"!\";",
  "@@ -8 +8 @@",
  "-  return x + \"\";",
  "+  return x;",
].join("\n");
const fs = parseUnifiedDiff(diff);
t("diff を塊に分ける", fs.length === 1 && fs[0].hunks.length === 2 && fs[0].hunks[0].newStart === 5);
t("off で抜ける関数の中の変更＝guarded", classifyHunk(fs[0], fs[0].hunks[0], src, ctx).kind === "guarded");
t("ゲートの無い関数の中の変更＝作り直す", classifyHunk(fs[0], fs[0].hunks[1], src, ctx).kind === "unsafe");
t("1つでも作り直す塊があれば全体も作り直す", !offOnlyChange(fs, new Map([["app/lib/x.ts", src]]), ctx).safe);
const onCtx: OffCtx = { switchOff: () => false, gateSwitch: (fn) => gates.get(fn) ?? null };
t("その構成でスイッチが on（既定 on・env で on）なら guarded にしない", classifyHunk(fs[0], fs[0].hunks[0], src, onCtx).kind === "unsafe");
const mk = (added: string[], removed: string[] = [], at = 20) => ({ oldStart: at, oldLines: removed.length, newStart: at, newLines: added.length, added, removed });
const f0 = { path: "app/lib/x.ts", isNew: false, isDeleted: false, hunks: [] };
t("コメントだけ", classifyHunk(f0, mk(["  // 説明を足した", ""]), src, ctx).kind === "comment");
t("if (fooOn()) { … } を足しただけ＝offblock", classifyHunk(f0, mk(["  if (fooOn()) {", "    lines.push(\"x\");", "  }"]), src, ctx).kind === "offblock");
t("if (barOn()) { … }（既定 on）＝作り直す", classifyHunk(f0, mk(["  if (barOn()) {", "    lines.push(\"x\");", "  }"]), src, ctx).kind === "unsafe");
t("else を伴う if は形が違う＝作り直す", classifyHunk(f0, mk(["  if (fooOn()) {", "    a();", "  } else {", "    b();", "  }"]), src, ctx).kind === "unsafe");
t("新しい関数の宣言だけ＝newdecl", classifyHunk(f0, mk(["export function newOne(x: string): string {", "  return x;", "}"]), src, ctx).kind === "newdecl");
t("行頭で動く文（呼び出し）＝作り直す", classifyHunk(f0, mk(["registerThing();"]), src, ctx).kind === "unsafe");
t("副作用の読み込み＝作り直す", classifyHunk(f0, mk(['import "./side-effect";']), src, ctx).kind === "unsafe");
t("新しいファイル: 宣言だけなら動かない", newFileInert('import { a } from "./a";\nexport const xOn = () => true;\nexport function f() {\n  return 1;\n}\n') && !newFileInert("const x = 1;\ndoIt();\n"));
t("消したファイル＝作り直す", !offOnlyChange([{ path: "app/lib/y.ts", isNew: false, isDeleted: true, hunks: [] }], new Map(), ctx).safe);
t("変更が無い＝safe にしない（鍵は別の物で変わった）", !offOnlyChange([], new Map(), ctx).safe);

// neutral（11/24 夕）: off なら偽を返す関数を挟んだだけ（11/18 の SCREENING_SIGNAL_BRAIN_FIRST の実例の形）
const lib = [
  'export function screeningOn(env?: Env): boolean {',
  '  return (env?.SCR ?? "").trim().toLowerCase() === "on";',
  '}',
  'export function skipped(o: { a: boolean }, env?: Env): boolean {',
  '  if (!screeningOn(env)) return false;',
  '  return o.a;',
  '}',
  'export function always(o: { a: boolean }): boolean {',
  '  return o.a;',
  '}',
].join("\n");
const g2 = gateSwitchesOf(lib);
const c2: OffCtx = { switchOff: (n) => n === "SCR", gateSwitch: (fn) => g2.get(fn) ?? null };
const neu = neutralFunctionsOf([lib], c2);
t("off なら偽を返す関数とゲートを拾う・ゲートの無い関数は拾わない", neu.has("skipped") && neu.has("screeningOn") && !neu.has("always"), [...neu]);
const real = mk([
  '        const skip = !!sig0 && (await import("@/app/lib/x")).skipped({ a: brainNo });',
  '        if (skip) console.info("[x]", JSON.stringify({ id }));',
  '        const sig = sig0 && !skip && adopt(brainNo) ? sig0 : null;',
], ['        const sig = sig0 && adopt(brainNo) ? sig0 : null;']);
t("実例の形（const＋if の1行＋「!v &&」の差し込み）＝neutral", neutralHunk(real, neu) !== null);
t("classifyHunk でも neutral", classifyHunk(f0, real, src, { ...c2, neutral: neu }).kind === "neutral");
const andNot = mk(['        const skip = skipped({ a });', '        const sig = sig0 && adopt(b) && !skip ? sig0 : null;'], ['        const sig = sig0 && adopt(b) ? sig0 : null;']);
t("「&& !v」は値が変わり得る＝作り直す", neutralHunk(andNot, neu) === null);
const alw = mk(['        const skip = always({ a });', '        const sig = sig0 && !skip && adopt(b) ? sig0 : null;'], ['        const sig = sig0 && adopt(b) ? sig0 : null;']);
t("off でも偽と言えない関数の値＝作り直す", neutralHunk(alw, neu) === null);
const tpl = mk(['  const p = `頭${screeningOn() ? "【足す】" : ""}尾`;'], ['  const p = `頭尾`;']);
t("テンプレートに ${gate() ? … : \"\"} を差し込んだだけ＝neutral", neutralHunk(tpl, neu) !== null);
const sp = mk(['  const xs = [a, ...(screeningOn() ? [b] : []), c];'], ['  const xs = [a, c];']);
t("...(gate() ? [..] : []) を差し込んだだけ＝neutral", neutralHunk(sp, neu) !== null);
const del = mk(['  const sig = sig0 ? sig0 : null;'], ['  const sig = sig0 && adopt(b) ? sig0 : null;']);
t("前の行から字を消した＝作り直す", neutralHunk(del, neu) === null);
const two = mk(["        const skip = skipped({ a });", "        if (skip) a(); b();", "        const sig = sig0 && !skip && adopt(b) ? sig0 : null;"], ["        const sig = sig0 && adopt(b) ? sig0 : null;"]);
t("if (v) の行に文が2つ（後ろは off でも動く）＝作り直す", neutralHunk(two, neu) === null);
const one = mk(["        const skip = skipped({ a });", '        if (skip) console.info("a;b", { x: 1 });', "        const sig = sig0 && !skip && adopt(b) ? sig0 : null;"], ["        const sig = sig0 && adopt(b) ? sig0 : null;"]);
t("文字列の中の ; は数えない＝neutral", neutralHunk(one, neu) !== null);
console.log(`\n${passed} OK / ${failed} NG`);
process.exit(failed ? 1 : 0);
