// app/lib/__tests__/turn-aims-after.test.ts — 道を決めた後の目的・中期・仕込み（TURN_AIMS_AFTER）
//   実行: npx tsx app/lib/__tests__/turn-aims-after.test.ts
import { readFileSync } from "node:fs";
import { deriveTurnAimsAfter, metaWithTurnAimsAfter, turnAimsAfterOn, matchSubstateOf, substateNetV2On } from "../turn-aims-after";
import { buildHandoff, handoffNote } from "../conductor-handoff";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) pass++; else { fail++; console.error(`NG ${name}`); } };
const ON = { TURN_AIMS_AFTER: "on" };
const d = (customerText: string, route: "reply" | "aix" = "reply") => deriveTurnAimsAfter({ customerText, route, env: ON });

// 11/15 既定 on（=off で戻る）
t("既定 on・=off で止まる", turnAimsAfterOn({}) && !turnAimsAfterOn({ TURN_AIMS_AFTER: "off" }) && deriveTurnAimsAfter({ customerText: "一度検討致します。", route: "reply", env: { TURN_AIMS_AFTER: "off" } }) === null);
// 試験の実物の言葉
t("q425 内覧なしで決める迷い", d("内覧なくても大丈夫かな思ってました")?.state === "内覧なしで決める迷い");
t("q368 検討します", d("ありがとうございます。\n一度検討致します。")?.state === "検討します（保留）");
t("q198 初期費用15万くらい", d("初期費用15万くらいないですかね。")?.state === "総額が予算を超える・高い");
t("q065 最速の入居（一般の手続き）は作らない", d("ありがとうございます\n最速で入居できるとしていつくらいになりそうですか？") === null);
t("お礼だけは作らない（推測で埋めない）", d("わかりました。 ありがとうございます。") === null);
t("AIX の番は作らない（AIX の文への受け口は別）", d("内覧なくても大丈夫かな思ってました", "aix") === null);
const ta = d("内覧なくても大丈夫かな思ってました");
t("深さ・目的・仕込み（確認・約束なし）", !!ta && ta.depth === 2 && ta.turnAim.length > 0 && /1部屋のみ/.test(ta.plant) && !/確認|約束|ご連絡/.test(ta.plant));
// meta への足し方
t("ブレインの meta に turn_aims があればそのまま", metaWithTurnAimsAfter({ turn_aims: { x: 1 } }, "内覧なくても大丈夫かな", ON).turn_aims !== undefined && (metaWithTurnAimsAfter({ turn_aims: { x: 1 } }, "内覧なくても", ON).turn_aims as { x: number }).x === 1);
t("AIX の番の meta は足さない", metaWithTurnAimsAfter({ reply_mode: "aix", action: "viewing_invite" }, "内覧なくても大丈夫かな思ってました", ON).turn_aims === undefined);
const m = metaWithTurnAimsAfter({ reply_mode: "auto_reply", action: null }, "内覧なくても大丈夫かな思ってました", ON);
t("返信の番は足す・元の meta は変えない", !!m.turn_aims);
t("受け渡しに出る", handoffNote(buildHandoff({ to: "compose", meta: m })).includes("この番の目的:"));
// 配線（道を決める所には渡さない＝generate-reply の受け渡しだけ）
const route = readFileSync("app/api/generate-reply/route.ts", "utf8");
t("generate-reply の受け渡しに配線", route.includes('meta: metaWithTurnAimsAfter(brainMeta as unknown as Record<string, unknown>, customerMsgUnits.join("\\n") || (message ?? ""))'));
// 2026-11-21 作業員M（#467）: brain-core は判断が終わった後の meta の記録（apply_route・turn_aims_after）にだけ使う＝ブレインの材料・出力の欄には渡さない
{ const bc = readFileSync("app/lib/brain-core.ts", "utf8").split("\n");
  const uses = bc.filter((l) => /deriveTurnAimsAfter\(|matchSubstateOf\(|metaWithTurnAimsAfter/.test(l));
  t("brain-core には渡していない（記録の行だけ）", !bc.some((l) => l.includes("metaWithTurnAimsAfter")) && uses.length > 0 && uses.every((l) => l.includes("applyRouteLocRec ?") || l.includes("substateContextOn()") || l.includes("const subA")), uses.map((l) => l.trim().slice(0, 60))); }

// 2026-11-21 作業員M: 網の2版（ROUTE_SUBSTATE_NET_V2・既定 off）。文は伏せた形
const form = "▶︎【お部屋お探し中！】 （ご希望のお部屋探しご条件） ①【ご入居の時期】⇒10月 ②【ご希望の家賃】⇒〜11万";
t("網の2版は既定 off（1版のまま）", !substateNetV2On({}) && matchSubstateOf(form)?.id !== "hearing_many_conditions");
t("2版: 条件のフォームは条件が多い・審査の語だけでは審査の不安にしない・内覧の日時", matchSubstateOf(form, { ROUTE_SUBSTATE_NET_V2: "on" })?.id === "hearing_many_conditions" && matchSubstateOf("江坂の方よろしくお願いします 審査一旦通してもらって行けそうでしたら", { ROUTE_SUBSTATE_NET_V2: "on" })?.id === "apply_intent" && matchSubstateOf("日曜日の17時でお願いします", { ROUTE_SUBSTATE_NET_V2: "on" })?.id === "viewing_dates");
t("2版でも最短の入居は作らない（q065）", matchSubstateOf("最短でいつ頃入居できますか", { ROUTE_SUBSTATE_NET_V2: "on" }) === null);
console.log(`turn-aims-after: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
