// 2026-10-07 竹内「設計知見もちゃんと整理して優先順位あげれる環境もつくる　そうすれば質が良くなるから」: 段（P0〜P3）の決まりを固定する
// 実行: npx tsx app/lib/__tests__/design-knowledge-priority.test.ts（自己完結・env 不要。全 OK で exit 0）
import {
  inferPriority, effectivePriority, mergePriority, normalizeTags, priorityWatch, parsePriorityBatch, isP0Relevant, PRIORITY_BOOST, P0_TAG, TAG_MAX,
} from "../design-knowledge-priority";
import { hybridRank, splitPinned, type RagRow } from "../design-knowledge-rag";
import { buildDigest, planFromRelation, type KbRow } from "../design-knowledge-curation";

let passed = 0, failed = 0;
function t(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log("  OK  " + name); } else { failed++; console.log("  NG  " + name + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : "")); }
}
let n = 0;
const row = (o: Partial<KbRow & RagRow>): KbRow & RagRow => ({ id: `id-${++n}`, title: "題", insight: "本文", is_current: true, created_at: "2026-09-01T00:00:00Z", tags: [], ...o });

console.log("── 決定論の段");
{
  t("札「絶対・最優先」→ P0（確か）", inferPriority(row({ tags: [P0_TAG, "汎用"] })).priority === 0 && inferPriority(row({ tags: [P0_TAG] })).certain);
  t("札「分析強化の原則」→ P1（確か）", inferPriority(row({ tags: ["分析強化の原則"] })).priority === 1);
  t("竹内さんの決定の言葉 → P1（確か）", inferPriority(row({ insight: "2026-10-02 竹内さんの決定: 電話は19時まで" })).priority === 1);
  t("竹内さんの承認 → P1", inferPriority(row({ context: "（10/06 竹内さん承認）" })).priority === 1);
  t("引用だけ（竹内「…」）は決定とは限らない＝言い切らない", !inferPriority(row({ insight: "竹内「重い」→ 原因は全件の読み直し" })).certain);
  t("整理の決定の行 → P1", inferPriority(row({}), { isDecisionRow: true }).priority === 1);
  t("題が事例 → P3 の推定（確かではない）", inferPriority(row({ title: "みこと事例の振り返り" })).priority === 3 && !inferPriority(row({ title: "みこと事例" })).certain);
  t("事例の題でも汎用の札は P2", inferPriority(row({ title: "〇〇事例から学んだ型", tags: ["汎用"] })).priority === 2);
  t("既定は P2", inferPriority(row({ title: "キャッシュの分け方" })).priority === 2);
  t("列の値があればそれ", effectivePriority(row({ priority: 3, tags: [P0_TAG] })) === 3);
  t("列が null なら推定", effectivePriority(row({ priority: null, tags: [P0_TAG] })) === 0);
}

console.log("── DeepSeek と合わせる");
{
  const r = row({ insight: "実装の型" });
  const g = inferPriority(r);
  t("確かな目印は LLM より先", mergePriority("x", inferPriority(row({ tags: [P0_TAG] })), { p: 3, why: "" }, row({})).priority === 0);
  t("LLM の段を使う", mergePriority("x", g, { p: 3, why: "1件の経緯" }, r).priority === 3);
  t("LLM が答えない → 推定", mergePriority("x", g, null, r).source === "fallback");
  const gen = row({ tags: ["汎用"] });
  const m = mergePriority("x", inferPriority(gen), { p: 3, why: "実測" }, gen);
  t("汎用の札は P3 に下げない（P2 のまま・要確認）", m.priority === 2 && !!m.review);
  t("竹内さんの言葉なしの P1 は要確認", !!mergePriority("x", g, { p: 1, why: "決まり" }, r).review);
  const parsed = parsePriorityBatch('{"items":[{"n":1,"p":2,"why":"型"},{"n":2,"p":"P1","why":"決まり"},{"n":3,"p":0}]}');
  t("返事を読む（P1 表記も・0 は捨てる）", parsed.get(1)?.p === 2 && parsed.get(2)?.p === 1 && !parsed.has(3));
  t("読めない返事は空", parsePriorityBatch("わかりません").size === 0);
}

console.log("── 札の正規化");
{
  const x = normalizeTags(["aix", "AIX", "rag", "audit", "line-reply", "ux", " 場面:質問 "]);
  t("略語は大文字・概念は日本語・重複は1つ", JSON.stringify(x.tags) === JSON.stringify(["AIX", "RAG", "監査", "line-reply", "UX", "場面:質問"]) && x.changed, x.tags);
  t("コード名・テーブル名は触らない", !normalizeTags(["generate-reply", "winning_patterns", "AIX"]).changed);
  t("札の上限は 8", TAG_MAX === 8);
}

