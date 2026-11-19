// app/lib/turn-anatomy-fields.ts — 竹内さんの1通から解剖の欄（誘導先・締め・継続の約束・約束の期日の言い方・訴求の点）を決まった計算で読む（純関数・LLM なし）
//
// 2026-11-12 作業員23（作業員24 の統括の洗い出し・根C）。
//   入口の意見（conductor-near-opinion）は「返信か AIX か（と鍵）」止まりで、近い竹内さんの番の多数の誘導先・締めまでは出せなかった。
//   近い番の表（conductor_turn_vectors）の列は増やさない: 入口の意見の server は近い返信の番の最初の文（messages.text）を既に読んでいる
//   （isPromiseText の判定）→ 同じ文からこの関数で欄を読み、nearAnatomyMajority で多数派を出す（CONDUCTOR_NEAR_ANATOMY=on の時だけ・既定 off）。
//   状況の文は作らない（近い番を引くのは今まで通り liveSituationV2 の状況の文＝同じ材料を2通りに作らない）。
//   継続の約束（reply-compose-conductor の keepPromise）の骨 {種類, 理由の事実} もここで読む（keepPromiseOf・文型カタログ sentence-pattern-catalog と共通）
// テスト: app/lib/__tests__/turn-anatomy-fields.test.ts
import type { LeadTo } from "./takeuchi-anatomy-roles";

/** 継続の約束の種類（新着で出次第お送り／見つかるまでサポート／申込・内覧の誘い） */
export type KeepPromiseKind = "new_listing" | "until_found" | "invite";
export const KEEP_PROMISE_JA: Record<KeepPromiseKind, string> = { new_listing: "新着・募集に出次第お送り", until_found: "見つかるまで全力でサポート", invite: "申込・内覧の誘い" };
/** 理由の事実の種類（「〜ので」「〜為」の前に竹内さんが置く事実） */
export type ReasonKind = "one_room" | "vacating" | "popular" | "new_build" | "cost" | "condition" | "other";
export const REASON_JA: Record<ReasonKind, string> = { one_room: "1部屋のみの募集", vacating: "退去予定・入居可能日", popular: "人気・すぐ埋まる", new_build: "新築・築浅", cost: "初期費用・割引", condition: "条件に合う", other: "その他の事実" };

/** 1文の継続の約束（無ければ null）。reason＝同じ文の「〜ので／〜為」の前の事実の種類 */
export function keepPromiseOf(sentence: string): { kind: KeepPromiseKind; reason: ReasonKind | null } | null {
  const t = String(sentence ?? "").normalize("NFKC");
  let kind: KeepPromiseKind | null = null;
  if (/見つかるまで|全力で(お部屋探し)?サポート/.test(t)) kind = "until_found";
  else if (/新着|募集に出次第|出次第|ピックアップ(出来|でき)次第|ピックアップ(して|させて|致し|し)?[^。!！]{0,20}お送り/.test(t)) kind = "new_listing";
  else if (/お申込|お部屋(を)?(抑|押さ)え|ご内覧|ご案内(させて|致)/.test(t)) kind = "invite";
  if (!kind) return null;
  const pre = /^(.*?)(?:ので|為|ため)/.exec(t)?.[1] ?? "";
  return { kind, reason: pre ? reasonKindOf(pre) : null };
}
export function reasonKindOf(t: string): ReasonKind {
  if (/1部屋のみ|一部屋のみ|残り1/.test(t)) return "one_room";
  if (/退去予定|入居可能|空き予定/.test(t)) return "vacating";
  if (/人気|すぐ(に)?埋ま|お問い合わせ(が)?多/.test(t)) return "popular";
  if (/新築|築浅|築年数浅/.test(t)) return "new_build";
  if (/初期費用|割引|キャンペーン|礼金|敷金/.test(t)) return "cost";
  if (/ご条件|ご希望/.test(t)) return "condition";
  return "other";
}

/** 約束の期日の言い方（出来次第／確認出来次第／本日中／明日／{日付}まで／無し） */
export type DeadlineKind = "as_soon" | "after_check" | "today" | "tomorrow" | "date" | null;
export function deadlineOf(text: string): DeadlineKind {
  const t = String(text ?? "").normalize("NFKC");
  if (/本日中|今日中|本日(の)?(夜|夕方|中)/.test(t)) return "today";
  if (/明日(中|の)?/.test(t) && /お送り|ご連絡|ご報告/.test(t)) return "tomorrow";
  if (/[0-9]{1,2}(月[0-9]{1,2}日|日)(まで|中)/.test(t)) return "date";
  if (/確認(出来|でき)次第/.test(t)) return "after_check";
  if (/(出来|でき|出)次第/.test(t)) return "as_soon";
  return null;
}

