/**
 * 2.8.307 竹内さん「5（資料を見る間）はいるのか／4 リセットが押せたら1つずつ外しはやらない・ボトルネックにしない／ループを理解しているか」
 *   ① リセット成功（空）の客は資料を見る間を省く ② 空なら件数が増えなくても成功 ③ ページ側も空なら『きれい』印
 *   ④ 手順書: ループの明記・古い外しの層に前置き
 */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");
const rd = (p) => fs.readFileSync(path.join(root, p), "utf8").replace(/\r\n/g, "\n");
const bg = rd("chrome-extension/background.js");
const ps = rd("chrome-extension/page-script.js");
const sa = rd("chrome-extension/search-audit.js");
const rules = rd("app/lib/auto-procedure-rules.ts");
const man = JSON.parse(rd("chrome-extension/manifest.json"));
let pass = 0, fail = 0;
function ok(n, c, e) { if (c) pass++; else { fail++; console.log("NG: " + n + (e === undefined ? "" : " " + JSON.stringify(e).slice(0, 200))); } }

console.log("\n■ 版");
ok(
  "manifest = page = 手順書の見直し上限（≥2.8.307）",
  man.version === (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] &&
    (rules.match(/AUTO_RULES_REVIEWED_UP_TO = "([^"]+)"/) || [])[1] === man.version &&
    man.version.split(".").map(Number)[2] >= 307,
  man.version
);

console.log("\n■ ① リセット成功の客は資料を見る間を省く");
ok("送付後のリセット結果を _axlxLastPsReset に残す", /self\._axlxLastPsReset = \{ cid: String\(customerId\), ok: !!\(_psRes && _psRes\.ok && _psRes\.reset\)/.test(bg));
ok("一括ループが _skipLook で省く（同じ客・3分以内・ok）", /_skipLook = !!\(_lp && _lp\.ok && String\(_lp\.cid\) === String\(_bc\.id\) && Date\.now\(\) - _lp\.at < 180000\)/.test(bg));
ok("省いた事を look_skip で残す", /_auditStep\(_bulkAudit\.runId, "look_skip"/.test(bg));
ok(
  "省かない時は今までの待ち（_bulkPhaseSet look と setTimeout）",
  /\} else \{\n\s*console\.log\("\[manual-bulk-search\] 👀 資料を見る間 "[\s\S]{0,200}_bulkPhaseSet\("look", _lookMs, \{\}\);\n\s*await new Promise\(function \(r\) \{ setTimeout\(r, _lookMs\); \}\);/.test(bg)
);
ok("look_skip は点検の段として残る（KEEP_STEP・RULE_STEP の両方）", (sa.match(/look_skip/g) || []).length >= 2);

console.log("\n■ ② 空なら件数が増えなくても成功（1つずつ外しに回さない）");
const bgVerify = bg.slice(bg.indexOf("async function _postSendResetRealpro"), bg.indexOf("async function _postSendClearOrReset"));
// 2.8.317: 送付後のリセットは押して30〜34秒待ったら空とみなす（読み戻しループ・件数の記録・reset_not_empty は廃止）
ok("押して空を確かめたら完了（reset_settled・confirmed・空とみなさない）", /_stamp\("reset_settled"/.test(bgVerify) && /confirmed: true/.test(bgVerify) && !/assumedEmpty: true/.test(bgVerify));
ok("空の確認ループ（RESET_VERIFY_TOTAL_MS）は無い", bgVerify.indexOf("RESET_VERIFY_TOTAL_MS") < 0);
ok("旧の『空でも増えなければ従来の外しへ』は無い", !/countSame: true, why: "reset_count_same"/.test(bgVerify));
ok("押せない・例外の時は ok:false で呼び元の保険へ（従来の外しへ行かない）", /ok: false/.test(bgVerify) && /reset_press", "押せず→保険/.test(bgVerify));

console.log("\n■ ③ ページ側も空なら『きれい』印を付ける");
const verifySrc = ps.slice(ps.indexOf("  function _resetVerify(opts, done) {"), ps.indexOf("  function _axResetCleanFresh"));
ok("時間が来て空なら CLEAN_KEY を付ける", /Date\.now\(\) - t0 > maxMs\) \{\n\s*if \(ready && st\.empty\) \{[\s\S]{0,300}_AX_RESET_CLEAN_KEY/.test(verifySrc));
ok("空でない時は印を付けない（empty は別に返す）", /empty: !!\(ready && st\.empty\), verified: false/.test(verifySrc));

console.log("\n■ ④ 手順書");
const block = (id) => {
  const i = rules.indexOf('id: "' + id + '"');
  return i < 0 ? "" : rules.slice(i, rules.indexOf("\n  },", i));
};
ok("決まり reset_empty_is_enough がある", block("reset_empty_is_enough").includes('since: "2.8.307"'));
ok("決まり reset_success_skips_look がある", block("reset_success_skips_look").includes('marker: "reset_success_skips_look"'));
ok(
  "series_handoff_order にループ（⑤次のお客さんは①へ戻る・最後は待たない）がある",
  /⑤次のお客さんがいれば①へ戻る/.test(block("series_handoff_order")) && /最後のお客さんは完了を待たせず/.test(block("series_handoff_order"))
);
ok("series_handoff_order は『空かの読み戻し・写真・猶予は置かない』と書く（資料を見る間は reset_success_skips_look）", /空かの読み戻し・写真・猶予は置かない/.test(block("series_handoff_order")));
const OLD = [
  "continuous_customer_loop", "flow_series_grasp", "flow_series_order_gate", "customer_loop_one_by_one", "clear_then_fill_gate",
  "one_task_complete_before_next", "samekind_clear_before_fill", "now_action_clear_then_fill", "task_grasp_now_done_next", "continuous_series_next_grasp",
];
// 2026-11-26 更新: 貼り足しの前置き（「この外しの段は行わず」）は、外しと関係ない決まりにも一括で付いていて誤った文だった。
// 事実だけの札「外しはリセットで空にする（reset_replaces_clear）」に置き換えた。貼り足しは残さない。
ok(
  "古い外しの層10本に、本文がリセットを主手順にしている（札か書き直し）",
  OLD.every((id) => /リセット/.test(block(id))),
  OLD.filter((id) => !/リセット/.test(block(id)))
);
ok(
  "貼り足しの前置き（この外しの段は行わず次へ進む）は、どの決まりにも残らない",
  !/この外しの段は行わず次へ進む/.test(rules)
);ok("新2本の marker が拡張の中にある", bg.includes("reset_empty_is_enough") && bg.includes("reset_success_skips_look"));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
