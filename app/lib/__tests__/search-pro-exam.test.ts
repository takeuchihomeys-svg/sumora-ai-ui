// 統括Pro（物件検索）の段A（2026-11-21 作業員G）: 凍結した問題集の再生・判定・quality_daily の行
// 実行: npx tsx app/lib/__tests__/search-pro-exam.test.ts
import {
  causeSummaryFromEvidence, compareProExam, judgeCase, misjudgeRow, parseCompletion, parseFoundationScore,
  replayCase, searchQualityRows, stripDerived, type EvRow,
} from "../search-pro-exam";
import { readCountFromFoundationLines } from "../learn-supervisor-pro";
import { proCauseNullStrictOn } from "../pro-cause-relearn";

let failed = 0;
function ok(name: string, cond: boolean) { if (!cond) { failed++; console.log("  ✗", name); } else console.log("  ✓", name); }

// 11/20 の realpro の形（数だけ・名前は入れない）
const EV_NEW: EvRow[] = [
  { label: "学習完成（期間・土台・つながり・一連）", value: "学習完成: 1/4 ✓／止=土台／土台 39/56 ✓／欠17／重要欠:F6_auto_after_bundle・F32_link_pipeline・F38_improve_reflect_chain・F43_improve_to_auto_link／次=重要欠" },
  { label: "自動モード完成度", value: "自動モード完成度 53/100（もう少し）" },
  { label: "土台 F55_auto_reflect_verified", value: "✗ 自動反映確認 read=2 新束後自動=0 reflect_ok=0 flow_reflect=0 aim有=0（完了線: read≥1）" },
  { label: "土台 F6_auto_after_bundle", value: "✗ 新束のあとの自動走行 0件（完了線≥1）" },
  { label: "なぜ100%でないか（統括Pro）", value: "Pro思考骨格: 止=学んだ結果を拡張が読んでいない（read_count=0）" },
  { label: "原因→改善の再学習", value: "前の決定論の行（外す）" },
];
// 11/19 までの形
const EV_OLD: EvRow[] = [
  { label: "学習完成（期間・土台・つながり・一連）", value: "学習完成: 1/4 ✓／止=土台／土台 26/0 ✓／欠30" },
  { label: "学習土台点検（F番号）", value: "土台(realpro/印realpro) 26/56 ✓／欠 30" },
  { label: "学習完成・つながり", value: "✗ 連携 solid=878 read=0 auto=? bn=無" },
];

console.log("数の読み取り");
{
  const f = parseFoundationScore(EV_NEW);
  ok("新しい形 39/56", f.ok === 39 && f.total === 56);
  ok("重要欠4", f.critical.length === 4 && f.critical[0] === "F6_auto_after_bundle");
  ok("完成度53", parseCompletion(EV_NEW) === 53);
  const o = parseFoundationScore(EV_OLD);
  ok("前の形は全数0の時に点検の行 26/56", o.ok === 26 && o.total === 56);
  ok("完成度が無ければ null", parseCompletion(EV_OLD) === null);
  ok("決定論の行を外す", stripDerived(EV_NEW).length === EV_NEW.length - 1);
}

console.log("読んだ数（土台の行から・LLM の文は読まない）");
ok("F55 の read=2", readCountFromFoundationLines(EV_NEW) === 2);
ok("前の形は つながり の read=0", readCountFromFoundationLines(EV_OLD) === 0);
ok("無ければ null", readCountFromFoundationLines([{ label: "なぜ100%でないか（統括Pro）", value: "read=0" }]) === null);

