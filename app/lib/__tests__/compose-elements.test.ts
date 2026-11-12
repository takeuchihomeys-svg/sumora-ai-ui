// npx tsx app/lib/__tests__/compose-elements.test.ts — 文の要素の型（2026-11-12 作業員23・KB 2301dbf1）
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bridgeKindOf, connectiveOf, pressKeysOf, plantFactsOf, positionOf, buildComposeElements, composeElementsNote, composeElementsOn, type ElemTurn } from "../compose-elements";
import { composeElementsNoteFor } from "../compose-elements-server";
import { skeletonize } from "../sentence-pattern-catalog";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; void name; };

t("つなぎの種類", () => {
  assert.equal(bridgeKindOf({ text: "空いております!!", role: "answer" }, { text: "ご内覧させて頂きます!!", role: "viewing" }), "answer_to_next");
  assert.equal(bridgeKindOf({ text: "申込が入ってしまいました!!", role: "answer" }, { text: "似たお部屋をピックアップします!!", role: "keep" }), "bad_to_alt");
  assert.equal(bridgeKindOf({ text: "かしこまりました!!", role: "uke" }, { text: "確認します", role: "promise" }), "uke_to_main");
  assert.equal(bridgeKindOf({ text: "全力でサポート", role: "trust" }, { text: "何卒", role: "close" }), null, "締めへは数えない");
  assert.equal(bridgeKindOf({ text: "a", role: "answer" }, { text: "b", role: "answer" }), null, "同じ役目は数えない");
});
t("つなぎの言い方", () => {
  assert.equal(connectiveOf("その為お早めに", "x"), "その為・ですので");
  assert.equal(connectiveOf("お気に召されましたらお申込", "x"), "お気に召されましたら・もし");
  assert.equal(connectiveOf("ご案内させて頂きます", "1部屋のみの募集となりますので"), "前の文を「〜ので」で受ける");
  assert.equal(connectiveOf("ご案内させて頂きます", "空いております!!"), "言い切りで続ける");
});
t("押さえる要点・事実・置き場所", () => {
  const tu: ElemTurn = { id: "a", scene: "apply", lead: "apply", latent: "screening", sentences: [{ text: "審査も通りやすい保証会社です", role: "barrier" }], trustHow: [], push: null, trigger: null, latentFact: null };
  assert.deepEqual(pressKeysOf(tu), ["hold_before_taken", "screening_path"]);
  assert.deepEqual(plantFactsOf("1部屋のみの募集となりますのでお申込しお部屋抑えさせて頂きます"), ["one_room_only", "hold_by_apply"]);
  assert.equal(positionOf(0, 4), "頭"); assert.equal(positionOf(3, 4), "終わり"); assert.equal(positionOf(2, 4), "中");
});
t("骨: 人でない「さん・様」は名前にしない・英字の建物名・伏せ字の崩れ", () => {
  assert.ok(skeletonize("一般的な不動産屋さんよりお安く").skeleton.includes("不動産屋さん"));
  assert.ok(skeletonize("オーナー様からの広告料").skeleton.includes("オーナー様"));
  assert.ok(!skeletonize("Leaf Maison大物は初期費用も抑えられます").skeleton.includes("Leaf"));
  assert.ok(skeletonize("LINEでご連絡ください").skeleton.includes("LINE"), "LINE は建物名にしない");
  assert.ok(skeletonize("一般的な不お客様より").skeleton.includes("{不明}"));
});

const mk = (id: string, o: Partial<ElemTurn> = {}): ElemTurn => ({ id, scene: "apply", lead: "apply", latent: "find", trustHow: ["support"], push: { push: true, strength: "strong" }, trigger: "customer_words", latentFact: null, sentences: [
  { text: "かしこまりました!!", role: "uke", why: "受ける" },
  { text: "空いております!!", role: "answer", why: "答える" },
  { text: "1部屋のみの募集となりますのでお申込しお部屋抑えさせて頂きます!!", role: "apply", why: "取られる前に" },
  { text: `${id}独自のサポートの言い方です!!`, role: "trust", why: "安心" },
  { text: "何卒よろしくお願い致します!!", role: "close" },
], ...o });

