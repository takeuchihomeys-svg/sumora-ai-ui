// scripts/lib/exam-aix-text.ts — 試験の「AIX の文」の段（純関数・DB/LLM なし・単体テスト scripts/lib/__tests__/exam-aix-text.test.ts）
//
// 2026-10-22 試験のブレインの穴: ブレインの試験（scripts/brain-exam.ts）は「どのボタンか」までで、押した後の AIX の文（1通目・2通目・
//   ✨この会話に合った文）を作って採点する段が無かった＝AIX の文の質を測れなかった（前日は yuma-r11-aix-text.ts --toggle で竹内さんの2通目 22本を手で比べた）。
//   物差しは竹内基準（竹内さんが実際に送った AIX の通・messages.staff_writer='takeuchi'）。問題は scripts/exam-aix-text-build.ts、流すのは scripts/exam-aix-text.ts。
//
// 採点（決まった物差しが主・LLM の判定は曖昧な時だけ＝exam-aix-text.ts の lazy）:
//   ① 中身（content）: 竹内さんの文にあり、入力（会話・ピッカー・資料）にもある事実（金額・号室・日付・時刻・徒歩・築年 等）と物件名、
//      訴求（オススメの理由）・ご査収・締め（申込へ／内覧へ／質問／何卒）・呼びかけが生成にあるか
//   ② 作り事（fabrication）: 生成の事実・物件名で、入力に無い物（竹内さんの文にあっても入力に無い物は「作れない」＝作り事に数える）
//   ③ 形（structure）: 行ごとの段（冒頭・見出し・事実・箇条・訴求・誘導・質問・査収・締め）の並びの近さ（LCS）
//   ④ 近さ（similarity）: 本文の芯の dice（text-diff-types）
//   ⑤ スタッフだけが知る事（staffOnly）: 募集中・募集終了・退去予定・入居時期・内覧可否・割引・確認済み は AIX の入力（ピッカー・資料）で渡す物。
//      入力にあって竹内さんも書いた物が生成に無い＝抜け／入力にも竹内さんの文にも無い物を生成が言う＝根拠の無い断定
import { createHash } from "node:crypto";
import { coreOf, dice } from "../../app/lib/text-diff-types";
import { shiftDatesInText } from "./scenario-date-shift";

export type AixTextKind = "aix" | "tpl" | "second";
export const KIND_JA: Record<AixTextKind, string> = { aix: "1通目（AIX の本文）", tpl: "この会話に合った文", second: "2通目（この会話に合った文）" };
export const BUTTON_JA: Record<string, string> = {
  estimate_sheet: "見積書", property_recommendation: "物件オススメ", property_check_result: "物件確認した", property_send: "ピックアップ",
  viewing_invite: "内覧日調整", meeting_place: "待ち合わせ", application_push: "申込へ",
};
export type AixQuestion = {
  id: string; aixType: string; button: string; picker: string | null; kind: AixTextKind;
  route: "aix/action" | "aix-template-generate";
  /** 本番の生成の入口に渡す本文（会話は伏せ済み・名前は YUMA。conversation_id は流す時に試験の会話に差し替える） */
  body: Record<string, unknown>;
  /** 竹内さんが送った文（伏せ済み・正解） */
  gold: string;
  /** 入力に入っている文字（作り事の点検の元・伏せ済み） */
  inputText: string;
  at: string; src: string;
  /** 問題の中身の印（本文＋正解・使い回しの鍵） */
  hash: string;
};

export const questionHash = (q: Pick<AixQuestion, "route" | "body" | "gold">) =>
  createHash("sha256").update(stable({ r: q.route, b: q.body, g: q.gold })).digest("hex").slice(0, 16);
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

const N = (t: string) => String(t ?? "").normalize("NFKC");
const squash = (t: string) => N(t).replace(/[\s　・()（）「」『』【】🌟,，]/g, "").toLowerCase();

