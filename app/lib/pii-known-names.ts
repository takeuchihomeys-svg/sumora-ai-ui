// app/lib/pii-known-names.ts
// 読み替え（pii-pseudonym）の「正解集合」＝お客様の名前を取ってくる1か所。
//
// 2026-09-19 竹内「お客さんの本名や電話番号は絶対にマスキングするように」
//   事例（ai_reply_examples）には**他のお客様**の会話が毎回8件載るので、当事者の名前だけでは足りない。
//   会話は300件台なので全部持っても軽い。5分だけ覚えておく。
//
// ⚠ AIX と返信生成で別々に実装しない（設計知見「同じ事実を2か所に置かない」）。
//   pii-pseudonym.ts は DB に触らない純関数のままにしたいので、取得はこのファイルに分ける。
import { supabase } from "./supabase-server";
import { buildAltNameMask, type AltNameMask } from "./pii-mask";

let cache: { at: number; names: string[] } | null = null;
const TTL_MS = 5 * 60_000;

/**
 * 当事者の別名: property_customers の登録名（本名のことがある）。
 * 2026-09-23 YUMA の DeepSeek 実測: 【お客様の希望条件（DB登録済み）】の「顧客名: 〇〇さん」は LINE の表示名と違い、
 *   全会話の表示名一覧にも無いので素のまま外に出ていた（ground-truth.ts が property_customer_id で引く）。
 *   取れなくても生成は止めない（表示名の仮名化は別に効く）
 * 2026-10-20 確かめる人（P1 979a4c55 の見直し・竹内さん「DeepSeek に渡す時だけ伏せ、戻す時に元の名前に戻す仕組みに call_name も入れる」）:
 *   会話に固定した呼び名（conversations.call_name＝スタッフが呼んだ本当の名前）も当事者の別名にする。
 *   表示名を🎀に変えたお客様では、本文の「ayakaさん」が表示名とも登録名とも違い、素のまま DeepSeek に渡っていた
 */