console.log("── 段の見張り");
{
  const rows = [row({ tags: [P0_TAG], priority: 2 }), row({ priority: 0 }), row({ priority: null, tags: ["分析強化の原則"] }), row({ priority: null })];
  const w = priorityWatch(rows);
  t("札「絶対・最優先」なのに P2 → P0 に直す", w.fixes.some((f) => f.id === rows[0].id && f.priority === 0));
  t("札が無いのに P0 → 勝手に下げず要確認", w.review.some((x) => x.id === rows[1].id) && !w.fixes.some((f) => f.id === rows[1].id));
  t("空の行は確かな推定だけ書く", w.fixes.some((f) => f.id === rows[2].id && f.priority === 1) && !w.fixes.some((f) => f.id === rows[3].id));
  const many = Array.from({ length: 6 }, () => row({ tags: [P0_TAG] }));
  t("P0 が増えすぎたら知らせる", priorityWatch(many).warnings.some((s) => s.includes("P0")));
  const p1 = Array.from({ length: 4 }, () => row({ priority: 1 }));
  t("P1 の割合が多すぎたら知らせる", priorityWatch([...p1, row({ priority: 2 })]).warnings.some((s) => s.includes("P1")));
}

console.log("── RAG の並び・P0 の別枠");
{
  const a = row({ title: "返信の締め", priority: 2, created_at: "2026-10-01T00:00:00Z" });
  const b = row({ title: "返信の締め", priority: 1, created_at: "2026-10-01T00:00:00Z" });
  const c = row({ title: "返信の締め", priority: 3, created_at: "2026-10-01T00:00:00Z" });
  const vec = new Map([[a.id, 0.5], [b.id, 0.5], [c.id, 0.5]]);
  const r = hybridRank([a, b, c], vec, "返信の締め", { nowIso: "2026-10-07T00:00:00Z" });
  t("同じ近さなら P1 が上", r[0].row.id === b.id && r[0].priority === 1);
  t("P3 は下げない（事例の行は直しの教訓を持つ）", PRIORITY_BOOST[3] === 0);
  const off = hybridRank([a, b], vec, "返信の締め", { nowIso: "2026-10-07T00:00:00Z", weights: { priority: 0 } });
  t("priority 0 で段の点を消せる（同点は段で並ぶ）", off[0].score === off[1].score);
  const p0 = row({ title: "AIX と返信の分け方", tags: [P0_TAG] });
  const ranked = hybridRank([p0, a, b, c], new Map([[a.id, 0.6], [b.id, 0.55], [c.id, 0.5]]), "締めの一文", { nowIso: "2026-10-07T00:00:00Z" });
  const s1 = splitPinned(ranked, 2);
  t("関係ない問いでは P0 を別枠に出さない", s1.pinned.length === 0);
  const s2 = splitPinned(ranked, 2, { scene: true });
  t("場面の問いでは P0 を必ず別枠に・上位 k の席は奪わない", s2.pinned.length === 1 && s2.pinned[0].row.id === p0.id && s2.hits.length === 2 && !s2.hits.some((h) => h.row.id === p0.id));
  const s3 = splitPinned(ranked, 2, { p0Sims: new Map([[p0.id, 0.55]]) });
  t("近さが線以上なら場面なしでも別枠に", s3.pinned.length === 1);
  t("線: 近さ 0.40／語 0.40", isP0Relevant(0.4, 0) && isP0Relevant(0, 0.4) && !isP0Relevant(0.39, 0.39));
}

console.log("── まとめ（ダイジェスト）の順");
{
  const p0 = row({ title: "絶対の考え方", tags: [P0_TAG] });
  const p1 = row({ title: "内覧の候補は直近の3つ", tags: ["内覧"], priority: 1 });
  const p3 = row({ title: "内覧の事例の経緯", tags: ["内覧"], priority: 3 });
  const p2 = row({ title: "内覧の画面の型", tags: ["内覧"], priority: 2 });
  const d = buildDigest([p0, p1, p2, p3], "内覧", "2026-10-07T00:00:00Z");
  const i0 = d.markdown.indexOf("絶対・最優先"), i1 = d.markdown.indexOf("今の決まり（P1"), i2 = d.markdown.indexOf("内覧の画面の型");
  t("P0 を先頭に（分野に関係なく）・P1・P2 の順", i0 >= 0 && i0 < i1 && i1 < i2, { i0, i1, i2 });
  t("P3（事例・経緯）はまとめに入れない", !d.markdown.includes("内覧の事例の経緯"));
}

console.log("── 食い違い・重複の判定から計画");
{
  const old = row({ title: "古い決まり", created_at: "2026-09-01T00:00:00Z", priority: 2 });
  const neu = row({ title: "新しい決定", created_at: "2026-10-05T00:00:00Z", priority: 1 });
  const same = planFromRelation(old, neu, "same", "同じ", 0.96, "embedding");
  t("確かな同じ（近さ 0.95 以上・埋め込み）は退役の計画", !!same.retire && !same.review);
  t("文字の重なりだけの same は要確認", !planFromRelation(old, neu, "same", "同じ", 0.97, "lexical").retire);
  const sup = planFromRelation(old, neu, "supersedes_a", "Bが変えた", 0.8, "scene");
  t("上書きは退役しない・古い方を退役する案つきで要確認", !sup.retire && sup.review?.kind === "conflict" && sup.review.ids[0] === old.id && sup.review.note.includes(`--id=${old.id} --by=${neu.id}`));
  const con = planFromRelation(neu, old, "conflict", "逆", 0.8, "scene");
  t("食い違いは段が上（P1）の方を残す案", con.review?.ids[1] === neu.id);
  t("related・different は何もしない", !planFromRelation(old, neu, "related", "", 0.8, "embedding").review);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
