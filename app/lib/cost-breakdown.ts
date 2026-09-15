// app/lib/cost-breakdown.ts
// AIX【初期費用について】（2026-09-15 竹内・ゆうこ事例）— 純関数・DB 依存なし
//   「これ AIX から送る費用についての項目となるから適当なこと言わないため、AIX ボタンに新しく初期費用についてという項目をつくる。
//    そこ押したら見積書の画像はりつけて、会話を合わせるボタンで初期費用について説明する形とする」
//
// 事例: ゆうこ（オススメ物件を送った後）「家賃だけ払ったら住めるんですか？」「例えばこの場合家賃と管理費を先振り込んだら住めるってことですか？」
//   → 下書きが本文で「初期費用は家賃・管理費に加え敷金礼金等含む総額となり、家賃・管理費のみでのご入居は出来かねます」と
//     見積書を見ずに費用の中身を断言した（その物件の敷金・礼金が0円かもしれないのに）。
// 仕組み: 見積書の画像を読み取って項目と金額を「確定事実」にし（ここで整形）、お客様の質問に答える1通を AI が作る。
//   金額は見積書の読み取り結果とスタッフの入力（火災保険）にある物だけ。それ以外の金額は「〇〇円」に伏せ字 → 送信前チェックで止まる。
//   見積書に無い費用で言ってよいのは、会社の決まり（日割家賃はご入居日によって発生・1日入居ならかからない）だけ。
//
// スタッフの実際の返信（240日・費用の中身の質問への答え）— 生成の言い回しの手本（創作の文例は使わない）
export const COST_BREAKDOWN_STAFF_EXAMPLES: readonly string[] = [
  "こちら鍵交換費用や必要な初期費用は御見積書に含めさせて頂いております😊！！\n火災保険費用（2年で18,000円程）\nが別途必要な金額となります！！\n\n日割家賃につきましては、1日ご入居の場合はかかりませんので、初期費用を出来る限り抑える場合は1日でのご入居でご契約頂くのがオススメです！！",
  "はい！！ペット飼育時敷金が1ヶ月分必要となります！！\nまた火災保険が別途支払いで、18,000円必要となります！\nこちらとご入居日によって日割家賃が発生する形となります😌！！",
  "こちら大和ハウスの物件となり、弊社ですと礼金2ヶ月分必要となります！！\nその他費用の項目がカードキー費用、ICロック電池費用となります！！\nクリーニング費用ですが退去の際必要となります！！",
];

// ── 見積書の読み取り（Vision に渡す指示と、返ってきた JSON の整形）──────────────────────────
export const COST_BREAKDOWN_OCR_SYSTEM = `この画像は賃貸の初期費用の御見積書です。印字されている内容をそのまま読み取り、JSON のみで返してください（説明・前置き禁止）。
{"property_name":"物件名","room_number":"号室","monthly_rent":"家賃（月額）","management_fee":"管理費・共益費（月額）","items":[{"label":"敷金","amount":"0円"},{"label":"礼金","amount":"67,000円"}],"discount":"割引額","total":"初期費用の合計（割引後の請求額）","saving":"一般的な不動産業者との差額（節約額）","notes":["※ご入居日によって日割家賃が発生致します"]}
- 金額の列が2つある時（「ギガ賃貸の場合」「スモラの場合」「イエヤスの場合」と「一般的な不動産屋」）は、自社の列（ギガ賃貸・スモラ・イエヤスの場合）の金額を読む。一般的な不動産屋の列は読まない
- items: 初期費用として請求される行をすべて、見積書の項目名のまま（敷金・礼金・翌月分家賃・共益費・仲介手数料・保証料・火災保険・鍵交換・クリーニング・日割家賃・その他）。0円の行も入れる。割引（ギガ割・スモ割 等）の行は items に入れず discount に
- total: 自社の列の合計（割引後の請求額・「御請求金額」「差引請求金額」）
- 退去時・毎月・更新時に払う費用（退去時クリーニング・月額保証料・更新料 等）は items に入れず notes に「項目名 金額（退去時）」のように書く
- 金額は画像の数字をそのまま「〇〇,〇〇〇円」で。読めない・書かれていない項目は入れない。計算・推測で金額を作らない
- 記載が無い項目は null`;

