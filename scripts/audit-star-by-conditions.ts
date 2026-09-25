// scripts/audit-star-by-conditions.ts
// 🌟（AIX 物件オススメで1番オススメにした物件）を「同じ回に送った画像の物件」と比べ、お客様の条件に照らして
// スタッフの選び方（＝オススメの基準）を測る。読むだけ・DB に書かない・LLM を呼ばない（決定論だけ）。
//
// 2026-09-25 竹内「過去の候補の記録、お客さんから希望の条件のフォーマットが届いていて、それを売上サポに保管されていると思う。
//   そこから、リンクしているお客さんへのオススメの基準を判断できるか」
//   正解は「スタッフが選んで送った事実」（memory feedback_property_selection_label）。お客様の返信の有無は一切使わない。
//
// ■ 組み立て
//   ① 🌟の送信（messages・staff・先頭が🌟）ごとに、同じ会話で🌟の 60秒前まで・24時間以内・前の🌟より後に送った画像を候補にする。
//      画像→物件は sent_image_properties / sent_properties.image_url。同じ建物の画像はまとめて1候補（枚数＝写真の多さ）。
//      🌟の建物が候補に無い回（単独で🌟を送った回）と候補が1件の回は数えない。
//   ② 候補の値は「どの候補にも同じ道で届く材料」だけ（🌟だけが持つ材料で差を作らない）:
//      OCR（image_details の lines）→ 間取り・築年・階・向き・設備・ペット・現況 ／ 号室 → 階 ／
//      同じ会話の送付記録の家賃（画像の読み取り）／ 候補プール（拡張の回）の間取り・AD・家賃・順位 ／
//      辞書（**別の会話**の🌟本文・property_details・OCR から同じ建物の値: 家賃・徒歩・築年・㎡・間取り・設備・敷礼0の語）
//      ⚠ 同じ会話の🌟本文は使わない（選ばれた物件だけが値を持つ＝答えの漏れ）
//   ③ お客様の条件は property_customers（raw_format_text を含む）を今の値で読み、property_condition_history で🌟の時点へ戻す
//      （🌟より後の変更は old_value に戻す）。戻せない列は今の値（印: 今の条件）。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-star-by-conditions.ts --until=2026-09-25T12:00:00Z [--days=180] [--show=8] [--out=path.json] [--ad=off] [--dict-star=on]
//   --dict-star=on: 別の会話の🌟本文・property_details の値も判定に使う（🌟の建物ほど本文がある＝🌟に有利な偏り。参考値）
//   追加の節（2026-09-25 竹内）: 物件オススメで送った物件の特定（🌟の前3分〜後1分の画像）／条件の近さ × お客様の反応（48時間・次の🌟まで・最初の5通）。
//     反応は選び方を理解する補助の材料で、🌟の正誤には使わない（feedback_property_selection_label）。反応の文は伏せ字・40字まで
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import {
  buildCustomerProfile, judgeProperty, parsePropertyFacts, normalizeFloorPlanToken, normalizeBuildingName, matchFloorPlan, rankFloorPlan,
  type CustomerLike, type SentRowLike, type PatternRowLike, type PropertyFacts, type CustomerProfile,
} from "../app/lib/property-brain";
import { isGenericBuildingName } from "../app/lib/generic-building-name";
import { parseListingEquipment, parseEquipmentWants, matchEquipment, floorFromRoom, type EquipmentMatch } from "../app/lib/listing-equipment";
import { parseListingTerms } from "../app/lib/listing-terms";
import { parseAreaWant, parseCommuteWants, buildPropertyLocation, matchArea, matchCommute, locationReasonCodes } from "../app/lib/area-want";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a, "1"]; }));
const DAYS = parseInt(String(args.days ?? "180"), 10);
const UNTIL = String(args.until ?? new Date().toISOString());
const SHOW = parseInt(String(args.show ?? "0"), 10);
const AD_OFF = args.ad === "off";
// 🌟本文・property_details の辞書は🌟の物件に偏る（選ばれた建物ほど本文がある）→ 既定では判定の材料にしない
const DICT_STAR = args["dict-star"] === "on";
const TEST_CONV = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7"; // YUMA（竹内さんのテスト用）は除く
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");

type Row = Record<string, any>;
const H = 3600_000, D = 24 * H;

async function all(build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>): Promise<Row[]> {
  let out: Row[] = [];
  for (let p = 0; p < 80; p++) {
    const { data, error } = await build(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < 1000) break;
  }
  return out;
}
function chunks<T>(xs: T[], n = 100): T[][] { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; }
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
/** 本文のお客様の呼び名（「〇〇さん」「〇〇様」）を伏せる（出力にお客様の名前を出さない） */
const maskName = (s: string) => s.replace(/[^\s、。！!・/（）()]{1,16}(?=さん|様)/gu, "〇〇");
/** 反応の文の個人情報を伏せる（呼び名・4桁以上の数字＝電話・番地） */
const maskText = (s: string) => maskName(s).replace(/\d[\d\-‐－]{3,}/g, "＊＊＊").replace(/\s+/g, " ").slice(0, 40);

/**
 * 🌟の後のお客様の発言を決定論で分ける（補助の材料・🌟の正誤には使わない）。
 * 強い順: 内見・申込の希望 ＞ 否定・別の物件を希望 ＞ 条件の追加・変更 ＞ その物件への質問 ＞ 好意的な反応 ＞ お礼・スタンプだけ ＞ その他
 * 否定の理由は、否定の文に家賃・場所・広さ・築年・間取り・設備の語がある時だけ数える。
 */
type Reaction = { kind: string; reasons: string[]; snippet: string };
function classifyReaction(msgs: Row[]): Reaction {
  if (!msgs.length) return { kind: "反応なし", reasons: [], snippet: "" };
  const texts = msgs.map((x) => (x.text ? String(x.text) : x.image_url ? "[画像]" : "")).filter(Boolean);
  const all = texts.join(" / ").normalize("NFKC");
  const pick = (re: RegExp) => texts.find((x) => re.test(x.normalize("NFKC"))) ?? texts[0];
  // 監査で直した誤り（2026-09-25・例を目で読んで）: 「ここって厳しいですか？」は否定ではなく質問（弱い否定語は疑問文なら数えない）／
  //   「〇〇の方が気に入ってます」「九条の1ルームはありますか」は別の物件の希望／「16時から空いております」は内見の日程
  //   2回目: 「審査通りやすいでしょうか」は申込ではない（審査を外す）／「築年数古い以外に理由が…でしょうか」は質問（否定語は文ごとに疑問文を除く）
  const VIEW = /内見|内覧|見学|見に行|見てみたい|申込|申し込|契約したい|契約させ|押さえ|住みたい|決めたい|(?:\d{1,2}|何)時(?:から|頃|に|以降|〜|~)|曜日|空いて(?:おり|い)ます/;
  const OTHER = /(?:他|別)の(?:物件|部屋|お部屋)|の方が(?:気に入|いい|良)|(?:物件|お部屋|部屋|ルーム|LDK|DK)(?:とか|も|って|は)?(?:ない|あります|ありません)(?:です|でしょう)?か/;
  const NEG_WORD = /高い|高すぎ|高め|狭い|狭そう|遠い|古い|古そう|やめ|見送|合わない|いまいち|イマイチ|気に(?:なら|入らな)|予算(?:内|オーバー|を超)|微妙|厳しい|ちょっと(?:違|無理)/;
  const isQuestion = (x: string) => /[?？]|ですか|ますか|でしょうか|のか/.test(x);
  const sentences = (x: string) => x.split(/[。！!\n]|(?<=[?？])/).map((y) => y.trim()).filter(Boolean);
  const NEG_STRONG = new RegExp(`${OTHER.source}|${NEG_WORD.source}`);
  const NEG_WEAK = NEG_WORD;
  const isNeg = (x: string) => OTHER.test(x) || sentences(x).some((y) => NEG_WORD.test(y) && !isQuestion(y));
  const COND = /条件|予算|エリア|希望(?:は|を|の)|最低でも|以上で|以内で|やっぱり|同棲|二人入居|ペット|抑えたい|周辺で|変わっても/;
  const Q = /[?？]|ですか|ますか|でしょうか|かな|教えて/;
  const LIKE = /いい(?:です|ね|な|感じ)|良い|良さそう|素敵|すてき|気に入|気にな(?:り|る)|綺麗|きれい|最高|魅力|ぜひ|是非|検討/;
  const THANKS = /^(?:\[スタンプ\]|\[画像\]|ありがとう|有難う|ありがと|承知|了解|わかりました|分かりました|確認|拝見|見てみ|見ます)/;
  if (VIEW.test(all)) return { kind: "内見・申込の希望", reasons: [], snippet: pick(VIEW) };
  if (texts.some((x) => isNeg(x.normalize("NFKC")))) {
    const s = texts.filter((x) => isNeg(x.normalize("NFKC"))).join(" ");
    const reasons: string[] = [];
    if (/高|家賃|予算|円|万/.test(s)) reasons.push("家賃");
    if (/遠|駅|場所|エリア|立地|通勤/.test(s)) reasons.push("場所");
    if (/狭|広さ|帖|畳|㎡|平米/.test(s)) reasons.push("広さ");
    if (/古|築/.test(s)) reasons.push("築年");
    if (/間取り|LDK|DK|1K|ワンルーム/.test(s)) reasons.push("間取り");
    if (/設備|バス|トイレ|洗面|オートロック|宅配|エレベーター|ペット|駐車/.test(s)) reasons.push("設備");
    if (/の方が|(?:他|別)の|ありますか|ありませんか/.test(s)) reasons.push("別の物件");
    const hit = (texts.find((x) => isNeg(x.normalize("NFKC"))) ?? texts[0]).normalize("NFKC");
    const mm = hit.match(NEG_STRONG) ?? hit.match(NEG_WEAK);
    const at = mm?.index ?? 0;
    return { kind: "否定・別の物件を希望", reasons, snippet: hit.slice(Math.max(0, at - 20), at + 20) };
  }
  if (COND.test(all)) return { kind: "条件の追加・変更", reasons: [], snippet: pick(COND) };
  if (Q.test(all)) return { kind: "その物件への質問", reasons: [], snippet: pick(Q) };
  if (LIKE.test(all)) return { kind: "好意的な反応", reasons: [], snippet: pick(LIKE) };
  if (texts.every((x) => THANKS.test(x.trim()))) return { kind: "お礼・スタンプだけ", reasons: [], snippet: texts[0] };
  return { kind: "その他", reasons: [], snippet: texts[0] };
}
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

