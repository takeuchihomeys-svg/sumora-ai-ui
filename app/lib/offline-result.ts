// app/lib/offline-result.ts — 電話・内覧の結果を、スタッフが手打ちした「電話の後／内覧の後の1通」から取り出す（純関数・DB/LLM なし）
//
// 2026-11-11 作業員1（弱い所 573「電話で話した内容が AI に届いていない」・574「内覧の場の結果が届いていない」・親 P0 ecd7b961 の②こちら側）:
//   実物（電話の AIX の後 9会話・内覧の後 11会話・10/10〜11/11）を読んだ:
//   ・保存の道はあるのに使われていない: AIX【電話終了後】0回（電話をかける 43回）・電話のメモ（customer_memos の call）0件・内覧の記録（viewing_report）3/135
//   ・スタッフは結果を手打ちの1通に書いている（「先ほどはお電話ありがとうございました！！ 11/1日に〇〇103号室お申込みさせていただきます」
//     「本日お時間頂きありがとうございました！！ 本町駅まで…家賃14万円以内の1SLDK 2LDK、大きめ(45平米以上)の1LDKのお部屋ピックアップ…」
//     「ご内覧時にお伺いさせていただきました。・ペット飼育可能か ・1/1日ご入居可能か 管理会社担当者に確認交渉させていただきます」
//     「…サンシエ南巽303号室お申込しお部屋抑えさせて頂きます」（内覧の予定は 103号室＝その場で別の部屋に決めた））
//   → この1通はこちらの送信として会話に載っているが、ブレインには「ただの挨拶の1通」で、決まった事・新しい条件・確認の約束・申込の部屋として読まれていない。
//   ここはその1通から決定論で ①決まった日程 ②新しい条件（家賃・間取り・広さ・築年・エリア） ③確認・交渉の約束 ④申込する部屋（次の一手）を取り、材料の1行にする。
//   ⚠ 審査の事情（夜職・無職・滞納・年収・勤務先・内定・提携会社への引き継ぎの理由）は取らない（個人の事情・申込以降は対象外）。引き継いだ事実だけ。
//   スタッフの頭の中だけの事（どの点が気に入った・何が合わなかった・気持ち）は文に無い＝ここでは取れない → 画面の入力（staff-capture のタップ）を送る1通の所に出す案（aix_feature_suggestions）。
// 既定 off（入れる OFFLINE_RESULT_MATERIAL=on）。

type Env = Record<string, string | undefined>;
export function offlineResultMaterialOn(env?: Env): boolean {
  const e = env ?? (typeof process !== "undefined" ? process.env : {});
  return (e.OFFLINE_RESULT_MATERIAL ?? "").trim().toLowerCase() === "on";
}

export type OfflineKind = "phone" | "viewing";
const PHONE_THANKS_RE = /(?:先ほど|先程|さきほど)(?:は)?お電話(?:頂き|いただき)?(?:ありがとう|有難う)|お電話(?:頂き|いただき)(?:ありがとう|有難う)/;
const VIEWING_THANKS_RE = /本日(?:は)?お時間(?:頂き|いただき)(?:ありがとう|有難う)|(?:ご内覧|ご内見)(?:に)?(?:お越し)?(?:頂き|いただき)(?:ありがとう|有難う)|本日(?:は)?(?:ご内覧|ご内見)(?:頂き|いただき)?(?:ありがとう|有難う)/;

/** 電話の後・内覧の後のお礼の1通か（無ければ null） */
export function offlineThanksKind(text: string | null | undefined): OfflineKind | null {
  const t = String(text ?? "").normalize("NFKC");
  if (PHONE_THANKS_RE.test(t)) return "phone";
  if (VIEWING_THANKS_RE.test(t)) return "viewing";
  return null;
}

