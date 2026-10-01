// app/lib/estimate-ask-signal.ts
// こちらが 🌟 でオススメした1件の後に、お客様がそのお部屋の初期費用・見積もりを聞いた → AIX【見積書送る】（純関数・DB 依存なし）
//
// 2026-10-01 竹内「まだ確かめ切れていない事の3点強化」③ ブレインの揺れ:
//   YUMA の「🌟プレサンス梅田北ザ・ライブ 305号室」→「初期費用はいくら位になりますかね」で、主のお部屋（customer-state の focus）が
//   内覧予定のレオパレス天満 107号室のままなので resolveFocusedEstimateRequest（主のお部屋の見積もりの依頼）が当たらず、
//   判断が LLM 任せ（decision_source=llm）になっていた。
//   ※ 2026-10-01 の YUMA の揺れ（Claude 3回中1回・DeepSeek 10回中4回が見積書送る以外）は、同じ時間に別の作業が YUMA に入れた
//     場面（ヴィレ堺湊・メゾン本庄東）をブレインが読んだ物だった。他の場面が無い回は DeepSeek 10/10 で見積書送る。
//     揺れの主因ではないが、「主のお部屋」と「今聞かれたお部屋」がずれる時の入口の守りとして決定論にする。
//
// 線（scripts/audit-estimate-ask-after-rec.ts・75日・YUMA 除く）: 🌟 の後の初期費用・見積の依頼（持ち込み・別の 🌟／【】が間に無い）66件の次の AIX は
//   見積書送る 53（80%）・物件確認した 8・その他 5。引用あり 16件は 15（94%）。見積書送る以外は「ハートウェルは前送ってくださった…」
//   「シティハイツ千種、メゾン加美北、サンコーハイツの初期費用」「クレール元町の見積り」＝**別の建物・複数を名指し**していた
//   → 依頼が別の建物名・複数を指していない時だけ（askPointsAtStarredRoom）
//
// ■ 監査で止めた（2026-10-01・ブレインには繋いでいない）:
//   線の内 40件で 見積書送る 33（83%）・線の外 26件で 20（77%）＝線を引いても差が小さく、既存の上書き
//   resolveFocusedEstimateRequest（52件中47＝90%）より弱い。ブレインの判断を上書きする（出口に近い）決まりは誤りが少ない時だけにする。
//   さらに揺れ自体が他の作業の場面の混入で、混入の無い回は DeepSeek 10/10・Claude（最終）も見積書送る（dept_estimate_tool.md）。
//   → 今は測る道具（scripts/audit-estimate-ask-after-rec.ts）としてだけ置く。引用あり（16件中15＝94%）が増えて線が立ったら、
//     brain-core の focused_estimate_request の隣に「主のお部屋が違う時は 🌟 の1件で同じ判定」として足す
import { FOCUSED_ESTIMATE_ASK_RE, VACANCY_ASK_RE } from "./focused-estimate-request";
import { staffPropsFromText, freeTextPropertyName } from "./estimate-handoff";

const MULTI_OR_OTHER_RE = /上記|各物件|それぞれ|全部|全て|両方|他の|別の|前(?:に)?(?:送って|頂いた|いただいた)|以前|[、,・]\s*\S{2,20}(?:、|,|・)|[0-9]+件/;
const nameKey = (s: string) => s.normalize("NFKC").replace(/[\s　・･\-ー－()（）【】🌟]/g, "").toLowerCase();

/** 🌟 の本文の1件（2件以上・0件なら null） */
export function starredRoomOf(starText: string | null | undefined): { name: string; room: string | null } | null {
  const props = staffPropsFromText(String(starText ?? "").split("\n").filter((l) => l.includes("🌟")).join("\n"));
  return props.length === 1 ? props[0] : null;
}

/** お客様の依頼が 🌟 の1件を指しているか（見積もりの依頼・空きの質問なし・別の建物名や複数を書いていない） */
export function askPointsAtStarredRoom(askText: string | null | undefined, starText: string | null | undefined): boolean {
  const ask = String(askText ?? "").normalize("NFKC");
  const star = starredRoomOf(starText);
  if (!star || !ask.trim()) return false;
  if (!FOCUSED_ESTIMATE_ASK_RE.test(ask) || VACANCY_ASK_RE.test(ask)) return false;
  if (MULTI_OR_OTHER_RE.test(ask)) return false;
  const free = freeTextPropertyName(ask);
  if (free && !nameKey(star.name).includes(nameKey(free)) && !nameKey(free).includes(nameKey(star.name))) return false;
  return true;
}

export type StarEstimateAsk = { hit: boolean; starName: string | null };

/**
 * 会話（古い順）と今回のお客様の連投から: 今回より前のこちらの最後の物件の発言が 🌟 の1件で、その後にお客様の持ち込み（物件の画像・URL）も
 * こちらの別の 🌟／【】も無く、今回の連投がその 🌟 を指す見積もりの依頼か。
 */
export function resolveStarEstimateAsk(
  messagesOldestFirst: ReadonlyArray<{ sender: string; text: string | null; imageType?: string | null }>,
  turnText: string | null | undefined,
): StarEstimateAsk {
  const no: StarEstimateAsk = { hit: false, starName: null };
  // 今回の連投（最後のこちらの発言より後）の前を見る
  let lastStaff = -1;
  messagesOldestFirst.forEach((m, i) => { if (m.sender !== "customer") lastStaff = i; });
  let starIdx = -1;
  for (let i = lastStaff; i >= 0; i--) {
    const m = messagesOldestFirst[i];
    if (m.sender === "customer") continue;
    if ((m.text ?? "").includes("🌟")) { starIdx = i; break; }
    if (/【[^】]{2,40}】/.test(m.text ?? "")) return no; // 🌟 より後にこちらの見積書・確認の見出し＝別の物件の話が進んでいる
  }
  if (starIdx < 0) return no;
  const after = messagesOldestFirst.slice(starIdx + 1);
  if (after.some((m) => m.sender === "customer" && (["floor_plan", "property_photo", "estimate"].includes(m.imageType ?? "") || /https?:\/\//.test(m.text ?? "")))) return no;
  const star = messagesOldestFirst[starIdx].text;
  if (!askPointsAtStarredRoom(turnText, star)) return no;
  return { hit: true, starName: starredRoomOf(star)?.name ?? null };
}
