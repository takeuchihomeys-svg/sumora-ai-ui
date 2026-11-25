/**
 * 連続客ループ台帳＋細分化強化
 * npx tsx app/lib/__tests__/handoff-loop-ledger.test.ts
 */
import {
  atomsFromAuditSteps,
  fineAtomsFromAuditSteps,
  judgeHandoffLoop,
  planHandoffStrengthen,
  countFineAtomsAcrossAudits,
  formatLoopAdvance,
} from "../handoff-loop-ledger";

let pass = 0;
let fail = 0;
function t(name: string, ok: boolean) {
  if (ok) {
    pass++;
    console.log("✓", name);
  } else {
    fail++;
    console.log("✗", name);
  }
}

{
  const a = atomsFromAuditSteps([
    { k: "leftover_clean", d: "ok" },
    { k: "customer_think", d: "ok" },
    { k: "now_customer", d: "place" },
    { k: "now_customer search", d: "ok" },
    { k: "dl:auto_pdf_end", d: "ok" },
    { k: "post_send_clear", d: "完了" },
    { k: "series_done", d: "次客可" },
  ]);
  const j = judgeHandoffLoop(a);
  t("全原子そろえば ok", j.ok && j.canAdvance);
}

{
  const a = atomsFromAuditSteps([
    { k: "leftover_clean", d: "ok" },
    { k: "human_takeover", d: "keydown" },
  ]);
  const j = judgeHandoffLoop(a);
  t("人引取は canAdvance=false", !j.canAdvance && !j.ok);
  t("送付後外し欠を gaps に", j.gaps.includes("送付後外し"));
}

{
  const a = atomsFromAuditSteps([
    { k: "leftover_clean", d: "ok" },
    { k: "flow_done_ready_next", d: "次" },
  ]);
  const j = judgeHandoffLoop(a);
  t("post_send無しは ok=false", !j.ok && j.gaps.includes("送付後外し"));
}

{
  const a = atomsFromAuditSteps([{ k: "leftover_scan", d: "前客あり→外し" }]);
  t("leftover_scan も前客外し原子", !!a.leftover_clean);
}

{
  const fine = fineAtomsFromAuditSteps([
    { k: "flow_done_switch", d: "ok" },
    { k: "leftover_clean", d: "ok" },
    { k: "post_send_clear", d: "ok" },
    { k: "handoff_atom_ready", d: "ok" },
  ]);
  t("細原子 switch", !!fine.switch);
  t("細原子 place_clear", !!fine.place_clear);
  t("細原子 post_send", !!fine.post_send_clear);
  t("細原子 ready", !!fine.ready_next);
  t("細原子 search 欠", !fine.search);
}

{
  const plan = planHandoffStrengthen([
    { k: "leftover_clean", d: "ok" },
    { k: "flow_done_switch", d: "ok" },
  ]);
  t("強化計画は ok=false", !plan.ok);
  t("強化計画に post_send 次手", plan.fine_gaps.includes("post_send_clear"));
  t("無料が先頭寄り", plan.items[0]?.layer === "free" || plan.items.length === 0);
}

{
  const tallied = countFineAtomsAcrossAudits([
    { steps: [{ k: "post_send_clear", d: "ok" }, { k: "series_done", d: "ok" }] },
    { steps: [{ k: "leftover_clean", d: "ok" }] },
  ]);
  t("集計 runs=2", tallied.runs === 2);
  t("集計 post_send≥1", tallied.counts.post_send_clear >= 1);
  t("集計に弱リスト", Array.isArray(tallied.weak));
}

{
  const fine = fineAtomsFromAuditSteps([
    { k: "loop_who_grasp", d: "いま客=A 次客=B" },
    { k: "loop_advance", d: "客完了→次へ（1/3）" },
    { k: "series_done", d: "次客可" },
  ]);
  t("細原子 who_grasp", !!fine.who_grasp);
  t("細原子 loop_advance", !!fine.loop_advance);
  t("細原子 ready_next（loop_advanceでも）", !!fine.ready_next);
}

{
  const adv = formatLoopAdvance({ currentName: "山田", nextName: "佐藤", index: 2, total: 5 });
  t("formatLoopAdvance 次あり", /客完了→次へ（2\/5）/.test(adv.summary) && adv.nextMove === "前客の選択を1つずつ外す");
  const last = formatLoopAdvance({ currentName: "末", nextName: "", index: 5, total: 5 });
  t("formatLoopAdvance 末", /一括末/.test(last.summary) && last.nextMove === "一括完了");
}

console.log(`\nhandoff-loop-ledger: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
