/**
 * 手順書（auto-procedure-rules.ts）の「連続ループ」まわりの食い違い・古い決まりが残っていないかの点検（静的）
 *   2026-11-26 竹内さん「最新の手順書でここの一連のループの流れで邪魔になっているものや昔のデータでボトルネックになっている部分ないのか徹底的に調査」
 *   実測 #1656（2.8.295・リセットを押さない旧方式）: 1つずつ外しが21分かかり『前客を外し切れず中止』で客が落ちた
 *   → 「外す」を命じる決まりは、必ずリセット優先の断りを持つ（持たない決まりは、古い前提のまま現場を遅くする）
 */
"use strict";
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");
const src = fs.readFileSync(path.join(root, "app/lib/auto-procedure-rules.ts"), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
function ok(n, c, e) { if (c) pass++; else { fail++; console.log("NG: " + n + (e === undefined ? "" : " " + JSON.stringify(e).slice(0, 300))); } }

// 決まりを素朴に切り出す（id・scene・since・text）
const rules = [];
src.split(/\n    id: "/).slice(1).forEach((chunk) => {
  const id = chunk.slice(0, chunk.indexOf('"'));
  const sc = (chunk.match(/scene:\s*"([^"]+)"/) || [])[1] || "";
  const tm = chunk.match(/\n\s*text:\s*("(?:[^"\\]|\\.)*")/);
  const since = (chunk.match(/\n\s*since:\s*(null|"[^"]*")/) || [])[1];
  if (!tm) return;
  let text = "";
  try { text = JSON.parse(tm[1]); } catch (_) { text = tm[1]; }
  rules.push({ id, scene: sc, text, since: since && since !== "null" ? since.slice(1, -1) : null });
});
ok("決まりを読めた（100件以上）", rules.length >= 100, rules.length);
const by = (id) => rules.find((r) => r.id === id) || { text: "" };

console.log("\n■ 『外す』を命じる決まりは、リセット優先の断りを持つ");
const CLEAR_WORDS = /1つずつ外|外しも|外し切|外し方|外しは|外す時|外し→|外しを|送付後の外し|前客を外|前客の.{0,8}外/;
const mustHave = rules.filter((r) => ["clear", "search", "switch"].includes(r.scene) && CLEAR_WORDS.test(r.text));
const lacking = mustHave.filter((r) => !/reset_replaces_clear|reset_retry_insurance|リセット/.test(r.text));
ok("外しに触れる決まり（" + mustHave.length + "件）は全部リセット優先に触れている", lacking.length === 0, lacking.map((r) => r.id));

console.log("\n■ 古い短い待ちが現行として残っていない");
["search_to_sort_cursor", "search_confirm_then_wait_sort"].forEach((id) => {
  const t = by(id).text;
  ok(id + " は 30〜36秒を言う", /30〜36秒|30秒/.test(t), t.slice(0, 80));
  ok(id + " の「1秒」は『旧…廃止』としてだけ出る", !/1秒/.test(t) || /旧[^。]{0,12}1秒[^。]{0,12}廃止/.test(t), t.match(/.{0,20}1秒.{0,20}/));
});

console.log("\n■ 連続ループの道筋（series_handoff_order）が閉じている");
const loop = by("series_handoff_order").text;
ok("①〜⑤がある", ["①", "②", "③", "④", "⑤"].every((c) => loop.includes(c)));
ok("⑤は次の客があれば①へ戻る（ループ）", /⑤[^。]*①へ戻る/.test(loop));
ok("リセット→読み直し→次客の条件はAPIから、の順", loop.indexOf("リセット") > 0 && loop.indexOf("リセット") < loop.indexOf("読み直"), loop.slice(0, 60));
ok("最後の客は待たず裏でリセットして終わる", /最後のお客さんは完了を待たせず裏でリセット/.test(loop));
ok("リセットが使えない時だけ従来の外し", /リセットが押せない・空にならない時だけ/.test(loop));

console.log("\n■ リセット周りの決まりが互いに食い違わない");
const rb = by("reset_between_customers").text, rc = by("reset_count_evidence").text || "";
ok("reset_between_customers: 空なら件数が増えなくても成功", /増えなくても成功/.test(rb));
ok("reset_between_customers: 保険（もう1回押す）を書く", /reset_retry_insurance/.test(rb));
ok("どの決まりも『空でも数が増えなければ従来の外し』と言っていない", rules.every((r) => !/空でも数が増えなければ従来の1つずつ外しへ/.test(r.text)), rules.filter((r) => /空でも数が増えなければ/.test(r.text)).map((r) => r.id));
ok("保険の決まりがある", /reset_stuck_shot/.test(by("reset_retry_insurance").text) && /reset_retry/.test(by("reset_retry_insurance").text));

console.log("\n■ 待ちの数字が決まりの間でそろう");
// リセット後の待ち 30秒以上（30〜34秒）／並べ替え 30〜36秒／間の上限 260秒
const allText = rules.map((r) => r.text).join("\n");
ok("リセット後の待ちは 30〜34秒 で書かれている（別の数字で書く決まりが無い）", !/リセット[^。]{0,40}(?:\b|[^0-9])(?:10|15|20|25)秒(?:以上)?[^。]{0,10}待/.test(allText.replace(/10秒以上の間を含む/g, "")), allText.match(/リセット[^。]{0,40}(?:10|15|20|25)秒[^。]{0,10}待/));
ok("並べ替えの待ちを 5秒・10秒 と書く決まりが無い", !/(?:検索|確認)[^。]{0,30}(?:から|後)[^。]{0,10}(?:5|10)秒待って並べ替え/.test(allText));

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
