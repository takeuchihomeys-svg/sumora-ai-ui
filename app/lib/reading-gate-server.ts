// app/lib/reading-gate-server.ts（サーバー専用・DB 読むだけ＋DeepSeek。画面側から import しない）
// 送った画像の読み取りの確信度のゲート: 怪しい印（reading-confidence.ts）がある欄だけ、売上サポの行と照らし、それでも決まらなければ拡大して読み直す。
//
// 2026-10-14 竹内さん（設計知見 56ecf24a・P1）「自信が無い時・根拠が見つからない時だけ深く調べる。全部に毎回かけない（質が上がり API の無駄も無い）」
//   順番（安い順・どれも印がある欄だけ）:
//     物件名  … 会話の物件名に寄らなかった時だけ。① 賃料・㎡・間取りで売上サポの建物が1つに決まり名前が似ていればその名前（LLM なし）
//                 ② 決まらなければ拡大して読み直し、帳簿にある・確かに直せた名前の時だけ使う
//     号室    … 拡大して読み直し、普通の号室の形の時だけ使う
//     敷金    … ① 同じ部屋の売上サポの行があればそれに合わせる（LLM なし）② 拡大して欄の文字（単位つき）を読む
//                 ③ それでも決まらなければ facts に「単位不明」の印（deposit_unit="unclear"）を付ける（断定するか確認の約束にするかはブレインに任せる）
//   読み直しは1枚1回（欄をまとめて読む）。
// 戻す: READING_CONFIDENCE=off（ゲートごと止める）・READING_RECHECK=off（LLM の読み直しだけ止める）・PROPERTY_NAME_ATTR_FIX=off（①の名前の照らしを止める）
//       PROPERTY_NAME_ATTR_FIX_PLACELESS=off（地名の無い片仮名・英字だけの名前は①で直さない。既定は直す＝竹内悠馬 10/14「直す」・賃料・㎡・間取りで1つに決まり名前が似ている時だけ）
import { supabase } from "@/app/lib/supabase";
import {
  readingConfidenceEnabled, nameSignals, NAME_TRIGGER, roomSignals, amountUnitSignals, lookupByAttributes, attrNameFix,
  adoptRecheckedName, adoptRecheckedRoom, alignUnitWithPickup, applyRecheckedUnits, markUnitUnclear,
  type AttrRow, type AttrHit, type UnitKind,
} from "@/app/lib/reading-confidence";
import type { NameFixResult } from "@/app/lib/property-name-fix";
import { parseLoose } from "@/app/lib/property-name-loose";
import { similarity, normalizePropertyName } from "@/app/lib/property-name-match";

export function attrNameFixEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PROPERTY_NAME_ATTR_FIX ?? "").trim().toLowerCase() !== "off";
}
export function attrNameFixPlacelessEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PROPERTY_NAME_ATTR_FIX_PLACELESS ?? "").trim().toLowerCase() !== "off";
}
/** 読み直した名前を使う時の、1回目の名前との近さの下限（まったく別の建物の名前に入れ替えない） */
export const RECHECK_NAME_MIN_SIM = 0.3;
/** 読み直しに要る最小の時間（これ未満の残り時間なら読み直さない＝関数の時間切れで記録ごと失わない） */
export const RECHECK_MIN_MS = 10_000;

export type GateResult = {
  /** 直した名前（無ければ null）・直した理由 */
  name: { name: string; rule: string } | null;
  room: string | null;
  /** 直した・印を付けた facts（変えなければ null） */
  facts: Record<string, unknown> | null;
  signals: { name: string[]; room: string[]; amount: string[] };
  rechecked: boolean;
  log: string[];
};

/** 売上サポの行（rent_observations）を賃料・㎡で引く（読むだけ・失敗は []） */
async function loadAttrRows(rent: number, area: number): Promise<AttrRow[]> {
  try {
    const { data } = await supabase.from("rent_observations")
      .select("property_name, room_no, rent, area_sqm, floor_plan, total_floors, deposit_months, key_money_months")
      .eq("rent", rent).gte("area_sqm", area - 0.05).lte("area_sqm", area + 0.05).limit(500); // 2026-10-14 確かめる人: 60 で切ると別の建物の行が落ちて「1つに決まる」を誤り得る
    return (data ?? []) as AttrRow[];
  } catch { return []; }
}

/**
 * 1枚の読み取り（1件の画像だけ）に確信度のゲートをかける。失敗しても投げない（何も変えない結果を返す）。
 * @param matched 会話の物件名に寄った（照合できた）か。寄ったら物件名は調べない
 */
