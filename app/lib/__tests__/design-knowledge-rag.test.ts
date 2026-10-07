// 2026-10-06 竹内「設計知見ひっぱるときRAG検索いれたらどうか」（⑯）: 設計知見の自然文の引き方の決まりを固定する
// 実行: npx tsx app/lib/__tests__/design-knowledge-rag.test.ts（自己完結・env 不要）
import {
  kbEmbeddingInput, textHash, needsEmbedding, queryGrams, keywordScore, tagScore, recencyScore, hybridRank, cosine, isOwnerWords,
  EMBED_MAX_CHARS, HYBRID_WEIGHTS, NEAR_DUP_MIN, rowInScene, KB_SCENES, sceneQuery, type RagRow,
} from "../design-knowledge-rag";

let passed = 0, failed = 0;
const t = (name: string, cond: boolean, extra?: unknown) => { if (cond) { passed++; console.log("  OK  " + name); } else { failed++; console.log("  NG  " + name + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : "")); } };
let n = 0;
const row = (o: Partial<RagRow>): RagRow => ({ id: `id-${++n}`, title: "題", insight: "本文", is_current: true, created_at: "2026-09-01T00:00:00Z", tags: [], ...o });
const NOW = "2026-10-06T00:00:00Z";

console.log("── 埋め込みの文");
const r1 = row({ title: "待ち合わせ場所は1件目", insight: "内覧日が決まったら1件目", rationale: "根拠", tags: ["内覧", "AIX"] });
t("題・本文・根拠・札を入れる", kbEmbeddingInput(r1) === "待ち合わせ場所は1件目\n内覧日が決まったら1件目\n根拠\n札: 内覧・AIX");
t("4,000字で切る", kbEmbeddingInput(row({ insight: "あ".repeat(9000) })).length === EMBED_MAX_CHARS);
t("文が同じなら指紋も同じ・違えば違う", textHash("abc") === textHash("abc") && textHash("abc") !== textHash("abd"));
t("埋め込みが無い・文が変わった行は埋め直す・同じなら埋めない", needsEmbedding({ ...r1, embedding_hash: null } as RagRow & { embedding_hash: null }) && !needsEmbedding({ ...r1, embedding_hash: textHash(kbEmbeddingInput(r1)) } as RagRow & { embedding_hash: string }));
t("退役した行は埋めない", !needsEmbedding({ ...r1, is_current: false, embedding_hash: null } as RagRow & { embedding_hash: null }));

console.log("── 語・札・新しさ");
const qg = queryGrams("待ち合わせ場所はどう決める");
t("問いの語から助詞・どう・決め を外す", qg.has("待ち") && qg.has("場所") && !qg.has("どう"), [...qg]);
t("題に語がある行ほど語の点が高い", keywordScore(row({ title: "待ち合わせ場所の決め方" }), qg) > keywordScore(row({ title: "別の話", insight: "待ち合わせ場所" }), qg));
t("札が問いに入っていれば札の点", tagScore(row({ tags: ["内覧"] }), "内覧の段階") > 0 && tagScore(row({ tags: ["見積書"] }), "内覧の段階") === 0);
t("指定の札は重く", tagScore(row({ tags: ["RAG"] }), "x", ["RAG"]) === 1);
t("新しさは60日で半分", Math.abs(recencyScore("2026-08-07T00:00:00Z", NOW) - 0.5) < 0.01);
t("竹内さんの言葉がある行", isOwnerWords(row({ insight: "竹内さん「おって連絡じゃない」" })) && !isOwnerWords(row({ insight: "ふつうの説明" })));

console.log("── 並べ方");
const a = row({ id: "A", title: "待ち合わせ場所は1件目の内覧物件", created_at: "2026-10-02T00:00:00Z" });
const b = row({ id: "B", title: "見積書の割引は判定に入れない" });
const c = row({ id: "C", title: "待ち合わせの住所は番地まで", is_current: false });
const vec = new Map([["A", 0.62], ["B", 0.30], ["C", 0.70]]);
const h = hybridRank([a, b, c], vec, "待ち合わせ場所はどう決める", { nowIso: NOW });
t("退役した行は出さない（近くても）", !h.some((s) => s.row.id === "C"));
t("近さと語の両方が高い行が1位", h[0].row.id === "A");
t("近さは候補の中で 0〜1 にそろえる", h.find((s) => s.row.id === "A")!.vector === 1 && h.find((s) => s.row.id === "B")!.vector === 0);
t("近さだけ・語だけの並べ方も選べる（評価用）", hybridRank([a, b], vec, "x", { nowIso: NOW, mode: "vector" })[0].row.id === "A" && hybridRank([a, b], new Map(), "見積書の割引", { nowIso: NOW, mode: "keyword" })[0].row.id === "B");
const o1 = row({ id: "O", title: "同じ点の行", insight: "竹内さん「決定」" }), o2 = row({ id: "P", title: "同じ点の行", insight: "説明" });
const tie = hybridRank([o2, o1], new Map(), "zz", { nowIso: NOW, weights: { recency: 0 } });
t("点が並んだら竹内さんの言葉がある行が上", tie[0].row.id === "O", tie.map((s) => [s.row.id, s.score]));
t("重みは評価で決めた値（keyword 0.5・tag 0.3・recency 0.15）", HYBRID_WEIGHTS.keyword === 0.5 && HYBRID_WEIGHTS.tag === 0.3 && HYBRID_WEIGHTS.recency === 0.15);

console.log("── 似ている組の近さ");
t("コサイン", Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9 && Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
t("似ている組の線は 0.80（DeepSeek が同じ・上書きとした27組の 20 が入る）", NEAR_DUP_MIN === 0.8);

console.log("── 返信の場面で引く（3巡目）");
{
  t("題の型で場面に入る（検討します）", rowInScene({ title: "「検討します」と持ち帰った場面は2択", tags: [] }, "considering"));
  t("札だけでも場面に入る", rowInScene({ title: "無関係", tags: [KB_SCENES.viewing.tag] }, "viewing"));
  t("本文の語では入らない（題だけ）", !rowInScene({ title: "キャッシュの分け方", tags: [] }, "cost"));
  const r1 = { id: "S", title: "検討中の締め", insight: "x", tags: [], is_current: true, created_at: NOW };
  const r2 = { id: "O", title: "別の話", insight: "x", tags: [], is_current: true, created_at: NOW };
  t("場面の行に点が足される", hybridRank([r2, r1], new Map([["S", 0.5], ["O", 0.6]]), "締め", { nowIso: NOW, scene: "considering" })[0].row.id === "S");
  t("場面なしは今まで通り", hybridRank([r2, r1], new Map([["S", 0.5], ["O", 0.6]]), "締め", { nowIso: NOW })[0].row.id === "O");
  t("問いに語を足す形", sceneQuery("締め", "ack") !== "締め" && sceneQuery("締め", null) === "締め");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
