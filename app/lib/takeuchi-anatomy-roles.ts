// app/lib/takeuchi-anatomy-roles.ts — 竹内さんの1通を1文ずつに分け、文ごとの役目・背景と1通全体の背景・誘導先を読む（純関数）
//
// 2026-11-11 作業員5（竹内さんの決定 KB P1 e94d6d27「竹内さんの1通は役目の違う部品の組み合わせ」・P0 2e164f41・04ca13be）。
//   今の解剖（takeuchi-anatomy.ts の部品 greet/uke/main/add/cta/close）は粗く、「信頼を得る文」「障壁を下げる文」「内覧へ」「申込へ」の区別が無い。
//   ①文の分け方は決まった計算（splitSentences）＝3回読みの多数を文ごとに取れる ②役目は DeepSeek が文の番号ごとに1つ選ぶ
//   ③場面×重点ごとの役目の並びの型（rolePattern）④下書きと竹内さんの比べ（compareRoles: 欠けた役目・余分な役目・順番の違い）。
//   書き手の設計図・採点にはまだ使わない（型が見えてから・既定 off・試験で悪化0）。
// テスト: app/lib/__tests__/takeuchi-anatomy-roles.test.ts

/** 文の役目（竹内さんの言葉: 要点・信頼・障壁・内覧へ・申込へ 等） */
export const SENTENCE_ROLES = [
  "greet",    // 名前と挨拶（お世話になっております）
  "uke",      // 受け（かしこまりました・ありがとうございます・お気持ちの受け止め）
  "answer",   // 問いへの答え＝一番の要点
  "worry",    // 奥の心配への答え（言っていない不安に答える）
  "trust",    // 信頼を得る（サポートの姿勢・こちらの手間を見せる・事実の裏付け）
  "barrier",  // 障壁を下げる（1部屋だけ・キャンセル料がかからない・入居まで期間がある・割引）
  "viewing",  // 内覧につなげる
  "apply",    // 申込・抑えるにつなげる
  "estimate", // 見積につなげる
  "ask_send", // 物件を送ってもらう
  "keep",     // 新着の約束・関係をつなぐ（ピックアップしてお送り・気になる点はいつでも）。全力でサポートは trust（竹内さん e94d6d27「信頼を得る＝サポートの姿勢」）
  "promise",  // 確かめる約束（募集状況・設備を確認させて頂きます）
  "close",    // 締め（何卒よろしくお願い致します・お気軽にお申し付けください）
] as const;
export type SentenceRole = typeof SENTENCE_ROLES[number];
export const ROLE_LABEL: Record<SentenceRole, string> = {
  greet: "名前と挨拶", uke: "受け", answer: "問いへの答え（一番の要点）", worry: "奥の心配への答え", trust: "信頼を得る",
  barrier: "障壁を下げる", viewing: "内覧へ", apply: "申込・抑えるへ", estimate: "見積へ", ask_send: "物件を送ってもらう",
  keep: "新着の約束・関係をつなぐ", promise: "確かめる約束", close: "締め",
};
/** 1通の誘導先（次に何へつなげたか） */
export const LEAD_TO = ["viewing", "apply", "estimate", "ask_send", "keep", "answer_only", "none"] as const;
export type LeadTo = typeof LEAD_TO[number];
const isRole = (v: unknown): v is SentenceRole => typeof v === "string" && (SENTENCE_ROLES as readonly string[]).includes(v);
const isLead = (v: unknown): v is LeadTo => typeof v === "string" && (LEAD_TO as readonly string[]).includes(v);

/**
 * 1文ずつに分ける（決まった計算）。改行で分け、さらに「！！」「。」「？」の後（続く絵文字・閉じ括弧は前の文に付ける）で分ける。
 * 空の文・絵文字だけの文は前の文に付ける。【AIX】の印は外さない（文の頭に残す）
 */
