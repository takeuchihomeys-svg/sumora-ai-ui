// 所在地絞り込みが押せない原因（2026-11-14）
//
// 竹内さん「まだ所在地絞り込み押すことできていない。原因見つけて改善する」
//
// 原因（実測・コードで確認）:
//   ① 地域の STEP1 は `clickByText` だけで探していた
//      `clickByText` は **textContent（子の文字も全部つなぐ）** で照合するので、
//      リアプロの左の帯のように
//        <div class="click_menu">所在地絞り込み<span>＋</span></div>
//      の入れ子だと、親の div の文字が
//        「所在地絞り込み＋沿線・駅絞り込み＋駅から徒歩…」
//      のように長くなり、**完全一致しない**。
//   ② 部分一致は「短すぎる候補は除く（5文字未満）」で落ちる事があり、
//      さらに**最初に見つかった親**を押していた（押しても開かない親）。
//   ③ 駅（沿線・駅絞り込み）は**先にクラス名で探す**よう直してあった（動いていた）。
//      地域だけ文字頼みで残っていた＝**ここが押せない原因**。
//   ④ 押した後の「本当に開いたか」を確かめていなかった。
//
// 実行: node tests/chrome-extension/area-open-press.test.js
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const ps = read("page-script.js");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

console.log("■ ① 地域の STEP1 がクラス名で堅く探す（駅と同じ）");
{
  t("クラス名で探す処理がある", /clsTargets = \['click_menu', 'one_slide_search_box'\]/.test(ps));
  t("所在地絞り込みを含む物を探す", /t\.includes\('所在地絞り込み'\)/.test(ps));
  t("クラス名で押した事を点検に残す", /area_open_by_class/.test(ps));
  t("場所の帯の中でも探す", /area_open_by_area/.test(ps));
  t("他の絞り込みを含む物は除く（一番内側を採る）", /!\/沿線・駅絞り込み\|管理会社絞り込み\//.test(ps));
  t("文字だけの探し方は最後の受け皿", /\/\/ ③ 文字（今まで通り・最後の受け皿）/.test(ps));
}

console.log("■ ② clickByText が「一番内側」を採る");
{
  t("一致する物を集める", /var found = \[\];/.test(ps));
  t("子孫に同じ一致があれば親を捨てる", /e\.contains\(o\)/.test(ps));
  t("内側が無ければ最初の物", /hit = \(inner\.length \? inner\[0\] : found\[0\]\);/.test(ps));
}

console.log("■ ③ 押した後に「本当に開いたか」を確かめる");
{
  t("確認の関数がある", /_ensureAreaOpened/.test(ps));
  t("開いたかの判定（区・町字・都道府県）", /label\.one_city, label\.one_town, input\[name="city_code\[\]"\], input\[name="pref_code"\]/.test(ps));
  t("開かなければ押し直す", /所在地絞り込みを押し直します/.test(ps));
  t("最大3回で止める", /if \(n >= 3\)/.test(ps));
  t("開いた事を点検に残す", /area_open_retry/.test(ps));
  t("3回で開かなければ点検に残す", /area_open_fail/.test(ps));
}

console.log("■ ④ 「一番内側を採る」判定を実際に動かす（DOMを模す）");
{
  // 実際の左の帯のような入れ子を作る
  const makeEl = (tag, text, children = []) => {
    const el = {
      tagName: tag.toUpperCase(),
      textContent: text + children.map((c) => c.textContent).join(""),
      contains(o) {
        if (this === o) return false;
        return children.some((c) => c === o || c.contains(o));
      },
    };
    return el;
  };
  const inner = makeEl("span", "＋");
  const menu = makeEl("div", "所在地絞り込み", [inner]);
  const other = makeEl("div", "沿線・駅絞り込み");
  const parent = makeEl("div", "", [menu, other]);   // 親（両方を含む）

  // clickByText と同じ「一番内側を採る」ロジック
  const pickInner = (found) => {
    const innerOnes = found.filter((e) => !found.some((o) => o !== e && e.contains(o)));
    return innerOnes.length ? innerOnes[0] : found[0];
  };

  const cand = "所在地絞り込み";
  const found = [parent, menu].filter((e) => e.textContent.replace(/\s+/g, "").includes(cand));
  t("親と menu が一致に含まれる（span は「＋」だけなので含まれない）", found.length === 2, found.map((e) => e.tagName));

  const picked = pickInner(found);
  t("親ではなく menu を採る（親は menu を含むので捨てる）", picked === menu, { tag: picked.tagName, text: picked.textContent });
  t("親を押さない（押しても開かない）", picked !== parent);

  // 内側の span も「所在地絞り込み」を含む形（実物は span が「＋」だが、文字を持つ場合もある）
  const inner2 = makeEl("span", "所在地絞り込み");
  const menu3 = makeEl("div", "", [inner2]);
  const found3 = [menu3, inner2].filter((e) => e.textContent.replace(/\s+/g, "").includes(cand));
  t("span が文字を持てば span を採る", pickInner(found3) === inner2);

  // 親だけが一致する場合（子に文字が無い＝アイコンだけ）
  const iconOnly = makeEl("span", "▼");
  const menu2 = makeEl("div", "所在地絞り込み", [iconOnly]);
  const found2 = [menu2].filter((e) => e.textContent.replace(/\s+/g, "").includes(cand));
  t("子に文字が無ければ親を採る", pickInner(found2) === menu2);

  // 帯の中だけを探す（他の絞り込みを含む物は除く）
  const inArea = [menu, other].filter((e) => {
    const tt = e.textContent.replace(/\s+/g, "");
    return tt.includes("所在地絞り込み") && !/沿線・駅絞り込み|管理会社絞り込み/.test(tt);
  });
  t("他の絞り込みを含む物は除く", inArea.length === 1 && inArea[0] === menu, inArea.map((e) => e.textContent));
}

console.log("■ ⑤ 駅のやり方と揃っている（片方だけ直さない）");
{
  t("駅もクラス名で探す", /clsTargets = \['click_menu', 'one_slide_search_box'\]/.test(ps));
  const stationIdx = ps.indexOf("沿線・駅絞り込み");
  t("駅のクラス名探索がある", stationIdx > 0);
  t("地域と駅で同じクラス名を使う", (ps.match(/clsTargets = \['click_menu', 'one_slide_search_box'\]/g) || []).length >= 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
