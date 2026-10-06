// app/lib/building-ad-assume.ts（純関数・DB/LLM なし）
// AD が資料に書かれていない部屋を「同じ建物の別の部屋の AD」で補う（みなし）。
//
// 2026-10-06 竹内さん（2軸の監査の質問2への答え「だいじょうぶ」）: AD が書かれていない部屋を同じ建物の別の部屋の AD で補う
//   （アズ・スタットのみなし＝agent-ad-assume.ts と同じ扱いの追加）。売上サポの行は AD 不明 158行（2,532行中）・そのうち同じ建物の別の部屋で補えるのは約 19行。
//   順番（AD を読む所＝property-pickups-server）: 資料の値（「A D 100%」「広告料 なし」も）→ 元付の決まり（アズ・スタット 200%）→ **同じ建物の別の部屋**（ここ）
// 決まり（誤って高く見せない側）:
//   - 同じ建物 = 建物の鍵（pickup-dedupe.buildingKey＝表記ゆれの正規化・一般名「物件」は比べない）に、濁点・半濁点だけの違いも同じ（customer-state.voicingFold）
//   - 別の部屋（号室が両方読めて違う・片方に号室が無い物も別の資料として使う）。同じ号室は使わない（同じ資料なら同じく AD が無い）
//   - 元付（資料の宅建業の免許番号・弊社帯の免許を除く）が両方読めて違えば使わない（管理会社が違う＝AD の決まりも違う）
//   - 近い時期（既定 30日以内）・みなしで付いた AD（アズ・スタット・この補い）は元にしない（みなしの数珠つなぎをしない）
//   - 同じ建物で AD がばらつく時（部屋ごとに 1〜3 等）は**一番低い値**を使う（高く見せない）
//   - 一番低い値が AD1 未満（AD なし・0.5 等）なら補わない（不明のまま 0点）: 不明を「AD なし＝外す候補」に落とすのは補いの役目を越える
//   補ったことは説明文の行「AD 1.5ヶ月（同じ建物の別の部屋・記載なしのため150%とみなす）」と判定の札 AD_ASSUMED_BUILDING（0点・印）で分かる
import { buildingKey } from "./pickup-dedupe";
import { voicingFold } from "./customer-state";
import { toHalf } from "./candidate-facts";
import { BUILDING_AD_NAME } from "./agent-ad-assume";
import { adMonthsOfPickup } from "./star-rank-pickup";

/** 補いの元にする部屋 */
export type BuildingAdSource = {
  name: string | null | undefined;
  room?: string | null;
  /** その部屋の AD（ヶ月）。null＝分からない（元にしない） */
  adMonths: number | null | undefined;
  /** その AD がみなし（アズ・スタット・同じ建物）なら true（元にしない） */
  assumed?: boolean | null;
  /** 元付の見分け（agentLicenseOf）。null＝読めない（比べない） */
  agent?: string | null;
  /** いつの資料か（ISO） */
  at?: string | null;
};
export type BuildingAdTarget = { name: string | null | undefined; room?: string | null; agent?: string | null; at?: string | null };
export type BuildingAdAssume = {
  /** 補った AD（ヶ月）＝元の部屋の一番低い値 */
  adMonths: number;
  /** 元にした部屋（号室）と値 */
  from: Array<{ room: string | null; adMonths: number }>;
  min: number;
  max: number;
};
export type BuildingAdRule = { maxDays: number; minAd: number; pick: "min" | "max" | "median" | "latest"; requireSameAgent: boolean; /** 元にする部屋の数の下限（1＝1部屋でも補う） */ minRooms?: number };
export const BUILDING_AD_RULE: Readonly<BuildingAdRule> = { maxDays: 30, minAd: 1, pick: "min", requireSameAgent: true, minRooms: 1 };

/** 札の名前（判定の 0点の印）と、説明文の行に入れる名前 */
export const BUILDING_AD_CODE = "AD_ASSUMED_BUILDING";
export { BUILDING_AD_NAME };

/** 建物の鍵（濁点・半濁点の違いも同じ）。一般名・空は "" */
export function buildingAdKey(name: string | null | undefined): string {
  const k = buildingKey(name);
  return k ? voicingFold(k) : "";
}
const normRoom = (r: unknown) => toHalf(String(r ?? "")).replace(/号室?$/, "").replace(/[^0-9A-Za-z]/g, "").replace(/^0+(?=\d)/, "");

/**
 * 資料の文字から元付の見分け（宅建業の免許番号）。弊社帯（1ページ目の先頭の免許）を除いた最後の免許番号。
 *   元付のページだけの文字（agentPagesText）なら最初の免許番号。読めなければ null
 */
const LICENSE_RE = /(大臣|知事)\s*免許\s*[（(]\s*[0-9０-９]+\s*[)）]\s*第\s*([0-9０-９]+)\s*号/g;
export function licenseNosOf(text: string | null | undefined): string[] {
  const t = String(text ?? "").normalize("NFKC");
  const out: string[] = [];
  for (const m of t.matchAll(LICENSE_RE)) { const no = `${m[1]}${m[2].replace(/^0+/, "")}`; if (!out.includes(no)) out.push(no); }
  return out;
}
export function agentLicenseOf(fullText: string | null | undefined, opts?: { agentPagesOnly?: boolean }): string | null {
  const nos = licenseNosOf(fullText);
  if (opts?.agentPagesOnly) return nos[0] ?? null;
  // 先頭＝弊社帯の免許。2つ目以降が元付（同じ番号は1つにまとめてある）
  return nos.length >= 2 ? nos[nos.length - 1] : null;
}

