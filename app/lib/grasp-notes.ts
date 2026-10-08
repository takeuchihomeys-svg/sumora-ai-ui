// app/lib/grasp-notes.ts — 把握の候補（決定論・純関数）。scripts/audit-grasp-gaps.ts が実データで件数を数える。
//   2026-10-08 竹内「細かい部分に対応できるように、ブレインに足りていない部分があれば追加していく形で。今ある TPO の把握や日にちの把握みたいな形で」
//   ここは「数える物差し」。ブレイン・返信に渡す把握は、件数が多く線が引けた物だけ別の関数（customer-circumstances.ts 等）にする。

const norm = (s: string) => String(s ?? "").normalize("NFKC").replace(/[\s！!。、,.・😊😌🌟✨🙇‍♀️🙇‍♂️🙇🙏]+/gu, "").replace(/\p{Extended_Pictographic}/gu, "");
/** 定型（挨拶・締め・呼びかけ）は毎回書くので繰り返しに数えない */
const FORMULA_RE = /^(?:.{0,12}(?:さん|様))?(?:お世話になっております|何卒よろしくお願い(?:致|いた)します|よろしくお願い(?:致|いた)します|かしこまりました|はい|承知(?:致|いた)しました|ありがとうございます|ご連絡(?:頂|いただ)きありがとうございます|お手隙の際にご(?:査収|確認)(?:ください|下さい)|それでは一度失礼(?:致|いた)します)$/;
function bigrams(s: string): Set<string> { const o = new Set<string>(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o; }
function jaccard(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return 0;
  let x = 0; for (const g of A) if (B.has(g)) x++;
  return x / (A.size + B.size - x);
}

/** 文の並びのうち、こちらが前（windowDays 以内）に送った文とほぼ同じ物（定型は除く） */
export function repeatedFromBefore(sentences: string[], staffBefore: ReadonlyArray<{ text: string; createdAt: string }>, nowMs: number, windowDays = 14): string[] {
  const prior: string[] = [];
  for (const m of staffBefore) {
    if (nowMs - Date.parse(m.createdAt) > windowDays * 86_400_000) continue;
    for (const s of String(m.text ?? "").split(/\n+|(?<=[！!。])/)) { const n = norm(s); if (n.length >= 12) prior.push(n); }
  }
  const out: string[] = [];
  for (const s of sentences) {
    const n = norm(s);
    if (n.length < 12 || FORMULA_RE.test(n)) continue;
    if (prior.some((p) => p === n || p.includes(n) || jaccard(p, n) >= 0.75)) out.push(s.trim());
  }
  return out;
}

/** 同じ日（JST）に、この番より前にこちらが送った通の数 */
export function sameDayStaffCountBefore(staffBefore: ReadonlyArray<{ createdAt: string }>, nowMs: number): number {
  const day = (ms: number) => Math.floor((ms + 9 * 3600_000) / 86_400_000);
  return staffBefore.filter((m) => { const t = Date.parse(m.createdAt); return t < nowMs && day(t) === day(nowMs); }).length;
}

export type Circumstance = { kind: string; hit: string; staffEcho: RegExp };
const C: Array<{ kind: string; re: RegExp; echo: RegExp }> = [
  { kind: "予定・都合", re: /(?:以降|以後)(?:で|に|なら|じゃ|しか|でない|の)|(?:都合|予定)(?:が|つく|つか|合わ|あっ|入っ|詰ま)|仕事(?:が|で|中|終わ|帰り)|休み(?:が|の日|は)|出張|帰っ(?:て|たら)から|出先|夜勤|シフト|(?:土日|平日|週末)(?:しか|なら|が|は)|(?:行け|伺え)(?:ない|ません)|時間(?:が)?(?:取れ|とれ|作れ)/, echo: /以降|ご都合|お日にち|直近|オンライン|撮影|抑え|お仕事/ },
  { kind: "時期の事情（更新・退去・転勤・出産）", re: /更新(?:を|が|月|まで|せず|しない)|退去(?:可能|予告|通知|日|の連絡)|解約(?:予告|通知)|転勤|異動|移動先|入社|出産|卒業|契約(?:が|の)?(?:切れ|満了)/, echo: /更新|退去|転勤|移動|異動|ご出産|ご入居|月|日/ },
  { kind: "遠方・海外", re: /在住|遠方|県外|海外|帰国|(?:東京|広島|福岡|名古屋|岡山|九州|北海道|沖縄)(?:に|から|在|住)/, echo: /オンライン|撮影|ご帰国|遠方|写真/ },
  { kind: "同行者・決める人", re: /彼氏|彼女|主人|旦那|夫|妻|嫁|(?:両)?親|母|父|家族|同居人|パートナー|相方/, echo: /彼氏|彼女|ご主人|旦那|奥様|ご家族|ご両親|お母様|お父様|パートナー|お二人|ご相談/ },
  { kind: "他社・比較・迷い", re: /他(?:の)?(?:不動産|業者|会社)|他社|別の不動産|他で(?:も|は)?(?:見|聞|問い合わせ|言われ)|悩んで|迷って|比べ/, echo: /他社|仲介手数料|最大限|悩|迷|比較|ご判断/ },
  { kind: "体調・事情", re: /熱が|体調|入院|風邪|しんどい|忙しく|バタバタ/, echo: /お大事|ご無理|ご静養|落ち着/ },
];
export function customerCircumstances(text: string): Circumstance[] {
  const t = String(text ?? "").normalize("NFKC");
  // 条件のフォーム（①〜⑧）の中の家族構成は事情ではなく条件
  const body = /①|【ご入居の時期】/.test(t) ? "" : t;
  const out: Circumstance[] = [];
  for (const c of C) { const m = body.match(c.re); if (m) out.push({ kind: c.kind, hit: m[0], staffEcho: c.echo }); }
  return out;
}

export type StaffAction = { kind: "電話" | "内覧の当日（案内の後）"; staffEcho: RegExp };
/** お客様の番の直前のこちらの行い（電話・内覧の案内）— 会話の文から読める物だけ */
export function staffActionJustBefore(staffBefore: ReadonlyArray<{ text: string; createdAt: string }>, nowMs: number, custBefore: ReadonlyArray<{ text: string; createdAt: string }>): StaffAction | null {
  const within = (iso: string, h: number) => nowMs - Date.parse(iso) <= h * 3600_000;
  if (staffBefore.some((m) => within(m.createdAt, 6) && /お電話(?:させて|いたし|致し|します|大丈夫|可能|お待ち)|折り返しお電話/.test(m.text))
    || custBefore.some((m) => within(m.createdAt, 6) && /電話(?:大丈夫|いけ|可能|お願い|します|ください|出れ)/.test(m.text))) {
    return { kind: "電話", staffEcho: /お電話ありがとう|先程はお電話|お電話(?:頂|いただ)き/ };
  }
  const day = (ms: number) => Math.floor((ms + 9 * 3600_000) / 86_400_000);
  const today = staffBefore.find((m) => day(Date.parse(m.createdAt)) === day(nowMs) && /本日[^\n]{0,20}(?:\d{1,2}[:：時])[^\n]{0,20}(?:ご案内|ご内覧|内覧)/.test(m.text));
  if (today) {
    const hm = today.text.normalize("NFKC").match(/本日[^\n]{0,20}?(\d{1,2})[:時](\d{2})?/);
    const atMin = hm ? Number(hm[1]) * 60 + Number(hm[2] ?? 0) : null;
    const nowMin = new Date(nowMs + 9 * 3600_000).getUTCHours() * 60 + new Date(nowMs + 9 * 3600_000).getUTCMinutes();
    if (atMin != null && nowMin >= atMin + 30) return { kind: "内覧の当日（案内の後）", staffEcho: /お時間(?:頂|いただ)き|お越し(?:頂|いただ)き|ご内覧(?:頂|いただ)き|本日はありがとう/ };
  }
  return null;
}
