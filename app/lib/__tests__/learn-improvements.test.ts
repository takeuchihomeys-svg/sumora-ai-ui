// app/lib/__tests__/learn-improvements.test.ts
// 2026-11-14 竹内さん「また今日強化されたら『強化した』と統括に保存しておくようにする」
//   「今日一日でかなり質が上がったかな」
//
// なぜ要るか:
//   `learn_supervisor_log` には**判断**は残るが、**何を直した結果どう変わったか**が残らない。
//   → 強化を1件ずつ `learn_improvements` に残す（分野・何を・なぜ（実測）・どう直した・効くはずの所・確かめ方）。
//
// ⚠ 大事な決まり:
//   ① **実測の数字**を必ず入れる（推測で「良くなった」と書かない）
//   ② 強化の数は**材料の点を上げない**（直したから賢くなったと自動で決めない・効いたかは数字で見る）
//   ③ 入れるのは仕組みの話だけ（お客様の名前・入力した中身・住所は入れない）
//   ④ 同じ title は二度足さない（何度流しても増えない）
//
// 実行: npx tsx --env-file=.env.local app/lib/__tests__/learn-improvements.test.ts
import fs from "node:fs";
import path from "node:path";
import { toImprovementRow, type Improvement } from "../learn-improvements";
import { superviseLearn } from "../learn-supervisor";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 400))); }
};

const root = path.join(__dirname, "..", "..", "..");

console.log("■ ① 保存する形（分野・何を・なぜ・どう直した・効く所・確かめ方）");
{
  const row = toImprovementRow({
    area: "拡張",
    title: "録画が操作を拾えていなかった原因を直した",
    why: "実測: seen0 が全部",
    how: "最大3秒待つ",
    effect: "本物の欄が記録される",
    verify: "node tests/…",
    version: "2.7.49",
  });
  ok("area が入る", row.area === "拡張");
  ok("title が入る", String(row.title).includes("録画"));
  ok("why が入る", String(row.why).includes("実測"));
  ok("how が入る", String(row.how).includes("3秒"));
  ok("effect が入る", String(row.effect).includes("記録"));
  ok("verify が入る", String(row.verify).includes("tests"));
  ok("version が入る", row.version === "2.7.49");
  ok("at（いつ）が入る", typeof row.at === "string" && row.at.length > 10);
  ok("  ⚠ 長すぎる文は切る（DBを太らせない）", String(toImprovementRow({ area: "a", title: "x".repeat(500), why: "y".repeat(2000), how: "", effect: "" }).title).length <= 200);
}

console.log("\n■ ② 個人情報の列が無い");
{
  const row = toImprovementRow({ area: "a", title: "t", why: "", how: "", effect: "" });
  const keys = Object.keys(row).join(",");
  ok("名前・電話・住所・入力値の列が無い", !/customer_name|phone|address|input_value|email|message/i.test(keys), keys);
}

console.log("\n■ ③ 強化の数は材料の点を上げない（直したから賢くなったと決めない）");
{
  const base = {
    rows: 200, next: 40, points: 80, opens: 20, screens: 4, sequence: 6, gap_ms: 900,
    weak: [], mode_counts: { normal: 200 }, site_counts: { realpro: 200 }, with_ops: 120,
    site: "all", shot_rows: 190,
  };
  const a = superviseLearn({ ...base });
  const b = superviseLearn({ ...base, improvements: { total: 50, by_area: [{ area: "拡張", n: 50 }] } });
  ok("⚠ 材料の点が変わらない（同じ）", a.score.coverage === b.score.coverage, { a: a.score.coverage, b: b.score.coverage });
  ok("⚠ 結論も変わらない（同じ）", a.verdict === b.verdict, { a: a.verdict, b: b.verdict });
  const ev = b.meeting.evidence.find((e) => e.label === "今日の強化");
  ok("  根拠に「今日の強化」が出る", !!ev, b.meeting.evidence.map((e) => e.label));
  ok("  何件・どの分野かを言う", !!ev && ev.value.includes("50件") && ev.value.includes("拡張"), ev);
}

console.log("\n■ ④ 記録する中身に実測の数字が入っている（推測で書かない）");
{
  const src = fs.readFileSync(path.join(root, "scripts", "save-improvements.ts"), "utf8");
  const items: Improvement[] = [];
  // スクリプト内の why を数える（実測の数字が入っているか）
  const whys = src.match(/why: "([^"]*)"/g) || [];
  ok("強化が10件以上ある（今日の分）", whys.length >= 10, whys.length);
  const withNumbers = whys.filter((w) => /[0-9]/.test(w));
  ok("  ⚠ 全部に数字が入っている（実測）", withNumbers.length === whys.length, { total: whys.length, withNumbers: withNumbers.length });
  ok("  「実測」と書いてある物が多い", whys.filter((w) => w.includes("実測")).length >= whys.length - 1);
  void items;
}

console.log("\n■ ⑤ 同じ title は二度足さない（何度流しても増えない）");
{
  const db = fs.readFileSync(path.join(root, "app", "lib", "learn-improvements.ts"), "utf8");
  ok("title で重複を確かめる", /eq\("title", row\.title\)/.test(db));
  ok("  表が無い時は静かに諦める（学習は止めない）", /no_table/.test(db));
}

console.log("\n■ ⑥ 表の決まり（RLS を有効にしない＝書けなくならない）");
{
  const mig = fs.readFileSync(path.join(root, "app", "api", "migrate-schema", "route.ts"), "utf8");
  const init = fs.readFileSync(path.join(root, "app", "api", "learn-improvements-init", "route.ts"), "utf8");
  ok("migrate-schema が表を作る", /CREATE TABLE IF NOT EXISTS learn_improvements/.test(mig));
  ok("  ⚠ DISABLE ROW LEVEL SECURITY（RLS で書けなくならない）", /ALTER TABLE learn_improvements DISABLE ROW LEVEL SECURITY/.test(mig));
  ok("  ENABLE していない", !/ALTER TABLE learn_improvements ENABLE ROW LEVEL SECURITY/.test(mig));
  ok("init も作れる", /CREATE TABLE IF NOT EXISTS learn_improvements/.test(init));
  ok("  init は DISABLE も流す", /ALTER TABLE learn_improvements DISABLE ROW LEVEL SECURITY/.test(init));
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
