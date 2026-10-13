// app/lib/recommend-appeal-points.ts — この物件の「このお客様に刺さる強み」（訴求の材料）を資料の事実とお客様の条件から選ぶ（純関数・DB/LLM なし）
//
// 2026-10-13 竹内さん: 「お客さんの条件によって、その物件の強みを訴求しているので、訴求ポイントがお客さんの条件に合わせて正確に読み取れるようにする必要がある
//   物件検索ブレイン。そうすると物件についての文の訴求の部分がかなり質が高くなる」「文は竹内が送ってる LINE の文参考に。資料はスタッフも参考」
//   設計知見 P1 3b508208（物差しの分け方）・P0 9eb6aa9c（規則は候補の網と安全の線＝ここは「資料に有る事実」だけを並べる網・どれを書くかは文を書く LLM／ブレイン）
//
// ■ 何をするか
//   旧: 🌟（AIX 物件オススメ）は資料の画像を Claude が読み、「お客様の希望条件に最も響くポイントを選ぶ」の指示だけで強みを選んでいた（構造化した事実も希望との照合も渡していない）。
//   新: 資料から読めた事実（sent_image_properties.facts・売上サポの行＝CandidateFacts）とお客様の希望（recommendation-gaps.customerWants＝条件欄・自由文・発言）を
//       同じ話題の語彙（recommendation-gaps.TOPICS）で照らし、
//       ① 希望に合う強み（希望 ∩ 事実で満たす）② 希望には無いが一般に強い強み（敷礼0・フリーレント・築浅・駅近・広さ）③ 希望なのに満たさない話題（書かない・言い切らない）
//       ④ 広げて提案した軸（判定の札＝エリア・広さ・間取り・家賃・築年の広げた帯）と、それをどの強みで補うか、を文の材料として渡す。
//   安全の線: 資料の事実が無い強みは作らない（値が null の話題は出さない）。数字は資料の値そのまま（帖数・㎡・徒歩・築年・敷礼）。
//
// ■ 既定 off（RECOMMEND_APPEAL_POINTS=on で入れる）: 🌟の文は画像つきの Claude でしか作れず、試験（DeepSeek）で文の前と後を比べられていない。
//   当て直し（scripts/audit-appeal-points.ts・竹内さんの🌟 100通×直前の生成文）では、生成文の箇条書きのうち資料の事実で裏付けられる行は
//   竹内さんが 91%残し（220行中 消した19）、資料で分からない行は 20%消している（403行中 82）・資料と食い違う行（敷礼なしと書いたが礼金1ヶ月）は消した（1/1）＝この材料（資料で裏付けた強み）を先に書かせる向きは物差しと合う。
//   最後の Claude で1〜2回確かめてから on にする（確かめる人・竹内さんの判断）
import { TOPIC_LABEL, factTopics, type TopicKey, type WantHit, type FactProfile } from "./recommendation-gaps";
import type { CandidateFacts } from "./candidate-facts";

export function recommendAppealPointsEnabled(env: Record<string, string | undefined> = (typeof process !== "undefined" ? process.env : {})): boolean {
  return String(env.RECOMMEND_APPEAL_POINTS ?? "").trim().toLowerCase() === "on";
}

export type AppealPoint = { key: TopicKey; label: string; fact: string; why: "wanted" | "general" };
export type WidenedAxis = { axis: "エリア" | "広さ" | "間取り" | "家賃" | "築年"; code: string; ja: string };
export type AppealPoints = {
  points: AppealPoint[];
  /** 希望なのに資料の事実で満たさない話題（書かない・言い切らない） */
  unmet: Array<{ key: TopicKey; label: string; fact: string }>;
  /** 広げて提案した軸（判定の札から） */
  widened: WidenedAxis[];
};

/** 一般に強い強み（希望が無くても竹内さんの🌟がよく書く・事実で満たす時だけ）。並び＝優先 */
const GENERAL_ORDER: TopicKey[] = ["zero_deposit", "free_rent", "new_build", "station_near", "spacious", "internet", "washbasin", "bath_toilet", "autolock"];
/** 一般に強いとみなす線（希望の線が無い時） */
const GENERAL_LINE = { walk: 5, age: 5 };

