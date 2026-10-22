// app/lib/aix-new-pickers.ts（純関数・DB/ネットに触れない）
// 2026-10-20 竹内さんの決定の新しいピッカー（AIX【確認した（条件・交渉）→管理会社に確認した】の中と、新しいボタン AIX【物件について】）。
//   ・審査について（ご相談）mgmt_screening（P1 84519320）: 名義・保証人・職業と収入・国籍・審査の見込み・時期 → 確認した結果＋審査の考え方＋必要書類＋通るまでサポート
//   ・申込状況について mgmt_application_status（P1 ec545624・お手本 d08bc127）: 申込の有無・何番手／何人待ち・1番手の審査の状況 → 結果＋番手＋繰り上がり＋申込への誘導と並行の手
//   ・駐車場について の中のバイク置き場（P1 95d3831d）: mgmt_parking の parking_kind=bike（check_pattern は駐車場のまま）
//   ・物件について→募集号室について room_vacancies（P1 398b9781）: 建物の募集中の号室・部屋数・間取り・家賃
//   ・契約の条件について mgmt_contract_terms／家賃の交渉について mgmt_rent_negotiation（P1 c2f49d5c 10/18 の新しいピッカー③⑤）
//   ・周辺の様子について mgmt_surroundings（10/18 の④・日当たり／音・騒音／周辺の様子・現地で見た／管理会社に聞いた）
//   ・室内写真を確認した の中の「現地で撮影した」（10/18 の②・写真／動画／両方・check_pattern は interior_photo のまま）
// 判断はブレイン（P0 9eb6aa9c）。ここの正規表現は「候補を拾う網」（場面の証拠・約束の台帳の要件・check_pattern の網）と、出口の安全の線（事実はスタッフの入力のまま）だけ。
// 切替: AIX_NEW_PICKERS_1020=on の時だけ（既定 off＝安全側）。場面の網・約束の台帳の新しい要件・約束→ピッカーの対応・ブレインの値とカタログ。
//   画面のボタン（ピッカーの選択肢）と aix/action の生成は足すだけの物なので切替なしで出る（押した時だけ動く）

export function aixNewPickers1020Enabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_NEW_PICKERS_1020 ?? "").trim().toLowerCase() !== "off";
}
/**
 * 2026-10-22 既定 on にした時の線（竹内さん 3948d74c「審査についてはブレインは試験後」）: 審査について（ご相談）mgmt_screening を
 *   ブレイン・約束の台帳・場面の網が選ぶのは、AIX_NEW_PICKERS_1020=on を明示した時か AIX_SCREENING_BUTTON=brain の時だけ（既定では選ばない・画面のボタンは今まで通り）。
 *   試験 p12-np-on（10問）は審査の問題 q021・q116 が揺れで悪化・審査で良くなった問題は無かった
 */
export function screeningPickerForBrain(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.AIX_NEW_PICKERS_1020 ?? "").trim().toLowerCase() === "on" || (env.AIX_SCREENING_BUTTON ?? "").trim().toLowerCase() === "brain";
}

/**
 * 2026-10-20 竹内さん「個人情報が絡む部分はかならずクロードにする」: 審査について（ご相談）は職業（夜職）・国籍・保証人・
 * ご家族の勤め先などのお客様の事情を入れるので、スイッチに関係なく必ず Claude（DeepSeek に回さない）。
 * aix/action の歯止め（setupAltProviderGuards）がこれを見て「申込以降」と同じ扱い（回さない・印を付けて Anthropic）にする。
 */
export const CLAUDE_ONLY_CHECK_PATTERNS: readonly string[] = ["mgmt_screening"];
/** 2026-10-21 竹内さん C9: 新しいボタン【審査について】の中の物は全部 Claude（保証会社について guarantor_info も審査の話・話題つきの審査の相談も） */
export const CLAUDE_ONLY_ACTIONS: readonly string[] = ["guarantor_info"];
export function aixRequestMustUseClaude(body: { action?: unknown; check_pattern?: unknown; screening_topic?: unknown } | null | undefined): boolean {
  if (!body) return false;
  if (typeof body.action === "string" && CLAUDE_ONLY_ACTIONS.includes(body.action)) return true;
  if (typeof body.screening_topic === "string" && body.screening_topic.trim()) return true;
  return body.action === "property_check_result" && typeof body.check_pattern === "string" && CLAUDE_ONLY_CHECK_PATTERNS.includes(body.check_pattern);
}