export type OfflineFacts = {
  kind: OfflineKind;
  /** ④ 申込する部屋（「〇〇 303号室お申込」） */
  applyRoom: string | null;
  /** ① 決まった日程（「11/1日にお申込み」「12/1入居」）の文の一節 */
  dates: string[];
  /** ② 新しい条件（ピックアップ・探す約束の中の家賃・間取り・広さ・築年・エリア） */
  conditions: string[];
  /** ③ 確認・交渉の約束の中身（「ペット飼育可能か」「401号室の室内の色味」） */
  confirms: string[];
  /** もう伝えた確認の結果（「確認できましたのでご連絡」の箇条書き） */
  results: string[];
  /** ピックアップ・新着を送る約束がある */
  pickupPromise: boolean;
  /** 提携会社に引き継いだ（理由は取らない） */
  handoff: boolean;
};

const SENSITIVE_RE = /審査|年収|勤務先|内定|夜職|無職|滞納|信用情報|お仕事情報|アリバイ/;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** お礼の1通から事実を取る（お礼の1通でなければ null） */
export function extractOfflineFacts(text: string | null | undefined): OfflineFacts | null {
  const t = String(text ?? "").normalize("NFKC").replace(/\r/g, "");
  const kind = offlineThanksKind(t);
  if (!kind) return null;
  const sentences = t.split(/(?<=[。！!？?])\s*|\n+/).map((s) => s.trim()).filter(Boolean);
  const safe = sentences.filter((s) => !SENSITIVE_RE.test(s));
  const joined = safe.join("\n");
  // ④ 申込する部屋（1つの文に2部屋「グルーブ日本橋502号室ラシーヌ日本橋501号室お申込」もある＝全部）
  // 「903号室2番手でお申込み」のように号室と申込の間に短い語が入る形もある
  const apSent = safe.find((x) => /号室?[^。！!、]{0,6}?(?:お申込|お申し込|で審査)/.test(x)) ?? "";
  const apHead = apSent.split(/お申込|お申し込|で審査/)[0] ?? "";
  // 名前の前の語（「11/1日に」「お送りいただけましたら」）は外す
  const rooms = [...apHead.matchAll(/([^\s、。！!・「」]{2,30}?)\s?(\d{2,4})\s*号室?/g)]
    .map((m) => `${m[1].replace(/^.*(?:たら|ので|日に|ます|ました)/, "").replace(/^(?:本日|に|で|と)/, "")} ${m[2]}号室`).filter((x) => x.length > 5);
  const applyRoom = rooms.length ? rooms.join("・") : null;
  // ① 決まった日程（申込・入居・内覧の日付）
  const dates = [...joined.matchAll(/(\d{1,2}\s*[/月]\s*\d{1,2}\s*日?)(?:に|より|から|〜)?[^\n。！!]{0,40}?(お申込|お申し込|ご入居|入居|ご案内|ご内覧)/g)]
    .map((m) => `${m[1].replace(/\s/g, "")}${m[2]}`);
  // ② 新しい条件（探す・ピックアップ・新着の約束の文の中だけ）
  const conditions: string[] = [];
  for (const s of safe) {
    if (!/ピックアップ|お部屋探し|お探し|探させて|新着|出次第|お送りさせて/.test(s)) continue;
    const add = (re: RegExp) => { for (const m of s.matchAll(re)) { const v = m[0].trim(); if (v && !conditions.includes(v)) conditions.push(v); } };
    add(/家賃\s*(?:管理費?込み?|管理)?\s*\d+(?:\.\d+)?\s*万円?(?:以内|以下|まで|程|ほど)/g);
    add(/敷金礼金(?:無し|なし|ゼロ|0)|洋室\s*\d+(?:\.\d+)?\s*帖以上|独立洗面台|築年数浅め|エリア(?:少し)?広げ|[ァ-ヶー一-龠]{2,6}が大きめ|ガスコンロ|マンションタイプ/g);
    add(/(?<![0-9A-Z])[1-5]\s*S?L?D?K(?:以上)?|ワンルーム/g);
    add(/(?:大きめ)?\(?\d{2,3}\s*(?:平米|㎡|m2)\s*以上\)?/g);
    add(/築年数\s*\d+\s*年以内|築浅|リノベーション(?:物件)?|新築/g);
    add(/(?<=^|[\s、])[^\s、。・で]{2,10}?駅(?:まで|から)[^\s、。]{0,14}?(?:駅|分)以内|(?<=^|[\s、でらは])[^\s、。・でらは]{2,10}周辺(?:全域)?/g);
    add(/リビング(?:が)?大きめ|敷地内駐車場|独立系の保証会社|ペット飼育可能|二人入居可能|角部屋|洗面台が広め/g);
  }
  // ③ 確認・交渉の約束の中身
  // もう確認できた結果（「確認できましたのでご連絡」＝約束ではなく結果）は results に
  const confirms: string[] = [];
  const results: string[] = [];
  const bullet = t.split("\n").map((l) => l.trim()).filter((l) => /^[・･]/.test(l)).map((l) => l.replace(/^[・･]\s*/, ""));
  const already = /確認(?:でき|出来)ました|確認させて(?:頂|いただ)きました|とのことです|とのご返答|ご返答(?:が)?あり(?:まし|、)/.test(joined);
  if (/確認|交渉/.test(joined)) for (const b of bullet) if (!SENSITIVE_RE.test(b) && b.length <= 30) (already ? results : confirms).push(b);
  for (const m of joined.matchAll(/([^\s、。！!]{2,24}?)(?:に関して|について|を)\s*(?:管理会社(?:担当者)?に)?(?:確認|交渉)(?:させて|して|しており|しております|いたし)/g)) {
    const v = m[1].replace(/^(?:また|あわせて|併せて)/, "");
    if (!SENSITIVE_RE.test(v) && !confirms.includes(v) && !already) confirms.push(v);
  }
  const pickupPromise = /ピックアップ(?:し|出来|でき|させて)|出次第(?:すぐに)?お送り|新着(?:で)?(?:募集に)?出次第/.test(joined);
  const handoff = /提携(?:会社|先)/.test(t);
  return { kind, applyRoom, dates: [...new Set(dates)].slice(0, 3), conditions: conditions.slice(0, 8).map((c) => clip(c, 30)), confirms: confirms.slice(0, 4).map((c) => clip(c, 30)), results: results.slice(0, 4).map((c) => clip(c, 30)), pickupPromise, handoff };
}

