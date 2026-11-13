// やり直しの輪（2026-11-13 作業員5・FC_BLUEPRINT_REDO=shadow・既定 off）: 印を統括に戻して1回だけ書き直す
// 実行: npx tsx app/lib/__tests__/blueprint-redo.test.ts
import { blueprintRedoMode, conductorRedoPlan, blueprintRedoLog } from "../blueprint-redo";
import { markUnmatchedSentences, type BlueprintRowLike } from "../final-check-blueprint-match";
import { summarizeMaterialLog } from "../line-watch-materials";
import { readFileSync } from "node:fs";
import { join } from "node:path";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, JSON.stringify(extra)); } };

t("既定 off・shadow の時だけ（on は受けない）", blueprintRedoMode({}) === "off" && blueprintRedoMode({ FC_BLUEPRINT_REDO: " Shadow " }) === "shadow" && blueprintRedoMode({ FC_BLUEPRINT_REDO: "on" }) === "off");
t("印が無い・やり直し済みの番は null（1回だけ）", conductorRedoPlan(null) === null && conductorRedoPlan([]) === null
  && conductorRedoPlan([{ sentence: "x", part: "answer", kind: "fact_addition" }], { redone: true }) === null);
t("other だけの番はやり直さない", conductorRedoPlan([{ sentence: "よろしくお願いします", part: "support", kind: "other" }]) === null);

// 12164（名前は伏せた）: 資料の事実の付け足し → 統括の一手は「消す」
const rows12164: BlueprintRowLike[] = [
  { role: "head", sub: "arigato" },
  { role: "press", sub: "conclusion", uses: [{ field: "fact.value", value: "長居東のお部屋お気に召して頂けたようで" }] },
  { role: "bridge", sub: "apply" },
];
const d12164 = "〇〇さんお世話になっております！！\nはい😊！！\n長居東のお部屋お気に召して頂けたようで何よりです！！\nこちらは現在建設中のため、ご内覧は入居日が近づいてからとなります！！\nお申込みしお部屋押さえさせて頂きます！！";
const m1 = markUnmatchedSentences(d12164, rows12164) ?? [];
const p1 = conductorRedoPlan(m1);
t("12164: 一手は drop・証拠は印の文・重点が無い時は先頭に何も付けない", !!p1 && p1.steps.join() === "drop" && /建設中/.test(p1.issues[0].evidence) && p1.issues[0].suggestion.startsWith("この文を消す") && p1.focus === null, p1);

// 重点がある時は統括の重点に沿って直す
const p2 = conductorRedoPlan([{ sentence: "大阪市西区から8万〜12万・1LDK・36㎡以上で探します", part: "answer", kind: "condition_repeat" }, { sentence: "一緒に進めていきましょう😌！！", part: "support", kind: "latent_no_material" }, { sentence: "x", part: "support", kind: "other" }],
  { focus: { focus: "変わった条件だけ受ける" } });
t("一手は印の順・other は入れない・重点が先頭に", !!p2 && p2.steps.join() === "narrow_conditions,drop" && p2.issues.every((i) => i.suggestion.startsWith("統括の重点「変わった条件だけ受ける」に沿って直す。")) && p2.issues[0].code === "BLUEPRINT_REDO_NARROW_CONDITIONS", p2);
const p3 = conductorRedoPlan([{ sentence: "アーバネックス本町Ⅱ 現在901号室のみ募集中となります！！", part: "answer", kind: "object_mismatch" }]);
t("対象の取り違えは fix_object", p3?.steps.join() === "fix_object" && p3.issues[0].severity === "warning" && p3.issues[0].pass === "rule_check", p3);

// 前と後の記録（shadow）
const after = "〇〇さんお世話になっております！！\nはい😊！！\n長居東のお部屋お気に召して頂けたようで何よりです！！\nお申込みしお部屋押さえさせて頂きます！！";
const marksAfter = markUnmatchedSentences(after, rows12164) ?? [];
const log = blueprintRedoLog("c1", p1!, d12164, after, marksAfter);
t("記録: 前1→後0・書き直した・字数", log.tag === "fc:blueprint-redo" && log.mode === "shadow" && log.n_before === 1 && log.n_after === 0 && log.revised === true && (log.len_after as number) < (log.len_before as number), log);
const logNone = blueprintRedoLog("c1", p1!, d12164, null, null);
t("書き直しが返らない時は revised=false・n_after=null", logNone.revised === false && logNone.n_after === null && logNone.len_after === null, logNone);
const sm = summarizeMaterialLog(log);
t("見張りの materials.reply.blueprintRedo に入る", sm?.source === "reply" && sm?.key === "blueprintRedo" && (sm?.summary as { n_after?: number }).n_after === 0, sm);

// 配線: 印の段の中・shadow の時だけ・after で書き直しの口（runGroundedRevision）を1回だけ・下書きは変えない
const route = readFileSync(join(__dirname, "..", "..", "api", "generate-reply", "route.ts"), "utf8");
const seg = route.slice(route.indexOf("if (fcBlueprintMarkOn() && composeSentencePlan?.rowsV2?.length)"), route.indexOf("if (fcBlueprintMarkOn() && composeSentencePlan?.rowsV2?.length)") + 3000);
t("配線: shadow の時だけ conductorRedoPlan → after の中で runGroundedRevision 1回 → blueprintRedoLog", /blueprintRedoMode\(\) === "shadow" \? conductorRedoPlan\(/.test(seg) && /after\(async \(\) => \{\s*const revised = await runGroundedRevision\(/.test(seg) && (seg.match(/runGroundedRevision\(/g) ?? []).length === 1 && /blueprintRedoLog\(/.test(seg));
t("配線: 書き直した文を下書きに入れない（finalDraftText に代入しない）", !/finalDraftText\s*=\s*revised/.test(seg));
t("配線: 最終チェックの文脈を持ち出す", /fcCtxForBlueprintRedo = finalCheckCtx;/.test(route));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
