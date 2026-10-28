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
  /** 2択（AIX か返信か）をセットした番。2026-10-28: どちらかに竹内さんの動きが入れば合格（スタッフが押すだけで済む） */
  two_choice_mode?: boolean | null;
  two_choice_aix?: string | null;
  two_choice_check_pattern?: string | null;
};
export type PathCode = {
  /** 正解の accept に当てる符号（1つ目が主）。曖昧な書き出しは複数 */
  codes: string[];
  /** mustNot に当てる符号（曖昧な時は空＝外れにしない） */
  hard: string[];
  /** 表示用 */
  label: string;
};

/**
 * 2026-10-13 竹内さん（KAORI）＋決定（B）: 物件を探す番（一手が物件の AIX か全力サポート）は画面が左右の形で並べる（search-result-split）。
 *   左＝物件ピックアップ（複数）・物件オススメ（1件）は毎回。右＝全力サポートはブレインが候補にした番だけ（一手が全力サポートか、alt_actions に全力サポート）。
 *   その番の道の符号に足す: 右も並んだ → "AIX:左右"（正解の符号）と "右:全力"（mustNot の符号）。左だけ → 足さない。
 *   正解の書き方: 新着・他にあるかの番＝accept "AIX:左右"／新規の番＝accept "AIX:物件"＋mustNot "右:全力"。
 *   SEARCH_SPLIT_CHOICE=off（または NEXT_PUBLIC_SEARCH_SPLIT_CHOICE=off）の時は足さない。
 * 10/13 レビュー（重要3）: 旧の alternates（物件の AIX か全力サポートなら3つのどれでも正解）はやめた（取り違えが測れない）。
 *   厳しい採点（judgePath の strict）＝物件の AIX の種類（ピックアップ／オススメ）まで分ける。spec の acceptStrict があればそれで当てる。
 */
