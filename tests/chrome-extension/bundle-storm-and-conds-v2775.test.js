// tests/chrome-extension/bundle-storm-and-conds-v2775.test.js
// 実行: node tests/chrome-extension/bundle-storm-and-conds-v2775.test.js
// 2026-11-15 竹内さん（Claude からの依頼2件）
//
//   依頼1: 学習の束の取り直しが重なって DB が止まった件（急ぎ）
//     ⚠ 実測（サーバーの記録）: 01:40:30〜01:41:30 UTC に
//       `GET /api/human-learn-profile` が**約1秒で約130回**重なった（同じ事務所の端末から）。
//       サーバーは1回ごとに束（1行 約40KB）を読み、同じ行に読んだ印を書いていたため DB の手が埋まり、
//       **約1分後に DB 全体が約1分半止まった**（1行読むだけの処理まで15秒）。
//     → ①同時に1本だけ ②失敗の後は間を空ける（1分→5分→15分）
//        ③起動はずらす（0〜30秒）④版が同じなら scope ごとの取り直しをしない
//
//   依頼2: 物件探しの条件を検索の直前に読み直す件
//     → ①検索直前に /api/property-customers から読み直す（キャッシュを使わない）
//        ②updated_at が新しければ「条件が変わった」印 ③その他の要望＋必須/できればも並べる
//        ④会話に結ばれていない new_inquiry の重複行は自動検索の対象から外す
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const dir = path.join(__dirname, "..", "..");
const bg = fs.readFileSync(path.join(dir, "chrome-extension", "background.js"), "utf8");
const pop = fs.readFileSync(path.join(dir, "chrome-extension", "popup.js"), "utf8");
const ps = fs.readFileSync(path.join(dir, "chrome-extension", "page-script.js"), "utf8");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

