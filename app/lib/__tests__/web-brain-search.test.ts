// app/lib/__tests__/web-brain-search.test.ts
// 2026-09-25 竹内「チェックした物の一括検索。拡張ツールでブレインモードに選択していたら連動して検索。ブレインモードのみで連動」
//   ＋ どの PC がどの出どころを拾うか（automation-sources.ts）
// 実行: npx tsx app/lib/__tests__/web-brain-search.test.ts（全 PASS で exit 0）
import { buildWebBrainCommands, webBrainBlockReason, summarizeWebBrainProgress, queuedKey, isWebBrainSite, WEB_BRAIN_MAX_CUSTOMERS } from "../web-brain-search";
import { excludedSourcesFor, pendingSourceOrFilter, isReusableForManualTrigger, BRAIN_EXPIRE_MESSAGE } from "../automation-sources";

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
  t("旧 ?aix=1 の PC と同じ（web_brain が無ければ絞らない＝前は絞っていなかった）", pendingSourceOrFilter({ aix: true, brain: false }) === "payload->>source.is.null,and(payload->>source.neq.web_brain)");
  t("手で押した一括（force なし）は web_brain・aix・自動便を再利用しない", !isReusableForManualTrigger("web_brain") && !isReusableForManualTrigger("aix") && !isReusableForManualTrigger("auto_schedule") && isReusableForManualTrigger(null));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