const SPLIT_PROP = new Set(["property_send", "property_recommendation", "property_search"]);
function splitScoringOn(): boolean {
  const off = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "off";
  return typeof process === "undefined" || !(off(process.env.SEARCH_SPLIT_CHOICE) || off(process.env.NEXT_PUBLIC_SEARCH_SPLIT_CHOICE));
}

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
  // 2026-10-28 2択の番（feedback_two_choice_aix・TWO_CHOICE_PROMISE_OR_NOW）: 画面は「AIX」と「返信」の両方のボタンを出し、スタッフが押すだけ
  //   ＝竹内さんの動きがどちらかに入れば道は合格。言ってはいけない道（hard）は2択では当てない（片方だけでは決めていない）
  if (b.two_choice_mode) {
    const aixAction = (b.action ?? "").trim() || (b.two_choice_aix ?? "").trim();
    const aixSide = aixAction ? brainPathCode({ ...b, two_choice_mode: false, reply_mode: "aix", action: aixAction, check_pattern: (b.action ?? "").trim() ? b.check_pattern : b.two_choice_check_pattern ?? null }) : null;
    const replySide = brainPathCode({ ...b, two_choice_mode: false, reply_mode: "auto_reply", action: null });
    const codes = [...new Set([...(aixSide?.codes ?? []), ...replySide.codes, ...(replySide.codes.some((c) => c.startsWith("2段")) ? [] : ["返信"])])];
    return { codes, hard: [], label: `2択（${aixSide?.label ?? "AIX"}｜${replySide.label}）` };
  }
  const action = (b.action ?? "").trim();
  if (b.reply_mode === "aix" && action) {
    const fam = aixFamily(action);
    const cp = (b.check_pattern ?? "").trim();
    const base = fam === "property_check_result" ? `AIX:${topicKey(`property_check_result/${cp}`)}` : `AIX:${action}`;
    const codes = [base, `AIX:${fam}`, "AIX"];
    const main: PathCode = { codes: [...new Set(codes)], hard: [...new Set(codes)], label: cp ? `AIX:${action}/${cp}` : `AIX:${action}` };
    if (splitScoringOn() && (SPLIT_PROP.has(action) || action === "zenryoku_support")) {
      const right = action === "zenryoku_support" || (b.alt_actions ?? []).includes("zenryoku_support");
      if (right) return { codes: [...main.codes, "AIX:左右"], hard: [...main.hard, "右:全力"], label: `${main.label}（左右）` };
      return { ...main, label: `${main.label}（左だけ）` };
    }
    return main;
  }
  const ts = (b.two_stage ?? "").trim();
  // 2026-10-27 苦手な問題②（q105）: 室内写真の撮影の約束は本番の2段の種類が check（約束を果たすのは AIX【物件確認した→室内写真】）で、
  //   符号が "2段:check" になり、正解の "2段:photo" に当たらなかった（本質は AIX:property_check_result/interior_photo＝正しいのに毎回 ✕）。
  //   方向が撮影の約束の時は "2段:photo" も符号に足す（採点の取りこぼしの直し・ブレインの判断は変えない）
  if (ts) {
    const photo = ts === "check" && pathOfDirection(String(b.reply_direction ?? "")).kind === "photo";
    if (photo) return { codes: ["2段:photo", `2段:${ts}`, "2段"], hard: ["2段:photo", `2段:${ts}`, "2段"], label: "2段:photo" };
    return { codes: [`2段:${ts}`, "2段"], hard: [`2段:${ts}`, "2段"], label: `2段:${ts}` };
  }
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
export function codeMatches(want: string, have: ReadonlyArray<string>, strict = false): boolean {
  const w = want.trim();
  if (!w) return false;
  if (w.startsWith("AIX:") && !w.startsWith("AIX:物件")) {
    // "AIX:property_check_result/募集状況" 等は topicKey に揃えて比べる。"AIX:acknowledge_check" は物件確認した の族
    const body = w.slice(4);
    const [a, p] = body.split("/");
    const fam = aixFamily(a);
    if (p) return have.includes(`AIX:${topicKey(`${fam}/${p}`)}`) || have.includes(`AIX:${fam}/${p}`);
    // 厳しい採点: 物件の AIX は種類まで（ピックアップとオススメの取り違えを外れにする）
    if (strict && fam === "物件" && a !== "property_pickup") return have.includes(`AIX:${a}`) || (a === "property_send" && have.includes("AIX:property_search"));
    return have.includes(`AIX:${a}`) || have.includes(`AIX:${fam}`);
  }
  return have.includes(w);
}

export type PathVerdict = { ok: boolean; acceptHit: string | null; mustNotHit: string | null };
export function judgePath(code: PathCode, accept: ReadonlyArray<string>, mustNot: ReadonlyArray<string> = [], opts: { strict?: boolean } = {}): PathVerdict {
  const acceptHit = accept.find((a) => codeMatches(a, code.codes, !!opts.strict)) ?? null;
  const mustNotHit = mustNot.find((m) => codeMatches(m, code.hard)) ?? null;
  return { ok: !!acceptHit && !mustNotHit, acceptHit, mustNotHit };
}

