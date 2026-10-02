// app/lib/fabricated-customer-words.ts
// 最終チェックの「捏造」（FABRICATED_AMOUNT／FABRICATED_PROPERTY）の指摘が、お客様自身の言葉の復唱を指していないか（純関数）。
//
// 2026-10-02 ⑫⑬の再生と本番の記録で見つけた穴（scripts/audit-fabricated-customer-words.ts）:
//   お客様「家賃＋管理費で月7万円程度・西九条駅から徒歩3分以内」→ 下書き「西九条駅から徒歩3分以内・家賃管理費込み7万円程度…」に
//   1回目の最終チェックが FABRICATED_PROPERTY:block（d416295c 9/23）／お客様「管理費込み10万まで」→ FABRICATED_AMOUNT（ac7c7fd3 10/02）。
//   書き直しで消えるが、1回目の block で書き直し（Sonnet・数秒・費用）が走り、文も実送信から遠ざかる。
// 原因: 捏造の検査（anomaly_scan）の情報源は CHECKPOINTS・CUSTOMER_CONDITIONS・HISTORY（直近10通）で、
//   ①その回のお客様の発言（lastCustomerMessage）を渡していなかった（HISTORY に今回の通が入らない呼び出しがある）
//   ②「お客様自身の言葉は根拠」と書いておらず、登録の条件（CUSTOMER_CONDITIONS）と食い違う新しい言い直しを捏造と読んだ。
// 直し: 入口＝anomaly_scan に [LATEST_CUSTOMER] と「お客様の言葉の復唱は捏造でない・新しい言い直しが登録より優先」を足す。
//   出口＝LLM の指摘の引用（evidence）の金額・駅・号室・物件名が全部お客様の発言にある時は指摘を外す（この関数）。
//   物件名や金額が1つでもお客様の発言に無ければ外さない（本当の写し間違い・別の金額は残る）。

/** 金額（「7万」「7.5万」「70,000円」）を数の文字列に（「7万円程度」→ "70000"） */
function amountsOf(s: string): string[] {
  const t = s.normalize("NFKC").replace(/[,，]/g, "");
  const out: string[] = [];
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*万/g)) out.push(String(Math.round(Number(m[1]) * 10000)));
  // 「9〜12万」の前の数（万が後ろの数にだけ付く）
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*[〜~～\-－ー]\s*\d+(?:\.\d+)?\s*万/g)) out.push(String(Math.round(Number(m[1]) * 10000)));
  // 条件フォームの家賃の欄の数だけの値（「②【ご希望の家賃（◯万円〜◯万円）】⇒9-12」・652d039f）＝万の単位
  for (const line of t.split("\n")) {
    if (!/家賃/.test(line)) continue;
    const v = line.split(/⇒|】/).pop() ?? "";
    for (const m of v.matchAll(/(?<![\d.])(\d{1,2}(?:\.\d+)?)(?![\d.]*\s*(?:万|円|分|階|㎡|帖|年))/g)) out.push(String(Math.round(Number(m[1]) * 10000)));
  }
  for (const m of t.matchAll(/(\d{4,})\s*円/g)) out.push(String(Number(m[1])));
  return out;
}

/** 駅名・号室・カタカナ／英字の物件名らしい語 */
function namesOf(s: string): string[] {
  const t = s.normalize("NFKC");
  const out: string[] = [];
  for (const m of t.matchAll(/([一-龯ぁ-んァ-ヶーA-Za-z0-9]{1,10}?)駅/g)) out.push(`${m[1]}駅`.replace(/^(?:から|の|は|で|に)/, ""));
  for (const m of t.matchAll(/(\d{2,4})\s*号室/g)) out.push(`${m[1]}号室`);
  for (const m of t.matchAll(/[ァ-ヶー]{4,}|[A-Za-z][A-Za-z\-・. ]{3,}[A-Za-z]/g)) out.push(m[0].trim());
  return [...new Set(out.filter((x) => x.replace(/駅|号室/g, "").length >= 1))];
}

/**
 * evidence（指摘の引用）の金額・名前が全部お客様の発言にあるか。
 * 金額も名前も1つも取れない引用は「分からない」＝ false（外さない）。
 */
export function evidenceFromCustomer(evidence: string | null | undefined, customerTexts: ReadonlyArray<string | null | undefined>): boolean {
  const ev = String(evidence ?? "");
  const cust = customerTexts.map((x) => String(x ?? "")).join("\n");
  if (!ev.trim() || !cust.trim()) return false;
  const ca = new Set(amountsOf(cust));
  const custNorm = cust.normalize("NFKC").replace(/\s+/g, "");
  const amts = amountsOf(ev);
  const names = namesOf(ev);
  if (!amts.length && !names.length) return false;
  if (amts.some((a) => !ca.has(a))) return false;
  if (names.some((n) => !custNorm.includes(n.replace(/\s+/g, "")))) return false;
  return true;
}

/** 外してよい捏造の指摘か（金額・物件の捏造だけ。空き状況・日付・名前・制度は対象外） */
export function isCustomerEchoFabrication(code: string, evidence: string | null | undefined, customerTexts: ReadonlyArray<string | null | undefined>): boolean {
  if (code !== "FABRICATED_AMOUNT" && code !== "FABRICATED_PROPERTY") return false;
  return evidenceFromCustomer(evidence, customerTexts);
}