console.log("■ 依頼1-① 同時に1本だけ（実行中なら新しく呼ばず、その結果を待つ）");
{
  ok("  実行中の1本を持つ変数がある", /var _learnInflight = null/.test(bg));
  ok("  ⚠ 実行中なら新しい実行をしない", /if \(_learnInflight\) \{[\s\S]{0,200}?return _learnInflight;/.test(bg));
  ok("  実行中でなければ走らせて保持する", /_learnInflight = p;/.test(bg));
  ok("  Queued 版がある", /function _refreshLearnedBundleQueued\(force\)/.test(bg));
  ok("  ⚠ 起動・定期・サイト切替・メッセージが Queued を使う", 
    (bg.match(/_refreshLearnedBundleQueued\(/g) || []).length >= 4,
    (bg.match(/_refreshLearnedBundleQueued\(/g) || []).length);
}

console.log("\n■ 依頼1-② 失敗の後は間を空ける（1分 → 5分 → 15分）");
{
  ok("  失敗回数を持つ", /var _learnFailCount = 0/.test(bg));
  ok("  次の試行時刻を持つ", /var _learnNextTryAt = 0/.test(bg));
  ok("  ⚠ 1回目は1分", /if \(n === 1\) return 60 \* 1000/.test(bg));
  ok("  ⚠ 2回目は5分", /if \(n === 2\) return 5 \* 60 \* 1000/.test(bg));
  ok("  ⚠ 3回目以降は15分", /return 15 \* 60 \* 1000/.test(bg));
  ok("  ⚠ 間隔内なら何もしない（backoff）", /skipped: "backoff"/.test(bg));
  ok("  ⚠ 失敗の後始末は1か所（Queued）", /_learnFailCount = Math\.min\(9, \(_learnFailCount \|\| 0\) \+ 1\)/.test(bg));
  ok("  ⚠ 成功したら戻す", /_learnFailCount = 0;[\s\S]{0,40}_learnNextTryAt = 0;/.test(bg));
  ok("  ⚠ 「何もしなかった」を失敗に数えない（ok:false だけ）", /var hardFail = !r \|\| r\.ok === false/.test(bg));
}

console.log("\n■ 依頼1-③ 起動の時はずらす（0〜30秒）");
{
  ok("  ずらしの関数がある", /function _learnStartJitterMs\(\)/.test(bg));
  ok("  ⚠ 0〜30秒の乱数", /Math\.floor\(Math\.random\(\) \* 30000\)/.test(bg));
  ok("  ⚠ 起動時に setTimeout でずらす", /setTimeout\(function \(\) \{\s*\n\s*_refreshLearnedBundleQueued\(false\)/.test(bg));
  ok("  定期の開始もばらす（0〜60秒）", /Math\.floor\(Math\.random\(\) \* 60000\)/.test(bg));
}

console.log("\n■ 依頼1-④ 版が同じなら scope ごとの取り直しをしない");
{
  ok("  ⚠ 版が同じなら即返る", /if \(hv && hv === lastVer\) return \{ ok: true, skipped: "same_version" \}/.test(bg));
  ok("  ⚠ 初回でも同じ版の束があれば取り直さない", /skipped: "same_version_first"/.test(bg));
  ok("  by_site を読むキーが入っている", /axlx_learn_by_site"\]/.test(bg) || /"axlx_learn_by_site"/.test(bg));
}

console.log("\n■ 依頼2-① 検索の直前に条件を読み直す");
{
  ok("  読み直す関数がある", /async function _refreshCustomerBeforeSearch/.test(bg));
  ok("  ⚠ キャッシュを使わない（no-store）", /cache: "no-store", signal: AbortSignal\.timeout\(12000\)/.test(bg));
  ok("  ⚠ 検索の条件を作る直前に呼ぶ", /var customer = await _refreshCustomerBeforeSearch\(customer, site\);\s*\n\s*var conds = _buildBatchConditions/.test(bg));
  ok("  ⚠ 読めなくても止まらない（今までの条件で続行）", /今までの条件で検索します/.test(bg));
  ok("  ⚠ API の返す形が複数でも動く（配列/ customers / customer / 単体）", /Array\.isArray\(j\.customers\)/.test(bg) && /j\.customer\.id/.test(bg));
}

console.log("\n■ 依頼2-② updated_at が新しければ「条件が変わった」印");
{
  ok("  ⚠ 前後の時刻を比べている", /after > before/.test(bg));
  ok("  ⚠ 「条件が変わりました」と出す", /条件が変わりました/.test(bg));
  ok("  ⚠ 読めない時刻で誤報しない（両方ある時だけ）", /if \(after && before && after > before\)/.test(bg));
  ok("  印は _nudge と作業メモに出す", /_nudge\(msg\)/.test(bg) && /_axlxWorkNote\(msg/.test(bg));
}

console.log("\n■ 依頼2-③ その他の要望＋必須/できればも並べる");
{
  ok("  ⚠ other_requests を「・」で分けて配列にする", /other_requests_list/.test(bg));
  ok("  ⚠ 区切りは ・ 、 , ／ /", /split\(\/\[・、,／\\\/\]\+\//.test(bg));
  ok("  ⚠ 重複を消す", /a\.indexOf\(x\) === i/.test(bg));
  ok("  ⚠ 上限12個（条件が長くなりすぎない）", /slice\(0, 12\)/.test(bg));
  ok("  元の other_requests も残す（今まで通り読める）", /other_requests: c\.other_requests \|\| null/.test(bg));
  ok("  requirement_strength も渡す", /requirement_strength: c\.requirement_strength/.test(bg));
  ok("  ⚠ 画面に出す関数がある（page-script）", /function _showOtherRequests/.test(ps));
  ok("  ⚠ 検索の直前に呼ぶ", /_showOtherRequests\(cond\)/.test(ps));
  ok("  ⚠ 見せるだけ（8秒で消える・押させない）", /8000/.test(ps) && /pointer-events:none/.test(ps));
  ok("  ⚠ タグを消してから出す（安全）", /function _escHtml/.test(ps));
}

console.log("\n■ 依頼2-④ new_inquiry の重複行は自動検索の対象から外す");
{
  ok("  重複の印を付ける関数がある", /function _axMarkAutoDuplicate/.test(pop));
  ok("  ⚠ parent_customer_id がある行は重複", /parent_customer_id/.test(pop));
  ok("  ⚠ 一括検索のチェックを出さない", /dup \? '<label class="bulk-check-wrap"/.test(pop));
  ok("  ⚠ 「重複」と分かる印を出す", /重複してできた行のため自動検索の対象外/.test(pop));
  ok("  ⚠ 送信時にも二重に外す", /filter\(function \(id\) \{[\s\S]{0,300}?_axIsAutoDuplicate/.test(pop));
  ok("  ⚠ 外した数を出す（黙って減らさない）", /重複してできた行を " \+ dropped \+ "件 外しました/.test(pop));
  ok("  ⚠ 今日やる事（needs_action/todayOnly）からも重複を外す", /currentAccount === "__needs_action__" \|\| todayOnly/.test(pop));
}

console.log("\n■ 構文");
{
  let all = true;
  for (const f of ["background.js", "popup.js", "page-script.js"]) {
    try { execFileSync(process.execPath, ["--check", path.join(dir, "chrome-extension", f)], { stdio: "pipe" }); }
    catch { all = false; console.log("      ✗ " + f); }
  }
  ok("  3ファイルの構文が通る", all);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