t("型: 過半数かつ5通以上だけ・信頼の言い回しが散れば型にしない・言わない型は数で", () => {
  const ce = buildComposeElements(["A", "B", "C", "D", "E"].map((x) => mk(x)), { latentSay: ["find"], now: "x" });
  const b = ce.types.find((x) => x.element === "bridge" && x.key === "answer_to_next")!;
  assert.equal(b.n, 5); assert.equal(b.fixed, true);
  const p = ce.types.find((x) => x.element === "press" && x.key === "hold_before_taken")!;
  assert.equal(p.fixed, true); assert.equal(p.forms[0].form, "1部屋のみの募集");
  const tr = ce.types.find((x) => x.element === "trust" && x.key === "support")!;
  assert.equal(tr.fixed, false, "5通とも違う言い回し");
  const few = buildComposeElements(["A", "B", "C"].map((x) => mk(x)), { latentSay: ["find"] });
  assert.equal(few.types.find((x) => x.element === "bridge" && x.key === "answer_to_next")!.fixed, false, "5通未満は型にしない");
  assert.ok(ce.latentNo.some((x) => x.latent === "taken"), "言わない型は理由つきで残す");
  // 実物1通（骨）は表（倉庫の外の JSON・md）にだけ置く。書き手への口には出さない
  assert.ok(!(composeElementsNote(ce, { lead: "apply", latent: "find", trust: ["support"] }, { COMPOSE_ELEMENTS: "on" }) ?? "").includes("独自"), "口に実物の文を出さない");
});
t("口: off が既定・型になった物だけ・ファイルが無い／壊れていれば null", () => {
  const ce = buildComposeElements(["A", "B", "C", "D", "E"].map((x) => mk(x)), { latentSay: ["find"] });
  assert.equal(composeElementsOn({}), false);
  assert.equal(composeElementsNote(ce, { lead: "apply", latent: "find" }, {}), null);
  const note = composeElementsNote(ce, { lead: "apply", latent: "find", trust: ["support"] }, { COMPOSE_ELEMENTS: "on" })!;
  assert.ok(note.includes("取られる前に抑える") && note.includes("つなぎ") && !note.includes("信頼（support）"), note);
  assert.ok(composeElementsNote(ce, { lead: "keep", latent: "taken" }, { COMPOSE_ELEMENTS: "on" })!.includes("書かない"));
  const dir = mkdtempSync(join(tmpdir(), "w23-ce-"));
  const good = join(dir, "g.json"); writeFileSync(good, JSON.stringify(ce));
  const bad = join(dir, "b.json"); writeFileSync(bad, "{");
  const o = { scene: "apply", customerText: "抑えたいです", meta: { reply_direction: "お申込で抑える事を勧める" } };
  assert.equal(composeElementsNoteFor(o, { COMPOSE_ELEMENTS_FILE: good }), null);
  assert.equal(composeElementsNoteFor(o, { COMPOSE_ELEMENTS: "on", COMPOSE_ELEMENTS_FILE: bad }), null);
  assert.equal(composeElementsNoteFor(o, { COMPOSE_ELEMENTS: "on" }), null);
  assert.ok(composeElementsNoteFor(o, { COMPOSE_ELEMENTS: "on", COMPOSE_ELEMENTS_FILE: good })?.note.includes("押さえ方"));
});

t("お客様の文の種類で分ける・押す強さの上限・q057 型・初回の名乗りは信頼の型にしない", () => {
  const thanks = ["A", "B", "C", "D", "E"].map((x) => mk(x, { customer: "ありがとうございます！" }));
  const ce = buildComposeElements(thanks, { latentSay: ["find"] });
  assert.ok(ce.types.find((x) => x.element === "press" && x.key === "hold_before_taken@thanks")?.fixed);
  const push = ce.types.find((x) => x.element === "push" && x.key === "*|thanks")!;
  assert.equal(push.detail["上限"][0].form, "strong");
  const note = composeElementsNote(ce, { lead: "apply", latent: "find", customerText: "ありがとうございます", scene: "apply" }, { COMPOSE_ELEMENTS: "on" })!;
  assert.ok(note.includes("お礼") && note.includes("上限"), note);
  const vac = ["A", "B", "C", "D", "E"].map((x) => mk(x, { customer: "退去予定で内見できないんですか？", sentences: [{ text: "他の方からお申込が入りますと埋まってしまいます!!", role: "worry" }] }));
  const ce2 = buildComposeElements(vac, {});
  assert.ok(ce2.types.find((x) => x.key === "taken_by_vacating")?.fixed);
  const intro = ["A", "B", "C", "D", "E"].map((x) => mk(x, { sentences: [{ text: "お部屋探しを担当させて頂きます鈴木と申します!!", role: "trust" }] }));
  assert.equal(buildComposeElements(intro, {}).types.find((x) => x.element === "trust" && x.key === "support")!.fixed, false);
});

// 手元の実物の表に名前・物件名・部屋番号が残らないか（倉庫の外・無ければ飛ばす）
const p = join(process.cwd(), "..", "..", "exam-cache", "anatomy-seven", "compose-elements.json");
if (existsSync(p)) t("実物の表: 名前・物件名・部屋番号が残らない", () => {
  const s = readFileSync(p, "utf8").normalize("NFKC").replace(/\s+/g, "");
  assert.ok(!/YUMA/.test(s));
  const raw: string[] = [];
  for (const f of ["seven-latent4.json", "seven-latent4b.json"]) { const q = join(p, "..", f); if (existsSync(q)) for (const o of JSON.parse(readFileSync(q, "utf8")) as Array<{ reads?: Array<{ part?: { property?: string | null } } | null> }>) { const v = o.reads?.[0]?.part?.property; if (v) raw.push(v); } }
  const probes = [...new Set(raw.flatMap((v) => { const x = v.normalize("NFKC"); return [x.replace(/\s+/g, ""), x.split(/\s+/)[0]]; }).filter((x) => x.length >= 3 && !/物件|URL|^[0-9]/i.test(x)))];
  assert.deepEqual(probes.filter((q) => s.includes(q)), []);
  assert.ok(!/[0-9]{3,4}号室/.test(s));
});
console.log(`compose-elements: ${n} pass`);