export async function runReadingGate(input: {
  imageUrl: string;
  nameFix: NameFixResult;
  matched: boolean;
  roomNumber: string | null;
  facts: Record<string, unknown> | null;
  /** llm_usage_logs に残すか（scripts の確かめは false） */
  recordUsage?: boolean;
  /** 読み直しに使ってよい時間（呼び出し側の関数の残り時間・既定 45秒）。RECHECK_MIN_MS 未満なら読み直さない（印だけ） */
  recheckTimeoutMs?: number;
}): Promise<GateResult> {
  const out: GateResult = { name: null, room: null, facts: null, signals: { name: [], room: [], amount: [] }, rechecked: false, log: [] };
  if (!readingConfidenceEnabled()) return out;
  try {
    const f = input.facts ?? {};
    const rent = typeof f.rent === "number" ? f.rent : null, area = typeof f.area_sqm === "number" ? f.area_sqm : null;
    const ns = input.matched ? [] : nameSignals(input.nameFix.name, input.nameFix).filter((s) => NAME_TRIGGER.has(s));
    const ds = amountUnitSignals(f);
    // 売上サポの行（名前・号室の階数・敷金の①に使う）。印がある時だけ引く
    let hit: AttrHit | null = null;
    const needRows = (ns.length || ds.length || input.roomNumber) && rent && area;
    if (needRows) hit = lookupByAttributes(await loadAttrRows(rent!, area!), { rent, areaSqm: area, floorPlan: typeof f.floor_plan === "string" ? f.floor_plan : null, room: input.roomNumber });
    const readKey = parseLoose(input.nameFix.name)?.key ?? null;
    const rs = roomSignals(input.roomNumber, { totalFloors: hit && hit.key === readKey ? hit.totalFloors : null });
    out.signals = { name: ns, room: rs, amount: ds };
    if (!ns.length && !rs.length && !ds.length) return out;

    // ── 物件名 ①: 賃料・㎡・間取りで1つの建物に決まり、名前が似ている
    let nameOpen = ns.length > 0;
    if (nameOpen && attrNameFixEnabled()) {
      const af = attrNameFix(input.nameFix.name, hit);
      if (af && (!af.placeless || attrNameFixPlacelessEnabled())) {
        out.name = { name: af.name, rule: `attr:rent+area${af.placeless ? "+placeless" : ""}` };
        nameOpen = false;
        out.log.push(`name:attr ${input.nameFix.name}→${af.name}(${af.sim.toFixed(2)})`);
      } else if (af) out.log.push(`name:attr-placeless-skipped ${input.nameFix.name}→${af.name}`);
    }
    // ── 敷金 ①: 同じ部屋の売上サポの行
    let facts: Record<string, unknown> = { ...f };
    let unitOpen: UnitKind[] = ds.map((s) => (s === "deposit_unit" ? "deposit" : "key_money"));
    if (unitOpen.length) {
      const al = alignUnitWithPickup(facts, hit, out.name ? parseLoose(out.name.name)?.key ?? readKey : readKey, unitOpen);
      if (al) { facts = al.facts; unitOpen = []; if (al.changes.length) out.log.push(`unit:pickup ${al.changes.join(",")}`); else out.log.push("unit:pickup-confirmed"); }
    }

    // ── ②: 残った欄だけ、拡大して1回読み直す
    if (nameOpen || rs.length || unitOpen.length) {
      const { readingRecheckEnabled, recheckImageFields } = await import("@/app/lib/reading-recheck-server");
      const budget = Math.min(45_000, input.recheckTimeoutMs ?? 45_000);
      if (budget < RECHECK_MIN_MS) out.log.push(`recheck:skipped-no-time ${budget}ms`);
      const again = readingRecheckEnabled() && budget >= RECHECK_MIN_MS ? await recheckImageFields(input.imageUrl, { timeoutMs: budget, record: input.recordUsage !== false }) : null;
      out.rechecked = !!again;
      if (again) out.log.push(`recheck tiles=${again.tiles} ms=${again.ms} in=${again.usage?.input ?? 0} out=${again.usage?.output ?? 0}`);
      if (again && nameOpen && again.propertyName) {
        const { fixReadPropertyNameWithLedger } = await import("@/app/lib/property-name-ledger-server");
        const ad = adoptRecheckedName(input.nameFix, await fixReadPropertyNameWithLedger(again.propertyName));
        if (ad && similarity(normalizePropertyName(input.nameFix.name), normalizePropertyName(ad.name)) >= RECHECK_NAME_MIN_SIM) {
          out.name = ad; out.log.push(`name:recheck ${input.nameFix.name}→${ad.name}`);
        } else out.log.push(`name:recheck-kept「${again.propertyName}」`);
      }
      if (again && rs.length) {
        const r = adoptRecheckedRoom(input.roomNumber, again.roomNumber);
        if (r) { out.room = r; out.log.push(`room:recheck ${input.roomNumber}→${r}`); } else out.log.push(`room:recheck-kept「${again.roomNumber}」`);
      }
      if (unitOpen.length) {
        // 敷金の読み直しで礼金の欄も一緒に読んだ＝礼金が「万円」と分かった時だけ直す（印は付けない）
        const res = applyRecheckedUnits(facts, again, unitOpen, again ? ["key_money"] : []);
        facts = res.facts;
        if (res.changes.length) out.log.push(`unit:recheck ${res.changes.join(",")}`);
        // ③ 決まらない欄は「単位不明」の印
        if (res.unclear.length) { facts = markUnitUnclear(facts, res.unclear); out.log.push(`unit:unclear ${res.unclear.join(",")}`); }
      }
    }
    if (JSON.stringify(facts) !== JSON.stringify(f)) out.facts = facts;
    return out;
  } catch (e) {
    out.log.push(`error:${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
}
