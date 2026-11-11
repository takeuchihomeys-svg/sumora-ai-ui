// 実行: node tests/chrome-extension/human-learn-reflect-v2666.test.js
// 2026-11-11 竹内さん「反映させる」「データたまって理解するたび反映」
//   ① 貯まった実測から「動きの癖（プロファイル）」を作る（少なすぎる時は作らない）
//   ② 癖が自動モードの動きに使われる（速さ→時間・曲がり→曲げ・押す位置→狙う点）
//   ③ 貯まるたびに作り直す（axlx_human_profile）→ カーソルがその変化を見て次の動きから効く
//   ④ DB に送る（/api/human-motion・鍵は background が付ける）
//   ⑤ 画面の写真は Storage に置き、表には名前だけ（画像の中身は入れない）
const fs = require("fs");
const path = require("path");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

const L = require(path.join(dir, "human-learn.js"));
const pu = read("pointer-ui.js"), rec = read("human-learn-record.js");
const up = read("human-learn-upload.js"), bg = read("background.js");

/** 実測（通常モードで貯まった形）を作る */
function agg(over) {
  return Object.assign({
    v: 1, n: 30, sessions: 2, kinds: { click: 20, key: 10 }, gaps: [400, 500, 600], gap_ms: 500,
    fields: ["rental_cost2", "検索"], order: ["rental_cost2", "検索"],
    moves: { n: 12, drag_n: 0, speed_px_s: 1200, curve: 1.25, ms: 400, dist: 480, shapes: [[[0.1, 0.2], [0.5, 0.6]]] },
    points: { n: 10, x: 0.32, y: 0.55, fields: { "検索": { n: 6, x: 0.3, y: 0.5 } } },
    scrolls: { n: 6, dy: 320, down: 5, up: 1, y: 0.12, y_samples: [0.1, 0.12] },
  }, over || {});
}

console.log("■ ① 貯まった実測から「動きの癖」を作る");
{
  const p = L.profileFrom(agg());
  ok("癖を作れる", !!p);
  ok("速さを使う（1200px/秒）", p.speed_px_s === 1200, p.speed_px_s);
  ok("曲がり具合を使う（1.25）", p.curve === 1.25, p.curve);
  ok("押す位置を使う（横0.32・縦0.55）", p.aim.x === 0.32 && p.aim.y === 0.55, p.aim);
  ok("スクロール量を使う（320px）", p.scroll_dy === 320, p.scroll_dy);
  ok("何件から学んだかを持つ", p.sample.moves === 12 && p.sample.points === 10 && p.sample.scrolls === 6, p.sample);

  // 少なすぎる時は作らない（急に動きが変わらない）
  ok("実測がほぼ無ければ作らない（null）", L.profileFrom({ n: 1 }) === null);
  ok("null を渡しても落ちない", L.profileFrom(null) === null && L.profileFrom(undefined) === null);
  // 極端な値は丸める
  const p2 = L.profileFrom({ moves: { n: 10, speed_px_s: 999999, curve: 9 }, points: { n: 10, x: 0.99, y: 0.01 }, scrolls: { n: 5, dy: 99999 } });
  ok("速さは 4000 までに丸める", p2.speed_px_s === 4000, p2.speed_px_s);
  ok("曲がりは 2.0 までに丸める", p2.curve === 2, p2.curve);
  ok("押す位置は 0.2〜0.8 に丸める（端は押さない）", p2.aim.x === 0.8 && p2.aim.y === 0.2, p2.aim);
  ok("スクロールは 1500 までに丸める", p2.scroll_dy === 1500, p2.scroll_dy);
  // 1つだけ足りない時は、その項目だけ null
  const p3 = L.profileFrom({ moves: { n: 10, speed_px_s: 1200, curve: 1.2 }, points: { n: 1, x: 0.3, y: 0.5 } });
  ok("押す位置の材料が足りなければ押す位置だけ null", p3.aim === null && p3.speed_px_s === 1200, p3);
}