/** 1問の合否（道・asks・言ってはいけない事）。判定が無い項目（DeepSeek を回さなかった）は数えない */
export type ProblemScore = {
  path: boolean; asks: { hit: number; n: number } | null; ng: { ok: number; n: number } | null; pass: boolean;
  /** 2026-10-23 優先の重み（旧の pass・asks・ng は変えない＝昔の結果と比べられる）: 0〜1。道が外れは0・主な依頼は他の依頼の PRIMARY_ASK_WEIGHT 倍 */
  weighted?: number;
  /** 主な依頼（お客様の一番の問い＝spec の main・無ければ1つ目）が入ったか。依頼が無い・判定なしは null */
  primary?: boolean | null;
};
/** 主な依頼の重み（他の依頼・言ってはいけない事は1） */
export const PRIMARY_ASK_WEIGHT = 2;
/** 主な依頼の位置: spec の asks[].main があればそれ・無ければ0（1つ目＝お客様の最初の問い） */
export function primaryAskIndex(asks: ReadonlyArray<{ main?: boolean }> | null | undefined): number { const i = (asks ?? []).findIndex((a) => a?.main === true); return i >= 0 ? i : 0; }
/** 2026-10-23 優先の重みの点: 道が外れは0。道が合えば（主な依頼×2＋他の依頼＋守った言ってはいけない事）÷（重みの合計）。判定なしは道だけ（1 か 0） */
export function weightedScore(pathOk: boolean, asks: ReadonlyArray<boolean> | null, ngViolated: ReadonlyArray<boolean> | null, primaryIdx = 0): { weighted: number; primary: boolean | null } {
  const pi = asks && asks.length ? Math.min(Math.max(0, primaryIdx), asks.length - 1) : 0;
  const primary = asks && asks.length ? !!asks[pi] : null;
  if (!pathOk) return { weighted: 0, primary };
  let got = 0, tot = 0;
  (asks ?? []).forEach((v, i) => { const w = i === pi ? PRIMARY_ASK_WEIGHT : 1; tot += w; if (v) got += w; });
  (ngViolated ?? []).forEach((v) => { tot += 1; if (!v) got += 1; });
  return { weighted: tot ? got / tot : 1, primary };
}
export function problemScore(path: PathVerdict, asks: ReadonlyArray<boolean> | null, ngViolated: ReadonlyArray<boolean> | null, o: { primaryIdx?: number } = {}): ProblemScore {
  const a = asks ? { hit: asks.filter(Boolean).length, n: asks.length } : null;
  const g = ngViolated ? { ok: ngViolated.filter((v) => !v).length, n: ngViolated.length } : null;
  const pass = path.ok && (!a || a.hit === a.n) && (!g || g.ok === g.n);
  return { path: path.ok, asks: a, ng: g, pass, ...weightedScore(path.ok, asks, ngViolated, o.primaryIdx ?? 0) };
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

/**
 * 2026-10-13 竹内さん③「確認＋見積を1文で約束した形を 2段:check の正解に含める」:
 *   下書きの判定（DeepSeek）は「募集状況確認させて頂きます！！確認出来次第、…御見積書を作成しお送り」を主な約束＝見積（2段:estimate）と読むことがある。
 *   竹内さんの実送信（db3722・ed7695・ac7c7f）と同じ「確認＋見積」の形なので、正解が 2段:check の時は 2段:check に数える。
 */
export function normalizeDraftCode(code: string, draft: string | null | undefined, accept: ReadonlyArray<string>): string {
  // 2026-10-16 下書きの関所: 判定（DeepSeek）が「募集状況確認させて頂きます」「管理会社に交渉させて頂きます」の約束の下書きを 返信 と付ける揺れ（q157 で 3回中2回）。
  //   確認・交渉の約束の文（結果の報告「確認させて頂きましたところ」は除く）がある下書きは 2段:check に数える（前・今の両方に同じく当たる）
  // 2026-10-17 確かめる人: 正解に 2段:check がある問題だけ（正解が 返信 だけの q007「募集状況随時確認させて頂きます＋出次第お送り」の竹内さんの形を 2段:check に替えて落としていた）
  if (code === "返信" && accept.includes("2段:check")) {
    const t0 = String(draft ?? "").normalize("NFKC");
    if (/(?:確認|交渉)(?:させて|致し|し)(?:頂|いただ)?き?ます(?!た)|確認出来次第ご連絡/.test(t0) && !/確認させて(?:頂|いただ)きましたところ/.test(t0)) return "2段:check";
  }
  if (code !== "2段:estimate" || !accept.includes("2段:check") || accept.includes("2段:estimate")) return code;
  const t = String(draft ?? "").normalize("NFKC");
  return /(?:募集状況|空室状況|空き状況)[^\n]{0,20}確認/.test(t) && /御?見積/.test(t) ? "2段:check" : code;
}
