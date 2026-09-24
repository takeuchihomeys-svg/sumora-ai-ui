// app/lib/pickup-terms.ts（純関数・DB 依存なし）
// 資料の表の「募集の条件」（listing-terms.ts）と、お客様の希望（入居時期・入居の条件）の照合を property_pickups.terms に保存する形にする。
// 画面（PickupReview）は保存した line と want を出すだけ（型だけ import する）。
//
// 2026-09-25 竹内「敷金礼金と入居時期、組み込みたい」:
//   「💴 敷0/礼1ヶ月 築8年 入居:11月上旬 普通2年 更新1ヶ月」の1行と、希望との照合（入居時期 ○×・条件 ×）の札
import { CONDITION_LABELS, moveInAvailableFrom, type ConditionKey, type ListingTerms, type TermStatus } from "./listing-terms";
import { matchListingTerms, type CustomerProfile } from "./property-brain";
import type { EquipmentMatch } from "./listing-equipment";

export type PickupTerms = {
  v: 1;
  format: ListingTerms["format"];
  deposit: number | null;
  keyMoney: number | null;
  depositSource: ListingTerms["depositSource"];
  guaranteeDeposit: number | null;
  builtYear: number | null;
  builtMonth: number | null;
  buildingAge: number | null;
  newBuild: boolean;
  moveIn: { kind: ListingTerms["moveIn"]["kind"]; date?: string; part?: ListingTerms["moveIn"]["part"]; day?: number; current: ListingTerms["moveIn"]["current"]; availableFrom: string | null };
  contract: { kind: ListingTerms["contract"]["kind"]; years?: number };
  renewal: { kind: ListingTerms["renewalFee"]["kind"]; months?: number; yen?: number; basis?: string };
  freeRent: { months: number | null } | null;
  /** 記載のあった入居の条件だけ（s=ok/ng/consult・ev=根拠） */
  conditions: Partial<Record<ConditionKey, { s: Exclude<TermStatus, "unlisted">; ev: string | null }>>;
  singleOnlyRestricted: boolean;
  /** 説明文に無く、資料の表で埋めた判定の材料（deposit・keyMoney・buildingAge） */
  filled: string[];
  evidence: ListingTerms["evidence"];
  /** お客様の希望との照合（希望が無い物は null・空） */
  want: {
    moveIn: { label: string | null; wantBy: string | null; result: "ok" | "late" | "unknown" } | null;
    conditions: Array<{ key: ConditionKey; label: string; status: TermStatus }>;
  };
  /** 「💴 敷0/礼1ヶ月 築8年 入居:11月上旬 普通2年 更新1ヶ月」 */
  line: string;
};

const months = (v: number | null) => (v == null ? "?" : v === 0 ? "0" : `${v}ヶ月`);

/** 入居時期の短い言い方（「即入居」「11月上旬」「10/20」「相談」「居住中」）。書いていなければ null */
export function moveInLabel(m: Pick<ListingTerms["moveIn"], "kind" | "date" | "part" | "day" | "current">): string | null {
  if (m.kind === "immediate") return "即入居";
  if (m.kind === "date" && m.date) {
    const mon = parseInt(m.date.slice(5, 7), 10);
    return m.day ? `${mon}/${m.day}` : `${mon}月${m.part ?? ""}`;
  }
  if (m.kind === "consult") return m.current === "leaving" ? "退去予定・相談" : "相談";
  if (m.kind === "occupied") return "居住中";
  return null;
}

/** 画面の1行（書いていない項目は出さない。敷礼は片方でも読めたら出す） */
export function formatTermsLine(t: Pick<PickupTerms, "deposit" | "keyMoney" | "buildingAge" | "newBuild" | "moveIn" | "contract" | "renewal" | "freeRent">): string {
  const parts: string[] = [];
  if (t.deposit != null || t.keyMoney != null) parts.push(`敷${months(t.deposit)}/礼${months(t.keyMoney)}`);
  if (t.newBuild && (t.buildingAge ?? 0) === 0) parts.push("新築");
  else if (t.buildingAge != null) parts.push(`築${t.buildingAge}年`);
  const mi = moveInLabel(t.moveIn);
  if (mi) parts.push(`入居:${mi}`);
  if (t.contract.kind !== "unknown" || t.contract.years != null) {
    parts.push(`${t.contract.kind === "fixed" ? "定期借家" : t.contract.kind === "normal" ? "普通" : ""}${t.contract.years != null ? `${t.contract.years}年` : ""}`);
  }
  if (t.renewal.kind === "none") parts.push("更新料なし");
  else if (t.renewal.kind === "months") parts.push(`更新${t.renewal.months}ヶ月`);
  else if (t.renewal.kind === "yen" && t.renewal.yen != null) parts.push(`更新${t.renewal.yen.toLocaleString("ja-JP")}円`);
  if (t.freeRent) parts.push(t.freeRent.months != null ? `フリーレント${t.freeRent.months}ヶ月` : "フリーレント");
  return parts.length ? `💴 ${parts.join(" ")}` : "";
}

/** 保存の形にする（profile が無い時は照合なし） */
export function buildPickupTerms(
  t: ListingTerms,
  profile: CustomerProfile | null,
  opts: { today?: Date | string; equipment?: EquipmentMatch | null; filled?: string[] } = {},
): PickupTerms {
  const conditions: PickupTerms["conditions"] = {};
  for (const [k, v] of Object.entries(t.conditions) as Array<[ConditionKey, ListingTerms["conditions"][ConditionKey]]>) {
    if (v.status !== "unlisted") conditions[k] = { s: v.status, ev: v.evidence };
  }
  const m = profile ? matchListingTerms(t, profile, { today: opts.today, equipment: opts.equipment }) : null;
  const w = profile?.moveInWant;
  const base: Omit<PickupTerms, "line"> = {
    v: 1, format: t.format,
    deposit: t.depositMonths, keyMoney: t.keyMoneyMonths, depositSource: t.depositSource, guaranteeDeposit: t.guaranteeDeposit,
    builtYear: t.builtYear, builtMonth: t.builtMonth, buildingAge: t.buildingAgeYears, newBuild: t.newBuild,
    moveIn: {
      kind: t.moveIn.kind, ...(t.moveIn.date ? { date: t.moveIn.date } : {}), ...(t.moveIn.part ? { part: t.moveIn.part } : {}), ...(t.moveIn.day ? { day: t.moveIn.day } : {}),
      current: t.moveIn.current, availableFrom: moveInAvailableFrom(t.moveIn, { today: opts.today }),
    },
    contract: { kind: t.contract.kind, ...(t.contract.years != null ? { years: t.contract.years } : {}) },
    renewal: { kind: t.renewalFee.kind, ...(t.renewalFee.months != null ? { months: t.renewalFee.months } : {}), ...(t.renewalFee.yen != null ? { yen: t.renewalFee.yen } : {}), ...(t.renewalFee.basis ? { basis: t.renewalFee.basis } : {}) },
    freeRent: t.freeRent,
    conditions, singleOnlyRestricted: t.singleOnlyRestricted,
    filled: opts.filled ?? [],
    evidence: t.evidence,
    want: {
      moveIn: m && m.moveIn && w ? { label: w.label, wantBy: w.wantBy, result: m.moveIn } : null,
      conditions: (m?.conditions ?? []).map((c) => ({ key: c.key, label: CONDITION_LABELS[c.key], status: c.status })),
    },
  };
  return { ...base, line: formatTermsLine(base) };
}
