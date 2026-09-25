// app/lib/__tests__/scoring-learning.test.ts
// 物件の点の重みの学習（scoring-learning.ts・scoring-learning-episodes.ts）と、property-brain の重みの版の口の回帰テスト。
// 実行: npx tsx app/lib/__tests__/scoring-learning.test.ts
//
// 確かめること: 学ぶ処理の純関数（順位・札ごとの率・提案）／動かす量の上限・最低件数・動かさない札（AD を弱めない・外す候補・材料の欠け）／
//   確かめ用での判定／自動で入れる条件／版の切り替えと戻し／DB から読んだ重みの形の確かめ／judgeProperty への入り方
import {
  LEARNING_CONFIG, scoreOf, rankMetrics, codeStats, featureStats, proposeWeights, evaluateProposal, splitHoldout, decideAutoApply,
  switchVersion, previousVersion, activeWeights, sanitizeWeights, boundsFor, isFrozenCode, isAdCode,
  type Episode, type WeightVersion,
} from "../scoring-learning";
import { customerAt, episodeFromSnapshot, episodeFromPool, episodeFromPickups, buildContext, sameBuilding, adTwoMonthCodes } from "../scoring-learning-episodes";
import {
  judgeProperty, parsePropertyFacts, buildCustomerProfile, setReasonPointOverrides, getReasonPointOverrides, reasonPoints, baseReasonPoints,
} from "../property-brain";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}

// 既定の点（テスト用の小さな表）
const BASE: Record<string, number> = { A_GOOD: 5, B_PLAIN: 5, AD_HIGH: 20, AD_COVERS_DISCOUNT: 0, ALREADY_SENT: -30, RENT_UNKNOWN: 0, PEN: -10, RARE: 5 };
const base = (c: string) => BASE[c] ?? 0;

/** i 番目の回: 選んだ物は chosenCodes、選ばなかった物は otherCodes */
function ep(i: number, chosenCodes: string[], otherCodes: string[][], at?: string, segments: string[] = []): Episode {
  return {
    id: `e${i}`, at: at ?? new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(), source: "snapshot", segments,
    cands: [{ key: "c", chosen: true, codes: chosenCodes, feats: {} }, ...otherCodes.map((c, j) => ({ key: `o${j}`, chosen: false, codes: c, feats: {} }))],
  };
}

console.log("■ 点と順位");
{
  t("点は 50＋札の点（上書きが優先）", scoreOf(["A_GOOD", "PEN"], base) === 45 && scoreOf(["A_GOOD", "PEN"], base, { A_GOOD: 9 }) === 49);
  const eps = [ep(1, ["A_GOOD"], [[], []]), ep(2, [], [["A_GOOD"], []]), ep(3, [], [[], []])];
  const m = rankMetrics(eps, base);
  // 1: 単独1位（1）・2: 2位（0）・3: 3件同点（1/3）
  t("1位率（同点は按分）", Math.abs(m.top1 - (1 + 0 + 1 / 3) / 3) < 1e-3, JSON.stringify(m));
  // 相対順位: 1→0、2→(1+0.5)/2=0.75、3→0.5
  t("相対順位（0＝1位・でたらめ0.5）", Math.abs(m.relRank - (0 + 0.75 + 0.5) / 3) < 1e-3, JSON.stringify(m));
  t("全部同点の回を数える", m.allTied === 1);
  t("でたらめの1位率は 選んだ数÷候補数", Math.abs(m.randTop1 - 1 / 3) < 1e-3);
  t("選んだ物しか無い回は数えない", rankMetrics([{ ...ep(9, ["A_GOOD"], []) }], base).episodes === 0);
}

console.log("■ 札ごと・特徴ごとの率");
{
  const eps = [ep(1, ["A_GOOD"], [[]]), ep(2, ["A_GOOD"], [[]]), ep(3, [], [["A_GOOD"]]), ep(4, ["B_PLAIN"], [["B_PLAIN"]])];
  const s = codeStats(eps);
  t("選んだ方が札を持つ率（違う回だけ）", s.A_GOOD.episodes === 3 && Math.abs(s.A_GOOD.winRate - 2 / 3) < 1e-3, JSON.stringify(s.A_GOOD));
  t("両方が持つ札は比べない", s.B_PLAIN.episodes === 0);
  const fe: Episode = { id: "f", at: "2026-01-01T00:00:00Z", source: "pool", segments: [], cands: [
    { key: "a", chosen: true, codes: [], feats: { walk: 3, building_age: null } }, { key: "b", chosen: false, codes: [], feats: { walk: 10, building_age: 5 } }] };
  const fs = featureStats([fe]);
  t("徒歩は短い方が良い（選んだ方が短い＝1）", fs.walk.episodes === 1 && fs.walk.winRate === 1);
  t("値の無い特徴は比べない", fs.building_age.episodes === 0);
}