/** 訴求の点（物件を推す時の軸） */
export type AppealPoint = "size" | "station" | "age" | "cost" | "equipment" | "rent" | "floor";
export function appealPointsOf(text: string): AppealPoint[] {
  const t = String(text ?? "").normalize("NFKC");
  const out: AppealPoint[] = [];
  if (/[0-9.]+\s*(帖|畳|㎡|m2)|広さ|ゆとり/.test(t)) out.push("size");
  if (/徒歩\s*[0-9]+\s*分|駅近|駅から/.test(t)) out.push("station");
  if (/築年数浅|築浅|新築|[0-9]{4}年[0-9]{0,2}月?築/.test(t)) out.push("age");
  if (/初期費用|敷金礼金|礼金0|フリーレント|割引/.test(t)) out.push("cost");
  if (/独立洗面|浴室乾燥|追い焚き|オートロック|宅配ボックス|カウンターキッチン|インターネット無料|設備/.test(t)) out.push("equipment");
  if (/家賃(管理費)?込|合計[0-9,]+円|家賃[0-9,]+円/.test(t)) out.push("rent");
  if (/[0-9]+\s*階|角部屋|最上階/.test(t)) out.push("floor");
  return out;
}

/** 誘導先（竹内さんの文だけから・決まった計算。ブレインの dir から読む leadKeyOf とは別の入口＝過去の番に使う） */
export function leadOfText(text: string): LeadTo {
  const t = String(text ?? "").normalize("NFKC");
  if (/お申込(み)?(し|して|させて|頂|いただ)|お部屋(を)?(抑|押さ)え/.test(t)) return "apply";
  if (/御見積(書)?(を)?(作成|お送り|同封)/.test(t)) return "estimate";
  if (/ご内覧|ご案内(させて|致|出来|でき)|内覧(の)?(候補|日)/.test(t)) return "viewing";
  if (/お送り(頂|いただ)け|送って(頂|いただ)け|教えて(頂|いただ)け/.test(t)) return "ask_send";
  if (/ピックアップ|新着|出次第|見つかるまで|全力で(お部屋探し)?サポート|お気軽にご連絡/.test(t)) return "keep";
  return "answer_only";
}

/** 締めの型（最後の文の言い方を短い鍵に） */
export type CloseKind = "nanitozo" | "kisyu" | "kigaru" | "tanoshimi" | "none";
export function closeOf(text: string): CloseKind {
  const lines = String(text ?? "").normalize("NFKC").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  if (/何卒よろしく/.test(last)) return "nanitozo";
  if (/ご査収/.test(last)) return "kisyu";
  if (/お気軽に|何時でも|いつでも/.test(last)) return "kigaru";
  if (/楽しみ/.test(last)) return "tanoshimi";
  return "none";
}

export type TurnAnatomy = { lead: LeadTo; close: CloseKind; keep: KeepPromiseKind | null; keepReason: ReasonKind | null; deadline: DeadlineKind; appeal: AppealPoint[] };
/** 竹内さんの1通 → 解剖の欄 */
export function turnAnatomyOf(text: string): TurnAnatomy {
  const sents = String(text ?? "").split(/\n+|(?<=[。!！])/).map((s) => s.trim()).filter(Boolean);
  const keeps = sents.map(keepPromiseOf).filter((x): x is NonNullable<typeof x> => !!x);
  // 1通に複数あれば、新着 → 見つかるまで → 誘い の順に1つ（竹内さんの継続の約束は新着の形が中心）
  const order: KeepPromiseKind[] = ["new_listing", "until_found", "invite"];
  const keep = keeps.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))[0] ?? null;
  return { lead: leadOfText(text), close: closeOf(text), keep: keep?.kind ?? null, keepReason: keep?.reason ?? null, deadline: deadlineOf(text), appeal: appealPointsOf(text) };
}

