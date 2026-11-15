// app/lib/__tests__/learnable-building-row.test.ts
//
// 2026-11-15 竹内さん「人が押す欄を自動モードが押していない」（統括が1番に挙げた）
//
// なぜ要るか（実測）:
//   ⚠ `div.building_tr`（物件の行）は「入れ物」ではなく**押す対象**なのに、
//     `NON_TARGET_NAMES` の `div` に当たって除外されていた。
//     人が **160回**押している（実測・7日）のに、手本から**抜けていた**。
//   ⚠ ただし `div`（ただの div）・`img`・`span` は**やっぱり入れ物**。
//     過去に学んで「div の次は img」のような意味の無い順番を学んだ実測がある。
//     → **クラス名が付いた意味のある物だけ**通す。
//
// 実行: npx tsx app/lib/__tests__/learnable-building-row.test.ts
import { isLearnableName } from "../shot-learn";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra))); }
};

console.log("■ ① 物件の行は学ぶ（人が160回押している）");
{
  ok("div.building_tr は学ぶ", isLearnableName("div.building_tr"), "div.building_tr");
  ok("div.building_list は学ぶ", isLearnableName("div.building_list"));
  ok("div.property_list は学ぶ", isLearnableName("div.property_list"));
  ok("room_ で始まるクラスは学ぶ", isLearnableName("div.room_layout") || isLearnableName("div.room_image"));
  ok("img.room_layout_image は学ぶ", isLearnableName("img.room_layout_image"), "img.room_layout_image");
}

console.log("\n■ ② ただの入れ物は今まで通り学ばない（過去の実測を守る）");
{
  ok("ただの div は学ばない", !isLearnableName("div"));
  ok("ただの img は学ばない", !isLearnableName("img"));
  ok("ただの span は学ばない", !isLearnableName("span"));
  ok("ただの td は学ばない", !isLearnableName("td"));
  ok("ただの svg は学ばない", !isLearnableName("svg"));
  ok("ただの a は学ばない", !isLearnableName("a"));
  ok("拡張自身の帯は学ばない", !isLearnableName("#axlx-bar"));
  ok("拡張自身のボタンも学ばない", !isLearnableName("axlx-learn-badge"));
}

console.log("\n■ ③ 関係ない div.xxx の扱い（実測に合わせる）");
{
  /**
   * ⚠ 実測（isLearnableName の実際の判定）:
   *   div.search_menu   → ✅ 通る（元から）
   *   div.this_window   → ❌ 除外（小窓の枠）
   *   div.wrapper       → ❌ 除外
   *   div.building_tr   → ✅ 通る（**今回から**・人が160回押している）
   *   img.room_layout_image → ✅ 通る（今回から）
   * → 今回の変更で**新しく通るのは building_tr 系と img の部屋画像だけ**（広げすぎていない）。
   */
  ok("div.search_menu は元から通る", isLearnableName("div.search_menu"));
  ok("div.this_window（小窓の枠）は除外のまま", !isLearnableName("div.this_window"));
  ok("div.wrapper は除外のまま", !isLearnableName("div.wrapper"));
  ok("div.building_tr は今回から通る", isLearnableName("div.building_tr"));
  ok("img.room_layout_image は今回から通る", isLearnableName("img.room_layout_image"));
  ok("ただの div は除外のまま", !isLearnableName("div"));
}

console.log("\n■ ④ 今まで通っていた物は今まで通り通る");
{
  ok("欄の名前（日本語）", isLearnableName("賃料"));
  ok("英語の欄の名前", isLearnableName("rental_cost2"));
  ok("1文字の意味のある物（分）", isLearnableName("分"));
  ok("label 付きの名前", isLearnableName("左の大阪市西区｜label.one_city"));
  ok("チェックの欄", isLearnableName("room_layout_id[]"));
}

console.log("\n■ ⑤ 壊れた入力でも落ちない");
{
  ok("空文字", !isLearnableName(""));
  ok("null", !isLearnableName(null));
  ok("undefined", !isLearnableName(undefined));
  ok("数字（複数桁）は元から通る（欄の値として学べる）", isLearnableName(123));
  ok("数字1文字は捨てる（意味が無い）", !isLearnableName("5"));
}

console.log("\n■ ⑥ なぜ必要かをコードに残している");
{
  const fs = require("fs") as typeof import("fs");
  const src = fs.readFileSync(require("path").join(__dirname, "../shot-learn.ts"), "utf8");
  ok("160回押していると書いてある", /160回/.test(src));
  ok("入れ物ではなく押す対象と書いてある", /入れ物.*押す対象/.test(src));
  ok("img を別に学ばない理由を書いてある", /img の次は img|img.*507回/.test(src));
}

console.log(`\n結果: 合格 ${pass} / 不合格 ${fail}`);
if (fail) process.exit(1);
