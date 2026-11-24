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
/** 駅・分かれ道の名前（申込までの地図の名前を読み手が渡す） */
export type RouteNames = { node: (id: string) => string | null; branch: (id: string) => string | null };
/** 今の状況の1行（統括から）。判断が古い時は印だけ（推さない） */
export function conductorSituationLine(v: ConductorView | null, atMs: number, names: RouteNames): string {
  if (!v) return "今: 統括の判断なし";
  if (v.stale) return `今: （統括の判断は ${v.analyzedTs ? md(v.analyzedTs) : "?"} の通まで・その後のお客様の通は未判断）`;
  const parts: string[] = [];
  const nn = v.node ? names.node(v.node) : null;
  if (nn) parts.push(nn);
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
export function todoVsConductor(actions: ReadonlyArray<string | null>, v: ConductorView | null): TodoVsConductor {
  if (!v || !v.nextSteps.length) return "no_conductor";
  if (v.stale) return "stale";
  const a = nextStepAixOf(v.nextSteps[0]);
  if (!a) return "unknown";
  const set = new Set(actions.map((x) => (x === "property_recommendation" ? "property_send" : x ?? "reply")));
  return set.has(a) ? "match" : "mismatch";
}

/** 物差し: 1人分の字数・行数・重複（同じ言葉が見出しと行に2回）・状況の1行があるか */
export function v2Measure(block: string): { chars: number; lines: number; dup: number; hasSituation: boolean } {
  const ls = block.split("\n").filter((l) => l.trim());
  const words = ["申込歴あり", "期限", "日過ぎ"];
  const dup = words.reduce((n, w) => n + Math.max(0, (block.split(w).length - 1) - 1), 0);
  return { chars: block.replace(/\n/g, "").length, lines: ls.length, dup, hasSituation: ls.some((l) => l.trim().startsWith("今:")) };
}
