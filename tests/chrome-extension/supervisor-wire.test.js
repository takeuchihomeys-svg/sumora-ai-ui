// 統括の判断を実際に使う（2026-11-14）
//
// 竹内さん「統括できる部分とできない部分の連携はちゃんとできているのか」→ **できていなかった**
//   「つなぐ」
//
// 見つけた穴:
//   統括（learn-supervisor）の判断は storage に置かれているだけで、
//   **読んで動く所が1つも無かった**（実測 0箇所）。
//   統括が「渡すと危ない」と言っても自動検索は止まらなかった。
//
// 繋ぎ方（竹内さんが選んだ A）:
//   **統括が「渡してよい（ready）」と言っていない時は、自動の送信・ダウンロードをしない**。
//   ⚠ 止めるのは自動モードの一括（bulk-dl）だけ。人が1件ずつ押すのは止めない。
//   ⚠ 判断が無い（学習がまだ）時は**止めない**（今まで通り動く＝いきなり止めない）。
//
// 実行: node tests/chrome-extension/supervisor-wire.test.js
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "chrome-extension");
const bd = fs.readFileSync(path.join(SRC, "bulk-dl.js"), "utf8");
const bg = fs.readFileSync(path.join(SRC, "background.js"), "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 統括の判断を読む");
{
  t("storage のキー（axlx_learn_supervisor）を読む", bd.includes("axlx_learn_supervisor"));
  t("  変化したら読み直す（onChanged）", /ch\[_SUP_KEY\]/.test(bd));
  t("  30秒は読み直さない（軽い）", /_supAt < 30000|now - _supAt < 30000/.test(bd));
  t("background が置いている", bg.includes("axlx_learn_supervisor:"));
}

console.log("\n■ ② 「渡してよい」以外は止める");
{
  t("_supervisorAllowsAuto がある", /function _supervisorAllowsAuto\(\)/.test(bd));
  t("  ready だけ通す", /return verdict === "ready"/.test(bd));
  t("  ⚠ 判断が無い時は止めない（今まで通り）", /if \(!verdict\) return true;/.test(bd));
  t("止める理由を人が読める形で出す", /function _supervisorBlockReason\(\)/.test(bd));
  t("  理由に結論と自己点検の矛盾を入れる", /self_check[\s\S]{0,120}issues/.test(bd));
}

console.log("\n■ ③ 自動の送信・ダウンロードの入口で止める（4か所）");
{
  t("autoOnLoad（自動で動き始める時）", /_supBlocksAuto\("autoOnLoad"\)/.test(bd));
  t("autoPressPdfs（印刷用PDFを押す時）", /_supBlocksAuto\("autoPressPdfs"\)/.test(bd));
  t("tryNext（次のページへ進む時）", /_supBlocksAuto\("tryNext"\)/.test(bd));
  t("autoSendOnePage（1ページ送る時）", /_supBlocksAuto\("autoSendOnePage"\)/.test(bd));
  t("  止める時は続きの印も消す（中途半端に残さない）", /remove\("axlx_pending_auto_send"\)/.test(bd));
  /**
   * 2026-11-14 竹内さん「自動はとめないようにする」:
   *   ⚠ 旧は `⛔` で止めていた。いまは**止めない**ので、代わりに**警告**を出す（黙って続けない）。
   */
  t("  危ない時も止めずに警告を出す（黙って続けない）", /_nudge\("⚠ 統括: /.test(bd));
}

console.log("\n■ ④ 案内モードと同じ形になっている（2つの決まりを作らない）");
{
  const seg = bd.slice(bd.indexOf("function _guideBlocksAuto"), bd.indexOf("function _guideBlocksAuto") + 1200);
  t("案内モードの関所と同じ場所で使う", /_guideBlocksAuto\("autoOnLoad"\)/.test(bd) && /_supBlocksAuto\("autoOnLoad"\)/.test(bd));
  t("  ⚠ 自動モードは案内モードでは止めない（今まで通り）", /if \(_autoModeOn\) return false;/.test(seg));
}

console.log("\n■ ⑤ 人が押すのは止めない");
{
  t("スタッフモードでは止めない（統括の判断を使わない）", !/_supBlocksAuto[\s\S]{0,100}_staffModeOn/.test(bd) || /_staffModeOn[\s\S]{0,40}return false/.test(bd));
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