/**
 * 同じ建物の別の部屋の AD でみなす（無ければ null）。
 *   target の AD が資料に無い時だけ呼ぶ（呼ぶ側が見る）。sources は同じ回の他の部屋・最近の売上サポの行
 */
export function sameBuildingAdOf(target: BuildingAdTarget, sources: ReadonlyArray<BuildingAdSource>, rule: Readonly<BuildingAdRule> = BUILDING_AD_RULE): BuildingAdAssume | null {
  const key = buildingAdKey(target.name);
  if (!key) return null;
  const room = normRoom(target.room);
  const at = target.at ? Date.parse(target.at) : NaN;
  // 同じ部屋の何回分もの行は1つに（一番新しい物）。号室の無い行はそれぞれ別に数える
  const byRoom = new Map<string, { room: string | null; adMonths: number; at: number }>();
  sources.forEach((s, i) => {
    if (s.adMonths == null || !Number.isFinite(s.adMonths) || s.assumed) return;
    if (buildingAdKey(s.name) !== key) return;
    const sr = normRoom(s.room);
    if (room && sr && sr === room) return; // 同じ号室は使わない
    if (rule.requireSameAgent && target.agent && s.agent && target.agent !== s.agent) return;
    const st = s.at ? Date.parse(s.at) : NaN;
    if (Number.isFinite(at) && Number.isFinite(st) && Math.abs(at - st) > rule.maxDays * 864e5) return;
    const k = sr || `?${i}`;
    const t = Number.isFinite(st) ? st : 0;
    const prev = byRoom.get(k);
    if (!prev || t > prev.at) byRoom.set(k, { room: sr || null, adMonths: s.adMonths, at: t });
  });
  const used = [...byRoom.values()];
  if (!used.length || used.length < (rule.minRooms ?? 1)) return null;
  const vals = used.map((u) => u.adMonths).sort((a, b) => a - b);
  const min = vals[0], max = vals[vals.length - 1];
  const v = rule.pick === "min" ? min : rule.pick === "max" ? max : rule.pick === "median" ? vals[Math.floor((vals.length - 1) / 2)] : used.slice().sort((a, b) => b.at - a.at)[0].adMonths;
  if (v < rule.minAd) return null;
  return { adMonths: v, from: used.map((u) => ({ room: u.room, adMonths: u.adMonths })), min, max };
}

/** 説明文に足す行（agent-ad-assume.assumedAdSummaryLine と同じ形＝parsePropertyFacts が月数と「みなし」の印を読む） */
export function buildingAdSummaryLine(a: Pick<BuildingAdAssume, "adMonths">): string {
  return `AD ${String(a.adMonths).replace(/\.0$/, "")}ヶ月（${BUILDING_AD_NAME}・記載なしのため${Math.round(a.adMonths * 100)}%とみなす）`;
}
/** みなしの名前が同じ建物の補いか（agent-ad-assume.assumedAdAgentInLine の返り値・facts.adAssumedBy を見る） */
export function isBuildingAdAssumedBy(name: string | null | undefined): boolean {
  return String(name ?? "") === BUILDING_AD_NAME;
}
/** 画面・記録の理由の一文（「AD 150%とみなした（同じ建物の別の部屋 305・資料に記載なし）」） */
export function buildingAdReasonJa(a: BuildingAdAssume): string {
  const rooms = a.from.map((f) => f.room).filter(Boolean).slice(0, 3).join("・");
  return `AD ${Math.round(a.adMonths * 100)}%とみなした（${BUILDING_AD_NAME}${rooms ? ` ${rooms}` : ""}・資料に記載なし${a.min !== a.max ? `・部屋ごとに ${a.min}〜${a.max}ヶ月の低い方` : ""}）`;
}

/** 判定の材料（PropertyFacts の形）の AD（ヶ月）。月数が無ければ円 ÷ 家賃 */
export function adMonthsOfFacts(f: { adMonths?: number | null; adYen?: number | null; rentYen?: number | null }): number | null {
  if (f.adMonths != null && Number.isFinite(f.adMonths)) return f.adMonths;
  return f.adYen != null && f.rentYen ? Math.round((f.adYen / f.rentYen) * 100) / 100 : null;
}
/** 売上サポの行（property_pickups）→ 補いの元。みなしの札（AD_ASSUMED_*）の行は assumed */
export function buildingAdSourceOfPickupRow(r: { property_name?: string | null; room_no?: string | null; reason_codes?: ReadonlyArray<string> | null; ad_yen?: number | null; summary_text?: string | null; pdf_text?: string | null; created_at?: string | null }): BuildingAdSource {
  return {
    name: r.property_name ?? null, room: r.room_no ?? null, adMonths: adMonthsOfPickup(r),
    assumed: (r.reason_codes ?? []).some((c) => /^AD_ASSUMED_/.test(c)), agent: agentLicenseOf(r.pdf_text ?? null), at: r.created_at ?? null,
  };
}