console.log("■ 動かさない札");
{
  t("外す候補の札は学ばない", isFrozenCode("ALREADY_SENT") && isFrozenCode("RENT_OVER_130") && isFrozenCode("ALREADY_SENT_SAME_ROOM"));
  t("材料が無いだけの札は学ばない", isFrozenCode("RENT_UNKNOWN") && isFrozenCode("EQUIP_AUTOLOCK_UNLISTED") && isFrozenCode("AD_UNKNOWN") && isFrozenCode("IMAGE_STORAGE_OK"));
  t("AD の札（段が増えても）", isAdCode("AD_HIGH") && isAdCode("AD_2_5M") && isAdCode("PROFIT_NEGATIVE") && !isAdCode("AD_UNKNOWN") && !isAdCode("FLOOR_PLAN_MATCH"));
  const b1 = boundsFor("AD_HIGH", 20, LEARNING_CONFIG, 15);
  t("AD の加点は下げない（上げるのは上限まで）", b1.lo === 20 && b1.hi === 25, JSON.stringify(b1));
  const b2 = boundsFor("PROFIT_NEGATIVE", -10, LEARNING_CONFIG, 15);
  t("AD の減点は弱めない", b2.hi === -10 && b2.lo === -15, JSON.stringify(b2));
  const b3 = boundsFor("RENT_OK", 15, LEARNING_CONFIG, 15.4);
  t("AD 以外の加点は AD 2ヶ月の合計÷1.3 を超えない", b3.hi === 15 && b3.lo === 10, JSON.stringify(b3));
  const b4 = boundsFor("RARE", 2, LEARNING_CONFIG, 30);
  t("向きは変えない（加点は0未満にしない）", b4.lo === 0 && b4.hi === 7, JSON.stringify(b4));
  const b5 = boundsFor("X_ZERO", 0, LEARNING_CONFIG, 30);
  t("0点の札は動かさない", b5.lo === 0 && b5.hi === 0);
}

console.log("■ 提案（上限・最低件数・方針）");
{
  // A_GOOD: 選んだ物だけが持つ（40回）→ 上げる。PEN: 選ばなかった物だけが持つ（40回）→ 減点を強める。
  // AD_HIGH: 選ばなかった物だけが持つ（40回）→ 下げたくなるが AD は弱めない。RARE: 5回だけ → 件数不足。ALREADY_SENT: 外す候補 → 動かさない
  const eps: Episode[] = [];
  for (let i = 0; i < 40; i++) eps.push(ep(i, ["A_GOOD"], [["PEN", "AD_HIGH", "ALREADY_SENT"], []]));
  for (let i = 40; i < 45; i++) eps.push(ep(i, ["RARE"], [[]]));
  const p = proposeWeights(eps, base, null, LEARNING_CONFIG, ["AD_HIGH", "AD_COVERS_DISCOUNT"]);
  const ch = Object.fromEntries(p.changes.map((c) => [c.code, c]));
  t("選ばれる札は上がる（上限 +5・AD 2ヶ月の合計20÷1.3=15 まで）", ch.A_GOOD && ch.A_GOOD.to > 5 && ch.A_GOOD.to <= 10, JSON.stringify(p.changes));
  t("選ばれない札は減点が強まる（−5 まで）", ch.PEN && ch.PEN.to < -10 && ch.PEN.to >= -15, JSON.stringify(p.changes));
  t("AD は下がらない", !ch.AD_HIGH && (p.weights.AD_HIGH ?? 20) >= 20);
  t("外す候補の札は動かない", !ch.ALREADY_SENT && p.weights.ALREADY_SENT === undefined);
  t("件数の少ない札は動かない（理由つき）", !ch.RARE && p.skipped.some((s) => s.code === "RARE" && /件数不足/.test(s.reason)));
  const p1 = proposeWeights(eps, base, null, { ...LEARNING_CONFIG, maxChanges: 1 }, ["AD_HIGH"]);
  t("動かす札の数の上限", p1.changes.length === 1 && p1.skipped.some((s) => /上限/.test(s.reason)));
  const p2 = proposeWeights(eps, base, null, LEARNING_CONFIG, ["AD_HIGH"]);
  t("決定論（同じ材料で同じ提案）", JSON.stringify(p2.changes) === JSON.stringify(p.changes));
  // 差がはっきりしない（半々）札は出さない
  const mixed: Episode[] = [];
  for (let i = 0; i < 40; i++) mixed.push(i % 2 ? ep(i, ["B_PLAIN"], [[]]) : ep(i, [], [["B_PLAIN"]]));
  const pm = proposeWeights(mixed, base, null);
  t("半々の札は動かさない", pm.changes.length === 0, JSON.stringify(pm.changes));
}

