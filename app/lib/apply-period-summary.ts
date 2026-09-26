// app/lib/apply-period-summary.ts
// 「申込期間のまとめ（個人情報なし）」を作る・検査する・渡す形にする純関数（DB にも LLM にも触らない）。
//
// 2026-09-27 竹内「申込中の部分はクロードに切り替えて要約して（審査否決等になって申込から物件提案中にステータスを切り替えた時に
//   連動してクロードが申込期間の部分を要約して DeepSeek に渡す仕組み）そうすれば費用も節約できるし問題も起きない」
//
// 【流れ】戻した（conversations.deepseek_cutoff_at が付いた）会話ごとに1回、Claude が「申込が始まった時〜線」のやり取りを要約する
//   （apply-period-summary-server.ts・brain-sweep が拾う／返信生成が無ければ after で頼む）。出てきた要約は**決定論でもう一度検査**し、
//   引っかかったら渡さない（要約なし＝線より後だけ）。通った要約だけが DeepSeek に1ブロックで渡る（返信生成・AIX・物件の評価）。
//
// 【固い決まり】
//   入れる: 申込した物件（建物・号室）・結果の区分（審査否決／キャンセル／取り下げ／他で決定）・否決の理由の区分（保証会社の審査／オーナー審査…）・
//          申込期間中にお客様が言った部屋の好みや要望・こちらがした約束・次にやること
//   入れない: 名前・電話・住所・生年月日・勤務先・年収・家族構成・本人確認書類や収入証明書の中身・保証人/緊急連絡先・在留資格・借入や滞納
//   → 結果と理由は**選択肢から選ばせる**（自由文にしない＝理由の中身が入る余地を無くす）。自由文の欄は下の検査に全部当てる。
//
// 【検査は既存の網を使う】pii-mask（maskForEmbedding: 電話・メール・郵便番号・申込の欄の値・生年月日・12桁の番号・敬称つきの名前）、
//   pii-pseudonym（createMasker: 当事者と他のお客様の名前・携帯・生年月日・現住所・勤務先・申込フォームの記入）、
//   post-apply の出口の網（線より前のお客様の発言の断片 20字以上＝そのまま写していないか）＋ 申込の個人情報の語。
//   出口の網に当たる要約を渡すと、その呼び出しごと Claude に戻る（llm-alt-provider）ので、作る時に同じ網で落とす。
import { maskForEmbedding } from "./pii-mask";
import { createMasker, isApplicationPayload, APPLICATION_FORM_PLACEHOLDER, type MaskKind } from "./pii-pseudonym";
import { countCutoffLeaks } from "./post-apply";
import { detectGuarantorInText } from "./guarantor-companies";

export const APPLY_OUTCOMES = ["審査否決", "キャンセル", "取り下げ", "他で決定", "不明"] as const;
export type ApplyOutcome = typeof APPLY_OUTCOMES[number];
export const REJECT_REASONS = ["保証会社の審査", "オーナー審査", "管理会社の審査", "不明"] as const;
export type RejectReason = typeof REJECT_REASONS[number];

export type ApplyPeriodSummary = {
  /** 申込した物件（「建物名 号室」） */
  properties: string[];
  outcome: ApplyOutcome;
  /** 否決の時だけ。区分だけ（中身は入れない） */
  reason: RejectReason | null;
  /** 申込期間中にお客様が言った部屋の好み・要望（個人情報を除く） */
  preferences: string[];
  /** こちらがした約束（例: 別の物件を探す） */
  promises: string[];
  /** 次にやること */
  nextSteps: string[];
};

/** 欄ごとの上限（長い要約はそれだけ漏れる面が増える・DeepSeek の入力も増える） */
const MAX_ITEMS = 5;
const MAX_ITEM_CHARS = 80;

// ─── 個人情報の語 ────────────────────────────────────────────────────────────────
/**
 * 申込で出てくる個人情報の語（要約にも、線より後にブレインが作った物にも、出てきたら渡さない）。
 * ⚠ 「保証会社」は区分として使うので入れない（「保証人」「連帯保証」は入れる）。
 */