export function splitSentences(body: string): string[] {
  const out: string[] = [];
  for (const line of String(body ?? "").replace(/\r/g, "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    // 終わりの記号の塊（！！・。・？・!）＋続く絵文字・括弧の後で切る
    const parts = t.split(/(?<=[。！？!?]+[\p{Extended_Pictographic}\u{FE0F}\u{200D}）」』]*)(?=[^。！？!?\p{Extended_Pictographic}\u{FE0F}\u{200D}）」』])/u);
    for (const p of parts) {
      const s = p.trim();
      if (!s) continue;
      if (!/[\p{L}\p{N}]/u.test(s) && out.length) out[out.length - 1] += s; else out.push(s);
    }
  }
  return out;
}

export const ROLES_SYSTEM = [
  "あなたは賃貸仲介会社の社長（竹内さん）の LINE の返信を、1文ずつ読み解く担当です（文は直さない）。竹内さんの1通は、役目の違う文の組み合わせです。",
  `文の番号ごとに役目を1つ選ぶ: ${SENTENCE_ROLES.map((r) => `${r}=${ROLE_LABEL[r]}`).join("／")}。`,
  "境目: お客様の問いに直接答えた文＝answer（1通に無いこともある）／問われていない不安（先に取られる・審査・費用・入居日）に答えた文＝worry／弊社がする手間・事実の裏付け・サポートの姿勢で安心させる文＝trust／申込や内覧の心理的・費用的な壁を低くする文（1部屋だけの募集・キャンセル料がかからない・割引・抑えてから内覧できる）＝barrier／内覧の誘い・日程を聞く＝viewing／申込・お部屋を抑える誘い＝apply／御見積の誘い・送る約束＝estimate／気になる物件を送ってほしい＝ask_send／ピックアップ・新着を送る約束・条件を広げて探す約束・気になる点はいつでもご連絡を＝keep／管理会社に確かめる約束（確認出来次第ご連絡も同じ）＝promise。",
  // 2026-11-11 作業員5: 3回読みで割れた 41/743 文を Claude が読み直して足した境目（割れ方の型 A〜H）
  "境目の決まり（割れやすい所）:",
  "A 文の途中で切れた行（終わりの記号が無い行・物件名だけの行・「・〇〇」の箇条書き・「〜にて」「〜ですので」で終わる行）は、続く文（無ければ前の文）と同じ役目。",
  "B 「全力でサポートさせて頂きます」「最善のサポート」はサポートの姿勢＝trust（keep ではない）。ピックアップ・新着を送る約束が入っていれば keep。",
  "C 「ごゆっくりご検討ください」「ごゆっくりご確認頂けますと幸いです」のように急かさず待つ文、「〜とのこと、かしこまりました」「ご連絡頂きありがとうございます」は uke。",
  "D 答えた事の続き（内訳・例外・手数料・仕組みの説明）は answer。barrier は、申込・内覧の壁を自分から下げに行く文だけ（キャンセル料がかからない・割引・1部屋だけの募集・問い合わせが多く埋まる可能性＝先に抑える理由）。",
  "E 1つの文に壁を下げる言葉と誘い（推奨・如何でしょうか・抑えさせて頂きます）が両方あれば、誘いの役目（apply・viewing）を取る。",
  "F 「お気軽にお申し付けください／ご連絡ください」は、何を（ご内覧・お申込・気になる点）と付いていればその役目（viewing・apply・keep）、何も付いていなければ close。1通の途中の「何卒よろしくお願い致します」も close。",
  "G 頼まれていない物件の推し・事実（初期費用をかなり抑えられる・好条件・〇月退去予定・号室の名前）は、その文が次に導く役目（退去予定→内覧の時期なら viewing／抑えるなら apply）、導く先が無ければ trust（事実の裏付け）。",
  "H 条件・ご都合・限度額をお客様に聞く文は ask_send（お客様から材料をもらう）。電話の打合せの時間を聞く文も ask_send。promise は管理会社・オーナーに確かめる約束だけ。",
  "書き出す物: roles（文の番号順に {\"i\":番号,\"role\":\"…\",\"why\":\"なぜこの言い方か（25字以内）\"}）・main_role（この1通で一番大事な文の役目）・lead_to（次に何へつなげたか: viewing 内覧／apply 申込・抑える／estimate 見積／ask_send 物件を送ってもらう／keep 新着・関係をつなぐ／answer_only 答えて終わり／none）・background（1通全体の背景＝何を一番にして、どこへ進めたいか・50字以内）。",
  "名前は YUMA、伏せた所は〈〉のまま。推測で事実を足さない。出力は JSON だけ: {\"roles\":[{\"i\":1,\"role\":\"…\",\"why\":\"…\"}],\"main_role\":\"…\",\"lead_to\":\"…\",\"background\":\"…\"}",
].join("\n");

/** 下読みに渡すのは伏せ済みの物だけ（申込の書類以降は呼ぶ側で外す） */
export function rolesPrompt(o: { maskedCustomer: string | null; sentences: string[]; scene: string; situation?: string | null }): string {
  return `## 場面\n${o.scene}\n\n${o.situation ? `## その番の時点の状況（伏せ済み）\n${o.situation.slice(0, 500)}\n\n` : ""}## お客様の発言（伏せ済み）\n${(o.maskedCustomer ?? "（こちらから送った番）").slice(0, 300)}\n\n## 竹内さんの返信（文の番号つき・伏せ済み）\n${o.sentences.slice(0, 20).map((s, i) => `${i + 1}. ${s.slice(0, 160)}`).join("\n")}`;
}

export type RoleRead = { roles: Array<{ i: number; role: SentenceRole; why: string }>; main_role: SentenceRole | null; lead_to: LeadTo | null; background: string | null };
/** 読み取り（番号が範囲の外・一覧の外の役目は捨てる）。n は文の数 */
export function parseRoles(text: string, n: number): RoleRead | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: Record<string, unknown>;
  try { j = JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
  const roles = (Array.isArray(j.roles) ? j.roles : []).map((r) => r as { i?: unknown; role?: unknown; why?: unknown })
    .filter((r) => Number.isInteger(r.i) && (r.i as number) >= 1 && (r.i as number) <= n && isRole(r.role))
    .map((r) => ({ i: r.i as number, role: r.role as SentenceRole, why: String(r.why ?? "").slice(0, 60) }));
  if (!roles.length) return null;
  return { roles, main_role: isRole(j.main_role) ? j.main_role : null, lead_to: isLead(j.lead_to) ? j.lead_to : null, background: typeof j.background === "string" ? j.background.slice(0, 120) : null };
}

const majority = <T extends string>(xs: ReadonlyArray<T | null | undefined>): { v: T | null; split: boolean } => {
  const c = new Map<T, number>();
  for (const x of xs) if (x) c.set(x, (c.get(x) ?? 0) + 1);
  const top = [...c.entries()].sort((a, b) => b[1] - a[1]);
  if (!top.length) return { v: null, split: false };
  const need = Math.floor(xs.length / 2) + 1;
  return top[0][1] >= need ? { v: top[0][0], split: false } : { v: null, split: true };
};
/** 3回読みの多数（文ごと・main_role・lead_to）。割れた文は role=null。背景は多数の役目と同じ回の why を採る。
 *  failedReads＝壊れて読めなかった回の数（11/11: 3回中2回壊れると全文が「割れた」に入ってしまう＝割れと読めないを分けて数える） */
export function majorityRoles(reads: ReadonlyArray<RoleRead | null>, n: number): { roles: Array<{ i: number; role: SentenceRole | null; why: string | null }>; main_role: SentenceRole | null; lead_to: LeadTo | null; background: string | null; splitSentences: number; failedReads: number } {
  const ok = reads.filter(Boolean) as RoleRead[];
  const roles = Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    const per = reads.map((r) => r?.roles.find((x) => x.i === i)?.role ?? null);
    const m = majority(per);
    const why = m.v ? ok.map((r) => r.roles.find((x) => x.i === i && x.role === m.v)?.why).find(Boolean) ?? null : null;
    return { i, role: m.v, why };
  });
  const lead = majority(reads.map((r) => r?.lead_to ?? null)).v;
  return {
    roles, main_role: majority(reads.map((r) => r?.main_role ?? null)).v, lead_to: lead,
    background: ok.find((r) => r.lead_to === lead)?.background ?? ok[0]?.background ?? null,
    splitSentences: roles.filter((r) => !r.role).length,
    failedReads: reads.length - ok.length,
  };
}

