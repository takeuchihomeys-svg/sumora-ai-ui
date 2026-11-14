// tests/chrome-extension/rent-select-opened-v2767.test.js
// 実行: node tests/chrome-extension/rent-select-opened-v2767.test.js
// 2026-11-14 竹内さん「賃料の部分のプルダウンのしくみとカーソルと動かし方と動きも理解できるのかな」
//
//   ★ 実測（7日 6,027件・全頁）で分かった事
//     ✅ 理解できている
//       ・賃料の欄がある記録 … 178件
//       ・要素の種類（w）      … **select 401件（100%）** ＝ プルダウンだと分かっている
//       ・値が変わった合図     … change 197件（人が選んで確定した記録）
//       ・写真から読んだ種類   … **select 191件（100%）** ＝ 記録と写真が一致
//
//     ❌ 足りていない
//       ・押した位置（x,y）    … 66件（37%）だけ
//       ・**「押したら何が開いたか」… 0件**  ← これが「しくみ」を学べない原因
//
//   ⚠ 原因: `opens`（展開先）は集計（`axlx_human_learn`）には入るが、
//     **写真と一緒に送る `shot_ops` には載せていなかった** ので DB から学べなかった。
//     さらに `noteBeforeClick` を**呼んでいなかった**ので、そもそも `opens` が空だった。
//
//   → ① 押す前に画面の数を控える（`noteBeforeClick`）
//     ② 押した後に開いた物を見て、その操作に `opened` を書く
//     ③ `shot_ops` に `opened` を載せる（種類だけ・中身の文字は入れない）
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const dir = path.join(__dirname, "..", "..", "chrome-extension");
const rec = fs.readFileSync(path.join(dir, "human-learn-record.js"), "utf8").replace(/\r\n/g, "\n");
const hl = fs.readFileSync(path.join(dir, "human-learn.js"), "utf8").replace(/\r\n/g, "\n");

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra !== undefined ? "\n      " + JSON.stringify(extra).slice(0, 400) : "")); }
}

console.log("■ ① 押す前に画面の数を控える（これを呼ばないと opens が空）");
{
  ok("  ⚠ noteBeforeClick を呼んでいる", /rec\.noteBeforeClick\(e\.target\)/.test(rec));
  // ⚠ _pushOp の**直後**（押した操作として同じ並びに載る）
  const iPush = rec.indexOf("_pushOp(e.type || \"click\", e.target, _by);");
  const iNote = rec.indexOf("rec.noteBeforeClick(e.target)");
  ok("  ⚠ 押した操作の記録の後にある", iPush > 0 && iNote > iPush, { iPush, iNote });
}

console.log("\n■ ② 押した後に「何が開いたか」をその操作に書く");
{
  ok("  noteOpened を呼んでいる", /rec\.noteOpened\(_openedFor\)/.test(rec));
  ok("  少し待ってから見る（サイトが描くのを待つ）", /setTimeout\(function \(\)[\s\S]{0,600}?noteOpened/.test(rec));
  // ⚠ 待ち時間は `setTimeout(...)` の**後ろ**（閉じ括弧の後）にある
  const iOpen = rec.indexOf("rec.noteOpened(_openedFor)");
  const segNear = rec.slice(Math.max(0, iOpen - 700), iOpen + 700);
  const waitMs = (segNear.match(/\}, *(\d+) \+ Math\.floor/) || [])[1];
  ok("  ⚠ 待ちは 500ms 以上（すぐ見ると『変化なし』になる）", Number(waitMs) >= 500, waitMs);
}

console.log("\n■ ③ `shot_ops` に `opened` を載せる（DBから学べるように）");
{
  ok("  ⚠ 送る形に opened が入っている", /return \{ t: o\.t, k: o\.k, f: o\.f, w: o\.w, g: o\.g, by: o\.by \|\| null, opened: o\.opened \|\| null \}/.test(rec));
  ok("  ⚠ 種類だけ（12文字に切る）", /o\.opened = String\(last\.o\)\.slice\(0, 12\)/.test(rec));
}

console.log("\n■ ④ 開いた種類は「プルダウン」を区別できる（賃料のしくみ）");
{
  /**
   * `noteOpened` が返す種類: modal / options / result / form / modal_close / none
   *   ⚠ **options** がプルダウンが開いた事（賃料・更新日・徒歩の選択肢）。
   */
  const i = hl.indexOf("function noteOpened(el)");
  const seg = hl.slice(i, i + 1200);
  ok("  options（プルダウンの中身が開いた）を見ている", /options/.test(seg));
  ok("  ⚠ 「2個以上増えた」で判定（1個は誤差）", /a\.options > b\.options \+ 2/.test(seg));
  ok("  modal（小窓）も見ている", /modal/.test(seg));
  ok("  閉じた事（確定）も見ている", /modal_close/.test(seg));
  ok("  ⚠ 中身の文字は見ていない（数の変化だけ）", !/textContent.*opens/.test(seg));
}

console.log("\n■ ⑤ `opened` を実際に組み立てて確かめる（本物の送る形を使う）");
{
  // 本体の `_recentOps` の return と同じ形
  const toSend = (o) => ({ t: o.t, k: o.k, f: o.f, w: o.w, g: o.g, by: o.by || null, opened: o.opened || null });
  const rent = { t: 1, k: "click", f: "rental_cost2", w: "select", g: 1200, by: "human", opened: "options" };
  const s = toSend(rent);
  ok("  ⚠ 賃料の操作に opened=options が付く", s.opened === "options", s);
  ok("  欄の種類（select）も残る", s.w === "select");
  ok("  人が押した事も残る", s.by === "human");
  const noOpen = toSend({ t: 2, k: "click", f: "update_date", w: "select" });
  ok("  開かなかった操作は null（嘘を入れない）", noOpen.opened === null, noOpen);
}

console.log("\n■ ⑥ 賃料の欄を「プルダウン」と判定できる（名前から）");
{
  const sl = fs.readFileSync(path.join(dir, "..", "app", "lib", "shot-learn.ts"), "utf8");
  ok("  rental_cost をプルダウンとして扱う決まりがある", /rental_cost/.test(sl));
  ok("  select の判定がある", /select/.test(sl));
}

console.log("\n■ ⑦ 構文");
{
  let ok1 = true, ok2 = true;
  try { execFileSync(process.execPath, ["--check", path.join(dir, "human-learn-record.js")], { stdio: "pipe" }); } catch { ok1 = false; }
  try { execFileSync(process.execPath, ["--check", path.join(dir, "human-learn.js")], { stdio: "pipe" }); } catch { ok2 = false; }
  ok("  human-learn-record.js の構文が通る", ok1);
  ok("  human-learn.js の構文が通る", ok2);
}

console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
if (failed > 0) process.exit(1);