export const APPLY_PII_WORD_RE = new RegExp([
  // 勤め先・職業・収入
  "勤務先", "勤め先", "お勤め", "勤続", "会社名", "職業", "職種", "正社員", "契約社員", "派遣社員", "アルバイト", "パート勤務", "自営業", "個人事業", "無職",
  "年収", "月収", "手取り", "収入", "給与", "給料", "賞与", "源泉", "預金", "貯金", "残高",
  // 信用
  "借入", "借り入れ", "ローン", "滞納", "延滞", "債務", "破産", "信用情報", "ブラックリスト",
  // 保証人・連絡先・身元
  "緊急連絡先", "連帯保証(?!人?(?:不要|なし|無し))", "保証人(?!不要|なし|無し)", "生年月日", "\\d+\\s*歳", "住民票", "本籍", "免許証", "保険証", "マイナンバー", "健康保険", "パスポート",
  "在留", "ビザ", "国籍", "続柄", "現住所", "印鑑証明", "電話番号", "メールアドレス",
].join("|"));

/** 要約だけに当てる語（家族構成）。線より後にブレインが作った物には当てない（申込の前から会話に出る部屋探しの前提のため） */
export const APPLY_SUMMARY_FAMILY_RE = /配偶者|奥様|旦那|妻|夫婦|婚約|子供|子ども|お子様|家族構成|扶養|同居人|ご家族|ご両親|父親|母親/;

/** maskForEmbedding が置いた伏せ字の印（＝元の文に個人情報の形があった） */
// ⚠ 「[日付非表示]」は数えない: maskForEmbedding は西暦つきの日付を全部伏せる（入居日・内覧日・記録の時刻まで当たる）。
//   生年月日は pii-pseudonym の網（ラベル・「〜日生」・昭和平成・十分に昔の西暦）で見る
const MASK_TOKENS = ["[電話番号非表示]", "[メールアドレス非表示]", "[郵便番号非表示]", "[回答済み・非表示]", "[番号非表示]"];
/** UUID（template_id 等）は網に当てる前に外す（数字の並びが郵便番号の形に当たる・実測34件） */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** 記録の時刻（ISO）は個人情報ではない（analyzed_msg_ts・updated_at）。網に当てる前に外す */
const ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;

export type PiiCheckContext = {
  /** 仮名化の種（会話 ID）。検査では仮名は使わない */
  conversationId: string;
  /** 当事者の呼び名（LINE の表示名）と登録名 */
  customerName?: string | null;
  partyAliases?: ReadonlyArray<string>;
  /** 他のお客様の名前（事例に出る名前の一覧と同じ） */
  knownNames?: ReadonlyArray<string>;
  /** 線より前のお客様の発言の断片（post-apply.preCutoffChunks）。そのまま写していないか */
  netChunks?: ReadonlyArray<string>;
};

export type PiiCheckOptions = {
  /** 名前（当事者・他のお客様・敬称つき）も見る。要約は true。ブレインの判断は false（名前は後段の読み替えが伏せる） */
  names: boolean;
  /** 家族構成の語も見る（要約だけ） */
  family: boolean;
};

/**
 * 文に個人情報が入っていないかの決定論の検査。理由（本文は含めない）を返す。空＝通った。
 * 語・伏せ字の網・読み替えの網・出口の網の4つを当てる。
 */
