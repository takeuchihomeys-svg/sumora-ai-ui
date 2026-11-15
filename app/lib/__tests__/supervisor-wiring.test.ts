// app/lib/__tests__/supervisor-wiring.test.ts
//
// 2026-11-15 竹内さん「追加する」「強化したらちゃんと反映されるように統括もちゃんと把握するように」
//   「必要な土台があれば強化する」
//
// なぜ要るか（**同じ失敗を2回した**）:
//   ① `toggles`（外した/選んだ）を作ったのに `buildMeeting` に渡していなかった
//      → 統括の根拠にも議題にも出ていなかった（作った意味が無かった）
//   ② `shot_learn`（写真から読んだ欄）は415件学んでいたのに、束には数だけで中身が無かった
//   どちらも「作った」のに「届いていない」。目で見て気づくしかない状態だった。
//   → **機械的に点検する**（材料の項目が全部、統括の材料に入っているかを毎回確かめる）。
//
// 実行: npx tsx app/lib/__tests__/supervisor-wiring.test.ts
import { readFileSync } from "node:fs";
import { inputKeys, buildMeetingArgs, camelOf, checkWiring } from "../supervisor-wiring";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 材料の項目を型から読む");
{
  const sample = [
    "export type SupervisorInput = {",
    "  rows?: number;",
    "  next?: number;",
    "  /** コメントの中の fake_key?: number */",
    "  shot_rows?: number;",
    "  toggles?: { off: number };",
    "};",
    "",
    "export type SupervisorVerdict = \"ready\";",
  ].join("\n");
  const keys = inputKeys(sample);
  ok("トップレベルの項目を読む", keys.includes("rows") && keys.includes("next"));
  ok("コメントの中の名前は拾わない", !keys.includes("fake_key"));
  ok("snake_case も読む", keys.includes("shot_rows"));
  ok("オブジェクト型の項目も読む", keys.includes("toggles"));
  ok("次の型は含めない", !keys.includes("SupervisorVerdict"));
  ok("型が無ければ空", inputKeys("const x = 1;").length === 0);
  ok("空でも落ちない", inputKeys("").length === 0);
}

console.log("\n■ ② 渡している項目を読む（1行にまとめた形も拾う）");
{
  const sample = [
    "    meeting: buildMeeting({",
    "      site, verdict, rows, next, points,",
    "      guessedOpens: num(x),",
    "      toggles: (() => {",
    "        return { off: 1 };",
    "      })(),",
    "      photoKinds: null,",
    "    }),",
    "  };",
  ].join("\n");
  const args = buildMeetingArgs(sample);
  ok("1行にまとめた名前を拾う（rows）", args.includes("rows"));
  ok("1行にまとめた名前を拾う（next）", args.includes("next"));
  ok("key: の形も拾う（guessedOpens）", args.includes("guessedOpens"));
  ok("ネストした中身は拾わない（off）", !args.includes("off"));
  ok("トップレベルの key: も拾う（photoKinds）", args.includes("photoKinds"));
  ok("buildMeeting が無ければ空", buildMeetingArgs("const x = 1;").length === 0);
  ok("空でも落ちない", buildMeetingArgs("").length === 0);
}

console.log("\n■ ③ 名前の変換（材料 → 渡す時）");
{
  ok("with_ops → withOps", camelOf("with_ops") === "withOps");
  ok("shot_rows → shotRows", camelOf("shot_rows") === "shotRows");
  ok("human_ops → humanOps", camelOf("human_ops") === "humanOps");
  ok("site_counts → siteCounts", camelOf("site_counts") === "siteCounts");
  ok("weak → weakN（件数に変わる）", camelOf("weak") === "weakN");
  ok("photo_kinds → photoKinds", camelOf("photo_kinds") === "photoKinds");
  ok("知らない物はそのまま", camelOf("rows") === "rows");
}

console.log("\n■ ④ 本物のソースで点検（今の learn-supervisor.ts）");
{
  const src = readFileSync(require("path").join(__dirname, "../learn-supervisor.ts"), "utf8");
  const r = checkWiring(src);
  ok("点検できた", r.ok === true, r.line);
  ok("材料が見つかった（20件以上）", r.wired.length >= 20, r.wired.length);
  /**
   * ★ ここが**本題**: 材料が全部届いているか。
   *   ⚠ 届いていない物があれば**このテストが落ちる**＝強化したのに反映されていないと気づける。
   */
  ok("⚠ 届いていない材料が0件（全部届いている）", r.missing.length === 0, r.missing);
  ok("toggles が届いている（2026-11-15 追加）", r.wired.includes("toggles"));
  ok("prev は点検から除く（前回比較は別の所）", !r.missing.includes("prev"));
}

console.log("\n■ ⑤ 届いていない物を名指しできる（点検の効き目）");
{
  // わざと toggles を渡さないソースを作る
  const broken = [
    "export type SupervisorInput = {",
    "  rows?: number;",
    "  toggles?: { off: number };",
    "};",
    "function x() {",
    "    meeting: buildMeeting({",
    "      rows,",
    "    }),",
    "}",
  ].join("\n");
  const r = checkWiring(broken);
  ok("届いていない物を名指しする", r.missing.includes("toggles"), r.missing);
  ok("届いている物は missing に入れない", !r.missing.includes("rows"));
  ok("1行で理由が分かる", r.line.includes("届いていない"), r.line);
}

console.log("\n■ ⑥ なぜ必要かをコードに残している");
{
  const src = readFileSync(require("path").join(__dirname, "../supervisor-wiring.ts"), "utf8");
  ok("2回失敗したと書いてある", /同じ失敗を2回/.test(src));
  ok("作ったのに届いていないと書いてある", /作った.*届いていない/.test(src));
  ok("機械的に点検すると書いてある", /機械的に点検/.test(src));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
