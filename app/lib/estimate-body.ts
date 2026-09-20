// app/lib/estimate-body.ts
// 見積書の金額文（LINE に送る本文）を組み立てる（純関数・DB 依存なし）。
//
// 2026-09-20 竹内（H さん事例）「見積書の文のところ、これちゃんときめられた AIX のテンプレートの文の
//   構成と違うようになってしまっている。AIX のテンプレートの部分くずれてしまっているかも」
//
// 【何が起きていたか】H さんの見積書は**スモ割が 0 円**（差引請求金額 178,090円・節約 61,920円）。
//   AIX【見積書送る】の**1枚の経路だけ**が割引と節約を抱き合わせにしていた:
//     if (discount > 0 && total > 0) { 割引行 + 初期費用 + 節約行 }
//     else if (total > 0)            { 初期費用だけ }          ← ここに落ちた
//   → 「【ハイツカトレア B 202号室】／初期費用：178,090円」だけになり、
//     見積書の画像には出ている**節約 61,920円が本文から消えた**。
//
// 【同じ物が4か所にあり、崩れていたのは1か所だけだった】
//   見積書作成画面 estimate/page.tsx … 割引と節約が独立 ✅
//   AIX 複数枚 aix/action route.ts   … 独立 ✅
//   AIX 物件確認 aix/action route.ts … 独立 ✅
//   AIX 1枚     aix/action route.ts … **抱き合わせ ❌**
//   → 4経路をこの関数1つに寄せた（設計知見「四者同名」・「入口は1つの関数にまとめる」）。
//
// 【実データで線を引いた】実送信365日で「初期費用：」を含む 319通:
//   割引させて 311通(97%) / 節約出来 295通(92%) / 日割家賃の注記 317通(99%) / 🌟 311通(97%)
//   組み合わせ: 割引＋節約 292 / 割引のみ 19 / **割引なし＋節約のみ 3** / どちらも無し 5
//   外れた側（割引なし 8通）を全部読んだ結果:
//     ・ROCCO 1201号室 / グレイス ガーデン 204号室 / マンションサンパール 205号室 の3通は
//       「【物件名】／初期費用：〇円／〇〇なら一般的な不動産業者より〇円節約出来ます！！」＝**この形が正解**
//     ・残り5通は節約額そのものが無いか、スタッフの手打ち（「いっぱんてきな」等の誤字を含む）
//   ＝ **割引が0円でも、節約額があれば節約行を書く**。割引行だけを落とす。

/** 1物件分の材料。数値でも文字列（Vision の読み取り結果「36,000円」）でも受ける */
export type EstimateItemInput = {
  propertyName?: string | null;
  /** 「202」でも「202号室」でも可（「号室」は二重に付けない） */
  roomNumber?: string | null;
  /** 差引請求金額 */
  total?: number | string | null;
  /** スモ割などの割引額。0 や未取得なら割引行を出さない */
  discount?: number | string | null;
  /** 一般的な不動産業者との差額 */
  savings?: number | string | null;
  /** 複数枚の時の見出し（「①」「1.」）。1枚なら省く */
  badge?: string | null;
  /** 「スモラ」「イエヤス」「ギガ賃貸」 */
  accountName: string;
};

/** 実送信 317/319通（99%）に入っている注記 */
export const DAY_RENT_NOTE = "※ご入居日によって日割家賃が発生致します。";
/** 金額が1つも読み取れなかった時の1文（実送信の形ではなく、送る前にスタッフが直す前提の受け皿） */
export const NO_AMOUNT_FALLBACK = "最大限割引した初期費用の御見積書をお送りさせて頂きます！！";

/**
 * 数値も文字列も「〇〇円」の表示に揃える。
 * ・number: 0・負・NaN は「無い」扱い（未取得と 0円割引を同じに扱う＝どちらも割引行を出さない）
 * ・string: Vision が「36,000円」まで返すのでそのまま使う。「円」が無ければ足す。
 *           数字が1つも無い文字列（「なし」「-」「0円」）は「無い」扱い
 */
