// scripts/lib/brain-exam-score.ts — ブレインの試験（scripts/brain-exam.ts）の決まった計算（純関数・DB も LLM も呼ばない）
//
// 2026-10-08 竹内さん「ブレインの読み違いを極力無くすために細部までこだわる」①: 読み違えた実例を正解つきの試験問題にし、
//   ブレインを直すたびに全部解かせて前より悪くならないか確かめる。
// ここで決めるのは「ブレインの出力 → 道の符号」と「正解の符号との一致」だけ。言葉の中身（asks・言ってはいけない事）は DeepSeek の判定（brain-exam.ts）。
//
// 道の符号（正解の accept / mustNot と同じ語彙）:
//   "返信"            … 返信の本文で答える（約束なし）
//   "2段" / "2段:<種類>" … 約束の返信（pickup＝ピックアップ／check＝確認／estimate＝見積／photo＝撮影）。結果は後で AIX
//   "なし"            … お客様の連絡待ち（送らない）
//   "AIX" / "AIX:<action>" / "AIX:<action>/<ピッカー>" … AIX の番。"AIX:物件" は物件の族（property_send/recommendation/pickup/search）
// ブレインの出力の読み方は scripts/audit-r10-path-truth.ts（10巡目の正解の表）と同じ:
//   reply_mode=aix かつ action → AIX／two_stage → 2段／初回の first_contact_pickup → 2段／reply_direction の定型の書き出し → 2段・なし・返信
import { topicKey } from "../../app/lib/aix-catalog";

export type BrainExamOutput = {
  reply_mode?: string | null; action?: string | null; check_pattern?: string | null;
  two_stage?: string | null; reply_direction?: string | null; first_contact_pickup?: string | null;
  alt_actions?: string[] | null;
};
export type PathCode = {
  /** 正解の accept に当てる符号（1つ目が主）。曖昧な書き出しは複数 */
  codes: string[];
  /** mustNot に当てる符号（曖昧な時は空＝外れにしない） */
  hard: string[];
  /** 表示用 */
  label: string;
};

const PROP = /^property_(?:send|recommendation|pickup|search)$/;
/** 同じ族として扱う（物件確認した＝反応確認・物件の4種） */
export function aixFamily(action: string): string {
  if (PROP.test(action)) return "物件";
  if (action === "acknowledge_check") return "property_check_result";
  return action;
}

/** reply_direction の定型の書き出しから道を読む（audit-r10-path-truth.brainNullPath と同じ線） */
export function pathOfDirection(dir: string): { path: string; kind: string } {
  if (/ピックアップしてお送りすると約束/.test(dir)) return { path: "2段", kind: "pickup" };
  if (/送ってきた物件の募集状況を確認し|募集状況と最大限割引した初期費用の御見積書をお送りすると約束/.test(dir)) return { path: "2段", kind: "check" };
  if (/室内の写真はスタッフが撮影/.test(dir)) return { path: "2段", kind: "photo" };
  if (/内覧を希望している/.test(dir) && /確認/.test(dir)) return { path: "2段", kind: "check" };
  if (/御見積書を作成しお送りすると約束/.test(dir)) return { path: "2段", kind: "estimate" };
  if (/^お客様に聞かれた事に答える返信/.test(dir)) return { path: "返信|2段", kind: "check" };
  if (/(?:募集状況|聞かれた事).{0,30}確認すると約束する返信/.test(dir)) return { path: "2段", kind: "check" };
  if (/^お客様の連絡待ち/.test(dir)) return { path: "なし", kind: "" };
  return { path: "返信", kind: "" };
}

export function brainPathCode(b: BrainExamOutput | null | undefined): PathCode {
  if (!b) return { codes: ["(なし: ブレインが null)"], hard: [], label: "ブレインが null" };
  const action = (b.action ?? "").trim();
  if (b.reply_mode === "aix" && action) {
    const fam = aixFamily(action);
    const cp = (b.check_pattern ?? "").trim();
    const base = fam === "property_check_result" ? `AIX:${topicKey(`property_check_result/${cp}`)}` : `AIX:${action}`;
    const codes = [base, `AIX:${fam}`, "AIX"];
    return { codes: [...new Set(codes)], hard: [...new Set(codes)], label: cp ? `AIX:${action}/${cp}` : `AIX:${action}` };
  }
  const ts = (b.two_stage ?? "").trim();
  if (ts) return { codes: [`2段:${ts}`, "2段"], hard: [`2段:${ts}`, "2段"], label: `2段:${ts}` };
  if (b.first_contact_pickup) {
    const k = b.first_contact_pickup === "property_check_result" ? "check" : "pickup";
    return { codes: [`2段:${k}`, "2段"], hard: [`2段:${k}`, "2段"], label: `2段:${k}（初回）` };
  }
  const d = pathOfDirection(String(b.reply_direction ?? ""));
  if (d.path === "返信|2段") return { codes: ["返信", `2段:${d.kind}`, "2段"], hard: [], label: "返信（分からない事は確認の約束）" };
  if (d.path === "2段") return { codes: [`2段:${d.kind}`, "2段"], hard: [`2段:${d.kind}`, "2段"], label: `2段:${d.kind}` };
  if (d.path === "なし") return { codes: ["なし"], hard: ["なし"], label: "なし（連絡待ち）" };
  return { codes: ["返信"], hard: ["返信"], label: "返信" };
}

