// 最終チェックの4つ目の段: 設計図の行に当たらない文に印（2026-11-13 作業員9・統括役 S9・FC_BLUEPRINT_MARK・実物の文）
// 実行: npx tsx app/lib/__tests__/final-check-blueprint-match.test.ts
import { summarizeMaterialLog } from "../line-watch-materials";
import { markUnmatchedSentences, fcBlueprintMarkOn, blueprintMarkLog, blueprintEmbedLog, conditionTokensForMark, type BlueprintRowLike } from "../final-check-blueprint-match";
import { readFileSync } from "node:fs";
import { join } from "node:path";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra: unknown = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, JSON.stringify(extra)); } };
t("既定 off", !fcBlueprintMarkOn({}));
t("設計図が無い番は何も言わない", markUnmatchedSentences("はい😊！！", null) === null && markUnmatchedSentences("はい😊！！", []) === null);

// 12164（11/07・名前は伏せた）: 竹内さんは「ご査収頂きありがとうございます／お気に召して頂けたようで何よりです／お申込みしお部屋押さえさせて頂きます」
const rows12164: BlueprintRowLike[] = [
  { role: "head", sub: "arigato" },
  { role: "press", sub: "conclusion", uses: [{ field: "fact.value", value: "長居東のお部屋お気に召して頂けたようで" }] },
  { role: "bridge", sub: "apply" },
];
const d12164 = "〇〇さんお世話になっております！！\nはい😊！！\n長居東のお部屋お気に召して頂けたようで何よりです！！\nこちらは現在建設中のため、ご内覧は入居日が近づいてからとなります！！\nお気に召されましたらお申込みでお部屋を先に押さえさせて頂きます😌！！";
const m1 = markUnmatchedSentences(d12164, rows12164) ?? [];
t("12164: 資料の事実の付け足し（建設中のため…）だけに印", m1.length === 1 && /建設中/.test(m1[0].sentence) && m1[0].kind === "fact_addition", m1);
const s12164 = "〇〇さんお世話になっております！！\nご査収頂きありがとうございます😊！！\n長居東のお部屋お気に召して頂けたようで何よりです！！\nお気に召されましたらお申込みしお部屋押さえさせて頂きます😌！！";
t("12164: 竹内さんの送信には印が付かない", (markUnmatchedSentences(s12164, rows12164) ?? []).length === 0, markUnmatchedSentences(s12164, rows12164));

// 12196（11/08）: 竹内さんは条件の変わった点だけ「家賃管理費込み12万円以内」
const rows12196: BlueprintRowLike[] = [
  { role: "head", sub: "kashikomari" },
  { role: "press", sub: "conclusion", uses: [{ field: "fact.value", value: "対象から外させて頂きます" }] },
  { role: "press", sub: "numbers", uses: [{ field: "aim.mid", value: "12万円以内" }] },
  { role: "close", sub: "fixed" },
];
const cond = ["大阪市西区", "南堀江", "8万", "12万", "1LDK", "36㎡", "築15年", "徒歩15分"];
const d12196 = "かしこまりました！！\nプレサンス立売堀アーバンスタイルは対象から外させて頂きます。\n大阪市西区(南堀江近い)周辺全域から家賃管理費込み8万〜12万・1LDK・36㎡以上・築15年以内・駅徒歩15分以内で、白基調やリフォーム済みの綺麗なお部屋をピックアップしてお送りさせて頂きます😊！！\n何卒よろしくお願い致します！！";
const m2 = markUnmatchedSentences(d12196, rows12196, { conditionTokens: cond }) ?? [];
t("12196: 前の条件の全部の繰り返しに印（condition_repeat）", m2.length === 1 && m2[0].kind === "condition_repeat", m2);
const s12196 = "〇〇さんお世話になっております！！\nかしこまりました！！\nプレサンス立売堀アーバンスタイルは対象から外させて頂きます。\n大阪市西区(南堀江近い)周辺全域から家賃管理費込み12万円以内で、〇〇さんにオススメ出来るお部屋をピックアップしてお送りさせて頂きます😊！！\n何卒よろしくお願い致します！！";
t("12196: 竹内さんの送信（変わった点だけ）は印なし", (markUnmatchedSentences(s12196, rows12196, { conditionTokens: cond }) ?? []).length === 0, markUnmatchedSentences(s12196, rows12196, { conditionTokens: cond }));