/** 新しい check_pattern（画面・記録・ブレインで同じ値） */
export const NEW_CHECK_PATTERNS_1020 = ["mgmt_screening", "mgmt_application_status", "mgmt_contract_terms", "mgmt_rent_negotiation", "mgmt_surroundings", "room_vacancies"] as const;
export type NewCheckPattern1020 = typeof NEW_CHECK_PATTERNS_1020[number];

/** 新しいボタン AIX【物件について】の画面の名前（四者同名: 画面・ブレインのカード・帯・カタログ） */
export const PROPERTY_INFO_BUTTON = "物件について";
/** 物件について の中のピッカー（check_pattern → 画面の文言） */
export const PROPERTY_INFO_PICKER_LABELS: Record<string, string> = {
  room_vacancies: "募集号室について",
};
export function isPropertyInfoCheckPattern(v: string | null | undefined): boolean {
  return !!v && Object.prototype.hasOwnProperty.call(PROPERTY_INFO_PICKER_LABELS, v);
}

// ─── 網（候補を拾う・ブレインの判断を上書きしない）──────────────────────────────────────

/**
 * 申込状況（ほかの方の申込の有無・何番手・何人待ち・1番手の方の審査の状況）の問い・約束の語。
 *   実物: お客様「13階は何人待ちですか？」（10/20）・「エスリードはまだ申し込み入ってないんですか？」／スタッフ「随時1番手お申し込み者さんの審査状況確認させていただきます」
 *   ご本人の申込の進捗（「無事1番手でお申込完了しているか確認」「申込み番手確認」・お部屋止め）は含めない（aix-task-link の APPLY_PROGRESS_CHECK_RE の線）
 */
export const APPLICATION_STATUS_Q_RE = /何人待ち|何番手|[一1１]番手[^\n。！!？?]{0,8}(?:の方|のお?客様|お?申し?込み?者)[^\n。！!？?]{0,10}(?:審査|状況)|(?:お?申込|お?申し込)み?状況|(?:お?申込|お?申し込)み?(?:が|は)?(?:まだ)?(?:入って|はいって)(?:いる|る|いない|ない|います|ます|いません|ません)?(?:んです|のです)?か|(?:お?申込|お?申し込)み?(?:が|は)?(?:まだ)?(?:入って|はいって)[^\n。！!]{0,6}[？?]|(?:お?申込|お?申し込)み?(?:が|は)?(?:何件|何人)/;
/** ご本人の申込の進捗（申込の後の確認）＝申込状況のピッカーではない */
export const OWN_APPLICATION_PROGRESS_RE = /完了|受理|お?部屋止め|申込み?番手|受付番手|(?:お?申込|お?申し込)み?(?:させて|しました|します|頂き|いただき)/;
export function isApplicationStatusQuestion(text: string | null | undefined): boolean {
  const t = String(text ?? "").normalize("NFKC");
  if (!t.trim()) return false;
  return APPLICATION_STATUS_Q_RE.test(t) && !OWN_APPLICATION_PROGRESS_RE.test(t);
}

/**
 * 建物の募集中の号室・部屋数の問い（「ここ何部屋空いてますか？」10/20 ゆいとさん）。
 *   別の部屋の間取り・一番広い部屋（OTHER_ROOM_LAYOUT_Q_RE＝室内写真を確認した）・物件を探す依頼（他にお部屋ありますか＝ピックアップ）は含めない
 */
