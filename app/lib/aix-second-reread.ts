// app/lib/aix-second-reread.ts — ブレインが勧めた AIX とスタッフが押した AIX が違う番の2通目: 押された AIX を正として、その AIX の意味で読み直す（純関数・既定 off）
//
// 2026-11-12 竹内さんの決定「Aでおねがい」（統括役経由・作業員25）:
//   ブレインが勧めた AIX とスタッフが押した AIX が違う番は、押された AIX を正として、ブレインにその AIX の意味で読み直させ
//   （なぜ今これを送るのか・お客様の何に応えるのか・押さえる要点）、その結果を2通目に渡す。古い方向（例「出来次第お送りする」）は渡さない。
//   読み直せない時は案B（ブレインの方向を渡さず、押された AIX と会話だけ）に落とす。
// なぜ: 実物 48組（exam-cache/anatomy-seven/aix-second-pairs.json・押したのは全部 物件オススメ）で、直前のブレインの一手が
//   返信（null）25・物件確認した 8・見積書 2・全力サポート 1＝36組が押した AIX と違った。その番の2通目には
//   brain-strategy-note が古い方向（返信方向「…出来次第お送りする旨を、待ちの形で」・勝ちパターン・成約戦略・判断理由）をそのまま渡していた。
//   一手が null（返信を勧めた）の番は「別アクション推奨時点の戦略」の注意書きも付かなかった（otherActionLabel は action がある時だけ）。
// 同じ仲間: 物件ピックアップした（property_send）と物件オススメ（property_recommendation）は「物件を送る」同じ一手として違う番に数えない
//   （ブレインの方向「約束したピックアップを AIX で届ける」は物件オススメの2通目でもそのまま当たる・12組）。
// 道は変えない: 押された AIX が道（読み直しは2通目の材料だけ・返信か AIX かを書かせない）。読み直しの答えに道の言葉があれば捨てて案B。
// テスト: app/lib/__tests__/aix-second-reread.test.ts（実物の48組のうち違う番）
type Env = Record<string, string | undefined>;
const envOf = (): Env => (typeof process !== "undefined" ? process.env : {});
export function aixSecondRereadOn(env: Env = envOf()): boolean {
  return (env.AIX_SECOND_REREAD ?? "").trim().toLowerCase() === "on";
}

/** 同じ一手とみなす仲間（物件を送る AIX） */
const SAME_FAMILY: ReadonlyArray<ReadonlySet<string>> = [new Set(["property_send", "property_recommendation"])];
const norm = (a: string | null | undefined) => String(a ?? "").trim().split("/")[0];
/** ブレインの一手（meta.action）と押された AIX が違うか。ブレインが返信を勧めた（action が空）番も違う番 */
export function brainPressedDiffer(brainAction: string | null | undefined, pressed: string | null | undefined): boolean {
  const p = norm(pressed);
  if (!p) return false;
  const b = norm(brainAction);
  if (b === p) return false;
  if (b && SAME_FAMILY.some((f) => f.has(b) && f.has(p))) return false;
  return true;
}

/** 方向の欄（違う番では渡さない）。お客様の読み（気持ち・潜在・不安・決め手の残り・質問）は残す */
export const BRAIN_DIRECTION_KEYS = ["reply_direction", "winning_pattern", "closing_strategy", "reason", "template_hint", "after_aix_template", "two_message_plan"] as const;
/** 方向の欄を外した写し（元は書き換えない） */
export function stripBrainDirection<T extends Record<string, unknown>>(meta: T | null | undefined): T | null {
  if (!meta) return null;
  const out: Record<string, unknown> = { ...meta };
  for (const k of BRAIN_DIRECTION_KEYS) delete out[k];
  return out as T;
}

export type SecondReread = { why: string; answers: string; points: string[] };

export const REREAD_SYSTEM = [
  "あなたはお部屋探しの LINE の担当のブレイン。スタッフが今、下の AIX（ボタン）を押して1通目を送った。押された AIX が正（道は決まっている）。",
  "その AIX の意味で、この番を読み直す。返す物は3つだけ（JSON 1つ・前後に何も書かない）:",
  '{"why":"なぜ今この AIX を送るのか（40字まで）","answers":"お客様の何に応えるのか（お客様の言葉や状況・40字まで）","points":["2通目で押さえる要点（20字まで・3つまで）"]}',
  "決まり: 返信か AIX か・別の AIX にすべきかは書かない（道は決まっている）。会話と1通目に書いてある事実だけ。物件名・号室・金額・日付を作らない。",
  "要点は中身（何に触れるか）で、文の言い回しは書かない。分からない欄は空にする。",
].join("\n");

export function buildRereadUser(i: { pressedLabel: string; meaning?: string | null; firstMessage: string; customerText: string; readings?: string[] }): string {
  return [
    `【押された AIX】${i.pressedLabel}`,
    i.meaning?.trim() ? i.meaning.trim().slice(0, 600) : "",
    `【送った1通目】\n${i.firstMessage.trim().slice(0, 700)}`,
    `【お客様の直近の発言】\n${i.customerText.trim().slice(0, 500) || "（無し）"}`,
    i.readings?.length ? `【ブレインのお客様の読み（方向ではない）】\n${i.readings.slice(0, 5).map((x) => `・${x.slice(0, 80)}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

/** 道の言葉（返信か AIX か・別のボタン）を含む答えは捨てる */
const ROUTE_WORDS_RE = /返信(?:に|で)(?:すべき|する|答え)|AIX(?:ではなく|を送らない|は不要)|別の(?:AIX|ボタン)|送るべきでない|押すべき/;
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export function parseReread(text: string): SecondReread | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: unknown;
  try { j = JSON.parse(m[0]); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const o = j as { why?: unknown; answers?: unknown; points?: unknown };
  const why = clip(o.why, 60), answers = clip(o.answers, 60);
  const points = (Array.isArray(o.points) ? o.points : []).map((p) => clip(p, 30)).filter(Boolean).slice(0, 3);
  if (!why && !answers && !points.length) return null;
  if ([why, answers, ...points].some((x) => ROUTE_WORDS_RE.test(x))) return null;
  return { why, answers, points };
}

/** 2通目に渡す注記（読み直せた時＝案A／読み直せない時＝案B） */
export function rereadNote(o: { pressedLabel: string; brainLabel: string | null; reread: SecondReread | null }): string {
  const head = `【押された AIX（${o.pressedLabel}）が正の番（ブレインの勧めは${o.brainLabel ?? "返信"}）】ブレインの前の方向（返信方向・勝ちパターン・判断理由）はこの番には使わない。`;
  if (!o.reread) return `${head}\n・押された AIX の意味・送った1通目・会話だけで書く（前の方向の約束「出来次第お送りする」等を言い直さない）`;
  const r = o.reread;
  return [
    `${head}押された AIX の意味でブレインが読み直した結果（材料・分析の言葉は本文に書かない）:`,
    r.why ? `・なぜ今これを送るのか: ${r.why}` : "",
    r.answers ? `・お客様の何に応えるのか: ${r.answers}` : "",
    r.points.length ? `・2通目で押さえる要点: ${r.points.join("／")}` : "",
  ].filter(Boolean).join("\n");
}