export function formatYen(v: number | string | null | undefined): string | null {
  if (v == null) return null;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    return `${v.toLocaleString()}円`;
  }
  const s = v.trim();
  if (!s) return null;
  // 「0円」「0」「なし」「-」は無い扱い（Vision は割引が無い見積書に 0 を返す事がある）
  const digits = s.replace(/[^0-9０-９]/g, "");
  if (!digits || /^[0０]+$/.test(digits)) return null;
  return /円/.test(s) ? s : `${s}円`;
}

/** 節約額の1文（本文と見積書画像のバッジで同じ言い回しにする） */
export function buildSavingsLine(accountName: string, savings: number | string | null | undefined): string {
  const s = formatYen(savings);
  return s ? `${accountName}なら一般的な不動産業者より${s}節約出来ます！！` : "";
}

/** 「202」→「 202号室」／「202号室」→「 202号室」／空→"" */
export function roomSuffix(roomNumber?: string | null): string {
  const r = (roomNumber ?? "").trim();
  if (!r) return "";
  return /号室\s*$/.test(r) ? ` ${r}` : ` ${r}号室`;
}

/**
 * 1物件分の金額文（日割の注記は付けない＝連結する側が最後に1回だけ付ける）。
 * 金額が1つも無ければ null（呼び出し側がまとめて受け皿の1文に倒す）。
 */
export function buildEstimateItem(o: EstimateItemInput): string | null {
  const total = formatYen(o.total);
  const discount = formatYen(o.discount);
  const savings = formatYen(o.savings);
  const name = (o.propertyName ?? "").trim();
  const head = name || roomSuffix(o.roomNumber).trim()
    ? `${(o.badge ?? "").trim()}【${name}${roomSuffix(o.roomNumber)}】`
    : "";
  if (!total && !discount && !savings) return head || null;

  const lines: string[] = [];
  if (head) { lines.push(head); lines.push(""); }
  // 割引行は割引がある時だけ（0円割引は書けない）
  if (discount) {
    lines.push("初期費用さらに");
    lines.push(`🌟${discount}割引させて頂き`);
  }
  if (total) lines.push(`初期費用：${total}`);
  // ★ 節約行は**割引の有無と独立**（H さん事例の直し）。実送信でも割引なし＋節約ありが3通ある
  if (savings) {
    lines.push("");
    lines.push(buildSavingsLine(o.accountName, savings));
  }
  return lines.join("\n");
}

/**
 * 送る本文。物件を連結し、末尾に日割の注記を1回だけ付ける。
 * @param dayRentNote 入居日が確定していて日割を計算済みの時だけ false（見積書作成画面）
 */
export function buildEstimateMessage(
  items: ReadonlyArray<EstimateItemInput>,
  opts?: { dayRentNote?: boolean },
): string {
  const withNote = opts?.dayRentNote !== false;
  const parts = items.map(buildEstimateItem).filter((x): x is string => !!x && x.includes("初期費用"));
  if (parts.length === 0) {
    return withNote ? `${NO_AMOUNT_FALLBACK}\n\n${DAY_RENT_NOTE}` : NO_AMOUNT_FALLBACK;
  }
  return withNote ? `${parts.join("\n\n")}\n\n${DAY_RENT_NOTE}` : parts.join("\n\n");
}

/**
 * 節約額 ＝（業界標準の仲介手数料1ヶ月＋税 − 実際の仲介手数料）＋ 割引額。
 * 見積書作成画面（estimate/page.tsx）と AIX で同じ式を使う（別々に書くとずれる）。
 * 家賃が読み取れない時は 0 になる＝節約行を出さない（誤った金額を書かない側に倒れる）。
 */
export function calcSavings(o: { rent?: number | null; commission?: number | null; commissionTax?: number | null; discount?: number | null }): number {
  const rent = Number.isFinite(o.rent as number) && (o.rent as number) > 0 ? (o.rent as number) : 0;
  const commission = Number.isFinite(o.commission as number) ? (o.commission as number) : 0;
  const commissionTax = Number.isFinite(o.commissionTax as number) ? (o.commissionTax as number) : 0;
  const discount = Number.isFinite(o.discount as number) && (o.discount as number) > 0 ? (o.discount as number) : 0;
  return Math.max(0, Math.round(rent * 1.1) - (commission + commissionTax) + discount);
}
