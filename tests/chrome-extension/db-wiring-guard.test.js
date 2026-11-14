// DB連携の4段（送る→入る→読む→使う）が見張られているか（2026-11-14）
//
// 竹内さん「ちゃんとデータベースとの連携ができているのか。この点も強化するのと補強する。そして強化する」
//
// 見張りの道具:
//   ・scripts/audit-db-wiring.ts … 4段を1つずつ確かめ、致命的なら終了コード1
//   ・scripts/check-db-columns.ts … 本番DBの列・表の欠けを一覧
//   ・/api/cron/morning-report … 毎朝1行で「学習が届いているか」を出す
//
// 実行: node tests/chrome-extension/db-wiring-guard.test.js
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

console.log("■ ① DB連携の見張り（4段を1つずつ）");
{
  const s = read("scripts/audit-db-wiring.ts");
  t("① 送る（/api/human-motion）を見る", s.includes("/api/human-motion?shots=1"));
  t("② 入る（dropped_cols を見る）", s.includes("dropped_cols"));
  t("③ 読む（next・sequence_flow・by_mode・learn_plan）",
    s.includes("next（押す順番）") && s.includes("sequence_flow") && s.includes("by_mode") && s.includes("learn_plan"));
  t("④ 使う（拡張が読むキー）", s.includes("axlx_learn_next") && s.includes("axlx_learn_seq"));
  t("⑤ 点検の記録も見る", s.includes("/api/search-audits"));
  t("⑥ 致命的なら終了コード1", /process\.exit\(1\)/.test(s));
  t("⑦ 新しさ（何日前か）を見る", s.includes("ageDays"));
  t("4日以上古ければ警告", /ageDays >= 4/.test(s));
}

console.log("■ ② 列の欠けの点検");
{
  const s = read("scripts/check-db-columns.ts");
  t("human_motion_learn の列を持つ", s.includes("human_motion_learn"));
  t("field_order を見る", s.includes("field_order"));
  t("exam_runs を正しい列名で見る", s.includes('"label"') && s.includes('"ran_at"') && !s.includes('"run_id"'));
  t("足りない列に SQL を出す", /ALTER TABLE/.test(s));
}

console.log("■ ③ 毎朝の見張り（morning-report）");
{
  const s = read("app/api/cron/morning-report/route.ts");
  t("学習の束を読む", s.includes("human_learn_profile"));
  t("押す順番の数を出す", /押す順番\$\{nx\}通り/.test(s));
  t("一連の動きの数を出す", /一連\$\{seq\}手/.test(s));
  t("モード別の数を出す", /モード別\$\{byMode\}種/.test(s));
  t("通常と自動の記録数を出す", /通常\$\{modes\.normal \?\? 0\}・自動\$\{modes\.aix \?\? 0\}/.test(s));
  t("押す順番0なら警告", /押す順番が0（学習が止まっています）/.test(s));
  t("束が古ければ警告", /束が古い（録画・記録が届いていない）/.test(s));
  t("束が無ければ警告", /まだ束がありません/.test(s));
  t("統括の判断も1行出す", /統括: \$\{bundle\.learn_plan/.test(s));
  t("失敗してもレポートは止めない", /確認できません（/.test(s));
}

console.log("■ ④ 拡張が読むキーと、サーバーが返す項目が一致している");
{
  const bg = read("chrome-extension/background.js");
  const keys = ["axlx_learn_next", "axlx_learn_points", "axlx_learn_motion", "axlx_learn_gaps", "axlx_learn_weak",
    "axlx_learn_site_flow", "axlx_learn_screen_flow", "axlx_learn_seq", "axlx_learn_by_mode", "axlx_learn_plan"];
  for (const k of keys) t(`background が ${k} を置く`, bg.includes(k));
  t("モード別の押す順番も置く", bg.includes("axlx_learn_next_mode"));
}

console.log("■ ⑤ 点検の道具が型チェックの邪魔をしない（トップレベルの名前を汚さない）");
{
  const s = read("scripts/audit-db-wiring.ts");
  t("即時実行の関数で包む", /^void \(async \(\) => \{/m.test(s.trim()));
  t("トップレベルに const API を置かない", !/^const API = /m.test(s));
  const h = read("scripts/audit-vs-human.ts");
  t("audit-vs-human も包む", /^void \(async \(\) => \{/m.test(h.trim()));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