export const ROOM_VACANCIES_Q_RE = /何部屋|何室|何戸|(?:どの|どこの|何階の?)(?:お?部屋|号室|階)(?:が|は)?(?:空いて|空き|募集)|(?:空いて(?:いる|る)|空きの?|募集(?:中|して(?:いる|る))の?)(?:お?部屋|号室)(?:は|って|が)?(?:どこ|どれ|何|いくつ|何部屋)|(?:お?部屋|号室)(?:は|が)?(?:いくつ|何部屋)(?:空いて|空き|募集)/;
export function isRoomVacanciesQuestion(text: string | null | undefined): boolean {
  const t = String(text ?? "").normalize("NFKC");
  if (!t.trim()) return false;
  return ROOM_VACANCIES_Q_RE.test(t);
}

/** バイク置き場（駐車場について の中のピッカーの既定値・約束の台帳の要件） */
export const BIKE_PARKING_RE = /バイク|原付|単車|二輪|駐輪/;

/** 契約の条件（短期解約の違約金・退去時のクリーニング代・フリーレント）の確認の約束・問い */
export const CONTRACT_TERMS_RE = /短期解約|違約金|解約予告|解約通知|フリーレント/;
/** 家賃の値下げの交渉（「交渉の宣言はこちらからしない」決まりは generate-reply 側。ここは聞かれた・交渉した結果を返すピッカーの網） */
export const RENT_NEGOTIATION_RE = /家賃[^\n。！!？?]{0,10}(?:交渉|値下げ|値引|下げ|安く|減額)|(?:交渉|値下げ|値引|減額)[^\n。！!？?]{0,8}家賃/;

/** 周辺の様子（日当たり・音・騒音・治安・周辺の環境）の問い・約束の要件 */
export const SURROUNDINGS_RE = /日当たり|陽当たり|日当り|騒音|うるさ|治安|周辺の(?:様子|環境)|周りの(?:様子|環境)/;

/** 審査の相談（名義・保証人・職業・国籍・審査が通るか）の約束の要件 */
export const SCREENING_CONSULT_RE = /名義|審査(?:の|に)?(?:ご?相談|見込み|通りやす|通る|通ら)|(?:保証人|連帯保証)(?:が)?(?:いない|なし|無し|立てられ|付けられ)|外国籍|在留|夜職|水商売|内定|就活|無職/;

// ─── 出口（スタッフの入力を事実の正とする）───────────────────────────────────────

/** 審査について（ご相談）の締めの一文（竹内さんの決定の言い方のまま・出口で必ず1回） */
export const SCREENING_SUPPORT_LINE = "無事に審査通過するまで全力でサポートさせて頂きます😊！！";
const SUPPORT_SENT_RE = /審査通過(?:する)?まで[^\n]{0,8}(?:全力で)?サポート/;
/** 生成の文に『審査通過するまで全力でサポート』が無ければ最後に足す（2回は書かない） */
export function ensureScreeningSupportLine(text: string): string {
  const t = String(text ?? "").replace(/\s+$/, "");
  if (SUPPORT_SENT_RE.test(t)) return t;
  return t ? `${t}\n${SCREENING_SUPPORT_LINE}` : SCREENING_SUPPORT_LINE;
}

/**
 * 審査の相談で確認した結果・見込みが入力に無い時（＝管理会社・保証会社に確認していない）、
 * LLM が書いた「管理会社（保証会社）に確認させて頂きました」「〜とのことでした」の行を落とす（P0: スタッフだけが知る事実を作らない）。
 * 全部落ちたら基本の考え方の一文にする。
 */
