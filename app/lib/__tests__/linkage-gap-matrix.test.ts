// app/lib/__tests__/linkage-gap-matrix.test.ts — 連携の切れ目の一覧（2026-11-26 作業員A）
//   実行: npx tsx app/lib/__tests__/linkage-gap-matrix.test.ts
import { LINKAGE_GAP_SOURCES, rankGaps, gapTopLines, gapLedgerItems, gapBundleCandidates, gapLedgerTitle } from "../linkage-gap-matrix";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("出す側: 頼みの11種類＋札・ブレインの決め＋ブレインの土台9つ＋組み合わせの束ね1つ（L の返信の土台は別ファイル）", LINKAGE_GAP_SOURCES.length >= 23 && LINKAGE_GAP_SOURCES.some((x) => x.id === "brain_combo" && x.cells.combo?.state === "off"));
const r = rankGaps();
t("並び: 値打ちの高い順・off と none だけ・未確認は入らない", r.every((g, i) => i === 0 || r[i - 1].value >= g.value) && r.every((g) => g.state === "off" || g.state === "none"));
{ // 2026-11-26: 並びは数で変わる（L の返信の土台の行が入ると上位が入れ替わる）＝本物の表ではなく決まった小さな表で並べ方だけ確かめる
  const fx = [{ id: "a", name: "A", owner: "x", value: 10, valueBase: "", cells: { brain: { state: "off" as const }, writer: { state: "on" as const } } }, { id: "b", name: "B", owner: "y", value: 30, valueBase: "", cells: { aix2: { state: "none" as const }, final: { state: "unknown" as const } } }, { id: "c", name: "C", owner: "z", value: null, valueBase: "", cells: { brain: { state: "none" as const } } }];
  const rf = rankGaps(fx);
  t("上位: 値打ちの高い順・on と未確認と値打ちの無い行は入らない", rf.length === 2 && rf[0].source === "b" && rf[1].source === "a");
}
t("今日見つけた物が行にある（選んだ理由の判断 off・札 shadow・2通目・反応の予想 off）", r.some((g) => g.source === "pickup_select" && g.sink === "brain") && r.some((g) => g.source === "reaction_predict"));
t("毎朝の1枚: 上位3つと未確認の升の数", gapTopLines().length === 4 && /未確認の升 \d+/.test(gapTopLines()[0]));
{ const items = gapLedgerItems([]); t("自動の台帳: 値打ち 15 以上・台帳の番号が無い切れ目だけ・同じ題が開いていれば足さない", items.length > 0 && items.every((x) => x.title.startsWith("連携の切れ目: ")) && gapLedgerItems(items.map((x) => x.title)).length === 0); }
t("次の晩の候補: 作ったが off でスイッチのある切れ目", gapBundleCandidates().length > 0 && gapBundleCandidates().every((x) => /^[A-Z_]+（/.test(x)));
t("題の形", gapLedgerTitle(rankGaps()[0]).includes(" → "));
console.log(`linkage-gap-matrix: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
