// app/lib/property-name-ledger-server.ts — 物件名の帳簿を DB から引く（読んだ名前に関係する行だけ・読むだけ）
//
// 2026-10-14 竹内さん「送った本文・売上サポ・AIX の記録・資料から正しい物件名の帳簿を作る（出所と回数つき・資料の文字とスタッフの入力ほど信頼）」
//   帳簿は表を作らず、その場で引く（名前の部分＝シリーズ名・地名で ilike・売上サポと送付は各 1000行・AIX は 200行まで）:
//     property_pickups.property_name → text（資料の文字）
//     aix_usage_logs.property_names（AIX でスタッフが入れた名前・試験の bexam は除く）→ staff
//     sent_properties（source≠vision）→ shared（グループに共有・照合済みの送付）／ source=vision → read（数えるだけ・信頼に入れない）
//   直しの決まりは property-name-fix.ts（純関数）。
import { supabase } from "@/app/lib/supabase";
import { buildLedger, fixReadPropertyName, kanjiRuns, placeFixCandidate, type LedgerEntry, type LedgerSource, type NameFixResult } from "@/app/lib/property-name-fix";
import { toJapaneseKanji } from "@/app/lib/ja-kanji";

/** 引く語（漢字の並び・その直しの候補・片仮名と英字の3字以上）。PostgREST の or() を壊す字は外す */
export function ledgerSearchTerms(name: string): string[] {
  const t = toJapaneseKanji(String(name ?? "")).normalize("NFKC");
  const terms = new Set<string>();
  for (const r of kanjiRuns(t)) {
    if (Array.from(r.text).length >= 2) terms.add(r.text);
    const f = placeFixCandidate(r.text);
    if (f) terms.add(f.to);
  }
  for (const m of t.matchAll(/[ァ-ヶー]{3,}|[A-Za-z]{3,}/g)) {
    const w = Array.from(m[0]);
    // シリーズ名そのものが化けている時（ガーデンプラッツ→ガーデンプランツ）も引けるように、頭と尻の3字でも引く
    //   英字は語のまま（「Gra」「and」のような短い頭尻は広すぎて 1000行の上限に当たる）
    if (w.length >= 5 && /^[ァ-ヶー]+$/.test(m[0])) { terms.add(w.slice(0, 3).join("")); terms.add(w.slice(-3).join("")); }
    else terms.add(m[0]);
  }
  return [...terms].map((s) => s.replace(/[,()"'\\%_*.:]/g, "")).filter((s) => Array.from(s).length >= 2).slice(0, 10);
}

export async function loadLedgerFor(name: string): Promise<LedgerEntry[]> {
  const terms = ledgerSearchTerms(name);
  if (!terms.length) return [];
  const orName = terms.map((s) => `property_name.ilike.%${s}%`).join(",");
  const orText = terms.map((s) => `generated_text.ilike.%${s}%`).join(",");
  const [pk, sp, ax] = await Promise.all([
    supabase.from("property_pickups").select("property_name").or(orName).order("created_at", { ascending: false }).limit(1000),
    supabase.from("sent_properties").select("property_name, source").or(orName).order("sent_at", { ascending: false }).limit(1000),
    supabase.from("aix_usage_logs").select("property_names, line_message_id").or(orText).not("property_names", "is", null).order("created_at", { ascending: false }).limit(200),
  ]);
  const rows: Array<{ name: string | null; source: LedgerSource }> = [];
  for (const r of (pk.data ?? []) as Array<{ property_name: string | null }>) rows.push({ name: r.property_name, source: "text" });
  for (const r of (sp.data ?? []) as Array<{ property_name: string | null; source: string | null }>) rows.push({ name: r.property_name, source: r.source === "vision" ? "read" : "shared" });
  for (const r of (ax.data ?? []) as Array<{ property_names: string[] | null; line_message_id: string | null }>) {
    if (String(r.line_message_id ?? "").startsWith("bexam")) continue;
    for (const n of r.property_names ?? []) rows.push({ name: n, source: "staff" });
  }
  return buildLedger(rows);
}

/** 読んだ物件名を帳簿と地名の表で直す（失敗しても投げない・直せない時は読んだまま＋status） */
export async function fixReadPropertyNameWithLedger(name: string | null | undefined): Promise<NameFixResult> {
  const raw = String(name ?? "").trim();
  try {
    const ledger = raw ? await loadLedgerFor(raw) : [];
    return fixReadPropertyName(raw, ledger);
  } catch (e) {
    console.warn("[property-name-ledger] 失敗:", e instanceof Error ? e.message : e);
    return fixReadPropertyName(raw, []);
  }
}