/** 事実を文の材料の言い方にする（資料の値そのまま。値が無ければ null＝出さない） */
export function factPhrase(key: TopicKey, c: CandidateFacts): string | null {
  switch (key) {
    case "zero_deposit": return c.deposit_months === 0 && c.key_money_months === 0 ? "敷金礼金なし" : null;
    case "station_near": return c.walk_minutes != null ? `${c.station ? `${String(c.station).replace(/駅$/, "")}駅` : "駅"}徒歩${c.walk_minutes}分` : null;
    // 新築と言うのは築0年の時だけ（築1年は「築浅」＝claimContradicts の「新築なのに築2年以上」より厳しく・言い切りを作らない）
    case "new_build": return c.building_age != null ? (c.building_age === 0 ? "新築" : c.building_age === 1 ? "築浅（築1年）" : `築${c.building_age}年`) : null;
    case "spacious": return c.area_sqm != null ? `${c.area_sqm}㎡${c.floor_plan ? `の${c.floor_plan}` : ""}` : null;
    case "floor2": return c.floor != null ? `${c.floor}階` : null;
    case "rent": return c.rent != null ? `家賃${Math.round(c.rent / 1000) / 10}万円${c.admin_fee_yen ? `＋管理費${c.admin_fee_yen.toLocaleString()}円` : ""}` : null;
    // 設備の話題は factTopics が資料の設備の語で「満たす」と言った時だけ呼ばれる（語が無い＝出さない）
    default: return factTopics(c).yes.includes(key) ? TOPIC_LABEL[key] : null;
  }
}

/** 判定の札 → 広げた軸 */
const WIDEN_CODES: Record<string, WidenedAxis> = {
  AREA_STATION_WIDE: { axis: "エリア", code: "AREA_STATION_WIDE", ja: "希望の駅の隣の駅" },
  AREA_STATION_2STOPS: { axis: "エリア", code: "AREA_STATION_2STOPS", ja: "希望の駅から2駅" },
  AREA_NEAR: { axis: "エリア", code: "AREA_NEAR", ja: "希望のエリアの近く（2km内）" },
  AREA_CLOSE: { axis: "エリア", code: "AREA_CLOSE", ja: "希望のエリアの少し外（隣の区・4km内）" },
  AREA_FAR: { axis: "エリア", code: "AREA_FAR", ja: "希望のエリアから離れている" },
  AREA_WARD_WIDE: { axis: "エリア", code: "AREA_WARD_WIDE", ja: "希望の区の隣（難波の3区）" },
  SQM_WIDE: { axis: "広さ", code: "SQM_WIDE", ja: "希望の広さより少し狭い" },
  SQM_SLIGHTLY_UNDER: { axis: "広さ", code: "SQM_SLIGHTLY_UNDER", ja: "希望の広さより少し狭い" },
  FLOOR_PLAN_FEWER_ROOM_WIDE: { axis: "間取り", code: "FLOOR_PLAN_FEWER_ROOM_WIDE", ja: "部屋数は1つ少ないが広い LDK" },
  FLOOR_PLAN_WIDE: { axis: "間取り", code: "FLOOR_PLAN_WIDE", ja: "LDK の希望に同じ部屋数の DK" },
  FLOOR_PLAN_SAME_CLASS: { axis: "間取り", code: "FLOOR_PLAN_SAME_CLASS", ja: "希望と同じ広さの級の間取り" },
  RENT_WIDE: { axis: "家賃", code: "RENT_WIDE", ja: "家賃が上限を少し超える" },
  RENT_SLIGHTLY_OVER: { axis: "家賃", code: "RENT_SLIGHTLY_OVER", ja: "家賃が上限を少し超える" },
  BUILDING_AGE_WIDE: { axis: "築年", code: "BUILDING_AGE_WIDE", ja: "希望の築年を少し超える" },
};
export function widenedAxesOf(reasonCodes: ReadonlyArray<string> | null | undefined): WidenedAxis[] {
  const out: WidenedAxis[] = [];
  for (const c of reasonCodes ?? []) { const w = WIDEN_CODES[c]; if (w && !out.some((o) => o.axis === w.axis)) out.push(w); }
  return out;
}

/**
 * この物件のこのお客様への訴求の材料（純）。wants は customerWants の結果（出どころの順＝条件欄 → 自由文 → 発言）。
 *   max: 強みの数（竹内さんの🌟の訴求は 1〜2点・3つまで渡して文を書く側が選ぶ）
 */