/** 役目の並びの型（続く同じ役目は1つに・挨拶と受けと締めは型から外さない）。例 "uke>answer>barrier>apply>close" */
export function rolePattern(roles: ReadonlyArray<SentenceRole | null>): string {
  const out: string[] = [];
  for (const r of roles) { const v = r ?? "?"; if (out[out.length - 1] !== v) out.push(v); }
  return out.join(">");
}

/** 下書きと竹内さんの比べ: 欠けた役目・余分な役目（挨拶・受け・締めは数えない）・順番の違い（共通の役目の並びが違う） */
export function compareRoles(takeuchi: ReadonlyArray<SentenceRole | null>, draft: ReadonlyArray<SentenceRole | null>): { missing: SentenceRole[]; extra: SentenceRole[]; orderDiff: boolean; same: boolean } {
  const SOFT = new Set<SentenceRole>(["greet", "uke", "close"]);
  const core = (xs: ReadonlyArray<SentenceRole | null>) => [...new Set(xs.filter((x): x is SentenceRole => !!x && !SOFT.has(x)))];
  const a = core(takeuchi), b = core(draft);
  const missing = a.filter((x) => !b.includes(x)), extra = b.filter((x) => !a.includes(x));
  const common = a.filter((x) => b.includes(x));
  const orderDiff = common.join(">") !== b.filter((x) => common.includes(x)).join(">");
  return { missing, extra, orderDiff, same: !missing.length && !extra.length && !orderDiff };
}
