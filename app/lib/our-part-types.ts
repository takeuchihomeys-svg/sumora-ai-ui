// app/lib/our-part-types.ts — やり取りの「部分」の語彙を1か所に（純関数・作業員4・2026-11-12）
//
// 竹内さん 11/12「送った事でもこのように足りていない部分あるか。ちゃんとこちらから送った部分と相手が送ってきた部分を照らし合わせられるように」
//   ＋同日「このこちらからの部分も具体的に細かく細分化しておく」。KB P0 ecd7b961（一通を両側から細かく読む）・P1 d030d496（確認の順番の細分化）。
// 名前を揃えた所（同じ語を2か所で作らない）:
//   ・作業員16 の our-send-uptake.ts の粗い6種（question/fact/promise/proposal/invite/property）＝ここの kind と同じ鍵。ここは「aix」を足し、各 kind の下に sub を持つ
//   ・作業員1 の info-fill-map.ts の INFO_KEYS（area/rent/layout/move_in/size…）＝聞いた事の sub の鍵と同じ
//   ・conductor-our-side.ts の AIX の名前（AIX_JA）とピッカー（pickJa）＝送った AIX の部分の名前
// 部分ごとに 目的（purpose）・期待した反応（expect）・期限（dueHours＝この時間の内に期待した反応／果たす事が来るはず）を持つ。
// ここは事実の語彙だけ（どう返すか・どこへつなぐかの言葉は入れない＝q057・q069 の教訓）。

export const OUR_PART_KINDS = ["question", "fact", "promise", "proposal", "invite", "property", "aix"] as const;
export type OurPartKind = typeof OUR_PART_KINDS[number];
export const OUR_PART_KIND_LABEL: Record<OurPartKind, string> = {
  question: "聞いた事", fact: "伝えた事実", promise: "約束", proposal: "提案・推し", invite: "誘い（内覧・申込）", property: "送った物件", aix: "送った AIX",
};

/** 期待した反応（お客様から来るはずの物）。fulfil はこちらが果たす物（約束） */
export const EXPECTS = ["answer", "accept", "schedule", "property", "reaction", "fulfil"] as const;
export type Expect = typeof EXPECTS[number];
export const EXPECT_LABEL: Record<Expect, string> = { answer: "答え", accept: "了承", schedule: "日程", property: "物件", reaction: "反応・感想", fulfil: "こちらが果たす" };

export type PartSpec = { kind: OurPartKind; label: string; purpose: string; expect: Expect; dueHours: number; re: RegExp };

