// scripts/test-golden-hold-and-view.ts — 竹内さん 11/12 の実例を通しの手本にして、作った部品の純関数が「正しい欄の値」を出すかを確かめる（LLM/DB なし・費用0・作業員16）
//
// 実例（名前・物件名は伏せた・YUMA の会話の形）:
//   こちら（直前）: 🌟〇〇マンション 502号室／リビング13帖と広く開放感抜群／敷金礼金なしで初期費用を抑えて／お気に召されましたらご案内
//   お客様: 「〇〇マンションの502号室かなり気に入っています！リビングの広さも希望通りで初期費用も抑えられるので。けど他にもっと条件に合う部屋があるかもしれないです。でも取られるのが不安です」
//   竹内さん: 先に申込でお部屋を抑えて内覧へ／保証会社の審査通過までキャンセル料がかからない事を伝える／抑えながら新着も並行して探す／内覧で気に入れば決める・合わなければ並行して探す
// 正しい欄の値（GOLD）を部品ごとに書き、各部品の純関数の出す値と比べる。外れは「外れ」として一覧に出す（テストは外れの数を固定して、直ったら数を減らす）。
// 実行: npx tsx scripts/test-golden-hold-and-view.ts
import assert from "node:assert/strict";
import { splitOurSend, readUptake } from "../app/lib/our-send-uptake";
import { pickCheckOrder, NEXT_MOVE_OF_TYPE } from "../app/lib/check-order";
import { strengthCeiling, timingOf, type PushCues } from "../app/lib/next-move-types";
import { normalizeTurnAims } from "../app/lib/brain-turn-aims";
import { matchCompanyFacts } from "../app/lib/company-facts";
import { normalizeNowVsLater, aixNowOf } from "../app/lib/brain-now-later";

export const GOLDEN_HOLD_AND_VIEW = {
  ourSend: "🌟〇〇マンション 502号室\nリビング13帖と広く開放感抜群のお部屋となります！！\n敷金礼金なしのため初期費用を抑えてご入居頂けます！！\nお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！",
  customer: "〇〇マンションの502号室かなり気に入っています！リビングの広さも希望通りで初期費用も抑えられるので。けど他にもっと条件に合う部屋があるかもしれないです。でも取られるのが不安です",
  takeuchi: [
    "かしこまりました！！",
    "よろしければ先にお申込みでお部屋を抑えた状態でご内覧頂くのがオススメです😊！！",
    "保証会社の審査通過まではキャンセル料かかりませんので、お部屋を抑えながら並行して新着のお部屋も探させて頂きます！！",
    "ご内覧でお気に召されましたらそのままお決め頂き、合わなければ並行して探したお部屋の中からご提案させて頂きます😌！！",
  ],
  gold: {
    uptake: { hook: "hooked", degree: "strong", points: ["広さ・間取り", "初期費用"], invite: "passed" },
    mood: { hooked: ["広さ・間取り", "初期費用"], hesitation: "他と比べている", worry: "先に取られる不安（人気の物件・迷っている間）" },
    checkOrderType: "T12_hooked_comparing_taken",
    nextMove: { main: { dest: "apply", strength: "strong", timing: "now" }, subs: [{ dest: "viewing", strength: "invite", timing: "now" }, { dest: "keep_send", strength: "none", timing: "plant" }] },
    nowVsLater: { this_turn: "answer", aixNow: null },
    turnAims: { depth: 2, turnAim: "申込で抑えてから内覧", midAim: "内覧で決める／合わなければ並行の新着", plant: "保証会社の審査通過までキャンセル料かからない" },
    preemptFacts: ["hold_room"],
  },
} as const;

const G = GOLDEN_HOLD_AND_VIEW;
const misses: string[] = [];
const check = (name: string, ok: boolean, got: unknown) => { console.log(`${ok ? "ok  " : "外れ"} ${name}${ok ? "" : `（出た値: ${JSON.stringify(got)}）`}`); if (!ok) misses.push(name); };

