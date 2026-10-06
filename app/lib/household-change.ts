// app/lib/household-change.ts — 世帯の変わり目（一人になる・二人になる・家族が増える・ペットを手放す）で検索の条件を連動して直す（純関数・DB なし）
//
// 2026-10-06 ⑫ 竹内さん「一人になった場合など連動して物件検索の条件も変更されるようにする」
//   あかり 10/02「別れることになって」「私一人になるかもです」「ここの部屋に似た感じでちっさくて大丈夫です！」→ 登録の条件に「二人入居可」が残り、
//   送っていない部屋が全部 保留（二人入居 NG）。読み方は condition-reading.householdChangeOf / smallerOkOf、書くのは household-change-server.ts。
//   変える物は決まった物だけ（他の希望は残す）:
//     一人になる    → 条件の欄（preferences・other_requests）から二人入居・同棲・カップル・二人暮らし・ルームシェアの節を外す
//     二人になる    → preferences に「二人入居可」を足す（無ければ）
//     ペットを手放す → ペットの節を外す
//     家族が増える  → 列は変えない（間取りの広げ方は人が決める）。帯でスタッフに知らせるだけ
//     小さくて大丈夫 → 広さの下限（floor_area_min）を外し、「広め」等の節を外す。間取りの列は変えない（帯で知らせる）
//   帯（additional_conditions）の文は物件検索ブレインの条件の読み取り（property-brain.detectConditionWants は additional_conditions も読む）に
//   拾われない言い方にする（「二人入居」「同棲」「ペット」「単身」の語を帯に書かない＝外した条件を帯から戻さない）
import type { HouseholdChange } from "./condition-reading";

export type HouseholdCurrent = { preferences?: string | null; other_requests?: string | null; floor_area_min?: number | null; floor_plan?: string | null };
export type HouseholdPlan = { updates: Record<string, unknown>; banner: string | null; removed: string[] };

const SPLIT_RE = /[・、,，\n]+/;
const TWO_PERSON_CLAUSE_RE = /二人入居|2人入居|ふたり入居|２人入居|同棲|カップル|二人暮らし|2人暮らし|ふたり暮らし|ルームシェア|夫婦/;
const PET_CLAUSE_RE = /ペット|犬|猫|小型犬|大型犬/;
const WIDE_CLAUSE_RE = /広め|広い|広く|ゆったり|[0-9０-９]{2,3}\s*(?:㎡|平米|m2)\s*以上/;

/** 節に分けて re に当たる節を外す（変わらなければ null） */
function dropClauses(text: string | null | undefined, re: RegExp): { text: string | null; removed: string[] } | null {
  const src = String(text ?? "");
  if (!src.trim()) return null;
  // 区切り（・、改行）は元のまま残す（外した節とその前の区切りだけ消す＝他の希望の書き方を変えない）
  const toks = src.split(new RegExp(`(${SPLIT_RE.source})`));
  const removed: string[] = [];
  const out: string[] = [];
  for (let i = 0; i < toks.length; i += 2) {
    const body = toks[i] ?? "";
    const sep = i > 0 ? toks[i - 1] ?? "" : "";
    if (body.trim() && re.test(body.normalize("NFKC"))) { removed.push(body.trim()); continue; }
    if (!body.trim() && !out.length) continue;
    out.push(out.length ? sep : "", body);
  }
  if (!removed.length) return null;
  const joined = out.join("").trim();
  return { text: joined || null, removed };
}

/**
 * 世帯の変わり目・「小さくて大丈夫」から条件の直しを決める。change も smallerOk も無ければ空。
 * 外す・足すのは上の決まった物だけ（家賃・エリア・設備の他の希望は触らない）
 */
export function planHouseholdConditions(cur: HouseholdCurrent, change: HouseholdChange | null, smallerOk: boolean): HouseholdPlan {
  const updates: Record<string, unknown> = {};
  const removed: string[] = [];
  const notes: string[] = [];
  let pref = cur.preferences ?? null;
  let other = cur.other_requests ?? null;
  const drop = (re: RegExp) => {
    const a = dropClauses(pref, re); if (a) { pref = a.text; updates.preferences = a.text; removed.push(...a.removed); }
    const b = dropClauses(other, re); if (b) { other = b.text; updates.other_requests = b.text; removed.push(...b.removed); }
  };
  if (change?.kind === "to_single") {
    drop(TWO_PERSON_CLAUSE_RE);
    notes.push(removed.length ? "お一人での入居に変わりました → 同居の条件を外しました" : "お一人での入居に変わりました");
  } else if (change?.kind === "to_two") {
    if (!TWO_PERSON_CLAUSE_RE.test(String(pref ?? "") + String(other ?? ""))) {
      pref = pref ? `${pref}・二人入居可` : "二人入居可";
      updates.preferences = pref;
    }
    notes.push("お二人での入居に変わりました → 同居できる部屋に絞ります");
  } else if (change?.kind === "pet_gone") {
    const n = removed.length; drop(PET_CLAUSE_RE);
    notes.push(removed.length > n ? "動物の飼育が無くなりました → 飼育の条件を外しました" : "動物の飼育が無くなりました");
  } else if (change?.kind === "family_grows") {
    notes.push("ご家族が増える予定です → 間取り・広さの見直しをご確認ください");
  }
  if (smallerOk) {
    const n = removed.length;
    if (cur.floor_area_min != null) { updates.floor_area_min = null; removed.push(`広さ${cur.floor_area_min}㎡以上`); }
    drop(WIDE_CLAUSE_RE);
    notes.push(removed.length > n ? "小さいお部屋でも大丈夫 → 広さの条件を外しました" : "小さいお部屋でも大丈夫とのこと");
    if (cur.floor_plan) notes.push(`間取り（${cur.floor_plan}）はそのまま・必要なら広げてください`);
  }
  return { updates, banner: notes.length ? notes.join("／") : null, removed };
}