console.log("PRO_CAUSE_NULL_STRICT");
ok("既定 on", proCauseNullStrictOn({}) === true);
ok("off で戻せる", proCauseNullStrictOn({ PRO_CAUSE_NULL_STRICT: "off" }) === false);
{
  const prev = process.env.PRO_CAUSE_NULL_STRICT;
  process.env.PRO_CAUSE_NULL_STRICT = "off";
  const off = causeSummaryFromEvidence(EV_NEW);
  ok("off の時は今まで通り（read=2 でも c_read0）", off.atom_ids.includes("c_read0"));
  process.env.PRO_CAUSE_NULL_STRICT = "on";
  const on = causeSummaryFromEvidence(EV_NEW);
  ok("on: read=2 なら c_read0 を作らない", !on.atom_ids.includes("c_read0"));
  ok("on: 新束後自動0 は c_no_auto_after（反映）", on.atom_ids.includes("c_no_auto_after") && (on.layers["反映"] || 0) >= 1);
  const onOld = causeSummaryFromEvidence(EV_OLD);
  ok("on: 前の形の read=0 は c_read0 のまま", onOld.atom_ids.includes("c_read0"));
  const none = causeSummaryFromEvidence([{ label: "何か", value: "数の無い行" }]);
  ok("on: 数が無ければ c_read0・c_no_reflect_mark を作らない", !none.atom_ids.includes("c_read0") && !none.atom_ids.includes("c_no_reflect_mark"));
  if (prev == null) delete process.env.PRO_CAUSE_NULL_STRICT; else process.env.PRO_CAUSE_NULL_STRICT = prev;
}

console.log("判定と比べ");
{
  const c = { id: "t1", log_id: 1, scope: "realpro", logged_at: "", frozen_at: "", evidence: EV_NEW };
  process.env.PRO_CAUSE_NULL_STRICT = "off";
  const r = replayCase(c);
  delete process.env.PRO_CAUSE_NULL_STRICT;
  const j = judgeCase({ id: "t1", source: "", note: "", atoms_none: ["c_read0"], f_all: ["F6"], needs_scores: true }, r);
  ok("off の時は c_read0 で外れ", !j.ok && j.misses.some((m) => /c_read0/.test(m)));
  const base = [{ id: "t1", ok: true, misses: [], replay: r }];
  const now = [{ id: "t1", ok: false, misses: ["x"], replay: r }];
  const cmp = compareProExam(base, now);
  ok("前は正しく今は違う＝悪くなった", cmp.worse.length === 1 && cmp.better.length === 0);
  const mj = misjudgeRow(now, 2);
  ok("search_pro_misjudge 1/1", mj.metric === "search_pro_misjudge" && mj.value === 1 && mj.n === 1);
}

console.log("PHOTO_LEARN_UNKNOWN_NULL（束に shot_gaps が無い時）");
{
  const c = { id: "t2", log_id: 2, scope: "realpro", logged_at: "", frozen_at: "", evidence: [], bundle: { shots: { in_storage: 3778 } } };
  const on = replayCase(c);
  ok("既定 on: 学べた数は分からない（null）", on.photo_learned === null);
  ok("既定 on: flash未実行 と書かない", !/flash未実行/.test(on.photo_claim || ""));
  process.env.PHOTO_LEARN_UNKNOWN_NULL = "off";
  const off = replayCase(c);
  delete process.env.PHOTO_LEARN_UNKNOWN_NULL;
  ok("off: 今まで通り 0・flash未実行", off.photo_learned === 0 && /flash未実行/.test(off.photo_claim || ""));
  const withGaps = replayCase({ ...c, bundle: { shots: { in_storage: 3778 }, shot_gaps_normal: { learnedOk: 996, todo: 209 } } });
  ok("shot_gaps があれば数を使う", withGaps.photo_learned === 996);
}

console.log("quality_daily の行");
{
  const rows = searchQualityRows("realpro", EV_NEW, { log_id: 9, logged_at: "2026-11-20" });
  const get = (m: string) => rows.find((r) => r.metric === m);
  ok("search_found_ok:realpro 0.696", Math.abs((get("search_found_ok:realpro")?.value ?? 0) - 0.696) < 0.001);
  ok("search_found_critical:realpro 4", get("search_found_critical:realpro")?.value === 4);
  ok("search_pro_completion:realpro 53", get("search_pro_completion:realpro")?.value === 53);
  ok("原因の型は6つ（学習・土台・連携・把握・反映・自動）", rows.filter((r) => r.metric.startsWith("search_cause_layer:")).length === 6);
  ok("数が無い形では found の行を作らない", searchQualityRows("itandi", [{ label: "x", value: "y" }], { log_id: 1, logged_at: "" }).every((r) => !r.metric.startsWith("search_found")));
}

if (failed) { console.log(`FAIL ${failed}`); process.exit(1); } else console.log("全 PASS");
