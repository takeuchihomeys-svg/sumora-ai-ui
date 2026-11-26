// app/lib/__tests__/aix-dictionary.test.ts — AIX の辞書の残り（前提・竹内さん本人の手本）（2026-11-26 作業員A・#688）
//   実行: npx tsx app/lib/__tests__/aix-dictionary.test.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIX_DICTIONARY, DICT_GAPS, aixDictionaryLine, aixDictionaryLineOn } from "../aix-dictionary";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
t("60日で送った上位10種類に前提がある", ["property_recommendation", "property_check_result", "property_send", "viewing_invite", "estimate_sheet", "meeting_place", "greeting_viewing", "application_push", "phone_call", "condition_hearing"].every((k) => !!AIX_DICTIONARY[k]?.premise));
t("手本は本文でなく要約（お名前・物件名・URL を入れない）", Object.values(AIX_DICTIONARY).flatMap((e) => e.examples).every((x) => !/https?:|さん[\s「]|号室/.test(`${x.customer}${x.takeuchi}`)));
t("手本がまだ無い種類の一覧", DICT_GAPS.includes("meeting_place") && !DICT_GAPS.includes("estimate_sheet"));
t("1行: 候補の AIX だけ・2つまで・手本つき", (() => { const l = aixDictionaryLine(["property_check_result", "estimate_sheet", "viewing_invite"]); return l.includes("property_check_result: 前提") && l.includes("estimate_sheet") && !l.includes("viewing_invite") && l.includes("手本"); })());
t("1行: 子の種類（/ 付き）も親で引く・知らない種類は空", aixDictionaryLine(["property_check_result/unavailable"]).includes("property_check_result") && aixDictionaryLine(["unknown"]) === "");
t("既定 off", !aixDictionaryLineOn({}) && aixDictionaryLineOn({ AIX_DICTIONARY_LINE: "on" }));
const bc = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8");
t("配線: on の時だけ・控えの行に登録", bc.includes("ad.aixDictionaryLineOn() && ar.loc?.next?.aix?.length") && bc.includes('key: "aix_dictionary"') && bc.includes("materialMarks.aix_dictionary"));
console.log(`aix-dictionary: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