export async function loadPartyAliases(conversationId: string | null | undefined): Promise<string[]> {
  if (!conversationId) return [];
  try {
    let convRes = await supabase.from("conversations").select("property_customer_id, call_name").eq("id", conversationId).maybeSingle();
    if (convRes.error) convRes = await supabase.from("conversations").select("property_customer_id").eq("id", conversationId).maybeSingle();
    const conv = convRes.data as { property_customer_id?: string | null; call_name?: string | null } | null;
    const callName = String(conv?.call_name ?? "").trim().replace(/(?:さん|様|さま)$/, "").trim();
    const out = callName ? [callName] : [];
    const pcId = conv?.property_customer_id ?? null;
    if (!pcId) return out;
    const { data: pc } = await supabase.from("property_customers").select("customer_name").eq("id", pcId).maybeSingle();
    const name = String((pc as { customer_name?: string | null } | null)?.customer_name ?? "").trim();
    return [...new Set([...out, ...(name ? [name] : [])])];
  } catch (e) {
    console.warn("[pii-known-names] 登録名の取得失敗:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** 全会話のお客様名（重複なし）。取れなければ前回の値、それも無ければ空 */
export async function loadKnownCustomerNames(): Promise<string[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.names;
  try {
    const { data } = await supabase.from("conversations").select("customer_name").limit(2000);
    const names = [...new Set((data ?? [])
      .map((r: { customer_name: string | null }) => (r.customer_name ?? "").trim())
      .filter(Boolean))];
    cache = { at: Date.now(), names };
    return names;
  } catch (e) {
    // 取れなくても当事者の名前は伏せられる。ここで生成を止めない
    console.warn("[pii-known-names] 取得失敗:", e instanceof Error ? e.message : e);
    return cache?.names ?? [];
  }
}

let callCache: { at: number; names: string[] } | null = null;
/**
 * 2026-10-20 確かめる人（竹内さん「DeepSeek に渡す時だけ伏せ、戻す時に元の名前に戻す仕組みに call_name も入れる」）:
 *   全会話の固定の呼び名（conversations.call_name＝スタッフが呼んだ本当の名前・重複なし）。手本（他のお客様の会話）に出る本当の名前は、
 *   表示名が絵文字の会話では表示名の一覧だけでは伏せられない。**DeepSeek に回す時だけ**既知の名前に足す（Claude の経路は今のまま）
 */
export async function loadKnownCallNames(): Promise<string[]> {
  if (callCache && Date.now() - callCache.at < TTL_MS) return callCache.names;
  try {
    const { data, error } = await supabase.from("conversations").select("call_name").not("call_name", "is", null).limit(2000);
    if (error) return callCache?.names ?? [];
    const names = [...new Set(((data ?? []) as Array<{ call_name: string | null }>)
      .map((r) => String(r.call_name ?? "").trim().replace(/(?:さん|様|さま)$/, "").trim())
      .filter(Boolean))];
    callCache = { at: Date.now(), names };
    return names;
  } catch (e) {
    console.warn("[pii-known-names] 呼び名の取得失敗:", e instanceof Error ? e.message : e);
    return callCache?.names ?? [];
  }
}

const stripHonor = (s: unknown) => String(s ?? "").trim().replace(/(?:さん|様|さま)$/, "").trim();

/**
 * 2026-10-20 決定 209b9a92（表示名しか伏せていなかった DeepSeek の経路の残り）: 会話ごとの当事者の別名をまとめて読む。
 *   会話の表示名（customer_name）・固定の呼び名（call_name）・顧客管理の登録名（property_customers.customer_name）。
 *   週の学習・見張りのように多くの会話を一度に扱う所で、loadPartyAliases を会話の数だけ呼ばないための形（読むだけ・2回の SELECT）。
 *   取れなければ空（表示名の伏せは呼ぶ側に残る・生成は止めない）
 */
export async function loadPartyAliasesMany(conversationIds: ReadonlyArray<string | null | undefined>): Promise<Map<string, string[]>> {
  const ids = [...new Set(conversationIds.filter((x): x is string => !!x))];
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  try {
    type C = { id: string; customer_name?: string | null; call_name?: string | null; property_customer_id?: string | null };
    const convs: C[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200);
      let r = await supabase.from("conversations").select("id, customer_name, call_name, property_customer_id").in("id", part);
      if (r.error) r = await supabase.from("conversations").select("id, customer_name, property_customer_id").in("id", part) as typeof r;
      convs.push(...((r.data ?? []) as C[]));
    }
    const pcIds = [...new Set(convs.map((c) => c.property_customer_id).filter((x): x is string => !!x))];
    const pcName = new Map<string, string>();
    for (let i = 0; i < pcIds.length; i += 200) {
      const { data } = await supabase.from("property_customers").select("id, customer_name").in("id", pcIds.slice(i, i + 200));
      for (const p of (data ?? []) as Array<{ id: string; customer_name: string | null }>) if (p.customer_name) pcName.set(p.id, p.customer_name.trim());
    }
    for (const c of convs) {
      const names = [stripHonor(c.customer_name), stripHonor(c.call_name), c.property_customer_id ? (pcName.get(c.property_customer_id) ?? "") : ""].filter(Boolean);
      out.set(c.id, [...new Set(names)]);
    }
  } catch (e) {
    console.warn("[pii-known-names] 別名の一括取得失敗:", e instanceof Error ? e.message : e);
  }
  return out;
}

/**
 * 2026-10-20 決定 209b9a92: DeepSeek に回る時だけ使う名前の束（buildAltNameMask）を1会話分読む。
 *   base＝今まで渡していた名前（表示名など・今までどおり）／当事者の別名（呼び名・登録名・表示名）／他のお客様の呼び名。
 *   ⚠ Claude に回る経路では呼ばない（Claude の材料は1文字も変えない）
 */
export async function loadAltNameMask(conversationId: string | null | undefined, base: ReadonlyArray<string | null | undefined>, opts: { otherCallNames?: boolean } = {}): Promise<AltNameMask> {
  const [party, others] = await Promise.all([
    conversationId ? loadPartyAliasesMany([conversationId]).then((m) => m.get(conversationId) ?? []) : Promise.resolve([] as string[]),
    opts.otherCallNames === false ? Promise.resolve([] as string[]) : loadKnownCallNames().catch(() => [] as string[]),
  ]);
  return buildAltNameMask(base, party, others);
}

/**
 * 2026-10-20 決定 209b9a92: 顧客管理のお客様（property_customers.id）に結んだ会話の別名をまとめる（会話 ID が手元に無い所＝条件の要約・画面の見張り）。
 *   1人のお客様に会話が複数（アカウント違い）ある時は全部の別名を足す（伏せが増えるだけ・戻さない伏せの所で使う）
 */
export async function loadPartyAliasesByCustomer(propertyCustomerId: string | null | undefined, conversationIds: ReadonlyArray<string | null | undefined> = []): Promise<string[]> {
  const ids = new Set(conversationIds.filter((x): x is string => !!x));
  if (propertyCustomerId) {
    try {
      const { data } = await supabase.from("conversations").select("id").eq("property_customer_id", propertyCustomerId).limit(10);
      for (const r of (data ?? []) as Array<{ id: string }>) ids.add(r.id);
    } catch { /* 取れなくても伏せは表示名・登録名で効く */ }
  }
  const m = await loadPartyAliasesMany([...ids]);
  return [...new Set([...m.values()].flat())];
}
