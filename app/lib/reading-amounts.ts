// app/lib/reading-amounts.ts（純関数・依存なし）
// 画像から読んだ金額（敷金・礼金）の「万」の読み違いを、同じ読み取りの賃料と照らして直す安全の線（決定論）。
//
// 2026-10-14 竹内さん「賃料・管理費・敷金・礼金・保証料・初期費用の読み取りを実データで測る…取り違え（70,000/7,000・管理費込み/別 等）を直す」
//   測り方 scripts/audit-reading-amounts.ts（送った画像の読み取り × 同じ部屋の売上サポの行＝資料の文字の層・30日以内・368組）:
//     賃料 358/368（誤 10: 1字の読み違い 71,000/78,000・別の部屋や改定・管理費込み 2）／管理費 363/368／敷金 346/349／礼金 345/362
//     直せる型（決定論）: 「2万円」「20万円」「5.5万円」を 2・20・5.5 と書いた（指示は「月数なら月数の数字・円なら円の数字」）
//       → 12以下は月数・それより大きければ円（candidate-facts.factsFromImageRead）なので 20 は「20円」、5.5 は「5.5ヶ月」になっていた
//   直す線（どれも同じ読み取りの賃料がある時だけ）:
//     ① 円の値が 1,000 未満（20円・55円）→ 万円の読み違い（×10,000）。直した値が賃料の 6倍以下の時だけ
//     ② 月数が 3 を超え（5.5ヶ月・4.5ヶ月）、万円と見ると賃料の 3倍以下 → 万円（×10,000）
//     ③ 2・3 のような月数は「2ヶ月」と「2万円」を見分けられない → 触らない（資料の文字の層・スタッフの入力で確かめる）
//   賃料・管理費の1字の読み違い（7↔1）は決定論で直せない＝読み取りの指示（property-image-read の PROPERTY_IMAGE_PROMPT）で「万」を円に直して書かせる
// 戻す: READ_AMOUNT_GUARD=off

export type ReadAmountFacts = {
  rent?: number | null; admin_fee_yen?: number | null;
  deposit_months?: number | null; deposit_yen?: number | null; key_money_months?: number | null; key_money_yen?: number | null;
  [k: string]: unknown;
};

export function readAmountGuardEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.READ_AMOUNT_GUARD ?? "").trim().toLowerCase() !== "off";
}

/** 額が賃料の 0.5 ヶ月刻み（0.5〜3）にほぼ一致するか（±2%） */
function monthLike(yen: number, rent: number): boolean {
  const r = yen / rent;
  return [0.5, 1, 1.5, 2, 2.5, 3].some((k) => Math.abs(r - k) <= k * 0.02);
}

export function checkReadAmounts<T extends ReadAmountFacts>(facts: T, env: Record<string, string | undefined> = process.env): { facts: T & ReadAmountFacts; changes: string[] } {
  const changes: string[] = [];
  if (!readAmountGuardEnabled(env)) return { facts, changes };
  const rent = typeof facts.rent === "number" && facts.rent > 0 ? facts.rent : null;
  if (rent == null) return { facts, changes };
  const out: ReadAmountFacts = { ...facts };
  for (const k of ["deposit", "key_money"] as const) {
    const yk = `${k}_yen` as const, mk = `${k}_months` as const;
    const y = out[yk], m = out[mk];
    if (typeof y === "number" && y > 0 && y < 1000 && y * 10000 <= rent * 6) {
      out[yk] = Math.round(y * 10000);
      changes.push(`${yk}:${y}→${out[yk]}`);
    } else if (typeof m === "number" && m > 3 && m * 10000 <= rent * 3 && (!Number.isInteger(m) || monthLike(m * 10000, rent))) {
      // fix(review): 整数の月数（4ヶ月・5ヶ月）は関西の保証金・敷金に本当にある＝「4万円」と見分けられない。
      //   整数は、万円と見た額が賃料のちょうど 0.5/1/1.5/2/2.5/3 ヶ月分の時だけ直す（5.5 のような端数は月数として不自然なので今まで通り直す）
      delete out[mk];
      out[yk] = Math.round(m * 10000);
      changes.push(`${mk}:${m}→${yk}:${out[yk]}`);
    }
  }
  return { facts: out as T & ReadAmountFacts, changes };
}

export type AmountTruth = { rent: number | null; admin: number | null; depM: number | null; keyM: number | null; depY: number | null; keyY: number | null };
export type AmountFacts = { rent?: number; admin_fee_yen?: number; deposit_months?: number; deposit_yen?: number; key_money_months?: number; key_money_yen?: number };
/** 読み取りの金額と資料の文字の層の金額を比べる（純関数・項目ごとに 正/誤/比べない） */
export function compareReadAmounts(f: AmountFacts, t: AmountTruth): Record<"rent" | "admin" | "deposit" | "key", "ok" | "bad" | null> {
  const months = (m: number | null | undefined, y: number | null | undefined) => (m != null ? m : y != null && t.rent ? Math.round((y / t.rent) * 10) / 10 : null);
  const cmpM = (rm: number | null, tm: number | null) => (rm == null || tm == null ? null : Math.abs(rm - tm) < 0.05 ? "ok" : "bad");
  return {
    rent: f.rent == null || t.rent == null ? null : f.rent === t.rent ? "ok" : "bad",
    admin: f.admin_fee_yen == null || t.admin == null ? null : f.admin_fee_yen === t.admin ? "ok" : "bad",
    deposit: cmpM(months(f.deposit_months, f.deposit_yen), months(t.depM, t.depY)),
    key: cmpM(months(f.key_money_months, f.key_money_yen), months(t.keyM, t.keyY)),
  };
}
