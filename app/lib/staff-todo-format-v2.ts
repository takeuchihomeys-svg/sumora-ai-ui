// app/lib/staff-todo-format-v2.ts — 【やることリスト】の1人分を、欄に分けて読みやすくする新しい形（純関数・DB/LLM なし・STAFF_TODO_FORMAT_V2・既定 off）
//
// 2026-11-24 作業員A（竹内さん 11/24 11:23・強い指示・LINE グループ「★物件出し★」の毎朝 10:30 の【やることリスト】のスクショ）:
//   「ここの指示の部分を、更にちゃんと要約して何をすべきか、状況を分かりやすく入れるようにする。今かなり読みにくいので読みやすく。
//    ここがちゃんとできればかなり質も上がるため、細かく行う」
//   今の形の読みにくい所: 同じ事の繰り返し（申込歴あり・期限過ぎが見出しと行に2回）・矢印の長い1行・状況（今どこで何を待っているか）が無い・何から手を付けるか分からない。
//   1人分の欄:
//     ① 誰: 名前さん（どこ経由）＋印（申込歴あり・🌟）は見出しに1回だけ
//     ② 急ぐ理由と期限は見出しの ▶ に1か所だけ（一番過ぎた期限の日数・約束した日・待たせている日数）
//     ③ 今の状況を1行（段・最後のやりとり・お客様が何を待っているか）
//     ④ 今日やる事を、動詞から始まる短い1行ずつ（何をする→どのボタンで）。番号（✅3 の返し）は今と同じ。行ごとの期限は時刻がある物だけ
//   送る仕組み・時刻・番号の振り方・済みの印は今と同じ（文の形だけ）。スタッフに見える物なので、竹内さんに見本を見てもらってから on。
// テスト: app/lib/__tests__/staff-todo-format-v2.test.ts
import { CONDITION_CHECK_OPTIONS } from "./aix-pickers";

type Env = Record<string, string | undefined>;
export function staffTodoFormatV2On(env: Env = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.STAFF_TODO_FORMAT_V2 ?? "").trim().toLowerCase() === "on";
}

const CHECK_WHAT: Record<string, string> = {
  mgmt_parking: "駐車場の空きと月額", mgmt_pet: "ペット可否と条件", mgmt_guarantor: "保証会社の名前と種類", mgmt_move_in: "入居可能日",
  vacate_date: "退去予定日", mgmt_availability: "募集状況", mgmt_equipment: "設備の有無", mgmt_company: "管理会社の名前と連絡先",
  mgmt_proxy: "代理契約の可否", mgmt_two_person: "二人入居の可否", mgmt_occupant: "お子様の入居の可否", mgmt_lifeline: "ライフラインの指定",
  mgmt_application_status: "申込の有無と何番手か", mgmt_initial_cost: "初期費用の交渉の結果", mgmt_contract_terms: "短期解約・クリーニング・フリーレント",
  mgmt_rent_negotiation: "家賃の交渉の結果", mgmt_screening: "審査の見込み",
};
const CHECK_LABEL: Record<string, string> = Object.fromEntries(CONDITION_CHECK_OPTIONS.map((o) => [o.value, o.label]));

export type V2TaskInput = {
  action: string | null; checkPattern: string | null; source: string; task: string; kindLabel: string;
  conditions?: string | null; everSent?: boolean | null; propertyName?: string | null;
};
/** 今日やる事の1行（動詞から・何をする→どのボタンで）。分からない時は「やる事（ボタン）」 */
export function v2TaskLine(i: V2TaskInput): string {
  const obj = (i.propertyName ?? "").trim().slice(0, 20);
  const cond = i.conditions ? `${i.conditions}で` : "ご条件で";
  if (i.action === "property_check_result") {
    if (i.checkPattern === "nearby_parking") return `${obj ? `${obj}の` : ""}近くの月極駐車場を調べる→AIX【物件確認した】で入力`;
    if (i.checkPattern && CHECK_WHAT[i.checkPattern]) return `管理会社に${obj ? `${obj}の` : ""}${CHECK_WHAT[i.checkPattern]}を確認→AIX【物件確認した】で入力`;
    if (i.checkPattern && CHECK_LABEL[i.checkPattern]) return `管理会社に${obj ? `${obj}の` : ""}${CHECK_LABEL[i.checkPattern]}を確認→AIX【物件確認した】で入力`;
    return `管理会社に${obj ? `${obj}の` : ""}募集状況を確認→AIX【物件確認した】で結果を選ぶ`;
  }
  if (i.action === "property_send" || i.action === "property_recommendation" || i.source === "target_new_arrival") {
    const newArrival = (i.source === "target_new_arrival" && i.everSent === true) || /新着/.test(i.task);
    const none = i.source === "target_new_arrival" ? "（無ければ☑）" : "";
    return newArrival ? `${cond}新着を確かめる→AIX【物件ピックアップした】で送る${none}` : `${cond}探す→AIX【物件ピックアップした】で送る${none}`;
  }
  if (i.action === "estimate_sheet") return `${obj ? `${obj}の` : ""}御見積書を作る→AIX【見積書送る】で送る`;
  const kind = i.kindLabel.replace(/：.*$/, "");
  return `${i.task}${kind && kind !== "返信" ? `（${kind}）` : ""}`;
}

