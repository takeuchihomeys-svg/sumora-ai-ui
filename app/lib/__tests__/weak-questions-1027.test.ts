// app/lib/__tests__/weak-questions-1027.test.ts — 苦手な問題②（2026-10-27）の材料の直し（実行: npx tsx app/lib/__tests__/weak-questions-1027.test.ts）
//   ① 出し切りの印の強さ（EXHAUSTED_WEAK_ACCURATE）② 行き先が未定の内覧の日時（VIEWING_PLACE_UNDECIDED_LINE）③ 名義貸しの番は電話（SCREENING_PHONE_LINE）
//   実物は試験の問題 q006・q007・q008・q141・q093 の文（名前は伏せた）
import { markerStrength, searchExhausted, type ExMsg } from "../search-exhausted";
import { exhaustedConditionWeakTurnLine, exhaustedWeakKeepBrainPromise } from "../ack-exhausted-reply";
import { buildViewingFlowBrainText, EMPTY_VIEWING_FLOW, type ViewingFlow } from "../viewing-flow";
import { nameLendingTurn, screeningPhoneTurnLine } from "../screening-phone-material";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) pass++; else { fail++; console.log(`  NG  ${name}${info !== undefined ? ` → ${JSON.stringify(info)}` : ""}`); } };
const withEnv = <T>(k: string, v: string | undefined, f: () => T): T => { const old = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; try { return f(); } finally { if (old === undefined) delete process.env[k]; else process.env[k] = old; } };
const st = (text: string, at: string, aixType?: string): ExMsg => ({ sender: "staff", text, createdAt: `2026-10-0${at}`, isAix: !!aixType, aixType: aixType ?? null });
const cu = (text: string, at: string): ExMsg => ({ sender: "customer", text, createdAt: `2026-10-0${at}`, isAix: false, aixType: null });

// ① 出し切りの印の強さ
const leave = "〇〇さん重ねてのご連絡失礼致します！！ こちらのお部屋港区とご希望のご条件から離れますが、〇〇さんにオススメできるご条件のお部屋となります！！";
const noneWiden = "〇〇さんお世話になっております！！ 大阪市北区、福島区、西区から敷金礼金無しのガスコンロタイプのお部屋探させて頂きましたが、現在募集に出ておらず、エリア広げさせていただきお部屋ピックアップさせていただきました！！";
const oneProp = "〇〇さんお送り頂きました物件3件につきまして募集状況確認させて頂きましたところ、 JS Houseは募集に出ておらず、メイウール木川の2部屋は既にご契約が決まり募集に出ておりませんでした。";
const firstBundle = "〇〇さん お待たせいたしました！！ 淀川区・天六周辺全域から〇〇さんにオススメできるお部屋ピックアップさせて頂きました！！ お手隙の際にご査収ください😌！！";
t("off: 条件から離れますが は従来どおり weak/null", withEnv("EXHAUSTED_WEAK_ACCURATE", undefined, () => markerStrength(st(leave, "1T00:00:00Z"))) !== "strong");
t("on: 条件から離れますが は strong", withEnv("EXHAUSTED_WEAK_ACCURATE", "on", () => markerStrength(st(leave, "1T00:00:00Z"))) === "strong");
t("on: 探しましたが現在募集に出ておらず は strong", withEnv("EXHAUSTED_WEAK_ACCURATE", "on", () => markerStrength(st(noneWiden, "1T00:00:00Z"))) === "strong");
t("on: 持ち込み1件の「募集に出ておらず」は strong にしない", withEnv("EXHAUSTED_WEAK_ACCURATE", "on", () => markerStrength(st(oneProp, "1T00:00:00Z"))) !== "strong");
t("on: 最初の束の送付は weak のまま", withEnv("EXHAUSTED_WEAK_ACCURATE", "on", () => markerStrength(st(firstBundle, "1T00:00:00Z"))) === "weak");
{
  // q006 の形: 物件の AIX の後に「条件から離れますが」→ お客様が設備を足した
  const msgs = [st("", "1T00:00:00Z", "property_send"), st(leave, "1T00:05:00Z"), cu("ガスコンロがいいんです。", "1T01:00:00Z")];
  const r = withEnv("EXHAUSTED_WEAK_ACCURATE", "on", () => searchExhausted(msgs, { conditionChangedThisTurn: false, pickupReady: null }));
  t("on: q006 の形は strong の出し切り", r.exhausted && r.strength === "strong", r);
  const r0 = withEnv("EXHAUSTED_WEAK_ACCURATE", undefined, () => searchExhausted(msgs, { conditionChangedThisTurn: false, pickupReady: null }));
  t("off: q006 の形は weak（従来）", r0.exhausted && r0.strength === "weak", r0);
  // q008 の形: 最初の束を送っただけ → お客様の懸念
  const m8 = [st("", "1T00:00:00Z", "property_send"), st(firstBundle, "1T00:01:00Z"), cu("神崎川はすんでましたが 不便だったので汗", "1T02:00:00Z")];
  const r8 = withEnv("EXHAUSTED_WEAK_ACCURATE", "on", () => searchExhausted(m8, { conditionChangedThisTurn: false, pickupReady: null }));
  t("on: q008 の形は weak のまま", r8.exhausted && r8.strength === "weak", r8);
}
t("off: weak の番の行は従来の言い切り", withEnv("EXHAUSTED_WEAK_ACCURATE", undefined, () => exhaustedConditionWeakTurnLine({})).includes("出し切った」印がある"));
t("on: weak の番の行は「出し切ったとは言っていない」", exhaustedConditionWeakTurnLine({ EXHAUSTED_WEAK_ACCURATE: "on" }).includes("出し切ったとは言っていない"));
t("off: weak でブレインの探す約束を守らない（従来）", exhaustedWeakKeepBrainPromise({ strength: "weak", asks: [{ route: "promise", about: "search_condition" }], env: {} }) === false);
t("on: weak でブレインの探す約束を守る", exhaustedWeakKeepBrainPromise({ strength: "weak", asks: [{ route: "promise", about: "search_condition" }], env: { EXHAUSTED_WEAK_ACCURATE: "on" } }) === true);
t("on: strong はブレインの約束でも従来どおり（守らない）", exhaustedWeakKeepBrainPromise({ strength: "strong", asks: [{ route: "promise", about: "search_condition" }], env: { EXHAUSTED_WEAK_ACCURATE: "on" } }) === false);