// ① こちらの送信の受け取られ方と刺さり（our-send-uptake）
const parts = splitOurSend(G.ourSend);
const ups = readUptake(parts, G.customer);
const prop = ups.find((u) => u.part.kind === "property");
check("刺さり＝hooked・かなり", prop?.hook?.kind === "hooked" && prop.hook.degree === "strong", prop?.hook);
const hookedPoints = [...new Set(ups.filter((u) => u.uptake === "answered").flatMap((u) => u.part.points))];
check("刺さった点に 広さ・間取り と 初期費用", G.gold.uptake.points.every((p) => hookedPoints.includes(p)), hookedPoints);
check("誘い（ご案内）は流された", ups.find((u) => u.part.kind === "invite")?.uptake === "passed", ups.find((u) => u.part.kind === "invite")?.uptake);

// ② 確認の順番の型（check-order）: 刺さっている×比べている×取られる不安
const picked = pickCheckOrder({ hasQuestion: false, considering: true, takenWorry: true, hooked: true } as Parameters<typeof pickCheckOrder>[0]);
check("型＝刺さっている×比べている×取られる不安（T12）", picked[0]?.id === G.gold.checkOrderType, picked.map((p) => p.id));
const nm = picked[0] ? NEXT_MOVE_OF_TYPE[picked[0].id] : undefined;
check("型の次の一手＝申込×強く（今）", nm?.usual.dest === "apply" && nm.usual.strength === "strong", nm?.usual);
check("型の次の一手の従に 内覧（案内）と 並行探し（仕込み）", !!nm && G.gold.nextMove.subs.every((s) => nm.alt.some((a) => a.dest === s.dest && a.timing === s.timing)), nm?.alt);

// ③ 次の一手の強さの上限・時機（next-move-types）
const cues: PushCues = { remaining: false, decideSignal: false, considering: true, firstContact: false, notHooked: false, takenWorry: /取られ|埋ま/.test(G.customer) };
check("強さの上限＝強く押してよい（取られる不安）", strengthCeiling(cues).max === "strong", strengthCeiling(cues));
check("並行探しの文は仕込み（keep_send の時機＝plant）", timingOf("keep_send", G.takeuchi.join("")) === "plant", timingOf("keep_send", G.takeuchi.join("")));

// ④ 今の番と後の番（brain-now-later）: 返信で答える番・今押す AIX は無し
const nl = normalizeNowVsLater({ asked_now: ["他にもっと合う部屋があるか", "取られるのが不安"], our_open: null, ready_now: [], this_turn: "answer" });
check("今押す AIX は無し（返信）", aixNowOf(nl, null) === null, aixNowOf(nl, null));

// ⑤ 目的・中期・仕込み（brain-turn-aims）: 仕込みのキャンセル料の線が確認・約束の語で落ちない
const ta = normalizeTurnAims({ state: "刺さって比べている", depth: 2, depth_why: "取られる前に抑える", turn_aim: G.gold.turnAims.turnAim, mid_aim: G.gold.turnAims.midAim, plant: G.gold.turnAims.plant });
check("仕込み＝キャンセル料の線が残る", ta?.plant === G.gold.turnAims.plant, ta?.plant);

// ⑥ 先回りの会社の事実（company-facts）: 聞かれていなくても、取られる不安に仮押さえ・キャンセル料の事実
const facts = matchCompanyFacts(G.customer).map((f) => f.id);
check("先回りの事実に hold_room（仮押さえ・キャンセル料）", G.gold.preemptFacts.every((id) => facts.includes(id)), facts);

console.log(`\n外れ ${misses.length} 件: ${misses.join("／") || "無し"}`);
// 今わかっている外れ: 先回りの事実（company-facts は聞かれた時だけ・作業員21 が先回りの会社の事実を作る）。直ったら 0 に
const KNOWN_MISSES = Number(process.env.GOLDEN_KNOWN_MISSES ?? "1");
assert.ok(misses.length <= KNOWN_MISSES, `外れが増えた ${misses.length} > ${KNOWN_MISSES}`);