const H = 24;
/** 細かい部分の表（sub の鍵 → 目的・期待・期限・見分ける網）。並びは見分ける順（先に当たった物を採る） */
export const OUR_PARTS: Record<string, PartSpec> = {
  // 聞いた事（鍵は info-fill-map の INFO_KEYS と同じ＋設備・日程・物件の希望・事情）
  "question.area": { kind: "question", label: "エリア", purpose: "探す範囲を決める", expect: "answer", dueHours: H, re: /エリア|最寄り?駅|どの辺|どちら周辺/ },
  "question.rent": { kind: "question", label: "家賃", purpose: "探す家賃の上限を決める", expect: "answer", dueHours: H, re: /家賃|ご予算|賃料/ },
  "question.layout": { kind: "question", label: "間取り", purpose: "探す間取りを決める", expect: "answer", dueHours: H, re: /間取り/ },
  "question.move_in": { kind: "question", label: "入居時期", purpose: "探す時期・急ぎ具合を知る", expect: "answer", dueHours: H, re: /入居(?:時期|のご予定|予定)|いつ頃|お引越し(?:の)?(?:時期|予定)/ },
  "question.size": { kind: "question", label: "広さ", purpose: "探す広さを決める", expect: "answer", dueHours: H, re: /広さ|㎡|平米|帖/ },
  "question.equipment": { kind: "question", label: "設備", purpose: "外せない設備を知る", expect: "answer", dueHours: H, re: /設備|こだわり|オートロック|バストイレ|ペット|駐車場/ },
  "question.schedule": { kind: "question", label: "日程", purpose: "内覧・連絡の日を決める", expect: "schedule", dueHours: H, re: /ご都合|お日にち|日程|何時|何日|曜日/ },
  "question.property_wish": { kind: "question", label: "物件の希望", purpose: "どの物件が気になるかを知る", expect: "property", dueHours: 2 * H, re: /気になる(?:お部屋|物件)|お気に召|どちらの(?:お部屋|物件)|気に入った/ },
  "question.situation": { kind: "question", label: "事情", purpose: "審査・入居の事情を知る", expect: "answer", dueHours: H, re: /ご職業|お勤め|保証会社|滞納|ご年収|ご事情|ご状況|何名|人数/ },
  // 伝えた事実
  "fact.check_result": { kind: "fact", label: "確認の結果", purpose: "確かめた事を伝える", expect: "reaction", dueHours: 2 * H, re: /募集中|募集(?:終了|が終了)|申込(?:が)?入|空き(?:が)?(?:ござい|あり)|確認(?:が)?取れ|確認(?:致|いた)しました|管理会社(?:様)?に確認/ },
  "fact.estimate_amount": { kind: "fact", label: "見積の金額", purpose: "初期費用を伝える", expect: "reaction", dueHours: 2 * H, re: /御?見積|初期費用[^。！!]{0,12}[0-9０-９,]+円|合計[0-9０-９,]+円/ },
  "fact.company": { kind: "fact", label: "会社の事実", purpose: "会社のやり方を伝える", expect: "accept", dueHours: 2 * H, re: /仲介手数料(?:0|０|無料)|最大限割引|弊社|スモ割|全力でサポート/ },
  // 網に当たらない文（聞かれた事への答え・事情の受け・その他）。網では当てず、最後の受け皿だけ
  "fact.answer": { kind: "fact", label: "答え・受け（その他）", purpose: "聞かれた事に答える・事情を受ける", expect: "reaction", dueHours: 2 * H, re: /(?!)/ },
  "fact.material": { kind: "fact", label: "資料の事実", purpose: "物件の資料の事を伝える", expect: "reaction", dueHours: 2 * H, re: /築|徒歩|帖|敷金|礼金|ペット可|フリーレント|退去予定|入居可能/ },
  // 約束（こちらが果たす）
  "promise.estimate": { kind: "promise", label: "見積を出す", purpose: "初期費用を見せる", expect: "fulfil", dueHours: H, re: /御?見積書?(?:を)?(?:作成|お送り)/ },
  "promise.check": { kind: "promise", label: "確認する", purpose: "空き・条件を確かめる", expect: "fulfil", dueHours: H, re: /(?:募集状況|空き状況|空室)?(?:を)?確認(?:させて|致し|いたし)/ },
  "promise.send_property": { kind: "promise", label: "物件を送る", purpose: "物件を見せる", expect: "fulfil", dueHours: H, re: /(?:お部屋|物件)[^。！!]{0,20}(?:お送り|送らせて)(?:させて|致し|いたし)/ },
  "promise.search": { kind: "promise", label: "探す", purpose: "条件で探す", expect: "fulfil", dueHours: 2 * H, re: /ピックアップ(?:して)?(?:お送り)?(?:させて|致し|いたし)|お探し(?:させて|致し|いたし)|探させて/ },
  "promise.contact_day": { kind: "promise", label: "連絡の日を決める", purpose: "次の連絡の時を伝える", expect: "fulfil", dueHours: 3 * H, re: /(?:明日|本日中|週明け|改めて|後ほど|確認出来次第)[^。！!]{0,20}ご連絡/ },
  // 提案・推し
  "proposal.hold": { kind: "proposal", label: "抑える", purpose: "埋まる前に部屋を確保する", expect: "accept", dueHours: H, re: /(?:抑え|押さえ)(?:て|る|られ)|先にお申込/ },
  "proposal.screening_first": { kind: "proposal", label: "審査だけ先に", purpose: "審査を先に通す", expect: "accept", dueHours: H, re: /審査(?:だけ|のみ)(?:を)?先/ },
  "proposal.other_property": { kind: "proposal", label: "別の物件", purpose: "代わりの物件を見せる", expect: "reaction", dueHours: 2 * H, re: /他(?:の|にも)(?:お部屋|物件)|別の(?:お部屋|物件)|代わり/ },
  "proposal.viewing": { kind: "proposal", label: "内覧", purpose: "実物を見てもらう", expect: "schedule", dueHours: 2 * H, re: /一度(?:ご)?(?:内覧|内見)|実際に(?:ご覧|見て)/ },
  // 誘い（扉を開けておく）
  "invite.apply_door": { kind: "invite", label: "申込の扉", purpose: "申込に進めると知らせる", expect: "accept", dueHours: 2 * H, re: /お申込(?:み)?(?:頂|いただ|の際|可能|でき)|お申し込み/ },
  "invite.viewing_door": { kind: "invite", label: "内覧の扉", purpose: "内覧に進めると知らせる", expect: "schedule", dueHours: 2 * H, re: /ご案内させて|ご内覧|内見|内覧/ },
  // 送った物件
  "property.alternative": { kind: "property", label: "代わり", purpose: "外れた物件の代わりを見せる", expect: "reaction", dueHours: 2 * H, re: /代わり|代替|他にも(?:同じ|似た)/ },
  "property.new_arrival": { kind: "property", label: "新着", purpose: "新しく出た物件を見せる", expect: "reaction", dueHours: 2 * H, re: /新着|新しく(?:募集|出)/ },
  "property.one_push": { kind: "property", label: "1件推し", purpose: "1件を強く見せる", expect: "reaction", dueHours: 2 * H, re: /(?:中でも|こちらの)[^。！!]{0,30}(?:オススメ|おすすめ)/ },
  "property.bundle": { kind: "property", label: "束", purpose: "候補をまとめて見せる", expect: "reaction", dueHours: 2 * H, re: /ピックアップさせて頂きました|ご査収|🌟|号室/ },
};
export type OurPartKey = keyof typeof OUR_PARTS;

