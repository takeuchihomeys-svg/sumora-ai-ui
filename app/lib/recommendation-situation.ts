// app/lib/recommendation-situation.ts
// AIX【物件オススメ】「現状伝えて・1件訴求」— 探した現状を1文で伝えてから物件カードを出す。純関数・DB 依存なし。
//
// 2026-09-17 竹内「AIXの物件オススメボタンに 現状伝えて1件オススメのピッカーを作成。このような文を生成するようにする」
//
// 実送信（ギガ賃貸 M さん 9/17 18:31・竹内さんのスクショ）:
//   「大国町・本町・堺筋本町周辺全域からご条件に合った物件すべて探させて頂きましたところ空室のお部屋で
//     募集御座いませんでしたが、1件退去予定のお部屋でMさんご希望のご条件にピッタリなお部屋が募集に出ております😊！！
//    （空行）
//    🌟 エステムコート難波サウスプレイスVIラグジー
//    大国町徒歩7分の立地、トイレ独立している間取りのお部屋となります！！
//    かなりオススメのご条件となります！
//    お手隙の際にご査収ください😌！！」
//
// もう1つの実送信（コトミさん 6/14）:
//   「周辺の地域でコトミさんのご条件に合った物件探させて頂きましたところ東淀川区の物件となりますが
//     1件オススメ出来るお部屋御座いました！！／コトミさんお手隙の際にご査収ください😌！！」
//
// ＝既存の5種類（初回・新着・送った中から・条件広げ・代替）はいずれも「探した現状」を言わない型。
//   この型だけ🌟の**前に1文**が入るので、物件オススメの「出力の最初の文字は必ず🌟」を
//   このモードだけ外し、無ければ出口で足す。
//
// 現状の型は**実送信にある2つだけ**を用意し、それ以外はスタッフが自分の言葉で書く（創作した言い回しを持たせない）。

/** 現状の種類。vacancy_none / area_none は実送信の骨組みをそのまま持つ。custom はスタッフの言葉 */
export type SituationKind = "vacancy_none" | "area_none" | "custom";

export type SituationPreset = {
  kind: SituationKind;
  /** 画面のチップ */
  chip: string;
  /** 画面の説明 */
  desc: string;
};

export const SITUATION_PRESETS: readonly SituationPreset[] = [
  { kind: "vacancy_none", chip: "空室なし → 退去予定1件", desc: "ご条件で空室は無く、退去予定のお部屋が1件あった" },
  { kind: "area_none", chip: "ご希望エリアに無し → 周辺で1件", desc: "ご希望エリアには無く、周辺エリアで1件あった" },
  { kind: "custom", chip: "自分で書く", desc: "上の2つに当てはまらない現状を自分の言葉で" },
];

export function isSituationKind(v: unknown): v is SituationKind {
  return v === "vacancy_none" || v === "area_none" || v === "custom";
}

type LineOpts = {
  /** 探したエリア（「大国町・本町・堺筋本町周辺全域」）。空なら省く */
  area?: string | null;
  /** 「Mさん」のように「さん」まで含んだ呼び名 */
  customerName: string;
  /** 見つかった側の補足（area_none の「東淀川区」等）。空なら省く */
  foundArea?: string | null;
  /** custom の時のスタッフの言葉 */
  note?: string | null;
};

const clean = (s: string | null | undefined) => (s ?? "").trim();

/**
 * 現状の1文（🌟の前に置く）。実送信の骨組みそのまま。
 * custom はスタッフの言葉をこちらで文にしない（創作しない）ので null を返し、指示層に任せる。
 */