/** 中身のある事実か（お礼だけの1通は材料にしない） */
export function hasOfflineFacts(f: OfflineFacts | null): f is OfflineFacts {
  return !!f && !!(f.applyRoom || f.dates.length || f.conditions.length || f.confirms.length || f.results.length || f.pickupPromise || f.handoff);
}

/** ブレインの材料の1行（無ければ空）。答えは書かない＝ブレインが決める */
export function offlineResultMaterialLine(f: OfflineFacts | null, atJst: string | null = null, opts: { viewedRoom?: string | null } = {}): string {
  if (!hasOfflineFacts(f)) return "";
  const head = f.kind === "phone" ? "電話で決まった事" : "内覧の場で決まった事";
  const parts: string[] = [];
  if (f.applyRoom) parts.push(`申込する部屋: ${f.applyRoom}${opts.viewedRoom && !f.applyRoom.replace(/\s/g, "").includes(opts.viewedRoom.replace(/\s|号室?/g, "")) ? `（内覧の予定は ${opts.viewedRoom}＝その場で別の部屋に決めた）` : ""}`);
  if (f.dates.length) parts.push(`日程: ${f.dates.join("・")}`);
  if (f.conditions.length) parts.push(`その場で分かった新しい条件（この条件で探す約束）: ${f.conditions.join("・")}`);
  if (f.confirms.length) parts.push(`管理会社に確認・交渉する約束: ${f.confirms.join("・")}`);
  if (f.results.length) parts.push(`もう伝えた確認の結果: ${f.results.join("・")}`);
  else if (f.pickupPromise && !f.conditions.length) parts.push("物件をピックアップして送る約束");
  if (f.handoff) parts.push("提携会社に引き継いだ");
  return `【☎️🏠 ${head}（こちらが${atJst ? ` ${atJst} に` : ""}送ったお礼の1通から・スタッフが話して知った事）】\n- ${parts.join("\n- ")}\n→ お客様の次の一通はこの事実と結び付けて読む（決まった事を聞き直さない・約束は果たす番か待つ番かをブレインが決める）。`;
}
