// app/lib/__tests__/unsend-refresh.test.ts — 取り消した通を見た判断・下書きを外して分析し直すか（実物: ☆ 10/26 07:08〜07:10 の3通・判断 07:10:02）
import { unsendRefreshOn, unsendRefreshPlan } from "../unsend-refresh";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };
t("既定 off", unsendRefreshOn({}) === false && unsendRefreshOn({ UNSEND_REFRESH: "on" }) === true);
const p = unsendRefreshPlan({ sender: "customer", unsentAt: "2026-10-26T07:09:30Z", suggestedAnalyzedTs: "2026-10-26T07:09:40Z", lastAnalyzedTs: "2026-10-26T07:09:40Z", hasDraft: true });
t("判断が取り消した通を見ていた → 外して分析し直す", p.rerun && p.clearSuggested && p.clearLast && p.clearDraft, p);
t("判断が取り消した通より前 → 触らない", !unsendRefreshPlan({ sender: "customer", unsentAt: "2026-10-26T07:09:30Z", suggestedAnalyzedTs: "2026-10-26T07:00:00Z", lastAnalyzedTs: null, hasDraft: true }).rerun);
t("スタッフの通の取り消しは触らない", !unsendRefreshPlan({ sender: "staff", unsentAt: "2026-10-26T07:09:30Z", suggestedAnalyzedTs: "2026-10-26T07:09:40Z", lastAnalyzedTs: null, hasDraft: true }).rerun);
const q = unsendRefreshPlan({ sender: "customer", unsentAt: "2026-10-26T07:09:30Z", suggestedAnalyzedTs: null, lastAnalyzedTs: "2026-10-26T07:09:30Z", hasDraft: false });
t("控えだけが見ていた → 控えだけ外す・下書きが無ければ下書きは触らない", q.rerun && !q.clearSuggested && q.clearLast && !q.clearDraft, q);
t("時刻が分からない → 触らない", !unsendRefreshPlan({ sender: "customer", unsentAt: null, suggestedAnalyzedTs: "2026-10-26T07:09:40Z", lastAnalyzedTs: null, hasDraft: true }).rerun);
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