const STATUS_JA: Record<string, string> = {
  new: "問い合わせ", inquiry: "問い合わせ", hearing: "条件の聞き取り", proposing: "物件の提案中", viewing: "内覧の調整",
  viewing_scheduled: "内覧の予定", viewed: "内覧の後", applying: "申込", screening: "審査中", contracted: "契約",
};
export type V2Situation = { status: string | null; lastAt: string | null; lastBy: "customer" | "staff" | null; waitSinceAt: string | null; waitWhat: string | null };
const md = (iso: string, off = 9 * 3600e3) => { const d = new Date(Date.parse(iso) + off); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const jstDay = (ms: number) => Math.floor((ms + 9 * 3600e3) / 86400e3);
const daysBetween = (a: number, b: number) => Math.max(0, jstDay(b) - jstDay(a)); // JST の日付で数える（見出しの期限の日数と同じ数え方）
/** 今の状況の1行: 段・最後のやりとり・お客様が何を待っているか（材料が無い欄は書かない・全部無ければ null） */
export function v2SituationLine(s: V2Situation, atMs: number): string | null {
  const parts: string[] = [];
  const st = s.status ? STATUS_JA[s.status] ?? null : null;
  if (st) parts.push(st);
  if (s.lastAt && s.lastBy) parts.push(`最後は${s.lastBy === "customer" ? "お客様から" : "こちらから"} ${md(s.lastAt)}`);
  if (s.waitSinceAt) {
    const d = daysBetween(Date.parse(s.waitSinceAt), atMs);
    parts.push(`${s.waitWhat ? `${s.waitWhat}を` : ""}${d > 0 ? `${d}日お待たせ` : "今日お約束"}`);
  }
  return parts.length ? `今: ${parts.join("・")}` : null;
}

/** 見出し: 名前さん（どこ経由）印 ▶ 急ぐ理由（期限は1か所だけ）。why の中で見出しに既にある言葉・期限の言葉は落とす */
export function v2Header(accountLabel: string, o: { maxOverdueDays: number; why?: string | null; hasOpen: boolean }): string {
  const reasons: string[] = [];
  if (o.hasOpen && o.maxOverdueDays > 0) reasons.push(`期限${o.maxOverdueDays}日過ぎ`);
  for (const w of String(o.why ?? "").split("・").map((x) => x.trim()).filter(Boolean)) {
    if (/期限/.test(w)) continue; // 期限は上の1か所だけ
    if (accountLabel.includes(w.replace(/^【|】$/g, ""))) continue; // 見出しの印（申込歴あり 等）と同じ
    if (!reasons.includes(w)) reasons.push(w);
  }
  return `${accountLabel}${o.hasOpen && reasons.length ? ` ▶${reasons.join("・")}` : ""}`;
}

/** 1行の期限（時刻がある物だけ・それ以外は見出しの1か所に寄せる） */
export function v2DueSuffix(o: { dueHasTime: boolean; dueAt: string; done: boolean }): string {
  if (o.done || !o.dueHasTime) return "";
  const d = new Date(Date.parse(o.dueAt) + 9 * 3600e3);
  return `（${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}まで）`;
}

// ── 統括ブレインの判断から取る（2026-11-24 統括役の足し・竹内さん「ちゃんとブレインと連携できるならする・統括ブレインと連携して」）──
//   リストの側で状況・次の手を別に作らない。会話の最後の判断（conversations.last_brain_meta）の欄から取る:
//     状況＝apply_route（地図の駅・分かれ道・駅の中の状態）＋ situation_now.promises_open（開いている約束）
//     次の手＝next_steps の Step1（統括の次の一手）／今日やる事の行そのものは、✅ の番号の元の記録（約束・AIX 要対応）のまま
//     古い＝最後の判断の後にお客様の通がある（analyzed_msg_ts より後）→ 印を付けてリストの側で推さない
export type ConductorView = {
  analyzedTs: string | null; node: string | null; branch: string | null; substate: string | null;
  nextSteps: string[]; promisesOpen: Array<{ kind: string; object: string | null; at: string; due_h: number | null }>;
  /** 最後の判断の後にお客様の通がある */
  stale: boolean;
};
/** last_brain_meta の欄から（形の崩れた欄は無い物として扱う） */
export function conductorViewOf(meta: Record<string, unknown> | null | undefined, lastCustomerAt: string | null): ConductorView | null {
  if (!meta || typeof meta !== "object") return null;
  const ar = (meta.apply_route ?? null) as { node?: unknown; branch?: unknown; substate?: unknown } | null;
  const ns = Array.isArray(meta.next_steps) ? (meta.next_steps as unknown[]).map(String).filter((x) => x.trim()) : [];
  const sn = (meta.situation_now ?? null) as { promises_open?: unknown } | null;
  const po = Array.isArray(sn?.promises_open) ? (sn!.promises_open as Array<Record<string, unknown>>).map((p) => ({ kind: String(p.kind ?? ""), object: p.object == null ? null : String(p.object), at: String(p.at ?? ""), due_h: typeof p.due_h === "number" ? p.due_h : null })).filter((p) => p.at) : [];
  const ts = typeof meta.analyzed_msg_ts === "string" ? meta.analyzed_msg_ts : null;
  const stale = !!(ts && lastCustomerAt && Date.parse(lastCustomerAt) > Date.parse(ts) + 1000);
  return { analyzedTs: ts, node: typeof ar?.node === "string" ? ar.node : null, branch: typeof ar?.branch === "string" ? ar.branch : null, substate: typeof ar?.substate === "string" ? ar.substate : null, nextSteps: ns, promisesOpen: po, stale };
}
/** 地図の駅を判断の記録（last_brain_meta.apply_route）に残し始めた時（APPLY_ROUTE_RECORD・route-record.ts・11/21 既定 on） */
export const APPLY_ROUTE_RECORD_SINCE = "2026-11-21T00:00:00Z";
/** 駅・分かれ道の名前（申込までの地図の名前を読み手が渡す） */
export type RouteNames = { node: (id: string) => string | null; branch: (id: string) => string | null;
  /** 2026-11-24 #657: 読み違いの多い駅（route:station_misread_move の駅ごとの数から読み手が渡す・無ければ印を付けない） */
  weak?: ReadonlySet<string> };
/** 今の状況の1行（統括から）。判断が古い時は印だけ（推さない） */
export function conductorSituationLine(v: ConductorView | null, atMs: number, names: RouteNames): string {
  if (!v) return "今: 統括の判断なし";
  if (v.stale) return `今: （統括の判断は ${v.analyzedTs ? md(v.analyzedTs) : "?"} の通まで・その後のお客様の通は未判断）`;
  const parts: string[] = [];
  const nn = v.node ? names.node(v.node) : null;
  if (nn) parts.push(`${nn}${v.node && names.weak?.has(v.node) ? "（この駅は読み違いが多い・確かめて）" : ""}`);
  // 2026-11-24 #676: 地図の駅を判断の記録に残すのは 11/21 から（APPLY_ROUTE_RECORD）。それより前の判断のままの会話は駅が無い＝推さずにその印
  else if (!v.node && v.analyzedTs && v.analyzedTs < APPLY_ROUTE_RECORD_SINCE) parts.push(`駅なし（統括の判断は ${md(v.analyzedTs)}・地図の駅を残す前）`);
  const bn = v.branch ? names.branch(v.branch) : null;
  if (bn) parts.push(`分かれ道: ${bn}`);
  if (v.promisesOpen.length) {
    const old = [...v.promisesOpen].sort((a, b) => a.at.localeCompare(b.at))[0];
    const d = daysBetween(Date.parse(old.at), atMs);
    parts.push(`開いている約束 ${v.promisesOpen.length}（一番古い ${md(old.at)}・${d}日）`);
  }
  return parts.length ? `今: ${parts.join("・")}` : "今: 統括の欄が空";
}
/** 統括の次の一手（next_steps の Step1・頭の「Step1（今すぐ）:」を落として短く） */
export function conductorNextLine(v: ConductorView | null): string | null {
  if (!v || v.stale || !v.nextSteps.length) return null;
  const s = v.nextSteps[0].replace(/^\s*Step\s*\d+[^:：]*[:：]\s*/i, "").trim();
  return s ? `統括の次の手: ${Array.from(s).slice(0, 48).join("")}${Array.from(s).length > 48 ? "…" : ""}` : null;
}
// 2026-11-24 統括役の直し①: 次の手は途中で切らず、動詞で終わる短い1文（30字ほど）に。LLM なしの要約・作れない時は AIX の種類の言葉
const VERB_RE = /([^、。]{1,40}?)を([^、。を]{0,12}?)(確認|検索|探|送|回答|案内|報告|伝え|提案|調べ|お伝え|作成|作)/;
const VERB_END: Record<string, string> = { 確認: "確認する", 検索: "検索する", 探: "探す", 送: "送る", 回答: "回答する", 案内: "案内する", 報告: "報告する", 伝え: "伝える", 提案: "提案する", 調べ: "調べる", お伝え: "お伝えする", 作成: "作成する", 作: "作る" };
export const NEXT_SHORT_MAX = 36;
/** next_steps の1行 → 「何を→どうする」の短い1文（動詞で終わる）。作れない時は AIX の種類の言葉・それも無ければ null */
export function nextStepShort(text: string): string | null {
  const s = text.replace(/^\s*Step\s*\d+[^:：]*[:：]\s*/i, "").trim();
  // 括弧の中（金額・面積の並び）は落としてから読む
  const first = s.split("。")[0].replace(/[（(][^）)]*[）)]/g, "");
  const topic = first.match(/^([^、]{1,20}?)(?:について|の件)/)?.[1] ?? null;
  const m = first.match(VERB_RE);
  if (m) {
    let obj = m[1].replace(/^[^、]*?について、?/, "").trim();
    // 頭の説明の節（「顧客が画像で送ってきた」等）を落とす
    obj = obj.replace(/^[^A-Za-zＡ-Ｚ]*?(?:てきた|された|した|頂いた|いただいた)(?=\S)/, "").trim();
    // 条件の並びは「条件で〇〇」だけ
    if (obj.includes("条件で")) obj = obj.slice(obj.indexOf("条件で"));
    if (Array.from(obj).length > 14 && obj.includes("・")) { const h0 = obj.includes("の") ? obj.slice(0, obj.indexOf("の")) : ""; obj = obj.split("・").pop()!.trim(); if (h0 && /号室|\d+階|[A-Za-z]/.test(h0) && !obj.includes(h0) && Array.from(`${h0}の${obj}`).length <= 26) obj = `${h0}の${obj}`; } // 物件名（号室・数字）は残す // 並びは最後の1つ（「〜の繰上げ・2番手申込の可否」→「2番手申込の可否」）
    if (Array.from(obj).length > 14 && obj.includes("の")) {
      const head = obj.slice(0, obj.indexOf("の")), tail = obj.slice(obj.lastIndexOf("の") + 1).split("・").pop()!.trim();
      obj = Array.from(`${head}の${tail}`).length <= 26 ? `${head}の${tail}` : tail;
    }
    if (Array.from(obj).length > 22) obj = obj.split("・").pop()!.trim();
    if (Array.from(obj).length > 22) return nextStepFallback(s);
    const mid = m[2].trim();
    const out = `${topic && !obj.includes(topic) ? `${topic}の` : ""}${obj}を${mid}${VERB_END[m[3]]}`;
    if (Array.from(out).length <= NEXT_SHORT_MAX) return out;
    const noTopic = `${obj}を${mid}${VERB_END[m[3]]}`;
    if (Array.from(noTopic).length <= NEXT_SHORT_MAX) return noTopic;
  }
  return nextStepFallback(s);
}
// 2026-11-24 統括役の直し: 代わりの言葉にも物件名と確かめる中身（next_steps の中の名詞）を入れる。どちらも取れない時は null（⚠ の行は出さず「統括の手は読めない」の印だけ）
const PROP_RE = /([A-Za-zＡ-Ｚァ-ヶー一-龠々][A-Za-z0-9Ａ-Ｚ０-９ァ-ヶー一-龠々 ]{1,24}?(?:\d+号室|\d+階|号室))/;
const NOUN_RE = /(募集状況|空き状況|空室|初期費用|ペット|申込|審査|駐車場|御見積書|見積書|入居日|内覧の日程)/;
export function nextStepFallback(text: string): string | null {
  const t = text.replace(/[（(][^）)]*[）)]/g, "");
  const prop = t.match(PROP_RE)?.[1]?.trim() ?? null;
  const noun = t.match(NOUN_RE)?.[1] ?? null;
  const k = nextStepAixOf(t);
  const P = prop ? `${prop}の` : "";
  let out: string | null = null;
  if (k === "property_check_result") out = noun ? `${P}${noun}を管理会社に確認する` : prop ? `${prop}を管理会社に確認する` : null;
  else if (k === "estimate_sheet") out = prop ? `${P}御見積書を作って送る` : null;
  else if (k === "viewing_invite") out = prop ? `${P}内覧の候補日を送る` : null;
  else if (k === "property_send") out = /条件/.test(t) ? "条件で物件を探して送る" : null;
  return out && Array.from(out).length <= NEXT_SHORT_MAX + 4 ? out : null;
}