const UNCHECKED_SCREENING_CLAIM_RE = /管理会社|保証会社|オーナー|確認させて頂|確認させていただ|確認いたしました|確認しました|とのことでした|との事でした/;
export function stripUncheckedScreeningClaims(text: string): string {
  const kept = String(text ?? "").replace(/\r\n/g, "\n").split("\n").filter((l) => !UNCHECKED_SCREENING_CLAIM_RE.test(l));
  const isGreeting = (l: string) => /お世話になっております/.test(l) || /^\s*\S{1,15}(?:さん|様)\s*$/.test(l);
  const hasBody = kept.some((l) => l.trim() && !SUPPORT_SENT_RE.test(l) && !isGreeting(l));
  const lines = hasBody ? kept : [...kept.filter(isGreeting), SCREENING_BASIC_STANCE, ...kept.filter((l) => SUPPORT_SENT_RE.test(l))];
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 申込状況の入力（画面の選択） */
export type ApplicationStatusInput = {
  /** 申込あり／申込なし */
  hasApplication: "あり" | "なし";
  /** 先に入っている申込の数（申込ありの時・1〜9）。お客様は ahead+1 番手 */
  ahead?: number | null;
  /** 1番手の方の審査の状況 */
  firstStatus?: "審査中" | "審査待ち" | "不明" | null;
  /** 2番手の受付ができない物件（管理会社の回答） */
  noSecond?: boolean;
};
export function applicationStatusPosition(i: ApplicationStatusInput): number {
  if (i.hasApplication !== "あり") return 1;
  const a = Math.max(1, Math.min(9, Math.floor(Number(i.ahead) || 1)));
  return a + 1;
}
/**
 * 申込状況の文のお手本の型（d08bc127）を入力で組んだ「決まった型の文」。LLM の文が型を外れた時の差し替えと、試験の正解の形に使う。
 *   ①結果 ②だから何番手か ③繰り上がりの仕組み ④申込への誘導と並行の手（如何でしょうか！！）
 *   お名前は呼び名の入口（aix/action の name＝固定の呼び名→会話で確定した名前）から。分からなければ名前なしで書く。
 */
export function composeApplicationStatusText(i: ApplicationStatusInput & { roomLabel?: string | null; callName?: string | null }): string {
  const room = (i.roomLabel ?? "").trim();
  const head = room ? `${room}${/お部屋$/.test(room) ? "" : "のお部屋"}` : "こちらのお部屋";
  const san = (i.callName ?? "").trim();
  const who = san ? (/さん$|様$/.test(san) ? san : `${san}さん`) : "";
  if (i.hasApplication === "なし") {
    return `${head}現在お申込は入っておりません！！\n${who ? `${who}が` : ""}1番手でお申込頂ける状況となります！！\nお気に召されましたらお申込しお部屋抑えさせて頂きます😊！！`;
  }
  const pos = applicationStatusPosition(i);
  const ahead = pos - 1;
  const firstWord = i.firstStatus === "審査待ち" ? "審査待ち" : i.firstStatus === "不明" ? "お申込が入っている状況" : "審査中";
  const result = i.firstStatus === "不明" ? `${head}現在${ahead}件お申込が入っている状況となります！` : `${head}現在${ahead}人${firstWord}となります！`;
  if (i.noSecond) {
    return `${result}\nこちらのお部屋は2番手でのお申込を受け付けていない為、1番手の方がキャンセル・審査否決となった場合にお申込可能となります！！\n1番手の方の状況を確認しながら、並行して${who ? `${who}に` : ""}オススメ出来るお部屋お探しさせて頂きます😊！！`;
  }
  const ord = `${pos}番手`;
  const lift = ahead >= 2
    ? `${Array.from({ length: ahead }, (_, k) => `${k + 1}番手`).join("・")}の方が審査否決となった場合${who ? `${who}に` : ""}審査が繰り上がる形となります！！`
    : `1番手の方が審査否決となった場合${who ? `${who}が` : ""}1番手に審査繰り上がる形となります！！`;
  return `${result}その為${ord}でのお申込となり、${lift}\nよろしければ${ord}でお申込を行い、${ahead >= 2 ? "" : "1番手への"}審査繰り上がりを待ちながら並行して物件をお探しさせて頂くのは如何でしょうか！！`;
}
/** LLM の申込状況の文がお手本の型の芯（番手・繰り上がり・申込の誘導）と事実（番手の数）を持っているか */
export function applicationStatusTextOk(text: string, i: ApplicationStatusInput): boolean {
  const t = String(text ?? "").normalize("NFKC");
  if (i.hasApplication === "なし") return /1番手|一番手/.test(t) && /お?申込|お?申し込/.test(t) && !/2番手|二番手/.test(t);
  const pos = applicationStatusPosition(i);
  // 2番手を受け付けない部屋で「N番手でのお申込となり／を行い」と申込める様に書いた文は外れ
  if (i.noSecond) return /受け付けていない|受付(?:て)?いない|出来ない|できない/.test(t) && !/番手でのお?申込(?:と|を行)/.test(t);
  const posRe = new RegExp(`${pos}番手`);
  const wrongPos = [2, 3, 4, 5, 6, 7, 8, 9, 10].filter((n) => n !== pos).some((n) => new RegExp(`(?<![0-9])${n}番手でのお?申込`).test(t));
  return posRe.test(t) && /繰り上が/.test(t) && /(?:お?申込|お?申し込)[^\n]{0,60}(?:如何|いかが|抑え|ご案内)/.test(t) && !wrongPos;
}

/** 募集号室の1行（スタッフが入れた行・号室/間取り/家賃は写した文字のまま） */
export function parseVacancyRows(raw: string | null | undefined): string[] {
  return String(raw ?? "").replace(/\r\n/g, "\n").split("\n")
    .map((l) => l.replace(/^[\s・\-*●○◆■□]+/, "").trim())
    .filter(Boolean)
    .slice(0, 30);
}
/** 生成の文から号室の一覧らしい行（スタッフの入力の写し）を落とし、スタッフの入力の一覧を差し込む */
export function composeVacancyMessage(generated: string, rows: string[], headline?: string | null): string {
  const lines = String(generated ?? "").replace(/\r\n/g, "\n").split("\n");
  const ROW_LIKE_RE = /^[\s・\-*●○◆■□]*[0-9０-９]{2,4}\s*号室|^[\s・\-*●○◆■□]*(?:[0-9０-９]+[RK]|[0-9０-９]+[SL]?DK|ワンルーム)/;
  const kept = lines.filter((l) => !ROW_LIKE_RE.test(l));
  // 1行目（〇〇は現在N部屋募集中となります）の後に一覧を入れる
  const firstIdx = kept.findIndex((l) => /募集中|空いて|空き/.test(l));
  const at = firstIdx >= 0 ? firstIdx + 1 : (headline ? 0 : Math.min(1, kept.length));
  const list = rows.map((r) => `・${r}`);
  const head = firstIdx < 0 && headline ? [headline] : [];
  const out = [...kept.slice(0, at), ...head, ...list, ...kept.slice(at)];
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 物件について→募集号室について の文（LLM なし・号室/間取り/家賃はスタッフが募集一覧で見た文字のまま）。
 *   1行目「〇〇現在N部屋募集中となります！！」→ 一覧 → 締め（誘導の選択に合わせる）
 */
export function composeRoomVacanciesText(i: { propertyName?: string | null; rows: string[]; guidance?: string | null }): string {
  const rows = i.rows.map((r) => r.trim()).filter(Boolean);
  const head = (i.propertyName ?? "").trim() || "こちらの建物";
  const close = i.guidance === "内覧"
    ? "気になるお部屋ございましたらご内覧のご案内させて頂きます😊！！"
    : i.guidance === "申込"
    ? "気になるお部屋ございましたら先にお申込みでお部屋抑えて内覧もできます😊！！"
    : "気になるお部屋ございましたら資料お送りさせて頂きます😊！！";
  return [`${head}現在${rows.length}部屋募集中となります！！`, ...rows.map((r) => `・${r}`), close].join("\n");
}

/** 審査について（ご相談）の基本の考え方（竹内さん 10/18 の答え: 気に入ったお部屋なら審査はかけてみることができる） */
export const SCREENING_BASIC_STANCE = "お気に召されたお部屋でしたら審査はかけてみることが出来ますので、ご安心ください😊！！";
