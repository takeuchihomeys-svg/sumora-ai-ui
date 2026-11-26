// app/lib/__tests__/linkage-gap-matrix.test.ts — 連携の切れ目の一覧（2026-11-26 作業員A）
//   実行: npx tsx app/lib/__tests__/linkage-gap-matrix.test.ts
import { LINKAGE_GAP_SOURCES, rankGaps, gapTopLines } from "../linkage-gap-matrix";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("出す側は頼みの11種類＋今日の2つ（札・ブレインの決め）", LINKAGE_GAP_SOURCES.length === 13);
const r = rankGaps();
t("並び: 値打ちの高い順・off と none だけ・未確認は入らない", r.every((g, i) => i === 0 || r[i - 1].value >= g.value) && r.every((g) => g.state === "off" || g.state === "none"));
t("上位: 2通目のブレインの決め・約束の台帳の2通目（L の確かめ）・札", r[0].source === "brain_decided" && r.slice(0, 5).some((g) => g.source === "aix_state_card") && r.slice(0, 3).some((g) => g.source === "promise_ledger"));
t("今日見つけた物が行にある（選んだ理由の判断 off・札 shadow・2通目・反応の予想 off）", r.some((g) => g.source === "pickup_select" && g.sink === "brain") && r.some((g) => g.source === "reaction_predict"));
t("毎朝の1枚: 上位3つと未確認の升の数", gapTopLines().length === 4 && /未確認の升 \d+/.test(gapTopLines()[0]));
console.log(`linkage-gap-matrix: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
