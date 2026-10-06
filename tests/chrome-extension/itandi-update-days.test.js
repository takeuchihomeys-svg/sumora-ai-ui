// 実行: node tests/chrome-extension/itandi-update-days.test.js
// ITANDI の「募集条件更新 [ ] 日以内」に更新日を入れる（chrome-extension/itandi-update-days.js・v2.5.34）の回帰テスト。
// 2026-09-27 竹内「リアプロはボタンで選択やけど ITANDI は入力となる（更新日）」
//
// ① 値の決まり（なし と 0 を分ける・読み戻しの読み方・一覧の選択肢の見分け）
// ② 欄の探し方（「募集条件更新」の文字から近い入力欄・他の欄を取らない・name の予備・無い時は null）
// ③ 入れ方（人の操作の形: 押す → 空 → 1文字ずつ → 一覧を押す／確定。Escape を使わない・入った値を確かめてから返す）
//    ・日数なし＋欄が空 → 触らない（今までどおり）
//    ・前のお客様の値が残っている → 空にする（なし を押す）
//    ・一覧（なし/0〜9）に無い 14 → 打たない → なし で out_of_range（9 に丸めない・前の 3 を残さない）
//    ・一覧が無く打っただけ → set_typed（確定は未確認・点検は warn）
//    ・名前だけの予備で見つけた欄は how="name"（呼ぶ側は打たない）・お金の欄（renew/fee）は候補にしない
//    ・空にもできない → stuck（呼ぶ側は検索を押さない）
// ④ 配線（manifest の同じ world:MAIN の段・検索を押す前に入れる・popup/background が日数を渡す・固定の待ちを足していない）
const fs = require("fs");
const path = require("path");
const UD = require("../../chrome-extension/itandi-update-days.js");