// 12348（11/08）: 潜在の材料が無い番（作業員10 は潜在の行を立てない）
const rows12348: BlueprintRowLike[] = [
  { role: "head", sub: "arigato" },
  { role: "press", sub: "split_known_check", uses: [{ field: "fact.value", value: "プレジオ永和" }] },
  { role: "close", sub: "fixed" },
];
const d12348 = "〇〇さん、ご連絡ありがとうございます！！\nお送り頂きましたプレジオ永和の募集状況と保証会社の情報、確認させて頂きます！！\n確認出来次第ご連絡させて頂きます！！\n\n彼氏名義で審査が通らなかったご事情も承知しております！！〇〇さんの場合は、審査に通りやすい保証会社を中心にサポートさせて頂きますので、一緒に進めていきましょう😌！！";
const m3 = markUnmatchedSentences(d12348, rows12348) ?? [];
t("12348: 材料の無い潜在の文（一緒に進めていきましょう）に印", m3.some((m) => m.kind === "latent_no_material" && /一緒に/.test(m.sentence)), m3);

// 対象の取り違え: 設計図の行の物件と違う物件を書いた
const rowsObj: BlueprintRowLike[] = [{ role: "head" }, { role: "press", uses: [{ field: "hook.property", value: "ラパンジール長堀" }] }];
const dObj = "かしこまりました！！\nアーバネックス本町Ⅱ 現在901号室のみ募集中となります！！";
const m4 = markUnmatchedSentences(dObj, rowsObj, { propertyNames: ["アーバネックス本町Ⅱ", "ラパンジール長堀"] }) ?? [];
t("対象の取り違え: 行に無い物件名の文に印（object_mismatch）", m4.length === 1 && m4[0].kind === "object_mismatch", m4);
const log = blueprintMarkLog("c1", m1, rows12164.length);
t("ログの形（見張りの materials に入る1行）", log.tag === "fc:blueprint-unmatched" && log.n === 1 && Array.isArray(log.kinds));
// 条件の文から数える語（12196 の登録の形を伏せた物）
const toks = conditionTokensForMark("エリア: 大阪市西区・南堀江近く／家賃: 8万〜12万円（管理費込み）／間取り: 1LDK／広さ: 36㎡以上／築15年以内／駅徒歩15分以内");
t("条件の語を取る（家賃・間取り・広さ・築年・徒歩・区）", ["12万円", "1LDK", "36m2", "築15年", "徒歩15分"].every((x) => toks.includes(x)) && toks.some((x) => /西区/.test(x)), toks);
// 配線: route が既定 off のスイッチの中で、行がある時だけ印のログを見張りに出す
const route = readFileSync(join(__dirname, "..", "..", "api", "generate-reply", "route.ts"), "utf8");
t("配線: fcBlueprintMarkOn() と rowsV2 がある時だけ・logWatchMaterial で出す", /if \(fcBlueprintMarkOn\(\) && composeSentencePlan\?\.rowsV2\?\.length\)/.test(route) && /logWatchMaterial\(JSON\.stringify\(blueprintMarkLog\(/.test(route));
const sm = summarizeMaterialLog(log);
t("見張りの materials.reply.blueprint に入る", sm?.source === "reply" && sm?.key === "blueprint" && (sm?.summary as { n?: number }).n === 1, sm);
// 2026-11-13 作業員10（統括役）: 信頼の添え（設計図の行の embeds）が下書きに出たかを同じ1行に足す
const rowsEmb = [{ role: "head" }, { role: "press", embeds: [{ kind: "effort", share: 0.8 }, { kind: "deadline", share: 0.75 }] }, { role: "bridge", embeds: [{ kind: "flexible", share: 0.4 }] }];
const dEmb = "かしこまりました！！\n管理会社に募集状況確認させて頂きます！！\nご都合よろしいお日にちにご案内させて頂きます😌！！";
const emb = blueprintEmbedLog(dEmb, rowsEmb);
t("添えの数え: 手間・都合は出た・期日は出ていない（印 trust_embed_deadline）", emb.embeds === 3 && emb.embeds_shown === 2 && emb.embeds_missing.join() === "trust_embed_deadline", emb);
const logE = blueprintMarkLog("c1", [], rowsEmb.length, emb);
t("ログの1行に添えの欄が入る", logE.embeds === 3 && logE.embeds_shown === 2 && Array.isArray(logE.embeds_missing));
t("添えを渡さない時は今までの形のまま", !("embeds" in blueprintMarkLog("c1", [], 1)));
const smE = summarizeMaterialLog(logE)?.summary as { embeds?: number | null; embeds_missing?: string[] } | undefined;
t("見張りの materials にも添えが入る", smE?.embeds === 3 && smE?.embeds_missing?.[0] === "trust_embed_deadline", smE);
t("配線: route が blueprintEmbedLog を blueprintMarkLog の4つ目に渡す", /blueprintMarkLog\(conversationId, marks, composeSentencePlan\.rowsV2\.length, blueprintEmbedLog\(finalDraftText/.test(route));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
