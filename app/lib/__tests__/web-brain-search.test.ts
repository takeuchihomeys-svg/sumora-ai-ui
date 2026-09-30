// app/lib/__tests__/web-brain-search.test.ts
// 2026-09-25 竹内「チェックした物の一括検索。拡張ツールでブレインモードに選択していたら連動して検索。ブレインモードのみで連動」
//   ＋ どの PC がどの出どころを拾うか（automation-sources.ts）
// 実行: npx tsx app/lib/__tests__/web-brain-search.test.ts（全 PASS で exit 0）
import { buildWebBrainCommands, webBrainBlockReason, summarizeWebBrainProgress, queuedKey, isWebBrainSite, WEB_BRAIN_MAX_CUSTOMERS } from "../web-brain-search";
import { excludedSourcesFor, pendingSourceOrFilter, isReusableForManualTrigger, BRAIN_EXPIRE_MESSAGE, deferForRealproNotReady, pickClaimable, RP_NOT_READY_DEFER_MS, notForThisInstall } from "../automation-sources";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const NOW = Date.parse("2026-09-25T15:00:00+09:00");
const at = (jst: string) => new Date(`${jst}+09:00`).toISOString();

console.log("── 積む行（1人1コマンド・更新日はお客様ごと）");
{
  const { rows, skipped } = buildWebBrainCommands([
    { id: "c1", last_property_sent_at: at("2026-09-24T18:00:00") },
    { id: "c2", rp_update_days: 7 },
    { id: "c3" },
    { id: "c1" },
  ], "realnetpro", true, { nowMs: NOW });
  t("重複を除いて3人＝3コマンド", rows.length === 3 && skipped.length === 0, JSON.stringify(rows.map((r) => r.customer_ids)));
  t("★ payload は source=web_brain・広げて・更新日（昨日→1）", JSON.stringify(rows[0].payload) === JSON.stringify({ source: "web_brain", is_wide: true, rp_update_days: 1 }), JSON.stringify(rows[0].payload));
  t("★ 手で決めた更新日（7）が先", rows[1].payload.rp_update_days === 7);
  t("初めてのお客様は絞らない（null）", rows[2].payload.rp_update_days === null);
  t("サイトは1つ・pending・batch_property_search", rows.every((r) => r.sites.length === 1 && r.sites[0] === "realnetpro" && r.status === "pending" && r.command_type === "batch_property_search"));
  const again = buildWebBrainCommands([{ id: "c1" }, { id: "c2" }], "realnetpro", false, { nowMs: NOW, queued: new Set([queuedKey("c1", "realnetpro"), queuedKey("c2", "itandi")]) });
  t("★ まだ終わっていない同じお客様・同じサイトは積まない（二度押し）", again.rows.length === 1 && again.rows[0].customer_ids[0] === "c2" && again.skipped.join() === "c1");
}

console.log("── 押せるか");
{
  t("0人 → 押せない", webBrainBlockReason(0, "realnetpro") !== null);
  t("リアプロ 5人 → 押せる", webBrainBlockReason(5, "realnetpro") === null);
  t("itandi 5人 → 押せる", webBrainBlockReason(5, "itandi") === null);
  t("★ レインズは条件を入れるだけ → 1人だけ", webBrainBlockReason(1, "reins") === null && webBrainBlockReason(2, "reins") !== null);
  t(`上限 ${WEB_BRAIN_MAX_CUSTOMERS}人`, webBrainBlockReason(WEB_BRAIN_MAX_CUSTOMERS + 1, "realnetpro") !== null);
  t("サイトの名前", isWebBrainSite("realnetpro") && isWebBrainSite("itandi") && isWebBrainSite("reins") && !isWebBrainSite("realpro") && !isWebBrainSite(undefined));
}

console.log("── 進み具合");
{
  const since = NOW - 120_000;
  const p1 = summarizeWebBrainProgress([{ id: "1", status: "pending" }, { id: "2", status: "pending" }], { sinceMs: since, nowMs: NOW });
  t("★ 2分たっても全部 pending → ブレインの PC がいない知らせ", p1.waitingForBrainPc && /ブレインモードの PC がまだ拾っていません/.test(p1.line), p1.line);
  const p2 = summarizeWebBrainProgress([{ id: "1", status: "done" }, { id: "2", status: "running" }], { sinceMs: since, nowMs: NOW });
  t("検索中がいれば知らせない・終わっていない", !p2.waitingForBrainPc && !p2.finished && p2.line.includes("完了 1/2") && p2.line.includes("検索中 1"), p2.line);
  const p3 = summarizeWebBrainProgress([{ id: "1", status: "done" }, { id: "2", status: "error", error_message: BRAIN_EXPIRE_MESSAGE }, { id: "3", status: "cancelled" }], { sinceMs: since, nowMs: NOW });
  t("done・error・cancelled だけ → 終わり", p3.finished && p3.failed === 1 && p3.cancelled === 1, p3.line);
  t("0件は終わりにしない", !summarizeWebBrainProgress([], { sinceMs: since, nowMs: NOW }).finished);
}