const EXT = path.join(__dirname, "../../chrome-extension");
const read = (f) => fs.readFileSync(path.join(EXT, f), "utf8").replace(/\r\n/g, "\n");
let pass = 0, fail = 0;
function ok(name, cond, detail) { cond ? pass++ : fail++; console.log((cond ? "  ✓ " : "  ✗ ") + name + (cond || !detail ? "" : "\n      " + detail)); }
function eq(name, a, b) { const c = JSON.stringify(a) === JSON.stringify(b); ok(name, c, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// ── 小さな偽の DOM（children・parentElement・textContent・tagName・getAttribute だけ）──
class El {
  constructor(tag, attrs, kids) {
    this.tagName = tag.toUpperCase(); this.attrs = attrs || {}; this.children = []; this.parentElement = null; this.ownText = "";
    this.name = this.attrs.name || ""; this.type = this.attrs.type || (this.tagName === "INPUT" ? "text" : ""); this.value = this.attrs.value || "";
    (kids || []).forEach((k) => { if (typeof k === "string") this.ownText += k; else { k.parentElement = this; this.children.push(k); } });
  }
  getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(""); }
}
const h = (tag, attrs, ...kids) => new El(tag, attrs, kids);

console.log("\n■ ① 値の決まり");
eq("normDays: null/undefined/''/なし → null", [null, undefined, "", "なし", "指定なし"].map(UD.normDays), [null, null, null, null, null]);
eq("normDays: 0 は 0（なしと別）", [0, "0"].map(UD.normDays), [0, 0]);
eq("normDays: 1/3/7/14・'3日'・負は null", [1, "3", 7, 14, "3日", -1].map(UD.normDays), [1, 3, 7, 14, 3, null]);
eq("readDays: ''・なし → null／'0' → 0／'3日以内' → 3／'１' → 1（全角）", ["", "なし", "0", "3日以内", "１"].map(UD.readDays), [null, null, 0, 3, 1]);
ok("readDays: 読めない文字はそのまま（数と取り違えない）", UD.readDays("abc") === "abc");
ok("一覧: 「なし」は null に当たる・「0」は当たらない", UD.optionMatches("なし", null) && !UD.optionMatches("0", null));
ok("一覧: 「0」は 0 に当たる・「なし」は 0 に当たらない", UD.optionMatches("0", 0) && !UD.optionMatches("なし", 0));
ok("一覧: 「1」は 1 だけ（14 に当たらない）", UD.optionMatches("1", 1) && !UD.optionMatches("1", 14));
eq("plan: 空→なし=keep／3→3=keep／3→なし=clear／空→7=set／0→なし=clear", [UD.plan("", null), UD.plan("3", 3), UD.plan("3", null), UD.plan("", 7), UD.plan("0", null)], ["keep", "keep", "clear", "set", "clear"]);

console.log("\n■ ② 欄の探し方");
function itandiForm(updInput) {
  return h("form", {},
    h("div", {}, h("span", {}, "賃料"), h("input", { name: "rent:gteq" }), h("span", {}, "〜"), h("input", { name: "rent:lteq" })),
    h("div", {}, h("span", {}, "駅徒歩"), h("input", { name: "station_walk_minutes:lteq" }), h("span", {}, "分以内")),
    h("div", {}, h("div", {}, h("label", {}, "募集条件更新")), h("div", {}, h("div", {}, updInput)), h("span", {}, "日以内")),
    h("div", {}, h("span", {}, "築年数"), h("input", { name: "building_age:lteq" }), h("span", {}, "年以内")),
    h("div", {}, h("label", {}, h("input", { type: "checkbox", name: "option_id:all_in" }), "ペット相談")));
}
{
  const inp = h("input", { id: "_r_1f_", role: "combobox" });
  const f = UD.findField(itandiForm(inp));
  ok("「募集条件更新」の文字から近い入力欄（name が無い MUI の欄でも）", f && f.el === inp && f.how === "label", f && f.el && f.el.attrs.id);
  const sel = h("select", { name: "x" });
  const f2 = UD.findField(itandiForm(sel));
  ok("select の形でも取れる", f2 && f2.el === sel);
  // 文字の要素そのものが欄を包む形
  const inp3 = h("input", {});
  const f3 = UD.findField(h("form", {}, h("label", {}, "募集条件更新", inp3, "日以内"), h("input", { name: "rent:lteq" })));
  ok("<label>募集条件更新 <input> 日以内</label> の形", f3 && f3.el === inp3);
  // 文字が無い時は name の予備
  const inp4 = h("input", { name: "condition_updated_within:lteq" });
  const f4 = UD.findField(h("form", {}, h("input", { name: "rent:lteq" }), inp4));
  ok("文字が無い時は name に update を含む欄（予備・how=name＝呼ぶ側は打たない）", f4 && f4.el === inp4 && f4.how === "name");
  // v2.5.34 反証の検証: 更新料の欄（renewal_fee）を予備で拾わない
  const fee = UD.findField(h("form", {}, h("input", { name: "rent:lteq" }), h("input", { name: "renewal_fee:lteq" })));
  ok("更新料の欄（renewal_fee）は予備でも拾わない → null", fee === null, fee && fee.el.name);
  const feeNear = UD.findField(h("form", {}, h("div", {}, h("span", {}, "募集条件更新"), h("input", { name: "renewal_fee_months" }), h("span", {}, "日以内"))));
  ok("文字の近くにあってもお金の欄（renewal_fee）は取らない", feeNear === null, feeNear && feeNear.el.name);
  const f5 = UD.findField(h("form", {}, h("span", {}, "募集条件更新"), h("input", { name: "rent:lteq" }), h("input", { name: "building_age:lteq" })));
  ok("近くに他の欄（賃料・築年）しか無い時は取らない → null", f5 === null, f5 && f5.el.name);
  ok("何も無い → null（検索は止めない）", UD.findField(h("form", {}, h("input", { name: "rent:lteq" }))) === null);
  // 一覧の列の見出し（募集条件更新日）だけがある時、見出しから遠いフォーム全体の欄を拾わない
  const wide = h("div", {}, h("th", {}, "募集条件更新日"), h("input", { name: "a" }), h("input", { name: "b" }), h("input", { name: "c" }), h("input", { name: "d" }));
  ok("文字の近くに入力欄が4つ以上（広すぎる）→ 決めない", UD.findField(wide) === null);
  // ページ全体（body）で探す時: 一覧の見出し「募集条件更新日」が先にあっても、フォームの「募集条件更新」の欄を取る
  const formInp = h("input", { id: "_r_2a_" });
  const page = h("body", {},
    h("table", {}, h("tr", {}, h("th", {}, "募集条件更新日"), h("td", {}, h("input", { name: "memo" })))),
    h("div", {}, h("span", {}, "募集条件更新"), formInp, h("span", {}, "日以内")));
  const fp = UD.findField(page);
  ok("見出し「募集条件更新日」よりフォームの「募集条件更新」を先に試す", fp && fp.el === formInp, fp && JSON.stringify(fp.el.attrs));
}

console.log("\n■ ③ 入れ方（人の操作の形・入った値を確かめる）");
// 偽の欄: kind="plain"（打った値がそのまま入る）／"mui"（一覧 なし/0〜9 から押した時だけ値が決まり、欄を離れると押した値に戻る）／"frozen"（変わらない）
function makeEnv(kind, initial) {
  const el = new El("input", { value: initial || "" });
  el.value = initial || "";
  const log = [];
  let committed = initial || ""; // mui の選ばれている値
  let open = false;
  const OPTS = ["なし", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
  const env = {
    later: (fn, ms) => { log.push(["wait", ms]); fn(); },
    hd: (ms) => ms, sd: (ms) => ms,
    setVal: (e, v) => { log.push(["set", v]); if (kind !== "frozen") e.value = v; if (kind === "mui") open = true; },
    fire: (e, t) => { log.push(["fire", t]); },
    press: (e) => { log.push(["press"]); if (kind === "mui") open = true; },
    click: (o) => { log.push(["click", o.textContent]); committed = o.textContent === "なし" ? "" : o.textContent; el.value = committed; open = false; },
    blur: (e) => { log.push(["blur"]); if (kind === "mui") { el.value = committed; open = false; } },
    options: () => {
      if (kind !== "mui" || !open) return [];
      const typed = String(el.value || "");
      return OPTS.filter((o) => !typed || o.indexOf(typed) === 0).map((o) => ({ textContent: o }));
    },
  };
  return { el, env, log };
}
function runSync(kind, initial, days) {
  const m = makeEnv(kind, initial); let res = null;
  UD.run(m.el, days, m.env, (r) => { res = r; });
  return { res, log: m.log, el: m.el };
}
{
  const a = runSync("mui", "", null);
  ok("日数なし＋欄が空 → 触らない（kept・操作0回）", a.res.status === "kept" && a.log.length === 0, JSON.stringify(a.log));
  const b = runSync("mui", "", 3);
  ok("空 → 3: 押す → 空 → 「3」を打つ → 一覧の「3」を押す → set", b.res.status === "set" && b.el.value === "3" && b.res.how_set === "option", JSON.stringify(b.res));
  eq("操作の順（押す・空・打つ・一覧・Escape なし）", b.log.filter((x) => x[0] !== "wait").map((x) => x.join(":")), ["press", "set:", "set:3", "click:3", "blur"]);
  ok("待ちは全部 human-wait（hd/sd）を通る（250・140・300）", b.log.filter((x) => x[0] === "wait").every((x) => [250, 140, 300].includes(x[1])));
  const c = runSync("mui", "7", null);
  ok("前のお客様の 7 が残っている＋日数なし → 「なし」を押して空（cleared）", c.res.status === "cleared" && c.el.value === "" && c.log.some((x) => x[0] === "click" && x[1] === "なし"), JSON.stringify(c.log));
  const d = runSync("mui", "3", 3);
  ok("もう同じ 3 → 触らない（kept）", d.res.status === "kept" && d.log.length === 0);
  const e = runSync("mui", "", 0);
  ok("0（当日）→ 一覧の「0」を押す（なし と取り違えない）", e.res.status === "set" && e.el.value === "0" && e.log.some((x) => x[0] === "click" && x[1] === "0"));
  const f = runSync("mui", "3", 14);
  ok("一覧に無い 14＋前の 3 → 打たずに なし を押して空（out_of_range・前の 3 を残さない）", f.res.status === "out_of_range" && f.el.value === "" && f.log.some((x) => x[0] === "click" && x[1] === "なし"), JSON.stringify(f.res));
  ok("14 は1文字も打たない（人は一覧に無い数を打たない）", !f.log.some((x) => x[0] === "set" && /^1/.test(x[1])), JSON.stringify(f.log));
  ok("9 に丸めない（狭くなり物件が漏れる）", !f.log.some((x) => x[0] === "click" && x[1] === "9"));
  const f0 = runSync("mui", "", 14);
  ok("一覧に無い 14＋欄は空 → 押して一覧を見て離れるだけ（out_of_range・打たない）", f0.res.status === "out_of_range" && f0.el.value === "" && f0.log.filter((x) => x[0] !== "wait").map((x) => x[0]).join() === "press,blur", JSON.stringify(f0.log));
  const g = runSync("plain", "", 14);
  ok("一覧が無くそのまま打てる欄なら 14 も打つ → set_typed（確定は未確認）", g.res.status === "set_typed" && g.el.value === "14" && g.res.how_set === "typed", JSON.stringify(g.res));
  eq("1文字ずつ打つ（1 → 14）", g.log.filter((x) => x[0] === "set").map((x) => x[1]), ["", "1", "14"]);
  ok("打った後は change を出して欄を離れる（Escape を使わない）", g.log.some((x) => x.join(":") === "fire:change") && g.log.some((x) => x[0] === "blur"));
  const h1 = runSync("frozen", "5", null);
  ok("空にもできない → stuck（呼ぶ側は検索を押さない）", h1.res.status === "stuck" && h1.res.got === "5");
  const h2 = runSync("frozen", "5", 3);
  ok("入らず空にもできない → stuck", h2.res.status === "stuck");
  const h3 = runSync("frozen", "", 3);
  ok("入らないが欄は空のまま → not_accepted（空で検索＝広い側）", h3.res.status === "not_accepted", JSON.stringify(h3.res));
  ok("打った値が入らない欄は打ち直さない（押すのは 3→なし の2回）", h3.log.filter((x) => x[0] === "press").length === 2, JSON.stringify(h3.log));
  // 一覧の「3」を押したのに1回目だけ値が残らない（描き直しの遅れ）→ 1回だけ入れ直して set
  const fl = makeEnv("mui", ""); let flMiss = true; const origClick = fl.env.click;
  fl.env.click = (o) => { if (flMiss) { flMiss = false; fl.log.push(["click-lost", o.textContent]); return; } origClick(o); };
  let flRes = null; UD.run(fl.el, 3, fl.env, (r) => { flRes = r; });
  ok("一覧を押したのに残らなかった → 1回だけ入れ直して set", flRes.status === "set" && flRes.tries === 2 && fl.el.value === "3", JSON.stringify(flRes));
}
{
  // select の形
  const sel = new El("select", {});
  sel.options = [{ value: "", textContent: "なし" }, { value: "0", textContent: "0" }, { value: "1", textContent: "1" }, { value: "3", textContent: "3" }];
  sel.value = "1";
  let res = null;
  UD.run(sel, 3, { later: (fn) => fn(), hd: (x) => x, sd: (x) => x, setVal: (e, v) => { e.value = v; }, fire: () => {}, press: () => {}, click: () => {}, blur: () => {}, options: () => [] }, (r) => { res = r; });
  ok("select: 1 → 3", res.status === "set" && sel.value === "3" && res.how_set === "select");
  UD.run(sel, null, { later: (fn) => fn(), hd: (x) => x, sd: (x) => x, setVal: (e, v) => { e.value = v; }, fire: () => {}, press: () => {}, click: () => {}, blur: () => {}, options: () => [] }, (r) => { res = r; });
  ok("select: 3 → なし（空）", res.status === "cleared" && sel.value === "");
  sel.value = "3";
  UD.run(sel, 14, { later: (fn) => fn(), hd: (x) => x, sd: (x) => x, setVal: (e, v) => { e.value = v; }, fire: () => {}, press: () => {}, click: () => {}, blur: () => {}, options: () => [] }, (r) => { res = r; });
  ok("select: 選択肢に無い 14 → なし（out_of_range・9 等に丸めない）", res.status === "out_of_range" && sel.value === "", JSON.stringify(res));
}

console.log("\n■ ④ 配線");
const manifest = JSON.parse(read("manifest.json"));
const main = manifest.content_scripts.find((c) => c.world === "MAIN" && c.js.includes("itandi-page-script.js"));
eq("manifest: human-wait.js → itandi-update-days.js → itandi-page-script.js（同じ world:MAIN）", main && main.js, ["human-wait.js", "floor-ijou.js", "itandi-update-days.js", "itandi-form-guard.js", "itandi-page-script.js"]);
ok("manifest の版 2.5.34 以上", manifest.version.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0) >= 2005034, manifest.version);
const ps = read("itandi-page-script.js");
const iUd = ps.indexOf("_itFillUpdateDays(cond, function (udOk, udErr)"), iRem = ps.indexOf("fillRemainingFields(cond);", iUd), iSearch = ps.indexOf('clickBtn("検索")', iUd);
ok("afterModal: 更新日 → 残りの欄 → 検索 の順（検索は更新日を入れ終わってから）", iUd > 0 && iRem > iUd && iSearch > iRem);
ok("入れられず前の値が残る時（ok=false）は検索を押さずに fill-done(error)", /if \(!udOk\) \{ showItandiWarnToast\(udErr\); _safeDone\(udErr\); return; \}/.test(ps));
ok("点検: 押す直前の読み戻しに update_days（ラベルで見つけた欄だけ）", /if \(ud && ud\.how === "label"\) f\.update_days = String\(ud\.el\.value/.test(ps));
ok("名前だけで見つけた欄には打たない（field_missing 扱い）", /if \(!found \|\| found\.how !== "label"\)/.test(ps));
ok("点検: 入れた結果を audit.update_days に", /_itAudit\.update_days = o/.test(ps));
ok("Escape を送らない（新しく足した所にキーの送信が無い）", !/KeyboardEvent|key:s*"Escape"|"keydown"/.test(read("itandi-update-days.js")) && !/KeyboardEvent|key:s*"Escape"|"keydown"/.test(ps.slice(ps.indexOf("function _itUD"), ps.indexOf("function _itFillUpdateDays"))));
ok("itandi-update-days.js に固定の待ち（setTimeout）が無い（待ちは呼ぶ側の human-wait）", !/setTimeout|setInterval/.test(read("itandi-update-days.js")));
ok("page-script の待ちは _hd/_sd を渡している", /hd: _hd, sd: _sd/.test(ps));
const pop = read("popup.js");
ok("popup: ITANDI の conditions に rp_update_days（更新日の欄の値）", /rp_update_days: adjUpdateDaysIt \? Number\(adjUpdateDaysIt\) : null/.test(pop));
ok("popup: ITANDI でも更新日の欄を見せる", /updateDaysRowIt\.style\.display = "flex"/.test(pop));
const bg = read("background.js");
ok("background: _buildBatchConditions の rp_update_days はサイトを問わず（ITANDI の直接入力も同じ値）", /rp_update_days: _rpDays,/.test(bg));
ok("リアプロの page-script は変えていない（select[name=update_date] のまま）", /queueSelVal\("update_date", String\(cond\.rp_update_days\)\)/.test(read("page-script.js")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
