// app/lib/__tests__/ops-anomaly.test.ts — 本番の異常の知らせの判断（純関数）
//   実行: npx tsx app/lib/__tests__/ops-anomaly.test.ts
import { opsAnomalyWatchMode, opsAnomalyBalanceLive, evaluateAnomalies, planAnomalyWrites, anomalyDestinations, opsAnomalyWatchOn, anomalyLineTargetFrom, anomalyLineConversation, shouldLineNotify, type AnomalyStats } from "../ops-anomaly";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const base: AnomalyStats = { llmFail15: 0, llmFailBaseline: [0, 0, 0, 0], draftStuck: 0, cronFail30: 0, customerMsgs90: 0, brainLogs90: 0, jstHour: 14 };
const kinds = (s: Partial<AnomalyStats>) => evaluateAnomalies({ ...base, ...s }).map((a) => a.kind).join(",");

t("いつも通りは何も出さない", kinds({}) === "");
t("11/03 の実測（失敗 0・止まった下書き 1・cron 失敗 0・ブレイン 6）は出さない", kinds({ draftStuck: 1, customerMsgs90: 5, brainLogs90: 6 }) === "");
t("LLM の失敗 4件は出さない（線 5）", kinds({ llmFail15: 4 }) === "");
t("LLM の失敗 5件で出す", kinds({ llmFail15: 5 }) === "llm_fail");
t("いつも失敗が多い時間帯は線を上げる（平均 3 → 線 12）", kinds({ llmFail15: 11, llmFailBaseline: [3, 3, 3, 3] }) === "" && kinds({ llmFail15: 12, llmFailBaseline: [3, 3, 3, 3] }) === "llm_fail");
t("LLM の失敗 15件は high", evaluateAnomalies({ ...base, llmFail15: 15 })[0].severity === "high");
t("止まった下書き 3件で出す", kinds({ draftStuck: 3 }) === "draft_stuck");
t("cron の失敗 3件で出す・名前を添える", (() => { const a = evaluateAnomalies({ ...base, cronFail30: 3, cronFailNames: ["brain-sweep×3"] }); return a[0]?.kind === "cron_fail" && a[0].why.includes("brain-sweep×3"); })());
t("お客様の発言 4件・ブレイン 0件で出す", kinds({ customerMsgs90: 4 }) === "brain_gap");
t("9時台は夜間見送りの発言が溜まる＝見ない", kinds({ customerMsgs90: 6, jstHour: 9 }) === "");
t("夜（JST 23時）はブレインの止まりを見ない", kinds({ customerMsgs90: 9, jstHour: 23 }) === "");
t("ブレインの記録が1件でもあれば出さない", kinds({ customerMsgs90: 9, brainLogs90: 1 }) === "");

const now = evaluateAnomalies({ ...base, llmFail15: 6, draftStuck: 4 });
const p = planAnomalyWrites([{ id: "a", kind: "llm_fail", severity: "warn", value: 5 }, { id: "b", kind: "cron_fail", severity: "warn", value: 3 }], now);
t("開いた行がある種類は更新", p.update.length === 1 && p.update[0].id === "a");
t("新しい種類は足す", p.insert.length === 1 && p.insert[0].kind === "draft_stuck");
t("戻った種類は閉じる", p.resolve.join(",") === "b");

t("知らせ先の既定は table と line", anomalyDestinations({}).join(",") === "table,line");
const U = "U" + "0".repeat(32);
t("LINE の宛先: 会話の個人の id とアカウントの鍵", JSON.stringify(anomalyLineTargetFrom({ line_user_id: U, account: "イエヤス" }, { LINE_IEYASU_CHANNEL_ACCESS_TOKEN: "k" })) === JSON.stringify({ to: U, token: "k" }));
t("LINE の宛先: アカウントが無ければスモラの鍵", anomalyLineTargetFrom({ line_user_id: U, account: null }, { LINE_SUMORA_CHANNEL_ACCESS_TOKEN: "s" })?.token === "s");
t("LINE の宛先: グループ（C…）・会話が無い・鍵が無いは送らない", !anomalyLineTargetFrom({ line_user_id: "C" + "0".repeat(32), account: "スモラ" }, { LINE_SUMORA_CHANNEL_ACCESS_TOKEN: "s" }) && !anomalyLineTargetFrom(null) && !anomalyLineTargetFrom({ line_user_id: U, account: "スモラ" }, {}));
t("送り先の会話の id は uuid の形だけ・既定は YUMA・off で止める", anomalyLineConversation({ OPS_ANOMALY_LINE_CONVERSATION: "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7" }) !== null && anomalyLineConversation({}) === "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7" && anomalyLineConversation({ OPS_ANOMALY_LINE_CONVERSATION: "off" }) === null && anomalyLineConversation({ OPS_ANOMALY_LINE_CONVERSATION: "x" }) === null);
const nowMs = Date.parse("2026-11-03T10:00:00Z");
t("同じ種類は1時間に1回まで", !shouldLineNotify("llm_fail", { llm_fail: "2026-11-03T09:30:00Z" }, nowMs, ["table", "line"]) && shouldLineNotify("llm_fail", { llm_fail: "2026-11-03T08:59:00Z" }, nowMs, ["table", "line"]) && shouldLineNotify("cron_fail", { llm_fail: "2026-11-03T09:30:00Z" }, nowMs, ["line"]));
t("宛先に line が無ければ送らない", !shouldLineNotify("llm_fail", {}, nowMs, ["table"]));
t("知らせ先を足せる", anomalyDestinations({ OPS_ANOMALY_DESTINATIONS: "table, line" }).join(",") === "table,line");
t("見張りは既定 dry（書かない・送らない）", opsAnomalyWatchMode({}) === "dry" && !opsAnomalyWatchOn({}) && opsAnomalyWatchOn({ OPS_ANOMALY_WATCH: "on" }) && opsAnomalyWatchMode({ OPS_ANOMALY_WATCH: "off" }) === "off");
// 2026-11-05 残高切れ（402）: 1回でも重い・llmFail15（500 以上と 0）とは別に数える
t("402 が1回で llm_balance（重い）", (() => { const a = evaluateAnomalies({ ...base, llmBalance15: 1 }).find((x) => x.kind === "llm_balance"); return !!a && a.severity === "high"; })());
t("402 が無ければ出さない", !evaluateAnomalies({ ...base, llmBalance15: 0 }).some((x) => x.kind === "llm_balance") && !evaluateAnomalies(base).some((x) => x.kind === "llm_balance"));
t("残高切れの知らせは既定で dry の間も出す・off で止める", opsAnomalyBalanceLive({}) && !opsAnomalyBalanceLive({ OPS_ANOMALY_BALANCE: "off" }));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