export function buildSituationLine(kind: SituationKind, opts: LineOpts): string | null {
  const name = clean(opts.customerName) || "お客様";
  const area = clean(opts.area);
  if (kind === "vacancy_none") {
    const head = area ? `${area}から` : "";
    return `${head}ご条件に合った物件すべて探させて頂きましたところ空室のお部屋で募集御座いませんでしたが、1件退去予定のお部屋で${name}ご希望のご条件にピッタリなお部屋が募集に出ております😊！！`;
  }
  if (kind === "area_none") {
    const head = area ? `${area}から` : "周辺の地域で";
    const found = clean(opts.foundArea);
    const foundPart = found ? `${found}の物件となりますが` : "";
    return `${head}${name}のご条件に合った物件探させて頂きましたところ${foundPart}1件オススメ出来るお部屋御座いました！！`;
  }
  return null;
}

/**
 * 出口で🌟の前に置く1文。
 * ・実送信の型（vacancy_none / area_none）は骨組みそのまま
 * ・custom はスタッフが書いた言葉をそのまま使う（こちらで言い回しを作らない）
 */
export function situationOpeningLine(kind: SituationKind, opts: LineOpts): string | null {
  const preset = buildSituationLine(kind, opts);
  if (preset) return preset;
  if (kind !== "custom") return null;
  const note = clean(opts.note);
  return note || null;
}

/** 現状の1文が（🌟より前に）既にあるか */
const SITUATION_SIGN_RE = /探させて(?:頂き|いただき)|募集(?:御座|ござ|ご座)いません|募集に出ております|オススメ出来るお部屋御座いました/;
export function hasSituationOpening(text: string, line?: string | null): boolean {
  const src = text ?? "";
  const starIdx = src.indexOf("🌟");
  const head = starIdx >= 0 ? src.slice(0, starIdx) : src;
  if (SITUATION_SIGN_RE.test(head)) return true;
  // custom（スタッフの言葉）は決まった語が無いので、その文が🌟より前にあるかで見る
  const l = (line ?? "").trim();
  return !!l && head.includes(l.slice(0, Math.min(16, l.length)));
}

/**
 * 出口: 現状の1文が無ければ🌟の前に足す（実送信どおり1行空ける）。
 * line が null（custom で文を作れない）時は触らない。
 */
export function ensureSituationOpening(text: string, line: string | null): { text: string; added: boolean } {
  const src = text ?? "";
  if (!line || !src.trim()) return { text: src, added: false };
  if (hasSituationOpening(src, line)) return { text: src, added: false };
  const starIdx = src.indexOf("🌟");
  if (starIdx < 0) return { text: `${line}\n\n${src.trim()}`, added: true };
  const head = src.slice(0, starIdx).trim();
  const rest = src.slice(starIdx).trim();
  // 🌟の前に別の文（挨拶など）があればその後ろに足す
  return { text: head ? `${head}\n${line}\n\n${rest}` : `${line}\n\n${rest}`, added: true };
}

/** 生成の指示（この経路だけ「🌟より前に1文」を許す） */
export function buildSituationPromptNote(kind: SituationKind, opts: LineOpts): string {
  const line = buildSituationLine(kind, opts);
  const area = clean(opts.area);
  const note = clean(opts.note);
  const head = [
    "【この通は「探した現状」を先に伝えてから1件オススメする型 — 最優先】",
    "・本文は「現状の1文」→ 空行 →「🌟物件名」から始まる物件カード、の順にする（この経路だけ🌟より前に文を書いてよい）",
  ];
  if (line) {
    head.push(`・現状の1文はこの文をそのまま使う（スタッフの実送信の言い回し）:\n${line}`);
    if (!area) head.push("・探したエリアが分かる場合は文頭に「〇〇周辺全域から」を足してよい（会話・希望条件にあるエリアだけ。作らない）");
  } else {
    head.push(
      `・現状はスタッフの言葉を使う: 「${note || "（未入力）"}」`,
      "・この内容を1文にまとめて先頭に置く。スタッフが書いていない事実（募集件数・エリア・理由）は足さない",
    );
  }
  head.push(
    "・現状の1文に物件名・家賃・設備は書かない（それは🌟のカードで書く）",
    "・「引き続きお探しします」「見つかるまでサポート」等の締めは足さない（1件オススメする通なので）",
  );
  return head.join("\n");
}
