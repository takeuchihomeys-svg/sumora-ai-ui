// app/lib/__tests__/compose-blueprint.test.ts — 文の指示役（構成のブレイン）の純関数
//   文例は竹内さんの型を作り物で写した物（実際の会話の文は入れない）
import { composeBlueprintOn, purposeOfText, tagSentence, parseComposeIntent, fallbackIntent, buildBlueprint, checkBlueprint, blueprintNote, composeDigestLine, replyRequirements, composeIntentPrompt, type ComposeIntent } from "../compose-blueprint";
let pass = 0, fail = 0;
const t = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG ${n} → ${JSON.stringify(info)}`); } };

t("既定 off・on で入る", !composeBlueprintOn({}) && composeBlueprintOn({ BRAIN_COMPOSE_BLUEPRINT: "on" }));

// 札と趣旨（数えと同じ線）
t("受け", tagSentence("かしこまりました！！") === "ack");
t("締め", tagSentence("何卒よろしくお願い致します！！") === "close");
t("約束", tagSentence("確認出来次第ご連絡させて頂きます😊！！") === "promise");
t("内覧の誘い", tagSentence("お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！") === "cta_viewing");
const p1 = purposeOfText("かしこまりました！！\nお送り頂きました物件の募集状況確認させて頂きます！！\n何卒よろしくお願い致します！！");
t("約束の通", p1.purpose === "promise" && p1.seq.join(">") === "ack>promise>close", p1);
const p2 = purposeOfText("YUMAさんお世話になっております！！\nお送りさせて頂きましたお部屋の中でも特にA棟101号室がYUMAさんにかなりオススメ出来るお部屋となります！！\nお手隙の際にご査収ください😌！！");
t("訴求の通", p2.purpose === "appeal", p2);
t("受けだけ", purposeOfText("はい😊！！\n明日何卒よろしくお願い致します！！").purpose === "ack");
t("定型", purposeOfText("・氏名\n・生年月日\n・勤務先名\n・年収").purpose === "material");

// 意図の読み取り
const it = parseComposeIntent('x {"purpose":"promise","why":"物件を送ってきた","feel":"待てる","next":"wait_check","main":{"subject":"us","what":"送って頂いた物件の募集状況を確認する"},"adds":["support","promise"],"closing":"nanitozo","confidence":"high"} y');
t("意図を読む・趣旨と同じ添えは落とす", !!it && it.purpose === "promise" && it.adds.join() === "support" && it.source === "brain", it);
t("知らない趣旨は読まない", parseComposeIntent('{"purpose":"decline"}') === null);
t("締めが外れたら趣旨の既定", parseComposeIntent('{"purpose":"ask","main":{"subject":"customer","what":"ご希望の時間"},"closing":"zzz"}')?.closing === "kigaru");

// 要件（plan の in・reply だけ／priorities の aix・later は外す）
const reqs = [
  { rank: 2, item: "全力サポート", handling: "answer_now" },
  { rank: 1, item: "送って頂いた物件の募集状況を確認する", handling: "confirm" },
  { rank: 3, item: "内覧の日程", handling: "aix" },
  { rank: 4, item: "審査の相談", who: "phone", include: "split" },
];
const rr = replyRequirements(reqs);
t("返信の要件だけ・順", rr.map((r) => r.rank).join() === "1,2", rr);
t("既定の意図＝1番が確認なら約束", fallbackIntent(reqs).purpose === "promise" && fallbackIntent([]).purpose === "ack");
t("指示に要件と型が入る", /1\. 送って頂いた物件/.test(composeIntentPrompt({ customerText: "これ空いてますか", scene: "property_share", requirements: reqs })) && /受け→約束/.test(composeIntentPrompt({ customerText: "", scene: "x", requirements: [] })));

// 設計図
const bp = buildBlueprint({ intent: it as ComposeIntent, requirements: reqs, nets: { main: ["18時以降は明日一番で確認"] } });
t("設計図の並び（受け→メイン→添え→締め）", bp.parts.map((p) => p.role).join(">") === "uke>main>add>close" && bp.parts[2].say === "全力サポート", bp.parts);
t("網はメインの部品の中だけ", bp.parts.find((p) => p.role === "main")?.nets?.[0] === "18時以降は明日一番で確認");
t("確かめ OK", bp.check.mainOnPurpose && bp.check.addsNotEatingMain, bp.check);
t("注記に設計図", /文の設計図/.test(blueprintNote(bp)) && /メインの1文: 送って頂いた物件/.test(blueprintNote(bp)));
const bad = checkBlueprint({ intent: { ...(it as ComposeIntent), main: { subject: "property", what: "こちらのお部屋オススメです" } }, parts: [{ role: "add", say: "全力サポート", from: "form" }, { role: "main", say: "こちらのお部屋オススメです", from: "decision" }] });
t("趣旨から外れたメイン・前にある添えを拾う", !bad.mainOnPurpose && !bad.addsNotEatingMain, bad);
const ackBp = buildBlueprint({ intent: fallbackIntent([]), requirements: [] });
t("受けだけ＝中身の部品なし", ackBp.parts.every((p) => p.role !== "main" && p.role !== "add") && ackBp.check.mainOnPurpose, ackBp.parts);

// digest
const line = composeDigestLine({ intent: it, blueprint: bp, writerGotNote: true, draft: "かしこまりました！！\n募集状況確認させて頂きます！！\n何卒よろしくお願い致します！！" });
t("digest に届いたか・出た文の趣旨", /書き手に届いた=yes/.test(line) && /出た文の趣旨=promise（合う）/.test(line), line);
t("意図なしの digest", /意図なし/.test(composeDigestLine({ intent: null, blueprint: null, writerGotNote: false })));

console.log(`compose-blueprint: ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