// ── 近い番の多数派（入口の意見に添える・既定 off） ──
type Env = Record<string, string | undefined>;
export const nearAnatomyOn = (env: Env = typeof process !== "undefined" ? process.env : {}) => (env.CONDUCTOR_NEAR_ANATOMY ?? "").trim().toLowerCase() === "on";
export type NearAnatomy = { n: number; lead: { v: LeadTo; share: number } | null; close: { v: CloseKind; share: number } | null; keep: { v: KeepPromiseKind | "none"; share: number } | null; deadline: { v: string; share: number } | null; appeal: Array<{ v: AppealPoint; share: number }> };
const major = <T extends string>(xs: ReadonlyArray<T>, minShare: number): { v: T; share: number } | null => {
  if (!xs.length) return null;
  const c = new Map<T, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  const [v, k] = [...c.entries()].sort((a, b) => b[1] - a[1] || xs.indexOf(a[0]) - xs.indexOf(b[0]))[0];
  const share = Math.round((k / xs.length) * 100) / 100;
  return share >= minShare ? { v, share } : null;
};
/** 近い返信の番（近い順）の解剖から多数派。minN 未満なら null・各欄は minShare 未満なら出さない（割合が低い欄は意見にしない） */
export function nearAnatomyMajority(list: ReadonlyArray<TurnAnatomy>, o: { minN?: number; minShare?: number } = {}): NearAnatomy | null {
  const minN = o.minN ?? 5, minShare = o.minShare ?? 0.6;
  if (list.length < minN) return null;
  const appealC = new Map<AppealPoint, number>();
  for (const a of list) for (const p of new Set(a.appeal)) appealC.set(p, (appealC.get(p) ?? 0) + 1);
  return {
    n: list.length,
    lead: major(list.map((a) => a.lead), minShare),
    close: major(list.map((a) => a.close), minShare),
    keep: major(list.map((a) => a.keep ?? "none"), minShare),
    deadline: major(list.map((a) => a.deadline ?? "none"), minShare),
    appeal: [...appealC.entries()].map(([v, k]) => ({ v, share: Math.round((k / list.length) * 100) / 100 })).filter((x) => x.share >= 0.5).sort((a, b) => b.share - a.share),
  };
}
const LEAD_JA: Record<string, string> = { viewing: "内覧へ", apply: "申込・抑えるへ", estimate: "見積へ", ask_send: "物件を送ってもらう", keep: "新着・つなぐ", answer_only: "答えるだけ", none: "なし" };
const CLOSE_JA: Record<CloseKind, string> = { nanitozo: "何卒よろしくお願い致します", kisyu: "ご査収ください", kigaru: "お気軽にご連絡ください", tanoshimi: "楽しみにしております", none: "締めなし" };
const DEADLINE_JA: Record<string, string> = { as_soon: "出来次第", after_check: "確認出来次第", today: "本日中", tomorrow: "明日", date: "{日付}まで", none: "期日を言わない" };
const APPEAL_JA: Record<AppealPoint, string> = { size: "広さ", station: "駅からの近さ", age: "築年数", cost: "初期費用", equipment: "設備", rent: "家賃（管理費込）", floor: "階・角部屋" };
/** ブレインの材料の1行（入口の意見の後ろ）。出せる欄が無ければ "" */
export function nearAnatomyLine(na: NearAnatomy | null): string {
  if (!na) return "";
  const p: string[] = [];
  if (na.lead) p.push(`誘導先は ${LEAD_JA[na.lead.v] ?? na.lead.v}（${Math.round(na.lead.share * 100)}%）`);
  if (na.keep) p.push(na.keep.v === "none" ? `継続の約束は添えない（${Math.round(na.keep.share * 100)}%）` : `継続の約束は「${KEEP_PROMISE_JA[na.keep.v]}」（${Math.round(na.keep.share * 100)}%）`);
  if (na.deadline) p.push(`約束の期日は ${DEADLINE_JA[na.deadline.v] ?? na.deadline.v}（${Math.round(na.deadline.share * 100)}%）`);
  if (na.close) p.push(`締めは「${CLOSE_JA[na.close.v]}」（${Math.round(na.close.share * 100)}%）`);
  if (na.appeal.length) p.push(`推す点は ${na.appeal.map((a) => `${APPEAL_JA[a.v]} ${Math.round(a.share * 100)}%`).join("・")}`);
  if (!p.length) return "";
  return `【近い竹内さんの番の文の形（返信 ${na.n}件の多数）】${p.join("／")}。この番の材料と食い違えば材料を採る。`;
}