// ─── 事実 ─────────────────────────────────────────────────────────────
export const FACT_RES: Array<[string, RegExp]> = [
  ["日付", /(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?/g],
  ["時刻", /(\d{1,2})[:：](\d{2})/g],
  ["金額", /([\d,]{3,})\s*円/g],
  ["号室", /(\d{2,4})\s*号室/g],
  ["徒歩", /徒歩\s*(\d{1,2})\s*分/g],
  ["階", /(\d{1,2})\s*階/g],
  ["築年", /((?:19|20)\d{2})\s*年\s*(?:\d{1,2}\s*月)?\s*築|築\s*(\d{1,2})\s*年/g],
  ["広さ", /(\d{1,3}(?:\.\d{1,2})?)\s*(?:帖|畳|㎡)/g],
  ["件数", /(\d{1,2})\s*件/g],
];
export function factsOf(t: string): Map<string, Set<string>> {
  const s = N(t);
  const out = new Map<string, Set<string>>();
  for (const [k, re] of FACT_RES) {
    const set = new Set<string>();
    for (const m of s.matchAll(re)) {
      const v = m.slice(1).filter(Boolean).map((x) => x.replace(/,/g, "").replace(/^0+(?=\d)/, "")).join("/");
      if (v) set.add(v);
    }
    if (set.size) out.set(k, set);
  }
  return out;
}
/** 値が入力にあるか（同じ種類の値・または数字の並びが入力の数字に現れる） */
function factInInput(kind: string, v: string, inFacts: Map<string, Set<string>>, inDigits: string): boolean {
  if (inFacts.get(kind)?.has(v)) return true;
  // 金額は「10万円」「100,000円」の言い方の違い・号室は「101」だけの書き方があるので数字で探す
  const parts = v.split("/");
  if (kind === "日付") return new RegExp(`(?<!\\d)0?${parts[0]}\\s*[/月]\\s*0?${parts[1]}(?!\\d)`).test(inDigits);
  if (kind === "時刻") return new RegExp(`(?<!\\d)0?${parts[0]}\\s*[:：時]\\s*${parts[1] === "0" ? "00?" : parts[1].padStart(2, "0")}(?!\\d)`).test(inDigits) || (parts[1] === "0" && new RegExp(`(?<!\\d)0?${parts[0]}\\s*時(?!\\s*\\d)`).test(inDigits));
  if (kind === "金額") { const n = Number(parts[0]); if (n >= 10000 && n % 10000 === 0 && new RegExp(`(?<!\\d)${n / 10000}(?:\\.0)?\\s*万`).test(inDigits)) return true; if (n >= 1000 && n % 1000 === 0 && new RegExp(`(?<![\\d.])${n / 10000}\\s*万`).test(inDigits)) return true; }
  return new RegExp(`(?<![\\d.])${parts.join("\\D{1,3}")}(?![\\d])`).test(inDigits);
}

// ─── 物件名 ───────────────────────────────────────────────────────────
const ROOM_NAME_RE = /([^\s　、。！!？?「」【】🌟・:：\n（(]{2,30}?)[\s　]*(\d{2,4}[A-Za-z]?)\s*号室/g;
export function propNamesOf(t: string): string[] {
  const s = N(t);
  const out = new Set<string>();
  // 「10/24 12:00にレオン… 1301号室」「中でも特にリンクハウス… 502号室」: 助詞の後ろを名前にする（物件名に「に・は・が・で・を」はほぼ無い）
  for (const m of s.matchAll(ROOM_NAME_RE)) { const nm = (m[1].split(/さん|様|[にはがでを、]|(?:頂|いただ)?きました|ました|します|した/).pop() ?? "").replace(/^[\d/:：\-]+/, "").replace(/^(?:の|特に|中でも)/, "").trim(); if (nm.length >= 2 && !/^(?:お部屋|こちら|同じ|別の|その|この|現在|只今|今回|全て|全部)$|^(?:お部屋|こちら|同じ|別の|その|この)/.test(nm)) out.add(nm); }
  for (const m of s.matchAll(/【([^】]{2,40})】/g)) { const nm = m[1].replace(/\s*\d{2,4}[A-Za-z]?\s*号?室?$/, "").trim(); if (nm.length >= 2 && !/欄$|記入欄|AIX|お客様|オススメ|ポイント/.test(nm)) out.add(nm); }
  for (const m of s.matchAll(/🌟\s*([^\n🌟]{2,40}?)\s+\d{2,4}[A-Za-z]?\s*$/gm)) out.add(m[1].trim());
  return [...out];
}

// ─── 訴求・締め・呼びかけ ─────────────────────────────────────────────────
export const APPEAL_RE = /オススメ|おすすめ|お勧め|好条件|条件のいい|条件の良い|充実|抑え(?:られ|る事|ることが)|築年数(?:も)?浅|新築|良好|人気|お得|最大限割引|魅力|ポイント|お安く|安心/;
const CLOSE_PARTS: Array<[string, RegExp]> = [
  ["申込へ", /お申込み?(?:し|で)?(?:て)?お部屋(?:を)?(?:抑|押)|お申込み?(?:は|の方)?(?:如何|いかが)|お申込(?:頂|いただ)ければ/],
  ["内覧へ", /ご都合(?:の)?よろしい(?:お日にち|日)|ご内覧|ご案内させて|ご案内可能/],
  ["質問", /でしょうか|ございますか|御座いますか|ですか[？?！!]/],
  ["査収", /ご査収/],
  ["何卒", /何卒|よろしくお願い/],
  ["お気軽に", /お気軽に/],
];
export function closePartsOf(t: string): string[] {
  const lines = N(t).split("\n").map((l) => l.trim()).filter(Boolean);
  const tail = lines.slice(-4).join("\n");
  return CLOSE_PARTS.filter(([, re]) => re.test(tail)).map(([k]) => k);
}
const callsName = (t: string) => /(?:^|\n)\s*YUMA\s*さん|YUMAさん/.test(N(t));

// ─── スタッフだけが知る事（AIX の入力で渡す物） ─────────────────────────────
export const STAFF_CLAIMS: Array<[string, RegExp]> = [
  ["募集中", /募集中|空いて(?:おり|い)|空室|ご紹介可能/],
  ["募集終了", /募集(?:が)?終了|埋まって|(?:お)?申込(?:み)?が入|成約(?:済|と)|ご紹介(?:が)?(?:出来|でき)な/],
  ["退去予定", /退去予定/],
  ["入居時期", /即入居|即日入居|入居可能日|(?:\d{1,2}月|上旬|中旬|下旬)(?:頃)?(?:から|より)(?:ご)?入居/],
  ["内覧可否", /内覧(?:可能|不可|が(?:出来|でき))|ご案内(?:が)?(?:可能|出来ます|できます|出来ません|できません)/],
  ["割引", /最大限割引|[\d,]+円(?:の)?割引|割引(?:させて|致し|して)/],
  ["確認済み", /確認(?:致し|させて頂き|させていただき)ました|確認が取れ|確認(?:致し|した)ところ/],
];
export function claimsOf(t: string): Set<string> { const s = N(t); return new Set(STAFF_CLAIMS.filter(([, re]) => re.test(s)).map(([k]) => k)); }
/** ピッカー・資料（本文の値）が示すスタッフだけが知る事（文字に出ない物） */
export function pickerClaims(body: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const cp = String(body.check_pattern ?? "");
  const st = Array.isArray(body.prop_statuses) ? (body.prop_statuses as unknown[]).map(String) : [];
  if (cp === "available" || st.includes("available")) { out.add("募集中"); out.add("確認済み"); }
  if (cp === "unavailable" || st.includes("unavailable") || st.includes("ended")) { out.add("募集終了"); out.add("確認済み"); }
  if (/^(?:mgmt_|vacate_date|other_room|nearby_parking)/.test(cp) || st.includes("alternative")) out.add("確認済み");
  if (/vacate/.test(cp)) out.add("退去予定");
  const est = body.parsed_estimate as { discount?: number } | undefined;
  if (est && Number(est.discount ?? 0) > 0) out.add("割引");
  if (String(body.action ?? body.actionType) === "estimate_sheet") out.add("割引"); // 御見積書は「最大限割引」で作る（竹内さんの定型）
  if (body.calendar_info) out.add("内覧可否");
  if (body.meeting_date || body.meeting_property_address) out.add("内覧可否");
  if (body.is_new_arrival || /新着|新規/.test(String(body.pickupType ?? body.send_mode ?? ""))) out.add("募集中");
  return out;
}

// ─── 形（行ごとの段） ────────────────────────────────────────────────────
export type Section = "冒頭" | "見出し" | "事実" | "箇条" | "訴求" | "誘導" | "質問" | "査収" | "締め" | "本文";
export function sectionsOf(t: string): Section[] {
  const lines = N(t).split("\n").map((l) => l.trim()).filter(Boolean);
  const out: Section[] = [];
  lines.forEach((l, i) => {
    let s: Section;
    if (i <= 1 && /^(?:YUMAさん|かしこまりました|承知|お世話になっております|夜分|ご連絡遅く|お待たせ)/.test(l) && l.length <= 40) s = "冒頭";
    else if (/ご査収/.test(l)) s = "査収";
    else if (CLOSE_PARTS[0][1].test(l) || CLOSE_PARTS[1][1].test(l)) s = "誘導";
    else if (/でしょうか|御座いますか|ございますか/.test(l)) s = "質問";
    else if (/^(?:【|🌟|①|②|③|（オススメポイント）)/.test(l)) s = "見出し";
    else if (/^[・\-]/.test(l)) s = "箇条";
    else if (APPEAL_RE.test(l)) s = "訴求";
    else if (factsOf(l).size || propNamesOf(l).length || /住所|募集|退去|号室/.test(l)) s = "事実";
    else if (/何卒|よろしくお願い|お気軽に/.test(l)) s = "締め";
    else s = "本文";
    if (out[out.length - 1] !== s) out.push(s);
  });
  return out;
}
export function lcsRatio<T>(a: T[], b: T[]): number {
  if (!a.length && !b.length) return 1;
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return (2 * dp[a.length][b.length]) / (a.length + b.length);
}

// ─── 採点 ─────────────────────────────────────────────────────────────
export type AixScore = {
  score: number; pass: boolean;
  content: number; structure: number; similarity: number;
  /** 竹内さんの文にあって生成に無い（入力で作れる物だけ） */
  missing: string[];
  /** 生成の事実・物件名で入力に無い物 */
  fabricated: string[];
  /** スタッフだけが知る事の点検の外れ */
  staffOnly: string[];
  /** 竹内さんの文にあるが入力に無い（作れない・参考） */
  unreachable: string[];
  goldSections: Section[]; genSections: Section[];
  /** LLM の判定（曖昧な時だけ・exam-aix-text.ts が足す） */
  judge?: { same: boolean; missing: string[]; extra: string[] } | null;
};
export const PASS_RULE = "中身 ≥ 0.75・作り事なし・スタッフだけが知る事の外れなし・形 ≥ 0.5（LLM の判定があれば「同じ要件」）";

export function scoreAixText(q: Pick<AixQuestion, "gold" | "inputText" | "body">, genRaw: string): AixScore {
  const gen = N(genRaw).trim(), gold = N(q.gold).trim();
  const input = N(q.inputText);
  const inFacts = factsOf(input), inDigits = input.replace(/,/g, "");
  const inSquash = squash(input);
  const missing: string[] = [], fabricated: string[] = [], staffOnly: string[] = [], unreachable: string[] = [];
  let need = 0, hit = 0;
  const gF = factsOf(gold), nF = factsOf(gen);
  // ① 事実
  for (const [k, vs] of gF) for (const v of vs) {
    if (k === "件数") continue; // 件数は言い方の揺れが大きい（数えない）
    if (!factInInput(k, v, inFacts, inDigits)) { unreachable.push(`${k}:${v}`); continue; }
    need++;
    if (nF.get(k)?.has(v) || factInInput(k, v, nF, gen.replace(/,/g, ""))) hit++; else missing.push(`${k}:${v}`);
  }
  // 物件名
  const genSq = squash(gen);
  for (const nm of propNamesOf(gold)) {
    if (!inSquash.includes(squash(nm))) { unreachable.push(`物件名:${nm}`); continue; }
    need++;
    if (genSq.includes(squash(nm))) hit++; else missing.push(`物件名:${nm}`);
  }
  // 訴求・締め・呼びかけ
  if (APPEAL_RE.test(gold)) { need++; if (APPEAL_RE.test(gen)) hit++; else missing.push("訴求"); }
  const gC = closePartsOf(gold), nC = new Set([...closePartsOf(gen), ...CLOSE_PARTS.filter(([, re]) => re.test(gen)).map(([k]) => k).filter((k) => k === "査収")]);
  for (const c of gC) { need++; if (nC.has(c)) hit++; else missing.push(`締め:${c}`); }
  if (callsName(gold)) { need++; if (callsName(gen)) hit++; else missing.push("呼びかけ（YUMAさん）"); }
  const content = need ? hit / need : 1;
  // ② 作り事
  for (const [k, vs] of nF) for (const v of vs) {
    if (k === "件数" || k === "階") continue;
    if (!factInInput(k, v, inFacts, inDigits)) fabricated.push(`${k}:${v}`);
  }
  for (const nm of propNamesOf(gen)) if (!inSquash.includes(squash(nm))) fabricated.push(`物件名:${nm}`);
  // ⑤ スタッフだけが知る事
  const inClaims = new Set([...claimsOf(input), ...pickerClaims(q.body)]);
  const gCl = claimsOf(gold), nCl = claimsOf(gen);
  for (const c of nCl) if (!inClaims.has(c) && !gCl.has(c)) staffOnly.push(`根拠なし:${c}`);
  for (const c of gCl) {
    if (!inClaims.has(c)) { unreachable.push(`スタッフだけ:${c}`); continue; }
    if (!nCl.has(c)) staffOnly.push(`抜け:${c}`);
  }
  // ③ ④
  const goldSections = sectionsOf(gold), genSections = sectionsOf(gen);
  const structure = lcsRatio(goldSections, genSections);
  const similarity = gen && gold ? dice(coreOf(gold), coreOf(gen)) : 0;
  const pass = !!gen && content >= 0.75 && !fabricated.length && !staffOnly.length && structure >= 0.5;
  const score = gen ? Math.round(100 * (0.35 * content + 0.15 * structure + 0.2 * similarity + 0.15 * (fabricated.length ? 0 : 1) + 0.15 * (staffOnly.length ? 0 : 1))) : 0;
  return { score, pass, content, structure, similarity, missing, fabricated, staffOnly, unreachable, goldSections, genSections };
}

/** LLM の判定が要るか（lazy）: 決まった物差しでは合格だが近さが低い（言い換えか要件の抜けか分からない）／中身が足りないが事実の抜けは無い */
export function needsJudge(s: AixScore): boolean {
  if (!s.genSections.length) return false;
  if (s.fabricated.length || s.staffOnly.length) return false;
  const factMiss = s.missing.some((m) => !/^(?:訴求|締め:|呼びかけ)/.test(m));
  if (s.pass && s.similarity < 0.35) return true;
  if (!s.pass && !factMiss && s.content >= 0.5) return true;
  return false;
}
/** 判定を入れた最終の合否 */
export function withJudge(s: AixScore, j: AixScore["judge"]): AixScore {
  if (!j) return { ...s, judge: j ?? null };
  const pass = !s.fabricated.length && !s.staffOnly.length && s.structure >= 0.5 && j.same && (s.content >= 0.5);
  return { ...s, judge: j, pass };
}
export const JUDGE_SYSTEM = `あなたは不動産仲介の LINE の文の採点者。【竹内さんの文】（正解）と【生成の文】を比べ、JSON だけを返す。
- same: 生成の文が竹内さんの文の要件（伝える事実・物件の訴求・お客様へのお願い・次の一歩の誘い）を欠けなく伝えていれば true（言い回し・順番・絵文字の違いは問わない）
- missing: 竹内さんの文にあって生成に無い要件（短く・最大4つ）
- extra: 生成だけが断定している事実（竹内さんの文にも入力にも無い物・最大4つ）
{"same":true|false,"missing":[],"extra":[]}`;
export function judgeUser(gold: string, gen: string): string { return `【竹内さんの文】\n${gold}\n\n【生成の文】\n${gen}`; }
export function parseJudge(o: Record<string, unknown> | null): AixScore["judge"] {
  if (!o || typeof o.same !== "boolean") return null;
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).slice(0, 4) : []);
  return { same: o.same, missing: arr(o.missing), extra: arr(o.extra) };
}