// ── 名前 ──
const toHalf = (s: string) => s.normalize("NFKC");
function splitRoom(name: string): { building: string; room: string } {
  const s = toHalf(name).trim();
  const m = s.match(/[\s　]*(\d{1,4})\s*号室?\s*$/) ?? s.match(/[\s　]+(\d{1,4})$/);
  if (!m) return { building: s, room: "" };
  return { building: s.slice(0, m.index ?? 0).trim(), room: m[1].replace(/^0+(?=\d)/, "") };
}
const bkey = (name: string) => normalizeBuildingName(splitRoom(name).building).replace(/[・･\-‐ー－\s]/g, "").toLowerCase();
function sameBuilding(a: string, b: string): boolean {
  const x = bkey(a), y = bkey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) >= 5 && (x.includes(y) || y.includes(x))) return true;
  // 画像の読み違い（クリエ↔クレイ・難波↔雑賀・ヴェローナ↔ヴェローラ）: 2文字組の一致度 0.75 以上で同じ建物（6文字以上の名前だけ）
  if (Math.min(x.length, y.length) < 6) return false;
  const bg = (s: string) => { const o = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); o.set(k, (o.get(k) ?? 0) + 1); } return o; };
  const A = bg(x), B = bg(y); let inter = 0;
  for (const [k, n] of A) inter += Math.min(n, B.get(k) ?? 0);
  return (2 * inter) / (x.length - 1 + y.length - 1) >= 0.75;
}
/** 🌟の1行目＝物件名。「1件新着で〇〇さんに…お部屋が募集に出ました」のように1行目が物件名でない形は ""（数えない） */
const starName = (text: string) => { const l = text.split("\n")[0].replace(/^🌟\s*/u, "").trim(); return /新着|オススメ|お部屋|募集に出/.test(l) ? "" : l; };
const normRoom = (r: unknown) => String(r ?? "").normalize("NFKC").replace(/号室?$/, "").replace(/^0+(?=\d)/, "").trim();

// ── 🌟本文・property_details から値（辞書の材料と、選ばれた物件そのものの値＝手順5） ──
type Vals = { rent?: number | null; admin?: number | null; total?: number | null; walk?: number | null; age?: number | null; plan?: string | null; sqm?: number | null; zero?: boolean; equipText?: string; access?: string[] };
function valsFromStarText(text: string, today: number): Vals {
  const t = toHalf(text).replace(/,/g, "");
  const total = t.match(/(?:合計|管理費込み?|管理費共益費込み?|総額)[^\d\n]{0,6}(\d{5,6})円/);
  const rent = t.match(/家賃\s*(\d{5,6})円/);
  const adm = t.match(/(?:管理費|共益費)\s*(\d{3,5})円/);
  const walk = t.match(/徒歩\s*(\d{1,2})\s*分/);
  const ageY = t.match(/築\s*(\d{1,2})\s*年/);
  const built = t.match(/(20\d{2}|19\d{2})年(?:\d{1,2}月)?築/);
  const sqm = t.match(/(\d{2,3}(?:\.\d+)?)\s*(?:㎡|m2|平米)/);
  const yr = new Date(today).getFullYear();
  const age = /新築/.test(t) ? 0 : ageY ? parseInt(ageY[1], 10) : built ? Math.max(0, yr - parseInt(built[1], 10)) : null;
  const zero = /敷金礼金(?:なし|0|ゼロ|無し)|敷礼(?:なし|0|ゼロ)|敷金・礼金(?:なし|0)|礼金敷金(?:なし|0)/.test(t);
  const access = t.split("\n").filter((l) => /徒歩\s*\d+\s*分/.test(l) && /「|駅/.test(l)).map((l) => (l.match(/[^\s、。・！]*「[^」]+」\s*徒歩\s*\d+\s*分|[^\s、。・！]+駅\s*徒歩\s*\d+\s*分/) ?? [""])[0]).filter(Boolean);
  return {
    rent: rent ? +rent[1] : null, admin: adm ? +adm[1] : null, total: total ? +total[1] : rent ? +rent[1] + (adm ? +adm[1] : 0) : null,
    walk: walk ? +walk[1] : null, age, plan: normalizeFloorPlanToken(t.replace(/\d{5,6}円/g, "")), sqm: sqm ? parseFloat(sqm[1]) : null, zero, access,
  };
}
function valsFromDetails(pd: Row): Vals {
  const plan = normalizeFloorPlanToken(String(pd.floor_plan ?? ""));
  const rent = typeof pd.rent === "number" ? pd.rent : null, admin = typeof pd.admin_fee === "number" ? pd.admin_fee : null;
  return {
    rent, admin, total: rent != null ? rent + (admin ?? 0) : null, walk: pd.walk_minutes ?? null, age: pd.building_age ?? null, plan,
    sqm: pd.area_sqm ?? null, zero: pd.deposit === 0 && pd.key_money === 0 ? true : undefined,
    equipText: Array.isArray(pd.features) && pd.features.length ? `設備: ${pd.features.join("、")}` : undefined,
  };
}

// ── 候補 ──
type Cand = {
  name: string; room: string; images: number; order: number; isStar: boolean;
  ocrText: string; ocr: boolean;
  rent: number | null; admin: number | null; rentSrc: string | null;
  plan: string | null; planSrc: string | null;
  age: number | null; ageSrc: string | null;
  walk: number | null; sqm: number | null; zeroMention: boolean | null; dictStar: boolean;
  floor: number | null; adMonths: number | null; poolRank: number | null; vacancy: "vacant" | "leaving" | null;
  equipText: string; access: string[];
};