export function piiReasons(text: string | null | undefined, ctx: PiiCheckContext, opts: PiiCheckOptions): string[] {
  const t = String(text ?? "").replace(ISO_TS_RE, " ").replace(UUID_RE, " ");
  if (!t.trim()) return [];
  const out = new Set<string>();
  const w = t.match(APPLY_PII_WORD_RE);
  if (w) out.add(`word:${w[0].replace(/\d+/g, "N")}`);
  if (opts.family) { const f = t.match(APPLY_SUMMARY_FAMILY_RE); if (f) out.add(`family:${f[0]}`); }
  // pii-mask の網（電話・メール・郵便番号・申込の欄の値・生年月日・12桁の番号）。日付の丸め（9月15日→9月中）は個人情報ではないので見ない
  const masked = maskForEmbedding(t);
  for (const tok of MASK_TOKENS) if (masked.includes(tok) && !t.includes(tok)) out.add(`mask:${tok.slice(1, -1)}`);
  // 敬称つきの名前（maskPII が「お客様」に置き換えた数が増えた＝〇〇様/さん があった）
  if (opts.names) {
    const n0 = (t.match(/お客様/g) ?? []).length, n1 = (masked.match(/お客様/g) ?? []).length;
    if (n1 > n0) out.add("mask:敬称つきの名前");
  }
  // pii-pseudonym の網（当事者・他のお客様の名前・携帯・生年月日・現住所・勤務先・申込フォームの記入）
  if (isApplicationPayload(t)) out.add("pseudonym:申込フォーム");
  const m = createMasker({
    conversationId: ctx.conversationId || "check",
    customerName: opts.names ? ctx.customerName ?? null : null,
    partyAliases: opts.names ? ctx.partyAliases ?? [] : [],
    knownNames: opts.names ? ctx.knownNames ?? [] : [],
  });
  const masked2 = m.mask(t);
  const kinds = new Set<MaskKind>(m.table().map((e) => e.kind));
  for (const k of kinds) if (opts.names || k !== "name") out.add(`pseudonym:${k}`);
  if (masked2 === APPLICATION_FORM_PLACEHOLDER) out.add("pseudonym:申込フォーム");
  // 出口の網（線より前のお客様の発言をそのまま写していないか）
  if (ctx.netChunks && ctx.netChunks.length > 0 && countCutoffLeaks(t, ctx.netChunks) > 0) out.add("net:線より前の発言の写し");
  return [...out];
}

// ─── Claude への指示（固定の前置き） ───────────────────────────────────────────────
export const APPLY_SUMMARY_SYSTEM = `あなたは賃貸仲介の LINE 会話の記録係です。お客様が「申込」をしてから、審査否決・キャンセル等で申込前の段階（物件提案中）に戻るまでの「申込期間」のやり取りを読み、
この後の担当（別の AI）が会話を続けるのに必要な要点だけを、個人情報を一切含めずにまとめます。別の AI には申込期間のやり取りそのものは渡りません。あなたのまとめだけが渡ります。

【入れてよいもの（これだけ）】
- 申込した物件: 建物名と号室だけ（例「グランパシフィック花園 1006号室」）
- 結果: 次から1つ選ぶ → 審査否決 / キャンセル / 取り下げ / 他で決定 / 不明
- 否決の理由: 結果が審査否決の時だけ、次から1つ選ぶ → 保証会社の審査 / オーナー審査 / 管理会社の審査 / 不明（理由の中身・事情は書かない）
- 申込期間中にお客様が言った部屋の好み・要望（間取り・エリア・家賃・設備・入居時期など、部屋探しの条件だけ）
- こちら（スタッフ）がお客様にした約束（例「別の物件を探してお送りする」「否決になった保証会社以外の物件を探す」）
- 次にやること（例「条件に合う別の物件をピックアップして送る」）
※ 期間の最後に、会話は申込前の段階（物件提案中）に戻っています。約束・次にやることは**戻った後も有効な物だけ**書く。
  申込の手続き（書類・申込情報の受け取り、審査の結果待ち）に関する物は書かない。

【絶対に入れないもの】
名前（お客様・保証人・家族・スタッフの名前すべて。「お客様」とだけ書く）・電話番号・メールアドレス・住所・生年月日・年齢・
勤務先・職業・雇用形態・年収・収入・貯金・借入・滞納・信用情報・家族構成・同居人・続柄・保証人・緊急連絡先・在留資格・国籍・
本人確認書類・収入証明書・申込書の中身、否決の具体的な事情、保証会社の名前・種類（「否決になった保証会社」とだけ書く）。
これらの語そのもの（例「年収」「勤務先」「保証人」「家族」）も書かない。お客様の発言をそのまま引用しない（言い換えて短く）。
敬称つきの呼び名（〇〇様・〇〇さん）を書かない。分からない欄は空にする（推測で埋めない）。

【出力】次の JSON だけを返す（前後に文を書かない・コードブロックにしない）。各配列は最大5件・1件40字以内。
{"properties":["建物名 号室"],"outcome":"審査否決","reason":"保証会社の審査","preferences":["..."],"promises":["..."],"next_steps":["..."]}`;