// ─── 集計・比べ ───────────────────────────────────────────────────────
export type AixRow = { id: string; hash: string; button: string; kind: AixTextKind; text: string; err: string | null; score: AixScore | null; inputSame?: boolean; calls?: number };
export function summarize(rows: AixRow[]): { n: number; pass: number; mean: number; byButton: Array<{ button: string; n: number; pass: number; mean: number }> } {
  const ok = rows.filter((r) => r.score);
  const by = new Map<string, AixRow[]>();
  for (const r of ok) { const k = r.button; by.set(k, [...(by.get(k) ?? []), r]); }
  const mean = (rs: AixRow[]) => (rs.length ? rs.reduce((s, r) => s + (r.score?.score ?? 0), 0) / rs.length : 0);
  return {
    n: ok.length, pass: ok.filter((r) => r.score!.pass).length, mean: mean(ok),
    byButton: [...by].map(([button, rs]) => ({ button, n: rs.length, pass: rs.filter((r) => r.score!.pass).length, mean: mean(rs) })).sort((a, b) => a.button.localeCompare(b.button)),
  };
}
export type AixDiff = { id: string; before: number; after: number; flip: "pass→fail" | "fail→pass" | null; inputSame: boolean };
export function compareRows(base: AixRow[], cur: AixRow[]): AixDiff[] {
  const m = new Map(base.map((r) => [`${r.id}|${r.hash}`, r]));
  const out: AixDiff[] = [];
  for (const r of cur) {
    const b = m.get(`${r.id}|${r.hash}`);
    if (!b?.score || !r.score) continue;
    const flip = b.score.pass && !r.score.pass ? "pass→fail" : !b.score.pass && r.score.pass ? "fail→pass" : null;
    out.push({ id: r.id, before: b.score.score, after: r.score.score, flip, inputSame: !!r.inputSame });
  }
  return out;
}

