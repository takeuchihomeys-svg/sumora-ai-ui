// app/lib/followup-revive-1021.ts（純関数・DB/ネットに触れない）
// 2026-10-21 竹内さんの答え D5「AIX 追客（7日返事なし）を強める」— 竹内さんの実送信で直す。
//
// ■ 測った物（読むだけの SELECT・365日・お客様の最後の発言から7日以上空いた、その日最初のこちらの文 1通/会話/日）
//   竹内さん: オススメの札（🌟物件名＋オススメポイント）59（3日以内の返事 13）・スモ割の案内（🟢…【2,980円＋前家賃】）20（2）・
//            新着のご連絡 15（2）・以前お送りした物件の更新（さらに割引・フリーレント）3（1）・継続の確認 1・その他 5
//   従業員:   新着のご連絡 66（26）・その他 21・オススメの札 14・継続の確認 3（3）
//   ★「その後いかがでしょうか」は全員 0 通（365日）。なのに AIX【追客する】の指示は「その後いかがでしょうか！！から入る」だった。
//   AIX【追客する】の送信は4回だけ。最新（10/06 search_continue）は竹内さんが新着の1文を消し
//     「〇〇さんお部屋探し継続されていますでしょうか！！／まだお決まりになっていない場合〇〇さんのご条件に合ったお部屋ピックアップしお送りさせて頂きます😌！！」
//   に直して送った（指示は「③の後に何も書かない」「新しくオススメ出来る物件が募集にでました」＝新着が無いのに新着を作っていた）。
//
// ■ 直し（切替 FOLLOWUP_REVIVE_1021・既定 on・off で今まで通り）
//   ① 「その後いかがでしょうか」を指示から外し、出口でも落とす
//   ② 新着の一文は、物件名か補足（新着物件あり 等）がある時だけ（無い時に新着を作らない）。作った時は決まった形に差し替える
//   ③ 締めは竹内さんの形（継続の確認＋まだお決まりでなければピックアップしてお送り）
type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});

export function followupRevive1021Enabled(env: Env = envOf()): boolean {
  return (env.FOLLOWUP_REVIVE_1021 ?? "").trim().toLowerCase() !== "off";
}

const san = (name: string | null | undefined) => {
  const n = String(name ?? "").trim().replace(/(?:さん|様)$/, "");
  return n ? `${n}さん` : "";
};

/** 竹内さんの継続の確認（10/06 の実送信の形） */
export function followupContinueLine(name?: string | null): string {
  return `${san(name)}お部屋探し継続されていますでしょうか！！`;
}
/** 竹内さんの締め（10/06 の実送信の形・誤字「さえて」は直す） */
export function followupPickupOfferLine(name?: string | null): string {
  const n = san(name);
  return `まだお決まりになっていない場合${n ? `${n}の` : ""}ご条件に合ったお部屋ピックアップしお送りさせて頂きます😌！！`;
}
/** 新着の一文（物件名がある時は名前で・無い時は「オススメ出来るお部屋」） */
export function followupNewArrivalLine(name?: string | null, propertyName?: string | null): string {
  const p = String(propertyName ?? "").trim();
  const n = san(name);
  return p ? `新着で${n ? `${n}に` : ""}オススメ出来る${p}が募集に出ました！！` : `新着で${n ? `${n}に` : ""}オススメ出来るお部屋が募集に出ました！！`;
}

/** 補足（スタッフの入力）・物件名から「新着がある」と言える材料があるか（スタッフだけが知る事実） */
export function hasNewArrivalFact(o: { propertyName?: string | null; extraInput?: string | null }): boolean {
  if (String(o.propertyName ?? "").trim()) return true;
  return /新着|募集に出|新しく[^\n]{0,10}(?:出|募集)|新築/.test(String(o.extraInput ?? ""));
}

/**
 * 竹内さんの形の追客の文（LLM なし）。greet: 今日はじめての連絡なら「〇〇さんお世話になっております！！」
 *   newArrival: 新着の材料がある時だけ新着の一文
 */
export function composeFollowupText(o: { name?: string | null; greet: boolean; newArrival?: boolean; propertyName?: string | null }): string {
  const n = san(o.name);
  const L: string[] = [];
  if (o.greet) L.push(`${n}お世話になっております！！`);
  if (o.newArrival) L.push(followupNewArrivalLine(o.name, o.propertyName));
  L.push(followupContinueLine(o.name));
  L.push(followupPickupOfferLine(o.name));
  return L.join("\n");
}

const SONOGO_RE = /その後(?:いかが|如何)(?:でしょうか|ですか|でしょう)?[^\n。]*?[！!。]*/g;
const NEW_ARRIVAL_CLAIM_RE = /新着|募集に(?:出|で)ました|新しく[^\n]{0,20}募集/;

/**
 * 出口: ①「その後いかがでしょうか」の文を落とす ②新着の材料が無いのに新着と書いた → null（呼び出し側が composeFollowupText にする）
 *   落とした後に本文が挨拶だけになった時も null
 */
export function sanitizeFollowupText(text: string, o: { newArrivalFact: boolean }): { text: string | null; removed: string[] } {
  const removed: string[] = [];
  let t = String(text ?? "").replace(/\r\n/g, "\n");
  t = t.replace(SONOGO_RE, (m) => { removed.push("sonogo"); return ""; });
  t = t.split("\n").map((l) => l.replace(/^\s+$/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!o.newArrivalFact && NEW_ARRIVAL_CLAIM_RE.test(t)) { removed.push("new_arrival_without_fact"); return { text: null, removed }; }
  const body = t.split("\n").filter((l) => l.trim() && !/お世話になっております/.test(l) && !/^\s*\S{1,15}(?:さん|様)[！!]*\s*$/.test(l));
  if (!body.length) return { text: null, removed };
  return { text: t, removed };
}

/** 指示に入れる竹内さんの形（LLM に渡す・出口と両方） */
export function followupShapeNote(o: { name?: string | null; newArrivalFact: boolean; propertyName?: string | null }): string {
  return [
    "【竹内さんの追客の形（2026-10-21・実送信で確かめた形。ここより前の指示と食い違う所はこちらが正）】",
    "・「その後いかがでしょうか」は書かない（竹内さん・従業員とも実送信 365日で0通）",
    o.newArrivalFact
      ? `・新着のご連絡から入る（例「${followupNewArrivalLine(o.name, o.propertyName)}」）。物件の特徴は補足にある事だけ一言`
      : "・新着の物件の話は書かない（スタッフの補足に新着の物件が無い＝新着があるとは言えない）",
    `・続けて「${followupContinueLine(o.name)}」`,
    `・締めは「${followupPickupOfferLine(o.name)}」（押しつけない・返信を求めない）`,
    "・2〜4行。過去の会話のお客様の条件（エリア・間取り等）は、会話にある事だけ一言添えてよい",
  ].join("\n");
}
