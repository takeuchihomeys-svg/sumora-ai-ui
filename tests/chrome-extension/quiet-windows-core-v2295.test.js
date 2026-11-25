/**
 * 2.8.295 点検の解析（scripts/lib/quiet-windows-core.js）の試験。
 *   ① 模擬の記録（実際のコードが出す名前と形）で、窓・割り込み・見送り・引き継ぎ・リセットの秒・反映の抜けを確かめる
 *   ② 解析が前提にしている段の名前が、拡張のコードから本当に出ているかを確かめる（名前がずれると点検が黙って0を出すため）
 */
"use strict";
const fs = require("fs");
const path = require("path");
const core = require(path.join(__dirname, "..", "..", "scripts", "lib", "quiet-windows-core.js"));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra).slice(0, 300) : "")); }
}

const T0 = Date.parse("2026-11-25T10:00:00Z");
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const st = (sec, k, d) => ({ at: at(sec), k, d: d || "" });

console.log("■ ① 模擬の記録で解析する");
{
  // 実際の形: 裏の窓は "reset 上限260秒 cid=…"、ページの窓は "dl:quiet_on" の d に "sort 上限…秒"
  const steps = [
    st(0, "begin", "bulk_manual"),
    st(5, "reset_press", "押した 押した先=mouse 位置=(10,20)"),
    st(6, "quiet_on", "reset 上限260秒 cid=715d7562"),
    st(9, "quiet_defer", "webapp_search 窓=reset 残り251秒 cid=c1 site=realpro"),
    st(12, "tab_reload", "拡張の中身が応答しない"),          // 窓の中の割り込み（検出されるべき）
    st(20, "quiet_off", "reset 14秒 batch_done"),
    st(25, "tab_reload", "窓の外（検出されない）"),
    st(30, "bulk_phase", "autofill 上限300秒 2/2"),          // reset_press から 24秒 → 30秒未満
    st(40, "quiet_on", "gap 上限210秒"),
    st(41, "quiet_inherit", "前の回のリセットが途中（3秒前）→ あと33秒待ち"),
    st(60, "dl:quiet_on", "sort 上限150秒"),
    st(65, "dl:quiet_defer", "guide_restore 窓=sort 残り140秒 sort_in_flight"),
    st(70, "dl:estate_stuck_recover", "v2.8.295 rows=3"),     // 並べ替えの窓の中（検出されるべき）
    st(80, "dl:quiet_off", "sort 20秒 press_start"),
  ];
  const a = core.analyzeSteps(steps, "2.8.295", "2.8.295");
  ok("窓が3つ読める（裏 reset・gap、ページ sort）", a.wins.length === 3 && a.wins.map((w) => w.kind + "/" + w.src).join(",") === "reset/bg,gap/bg,sort/page", a.wins.map((w) => w.kind + "/" + w.src));
  const r1 = a.wins.find((w) => w.kind === "reset");
  ok("  reset の窓は quiet_off で 14秒に閉じる（上限260秒より前に外れた）", r1 && (r1.to - r1.from) === 14000 && /外した/.test(r1.why), r1);
  const g1 = a.wins.find((w) => w.kind === "gap");
  ok("  gap の窓は次の窓（ページの gap ではない）が来ても閉じる or 上限210秒", g1 && (g1.to - g1.from) === 210000 || (g1 && /次の窓/.test(g1.why)), g1);
  const s1 = a.wins.find((w) => w.kind === "sort");
  ok("  ページの sort の窓は press_start で 20秒に閉じる", s1 && (s1.to - s1.from) === 20000 && s1.src === "page", s1);
  ok("割り込み: 窓の中の tab_reload を拾う（12秒・reset の窓）", a.interrupts.some((i) => i.k === "tab_reload" && i.kind === "reset/bg"), a.interrupts);
  ok("割り込み: 窓の外の tab_reload（25秒）は拾わない", a.interrupts.filter((i) => i.k === "tab_reload").length === 1, a.interrupts);
  ok("割り込み: 並べ替えの窓（重なった裏の gap も）の中の dl:estate_stuck_recover を拾い、両方を書く",
    a.interrupts.some((i) => i.k === "dl:estate_stuck_recover" && /sort\/page/.test(i.kind) && /gap\/bg/.test(i.kind)), a.interrupts);
  ok("見送り: 相手の名前を取り出す（webapp_search・guide_restore）", a.defers.map((d) => d.who).join(",") === "webapp_search,guide_restore", a.defers);
  ok("引き継ぎ: quiet_inherit を残す", a.inherits.length === 1 && /待ち/.test(a.inherits[0]), a.inherits);
  ok("リセット→次の入力: 24秒は30秒未満として出す", a.resetGaps.length === 1 && a.resetGaps[0].ms === 25000 && a.resetGaps[0].short === true, a.resetGaps);
  ok("2.8.295 で窓の印があるので『反映されていない』は出さない", a.notReflected === false);
}
{
  // 反映の抜け: 2.8.295 でリセットを押したのに窓の印が無い
  const steps = [st(0, "reset_press", "押した"), st(20, "bulk_phase", "autofill 上限300秒 1/2")];
  const a = core.analyzeSteps(steps, "2.8.295", "2.8.295");
  ok("2.8.295 でリセットを押して窓の印が無ければ『反映されていない』", a.notReflected === true, a);
}
{
  // 古い版（2.8.294）は反映の抜けとして数えない（まだ窓の無い版）
  const steps = [st(0, "reset_press", "押した"), st(20, "bulk_phase", "autofill 上限300秒 1/2")];
  const a = core.analyzeSteps(steps, "2.8.294", "2.8.295");
  ok("2.8.294 の記録は『反映されていない』に数えない", a.notReflected === false && a.isNew === false, a);
}
{
  // 版の比較
  ok("版の比較: 2.8.295 は 2.8.295 以上", core.verGte("2.8.295", "2.8.295") === true);
  ok("版の比較: 2.8.292 は 2.8.295 未満", core.verGte("2.8.292", "2.8.295") === false);
  ok("版の比較: 2.8.1000 は 2.8.295 以上（桁の比較）", core.verGte("2.8.1000", "2.8.295") === true);
  ok("版の比較: 版が無い記録は未満扱い", core.verGte(null, "2.8.295") === false);
}
{
  // 窓の上限が無い（上限不明）の記録は 300秒 として扱い、その旨を残す
  const a = core.analyzeSteps([st(0, "quiet_on", "reset")], "2.8.295", "2.8.295");
  ok("上限が書かれていない窓は 300秒・上限不明と残す", a.wins.length === 1 && (a.wins[0].to - a.wins[0].from) === 300000 && /上限不明/.test(a.wins[0].why), a.wins);
}
{
  // 空の記録・壊れた記録で落ちない
  const a = core.analyzeSteps(null, null, "2.8.295");
  ok("段が無くても落ちない", a.wins.length === 0 && a.interrupts.length === 0 && a.isNew === false);
  const b = core.analyzeSteps([{ k: "quiet_on" }, null, { at: "not-a-date", k: "tab_reload" }], "2.8.295", "2.8.295");
  ok("壊れた段（時刻が読めない・null）があっても落ちない", Array.isArray(b.wins));
}