/** 正解の1つの符号に、ブレインの符号のどれかが当たるか */
export function codeMatches(want: string, have: ReadonlyArray<string>): boolean {
  const w = want.trim();
  if (!w) return false;
  if (w.startsWith("AIX:") && !w.startsWith("AIX:物件")) {
    // "AIX:property_check_result/募集状況" 等は topicKey に揃えて比べる。"AIX:acknowledge_check" は物件確認した の族
    const body = w.slice(4);
    const [a, p] = body.split("/");
    const fam = aixFamily(a);
    if (p) return have.includes(`AIX:${topicKey(`${fam}/${p}`)}`) || have.includes(`AIX:${fam}/${p}`);
    return have.includes(`AIX:${a}`) || have.includes(`AIX:${fam}`);
  }
  return have.includes(w);
}

export type PathVerdict = { ok: boolean; acceptHit: string | null; mustNotHit: string | null };
export function judgePath(code: PathCode, accept: ReadonlyArray<string>, mustNot: ReadonlyArray<string> = []): PathVerdict {
  const acceptHit = accept.find((a) => codeMatches(a, code.codes)) ?? null;
  const mustNotHit = mustNot.find((m) => codeMatches(m, code.hard)) ?? null;
  return { ok: !!acceptHit && !mustNotHit, acceptHit, mustNotHit };
}

/** 1問の合否（道・asks・言ってはいけない事）。判定が無い項目（DeepSeek を回さなかった）は数えない */
export type ProblemScore = { path: boolean; asks: { hit: number; n: number } | null; ng: { ok: number; n: number } | null; pass: boolean };
export function problemScore(path: PathVerdict, asks: ReadonlyArray<boolean> | null, ngViolated: ReadonlyArray<boolean> | null): ProblemScore {
  const a = asks ? { hit: asks.filter(Boolean).length, n: asks.length } : null;
  const g = ngViolated ? { ok: ngViolated.filter((v) => !v).length, n: ngViolated.length } : null;
  const pass = path.ok && (!a || a.hit === a.n) && (!g || g.ok === g.n);
  return { path: path.ok, asks: a, ng: g, pass };
}

/**
 * 2026-10-09 主語の抜け: ブレインの current_property が正解の建物を指しているか（号室・括弧の読み仮名・空白・濁点の揺れは同じ）。
 * 正解が無い問題は null（数えない）。読み取りの化け（1〜2字）は名前の近さ 0.75 以上で同じ。
 */
export function judgeCurrentProperty(expected: string | null | undefined, have: string | null | undefined, sim: (a: string, b: string) => number): boolean | null {
  const norm = (s: string) => s.normalize("NFKC").replace(/[（(][^）)]*[）)]/g, "").replace(/\s*[0-9０-９]{2,4}\s*号室?.*$/, "").replace(/[\s・･\-ー〜~]/g, "").normalize("NFD").replace(/[゙゚]/g, "").normalize("NFC").toLowerCase();
  if (!expected?.trim()) return null;
  const e = norm(expected), h = norm(have ?? "");
  if (!h) return false;
  if (e.includes(h) || h.includes(e)) return true;
  return sim(e, h) >= 0.75;
}

/** 型ごとの正答率（tags も型として数える） */
export function rateByType(rows: ReadonlyArray<{ type: string; tags?: string[]; score: ProblemScore }>): Array<{ type: string; n: number; pass: number; path: number; asksHit: number; asksN: number }> {
  const m = new Map<string, { n: number; pass: number; path: number; asksHit: number; asksN: number }>();
  const add = (t: string, s: ProblemScore) => {
    const x = m.get(t) ?? { n: 0, pass: 0, path: 0, asksHit: 0, asksN: 0 };
    x.n++; if (s.pass) x.pass++; if (s.path) x.path++;
    if (s.asks) { x.asksHit += s.asks.hit; x.asksN += s.asks.n; }
    m.set(t, x);
  };
  for (const r of rows) { add(r.type, r.score); for (const t of r.tags ?? []) if (t !== r.type) add(`（札）${t}`, r.score); }
  return [...m].map(([type, v]) => ({ type, ...v })).sort((a, b) => (a.type.startsWith("（札）") === b.type.startsWith("（札）") ? b.n - a.n : a.type.startsWith("（札）") ? 1 : -1));
}