console.log("■ 確かめ用・自動で入れる条件");
{
  const eps: Episode[] = [];
  for (let i = 0; i < 100; i++) eps.push(ep(i, ["A_GOOD"], [["B_PLAIN", "PEN"], ["B_PLAIN"]]));
  const { train, holdout } = splitHoldout(eps, 0.25);
  t("確かめ用は新しい順に 25%", holdout.length === 25 && train.length === 75 && holdout[0].id === "e75");
  // 今は A_GOOD と B_PLAIN が同点 → A_GOOD を上げると1位になる
  const ev = evaluateProposal(holdout, base, null, { A_GOOD: 8 });
  t("当たりが良くなれば improved", ev.improved && ev.proposed.relRank < ev.base.relRank, ev.reason);
  const ev2 = evaluateProposal(holdout, base, null, { A_GOOD: 5 });
  t("変わらなければ入れない", !ev2.improved);
  const ev3 = evaluateProposal(holdout.slice(0, 5), base, null, { A_GOOD: 8 });
  t("確かめ用が少なければ入れない", !ev3.improved && /少ない/.test(ev3.reason));
  const on = { enabled: true, improved: true, episodesTotal: 400, holdout: 100, prevAccepted: 1, changes: 2 };
  t("提案だけの設定では入れない", !decideAutoApply({ ...on, enabled: false }).apply);
  t("条件を満たせば入れる", decideAutoApply(on).apply);
  t("回数が少なければ入れない", !decideAutoApply({ ...on, episodesTotal: 100 }).apply);
  t("続けて良くなった週が足りなければ入れない", !decideAutoApply({ ...on, prevAccepted: 0 }).apply);
  t("当たりが良くならなければ入れない", !decideAutoApply({ ...on, improved: false }).apply);
}

console.log("■ 版の切り替え・戻し");
{
  const vs: WeightVersion[] = [
    { version: 1, status: "retired", weights: { A: 1 } }, { version: 2, status: "active", weights: { A: 2 } }, { version: 3, status: "proposed", weights: { A: 3 } },
  ];
  const s3 = switchVersion(vs, 3);
  t("版 3 を入れると 2 は retired・active は1つ", activeWeights(s3)?.version === 3 && s3.find((v) => v.version === 2)?.status === "retired" && s3.filter((v) => v.status === "active").length === 1);
  t("前の版に戻す先（今 3 → 2）", previousVersion(s3) === 2);
  t("前の版に戻す先（今 2 → 1）", previousVersion(vs) === 1);
  const s0 = switchVersion(vs, 0);
  t("0 はコードの定数（active なし）", activeWeights(s0) === null);
  t("前が無ければ 0", previousVersion([{ version: 1, status: "active", weights: {} }]) === 0);
  let threw = false; try { switchVersion(vs, 9); } catch { threw = true; }
  t("無い版は入れられない", threw);
  t("重みの形の確かめ（壊れていれば null）", sanitizeWeights({ A_B: "x" }) === null && sanitizeWeights([1]) === null && sanitizeWeights({ bad: 1 }) === null && sanitizeWeights({ A_B: 999 }) === null);
  t("外す候補の札は版でも変えない", JSON.stringify(sanitizeWeights({ ALREADY_SENT: 0, RENT_OK: 17.4 })) === JSON.stringify({ RENT_OK: 17 }));
}

console.log("■ property-brain の重みの版の口");
{
  const prof = buildCustomerProfile({ rent_max: 80000, floor_plan: "1LDK" }, [], [], null, { today: "2026-09-25" });
  const f = parsePropertyFacts("【1】テストハイツ", { rank: 1, name: "テストハイツ", rent: 75000, floor_plan: "1LDK", ad_months: 2 });
  const j0 = judgeProperty(f, prof, 0, { today: "2026-09-25" });
  const sum0 = 50 + j0.reasonCodes.reduce((a, c) => a + reasonPoints(c), 0);
  t("版なしは今の定数（50＋札の合計）", j0.score === Math.max(0, Math.min(200, sum0)) && getReasonPointOverrides() === null);
  setReasonPointOverrides({ FLOOR_PLAN_MATCH: 20 });
  const j1 = judgeProperty(f, prof, 0, { today: "2026-09-25" });
  t("版を入れると点だけ変わる（札は同じ）", j1.score === j0.score + (20 - baseReasonPoints("FLOOR_PLAN_MATCH")) && JSON.stringify(j1.reasonCodes) === JSON.stringify(j0.reasonCodes), `${j0.score}→${j1.score}`);
  t("定数の点は版を見ない", baseReasonPoints("FLOOR_PLAN_MATCH") === 15 && reasonPoints("FLOOR_PLAN_MATCH") === 20);
  setReasonPointOverrides({});
  t("空の版は null（今の定数のまま）", getReasonPointOverrides() === null);
  setReasonPointOverrides(null);
  const j2 = judgeProperty(f, prof, 0, { today: "2026-09-25" });
  t("null で元に戻る", j2.score === j0.score);
  const adc = adTwoMonthCodes();
  t("AD 2ヶ月の札を判定から作る", adc.includes("AD_HIGH"), JSON.stringify(adc));
}