// ─── 問題の選び方（ボタンごとの数・ピッカーを散らす） ─────────────────────────────
export const DEFAULT_QUOTA: Record<string, number> = {
  "estimate_sheet:aix": 3, "estimate_sheet:second": 2,
  "property_recommendation:tpl": 2, "property_recommendation:second": 3,
  "property_check_result:aix": 5, "property_send:aix": 5,
  "viewing_invite:aix": 4, "meeting_place:aix": 4, "application_push:aix": 2,
};
/** 新しい順の候補から、枠ごとにピッカーを順に回して選ぶ（同じ正解の文は1つ） */
export function pickQuestions(cands: AixQuestion[], quota: Record<string, number> = DEFAULT_QUOTA): AixQuestion[] {
  const out: AixQuestion[] = [];
  const seenGold = new Set<string>();
  const sorted = [...cands].sort((a, b) => b.at.localeCompare(a.at));
  for (const [slot, n] of Object.entries(quota)) {
    const [type, kind] = slot.split(":");
    const pool = sorted.filter((q) => q.aixType === type && q.kind === kind);
    const byPicker = new Map<string, AixQuestion[]>();
    for (const q of pool) { const k = q.picker ?? "-"; byPicker.set(k, [...(byPicker.get(k) ?? []), q]); }
    const queues = [...byPicker.values()];
    let got = 0;
    for (let round = 0; got < n && queues.some((qq) => qq.length); round++) {
      for (const qq of queues) {
        if (got >= n) break;
        while (qq.length) {
          const q = qq.shift()!;
          const g = `${type}|${kind}|${squash(q.gold)}`;
          if (seenGold.has(g)) continue;
          seenGold.add(g); out.push(q); got++; break;
        }
      }
    }
  }
  return out;
}
/** 正解に使えない文（写真の案内だけ・URL だけ・短すぎ） */
export function goldUnusable(gold: string): string | null {
  const g = N(gold).trim();
  if (g.length < 25) return "短すぎ";
  if (/^（?室内イメージ）?/.test(g) && g.replace(/（?室内イメージ）?|〈URL〉|\s/g, "").length < 15) return "写真の案内だけ";
  if (g.replace(/〈URL〉|\s/g, "").length < 20) return "URL だけ";
  return null;
}

