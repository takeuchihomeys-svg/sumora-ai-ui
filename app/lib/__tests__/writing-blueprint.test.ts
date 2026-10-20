// app/lib/__tests__/writing-blueprint.test.ts — 文の設計図（実行: npx tsx app/lib/__tests__/writing-blueprint.test.ts）
//   文は作った例（実際のお客様の文は使わない）。LLM なし
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  partsOf, classifySentence, splitSentences, orderInversions, BASE_ORDER, checkDraftAgainstBlueprint, buildWritingBlueprintNote,
  writingBlueprintEnabled, writingBlueprintNoteIfEnabled, resolveBlueprint, questionsOf, questionOrderInversions, WRITING_BLUEPRINTS, BLUEPRINT_NOTE_MAX,
} from "../writing-blueprint";
import type { ReplyScene } from "../reply-scene";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };
const types = (d: string, f: Parameters<typeof checkDraftAgainstBlueprint>[1]) => checkDraftAgainstBlueprint(d, f).breaks.map((b) => b.type);

// ── 文に分ける・段に分ける ──
t("！！で文に分ける", splitSentences("かしこまりました😊！！確認させて頂きます！！").length === 2);
t("受け", classifySentence("かしこまりました！！") === "ack");
t("はい😊も受け", classifySentence("はい😊！！") === "ack");
t("約束", classifySentence("募集状況確認させて頂きます！！") === "promise");
t("済んだ事は約束ではない", classifySentence("御見積書お送りさせて頂きました！！") !== "promise");
t("締め", classifySentence("何卒よろしくお願い致します😌！！") === "closing");
t("ご査収くださいは締め", classifySentence("お手隙の際にご査収ください😌！！") === "closing");
t("支える一言", classifySentence("気になる点ございましたらお気軽にご連絡ください！！") === "support");
t("誘い", classifySentence("お気に召されましたらご内覧可能です！！") === "invite");
t("挨拶", classifySentence("お世話になっております！！") === "greeting");
t("答え", classifySentence("ペット飼育可能なお部屋となります！！") === "answer");
const p1 = partsOf("テストさん\nお世話になっております！！\n\nかしこまりました！！\nこちらのお部屋は駐車場ございます！！\n募集状況確認させて頂きます！！\n何卒よろしくお願い致します！！");
t("並び: 名前→挨拶→受け→答え→約束→締め", p1.parts.join(",") === "name,greeting,ack,answer,promise,closing");
t("同じ段の連続は1つ", partsOf("かしこまりました！！承知しました！！").parts.join(",") === "ack");

// ── 並びの逆 ──
t("基本の並びに沿えば逆なし", orderInversions(["ack", "answer", "promise", "closing"], BASE_ORDER).length === 0);
t("締めの後の答えは逆", orderInversions(["ack", "closing", "answer"], BASE_ORDER).some(([a, b]) => a === "closing" && b === "answer"));
t("同じ段が離れて2回は数えない", orderInversions(["answer", "promise", "answer"], BASE_ORDER).length === 1);

// ── 確かめる ──
t("かしこまりましたが2回", types("かしこまりました😊！！かしこまりました😊！！確認させて頂きます！！", { scene: "conditions" }).includes("dup_ack"));
t("挨拶の行に受け", types("テストさんお世話になっております！！かしこまりました！！\n\n探させて頂きます！！", { scene: "conditions" }).includes("ack_on_greeting"));
t("説明口調の受け止め", types("お悩みのご状況しっかり受け止めさせて頂きました。", { scene: "other" }).includes("explain_empathy"));
t("送っていない番のご査収", types("御見積書を作成しお送りさせて頂きます！！お手隙の際にご査収ください😌！！", { scene: "cost", sentThisTurn: false }).includes("kasa_not_sent"));
t("送った番のご査収は外れではない", !types("御見積書となります！！お手隙の際にご査収ください😌！！", { scene: "cost", sentThisTurn: true }).includes("kasa_not_sent"));
t("資料に記載が無い旨", types("資料に記載がございませんでした！！確認させて頂きます！！", { scene: "question" }).includes("material_missing"));
// 10/21 竹内さん A4: 約束だけの返信は「答え」を満たす（BLUEPRINT_PROMISE_AS_ANSWER=off で旧）
t("A4: 約束だけの番は答えが無いに数えない", !types("かしこまりました！！確認させて頂きます！！", { scene: "question" }).includes("missing_required"));
{ const prev = process.env.BLUEPRINT_PROMISE_AS_ANSWER; process.env.BLUEPRINT_PROMISE_AS_ANSWER = "off";
  t("質問の番に答えが無い（off で旧）", types("かしこまりました！！確認させて頂きます！！", { scene: "question" }).includes("missing_required"));
  if (prev === undefined) delete process.env.BLUEPRINT_PROMISE_AS_ANSWER; else process.env.BLUEPRINT_PROMISE_AS_ANSWER = prev; }
t("約束も答えも無い番は答えが無い", types("かしこまりました！！", { scene: "question" }).includes("missing_required"));
t("質問の番に答えがあれば要る段はそろう", !types("駐車場ございます！！", { scene: "question" }).includes("missing_required"));
t("条件の番の誘いは書かない段", types("かしこまりました！！ピックアップしてお送りさせて頂きます！！ご内覧可能です！！", { scene: "conditions" }).includes("forbidden_part"));
t("短い了承の長すぎ", types("はい！！ありがとうございます！！駐車場あります！！確認します！！お気軽に！！何卒よろしくお願い致します！！", { scene: "ack" }).includes("too_long"));
t("締めが2回", types("よろしくお願い致します！！何卒よろしくお願い致します！！", { scene: "other" }).includes("dup_closing"));
t("きれいな下書きは外れなし", types("かしこまりました！！\n募集状況確認させて頂きます！！\n何卒よろしくお願い致します！！", { scene: "property_share", sentThisTurn: false }).filter((x) => x !== "missing_required").length === 0);

