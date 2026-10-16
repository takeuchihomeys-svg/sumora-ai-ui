// app/lib/__tests__/brain-route-keep.test.ts — 2026-10-16 方向が空の取り直しで最初の答えの道を残す
//   実行: npx tsx app/lib/__tests__/brain-route-keep.test.ts
import { mergeEmptyDirectionRetry, emptyDirectionKeepRouteEnabled } from "../brain-route-keep";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

const first = { aix: null, reply_mode: "auto_reply", reply_direction: "", turn_contract: { asks: [{ route: "reply" }] }, key_topics: [], current_property: "A 101" };
const retry = { aix: "estimate_sheet", reply_mode: "aix", reply_direction: "見積書を送る", turn_contract: { asks: [{ route: "aix" }] }, key_topics: ["見積"], current_property: "B 202", latent_intent: "費用の不安" };
const m = mergeEmptyDirectionRetry(first, retry);
t("道（aix null）は最初の答えのまま", m.aix === null && m.reply_mode === "auto_reply");
t("turn_contract も最初の答えのまま", JSON.stringify(m.turn_contract) === JSON.stringify(first.turn_contract));
t("方向は取り直しから", m.reply_direction === "見積書を送る");
t("空の欄は取り直しで埋める", JSON.stringify(m.key_topics) === JSON.stringify(["見積"]) && m.latent_intent === "費用の不安");
t("埋まっている欄は最初の答えのまま", m.current_property === "A 101");
t("既定 on・off で戻す", emptyDirectionKeepRouteEnabled({}) && !emptyDirectionKeepRouteEnabled({ BRAIN_EMPTY_DIRECTION_KEEP_ROUTE: "off" }));
console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