/** 送った AIX の部分（種類×ピッカー）の期待と期限。種類が無い物は reaction・2日 */
export const AIX_PART_EXPECT: Record<string, { purpose: string; expect: Expect; dueHours: number }> = {
  condition_hearing: { purpose: "条件を聞く", expect: "answer", dueHours: 2 * H },
  property_send: { purpose: "物件を見せる", expect: "reaction", dueHours: 2 * H },
  property_recommendation: { purpose: "1件を強く見せる", expect: "reaction", dueHours: 2 * H },
  property_check_result: { purpose: "確かめた事を伝える", expect: "reaction", dueHours: 2 * H },
  estimate_sheet: { purpose: "初期費用を見せる", expect: "reaction", dueHours: 2 * H },
  viewing_invite: { purpose: "内覧の日を決める", expect: "schedule", dueHours: H },
  meeting_place: { purpose: "内覧の待ち合わせを伝える", expect: "accept", dueHours: H },
  application_push: { purpose: "申込に進める", expect: "accept", dueHours: H },
  phone_call: { purpose: "電話で話す", expect: "schedule", dueHours: H },
};

export type OurPart = { key: string; kind: OurPartKind; label: string; purpose: string; expect: Expect; dueHours: number; text: string; at: string };

const isQuestion = (s: string) => /[?？]|でしょうか|ございますか|(?:頂|いただ)けますか|お聞かせ|教えて/.test(s);
const PROMISE_TAIL = /(?:させて|致し|いたし)(?:頂き|いただき)?ます/;

/** こちらの1通（文字）を細かい部分に分ける（網・本番の判断はブレイン）。AIX の1通は aixPart で別に作る */
export function splitOurPartsFine(text: string, at: string): OurPart[] {
  const sents = String(text ?? "").split(/(?<=[！!。？?])\s*|\n+/).map((s) => s.trim()).filter((s) => s.length >= 4);
  const out: OurPart[] = [];
  const seen = new Set<string>();
  for (const s of sents) {
    if (/^(?:\S{0,12}さん)?(?:お世話になっております|はじめまして)|^何卒よろしく|^お手隙の際に|^かしこまりました|^はい[😊！!]*$/.test(s) && s.length < 30) continue;
    let key: string | null = null;
    const q = isQuestion(s);
    const order: OurPartKind[] = q ? ["proposal", "question"] : PROMISE_TAIL.test(s) ? ["promise", "invite", "proposal", "property", "fact"] : ["property", "proposal", "invite", "fact"];
    for (const k of order) {
      key = Object.keys(OUR_PARTS).find((kk) => OUR_PARTS[kk].kind === k && OUR_PARTS[kk].re.test(s)) ?? null;
      if (key) break;
    }
    if (!key && q) key = "question.property_wish";
    if (!key && !/^(?:\S{0,12}さん)?(?:お世話|はじめまして|この度|何卒|お手隙|かしこまり|はい|ありがとう|お部屋探しを担当)/.test(s)) key = "fact.answer";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const sp = OUR_PARTS[key];
    out.push({ key, kind: sp.kind, label: sp.label, purpose: sp.purpose, expect: sp.expect, dueHours: sp.dueHours, text: s.slice(0, 80), at });
  }
  return out;
}

