// app/lib/info-fill-map.ts — 「今このお客様について分かっている情報／分かっていない情報／古い情報」の土台（純関数・DB/LLM なし）
//
// 2026-11-12 作業員1（竹内さん 11/12「なぜやっているか・何の情報が足りていないから・どこの要点を押さえにいっているか」を細分化する決定の土台・統括役）:
//   「足りない情報」を読むには、今分かっている情報の表が要るが、条件・送った物件・セーブデータ・帳面がばらばらで1つの表が無かった。
//   ①申込までに要る情報の一覧を、作業員7 の申込までの地図（apply-route-map の駅）ごとに「次の駅へ進むのに要る物」として持つ
//   ②会話の材料（登録の条件・行動台帳・送付・AIX の記録・内覧の記録・申込の情報）から 分かっている／分かっていない／古い を決まった計算で埋める
//   ③今の駅で足りない情報を事実の一覧で渡す（道の言葉＝何を送るか・AIX は書かない＝判断はブレイン P0 9eb6aa9c）
//   材料が呼ぶ側に届いていない項目（unwired）は「材料が届いていない」と分けて出す（受け取る側の点検の結果と合わせる）。
//   既定 off（入れる INFO_FILL_MAP=on）。
import type { RouteNodeId } from "./apply-route-map";

type Env = Record<string, string | undefined>;
export function infoFillMapOn(env?: Env): boolean {
  const e = env ?? (typeof process !== "undefined" ? process.env : {});
  return (e.INFO_FILL_MAP ?? "").trim().toLowerCase() === "on";
}

/** 情報の項目（名前は判断の根拠のメモ・作業員16 の型の表と揃える時はここだけ直す） */
export const INFO_KEYS = [
  "area", "rent", "layout", "move_in", "size",
  "property_chosen", "vacancy_checked", "estimate_sent", "viewing_date", "viewing_done",
  "apply_intent", "apply_form", "screening_info",
] as const;
export type InfoKey = typeof INFO_KEYS[number];
export const INFO_LABEL: Record<InfoKey, string> = {
  area: "エリア", rent: "家賃", layout: "間取り", move_in: "入居時期", size: "広さ",
  property_chosen: "気に入った物件（どの部屋か）", vacancy_checked: "その物件の募集状況（確かめ済みか）", estimate_sent: "その物件の初期費用（御見積書）",
  viewing_date: "内覧の日時", viewing_done: "内覧が済んだか", apply_intent: "申込の意思", apply_form: "申込の情報（記入済みのフォーマット・本人確認書類）",
  screening_info: "審査の事情（職業・保証会社の不安など）",
};

/** 次の駅へ進むのに要る物（駅ごと）。分かれ道は呼ぶ側で本線の駅に寄せる */
export const NEEDS_FOR_NEXT: Record<RouteNodeId, readonly InfoKey[]> = {
  inquiry: ["area", "rent", "layout", "move_in"],
  hearing: ["area", "rent", "layout", "move_in"],
  pickup: ["area", "rent", "layout"],
  proposing: ["property_chosen"],
  interested: ["property_chosen", "vacancy_checked", "estimate_sent"],
  estimate: ["property_chosen", "estimate_sent", "viewing_date"],
  viewing_arrange: ["property_chosen", "viewing_date"],
  viewing_scheduled: ["viewing_date"],
  viewed: ["viewing_done", "apply_intent"],
  apply_prep: ["apply_intent", "apply_form", "screening_info"],
  applying: [],
  won: [],
};

export type InfoState = "known" | "unknown" | "stale" | "unwired";
export type InfoCell = { key: InfoKey; state: InfoState; value?: string | null; why?: string | null };

/** 呼ぶ側が渡す材料（無い・読めなかった物は undefined＝材料が届いていない） */
export type InfoInputs = {
  nowMs: number;
  /** 登録の条件（property_customers） */
  pc?: { desired_area?: unknown; rent_max?: unknown; rent_min?: unknown; floor_plan?: unknown; move_in_time?: unknown; floor_area_min?: unknown; updated_at?: string | null } | null;
  /** 今の番の物件・主のお部屋（名前）。決まっていなければ null */
  focusProperty?: string | null;
  /** その物件の募集状況を確かめた時刻（AIX【物件確認した】・確認の報告） */
  vacancyCheckedAt?: string | null;
  /** その物件の御見積書を送ったか（行動台帳 estimateSentFor・estimate_records） */
  estimateSent?: boolean | null;
  /** 内覧の日時（決まっている・今日以降） */
  viewingDate?: string | null;
  /** 内覧が済んだか */
  viewingDone?: boolean | null;
  /** 申込の意思（お客様が申込したいと言った） */
  applyIntent?: boolean | null;
  /** 申込の情報の状態（apply-info-state: none / form_sent / received） */
  applyForm?: "none" | "form_sent" | "received" | null;
  /** 審査の事情（会話・メモにある・申込の書類の手前） */
  screeningInfo?: string | null;
};

const VACANCY_STALE_DAYS = 7;
const present = (v: unknown) => v != null && !(typeof v === "string" && !v.trim()) && !(Array.isArray(v) && v.length === 0);
const show = (v: unknown) => (Array.isArray(v) ? v.join("・") : String(v)).slice(0, 30);