// ─── 2026-10-23 試験の穴の直し（確かめる人） ───────────────────────────────
// ① 内覧日調整・待ち合わせ: 竹内さんが送った時の日付（10/16 等）は試験の日には過去＝入口が過去の日付を作り直し（10/31 等）、作り事に数えた。
//    ブレインの段と同じく、問題の時刻から今日までの日数（曜日を変えない＝7の倍数に切り上げ）だけ、本文・会話・正解・入力の日付をずらす。
export const DATE_SHIFT_TYPES = new Set(["viewing_invite", "meeting_place"]);
//    「明日」「今日」等の言い方がある問題はちょうど今日へ（経った日数そのまま・曜日の括弧は shiftDatesInText が付け直す）＝試験の時計の「明日」と合う
export const RELATIVE_DAY_RE = /明日|明後日|本日|今日/;
export function aixShiftDays(q: Pick<AixQuestion, "aixType" | "at"> & Partial<Pick<AixQuestion, "body" | "gold">>, nowMs = Date.now()): number {
  if (!DATE_SHIFT_TYPES.has(q.aixType)) return 0;
  const jstDay = (ms: number) => Math.floor((ms + 9 * 3600_000) / 86_400_000);
  const diff = jstDay(nowMs) - jstDay(Date.parse(q.at));
  if (!Number.isFinite(diff) || diff <= 0) return 0;
  return RELATIVE_DAY_RE.test(`${JSON.stringify(q.body ?? {})}
${q.gold ?? ""}`) ? diff : Math.ceil(diff / 7) * 7;
}
/** 問題の日付を days 日ずらした写し（本文の文字の値・会話の text・正解・入力。時刻の印 createdAt 等は触らない） */
export function shiftQuestionDates<T extends Pick<AixQuestion, "body" | "gold" | "inputText" | "at">>(q: T, days: number): T {
  if (!days) return q;
  const year = new Date(Date.parse(q.at) + 9 * 3600_000).getUTCFullYear();
  const sh = (t: string) => shiftDatesInText(t, days, year);
  const walk = (v: unknown, key = ""): unknown => {
    if (typeof v === "string") return /^(?:createdAt|rawCreatedAt|created_at|at)$/.test(key) ? v : sh(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return { ...q, body: walk(q.body) as Record<string, unknown>, gold: sh(q.gold), inputText: sh(q.inputText) };
}
// ② 申込へ・フォーマット: 本番は入口を呼ばず画面が決まった記入欄を組む（AixModal.tsx・application-format.ts）＝入口を呼ぶと押す文が返った
export const isAppFormat = (q: Pick<AixQuestion, "aixType" | "body">) => q.aixType === "application_push" && q.body.app_sub_mode === "format";