console.log("\n■ ② 癖が自動モードの動きに使われる");
{
  const p = L.profileFrom(agg());
  // 速さ → 動く時間（距離 600px ÷ 1200px/秒 ＝ 500ms）
  ok("速さから動く時間を出す（600px÷1200px/s≒500ms）", L.moveMsFor(p, 600) === 500, L.moveMsFor(p, 600));
  ok("近い距離でも 120ms を下回らない", L.moveMsFor(p, 10) >= 120, L.moveMsFor(p, 10));
  ok("遠くても 1600ms を超えない", L.moveMsFor(p, 20000) <= 1600, L.moveMsFor(p, 20000));
  ok("癖が無ければ null（今まで通りの速さで動く）", L.moveMsFor(null, 600) === null);

  // カーソルが癖を使う
  ok("pointer-ui が癖を読む（reloadProfile）", /function reloadProfile\(\)/.test(pu));
  ok("貯まるたびに作り直された癖（axlx_human_profile）を優先して使う", /PROF_LIVE_KEY = "axlx_human_profile"/.test(pu) && /if \(live && typeof live === "object"\) \{ _prof = live; return; \}/.test(pu));
  ok("癖が変わったら読み直す（storage の変化を見る）", /ch\[PROF_LIVE_KEY\] \|\| ch\[PROF_KEY\]/.test(pu));
  ok("動く時間に癖の速さを使う", /_LL\.moveMsFor\(prof, dist\)/.test(pu));
  ok("癖が無ければ今まで通りの式", /_learned != null \? _learned : Math\.min\(900, Math\.max\(220, Math\.round\(dist \* 1\.6\)\)\)/.test(pu));
  ok("軌跡を癖の曲がり具合に寄せる（_bendLike）", /function _bendLike\(pts, from, to, curve\)/.test(pu) && /pts = _bendLike\(pts, from, t, prof\.curve\)/.test(pu));
  ok("曲げる量は距離の12%まで（画面が暴れない）", /Math\.min\(len \* 0\.12/.test(pu));
  ok("押す位置は癖の割合で狙う", /prof\.aim\.x \+ \(Math\.random\(\) - 0\.5\) \* 0\.16/.test(pu));
  ok("癖が無ければ 40〜60%（ほぼ真ん中）", /var fx = 0\.4 \+ Math\.random\(\) \* 0\.2;/.test(pu));
  ok("押す位置も 0.15〜0.85 に収める", /Math\.max\(0\.15, Math\.min\(0\.85/.test(pu));
}

console.log("\n■ ③ データがたまるたびに反映される");
{
  ok("貯めるたびに癖を作り直す", /var prof = L\.profileFrom\(next\);/.test(rec));
  ok("別のキー（axlx_human_profile）に置く（カーソルがこれを見る）", /o\[PROFILE_KEY\] = prof/.test(rec) && /PROFILE_KEY = "axlx_human_profile"/.test(rec));
  ok("同じ書き込みでまとめて置く（変化が1回で届く）", /chrome\.storage\.local\.set\(o, function \(\)/.test(rec));
  ok("理解した内容を画面に出す（paintLearned）", /function paintLearned\(prof\)/.test(rec) && /理解した動き: /.test(rec));
  ok("理解したら印を出す（貯まった後）", /if \(o\[PROFILE_KEY\]\) paintLearned\(o\[PROFILE_KEY\]\); else paintBadge\(\);/.test(rec));
  ok("小窓に「この値が自動モードの動きに使われます」を出す", /▼ この値が自動モードの動きに使われます/.test(read("popup.js")));
  ok("学んだ値を1行ずつ出せる（learnedLines）", /function learnedLines\(profile\)/.test(L.learnedLines ? read("human-learn.js") : ""));
  const lines = L.learnedLines(L.profileFrom(agg()));
  ok("速さ・曲がり・押す位置・スクロールを出す", lines.some((x) => /速さ/.test(x)) && lines.some((x) => /曲がり/.test(x)) && lines.some((x) => /押す位置/.test(x)) && lines.some((x) => /スクロール/.test(x)), lines);
  ok("まだ学べていない時の案内", /まだ学べていません/.test(L.learnedLines(null)[0]));
}

console.log("\n■ ④ DB に送る（鍵は background が付ける）");
{
  ok("画面側は鍵を持たない（background に頼む）", /chrome\.runtime\.sendMessage\(\{\s*type: "axlx-human-motion"/.test(up));
  ok("送りすぎない（前回から5分）", /MIN_GAP_MS = 5 \* 60 \* 1000/.test(up));
  ok("送った印を先に置く（同じ分を2回送らない）", /SENT_KEY\] = Date\.now\(\);/.test(up));
  ok("記録が増えたら送る", /ch\[KEY\]\.newValue/.test(up));
  ok("background が鍵を付けて送る", /type === "axlx-human-motion"/.test(bg) && /_getAutomationKeyHeader\(\)/.test(bg));
  ok("送り先は /api/human-motion", /\/api\/human-motion/.test(bg));
  ok("送るのは数と傾向だけ（中身は送らない）", /motion: msg\.motion/.test(bg) && !/value:/.test(up));
}

console.log("\n■ ⑤ 画面の写真は Storage に置き、表には名前だけ");
{
  ok("写真を撮る受け口（axlx-human-shot）", /type === "axlx-human-shot"/.test(bg) && /captureVisibleTab/.test(bg));
  ok("<all_urls> の許可が無ければ撮らない（止まらない）", /permissions\.contains\(\{ origins: \["<all_urls>"\] \}\)/.test(bg) && /no_permission/.test(bg));
  ok("見えているタブだけ撮る", /chrome\.tabs\.query\(\{ active: true, currentWindow: true \}\)/.test(bg));
  ok("古い写真から消す（Storage を溢れさせない）", /SHOT_KEEP = 30/.test(bg) && /keys\.slice\(0, keys\.length - SHOT_KEEP\)/.test(bg));
  ok("写真の中身は表に入れない（名前と大きさだけ）", /shot_key/.test(rec) && /delete row\.shot_b64/.test(fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "human-motion", "route.ts"), "utf8")));
  ok("記録する側が写真を撮って印を残す", /type: "axlx-human-shot"/.test(rec) && /axlx_human_shot/.test(rec));
}

console.log("\n■ ⑥ DB の表（migrate-schema と DDL が同じ形）");
{
  const ms = fs.readFileSync(path.join(__dirname, "..", "..", "app", "api", "migrate-schema", "route.ts"), "utf8");
  const ddl = fs.readFileSync(path.join(__dirname, "..", "..", "memory", "ddl_human_motion_learn.sql"), "utf8");
  ok("migrate-schema に human_motion_learn がある（決まり）", /CREATE TABLE IF NOT EXISTS human_motion_learn/.test(ms));
  ok("DDL ファイルにも同じ表がある", /CREATE TABLE IF NOT EXISTS human_motion_learn/.test(ddl));
  const cols = ["move_speed_px_s", "move_curve", "point_x", "point_y", "scroll_dy", "scroll_y", "shot_key", "shot_taken"];
  ok("migrate-schema に必要な列が揃っている", cols.every((c) => new RegExp("\\b" + c + "\\b").test(ms)), cols.filter((c) => !new RegExp("\\b" + c + "\\b").test(ms)));
  ok("DDL にも同じ列が揃っている", cols.every((c) => new RegExp("\\b" + c + "\\b").test(ddl)));
  ok("索引がある（新しい順）", /idx_human_motion_created/.test(ms) && /idx_human_motion_install/.test(ms));
  ok("RLS を有効にする（サーバーだけの表・DISABLE しない決まり）", /ALTER TABLE human_motion_learn ENABLE ROW LEVEL SECURITY/.test(ms) && /ALTER TABLE human_motion_learn ENABLE ROW LEVEL SECURITY/.test(ddl));
  ok("RLS を DISABLE していない", !/DISABLE ROW LEVEL SECURITY[\s\S]{0,40}human_motion_learn/.test(ms) && !/human_motion_learn[\s\S]{0,40}DISABLE ROW LEVEL SECURITY/.test(ms));
  ok("当てるスクリプトがある（apply-human-motion-learn.ts）", /human_motion_learn/.test(fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "apply-human-motion-learn.ts"), "utf8")));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