// ② 行き先が未定の内覧の日時（q141）
{
  const f: ViewingFlow = { ...EMPTY_VIEWING_FLOW, stage: "date_agreed", label: "10/26 17:00", timeFixed: true, currentReply: "date_time", reason: "test" };
  const off = withEnv("VIEWING_PLACE_UNDECIDED_LINE", undefined, () => buildViewingFlowBrainText(f));
  const on = withEnv("VIEWING_PLACE_UNDECIDED_LINE", "on", () => buildViewingFlowBrainText(f));
  t("off: 行き先未定の1文は無い", !off.includes("行き先") && off.includes("次の一手は meeting_place"));
  t("on: 行き先未定なら meeting_place はまだ送れない", on.includes("行き先") && on.includes("meeting_place はまだ送れない"));
  const g: ViewingFlow = { ...EMPTY_VIEWING_FLOW, stage: "proposing", reason: "test" };
  t("on: 日にちが決まる前の段階には足さない", !withEnv("VIEWING_PLACE_UNDECIDED_LINE", "on", () => buildViewingFlowBrainText(g)).includes("行き先"));
}

// ③ 名義貸しの番（q093）
t("網: お客さんの名義貸してくれる", nameLendingTurn("ここまだ空いてますかー？\nお客さんの名義貸してくれるみたいで\n新着もあったら追加で送って欲しいです！"));
t("網: 他人名義で契約", nameLendingTurn("他人名義で契約できますか？"));
t("網: 親の名義で", nameLendingTurn("親の名義で借りることはできますか"));
t("網の外: 保証人がいない（通常の審査の相談）", !nameLendingTurn("保証人がいないのですが審査通りますか？"));
t("網の外: 収入が不安", !nameLendingTurn("収入が少ないので審査が不安です"));
t("網の外: 過去に名義を貸した打ち明け（q036）", !nameLendingTurn("今回、通らなかったのは以前、友人に名義を貸した際に飛ばれてるので それが影響してるかもしれないです。"));
t("網の外: 契約者の名前の漢字", !nameLendingTurn("契約書の名前の漢字が違っていました"));
t("off: 行は空", screeningPhoneTurnLine("名義貸してくれるみたいで", {}) === "");
t("on: 行は電話をかける", screeningPhoneTurnLine("名義貸してくれるみたいで", { SCREENING_PHONE_LINE: "on" }).includes("phone_call"));
t("on: 通常の審査の相談は行なし", screeningPhoneTurnLine("保証人がいないのですが", { SCREENING_PHONE_LINE: "on" }) === "");

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
