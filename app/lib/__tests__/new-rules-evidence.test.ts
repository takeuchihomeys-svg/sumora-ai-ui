// 新しい決まりが実機の自動で確かめられたか（newRulesEvidence）。2.8.313
//   「直した」と「実機で効いた」を混ぜない（拡張が古い／場面が出ない／守れていない／確かめられた を分ける）。
import { newRulesEvidence, AUTO_RULES, type AutoRule } from "../auto-procedure-rules";

let pass = 0, fail = 0;
const ok = (name: string, c: boolean, extra?: unknown) => {
  if (c) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

const rule = (over: Partial<AutoRule>): AutoRule => ({
  id: "r1", scene: "clear", text: "t", since: "2.8.313", kb: null, marker: "m", file: "page-script.js",
  verify: { onlyIf: ["page:a"], mustNot: ["page:b"] }, ...over,
} as AutoRule);
const S = (k: string, at: number) => ({ k, d: "", at });

console.log("\n■ 状態の分け方");
{
  const rs = [rule({})];
  const w = newRulesEvidence([], rs)[0];
  ok("記録が無ければ waiting_ext", w.state === "waiting_ext" && w.eligible_runs === 0, w);
  const old = newRulesEvidence([{ ext_version: "2.8.295", steps: [S("page:a", 1)] }], rs)[0];
  ok("古い版の回だけなら waiting_ext（守れたと数えない）", old.state === "waiting_ext", old);
  const none = newRulesEvidence([{ ext_version: "2.8.313", steps: [S("begin", 1), S("page:x", 2)] }], rs)[0];
  ok("新しい版で場面が出ない回だけなら no_scene", none.state === "no_scene" && none.eligible_runs === 1, none);
  const good = newRulesEvidence([{ ext_version: "2.8.313", steps: [S("page:a", 1)] }], rs)[0];
  ok("場面が出て mustNot が無ければ verified", good.state === "verified" && good.ok === 1, good);
  const bad = newRulesEvidence([{ ext_version: "2.8.314", steps: [S("page:a", 1), S("page:b", 2)] }], rs)[0];
  ok("mustNot が出たら ng", bad.state === "ng" && bad.ng === 1, bad);
  const mix = newRulesEvidence([
    { ext_version: "2.8.313", steps: [S("page:a", 1)] },
    { ext_version: "2.8.313", steps: [S("page:a", 1), S("page:b", 2)] },
  ], rs)[0];
  ok("1回でも ng なら ng（良い回に紛れさせない）", mix.state === "ng" && mix.ok === 1 && mix.ng === 1, mix);
  const nv = newRulesEvidence([], [rule({ verify: undefined })])[0];
  ok("確かめ方が無い決まりは no_verify", nv.state === "no_verify", nv);
}

console.log("\n■ 「新しい決まり」の範囲");
{
  const rs = [rule({ id: "a", since: "2.8.313" }), rule({ id: "b", since: "2.8.312" }), rule({ id: "c", since: "2.8.311" }), rule({ id: "d", since: "2.8.100" })];
  const ids = newRulesEvidence([], rs).map((x) => x.id).sort();
  ok("直近3つの版の決まりだけ（古い決まりは見ない）", JSON.stringify(ids) === JSON.stringify(["a", "b", "c"]), ids);
  const one = newRulesEvidence([], rs, { recent: 1 }).map((x) => x.id);
  ok("recent=1 なら最新の版だけ", JSON.stringify(one) === JSON.stringify(["a"]), one);
  const nosince = newRulesEvidence([], [rule({ id: "x", since: undefined as unknown as string })]);
  ok("since が無い決まりは数えない（落ちない）", nosince.length === 0);
}

console.log("\n■ 壊れない");
{
  ok("steps が null でも落ちない", newRulesEvidence([{ ext_version: "2.8.313", steps: null }], [rule({})])[0].state === "no_scene");
  ok("版が壊れていても落ちない（対象外）", newRulesEvidence([{ ext_version: "abc", steps: [S("page:a", 1)] }], [rule({})])[0].state === "waiting_ext");
  ok("版が null でも落ちない", newRulesEvidence([{ ext_version: null, steps: [S("page:a", 1)] }], [rule({})])[0].state === "waiting_ext");
}

console.log("\n■ 実物の決まり（今の AUTO_RULES）");
{
  const r = newRulesEvidence([], AUTO_RULES, { recent: 12 }); // 2.8.317: 直近3つの版では 2.8.313 の決まりが外れたので広げて見る（2.8.321: 版が増えて 6 でも外れたので 12 へ）
  ok("今回の決まり reset_clean_no_force_place が新しい決まりに入る", r.some((x) => x.id === "reset_clean_no_force_place"), r.map((x) => x.id));
  ok("記録が無い今は全部 waiting_ext か no_verify（verified と偽らない）", r.every((x) => x.state === "waiting_ext" || x.state === "no_verify"), r.map((x) => x.state));
  const real = newRulesEvidence([{ ext_version: "2.8.313", steps: [S("page:reset_clean_no_force_place", 1)] }], AUTO_RULES, { recent: 12 }).find((x) => x.id === "reset_clean_no_force_place");
  ok("実物: 印が出て place_redo が無ければ verified", real?.state === "verified", real);
  const real2 = newRulesEvidence([{ ext_version: "2.8.313", steps: [S("page:reset_clean_no_force_place", 1), S("page:place_redo", 2)] }], AUTO_RULES, { recent: 12 }).find((x) => x.id === "reset_clean_no_force_place");
  ok("実物: place_redo が出たら ng", real2?.state === "ng", real2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