console.log("── どの PC がどの出どころを拾うか（/api/automation/pending）");
{
  t("通常の PC: aix・自動便・web_brain を渡さない", excludedSourcesFor({ aix: false, brain: false }).join() === "aix,auto_schedule,web_brain");
  t("AIX の PC: web_brain だけ渡さない", excludedSourcesFor({ aix: true, brain: false }).join() === "web_brain");
  t("★ ブレインの PC（AIX でない）: aix・自動便を渡さない＝web_brain は渡す", excludedSourcesFor({ aix: false, brain: true }).join() === "aix,auto_schedule");
  t("🧠×AIX の PC: 全部渡す（自動便は拡張が見送る）", pendingSourceOrFilter({ aix: true, brain: true }) === null);
  t("フィルタの形（旧と同じ書き方に web_brain を足しただけ）", pendingSourceOrFilter({ aix: false, brain: false }) === "payload->>source.is.null,and(payload->>source.neq.aix,payload->>source.neq.auto_schedule,payload->>source.neq.web_brain)", String(pendingSourceOrFilter({ aix: false, brain: false })));
  t("旧 ?aix=1 の PC と同じ（web_brain が無ければ絞らない＝前は絞っていなかった）＋ v2.5.44 自動便から続いた広げて（chain_picker）は拾う", pendingSourceOrFilter({ aix: true, brain: false }) === "payload->>source.is.null,and(payload->>source.neq.web_brain),payload->>chain_picker.eq.aix_or_brain", String(pendingSourceOrFilter({ aix: true, brain: false })));
  t("v2.5.44 ブレインの PC（AIX でない）は chain_picker を足さない（web_brain は元から拾う）", !String(pendingSourceOrFilter({ aix: false, brain: true })).includes("chain_picker"));
  t("手で押した一括（force なし）は web_brain・aix・自動便を再利用しない", !isReusableForManualTrigger("web_brain") && !isReusableForManualTrigger("aix") && !isReusableForManualTrigger("auto_schedule") && isReusableForManualTrigger(null));
}

console.log("── v2.5.48 リアプロがログインの画面の PC（?rp=0）には、リアプロを含む手の命令を少しの間渡さない");
{
  // 2026-09-30 YUMA の手の命令 90aee87c（16:22）・667f41a4（16:35）が2回ともログイン切れの PC 38f4be8b に渡った
  const made = at("2026-09-30T16:22:00");
  const n0 = Date.parse(made);
  const row = { id: "90aee87c", created_at: made, payload: { source: "web_brain", is_wide: false }, sites: ["realnetpro", "itandi"], command_type: "batch_search" };
  t("★ 積んだ直後・rp=0 の PC には渡さない", deferForRealproNotReady(row, { rpReady: false }, n0 + 20_000));
  t("状態の良い PC には渡す", !deferForRealproNotReady(row, { rpReady: true }, n0 + 20_000));
  t("3分を過ぎたら rp=0 の PC にも渡す（ブレインの PC が1台だけでも止めない）", !deferForRealproNotReady(row, { rpReady: false }, n0 + RP_NOT_READY_DEFER_MS));
  t("ITANDI だけの命令は渡す", !deferForRealproNotReady({ ...row, sites: ["itandi"] }, { rpReady: false }, n0 + 20_000));
  t("自動便は今まで通り", !deferForRealproNotReady({ ...row, payload: { source: "auto_schedule" } }, { rpReady: false }, n0 + 20_000));
  t("AIX の検索は今まで通り", !deferForRealproNotReady({ ...row, payload: { source: "aix" } }, { rpReady: false }, n0 + 20_000));
  t("止める命令（stop_all）は必ず渡す", !deferForRealproNotReady({ ...row, command_type: "stop_all" }, { rpReady: false }, n0 + 20_000));
  t("sites が無い古い行は渡す", !deferForRealproNotReady({ ...row, sites: null }, { rpReady: false }, n0 + 20_000));
  t("not_before がある時はそこから数える", deferForRealproNotReady({ ...row, payload: { source: "web_brain", not_before: at("2026-09-30T16:30:00") } }, { rpReady: false }, Date.parse(at("2026-09-30T16:31:00"))));
  const auto = { id: "auto", created_at: at("2026-09-30T10:00:00"), payload: { source: "auto_schedule" }, sites: ["realnetpro", "itandi"], command_type: "batch_search" };
  const list = [auto, row];
  const pick = (rp: boolean, now: number) => pickClaimable(list.filter((c) => !deferForRealproNotReady(c, { rpReady: rp }, now)), now)?.id;
  t("rp=0 の PC は手の命令を譲って自動便を拾う", pick(false, n0 + 20_000) === "auto", String(pick(false, n0 + 20_000)));
  t("状態の良い PC は手の命令を先に拾う（今まで通り）", pick(true, n0 + 20_000) === "90aee87c");
  // 2026-09-30 拾う PC の指定（YUMA 19:07・19:14 は待機中の別の PC がログイン画面のまま拾った）
  const aimed = { payload: { source: "web_brain", target_install: "74a7a6fa" }, command_type: "batch_property_search" };
  t("★ 指定した PC でない PC には渡さない", notForThisInstall(aimed, "38f4be8b"));
  t("指定した PC には渡す", !notForThisInstall(aimed, "74a7a6fa"));
  t("PC の名乗りが無い拡張には渡さない", notForThisInstall(aimed, null));
  t("指定が無い命令は今まで通りどの PC にも渡す", !notForThisInstall({ payload: { source: "web_brain" } }, "38f4be8b") && !notForThisInstall({ payload: null }, null));
  t("止める命令（stop_all）は指定があっても渡す", !notForThisInstall({ ...aimed, command_type: "stop_all" }, "38f4be8b"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