console.log("\n■ ② 解析が前提にしている段の名前が、拡張のコードから本当に出ているか");
{
  const ROOT = path.join(__dirname, "..", "..", "chrome-extension");
  const bg = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");
  const bd = fs.readFileSync(path.join(ROOT, "bulk-dl.js"), "utf8");
  const sa = fs.readFileSync(path.join(ROOT, "search-audit.js"), "utf8");
  ok("裏: quiet_on／quiet_off／quiet_defer／quiet_inherit を点検の記録に出す（background.js）",
    /_auditStep\(rid, "quiet_on"/.test(bg) && /_auditStep\(rid, "quiet_off"/.test(bg) && /_auditStep\(rid, "quiet_defer"/.test(bg) && /_auditStep\(runId, "quiet_inherit"/.test(bg));
  ok("ページ: dl:quiet_on／dl:quiet_off／dl:quiet_defer を出す（bulk-dl.js の _liveDlStep が dl: を付ける）",
    /_liveDlStep\("quiet_on"/.test(bd) && /_liveDlStep\("quiet_off"/.test(bd) && /_liveDlStep\("quiet_defer"/.test(bd));
  ok("リセットの押下は reset_press（_stamp の名前）", /_stamp\("reset_press"/.test(bg));
  ok("窓の中の割り込みの名前（tab_reload・dl:estate_stuck_recover）が実際に出る",
    /_auditStep\(runId, "tab_reload"/.test(bg) && /_liveDlStep\("estate_stuck_recover"/.test(bd));
  ok("bulk_phase の段の文字は『phase + 上限NN秒』（解析の『autofill 上限…』の目印と一致）",
    /_bulkPhaseSet\("autofill", 300000/.test(bg) && /_auditStep\(rid, "bulk_phase", \(String\(phase\) \+ " 上限"/.test(bg));
  ok("点検の KEEP_STEP が窓の段を残す（上限で落ちない）", /quiet_on\|quiet_off\|quiet_defer\|quiet_inherit\|dl:quiet_/.test(sa));
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