console.log("■ 1回の組み立て");
{
  const r = customerAt({ id: "x", rent_max: 90000, floor_plan: "1LDK" }, [
    { changed_field: "rent_max", old_value: "80000", created_at: "2026-09-10T00:00:00Z" },
    { changed_field: "rent_max", old_value: "85000", created_at: "2026-09-20T00:00:00Z" },
    { changed_field: "floor_plan", old_value: "1K", created_at: "2026-08-01T00:00:00Z" },
    { changed_field: "no_such_col", old_value: "1", created_at: "2026-09-20T00:00:00Z" },
  ], "2026-09-05T00:00:00Z");
  t("その時点へ戻す（後の変更の一番古い old_value）", r.c.rent_max === 80000 && r.c.floor_plan === "1LDK" && !("no_such_col" in r.c) && r.restored.join() === "rent_max");
  t("同じ建物（号室・空白・長音の違い）", sameBuilding("グランコート 201号室", "グランコート") && !sameBuilding("グランコート", "パレス城北"));
  const ctx = buildContext({ rent_max: 80000, floor_plan: "1LDK" }, [], [], "2026-09-25T00:00:00Z");
  const snap = { id: 1, sent_at: "2026-09-25T00:00:00Z", star_in_candidates: true, candidates: [
    { name: "テストハイツ", rent: 75000, floor_plan: "1LDK", is_star: true }, { name: "サンプル荘", rent: 95000, floor_plan: "1K", is_star: false }] };
  const e = episodeFromSnapshot(snap, ctx);
  t("🌟の時点の候補 → 1回（選んだ物＝🌟）", !!e && e.cands.length === 2 && e.cands[0].chosen && !e.cands[1].chosen && e.cands[0].codes.includes("FLOOR_PLAN_MATCH"), JSON.stringify(e?.cands.map((c) => c.codes)));
  t("家賃比の特徴", e?.cands[1].feats.rent_ratio === 1.188);
  t("🌟が候補に無い回は使わない", episodeFromSnapshot({ ...snap, star_in_candidates: false }, ctx) === null);
  const pool = { id: "p", sent_at: "2026-09-20T00:00:00Z", candidates: [{ name: "テストハイツ", rank: 1 }, { name: "サンプル荘", rank: 2 }, { name: "見本館", rank: 3 }] };
  const sent = [
    { property_name: "サンプル荘 102号室", delivery: "customer", source: "vision", sent_at: "2026-09-20T05:00:00Z" },
    { property_name: "見本館", delivery: "shared", source: "line_group", sent_at: "2026-09-20T00:01:00Z" }, // 共有だけは選んだ物ではない
    { property_name: "テストハイツ", delivery: "customer", source: "vision", sent_at: "2026-09-25T00:00:00Z" }, // 72時間より後
  ];
  const pe = episodeFromPool(pool, sent, ctx);
  t("拡張の回 → 72時間以内にお客様に届いた物だけが選んだ物", !!pe && pe.cands.map((c) => c.chosen).join() === "false,true,false", JSON.stringify(pe?.cands.map((c) => c.chosen)));
  t("お客様に届いていない回は使わない", episodeFromPool(pool, [sent[1]], ctx) === null);
  const pk = episodeFromPickups([
    { batch_id: "b", rank: 1, property_name: "A", status: "pending", reason_codes: ["RENT_OK"], created_at: "2026-09-25T00:00:00Z", recommended: true },
    { batch_id: "b", rank: 2, property_name: "B", status: "sent", reason_codes: ["FLOOR_PLAN_MATCH"], created_at: "2026-09-25T00:00:00Z" }], []);
  t("売上サポ → 選んだ物＝スタッフが送った物（DeepSeek の🌟は使わない）", !!pk && !pk.cands[0].chosen && pk.cands[1].chosen);
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