/** 1項目の状態を埋める（材料が届いていない＝undefined は unwired） */
export function fillInfo(key: InfoKey, i: InfoInputs): InfoCell {
  const pc = i.pc;
  const cond = (field: keyof NonNullable<InfoInputs["pc"]>, alt?: keyof NonNullable<InfoInputs["pc"]>): InfoCell => {
    if (pc === undefined) return { key, state: "unwired" };
    const v = pc?.[field] ?? (alt ? pc?.[alt] : undefined);
    return present(v) ? { key, state: "known", value: show(v) } : { key, state: "unknown" };
  };
  switch (key) {
    case "area": return cond("desired_area");
    case "rent": return cond("rent_max", "rent_min");
    case "layout": return cond("floor_plan");
    case "size": return cond("floor_area_min");
    case "move_in": {
      const c = cond("move_in_time");
      // 入居時期が過ぎた月（「10月中」で今が11月）は古い
      if (c.state === "known" && c.value) {
        const m = c.value.normalize("NFKC").match(/(\d{1,2})\s*月/);
        const nowM = new Date(i.nowMs + 9 * 3600_000).getUTCMonth() + 1;
        if (m && !/来年|年明け/.test(c.value) && ((nowM - Number(m[1]) + 12) % 12) >= 1 && ((nowM - Number(m[1]) + 12) % 12) <= 3) return { ...c, state: "stale", why: "入居時期の月が過ぎている" };
      }
      return c;
    }
    case "property_chosen": return i.focusProperty === undefined ? { key, state: "unwired" } : i.focusProperty ? { key, state: "known", value: i.focusProperty } : { key, state: "unknown" };
    case "vacancy_checked": {
      if (i.vacancyCheckedAt === undefined) return { key, state: "unwired" };
      if (!i.vacancyCheckedAt) return { key, state: "unknown" };
      const days = (i.nowMs - Date.parse(i.vacancyCheckedAt)) / 86_400_000;
      return days > VACANCY_STALE_DAYS ? { key, state: "stale", value: i.vacancyCheckedAt.slice(0, 10), why: `確かめてから${Math.floor(days)}日` } : { key, state: "known", value: i.vacancyCheckedAt.slice(0, 10) };
    }
    case "estimate_sent": return i.estimateSent === undefined || i.estimateSent === null ? { key, state: i.estimateSent === null ? "unknown" : "unwired" } : { key, state: i.estimateSent ? "known" : "unknown" };
    case "viewing_date": return i.viewingDate === undefined ? { key, state: "unwired" } : i.viewingDate ? { key, state: "known", value: i.viewingDate } : { key, state: "unknown" };
    case "viewing_done": return i.viewingDone === undefined || i.viewingDone === null ? { key, state: "unwired" } : { key, state: i.viewingDone ? "known" : "unknown" };
    case "apply_intent": return i.applyIntent === undefined || i.applyIntent === null ? { key, state: "unwired" } : { key, state: i.applyIntent ? "known" : "unknown" };
    case "apply_form": return i.applyForm === undefined || i.applyForm === null ? { key, state: "unwired" } : { key, state: i.applyForm === "received" ? "known" : "unknown", value: i.applyForm };
    case "screening_info": return i.screeningInfo === undefined ? { key, state: "unwired" } : i.screeningInfo ? { key, state: "known", value: i.screeningInfo.slice(0, 30) } : { key, state: "unknown" };
  }
}

/** 今の駅で次へ進むのに要る項目の表 */
export function infoFillForNode(node: RouteNodeId | null | undefined, i: InfoInputs): InfoCell[] {
  if (!node) return [];
  return NEEDS_FOR_NEXT[node].map((k) => fillInfo(k, i));
}

/** ブレイン・統括に渡す事実の一覧（道の言葉は入れない）。足りない物が無ければ空 */
export function infoFillMaterialLine(node: RouteNodeId | null | undefined, cells: ReadonlyArray<InfoCell>, nodeName?: string | null): string {
  const gap = cells.filter((c) => c.state !== "known");
  if (!node || !gap.length) return "";
  const known = cells.filter((c) => c.state === "known").map((c) => `${INFO_LABEL[c.key]}${c.value ? `（${c.value}）` : ""}`);
  const unknown = gap.filter((c) => c.state === "unknown").map((c) => INFO_LABEL[c.key]);
  const stale = gap.filter((c) => c.state === "stale").map((c) => `${INFO_LABEL[c.key]}${c.why ? `（${c.why}）` : ""}`);
  const unwired = gap.filter((c) => c.state === "unwired").map((c) => INFO_LABEL[c.key]);
  const lines = [`【📋 今の駅（${nodeName ?? node}）から次へ進むのに要る情報（事実だけ）】`];
  if (known.length) lines.push(`- 分かっている: ${known.join("・")}`);
  if (unknown.length) lines.push(`- 分かっていない: ${unknown.join("・")}`);
  if (stale.length) lines.push(`- 古い（確かめ直しが要るかもしれない）: ${stale.join("・")}`);
  if (unwired.length) lines.push(`- この表に材料が届いていない（分からないとは限らない）: ${unwired.join("・")}`);
  return lines.join("\n");
}
