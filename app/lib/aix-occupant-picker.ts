// app/lib/aix-occupant-picker.ts（純関数・DB/ネットに触れない）
// 2026-10-22 竹内さんの決定（設計知見 2d860ddb・質問の台帳 8eb83328・質問待ち20①／質問7）:
//   「『入居者の条件（お子様・年齢）』のピッカーを作る。『審査の結果について』は【審査について】の中の選択肢」。
//   審査の結果は aix-owner-answers-1021（screening_topic=result）で入済み。ここは 入居者の条件 のピッカー。
//
//   置き場所: AIX【確認した（条件・交渉）→管理会社に確認した】の中（二人入居について の隣）。check_pattern = mgmt_occupant
//   入れる物: お子様のご入居 可能／不可／条件あり ＋ 条件（「中学生以上のお子様」「1階のお部屋のみ」等・スタッフが管理会社に聞いた字のまま）＋ 物件名
//   実物（本番）: スタッフ「サンライトあべの8 202号ただいま管理会社担当さんに子供のご入居が可能か確認いただいております」→ 結果を手打ち
//               （「中学生以下のお子様のご入居が出来ないとのことです」「1階のお部屋のみお子様のご入居…可能とのことです」）
//               ＝ スタッフだけが知る事（P0 AIX と返信の分け方）なのにボタンが無く手で打っていた。
//   書き方: 竹内さん自身の送信で お子様の入居の結果 を伝えた物は 0 通（10/23 本番 messages を読んだ）→ 竹内さんが決めた
//           二人入居について（10/16・mgmt_two_person）の2行の型に合わせる。竹内さんが送れば aix-meaning-learn が学ぶ。
//   個人情報: お子様の有無・年齢はご家族の事情 → 生成は必ず Claude（CLAUDE_ONLY_CHECK_PATTERNS に入れる）。
//
// 切替: 画面のボタンと aix/action の生成は押した時だけ動く足すだけの物なので切替なし。
//   ブレイン・約束の台帳・場面の網・カタログ（ブレインが選ぶ側）は AIX_OCCUPANT_PICKER=on の時だけ（既定 off）。
//   理由: 今は「子供のご入居が可能か」の約束が 入居時期（mgmt_move_in）の語に当たって入居日のピッカーに読まれている＝
//   on にすると約束の閉じ方・ブレインの選び方が変わる（足すだけではない）。試験で確かめてから既定 on。

type Env = Record<string, string | undefined>;

export const OCCUPANT_CHECK_PATTERN = "mgmt_occupant" as const;
export const OCCUPANT_PICKER_LABEL = "入居者の条件について";
/** 確認の要件名（約束の台帳・カレンダー） */
export const OCCUPANT_CONFIRM_TOPIC = "入居者の条件";
/** 話題の名前（帯・ブレインの note） */
export const OCCUPANT_TOPIC = "入居者の条件（お子様・年齢）";

export function aixOccupantPickerEnabled(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  const v = (env.AIX_OCCUPANT_PICKER ?? "").trim().toLowerCase();
  return v === "on" || v === "1" || v === "true";
}

export const OCCUPANT_POLICIES = ["可能", "不可", "条件あり"] as const;
export type OccupantPolicy = typeof OCCUPANT_POLICIES[number];
export function isOccupantPolicy(v: unknown): v is OccupantPolicy {
  return typeof v === "string" && (OCCUPANT_POLICIES as readonly string[]).includes(v);
}

const CHILD = "(?:お子様|お子さん|お子さま|子供|子ども|こども|小学生|中学生|未就学児?|乳幼児|乳児|幼児|赤ちゃん|新生児)";
/**
 * 入居者の条件（お子様の入居・年齢）の問い・約束の語（候補を拾う網・判断はブレイン）。
 *   当たる: 「202は子ども不可ですか」「子供のご入居が可能か確認」「お子様可ですか」「小学生以下は入居できますか」「年齢制限」
 *   当たらない: 「子供の声NG」（騒音の気にし方）・「大人2人、子供2人、犬2匹でいい物件」（探す条件）・「お子様のお部屋と分けやすい」
 */
export const OCCUPANT_COND_RE = new RegExp([
  `${CHILD}(?:以下|以上|未満)?(?:の|は|が|って|でも)?(?:ご?入居|ご?同居)`,
  `${CHILD}(?:以下|以上|未満)?(?:は|って)?(?:可|不可|OK|NG|ＯＫ|ＮＧ|大丈夫|だめ|ダメ)`,
  `${CHILD}[^\\n。！!？?]{0,12}(?:住め|住む事|暮らせ)`,
  `入居者?の?年齢|入居者の条件|年齢(?:制限|の?条件)`,
].join("|"));
export function isOccupantConditionText(text: string | null | undefined): boolean {
  const t = String(text ?? "").normalize("NFKC");
  return !!t.trim() && OCCUPANT_COND_RE.test(t);
}