/** 要約に渡す1通（created_at 昇順で渡す） */
export type ApplyPeriodMessage = { created_at: string; sender: string; text: string | null; image_type?: string | null };

/**
 * 申込フォームの続き（2通目以降）の指紋。isApplicationPayload は1通目（氏名・フリガナ…が並ぶ）は拾うが、
 * 続きの通（「居住年数 ４年 … 年収 … 勤続 …」「勤務先 … 年収 … 勤続 …」）は拾えない（2026-09-27 実物: 戻した8会話で2通）。
 * 実物では続きの通の「現住所の建物名＋号室」を Haiku が「申込した物件」として書いた（＝お客様の住所がまとめに入った）。
 * 申込期間のお客様の発言は、欄の語が2つ以上あれば中身ごと落とす（要約の入力だけ・ここは申込期間なので誤って落としても失うのは申込の手続きの話）
 */
const FORM_FIELD_RE = /氏名|フリガナ|生年月日|現住所|居住年数|続柄|勤務先|勤め先|年収|月収|勤続|緊急連絡先|保証人|本籍|職業|雇用形態|入居者/g;
export function isApplicationFieldMessage(text: string | null | undefined): boolean {
  return new Set(String(text ?? "").match(FORM_FIELD_RE) ?? []).size >= 2;
}

/** 入力を作る前に伏せる（Claude が見ない物は漏れようがない）。申込フォームの記入は丸ごと落とす・証明書類は種類の名前のまま */
export function prepareApplyPeriodInput(msgs: ReadonlyArray<ApplyPeriodMessage>, opts: { names?: ReadonlyArray<string>; maxChars?: number; perMessageChars?: number } = {}): { text: string; staffText: string; used: number; total: number } {
  const maxChars = opts.maxChars ?? 16_000, per = opts.perMessageChars ?? 400;
  const names = (opts.names ?? []).filter((s) => (s ?? "").trim().length >= 2);
  const lines: string[] = [];
  const staffLines: string[] = [];
  for (const m of msgs) {
    const raw = String(m.text ?? "").trim();
    if (!raw) continue;
    const who = m.sender === "customer" ? "お客様" : m.sender === "staff" ? "スタッフ" : m.sender;
    let body: string;
    if (isApplicationPayload(raw) || (m.sender === "customer" && isApplicationFieldMessage(raw))) body = m.sender === "customer" ? "[お客様が申込フォームに記入して送信（中身は非表示）]" : "[申込フォーマットを送付]";
    else {
      body = maskForEmbedding(raw);
      for (const n of names) body = body.split(n.trim()).join("お客様");
    }
    body = body.replace(/\s+/g, " ").slice(0, per);
    const d = new Date(m.created_at);
    const ts = Number.isFinite(d.getTime()) ? `${d.getUTCMonth() + 1}/${d.getUTCDate()}` : "";
    lines.push(`[${ts} ${who}] ${body}`);
    // 物件名の根拠にしてよい発言: スタッフの発言と、お客様が物件を送ってきた通（ポータルのリンク・物件情報の貼り付け）だけ
    if (m.sender !== "customer" || /https?:\/\/|【物件情報】|物件名[：:]/.test(raw)) staffLines.push(body);
  }
  // 新しい方を優先して上限まで（結果と次にやることは期間の終わりにある）
  const out: string[] = [];
  let n = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (n + lines[i].length + 1 > maxChars) break;
    out.unshift(lines[i]); n += lines[i].length + 1;
  }
  return { text: out.join("\n"), staffText: staffLines.join("\n"), used: out.length, total: lines.length };
}

export function buildApplySummaryUserText(prepared: string): string {
  return `【申込期間のやり取り（古い順・個人情報の一部は伏せ字）】\n${prepared}\n\n上の決まりに従って JSON だけを返してください。`;
}

