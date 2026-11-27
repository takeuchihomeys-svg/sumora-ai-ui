// scripts/lib/__tests__/brain-health.test.ts — 朝の1枚の「ブレインの健康」（#817・2026-11-27 作業員A）
//   実行: npx tsx scripts/lib/__tests__/brain-health.test.ts
import { reachItems, shareItem, regressItems, rolloutItems, examCostItems, spendItems, countItem, brainHealthLines, brainHealthLedger, brainHealthLedgerOn, type HealthItem } from "../brain-health";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

// ① 届き（今朝の形: 試験の候補10本が全部「印なし」・前の晩は a-cpf 届かず 2/12・a-backplan 比べる 7/11）
const reach = reachItems([
  { sw: "BRAIN_CHECK_PROMISE_FLOW", verdict: "届かず", reached: 2, targets: 12, owner: "作業員A" },
  { sw: "APPLY_ROUTE_BACKPLAN", verdict: "比べる", reached: 7, targets: 11, owner: "作業員A" },
  { sw: "SECOND_APPEAL_COUNT_BY_SCENE", verdict: "印なし" },
]);
t("届き: 届かず＝悪い・比べる＝変わらない・印なし＝分からない", reach.map((x) => x.status).join() === "bad,ok,unknown" && /2\/12問/.test(reach[0].why));
t("割合: 数が少なければ分からない・線より下は悪い", shareItem({ label: "core:linkage", pct: 40, n: 85 }).status === "bad" && shareItem({ label: "x", pct: 90, n: 2 }).status === "unknown" && shareItem({ label: "y", pct: 70, n: 10 }).status === "ok");

// ② 効き（switch-regress-watch・rollout-watch の形）
const reg = regressItems([
  { name: "2026-11-15 の束（41本）", onDay: "2026-11-15", verdict: "unknown", metrics: [{ metric: "reply_match", scope: "all", verdict: "unknown", why: "番が少ない" }] },
  { name: "FOO_LINE", onDay: "2026-11-17", verdict: "down", metrics: [{ metric: "reply_match", scope: "all", verdict: "down", why: "前 80.0%（70番）→ 後 60.0%（70番）・20pt 下がった" }] },
], (n) => (n === "FOO_LINE" ? "作業員L" : "統括役"));
t("効き: 下がった＝悪い（持ち主つき）・番が少ない＝分からない", reg[1].status === "bad" && reg[1].owner === "作業員L" && reg[0].status === "unknown");
const ro = rolloutItems([{ name: "BRAIN_RAG_STATE_FILTER", action: "down", from: "all", to: "pct:50", why: "一致 on 60%・7pt 下がった" }, { name: "X", action: "thin", from: "pct:10", why: "数が足りない" }]);
t("効き: 夜の見張りが戻した＝悪い・数が足りない＝分からない", ro[0].status === "bad" && /all→pct:50/.test(ro[0].why) && ro[1].status === "unknown");

// ③ 費用
t("費用: 上限の内＝変わらない・悪化のあった本＝悪い", (() => { const c = examCostItems({ runs: 12, costUsd: 4.2, worseLabels: ["a-pick"] }); return c[0].status === "ok" && c[1].status === "bad" && /a-pick/.test(c[1].why); })());
t("費用: 上限を超えた＝悪い・試験が無い＝分からない", examCostItems({ runs: 30, costUsd: 12.5, worseLabels: [] })[0].status === "bad" && examCostItems({ runs: 0, costUsd: 0, worseLabels: [] })[0].status === "unknown");
t("費用: 特典を超える見込み＝悪い・特典の無い物は出さない", (() => { const s = spendItems([{ provider: "Claude", spendUsd: 150, forecastUsd: 230, creditUsd: 200, overCredit: true }, { provider: "DeepSeek", spendUsd: 3, forecastUsd: 5, creditUsd: 0 }]); return s.length === 1 && s[0].status === "bad"; })());

// ④⑤ 記録が無い間は分からない
const de = countItem({ area: "行き止まり", label: "地図の行き止まりの節", now: null, noRecordWhy: "本番の記録が無い（#804 は手元の json）" });
const ua = countItem({ area: "答え漏れ", label: "まだ答えていない事", now: 12, prev: 9, owner: "作業員A", noRecordWhy: "-", next: "答え漏れの番を読む" });
t("行き止まり: 記録が無ければ分からない・答え漏れ: 増えた＝悪い", de.status === "unknown" && ua.status === "bad" && /9→12/.test(ua.why));

// 束ねる
const all: HealthItem[] = [...reach, ...reg, ...ro, ...examCostItems({ runs: 12, costUsd: 4.2, worseLabels: [] }), de, ua];
const lines = brainHealthLines(all);
t("欄: 見出しに数・悪い所が先・持ち主つき", /悪い 4・変わらない 2・分からない 4/.test(lines[0]) && lines[1].startsWith("- 悪い｜効き｜FOO_LINE｜作業員L"));
t("欄: 変わらない・分からないは短く1行ずつ", lines.some((l) => l.startsWith("- 変わらない: ")) && lines.some((l) => l.startsWith("- 分からない（番が少ない・記録が無い）: ")) && lines.length === 1 + 4 + 2);
t("欄: 悪い所が無ければ「なし」", brainHealthLines([de])[1] === "- 悪い所: なし");

// 台帳
const led = brainHealthLedger(all, ["ブレインの健康: 届き: BRAIN_CHECK_PROMISE_FLOW"]);
t("台帳: 悪い所だけ・開いている題は重ねない・効きは先に", led.length === 3 && !led.some((r) => r.title.endsWith("BRAIN_CHECK_PROMISE_FLOW")) && led.find((r) => r.title.includes("FOO_LINE"))?.priority === 10);
t("台帳に積むのは既定 off", !brainHealthLedgerOn({}) && brainHealthLedgerOn({ BRAIN_HEALTH_LEDGER: "on" }));
console.log(`brain-health: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