export function buildAppealPoints(facts: CandidateFacts, wants: ReadonlyArray<WantHit>, profile: FactProfile = {}, opts: { max?: number; reasonCodes?: ReadonlyArray<string> | null } = {}): AppealPoints {
  const max = opts.max ?? 3;
  const ft = factTopics(facts, profile);
  const yes = new Set(ft.yes), no = new Set(ft.no);
  const points: AppealPoint[] = [];
  const push = (key: TopicKey, why: AppealPoint["why"]) => {
    if (points.length >= max || points.some((p) => p.key === key)) return;
    const fact = factPhrase(key, facts);
    if (fact) points.push({ key, label: TOPIC_LABEL[key], fact, why });
  };
  // ① 希望に合う強み（家賃は「上限内」なので強みとしては書かない＝竹内さんの🌟は家賃の数字を書くのは希望が家賃の時だけ）
  for (const w of wants) if (yes.has(w.key)) push(w.key, "wanted");
  // ② 一般に強い強み（線を満たす物だけ）
  for (const k of GENERAL_ORDER) {
    const ok = k === "station_near" ? facts.walk_minutes != null && facts.walk_minutes <= GENERAL_LINE.walk
      : k === "new_build" ? facts.building_age != null && facts.building_age <= GENERAL_LINE.age
      : k === "spacious" ? false // 広さは希望がある時だけ（数字だけでは強みか分からない＝①で出す）
      : yes.has(k);
    if (ok) push(k, "general");
  }
  const unmet = wants.filter((w) => no.has(w.key)).map((w) => ({ key: w.key, label: TOPIC_LABEL[w.key], fact: factPhrase(w.key, facts) ?? "" }));
  return { points, unmet, widened: widenedAxesOf(opts.reasonCodes) };
}

/** 強みと言うと資料の事実と食い違う話題（新築・築浅なのに築11年以上／敷礼なしなのに敷金か礼金あり／2階以上なのに1階）。値が無い話題は入れない */
export function factContradictions(c: CandidateFacts): TopicKey[] {
  const out: TopicKey[] = [];
  if (c.building_age != null && c.building_age > 10) out.push("new_build");
  if ((c.deposit_months != null && c.deposit_months > 0) || (c.key_money_months != null && c.key_money_months > 0)) out.push("zero_deposit");
  if (c.floor != null && c.floor < 2) out.push("floor2");
  return out;
}
/** 1行の言い切りが資料の事実と食い違うか（「新築」なのに築2年以上・「築浅」なのに築11年以上・「敷金礼金なし」なのに敷金か礼金あり） */
export function claimContradicts(line: string, c: CandidateFacts): string | null {
  const l = String(line ?? "");
  if (/新築/.test(l) && !/築浅/.test(l) && c.building_age != null && c.building_age >= 2) return `新築と書いたが築${c.building_age}年`;
  if (/築浅/.test(l) && c.building_age != null && c.building_age > 10) return `築浅と書いたが築${c.building_age}年`;
  if (/敷金?礼金?(?:共に|とも)?(?:なし|無し|0|ゼロ)|敷礼(?:なし|0)/.test(l) && ((c.deposit_months ?? 0) > 0 || (c.key_money_months ?? 0) > 0) && c.deposit_months != null && c.key_money_months != null) return "敷金礼金なしと書いたが資料は敷金か礼金あり";
  return null;
}

/** 文の材料の注記（AIX 物件オススメの user text に足す）。何も無ければ空文字 */
export function buildAppealPointsNote(a: AppealPoints | null | undefined): string {
  if (!a || (!a.points.length && !a.widened.length && !a.unmet.length)) return "";
  const lines: string[] = ["", "【この物件の訴求の材料（資料から読めた事実・お客様の希望と照らした物）】"];
  if (a.points.length) lines.push(`・お客様に刺さる強み（上から優先・1〜2点を選んで書く）: ${a.points.map((p) => `${p.fact}${p.why === "wanted" ? "（希望に合う）" : ""}`).join("／")}`);
  if (a.widened.length) lines.push(`・希望から広げた所: ${a.widened.map((w) => w.ja).join("／")} → 隠さず、上の強みで補う形で（例「〇〇から少し離れますが、△△なので〜」）。広げた事を謝りすぎない`);
  if (a.unmet.length) lines.push(`・希望なのにこの物件で満たさない所（強みとして書かない・満たすと言い切らない）: ${a.unmet.map((u) => u.label).join("／")}`);
  // 2026-10-13 確かめる人の重要3: 「ここに無い物は書くな」と読まれると、竹内さんの🌟でほぼ毎回書く家賃（96/100）・広さ（93/100）の行が抜ける → 一覧は全部ではないと明記
  lines.push("・資料（画像・資料の文字）に無い強みは書かない。この一覧は優先の順であって全部ではない（家賃・間取り・広さ・駅・設備などいつもの行は今まで通り書く）");
  return lines.join("\n");
}