// ─── 出力を形にする（選択肢の外・長すぎる物は捨てる） ─────────────────────────────────
const clip = (s: unknown): string | null => {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  if (!t) return null;
  return t.length > MAX_ITEM_CHARS ? null : t; // 長い＝指示に従っていない。切って残すと途中の中身が残るので捨てる
};
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(clip).filter((x): x is string => !!x).slice(0, MAX_ITEMS) : []);

/** Claude の返答（JSON の文字列）を形にする。読めなければ null */
export function parseApplySummary(raw: string | null | undefined): ApplyPeriodSummary | null {
  const s = String(raw ?? "").replace(/```(?:json)?/g, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  let j: Record<string, unknown>;
  try { j = JSON.parse(s.slice(a, b + 1)) as Record<string, unknown>; } catch { return null; }
  const outcome = (APPLY_OUTCOMES as readonly string[]).includes(String(j.outcome)) ? (j.outcome as ApplyOutcome) : "不明";
  const reason = outcome === "審査否決"
    ? ((REJECT_REASONS as readonly string[]).includes(String(j.reason)) ? (j.reason as RejectReason) : "不明")
    : null;
  return {
    properties: list(j.properties),
    outcome,
    reason,
    preferences: list(j.preferences),
    promises: list(j.promises),
    nextSteps: list(j.next_steps ?? j.nextSteps),
  };
}

const md = (iso: string | null | undefined): string => {
  const d = new Date(iso ?? "");
  if (!Number.isFinite(d.getTime())) return "";
  const j = new Date(d.getTime() + 9 * 3600_000);
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()}`;
};

/** DeepSeek に渡すブロック（決定論で組む）。中身が何も無ければ "" */
export function renderApplySummaryBlock(s: ApplyPeriodSummary, span: { from?: string | null; to?: string | null } = {}): string {
  const lines: string[] = [];
  if (s.properties.length) lines.push(`・申込した物件: ${s.properties.join("／")}`);
  lines.push(`・結果: ${s.outcome}${s.reason ? `（理由の区分: ${s.reason}）` : ""}`);
  if (s.preferences.length) lines.push(`・申込期間中のお客様のご希望: ${s.preferences.join("／")}`);
  if (s.promises.length) lines.push(`・こちらがした約束: ${s.promises.join("／")}`);
  if (s.nextSteps.length) lines.push(`・次にやること: ${s.nextSteps.join("／")}`);
  if (!s.properties.length && s.outcome === "不明" && !s.preferences.length && !s.promises.length && !s.nextSteps.length) return "";
  const range = span.from || span.to ? `（${md(span.from)}〜${md(span.to)}）` : "";
  return `\n【申込期間のまとめ（個人情報なし）${range}】\n※ 申込中のやり取りは個人情報を含むため渡していない。要点だけ。返信に申込中の細部（書類・審査の中身）を書かないこと\n${lines.join("\n")}\n`;
}

/** 申込の手続きの項目（個人情報ではないが、戻った後に DeepSeek が書類を再依頼する元になる）。項目ごと落とす */
export const APPLY_PROCEDURE_RE = /本人確認|身分証|収入証明|申込書|申込情報|申込フォーム|書類|審査結果(?:を|の)?待|審査の結果待/;
const normName = (s: string) => s.normalize("NFKC").replace(/[\s・\-ー－]/g, "").toLowerCase();

/**
 * 決定論の後処理（検査の前）: ①手続きの項目を落とす ②**スタッフの発言に無い**物件名を落とす。
 * ②の理由（2026-09-27 実物）: お客様の発言にしか無い建物名がお客様の現住所（申込フォームの続き）だった＝Haiku が
 *   「申込した物件: 〇〇 215号室」と書いた。物件はスタッフが出すか、お客様がポータルのリンク・物件情報で送ってくる物なので、
 *   根拠はその2つ（prepareApplyPeriodInput の staffText）に限る。作り話の歯止めにもなる。
 *   建物名（号室を外した形・空白や記号を詰める）の頭12字がスタッフの発言にあること。3字未満は根拠にしない
 * どちらも落としても要約そのものは渡す（個人情報の検査は checkApplySummary）
 */
export function tidyApplySummary(s: ApplyPeriodSummary, staffText: string): { summary: ApplyPeriodSummary; dropped: string[] } {
  const dropped: string[] = [];
  const keep = (label: string) => (x: string) => { if (APPLY_PROCEDURE_RE.test(x)) { dropped.push(`${label}:手続き`); return false; } return true; };
  const src = normName(staffText);
  const grounded = (p: string) => {
    const building = normName(p.replace(/\s*\d+\s*(?:号室|号|階|F)\s*$/i, "").replace(/\s*[0-9０-９]{2,4}\s*$/, ""));
    const head = building.slice(0, 12);
    const ok = head.length >= 3 && src.includes(head);
    if (!ok) dropped.push("properties:スタッフの発言に無い");
    return ok;
  };
  return {
    summary: {
      ...s,
      properties: s.properties.filter(keep("properties")).filter(grounded),
      preferences: s.preferences.filter(keep("preferences")),
      promises: s.promises.filter(keep("promises")),
      nextSteps: s.nextSteps.filter(keep("nextSteps")),
    },
    dropped,
  };
}

/** 要約の全ての自由文を検査する（名前・家族構成・保証会社の名前も見る）。空＝通った */
export function checkApplySummary(s: ApplyPeriodSummary, ctx: PiiCheckContext): string[] {
  const texts = [...s.properties, ...s.preferences, ...s.promises, ...s.nextSteps];
  const out = new Set<string>();
  for (const t of texts) for (const r of piiReasons(t, ctx, { names: true, family: true })) out.add(r);
  // どの保証会社で否決になったかは信用の情報（区分だけにする決まり）。種類の語も同じ
  for (const t of texts) { if (detectGuarantorInText(t)) out.add("guarantor:会社名"); if (/信販系|信用系|独立系|LICC/i.test(t)) out.add("guarantor:種類"); }
  // 並べた全体でも見る（欄をまたいだ断片・電話番号の分割）
  for (const r of piiReasons(texts.join(" "), ctx, { names: true, family: true })) out.add(r);
  return [...out];
}

// ─── 残る穴: 線より後にブレインが全履歴から作った物（判断・会話の方向・要約・セーブデータ） ─────────────
/**
 * 線より後にブレイン（Claude）が全履歴から作った物は、申込中の事実を言い換えて持ち越しうる。
 * DeepSeek に渡す時だけ、文字の欄を1つずつ検査して**引っかかった欄だけ落とす**（構造・選択肢の欄はそのまま）。
 * 名前は見ない（後段の読み替え pii-pseudonym が伏せる）・家族構成も見ない（申込の前から部屋探しの前提として会話に出る）。
 * 費用 0（決定論）。作り直し（Claude で線より後だけから作る）は費用が会話ごとに毎回かかるので採らない（報告の判断）。
 */
export function scrubDerivedForDeepseek<T>(value: T, ctx: Omit<PiiCheckContext, "netChunks"> = { conversationId: "derived" }): { value: T; dropped: number } {
  let dropped = 0;
  const bad = (s: string) => piiReasons(s, ctx, { names: false, family: false }).length > 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 8) return v;
    if (typeof v === "string") return bad(v) ? undefined : v;
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const x of v) { const y = walk(x, depth + 1); if (y === undefined) { dropped++; continue; } out.push(y); }
      return out;
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        // 記録の鍵（ID・時刻）は中身ではない
        if (/(?:^|_)id$|_at$|_ts$/.test(k)) { out[k] = x; continue; }
        const y = walk(x, depth + 1);
        if (y === undefined && x !== undefined) { dropped++; out[k] = null; continue; }
        out[k] = y;
      }
      return out;
    }
    return v;
  };
  if (typeof value === "string") {
    // 文（セーブデータ等）は行ごとに落とす
    const lines = value.split("\n");
    const kept = lines.filter((l) => !bad(l));
    dropped = lines.length - kept.length;
    return { value: kept.join("\n") as unknown as T, dropped };
  }
  const v = walk(value, 0);
  return { value: (v === undefined ? null : v) as T, dropped };
}
