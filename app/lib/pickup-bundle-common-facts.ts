// app/lib/pickup-bundle-common-facts.ts（純関数・DB 依存なし）
// AIX【物件ピックアップした】で送る束の「全部屋に共通の事実」（敷金礼金なし・礼金あり・敷地内駐車場あり・ペット可 等）を、
// 売上サポの行（property_pickups.terms／equipment＝資料の文字から決定論で読んだ物）から作る。
//
// 2026-10-15 竹内さん「入れれるようにする」: 竹内さんが物件ピックアップの文に書く「束に共通の事実」
//   （「敷金礼金無しのお部屋は現在募集に出ておりませんでしたので礼金備わったお部屋となりますが」「敷地内駐車場あり」等）が一番の伸びしろ。
//   スタッフの実送信（「ピックアップ」を含む 1,472通）で共通の事実らしい語: ペット 186・駐車場 79・礼金 67・バストイレ別 59・敷金 55・独立洗面 49・オートロック 32・2階以上 25。
// 決まり（網と安全の線だけ。書くかどうかは文を作る側＝ブレイン・生成が決める）:
//   - 束の全部屋の材料（行）がそろった時だけ作る（1部屋でも分からなければ作らない＝束の事として言い切れない）
//   - 2部屋以上の時だけ（1部屋は物件オススメの材料で足りる）
//   - 「全部屋が資料にそう書いてある」物だけ。記載なし（unlisted）は「無い」ではなく分からない＝共通にしない
//   - 礼金・敷金は資料の表の数字（terms）だけ。送った画像の読み（sent_image_properties.facts）は礼金の読みが揺れるので使わない（f36803ad）
// 戻す: PICKUP_COMMON_FACTS=off
import type { PickupTerms } from "./pickup-terms";
import type { PickupEquipment } from "./pickup-equipment";
import type { EquipKey } from "./listing-equipment";

export type CommonFactRow = { terms?: unknown; equipment?: unknown } | null | undefined;

export function pickupCommonFactsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PICKUP_COMMON_FACTS ?? "").trim().toLowerCase() !== "off";
}

/** 共通にしてよい設備（お客様がよく書く・資料の欄で有無がはっきり書かれる物）と、文に書く時の言い方 */
const EQUIP_PHRASE: ReadonlyArray<[EquipKey, string]> = [
  ["pet", "ペット飼育可能"],
  ["parking", "駐車場あり"],
  ["bath_toilet", "バス・トイレ別"],
  ["washbasin", "独立洗面台付き"],
  ["autolock", "オートロック付き"],
  ["delivery_box", "宅配ボックス付き"],
  ["elevator", "エレベーター付き"],
  ["net_free", "インターネット無料"],
  ["laundry_in", "室内洗濯機置場"],
  ["floor2", "2階以上"],
  ["two_person", "二人入居可"],
];

const asTerms = (v: unknown): Partial<PickupTerms> | null => (v && typeof v === "object" ? (v as Partial<PickupTerms>) : null);
const asEquip = (v: unknown): Partial<PickupEquipment> | null => (v && typeof v === "object" ? (v as Partial<PickupEquipment>) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * 束の全部屋に共通の事実（文に書ける短い言い方の並び）。作れない時は空。
 * rows は送る画像と同じ並び・同じ数（分からない画像は null）。
 */
export function bundleCommonFacts(rows: ReadonlyArray<CommonFactRow>): string[] {
  if (rows.length < 2 || rows.some((r) => !r)) return [];
  const terms = rows.map((r) => asTerms(r!.terms));
  const equips = rows.map((r) => asEquip(r!.equipment));
  const out: string[] = [];

  // 敷金・礼金（資料の表の数字。全部屋が読めた時だけ）
  const dep = terms.map((t) => num(t?.deposit));
  const key = terms.map((t) => num(t?.keyMoney));
  const allDep = dep.every((v) => v != null), allKey = key.every((v) => v != null);
  const depZero = allDep && dep.every((v) => v === 0);
  const keyZero = allKey && key.every((v) => v === 0);
  if (depZero && keyZero) out.push("敷金礼金なし");
  else {
    if (keyZero) out.push("礼金なし");
    else if (allKey && key.every((v) => (v as number) > 0)) out.push("礼金あり");
    if (depZero) out.push("敷金なし");
  }

  // 入居時期・新築・フリーレント
  if (terms.every((t) => t?.moveIn?.kind === "immediate")) out.push("即入居可");
  if (terms.every((t) => t?.newBuild === true)) out.push("新築");
  if (terms.every((t) => (num(t?.freeRent?.months) ?? 0) > 0)) out.push("フリーレント付き");

  // 設備（全部屋が「あり（ok）」と書いてある物だけ。同じ建物の別の部屋から補った ok〔建〕も資料の文字なので含める）
  for (const [k, phrase] of EQUIP_PHRASE) {
    const facts = equips.map((e) => e?.facts?.[k]);
    if (!facts.every((f) => f?.s === "ok")) continue;
    if (k === "pet") {
      out.push(facts.every((f) => !/相談/.test(String(f?.d ?? ""))) ? "ペット飼育可能" : "ペット飼育可能（相談の部屋を含む）");
      continue;
    }
    if (k === "parking") {
      // 駐車場は全部屋が「敷地内・空きあり」と書いてある時だけ（近隣・敷地外・空き不明〔設備あり〕は束の事として言い切らない）。
      //   2026-10-15 確かめる人: itandi の欄は証拠（ev）が「駐車場空きあり」だけで敷地内/敷地外/近隣が落ちる（listing-equipment の pTok）＝
      //   d が「空きあり」でも近隣の事がある。旧は d≠近隣 なら「駐車場あり」を出していた（近隣・空き不明も束の事になった）
      if (facts.every((f) => f?.d === "空きあり" && /敷地内/.test(String(f?.ev ?? "")))) out.push("敷地内駐車場あり");
      continue;
    }
    out.push(phrase);
  }
  return out;
}

/** 生成・ブレインに渡す注記（無ければ空） */
export function buildBundleCommonFactsNote(facts: readonly string[], total: number): string {
  if (facts.length === 0 || total < 2) return "";
  return `【今回送る${total}部屋すべてに共通の事実（売上サポの資料の文字から・全部屋で確かめた物だけ）】${facts.join("・")}`
    + "\n→ 束の説明に役立つ時だけ書いてよい（例:「敷金礼金なしのお部屋となります！！」「礼金ありのお部屋となりますが」「敷地内駐車場ありのお部屋」）。書くかどうかは会話の流れで決める。書くなら言い方を足さない・ここに無い事を全部屋の事として書かない";
}

/**
 * 画面が渡した「画像ごとの売上サポの行 ID」（分からない画像は null）を、送る画像の数にそろえて読む。
 * 数が合わない・形が違う時は null（並びが信用できない）
 */
export function parsePickupIdsByImage(v: unknown, imageCount: number): Array<number | null> | null {
  if (!Array.isArray(v) || v.length !== imageCount || imageCount === 0 || imageCount > 20) return null;
  const out = v.map((x) => {
    const n = Number(x);
    return x != null && Number.isInteger(n) && n > 0 ? n : null;
  });
  // 同じ行 ID が2枚に付いていたら並びが信用できない
  const ids = out.filter((x): x is number => x != null);
  if (new Set(ids).size !== ids.length) return null;
  return out;
}