// ── 質問の順 ──
const qs = questionsOf("ペットは飼えますか？あと駐車場はありますか？");
t("質問を書いた順に拾う", qs.length === 2 && /ペット/.test(qs[0]));
t("同じ順に答えれば逆なし", questionOrderInversions(qs, "ペット飼育可能です！！駐車場もございます！！").inversions === 0);
t("逆の順は外れ", types("駐車場ございます！！ペット飼育可能です！！", { scene: "question", questions: qs }).includes("question_order"));

// ── 他社で内覧（分かれ道）──
const bpO = resolveBlueprint({ scene: "viewing", routeBranch: "other_agent_viewing" });
t("他社で内覧は誘いが要る段", bpO.required.includes("invite") && bpO.must.length === 3);
t("他社で内覧で誘いが無いと外れ", types("大丈夫です😊！！弊社でお申込可能です！！", { scene: "viewing", routeBranch: "other_agent_viewing" }).includes("missing_required"));
t("他社で内覧・3つそろえば要る段そろう", !types("大丈夫です😊！！\nよろしければ弊社にてご内見可能です！！\nご挨拶も兼ねまして一度ご内見頂ければご安心してお任せ頂けると思います！！", { scene: "viewing", routeBranch: "other_agent_viewing" }).includes("missing_required"));
t("知らない分かれ道は場面のまま", resolveBlueprint({ scene: "question", routeBranch: "nope" }).key === "question");
t("断りは誘い・約束を書かない", resolveBlueprint({ scene: "considering", routeBranch: "declined" }).forbidden.includes("invite"));

// ── 指示の文（選ぶ）──
const scenes: ReplyScene[] = ["ack", "considering", "question", "conditions", "property_share", "cost", "viewing", "apply", "other"];
t("全部の場面に設計図", scenes.every((s) => !!WRITING_BLUEPRINTS[s] && WRITING_BLUEPRINTS[s].order.length === 9));
const longQs = ["とても長い質問の文その1ですがどうでしょうか？", "とても長い質問の文その2ですがどうでしょうか？", "とても長い質問の文その3？", "その4？", "その5？"];
const allNotes = scenes.flatMap((s) => [false, true].map((b) => buildWritingBlueprintNote({ scene: s, questions: longQs, sentThisTurn: b, promiseOutstanding: b, routeBranch: b ? "other_agent_viewing" : null })));
t(`指示は${BLUEPRINT_NOTE_MAX}字以内`, allNotes.every((n) => n.length <= BLUEPRINT_NOTE_MAX));
const n1 = buildWritingBlueprintNote({ scene: "question", questions: qs, sentThisTurn: false });
t("指示に質問の順", /聞かれた順/.test(n1) && n1.indexOf("1.") < n1.indexOf("2."));
t("送っていない番はご査収を書かない指示", /ご査収/.test(n1));
t("送った番はご査収の行を出さない", !/ご査収」は書かない/.test(buildWritingBlueprintNote({ scene: "cost", sentThisTurn: true })));
t("他社で内覧の必ず3つ", (buildWritingBlueprintNote({ scene: "viewing", routeBranch: "other_agent_viewing" }).match(/必ず:/g) ?? []).length === 3);

// ── 切り替え（既定 off＝指示は1文字も変わらない）──
t("既定 off", !writingBlueprintEnabled({}));
t("on の時だけ on", writingBlueprintEnabled({ WRITING_BLUEPRINT: "on" }) && !writingBlueprintEnabled({ WRITING_BLUEPRINT: "off" }) && !writingBlueprintEnabled({ WRITING_BLUEPRINT: "1" }));
t("off の時は空文字", writingBlueprintNoteIfEnabled({ scene: "question", questions: qs }, {}) === "");
t("on の時は文", writingBlueprintNoteIfEnabled({ scene: "question" }, { WRITING_BLUEPRINT: "on" }).startsWith("\n\n【🧩 文の設計図"));
// 返信の指示に入る所は「off の時は空文字」の1か所だけ（キャッシュする側には入れない）
const route = readFileSync(join(__dirname, "../../api/generate-reply/route.ts"), "utf8");
t("route: 差し込みは毎回変わる側の1か所", (route.match(/sceneSel\?\.blueprintNote/g) ?? []).length === 1 && /\$\{sceneStyleNoteText\}\$\{sceneSel\?\.blueprintNote \?\? ""\}/.test(route));
t("route: off の時は空文字を渡す（on でも投げたら空文字）", /blueprintNote: !isTemplateOptimize && writingBlueprintEnabled\(\) \? \(\(\) => \{ try \{ return buildWritingBlueprintNote\([\s\S]{0,700}?catch[\s\S]{0,120}?return ""; \} \}\)\(\) : ""/.test(route));
t("route: 差し込みは dynamicBlock の中", (() => { const a = route.indexOf("const dynamicBlock ="); const b = route.indexOf("sceneSel?.blueprintNote"); const c = route.indexOf("const priorityOrderNote", a); return a > 0 && b > a && b < c; })());

console.log(`\nwriting-blueprint: ${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