/** next_steps の1行が指す AIX の種類（分からなければ null） */
export function nextStepAixOf(text: string): string | null {
  if (/物件確認した|募集状況|管理会社に確認/.test(text)) return "property_check_result";
  if (/見積/.test(text)) return "estimate_sheet";
  if (/内覧/.test(text)) return "viewing_invite";
  if (/ピックアップ|検索|探す|探して/.test(text)) return "property_send";
  if (/返信|回答|お伝え/.test(text)) return "reply";
  return null;
}
export type TodoVsConductor = "match" | "mismatch" | "no_conductor" | "stale" | "unknown";
/** リストのやる事（AIX の種類の集まり）と統括の次の一手が合うか（見張り link:todo_vs_conductor の1件） */
/** 確認の行の中身の手がかり（同じ「物件確認した」でも、統括の次の手が別の件を確かめるなら食い違い） */
const CHECK_TOPIC_RE: Record<string, RegExp> = {
  mgmt_pet: /ペット/, mgmt_parking: /駐車場/, nearby_parking: /駐車場/, mgmt_initial_cost: /初期費用|交渉|割引/, mgmt_guarantor: /保証/, mgmt_move_in: /入居/,
  vacate_date: /退去/, mgmt_application_status: /申込|番手/, mgmt_screening: /審査/, mgmt_rent_negotiation: /家賃/, mgmt_equipment: /設備/, mgmt_contract_terms: /解約|クリーニング|フリーレント/,
};
export function todoVsConductor(items: ReadonlyArray<string | null | { action: string | null; checkPattern?: string | null }>, v: ConductorView | null): TodoVsConductor {
  if (!v || !v.nextSteps.length) return "no_conductor";
  if (v.stale) return "stale";
  const step = v.nextSteps[0];
  const a = nextStepAixOf(step);
  if (!a) return "unknown";
  const its = items.map((x) => (typeof x === "object" && x !== null ? x : { action: x, checkPattern: null }));
  const norm = (x: string | null) => (x === "property_recommendation" ? "property_send" : x ?? "reply");
  const same = its.filter((i) => norm(i.action) === a);
  if (!same.length) return "mismatch";
  // 2026-11-24 統括役の直し②: 物件確認した 同士は中身（ペット・初期費用・申込…）まで見る。どの行の中身も次の手に出てこなければ別の件
  if (a === "property_check_result") {
    const topics = same.map((i) => (i.checkPattern ? CHECK_TOPIC_RE[i.checkPattern] : /募集状況|空き|空室/)).filter((r): r is RegExp => !!r);
    if (topics.length && !topics.some((r) => r.test(step))) return "mismatch";
  }
  return "match";
}

/** 物差し: 1人分の字数・行数・重複（同じ言葉が見出しと行に2回）・状況の1行があるか */
export function v2Measure(block: string): { chars: number; lines: number; dup: number; hasSituation: boolean } {
  const ls = block.split("\n").filter((l) => l.trim());
  const words = ["申込歴あり", "期限", "日過ぎ"];
  const dup = words.reduce((n, w) => n + Math.max(0, (block.split(w).length - 1) - 1), 0);
  return { chars: block.replace(/\n/g, "").length, lines: ls.length, dup, hasSituation: ls.some((l) => l.trim().startsWith("今:")) };
}