/** aix/action の【スタッフ入力情報】（入れるのは 可否・条件・物件名・補足だけ） */
export function buildOccupantMgmtInfo(i: { policy: unknown; condition?: unknown; propertyName?: unknown; extra?: string | null }): string {
  if (!isOccupantPolicy(i.policy)) throw new Error("お子様のご入居が 可能／不可／条件あり のどれかが必要です");
  const cond = typeof i.condition === "string" ? i.condition.replace(/\r\n/g, "\n").trim() : "";
  if (i.policy === "条件あり" && !cond) throw new Error("条件ありの時は条件（例：中学生以上のお子様・1階のお部屋のみ）を入力してください");
  const pn = typeof i.propertyName === "string" ? i.propertyName.trim() : "";
  return [
    `お子様のご入居：${i.policy}`,
    cond ? `条件（管理会社の回答のまま）：${cond}` : "",
    pn ? `物件名：${pn}` : "物件名：入力なし（物件名に触れない）",
    i.extra && i.extra.trim() ? `補足：${i.extra.trim()}` : "",
  ].filter(Boolean).join("\n");
}

/** 生成の型（竹内さんの 二人入居について の2行の型に合わせる） */
export function occupantFormat(policy: OccupantPolicy, condition?: string | null): string {
  const head = "[物件名]にお子様のご入居可能か管理会社に確認させて頂きましたところ";
  if (policy === "不可") return `${head}\nお子様のご入居が出来ないお部屋となります。`;
  if (policy === "条件あり") return `${head}\n${occupantConditionLine(String(condition ?? "").trim() || "[条件]", "[条件]")}`;
  return `${head}\nお子様のご入居可能となります😊！！`;
}

export const OCCUPANT_RULES = `・**この2行だけで終えるのが基本**（二人入居について と同じ形）。挨拶（お世話になっております等）・時候の挨拶は書かない＝1行目から始める
・スタッフが入れたのは「お子様のご入居：可能／不可／条件あり」「条件」「物件名」「補足」だけ。これ以外の事実は絶対に書かない（お子様の人数・年齢・お名前・ご家族の事情・騒音の評価・広さの評価・審査・他の物件の可否）
・[条件]はスタッフ入力の「条件」の字のまま（「中学生以上のお子様」「1階のお部屋のみ」等・言い換え・推測で足さない）
・[物件名]はスタッフ入力の物件名をそのまま使う（複数は「〇〇・〇〇ともに」）。物件名が「入力なし」なら1行目は「お子様のご入居可能か管理会社に確認させて頂きましたところ」から始める
・3行目（次の一手）を足してよいのは、**この会話で内覧のご案内も申込のご案内も一度もしていない時だけ**（可能・条件ありの時「よろしければ一度お部屋ご内覧如何でしょうか😊！！」）。不可の時は足さない（代わりの提案はスタッフが別の AIX で送る）
・謝罪表現（申し訳ございません等）は使わない。「大丈夫です」「審査に通る」など確認していない断定はしない`;

/** 条件ありの2行目（条件の字に お子様・子 があれば「お子様の」を重ねない）。label は型に書く時の置き字（[条件]） */
export function occupantConditionLine(condition: string, label?: string): string {
  const c = condition.trim();
  const w = label ?? c;
  return /お子|子供|子ども|こども|小学生|中学生|高校生|幼児|乳児|未就学/.test(c) ? `${w}でしたらご入居可能となります😊！！` : `${w}でしたらお子様のご入居可能となります😊！！`;
}

/** 出口の安全の線:条件ありで、スタッフの条件の字が本文に無ければ 2行目を決まった型で差し替える */
export function ensureOccupantCondition(text: string, policy: OccupantPolicy, condition: string | null | undefined): string {
  const t = String(text ?? "");
  const cond = String(condition ?? "").trim();
  if (policy !== "条件あり" || !cond || t.normalize("NFKC").includes(cond.normalize("NFKC"))) return t;
  const lines = t.replace(/\r\n/g, "\n").split("\n");
  const i = lines.findIndex((l) => /お子様[^\n]{0,10}(?:ご入居|入居)/.test(l) && !/確認させて/.test(l));
  const fixed = occupantConditionLine(cond);
  if (i >= 0) lines[i] = fixed; else lines.push(fixed);
  return lines.join("\n");
}