async function main() {
  const until = new Date(UNTIL).getTime();
  const since = new Date(until - DAYS * D).toISOString();
  const untilIso = new Date(until).toISOString();

  // ① 🌟の送信（辞書のため 365日分を読み、測るのは DAYS 分）
  const dictSince = new Date(until - 365 * D).toISOString();
  const starsAll = await all((a, b) => sb.from("messages").select("id, conversation_id, text, created_at").eq("sender", "staff").like("text", "🌟%")
    .gte("created_at", dictSince).lt("created_at", untilIso).order("created_at").range(a, b) as never);
  const stars = starsAll.filter((m) => m.created_at >= since && m.conversation_id !== TEST_CONV);
  const convIds = [...new Set(stars.map((m) => m.conversation_id as string))];
  const convCust = new Map<string, string>();
  for (const c of chunks(convIds)) {
    const { data } = await sb.from("conversations").select("id, property_customer_id").in("id", c);
    for (const r of (data ?? []) as Row[]) if (r.property_customer_id) convCust.set(r.id, r.property_customer_id);
  }
  const custIds = [...new Set([...convCust.values()])];

  const custs = new Map<string, Row>();
  const hist: Row[] = [], pools: Row[] = [], sentsCust: Row[] = [], pats: Row[] = [];
  for (const c of chunks(custIds, 60)) {
    const { data } = await sb.from("property_customers").select("id, rent_max, max_rent, rent_min, floor_plan, layout, walk_minutes, building_age, initial_cost_limit, preferences, ng_points, other_requests, additional_conditions, pet, move_in_time, created_at, floor_area_min, raw_format_text, desired_area, commute_station, commute_minutes").in("id", c);
    for (const r of (data ?? []) as Row[]) custs.set(r.id, r);
    hist.push(...await all((a, b) => sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, new_value, created_at").in("property_customer_id", c).range(a, b) as never));
    pools.push(...await all((a, b) => sb.from("property_candidate_pools").select("property_customer_id, candidates, sent_at").in("property_customer_id", c).gte("sent_at", new Date(until - (DAYS + 15) * D).toISOString()).lt("sent_at", untilIso).range(a, b) as never));
    sentsCust.push(...await all((a, b) => sb.from("sent_properties").select("property_customer_id, conversation_id, property_name, room_no, rent, delivery, source, sent_at, ad_months, image_url").in("property_customer_id", c).gte("sent_at", new Date(until - (DAYS + 200) * D).toISOString()).lt("sent_at", untilIso).range(a, b) as never));
    pats.push(...await all((a, b) => sb.from("property_selection_patterns").select("property_customer_id, selling_points, selection_label, created_at").in("property_customer_id", c).lt("created_at", untilIso).range(a, b) as never));
  }
  // 会話ごとの画像・画像→物件・OCR
  const imgs: Row[] = [], sips: Row[] = [], sentsConv: Row[] = [], custMsgs: Row[] = [];
  for (const c of chunks(convIds, 40)) {
    imgs.push(...await all((a, b) => sb.from("messages").select("id, conversation_id, created_at, image_url").eq("sender", "staff").not("image_url", "is", null).in("conversation_id", c).gte("created_at", new Date(until - (DAYS + 2) * D).toISOString()).lt("created_at", untilIso).range(a, b) as never));
    sips.push(...await all((a, b) => sb.from("sent_image_properties").select("image_url, conversation_id, property_name, room_no, source").in("conversation_id", c).range(a, b) as never));
    sentsConv.push(...await all((a, b) => sb.from("sent_properties").select("conversation_id, property_name, room_no, rent, source, channel, sent_at, ad_months, image_url").in("conversation_id", c).gte("sent_at", new Date(until - (DAYS + 2) * D).toISOString()).lt("sent_at", new Date(until + 2 * D).toISOString()).range(a, b) as never));
    // 🌟の後のお客様の発言（反応＝選び方を理解する補助の材料。🌟の正誤には使わない）
    custMsgs.push(...await all((a, b) => sb.from("messages").select("conversation_id, created_at, text, image_url").eq("sender", "customer").in("conversation_id", c).gte("created_at", since).lt("created_at", new Date(until + 2 * D).toISOString()).range(a, b) as never));
  }
  const custMsgsByConv = new Map<string, Row[]>(); for (const x of custMsgs) { if (!custMsgsByConv.has(x.conversation_id)) custMsgsByConv.set(x.conversation_id, []); custMsgsByConv.get(x.conversation_id)!.push(x); }
  for (const xs of custMsgsByConv.values()) xs.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const ocrAll = await all((a, b) => sb.from("image_details").select("image_url, conversation_id, kind, lines").range(a, b) as never);
  const sipAll = await all((a, b) => sb.from("sent_image_properties").select("image_url, conversation_id, property_name, room_no").range(a, b) as never);
  // 選び方に関係なく全物件に届く材料（全お客様の候補プール＝検索の結果・全会話の送付記録の家賃＝送った画像の読み取り）
  const poolsGlobal = await all((a, b) => sb.from("property_candidate_pools").select("property_customer_id, candidates, sent_at").gte("sent_at", dictSince).lt("sent_at", untilIso).range(a, b) as never);
  const sentRentGlobal = await all((a, b) => sb.from("sent_properties").select("conversation_id, property_name, room_no, rent, ad_months").gte("sent_at", dictSince).lt("sent_at", untilIso).not("rent", "is", null).range(a, b) as never);
  const pdAll = await all((a, b) => sb.from("aix_generate_log").select("conversation_id, created_at, property_details").eq("action_type", "property_recommendation").not("property_details", "is", null).lt("created_at", untilIso).range(a, b) as never);

  const sipByUrl = new Map<string, Row>(); for (const r of [...sipAll, ...sips]) sipByUrl.set(r.image_url, r);
  const spByUrl = new Map<string, Row>(); for (const r of sentsConv) if (r.image_url) spByUrl.set(r.image_url, r);
  const ocrByUrl = new Map<string, Row>(); for (const r of ocrAll) if (r.kind === "property") ocrByUrl.set(r.image_url, r);

  // ── 辞書（建物 → 値の出どころの一覧・会話 id 付き。使う時に同じ会話を除く） ──
  type DictEntry = { conv: string; room: string; v: Vals; src: "star" | "pd" | "ocr" };
  const dict = new Map<string, DictEntry[]>();
  const put = (name: string, e: DictEntry) => { const k = bkey(name); if (!k || isGenericBuildingName(name)) return; if (!dict.has(k)) dict.set(k, []); dict.get(k)!.push(e); };
  for (const m of starsAll) {
    const first = starName(String(m.text ?? ""));
    if (!first) continue;
    put(first, { conv: m.conversation_id, room: splitRoom(first).room, v: valsFromStarText(String(m.text), Date.parse(m.created_at)), src: "star" });
  }
  for (const r of pdAll) {
    const pd = r.property_details as Row; if (!pd?.name) continue;
    put(String(pd.name), { conv: r.conversation_id, room: normRoom(pd.room_no), v: valsFromDetails(pd), src: "pd" });
  }
  for (const r of ocrAll) {
    if (r.kind !== "property") continue;
    const s = sipByUrl.get(r.image_url); if (!s?.property_name) continue;
    const text = (r.lines as string[]).join("\n");
    const t = parseListingTerms(text, { today: new Date(until).toISOString() });
    const plan = normalizeFloorPlanToken(((text.match(/間取り[:：]\s*([^\n]+)/) ?? [])[1] ?? "").replace(/ワンルーム/, "1R"));
    put(String(s.property_name), { conv: r.conversation_id ?? s.conversation_id, room: normRoom(s.room_no), v: { age: t.buildingAgeYears, plan, equipText: text }, src: "ocr" });
  }
  // 建物 → プールの間取り・AD（間取りは1種類に決まる建物だけ）／ 建物＋号室 → 送付記録の家賃
  const gPool = new Map<string, { plans: Set<string>; ads: number[] }>();
  for (const p of poolsGlobal) for (const x of (((typeof p.candidates === "string" ? JSON.parse(p.candidates) : p.candidates) ?? []) as Row[])) {
    if (!x?.name || isGenericBuildingName(String(x.name))) continue;
    const k = bkey(String(x.name)); if (!k) continue;
    const e = gPool.get(k) ?? { plans: new Set<string>(), ads: [] }; gPool.set(k, e);
    const pl = x.floor_plan ? normalizeFloorPlanToken(String(x.floor_plan)) : null; if (pl) e.plans.add(pl);
    if (x.ad_months != null) e.ads.push(Number(x.ad_months));
  }
  const gRent = new Map<string, number[]>();
  for (const r of sentRentGlobal) {
    if (!r.property_name || !r.room_no || !r.rent) continue;
    const k = `${bkey(String(r.property_name))}|${normRoom(r.room_no)}`;
    if (!gRent.has(k)) gRent.set(k, []); gRent.get(k)!.push(r.rent);
  }
  const dictLookup = (name: string, room: string, conv: string): DictEntry[] => {
    const k = bkey(name);
    const hits: DictEntry[] = [];
    for (const [dk, es] of dict) { if (dk === k || (Math.min(dk.length, k.length) >= 5 && (dk.includes(k) || k.includes(dk)))) hits.push(...es.filter((e) => e.conv !== conv)); }
    // 同じ部屋を先に
    return hits.sort((a, b) => Number(!!room && b.room === room) - Number(!!room && a.room === room));
  };

  // ── 条件を🌟の時点へ戻す ──
  const histOf = new Map<string, Row[]>(); for (const h of hist) { if (!histOf.has(h.property_customer_id)) histOf.set(h.property_customer_id, []); histOf.get(h.property_customer_id)!.push(h); }
  const NUM = new Set(["rent_max", "rent_min", "walk_minutes", "building_age", "initial_cost_limit", "max_rent", "floor_area_min"]);
  function custAt(id: string, t: number): { c: Row; restored: string[]; hadHistory: boolean } {
    const base = { ...custs.get(id)! };
    const hs = (histOf.get(id) ?? []).filter((h) => Date.parse(h.created_at) > t).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const done = new Set<string>(), restored: string[] = [];
    for (const h of hs) {
      if (done.has(h.changed_field) || !(h.changed_field in base)) continue;
      done.add(h.changed_field);
      const v = h.old_value;
      base[h.changed_field] = NUM.has(h.changed_field) ? (v == null || v === "" ? null : parseInt(String(v).replace(/[^\d]/g, ""), 10) || null) : v;
      restored.push(h.changed_field);
    }
    return { c: base, restored, hadHistory: (histOf.get(id) ?? []).length > 0 };
  }

  // ── 集計の器 ──
  const cnt = { stars: stars.length, starNameNotFirstLine: 0, withCust: 0, noBatch: 0, starNotInBatch: 0, single: 0, sessions: 0, cands: 0, unnamedImages: 0, restoredSessions: 0, currentOnly: 0 };
  type Pair = { better: number; equal: number; worse: number; sessions: Set<string> };
  const pairs: Record<string, Pair> = {};
  const addPair = (feat: string, sid: string, star: number | null | undefined, other: number | null | undefined, higherBetter: boolean) => {
    if (star == null || other == null || Number.isNaN(star) || Number.isNaN(other)) return;
    const p = (pairs[feat] ??= { better: 0, equal: 0, worse: 0, sessions: new Set() });
    p.sessions.add(sid);
    if (star === other) p.equal++; else if ((star > other) === higherBetter) p.better++; else p.worse++;
  };
  const coverage: Record<string, { star: number; other: number }> = {};
  const cov = (k: string, isStar: boolean, has: boolean) => { const c = (coverage[k] ??= { star: 0, other: 0 }); if (has) c[isStar ? "star" : "other"]++; };
  let starCands = 0, otherCands = 0;
  // judge
  const coreRes: Array<{ n: number; gt: number; pos: number; rel: number; allTied: boolean }> = [];
  const coreShows: string[] = [];
  const rentSrcCount: Record<string, { star: number; other: number }> = {};
  const judgeRes: Array<{ sid: string; n: number; gt: number; pos: number; rel: number; allTied: boolean; ocrAll: boolean; orderPos: number; poolPos: number | null }> = [];
  const shows: string[] = [];
  const reasonDiff: Record<string, { star: number; other: number }> = {};
  // 手順5: お客様の条件の種類 → 選ばれた物件（本文の値）が合う率・同じ回のほかの候補との比較
  type TypeStat = { sessions: number; starSat: number; starKnown: number; pairBetter: number; pairWorse: number; pairEq: number };
  const typeStats: Record<string, TypeStat> = {};
  const tstat = (k: string) => (typeStats[k] ??= { sessions: 0, starSat: 0, starKnown: 0, pairBetter: 0, pairWorse: 0, pairEq: 0 });
  // 手順5（全🌟）: 選ばれた物件そのものの値（本文・property_details）が条件に合う率（候補が組めない🌟も含む）
  const ownStats: Record<string, { n: number; known: number; sat: number }> = {};
  const identCount: Record<string, number> = {};
  const identShows: string[] = [];
  const reactTable: Record<string, Record<string, number>> = {};
  const negReasons: Record<string, number> = {};
  const negVsOut: Record<string, number> = {};
  const reactShows: string[] = [];
  const ownRatios: number[] = [];
  const overShows: string[] = [];
  const own = (k: string, known: boolean, sat: boolean) => { const s = (ownStats[k] ??= { n: 0, known: 0, sat: 0 }); s.n++; if (known) { s.known++; if (sat) s.sat++; } };

  const imgsByConv = new Map<string, Row[]>(); for (const m of imgs) { if (!imgsByConv.has(m.conversation_id)) imgsByConv.set(m.conversation_id, []); imgsByConv.get(m.conversation_id)!.push(m); }
  for (const xs of imgsByConv.values()) xs.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const starsByConv = new Map<string, number[]>(); for (const m of starsAll) { if (!starsByConv.has(m.conversation_id)) starsByConv.set(m.conversation_id, []); starsByConv.get(m.conversation_id)!.push(Date.parse(m.created_at)); }
  const poolsOf = new Map<string, Row[]>(); for (const p of pools) { if (!poolsOf.has(p.property_customer_id)) poolsOf.set(p.property_customer_id, []); poolsOf.get(p.property_customer_id)!.push(p); }
  const sentOf = new Map<string, Row[]>(); for (const s of sentsCust) { if (!sentOf.has(s.property_customer_id)) sentOf.set(s.property_customer_id, []); sentOf.get(s.property_customer_id)!.push(s); }
  const patsOf = new Map<string, Row[]>(); for (const p of pats) { if (!patsOf.has(p.property_customer_id)) patsOf.set(p.property_customer_id, []); patsOf.get(p.property_customer_id)!.push(p); }
  const custLabel = new Map<string, string>();
  const label = (id: string) => { if (!custLabel.has(id)) custLabel.set(id, `お客様${custLabel.size < 26 ? String.fromCharCode(65 + custLabel.size) : custLabel.size + 1}`); return custLabel.get(id)!; };
  const pdByConvTime = pdAll.map((r) => ({ conv: r.conversation_id, t: Date.parse(r.created_at), pd: r.property_details as Row }));

  for (const m of stars) {
    const first = starName(String(m.text ?? ""));
    if (!first || isGenericBuildingName(first)) { cnt.starNameNotFirstLine++; continue; }
    const pc = convCust.get(m.conversation_id);
    if (!pc || !custs.has(pc)) continue;
    cnt.withCust++;
    const t = Date.parse(m.created_at);
    const { c: custRow, restored, hadHistory } = custAt(pc, t);
    const cust = custRow as CustomerLike & Row;
    const patsBefore = (patsOf.get(pc) ?? []).filter((p) => Date.parse(p.created_at) < t) as PatternRowLike[];

    // 手順5（全🌟）: 選ばれた物件の値（本文＋同じ時刻の property_details）
    {
      const prof0 = buildCustomerProfile(cust, [], patsBefore, null, { today: m.created_at });
      const v = valsFromStarText(String(m.text), t);
      const pdHit = pdByConvTime.find((x) => x.conv === m.conversation_id && Math.abs(x.t - t) < 20 * 60_000 && x.pd?.name && sameBuilding(String(x.pd.name), first));
      if (pdHit) { const d = valsFromDetails(pdHit.pd); v.total ??= d.total; v.walk ??= d.walk; v.age ??= d.age; v.plan ??= d.plan; v.sqm ??= d.sqm; }
      const type = (k: string) => k;
      own(type(prof0.wantsLowInitialCost ? "初期費用を抑えたい→敷礼0の語" : "初期費用の希望なし→敷礼0の語"), true, !!v.zero);
      if (prof0.rentMax != null) {
        own("家賃: 上限内（管理費込み）", v.total != null, v.total != null && v.total <= prof0.rentMax);
        own("家賃: 上限の110%以内", v.total != null, v.total != null && v.total <= prof0.rentMax * 1.1);
        own("家賃: 上限の85%未満（安すぎ）", v.total != null, v.total != null && v.total < prof0.rentMax * 0.85);
        if (v.total != null) ownRatios.push(v.total / prof0.rentMax);
        if (v.total != null && v.total > prof0.rentMax * 1.1 && overShows.length < SHOW) overShows.push(`${label(pc)} ${m.created_at.slice(0, 10)} 条件の履歴${hadHistory ? "あり" : "なし（今の条件）"} 上限${prof0.rentMax} 🌟${v.total}（${(v.total / prof0.rentMax).toFixed(2)}） ${maskName(String(m.text).split("\n").slice(0, 3).join(" / ")).slice(0, 160)}`);
      }
      if (prof0.walkMax != null) own(`徒歩の希望あり→希望内`, v.walk != null, v.walk != null && v.walk <= prof0.walkMax);
      if (prof0.buildingAgeMax != null) own(`築年の希望あり→希望内`, v.age != null, v.age != null && v.age <= prof0.buildingAgeMax);
      else own(`築年の希望なし→築10年以内`, v.age != null, v.age != null && v.age <= 10);
      if (!prof0.floorPlanWant.any) own("間取りの希望あり→一致", v.plan != null, v.plan != null && matchFloorPlan(prof0.floorPlanWant, v.plan) === "match");
      if (prof0.sqmMin != null) own("広さの希望あり→希望以上", v.sqm != null, v.sqm != null && v.sqm >= prof0.sqmMin);

      // 追加（竹内 2026-09-25）A: 物件オススメで送った物件の特定（🌟の本文と一緒に送った画像）
      const recWin = (imgsByConv.get(m.conversation_id) ?? []).filter((x) => { const ts = Date.parse(x.created_at); return ts >= t - 3 * 60_000 && ts <= t + 60_000; });
      const recRows = recWin.map((x) => sipByUrl.get(x.image_url) ?? spByUrl.get(x.image_url) ?? null);
      const spRec = sentsConv.filter((s) => s.conversation_id === m.conversation_id && Math.abs(Date.parse(s.sent_at) - t) <= 10 * 60_000 && (s.channel === "recommendation" || String(s.source ?? "") === "aix:property_recommendation"));
      let ident: string;
      if (recWin.length === 0) ident = spRec.some((s) => s.property_name && sameBuilding(s.property_name, first)) ? "画像の記録なし・送付記録で一致" : "画像なし（本文だけ・またはLINEの保存外）";
      else if (recRows.some((r) => r?.property_name && sameBuilding(String(r.property_name), first))) ident = "画像あり・物件名が🌟と一致";
      else if (spRec.some((s) => s.property_name && sameBuilding(s.property_name, first))) ident = "画像あり・送付記録（recommendation）で一致";
      else if (recRows.some((r) => r?.property_name)) { ident = "画像あり・読んだ物件名が🌟と違う"; if (identShows.length < SHOW * 2) identShows.push(maskName(`🌟「${first}」 ⇔ 読んだ名前「${recRows.filter((r) => r?.property_name).map((r) => r!.property_name).join("／")}」`)); }
      else ident = "画像あり・画像→物件の記録なし";
      identCount[ident] = (identCount[ident] ?? 0) + 1;
      if (spRec.length) identCount["（参考）送付記録に channel=recommendation の行がある"] = (identCount["（参考）送付記録に channel=recommendation の行がある"] ?? 0) + 1;
      if (recWin.length > 1) identCount["（参考）🌟と一緒の画像が2枚以上"] = (identCount["（参考）🌟と一緒の画像が2枚以上"] ?? 0) + 1;

      // 追加 B: 条件の近さ（🌟そのものの値を条件に照らし、読めた基準のうち外れた数）× お客様の反応（48時間以内・最初の5通）
      if (t <= until - 48 * H) {
        const checks: boolean[] = [];
        const outs: string[] = [];
        if (prof0.rentMax != null && v.total != null) { const ok = v.total <= prof0.rentMax; checks.push(ok); if (!ok) outs.push("家賃"); }
        if (prof0.walkMax != null && v.walk != null) { const ok = v.walk <= prof0.walkMax; checks.push(ok); if (!ok) outs.push("徒歩"); }
        if (prof0.buildingAgeMax != null && v.age != null) { const ok = v.age <= prof0.buildingAgeMax; checks.push(ok); if (!ok) outs.push("築年"); }
        if (!prof0.floorPlanWant.any && v.plan != null) { const ok = matchFloorPlan(prof0.floorPlanWant, v.plan) === "match"; checks.push(ok); if (!ok) outs.push("間取り"); }
        if (prof0.sqmMin != null && v.sqm != null) { const ok = v.sqm >= prof0.sqmMin; checks.push(ok); if (!ok) outs.push("広さ"); }
        const wants0 = parseEquipmentWants(cust);
        if (wants0.wants.length) {
          const eqText = `設備: ${[String(m.text), ...(Array.isArray(pdHit?.pd?.features) ? pdHit!.pd.features : [])].join("、")}`;
          const em = matchEquipment(wants0, parseListingEquipment(eqText));
          if (em.ok + em.ng > 0) { const ok = em.ng === 0; checks.push(ok); if (!ok) outs.push("設備"); }
        }
        const closeness = checks.length === 0 ? "基準が読めない" : outs.length === 0 ? `全部合う（${checks.length}基準）` : outs.length === 1 ? "1つ外れ" : "2つ以上外れ";
        // 次の🌟までに区切る（次の回の反応を混ぜない）
        const nextStar = (starsByConv.get(m.conversation_id) ?? []).filter((x) => x > t + 60_000).reduce((a, b) => Math.min(a, b), Infinity);
        const after = (custMsgsByConv.get(m.conversation_id) ?? []).filter((x) => { const ts = Date.parse(x.created_at); return ts > t && ts <= Math.min(t + 48 * H, nextStar); }).slice(0, 5);
        const r = classifyReaction(after);
        const row = (reactTable[closeness] ??= {});
        row[r.kind] = (row[r.kind] ?? 0) + 1;
        const rowAll = (reactTable["（全体）"] ??= {}); rowAll[r.kind] = (rowAll[r.kind] ?? 0) + 1;
        for (const why of r.reasons) negReasons[why] = (negReasons[why] ?? 0) + 1;
        if (r.kind === "否定・別の物件を希望") for (const o of outs) negVsOut[o] = (negVsOut[o] ?? 0) + 1;
        if (reactShows.length < SHOW * 3 && r.kind !== "反応なし") reactShows.push(`${r.kind}${r.reasons.length ? `（${r.reasons.join("・")}）` : ""} ｜近さ: ${closeness}${outs.length ? `［外れ: ${outs.join("・")}］` : ""} ｜「${maskText(r.snippet)}」`);
      } else identCount["（参考）反応の窓が48時間に足りない（until の直前）"] = (identCount["（参考）反応の窓が48時間に足りない（until の直前）"] ?? 0) + 1;
    }

    // ② 候補（同じ会話・24時間以内・前の🌟より後・🌟の60秒前まで）
    const prevStar = (starsByConv.get(m.conversation_id) ?? []).filter((x) => x < t - 60_000).reduce((a, b) => Math.max(a, b), 0);
    const win = (imgsByConv.get(m.conversation_id) ?? []).filter((x) => { const ts = Date.parse(x.created_at); return ts < t - 60_000 && ts > t - 24 * H && ts > prevStar; });
    if (!win.length) { cnt.noBatch++; continue; }
    const groups: Array<{ name: string; room: string; urls: string[]; firstIdx: number }> = [];
    win.forEach((x, idx) => {
      const s = sipByUrl.get(x.image_url) ?? spByUrl.get(x.image_url);
      if (s && String(s.source ?? "").startsWith("aix:property_recommendation")) return;
      const name = s?.property_name ? String(s.property_name) : "";
      if (!s || !name || isGenericBuildingName(name)) { cnt.unnamedImages++; return; }
      const g = groups.find((y) => sameBuilding(y.name, name));
      if (g) { g.urls.push(x.image_url); if (!g.room && s.room_no) g.room = normRoom(s.room_no); }
      else groups.push({ name, room: normRoom(s.room_no), urls: [x.image_url], firstIdx: idx });
    });
    const starG = groups.find((g) => sameBuilding(g.name, first));
    if (!starG) { cnt.starNotInBatch++; continue; }
    if (groups.length < 2) { cnt.single++; continue; }
    cnt.sessions++;
    if (restored.length) cnt.restoredSessions++; else if (!hadHistory) cnt.currentOnly++;
    const sid = String(m.id);
    const batchStart = Date.parse(win[0].created_at);
    const pool = (poolsOf.get(pc) ?? []).filter((p) => { const ts = Date.parse(p.sent_at); return ts <= t && ts >= t - 14 * D; })
      .sort((a, z) => Date.parse(z.sent_at) - Date.parse(a.sent_at));
    const poolCands = pool.flatMap((p) => ((typeof p.candidates === "string" ? JSON.parse(p.candidates) : p.candidates) ?? []) as Row[]);

    const cands: Cand[] = groups.map((g, gi) => {
      const ocrs = g.urls.map((u) => ocrByUrl.get(u)).filter(Boolean) as Row[];
      const ocrText = ocrs.map((o) => (o.lines as string[]).join("\n")).join("\n");
      const c: Cand = {
        name: g.name, room: g.room, images: g.urls.length, order: gi + 1, isStar: g === starG, ocrText, ocr: ocrs.length > 0,
        rent: null, admin: null, rentSrc: null, plan: null, planSrc: null, age: null, ageSrc: null, walk: null, sqm: null, zeroMention: null, dictStar: false,
        floor: null, adMonths: null, poolRank: null, vacancy: null, equipText: ocrText, access: [],
      };
      if (ocrText) {
        const tr = parseListingTerms(ocrText, { today: m.created_at });
        if (tr.buildingAgeYears != null) { c.age = tr.buildingAgeYears; c.ageSrc = "ocr"; }
        const pl = normalizeFloorPlanToken(((ocrText.match(/間取り[:：]\s*([^\n]+)/) ?? [])[1] ?? "").replace(/ワンルーム/, "1R"));
        if (pl) { c.plan = pl; c.planSrc = "ocr"; }
        const st = (ocrText.match(/現況[:：]\s*([^\n]+)/) ?? [])[1] ?? "";
        c.vacancy = /退去予定|居住中|予定/.test(st) ? "leaving" : /空/.test(st) ? "vacant" : null;
        const eq = parseListingEquipment(ocrText);
        c.floor = eq.floor;
      }
      if (c.floor == null) c.floor = floorFromRoom(g.room);
      // 同じ会話の送付記録（画像の読み取りの家賃・AD）
      const sp = sentsConv.filter((s) => s.conversation_id === m.conversation_id && Math.abs(Date.parse(s.sent_at) - batchStart) < 3 * H && s.property_name && sameBuilding(s.property_name, g.name));
      const spRent = sp.find((s) => s.rent)?.rent ?? null;
      if (spRent) { c.rent = spRent; c.rentSrc = "sent"; }
      c.adMonths = sp.find((s) => s.ad_months != null)?.ad_months ?? null;
      // 候補プール（拡張の回）
      const pcHit = poolCands.find((x) => x.name && sameBuilding(String(x.name), g.name));
      if (pcHit) {
        c.poolRank = pcHit.rank ?? null;
        if (c.plan == null && pcHit.floor_plan) { c.plan = normalizeFloorPlanToken(String(pcHit.floor_plan)); c.planSrc = "pool"; }
        if (c.adMonths == null && pcHit.ad_months != null) c.adMonths = pcHit.ad_months;
        if (c.rent == null && pcHit.rent) { c.rent = pcHit.rent; c.rentSrc = "pool"; }
      }
      // 全お客様の候補プール・全会話の送付記録（号室が同じ物だけ）
      const gp = gPool.get(bkey(g.name));
      if (gp) {
        if (c.plan == null && gp.plans.size === 1) { c.plan = [...gp.plans][0]; c.planSrc = "pool-all"; }
        if (c.adMonths == null && gp.ads.length) c.adMonths = median(gp.ads);
      }
      if (c.rent == null && g.room) { const rs = gRent.get(`${bkey(g.name)}|${g.room}`); if (rs?.length) { c.rent = median(rs); c.rentSrc = "sent-all"; } }
      // 辞書（別の会話）
      const ds = dictLookup(g.name, g.room, m.conversation_id);
      for (const e of ds) {
        const v = e.v;
        if (e.src === "star") c.dictStar = true;
        if (e.src === "star") c.zeroMention = (c.zeroMention ?? false) || !!v.zero;
        if (e.src !== "ocr" && !DICT_STAR) continue;
        if (c.rent == null && v.total != null) { c.rent = v.total; c.admin = 0; c.rentSrc = `dict-${e.src}${g.room && e.room === g.room ? "" : "-bldg"}`; }
        if (c.walk == null && v.walk != null) c.walk = v.walk;
        if (c.age == null && v.age != null) { c.age = v.age; c.ageSrc = `dict-${e.src}`; }
        if (c.plan == null && v.plan) { c.plan = v.plan; c.planSrc = `dict-${e.src}`; }
        if (c.sqm == null && v.sqm != null) c.sqm = v.sqm;
        if (!c.ocrText && v.equipText && !c.equipText.includes(v.equipText)) c.equipText += `\n${v.equipText}`;
        if (v.access?.length) c.access.push(...v.access);
      }
      return c;
    });
    cnt.cands += cands.length;

    // 条件のプロフィール（送付済みは この回より前だけ・共有は除く）
    const before = (sentOf.get(pc) ?? []).filter((s) => Date.parse(s.sent_at) < batchStart - 10 * 60_000) as SentRowLike[];
    const prof = buildCustomerProfile(cust, before, patsBefore, null, { today: m.created_at });
    const wants = parseEquipmentWants(cust);
    const areaW = parseAreaWant(cust.desired_area, [cust.preferences, cust.other_requests].filter(Boolean).join("\n"));
    const commW = parseCommuteWants(cust);

    type J = { c: Cand; score: number; codes: string[]; eqm: EquipmentMatch | null; ratio: number | null; planM: number | null; locCodes: string[] };
    const judged: J[] = cands.map((c, i) => {
      const f: PropertyFacts = parsePropertyFacts(`【${i + 1}】${c.name}${c.room ? ` ${c.room}号室` : ""}`, {
        rank: i + 1, name: c.name, rent: c.rent, floor_plan: c.plan, walk_minutes: c.walk, ad_months: AD_OFF ? null : c.adMonths,
      });
      f.adminFeeYen = c.admin; f.buildingAge = c.age; f.areaSqm = c.sqm; f.roomNo = c.room || null;
      if (c.zeroMention && DICT_STAR) { f.depositMonths = 0; f.keyMoneyMonths = 0; }
      const eqFacts = c.equipText ? parseListingEquipment(c.equipText) : null;
      if (eqFacts && c.floor != null && eqFacts.floor == null) eqFacts.floor = c.floor;
      const eqm = eqFacts && wants.wants.length ? matchEquipment(wants, eqFacts) : null;
      const terms = c.ocrText ? parseListingTerms(c.ocrText, { today: m.created_at }) : null;
      let locCodes: string[] = [];
      if ((areaW.any || commW.length) && c.access.length) {
        const loc = buildPropertyLocation(`【1】${c.name}\n${c.access[0]}`, null);
        locCodes = locationReasonCodes(matchArea(areaW, loc), matchCommute(commW, loc));
      }
      const j = judgeProperty(f, prof, i, { today: m.created_at, equipment: eqm, terms, locationCodes: locCodes });
      const ratio = c.rent != null && prof.rentMax ? (c.rent + (c.admin ?? 0)) / prof.rentMax : null;
      const fm = c.plan ? matchFloorPlan(prof.floorPlanWant, c.plan) : null;
      const planM = prof.floorPlanWant.any ? null : fm === "match" ? 2 : fm === "near" ? 1 : fm === "mismatch" ? 0 : null;
      return { c, score: j.score, codes: j.reasonCodes, eqm, ratio, planM, locCodes };
    });
    const star = judged.find((x) => x.c.isStar)!;
    const others = judged.filter((x) => x !== star);
    const fmtJ = (x: J) => `   ${x.c.isStar ? "🌟" : "  "}${x.c.order}. ${x.score}点 ${x.c.plan ?? "?"} 家賃${x.c.rent ?? "?"}(${x.c.rentSrc ?? "-"}) 比${x.ratio?.toFixed(2) ?? "?"} 徒歩${x.c.walk ?? "?"} 築${x.c.age ?? "?"} ${x.c.sqm ?? "?"}㎡ 敷礼0語${x.c.zeroMention == null ? "?" : x.c.zeroMention ? "○" : "－"} ${x.c.floor ?? "?"}階 AD${x.c.adMonths ?? "?"} 写真${x.c.images} 設備${x.eqm ? `${x.eqm.ok}/${x.eqm.ng}` : "-"}\n      ${x.codes.filter((c) => !/UNKNOWN|UNLISTED/.test(c)).join(",")}`;

    // 材料の覆い率（🌟とほかで偏りが無いか）
    for (const x of judged) {
      if (x.c.isStar) starCands++; else otherCands++;
      { const r = (rentSrcCount[x.c.rentSrc ?? "なし"] ??= { star: 0, other: 0 }); r[x.c.isStar ? "star" : "other"]++; }
      cov("家賃", x.c.isStar, x.c.rent != null); cov("間取り", x.c.isStar, x.c.plan != null); cov("築年", x.c.isStar, x.c.age != null);
      cov("徒歩", x.c.isStar, x.c.walk != null); cov("㎡", x.c.isStar, x.c.sqm != null); cov("OCR", x.c.isStar, x.c.ocr);
      cov("AD", x.c.isStar, x.c.adMonths != null); cov("別の会話の🌟本文あり", x.c.isStar, x.c.dictStar); cov("階", x.c.isStar, x.c.floor != null);
    }
    // ③ 特徴の差（ペア）
    for (const o of others) {
      addPair("家賃÷上限（低いほど良い）", sid, star.ratio, o.ratio, false);
      addPair("家賃が上限内（管理費込み）", sid, star.ratio == null ? null : +(star.ratio <= 1), o.ratio == null ? null : +(o.ratio <= 1), true);
      if (prof.walkMax != null) addPair("徒歩÷希望（短いほど良い）", sid, star.c.walk != null ? star.c.walk / prof.walkMax : null, o.c.walk != null ? o.c.walk / prof.walkMax : null, false);
      addPair("徒歩（分・希望の有無を問わず）", sid, star.c.walk, o.c.walk, false);
      addPair("築年（新しいほど良い）", sid, star.c.age, o.c.age, false);
      if (prof.buildingAgeMax != null) addPair("築年が希望内", sid, star.c.age == null ? null : +(star.c.age <= prof.buildingAgeMax), o.c.age == null ? null : +(o.c.age <= prof.buildingAgeMax), true);
      addPair("間取りの一致（一致2・近い1・不一致0）", sid, star.planM, o.planM, true);
      addPair("間取りの大きさ（部屋数）", sid, rankFloorPlan(star.c.plan), rankFloorPlan(o.c.plan), true);
      addPair("㎡（広いほど良い）", sid, star.c.sqm, o.c.sqm, true);
      if (star.c.dictStar && o.c.dictStar) addPair("敷礼0の語（別の会話の🌟本文・両方に本文がある時）", sid, +!!star.c.zeroMention, +!!o.c.zeroMention, true);
      if (star.eqm && o.eqm && (star.eqm.rows.length)) addPair("設備の一致（ok−ng）", sid, star.eqm.ok - star.eqm.ng, o.eqm.ok - o.eqm.ng, true);
      addPair("階（高いほど良い）", sid, star.c.floor, o.c.floor, true);
      addPair("AD（ヶ月）", sid, star.c.adMonths, o.c.adMonths, true);
      addPair("写真の枚数", sid, star.c.images, o.c.images, true);
      addPair("送った順（早いほど良い）", sid, star.c.order, o.c.order, false);
      addPair("候補プールの順位（上ほど良い）", sid, star.c.poolRank, o.c.poolRank, false);
      addPair("空室（退去予定より）", sid, star.c.vacancy ? +(star.c.vacancy === "vacant") : null, o.c.vacancy ? +(o.c.vacancy === "vacant") : null, true);
      addPair("今の点（judgeProperty）", sid, star.score, o.score, true);
    }
    // 札の差（🌟に付いた率 − ほかに付いた率）
    const codeSet = new Set(judged.flatMap((x) => x.codes));
    for (const code of codeSet) {
      const r = (reasonDiff[code] ??= { star: 0, other: 0 });
      if (star.codes.includes(code)) r.star++;
      r.other += others.filter((o) => o.codes.includes(code)).length / others.length;
    }
    // ④ 今の点での順位
    const gt = others.filter((x) => x.score > star.score).length, eq = others.filter((x) => x.score === star.score).length, n = judged.length;
    const pos = 1 + gt + eq / 2;
    const poolRanked = judged.filter((x) => x.c.poolRank != null);
    const poolPos = star.c.poolRank != null && poolRanked.length >= 2 ? 1 + poolRanked.filter((x) => (x.c.poolRank as number) < (star.c.poolRank as number)).length : null;
    judgeRes.push({ sid, n, gt, pos, rel: (gt + eq / 2) / (n - 1), allTied: new Set(judged.map((x) => x.score)).size === 1, ocrAll: judged.every((x) => x.c.ocr), orderPos: star.c.order, poolPos });
    // ④' 家賃と間取りがそろった候補だけで順位（材料の欠け＝50点の並びを外す）
    {
      const core = judged.filter((x) => x.c.rent != null && x.c.plan != null);
      if (core.includes(star) && core.length >= 2) {
        const o2 = core.filter((x) => x !== star);
        const g2 = o2.filter((x) => x.score > star.score).length, e2 = o2.filter((x) => x.score === star.score).length;
        coreRes.push({ n: core.length, gt: g2, pos: 1 + g2 + e2 / 2, rel: (g2 + e2 / 2) / (core.length - 1), allTied: new Set(core.map((x) => x.score)).size === 1 });
        if (coreShows.length < SHOW && g2 > 0) coreShows.push(`■ ${label(pc)} ${m.created_at.slice(0, 10)} そろった候補${core.length}/${n} 🌟${1 + g2 + e2 / 2}位（条件: 上限${prof.rentMax ?? "-"} 間取り${prof.floorPlanWant.raw || "-"} 徒歩${prof.walkMax ?? "-"} 築${prof.buildingAgeMax ?? "-"} 初期費用${prof.wantsLowInitialCost ? "抑えたい" : "-"} 設備${wants.wants.map((w) => w.key).join("/") || "-"}）\n` + core.map((x) => fmtJ(x)).join("\n"));
      }
    }
    // ⑤ 条件の種類ごと
    const kinds: Array<[string, (x: J) => number | null, boolean]> = [];
    if (prof.wantsLowInitialCost) kinds.push(["初期費用を抑えたい × 敷礼0の語", (x) => (star.c.dictStar && x.c.dictStar ? +!!x.c.zeroMention : null), true]);
    else kinds.push(["初期費用の希望なし × 敷礼0の語", (x) => (star.c.dictStar && x.c.dictStar ? +!!x.c.zeroMention : null), true]);
    if (prof.walkMax != null) kinds.push([`徒歩の希望あり × 徒歩`, (x) => x.c.walk, false]); else kinds.push(["徒歩の希望なし × 徒歩", (x) => x.c.walk, false]);
    if (prof.buildingAgeMax != null || prof.ageTextMax) kinds.push(["築年・築浅の希望あり × 築年", (x) => x.c.age, false]); else kinds.push(["築年の希望なし × 築年", (x) => x.c.age, false]);
    if (!prof.floorPlanWant.any) kinds.push(["間取りの希望あり × 一致", (x) => x.planM, true]);
    if (prof.sqmMin != null) kinds.push(["広さの希望あり × ㎡", (x) => x.c.sqm, true]); else kinds.push(["広さの希望なし × ㎡", (x) => x.c.sqm, true]);
    if (wants.wants.length) kinds.push([`設備の希望あり × 設備の一致`, (x) => (x.eqm ? x.eqm.ok - x.eqm.ng : null), true]);
    if (prof.rentMax != null) kinds.push(["家賃の上限あり × 家賃÷上限", (x) => x.ratio, false]);
    for (const [k, f, hi] of kinds) {
      const s = tstat(k); s.sessions++;
      const sv = f(star);
      for (const o of others) { const ov = f(o); if (sv == null || ov == null) continue; if (sv === ov) s.pairEq++; else if ((sv > ov) === hi) s.pairBetter++; else s.pairWorse++; }
    }
    if (shows.length < SHOW && gt > 0) {
      shows.push(`■ ${label(pc)} ${m.created_at.slice(0, 10)} 候補${n} 🌟${pos}位（条件: 上限${prof.rentMax ?? "-"} 間取り${prof.floorPlanWant.raw || "-"} 徒歩${prof.walkMax ?? "-"} 築${prof.buildingAgeMax ?? "-"} 初期費用${prof.wantsLowInitialCost ? "抑えたい" : "-"} 設備${wants.wants.map((w) => w.key).join("/") || "-"}${restored.length ? ` ／時点に戻した列: ${restored.join(",")}` : ""}）\n` + judged.map(fmtJ).join("\n"));
    }
  }

  // ── 出力 ──
  const pairTable = Object.entries(pairs).map(([k, p]) => ({ 特徴: k, 回: p.sessions.size, ペア: p.better + p.equal + p.worse, "🌟が良い": p.better, 同じ: p.equal, "🌟が悪い": p.worse, 良い率: pct(p.better, p.better + p.worse), 同点率: pct(p.equal, p.better + p.equal + p.worse) }));
  const jr = judgeRes;
  const sum = (f: (x: typeof jr[number]) => number) => jr.reduce((a, x) => a + f(x), 0);
  const judgeSummary = (xs: typeof jr) => ({
    回: xs.length, 平均候補: xs.length ? +(xs.reduce((a, x) => a + x.n, 0) / xs.length).toFixed(1) : null,
    "1位（同点含む）": pct(xs.filter((x) => x.gt === 0).length, xs.length),
    "1位（同点は平均順位で1.5以内）": pct(xs.filter((x) => x.pos <= 1.5).length, xs.length),
    "3位以内": pct(xs.filter((x) => x.pos <= 3).length, xs.length),
    でたらめの3位以内: pct(xs.reduce((a, x) => a + Math.min(3, x.n) / x.n, 0), xs.length),
    でたらめの1位: pct(xs.reduce((a, x) => a + 1 / x.n, 0), xs.length),
    相対順位: xs.length ? +(xs.reduce((a, x) => a + x.rel, 0) / xs.length).toFixed(3) : null,
    全部同点の回: xs.filter((x) => x.allTied).length,
  });
  void sum;
  const order1 = jr.filter((x) => x.orderPos === 1).length;
  const poolXs = jr.filter((x) => x.poolPos != null);
  const out = {
    until: untilIso, days: DAYS, ad: AD_OFF ? "off" : "on",
    件数: { ...cnt, 候補の平均: cnt.sessions ? +(cnt.cands / cnt.sessions).toFixed(1) : null },
    材料の覆い率: Object.fromEntries(Object.entries(coverage).map(([k, v]) => [k, `🌟 ${pct(v.star, starCands)} ／ ほか ${pct(v.other, otherCands)}`])),
    今の点_全回: judgeSummary(jr),
    今の点_全候補にOCRがある回: judgeSummary(jr.filter((x) => x.ocrAll)),
    今の点_全部同点を除く: judgeSummary(jr.filter((x) => !x.allTied)),
    今の点_家賃と間取りがそろった候補だけ: judgeSummary(coreRes.map((x) => ({ ...x, sid: "", ocrAll: false, orderPos: 0, poolPos: null }))),
    判定の材料: DICT_STAR ? "on（🌟本文の辞書も判定に使う・偏りあり）" : "off（判定は全物件に届く材料だけ）",
    "比較_送った順で1番目が🌟": `${order1}/${jr.length}（${pct(order1, jr.length)}）`,
    比較_候補プールの順位: poolXs.length ? { 回: poolXs.length, "1位": pct(poolXs.filter((x) => x.poolPos === 1).length, poolXs.length) } : null,
    札の差: Object.entries(reasonDiff).map(([k, v]) => ({ 札: k, "🌟": pct(v.star, jr.length), ほか: pct(v.other, jr.length), 差: +(((v.star - v.other) / Math.max(1, jr.length)) * 100).toFixed(1) }))
      .filter((x) => Math.abs(x.差) >= 3).sort((a, b) => b.差 - a.差),
    条件の種類ごと_同じ回の比較: Object.entries(typeStats).map(([k, s]) => ({ 種類: k, 回: s.sessions, ペア: s.pairBetter + s.pairWorse + s.pairEq, "🌟が良い率": pct(s.pairBetter, s.pairBetter + s.pairWorse), 同点: s.pairEq })),
    "条件の種類ごと_🌟そのものの値": Object.entries(ownStats).map(([k, s]) => ({ 種類: k, "🌟": s.n, 値が読めた: s.known, 合う率: pct(s.sat, s.known) })),
  };
  console.log(JSON.stringify(out, null, 1));
  console.table(pairTable);
  console.log("家賃の出どころ", JSON.stringify(rentSrcCount));
  console.log("\n■ 物件オススメで送った物件の特定（🌟の本文の前3分〜後1分の画像）");
  console.log(JSON.stringify(identCount, null, 1));
  if (identShows.length) console.log(identShows.join("\n"));
  console.log("\n■ 条件の近さ × お客様の反応（48時間以内・次の🌟まで・最初の5通。反応は補助の材料で🌟の正誤ではない）");
  const kindsR = ["内見・申込の希望", "その物件への質問", "好意的な反応", "条件の追加・変更", "否定・別の物件を希望", "お礼・スタンプだけ", "その他", "反応なし"];
  console.table(Object.fromEntries(Object.entries(reactTable).map(([k, row]) => {
    const n = Object.values(row).reduce((a, b) => a + b, 0);
    return [k, { 件数: n, ...Object.fromEntries(kindsR.map((r) => [r, `${row[r] ?? 0}（${pct(row[r] ?? 0, n)}）`])) }];
  })));
  console.log("否定の理由（文に出た語）", JSON.stringify(negReasons), "／ 否定の回で🌟が外れていた基準", JSON.stringify(negVsOut));
  if (reactShows.length) console.log("\n■ 反応の例（伏せ字・短く）\n" + reactShows.join("\n"));
  if (overShows.length) console.log("\n■ 🌟そのものが上限の110%を超えた例\n" + overShows.join("\n"));
  { const s = [...ownRatios].sort((a, b) => a - b); const q = (p: number) => s[Math.floor(p * (s.length - 1))]?.toFixed(3);
    console.log(`🌟そのものの 家賃（管理費込み）÷上限: ${s.length}件 中央値 ${median(s)?.toFixed(3)} 四分位 ${q(0.25)}〜${q(0.75)} 90%点 ${q(0.9)}`); }
  if (coreShows.length) console.log("\n■ 家賃と間取りがそろった候補の中で🌟が1位でない回（お客様は伏せる）\n" + coreShows.join("\n\n"));
  if (shows.length) console.log("\n■ 🌟が今の点で1位でない回（お客様は伏せる）\n" + shows.join("\n\n"));
  if (args.out) writeFileSync(String(args.out), JSON.stringify({ out, pairTable, judgeRes }, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