export function aixPart(aixType: string, pickerJa: string | null, at: string, aixJa: string): OurPart {
  const e = AIX_PART_EXPECT[aixType] ?? { purpose: "AIX の中身を伝える", expect: "reaction" as Expect, dueHours: 2 * H };
  return { key: `aix.${aixType}`, kind: "aix", label: `${aixJa}${pickerJa ? `＝${pickerJa}` : ""}`, purpose: e.purpose, expect: e.expect, dueHours: e.dueHours, text: aixJa, at };
}

// ─── お客様が送ってきた部分 ─────────────────────────────────────────────────────────
export const THEIR_PART_KINDS = ["question", "condition", "worry", "accept", "schedule", "property_bring", "reaction"] as const;
export type TheirPartKind = typeof THEIR_PART_KINDS[number];
export const THEIR_PART_LABEL: Record<TheirPartKind, string> = {
  question: "問い", condition: "条件", worry: "不安", accept: "了承", schedule: "日程", property_bring: "物件の持ち込み", reaction: "物件への反応",
};
export type TheirPart = { kind: TheirPartKind; text: string; at: string; conditionKeys: string[] };

const COND_KEY_RE: Array<[string, RegExp]> = [
  ["area", /区|市|駅|線|周辺|エリア|梅田|難波|なんば|天王寺|本町|心斎橋|京橋|新大阪/], ["rent", /[0-9０-９.]+万|円|家賃|予算/], ["layout", /[1-4１-４][LDKＬＤＫ]{1,3}|ワンルーム|1R|1K/i],
  ["move_in", /[0-9０-９]+月|来月|今月|年内|来年|すぐ|即入居|春|夏|秋|冬/], ["size", /㎡|平米|帖|畳|広め|広い/], ["equipment", /オートロック|バストイレ|独立洗面|ペット|駐車場|宅配|エアコン|2階以上|角部屋/],
];
export const conditionKeysOf = (t: string) => COND_KEY_RE.filter(([, re]) => re.test(t)).map(([k]) => k);

export function splitTheirParts(text: string, at: string): TheirPart[] {
  const t = String(text ?? "").trim();
  if (!t) return [];
  const out: TheirPart[] = [];
  const keys = conditionKeysOf(t);
  if (/https?:\/\/|^\[画像\]/.test(t)) out.push({ kind: "property_bring", text: t.slice(0, 60), at, conditionKeys: [] });
  if (/[?？]|ですか|ますか|でしょうか|かな|教えて/.test(t)) out.push({ kind: "question", text: t.slice(0, 80), at, conditionKeys: keys });
  if (/不安|心配|危う|通らない|落ち|ブラック|滞納|厳しい/.test(t)) out.push({ kind: "worry", text: t.slice(0, 60), at, conditionKeys: [] });
  if (/(?:[0-9０-９]+[日月]|明日|明後日|土曜|日曜|平日|午前|午後|[0-9０-９]+時)/.test(t) && !/[0-9０-９]+月(?:頃|上旬|中旬|下旬|入居)/.test(t)) out.push({ kind: "schedule", text: t.slice(0, 60), at, conditionKeys: [] });
  if (keys.length >= 2 || /^[①1]/.test(t)) out.push({ kind: "condition", text: t.slice(0, 60), at, conditionKeys: keys });
  if (/気になり|いいですね|良いですね|見てみたい|ここ(?:に|が)|微妙|高い|遠い|狭い/.test(t)) out.push({ kind: "reaction", text: t.slice(0, 60), at, conditionKeys: [] });
  if (!out.length && /^(?:はい|了解|承知|わかりました|分かりました|ありがとう|よろしく|お願いします)/.test(t)) out.push({ kind: "accept", text: t.slice(0, 40), at, conditionKeys: [] });
  if (!out.length && keys.length === 1) out.push({ kind: "condition", text: t.slice(0, 60), at, conditionKeys: keys });
  return out;
}