export type CostBreakdownItem = { label: string; amount: number };
export type CostBreakdown = {
  propertyName: string | null;
  roomNumber: string | null;
  monthlyRent: number | null;
  managementFee: number | null;
  items: CostBreakdownItem[];
  discount: number | null;
  total: number | null;
  saving: number | null;
  notes: string[];
};

/** 「67,000円」「6.7万円」「67000」→ 67000。0円は 0。読めなければ null */
export function yenOf(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
  const s = String(raw).normalize("NFKC").replace(/[,，\s]/g, "").replace(/円$/, "");
  if (!s) return null;
  const man = s.match(/^(\d+(?:\.\d+)?)万(\d+)?$/);
  if (man) return Math.round(parseFloat(man[1]) * 10000) + (man[2] ? parseInt(man[2], 10) : 0);
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  return Math.round(parseFloat(s));
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Vision の返答（JSON）を整形。項目が1つも読めなければ null（金額の無い説明は作らない） */
export function parseCostBreakdownJson(raw: string): CostBreakdown | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let d: Record<string, unknown>;
  try { d = JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
  const items: CostBreakdownItem[] = [];
  for (const it of Array.isArray(d.items) ? d.items : []) {
    const label = str((it as { label?: unknown })?.label);
    const amount = yenOf((it as { amount?: unknown })?.amount);
    if (label && amount !== null) items.push({ label: label.slice(0, 30), amount });
  }
  const total = yenOf(d.total);
  if (items.length === 0 && total === null) return null;
  return {
    propertyName: str(d.property_name),
    roomNumber: str(d.room_number),
    monthlyRent: yenOf(d.monthly_rent),
    managementFee: yenOf(d.management_fee),
    items,
    discount: yenOf(d.discount),
    total,
    saving: yenOf(d.saving),
    notes: (Array.isArray(d.notes) ? d.notes : []).map((n) => str(n)).filter((n): n is string => !!n).slice(0, 8),
  };
}

const fmt = (n: number) => `${n.toLocaleString("ja-JP")}円`;

export type CostBreakdownExtras = {
  /** スタッフが入力した「見積書に含まれない火災保険」の金額（円）。入力が無ければ金額には触れない */
  insuranceSeparateYen?: number | null;
};

/**
 * 読み取った内訳を、生成に渡す「確定事実」のブロックにする。
 * allowedAmounts = 本文に書いてよい金額（見積書の各行・合計・割引・家賃・管理費・家賃＋管理費・スタッフ入力の火災保険）
 */
export function formatCostBreakdownFacts(list: CostBreakdown[], extras: CostBreakdownExtras = {}): { block: string; notes: string[]; allowedAmounts: number[] } {
  const allowed = new Set<number>();
  const lines: string[] = [];
  const notes: string[] = [];
  const badges = ["①", "②", "③"];
  list.forEach((b, i) => {
    const name = [b.propertyName, b.roomNumber ? (/号室$/.test(b.roomNumber) ? b.roomNumber : `${b.roomNumber}号室`) : null].filter(Boolean).join(" ") || `物件${badges[i] ?? i + 1}`;
    const rows: string[] = [];
    if (b.monthlyRent !== null) { rows.push(`家賃（月額）: ${fmt(b.monthlyRent)}`); allowed.add(b.monthlyRent); }
    if (b.managementFee !== null) { rows.push(`管理費・共益費（月額）: ${fmt(b.managementFee)}`); allowed.add(b.managementFee); }
    if (b.monthlyRent !== null && b.managementFee !== null) allowed.add(b.monthlyRent + b.managementFee);
    for (const it of b.items) { rows.push(`${it.label}: ${fmt(it.amount)}`); allowed.add(it.amount); }
    if (b.discount !== null) { rows.push(`割引額: ${fmt(b.discount)}`); allowed.add(b.discount); }
    if (b.total !== null) { rows.push(`初期費用の合計（割引後）: ${fmt(b.total)}`); allowed.add(b.total); }
    if (b.saving !== null) { rows.push(`一般的な不動産業者との差額: ${fmt(b.saving)}`); allowed.add(b.saving); }
    const zero = b.items.filter((it) => it.amount === 0).map((it) => it.label);
    lines.push([`- ${name}`, ...rows.map((r) => `  ・${r}`), ...(zero.length ? [`  ※0円の項目: ${zero.join("・")}`] : []), ...b.notes.map((n) => `  ※見積書の注記: ${n}`)].join("\n"));
    notes.push([name, ...(b.total !== null ? [`初期費用合計: ${fmt(b.total)}`] : []), `内訳: ${b.items.map((it) => `${it.label}${fmt(it.amount)}`).join("・")}`].join(" / "));
  });
  const ins = extras.insuranceSeparateYen ?? null;
  if (ins && ins > 0) allowed.add(ins);
  // 2026-09-15 実物の御見積書（コーポ平野上町）で確認: 火災保険 18,000円が御見積書に含まれているのに、スタッフの手本（火災保険は別途）を写して
  //   「別途、火災保険18,000円のお支払いが必要」と書いた（金額は御見積書にあるので金額の照合では止まらない）→ 含まれているかを明示する
  const insuranceRows = list.flatMap((b) => b.items.filter((it) => /火災保険|保険/.test(it.label)));
  const extraRules = [
    "・御見積書の項目にある費用は、すべて初期費用の合計に含まれている（「別途」「別で」「他に」と書かない）",
    insuranceRows.length > 0
      ? `・火災保険: 御見積書に含まれている（${insuranceRows.map((it) => `${it.label} ${fmt(it.amount)}`).join("・")}）。「別途」と書かない`
      : ins && ins > 0
        ? `・火災保険: 御見積書に含まれず別途 ${fmt(ins)} 必要（スタッフ確認済みの事実）。「別途」と書いてよいのはこの火災保険だけ`
        : "・火災保険: 御見積書の項目に無い。別途かどうか・金額は分からないので触れない",
    "・日割家賃: ご入居日によって発生する（金額は計算しない・書かない）。1日のご入居なら日割家賃はかからない（会社の決まり）",
  ];
  const block = `【御見積書の内訳（画像の読み取り結果・確定事実）】
${lines.join("\n")}
${extraRules.join("\n")}
・本文に書いてよい金額は上記の数字だけ。足し算・引き算で新しい金額を作らない。上記に無い費用項目・金額を創作しない`;
  return { block, notes, allowedAmounts: [...allowed].sort((a, b) => a - b) };
}

// ── 本文の金額の照合（見積書に無い金額は伏せ字 → 送信前チェックで止まる）─────────────────────
const AMOUNT_RE = /([0-9０-９][0-9０-９,，]*(?:\.[0-9０-９]+)?)\s*万\s*([0-9０-９][0-9０-９,，]*)?\s*円?|([0-9０-９][0-9０-９,，]*)\s*円/g;

/** 本文の「〇〇円」「〇.〇万円」「〇万〇〇円」を読んで、許された金額に無い物を「〇〇円」に置き換える */
export function checkAmountsAgainstBreakdown(text: string, allowedAmounts: readonly number[]): { cleaned: string; unmatched: string[] } {
  const allowed = new Set(allowedAmounts);
  const unmatched: string[] = [];
  const cleaned = text.replace(AMOUNT_RE, (m, manPart: string | undefined, manRest: string | undefined, yenPart: string | undefined) => {
    let n: number | null = null;
    if (manPart !== undefined) {
      const base = parseFloat(manPart.normalize("NFKC").replace(/[,，]/g, ""));
      const rest = manRest ? parseInt(manRest.normalize("NFKC").replace(/[,，]/g, ""), 10) : 0;
      n = Number.isFinite(base) ? Math.round(base * 10000) + (Number.isFinite(rest) ? rest : 0) : null;
    } else if (yenPart !== undefined) {
      n = parseInt(yenPart.normalize("NFKC").replace(/[,，]/g, ""), 10);
    }
    if (n !== null && (allowed.has(n) || n === 0)) return m;
    unmatched.push(m.trim());
    return "〇〇円";
  });
  return { cleaned, unmatched };
}

// ── ブレイン・場面の証拠用: 「初期費用に何が含まれるか・家賃だけで入居できるか」の質問 ────────────────
// 実例（240日）: ゆうこ「家賃だけ払ったら住めるんですか？」「例えばこの場合家賃と管理費を先振り込んだら住めるってことですか？」
//   ／「初期費用とは別の火災保険ですかね？」／「SUUMOに書いてある鍵交換代とかももろもろかかってまた金額上乗せされていきますよね」
//   ／「クリーニング代38,300円が敷金から精算されるのか、敷金とは別に退去時に38,300円を支払いになるんですか？」
// 除外: 値引きの相談（別の場面）・安さへの不安（AIX 初期費用を説明）・支払い方法（分割・カード・口座）・金額だけの質問（見積書送る）
const RENT_ONLY_RE = /(?:家賃|賃料|前家賃|管理費|共益費)[^\n。]{0,12}(?:だけ|のみ|先に?)[^\n。]{0,12}(?:払|振り?込|支払|入金)[^\n。]{0,20}(?:住め|住む|入居|入れ|済む|済みます|大丈夫|OK|いい|良い)|(?:家賃|賃料|前家賃|管理費|共益費)(?:だけ|のみ)(?:で|でも)?[^\n。]{0,8}(?:住め|住む|入居|入れ|済む|済みます|大丈夫|OK)/;
const COMPOSITION_RE = /初期費用[^\n。]{0,4}(?:って|とは|には|に|は)?[^\n。]{0,8}(?:何が|なにが|何の|なんの|含ま|入って|内訳|とは別|と別|別途|込み)/;
const ITEM_RE = /(?:敷金|礼金|保証料|保証会社|火災保険|鍵交換|クリーニング|日割|前家賃)[^\n。]{0,20}(?:含ま|込み|込ん|別途|別で|別に|とは別|と別|って何|とは何|って(?:なん|どう)|返って|戻って|精算|かかり|かかって|上乗せ|必要(?:ですか|なんですか|でしょうか|ですかね))/;
const QUESTIONISH_RE = /[？?]|ですか|ますか|でしょうか|かね|よね|のか|ってこと/;
// 実データ（240日・検出21件）で外した誤検出: 見積書の依頼（「総額と内訳をお送り頂けますか」「新しい見積書はお願い出来ませんか」＝見積書送る）
//   ／金額だけの質問（「日割家賃？何円かかりますか」「おいくら」＝見積書送る）／契約の手続き（「火災保険の封筒ってなんですか」
//   「保証会社から電話…なんの電話」「請求書とは別」＝申込後の書類・手続きの話）
const EXCLUDE_RE = /(安くなりませんか|安くできますか|安く出来ますか|もう少し安く|値引き|交渉|分割|クレジット|カード払い|ローン|引き落と|口座|振込先|いつまでに|何円|いくら|おいくら|封筒|登録|ログイン|手続|電話|契約書|請求書)|見積(?:もり|書)?[^\n。]{0,8}(?:出して|お願い|ください|下さい|頂け|いただけ|欲しい|ほしい)/;

/** お客様の発言が「初期費用に何が含まれるか・家賃だけで入居できるか」の質問か（画像の読み取り文字・値引きの相談・支払い方法は除く） */
export function customerAsksCostComposition(customerText: string): boolean {
  const t = (customerText || "").normalize("NFKC");
  if (!t.trim()) return false;
  if (/^\s*\[画像\]/.test(t)) return false;
  if (EXCLUDE_RE.test(t)) return false;
  if (!QUESTIONISH_RE.test(t)) return false;
  return RENT_ONLY_RE.test(t) || COMPOSITION_RE.test(t) || ITEM_RE.test(t);
}
