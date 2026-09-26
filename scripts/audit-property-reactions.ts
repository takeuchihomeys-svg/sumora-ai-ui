// 物件を送った後のお客様の反応（良い・NG・比較/要望・質問）を数える（読み取りのみ・LLM は呼ばない・本文はマスクして出す）
// 2026-09-26 竹内「反応があった物件のところ、物件ごとに良い反応や NG 反応があればわかりやすい。要望等を物件検索のブレイン（DeepSeek）に活かせれば理想」
//
// 測ること（直近 DAYS 日・グループと YUMA を除く）:
//   ① こちらの送付のかたまり（sent_image_properties / sent_properties の画像・AIX 物件ピックアップ/オススメ・物件 URL）の後 72h・3ターンまでのお客様のターン
//   ② 発言1通ごとに 良い(good)・NG(ng)・比較/要望(compare)・質問(question)・手続き(proc)・共有(share) を決定論で付ける
//   ③ どの物件への反応か（1件だけ・引用・物件名・順番の言葉・決められない・束への反応＝どの物件でもない）
//   ④ 要望（ng/compare の発言の条件の語）が条件欄・次の送付の文に出たか・parseEquipmentWants で読めるか
//   ⑤ NG の物件の再送・反応の直後の返信の下書き×実送信（書き直しで実送信だけに要望の語／物件名）
//   OUT=<file> でターンの一覧（マスク済み）と要望の一覧（<file>.wants.tsv）を書き出す（目で読む用）
//
// 2026-09-26 の結論（設計知見「お客様の物件への反応は『物件ごと』より『束への条件』が多い…」）:
//   送付後の反応ターン 452（148会話・約4か月）: good 251・ng 58・compare 143。目で読んだ精度は good 約85%・ng 約70%・compare 約80%。
//   物件に決まるのは good 51%・ng 33%。ng/compare の3〜4割は束全体への条件（家賃が高い・もう少し広め）でどの物件でもない。
//   NG の物件の再送は0件。要望の34%は『送った物件との比べ』（もう少し広く・遠い）で条件欄の書式に入らない。
//   反応直後の返信のそのまま送信 23.4%（全体 20.0%）＝反応が原因で悪いわけではない。書き直しで反応の中身（物件の取り違え・要望の復唱）が効くのは約8%。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-property-reactions.ts   （DAYS=180・OUT=）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { normalizeBuildingName, splitBuildingRoom } from "../app/lib/property-brain";
import { parseEquipmentWants } from "../app/lib/listing-equipment";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 180);
const OUT = process.env.OUT ?? "";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function page(table: string, cols: string, since: string | null, tcol = "created_at", extra?: (q: any) => any): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  for (let p = 0; p < 300; p++) {
    let q = sb.from(table).select(cols).order(tcol).range(p * 1000, p * 1000 + 999);
    if (since) q = q.gte(tcol, since);
    if (extra) q = extra(q);
    const { data, error } = await q; if (error) { console.error(table, error.message); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}
const mask = (s: string) => s
  .replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]")
  .replace(/https?:\/\/\S+/g, "[URL]")
  .replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1")
  .replace(/\s+/g, " ");
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");

const PROP_URL_RE = /https?:\/\/\S*(suumo|homes|athome|chintai|canary|door|smocca|goodrooms|able|apamanshop|minimini|eheya|ielove|realpro|itandi|bukkaku|es-b2b|reins)/i;
// ── お客様の反応の語彙 ──

// 要望の種類（反応の中の条件）
const WANT_TAGS: Array<[string, RegExp]> = [
  ["広さ", /広(い|め|さ|く)|狭|せま|帖|畳|平米|㎡|m2|収納|クローゼット/],
  ["駅近", /駅(近|ちか|から(近|遠)|まで)|徒歩|遠(い|すぎ|そう)|近(い|め|く)/],
  ["築年", /築|新し|新築|古(い|すぎ|そう|め)|綺麗|きれい|リフォーム|リノベ/],
  ["家賃", /家賃|賃料|予算|高(い|すぎ|め)|安(い|く|め)|万円|管理費|共益費/],
  ["初期費用", /初期費用|敷金|礼金|仲介手数料|フリーレント|初期/],
  ["階", /[0-9０-９一二三]階|階数|上の階|高層|低層|1階|一階|最上階/],
  ["向き・日当たり", /日当たり|南向|向き|明る|暗(い|そう)|陽当/],
  ["バス・トイレ", /バス|トイレ|風呂|浴室|ユニット|セパレート|追い焚|追焚/],
  ["洗面・洗濯", /洗面|洗濯|ランドリー|独立洗面/],
  ["キッチン", /キッチン|コンロ|IH|ガス|台所|自炊/],
  ["セキュリティ", /オートロック|セキュリティ|防犯|治安|女性/],
  ["エリア", /エリア|地域|区|線|沿線|場所|立地|周辺|環境|スーパー|コンビニ/],
  ["間取り", /1K|1DK|1LDK|2K|2DK|2LDK|ワンルーム|間取り|部屋数/i],
  ["ペット", /ペット|犬|猫/],
  ["騒音・周辺", /音|うるさ|静か|線路|大通り|騒/],
  ["入居時期", /入居|引っ越し|引越|退去|空き予定|いつから/],
  ["ネット・設備", /ネット|Wi-?Fi|wifi|エアコン|宅配|エレベーター|駐車場|駐輪|バルコニー|ベランダ|ロフト/i],
];
const ORD_RE = /([1-9１-９一二三四五])(枚目|件目|番目|つ目|個目|番の|番)|最初|一番上|上の|下の|最後|2つ目|前者|後者|上から|下から|左|右|後の方|先の/;

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; image_url: string | null; created_at: string; is_aix_generated: boolean | null; quoted_message_id: string | null; line_message_id: string | null; t: number };


const ATTR = "(広|狭|せま|収納|帖|畳|平米|㎡|駅|徒歩|遠|近|築|古|新し|新築|綺麗|きれい|家賃|賃料|予算|金額|値段|初期費用|礼金|敷金|費用|高|安|階|日当|向き|明る|暗|バス|トイレ|風呂|浴室|洗面|洗濯|キッチン|コンロ|オートロック|エリア|場所|立地|周辺|環境|治安|区|木造|鉄骨|RC|間取|1K|1DK|1LDK|2LDK|ワンルーム|音|うるさ|静か|ペット|駐車|バイク|ネット|写真|雰囲気|外観|内装|部屋)";
const P = "[^。！!？?\\n]";
const EXCL_RE = /審査|保証会社|保証人|名義|在籍|内定|給料|明細|書類|免許|パスポート|収入|ブラック|夜職|メール|契約書|振込|振り込|住民票|身分証|時間帯|何時|[0-9０-９]+時|明日|本日|今日|土曜|日曜|平日|午前|午後|シフト/;
const NG_ATTR_RE = new RegExp(ATTR + P + "{0,12}(高い|高すぎ|高め|高かっ|狭い|狭すぎ|狭そう|狭め|遠い|遠すぎ|遠そう|遠め|古い|古すぎ|古そう|少ない|少なめ|避けたい|厳し|微妙|悪い|NG|ng|無理|嫌|うるさ|暗い|怖)|(高い|狭い|遠い|古い)(んですね|ですね|な|かな|です|し)");
const NG_DECLINE_RE = new RegExp("(ここ|こちら|この(物件|お部屋|部屋)|そちら|そこ)(の物件)?(は|も)?" + P + "{0,6}(やめ|なし|ナシ|大丈夫です|パス|見送|保留|結構です|遠慮)|一旦なし|なしで(😭|す|お願い)|(やめ|辞め)(とき|ておき|ます)|見送り|保留に|他(を|の)?(探|当た)|違う物件|イメージと(違|ちが)|ピンとこ|ぴんとこ|好みじゃ|好きじゃ|好きでは|気に入(ら|りませ)|気に入(る|った)(物件|お部屋|もの)(が|は)(な|あり)|タイプじゃ|惹かれな|気が進ま");
const GOOD_NEG_RE = /気に入(ら|りませ|る(物件|お部屋|もの)が(な|あり)|った(物件|お部屋|もの)(が|は)(な|あり))|好きじゃ|好きでは/;
const GOOD_RE = /(内覧|内見)してみたい|見せて(もらえ|頂け|いただけ|ください|下さい)|抑えて(て)?(頂き|いただき|ほしい|欲しい)|押さえて(て)?(頂き|いただき|ほしい|欲しい)|初期費用(を)?(お伺い|教えて)|気に入|いいですね|良いですね|いいな(ぁ|あ|って|と)|良いな|素敵|良さそう|よさそう|いい感じ|良い感じ|惹かれ|気になり(ました|ます)|気になってる|気になる(お部屋|物件|部屋)|魅力|理想|ドンピシャ|最高|めっちゃいい|すごくいい|凄くいい|かなりいい|好きです|可愛い|かわいい|おしゃれ|オシャレ|第一候補|一番(いい|良い|気に)|ここ(が|に|で)(いい|良い|します|決め)|こちら(が|で|に)(いい|良い|します|決め)|申し分|(内覧|内見|見学)(したい|希望|させて|お願い|でき(ますか|ますでしょうか|れば)|可能|行きたい|いつ|を?(お願い|したい))|見に行(きたい|けますか)|見てみたい|見積(もり)?(書)?(を|も)?(ほしい|欲しい|お願い|頂け|いただけ|出して|もらえ|ください|下さい)|初期費用(を|も)?(知りたい|出して|出していただ|お願い)|申し?込(みたい|みます|もう|めます|み(を)?(したい|お願い))|押さえ(たい|て)|抑え(たい|て(ほしい|欲しい|頂け|いただけ|もらえ))/;
const COMPARE_RE = new RegExp("(もう少し|もうすこし|もっと|より)" + P + "{0,10}" + ATTR + "|" + ATTR + P + "{0,14}((方|ほう)が(いい|良い|嬉し|うれし|好き|助か|希望|ありがた)|がいい|が良い|がありがた|希望|欲しい|ほしい|だと(助か|嬉し|うれし|ありがた)|以外|優先|重視|こだわ|は譲れ|必須|絶対)|(みたいな|のような|ような)(お部屋|部屋|物件|感じ|とこ)|(他|ほか)(に|の|にも)" + P + "{0,6}(ある|あり|物件|お部屋|部屋)|(別の|違う)(物件|お部屋|部屋)|条件(を)?(変|追加|緩|広)|(比較|比べ)|(でも|も)(いい|良い|大丈夫|OK|可)(です)?(。|！|!|$|\\s)|変更(を)?お願い|(他|ほか)は(無|な)さ|(他|ほか)は(あり|ない)");
const QUESTION_RE = new RegExp(ATTR + "[^。！\\n]{0,30}([？?]|ですか|ますか|でしょうか|教えて|知りたい)|(空き|空いて|募集)[^。！\\n]{0,15}([？?]|ですか|ますか|でしょうか)|何階|何帖|何畳|何分|何年|いくら");
const ACK_RE = /^(ありがとう|有難う|有り難う|ありがと|了解|承知|かしこまり|確認します|見てみます|拝見|検討|わかりました|分かりました|はい|OK|おけ|👍|🙏|よろしく|宜しく)/;
const CUST_URL_RE = /https?:\/\/\S*(suumo|homes|athome|chintai|canary|door|smocca|goodrooms|able|apamanshop|minimini|eheya|ielove|realpro|itandi)/i;
function kindsOfMsg(t: string): string[] {
  const k: string[] = [];
  if (CUST_URL_RE.test(t)) k.push("share");
  const x = t.replace(/https?:\/\/\S+/g, "");
  const excl = EXCL_RE.test(x);
  if (GOOD_RE.test(x) && !GOOD_NEG_RE.test(x)) k.push("good");
  if (!excl && (NG_ATTR_RE.test(x) || NG_DECLINE_RE.test(x))) k.push("ng");
  else if (excl && NG_DECLINE_RE.test(x) && /(ここ|こちら|この(物件|お部屋|部屋))/.test(x)) k.push("ng");
  if (!excl && COMPARE_RE.test(x)) k.push("compare");
  if (!excl && QUESTION_RE.test(x)) k.push("question");
  if (excl && !k.length) k.push("proc");
  return k;
}
function kindsOfTurn(parts: string[]): string[] {
  const set = new Set<string>();
  for (const p of parts) for (const k of kindsOfMsg(p)) set.add(k);
  if (!set.size) set.add(ACK_RE.test((parts[0] ?? "").trim()) ? "ack" : "other");
  return [...set];
}

const med = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// 要望の種類（反応した発言だけに当てる）。cond: 条件欄の文に当てる式／col: 数値の列
const TAGS: Array<{ k: string; re: RegExp; cond: RegExp; col?: string[] }> = [
  { k: "広さ", re: /広(い|め|さ|く)|狭|せま|帖|畳|平米|㎡|収納|クローゼット|WIC/, cond: /広|帖|畳|平米|㎡|収納|クローゼット|WIC/, col: ["floor_area_min"] },
  { k: "駅近", re: /駅(近|ちか|から(近|遠)|まで)|徒歩|遠(い|すぎ|そう)/, cond: /駅(近|ちか)|徒歩/, col: ["walk_minutes"] },
  { k: "築年", re: /築|新し|新築|古(い|すぎ|そう|め)|綺麗|きれい|リノベ/, cond: /築|新し|新築|綺麗|きれい|リノベ/, col: ["building_age"] },
  { k: "家賃", re: /家賃|賃料|予算|管理費|[0-9０-９.]+万/, cond: /家賃|賃料|予算/, col: ["rent_max"] },
  { k: "初期費用", re: /初期費用|敷金|礼金|仲介手数料|フリーレント/, cond: /初期費用|敷金|礼金|敷礼|フリーレント/, col: ["initial_cost_limit"] },
  { k: "階", re: /[0-9０-９一二三四五]階|階数|高層|低層|最上階|エレベーター/, cond: /階|エレベーター/ },
  { k: "向き・日当たり", re: /日当たり|南向|向き|明る|暗(い|そう)|陽当/, cond: /日当たり|南向|向き|明る|陽当/ },
  { k: "バス・トイレ・洗面", re: /バス|トイレ|風呂|浴室|ユニット|セパレート|追い焚|追焚|洗面|洗濯/, cond: /バス|トイレ|風呂|浴室|ユニット|セパレート|追い焚|追焚|洗面|洗濯/ },
  { k: "キッチン", re: /キッチン|コンロ|IH|ガス|台所/, cond: /キッチン|コンロ|IH|ガス/ },
  { k: "構造・音", re: /木造|鉄骨|鉄筋|RC|音|うるさ|静か|騒/, cond: /木造|鉄骨|鉄筋|RC|SRC|音|静か/ },
  { k: "エリア・周辺", re: /エリア|区|線|沿線|場所|立地|周辺|環境|スーパー|治安|付近|あたり|辺り|らへん|駅(でも|周辺|付近)/, cond: /./, col: ["desired_area", "area"] },
  { k: "間取り", re: /1K|1DK|1LDK|2K|2DK|2LDK|ワンルーム|間取り/i, cond: /1K|1DK|1LDK|2K|2DK|2LDK|ワンルーム/i, col: ["floor_plan", "layout"] },
  { k: "設備（その他）", re: /オートロック|宅配|ネット|Wi-?Fi|駐車場|駐輪|バイク|ペット|ベランダ|バルコニー|ロフト|エアコン/i, cond: /オートロック|宅配|ネット|Wi-?Fi|駐車|駐輪|バイク|ペット|ベランダ|バルコニー|ロフト|エアコン/i },
];
const DEIXIS_RE = /ここ|こちら|この(物件|お部屋|部屋|マンション)|これ|そこ|そちら|その(物件|お部屋|部屋)|[0-9０-９一二三]つ目|[0-9０-９]枚目|[0-9０-９]件目|[0-9０-９]{3}号室|[ァ-ヴー]{3,}|[A-Za-z]{4,}/;
const WHICH_Q_RE = /どちら|どの(物件|お部屋|部屋)|何枚目|何番目|どれ/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function extra(turns: any[], convBlocks: Map<string, Array<{ t: number; props: string[]; texts: string }>>, pcById: Map<string, any>, convOk: Map<string, string | null>) {
  // ── 1ターンの中の「反応した発言」だけ
  for (const tu of turns) {
    const rp = (tu.parts as string[]).filter((p) => kindsOfMsg(p).some((k) => ["good", "ng", "compare"].includes(k)));
    const wp = (tu.parts as string[]).filter((p) => kindsOfMsg(p).some((k) => ["ng", "compare"].includes(k)));
    tu.reactText = rp.join(" / ");
    tu.wantText = wp.join(" / ");
    tu.wtags = TAGS.filter((t) => t.re.test(tu.wantText)).map((t) => t.k);
    tu.deixis = DEIXIS_RE.test(tu.reactText);
  }
  const R = turns.filter((t) => t.reactText);
  console.log(`\n■ 反応（good/ng/compare のどれか）のターン ${R.length}・会話 ${new Set(R.map((t) => t.conv)).size}`);
  const cls = (t: { kinds: string[] }) => t.kinds.includes("ng") ? "ng" : t.kinds.includes("compare") ? "compare" : "good";
  const cc: Record<string, number> = {}; for (const t of R) cc[cls(t)] = (cc[cls(t)] ?? 0) + 1; console.log("  主な種類", cc);
  // ── 物件の決まり方: 物件を指す反応（good/ng）と、束への反応（compare の条件）
  const tab: Record<string, Record<string, number>> = {};
  for (const t of R) {
    const c = cls(t);
    const multi = t.props.length >= 2;
    let how = t.resolved;
    if (how === "決められない" && !t.deixis) how = "束への反応（どの物件でもない）";
    if (how === "物件不明(画像未読)" && !t.deixis) how = "束への反応（どの物件でもない）";
    if (how === "1件だけ" && !t.deixis && c === "compare") how = "1件だけ（条件の話）";
    t.how = how;
    (tab[c] ??= {})[how] = ((tab[c] ??= {})[how] ?? 0) + 1;
    void multi;
  }
  for (const [c, m] of Object.entries(tab)) { const n = Object.values(m).reduce((a, b) => a + b, 0); console.log(`  ${c} ${n}:`, Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}(${pct(v, n)})`).join("・")); }
  // 決められない（物件を指しているのに複数送付で決まらない）時のスタッフ
  const amb = R.filter((t) => t.how === "決められない" || t.how === "物件不明(画像未読)");
  const sh: Record<string, number> = {};
  for (const t of amb) {
    const after = String(t.staffAfter ?? "");
    const names = (t.props as string[]).map((p) => p.split("|")[0]).filter((b) => b.length >= 3);
    const k = WHICH_Q_RE.test(after) ? "聞き返した" : names.some((b) => after.replace(/\s/g, "").toLowerCase().includes(b.slice(0, 4))) ? "物件名を書いて答えた" : after ? "物件名なしで答えた" : "返事なし（6通以内）";
    sh[k] = (sh[k] ?? 0) + 1;
  }
  console.log(`  物件を指しているのに決まらない ${amb.length} のスタッフの動き`, sh);
  for (const t of amb.slice(0, 0)) console.log(t);

  // ── 要望 → 条件への反映
  const W = turns.filter((t) => t.wantText && t.wtags.length);
  console.log(`\n■ 要望（ng/compare の発言に条件の語）のターン ${W.length}・会話 ${new Set(W.map((t) => t.conv)).size}`);
  const perTag: Record<string, { n: number; cond: number; next: number; nextN: number; eq: number; hours: number[] }> = {};
  let anyReflected = 0, headOnly = 0;
  for (const t of W) {
    const pc = pcById.get(convOk.get(t.conv) ?? "");
    const condText = pc ? [pc.preferences, pc.ng_points, pc.other_requests, pc.additional_conditions, pc.floor_plan, pc.layout, pc.structure_types].map((x) => String(x ?? "")).join(" ") : "";
    const later = (convBlocks.get(t.conv) ?? []).filter((b) => b.t > t.t1 && b.t - t.t1 < 14 * 86400e3);
    const nb = later[0];
    const eq = parseEquipmentWants({ preferences: t.wantText });
    t.eqWants = eq.wants.map((w) => `${w.key}:${w.mode}`);
    t.eqElse = eq.handledElsewhere.length; t.eqUnc = eq.uncovered.length;
    let refl = false;
    for (const k of t.wtags) {
      const def = TAGS.find((x) => x.k === k)!;
      const p = (perTag[k] ??= { n: 0, cond: 0, next: 0, nextN: 0, eq: 0, hours: [] });
      p.n++;
      const inCond = !!pc && ((def.col ?? []).some((c) => pc[c] != null && String(pc[c]).trim() !== "") || (k !== "エリア・周辺" && def.cond.test(condText)));
      if (inCond) p.cond++;
      if (nb) { p.nextN++; p.hours.push((nb.t - t.t1) / 3600e3); if (def.cond.test(nb.texts) && k !== "エリア・周辺") { p.next++; refl = true; } }
      if (eq.wants.length) p.eq++;
    }
    if (refl) anyReflected++;
    t.nextSendH = nb ? (nb.t - t.t1) / 3600e3 : null;
    t.condHas = pc ? t.wtags.filter((k: string) => { const def = TAGS.find((x) => x.k === k)!; return (def.col ?? []).some((c) => pc[c] != null && String(pc[c]).trim() !== "") || (k !== "エリア・周辺" && def.cond.test(condText)); }) : [];
    if (pc && t.condHas.length === 0) headOnly++;
  }
  console.log(`  種類ごと（件・条件欄に同じ種類の語/列がある・14日以内に次の送付あり・次の送付の文にその語・設備の読み取りで何か読めた）`);
  for (const [k, p] of Object.entries(perTag).sort((a, b) => b[1].n - a[1].n)) console.log(`   ${k}: ${p.n}・条件欄 ${pct(p.cond, p.n)}・次の送付 ${p.nextN}（中央 ${med(p.hours).toFixed(0)}h）・次の文に語 ${pct(p.next, p.nextN)}・設備読取 ${pct(p.eq, p.n)}`);
  console.log(`  条件欄に1つも無い（スタッフの頭の中だけ）${headOnly}/${W.length}・次の送付の文に語が出た ${anyReflected}`);
  const eqAny = W.filter((t) => t.eqWants.length).length;
  console.log(`  parseEquipmentWants で要望文から設備の希望が読めた ${eqAny}/${W.length}（${pct(eqAny, W.length)}）`);
  const eqc: Record<string, number> = {}; for (const t of W) for (const w of t.eqWants) eqc[w] = (eqc[w] ?? 0) + 1; console.log("   読めた希望", eqc);

  // ── NG の物件をまた送った
  const ngResolved = R.filter((t) => t.kinds.includes("ng") && ["1件だけ", "引用", "物件名", "順番の言葉"].includes(t.how));
  let resent = 0; const resentEx: string[] = [];
  for (const t of ngResolved) {
    const target: string[] = t.props.length === 1 ? t.props : [];
    if (!target.length) continue;
    const later = (convBlocks.get(t.conv) ?? []).filter((b) => b.t > t.t1);
    if (later.some((b) => b.props.some((p) => target.includes(p)))) { resent++; resentEx.push(`${t.conv.slice(0, 8)} ${mask(t.reactText).slice(0, 80)}`); }
  }
  console.log(`\n■ NG の物件（1件に決まる ${ngResolved.filter((t) => t.props.length === 1).length}）を後でまた送った ${resent}`, resentEx.slice(0, 5));
  // 同じ建物（別の部屋）
  // ── 要望の後の送付の性質（設備の要望 → 次の送付の文に同じ設備）
  // ── 書き直し: 反応の直後の返信の下書き × 実送信
  const since = new Date(Date.now() - 180 * 86400e3).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ex: any[] = [];
  for (let p = 0; p < 50; p++) {
    const { data, error } = await sb.from("ai_reply_examples").select("conversation_id, sent_reply, ai_draft, ai_similarity, entry_source, sent_at, created_at").gte("created_at", since).not("ai_draft", "is", null).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    ex.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  const pairs = ex.filter((r) => r.entry_source === "line_reply" && String(r.ai_draft ?? "").trim() && String(r.sent_reply ?? "").trim());
  const byConv = new Map<string, typeof pairs>();
  for (const r of pairs) { const a = byConv.get(r.conversation_id) ?? []; a.push(r); byConv.set(r.conversation_id, a); }
  const exact = (r: { ai_draft: string; sent_reply: string }) => String(r.ai_draft).replace(/\s/g, "") === String(r.sent_reply).replace(/\s/g, "");
  const allAsIs = pairs.filter(exact).length;
  let n = 0, asIs = 0, missTag = 0, missProp = 0; const missEx: string[] = [];
  const bucket: Record<string, { n: number; asIs: number }> = {};
  for (const t of R) {
    const rows = (byConv.get(t.conv) ?? []).filter((r) => { const s = Date.parse(r.sent_at ?? r.created_at); return s > t.t1 && s - t.t1 < 6 * 3600e3; });
    const r = rows[0]; if (!r) continue;
    n++; const e = exact(r); if (e) asIs++;
    const b = (bucket[cls(t)] ??= { n: 0, asIs: 0 }); b.n++; if (e) b.asIs++;
    if (!e) {
      const d = String(r.ai_draft), s = String(r.sent_reply);
      const tagMiss = (t.wtags as string[]).some((k) => { const def = TAGS.find((x) => x.k === k)!; return k !== "エリア・周辺" && def.cond.test(s) && !def.cond.test(d); });
      const names = (t.props as string[]).map((p) => p.split("|")[0]).filter((x) => x.length >= 3);
      const nd = d.replace(/\s/g, "").toLowerCase(), ns = s.replace(/\s/g, "").toLowerCase();
      const propMiss = names.some((b) => ns.includes(b.slice(0, 4)) && !nd.includes(b.slice(0, 4)));
      if (tagMiss) missTag++;
      if (propMiss) missProp++;
      if ((tagMiss || propMiss) && missEx.length < 14) missEx.push(`${t.conv.slice(0, 8)} [${cls(t)}] 客:${mask(t.reactText).slice(0, 90)}\n     ▼AI:${mask(d).slice(0, 150)}\n     ▲実:${mask(s).slice(0, 150)}`);
    }
  }
  console.log(`\n■ 反応の直後6h の返信（下書きあり）${n}・そのまま送信 ${pct(asIs, n)}（全体 ${pct(allAsIs, pairs.length)}・${pairs.length}組）`, bucket);
  console.log(`  書き直しのうち 実送信だけに要望の語 ${missTag}・実送信だけに物件名 ${missProp}`);
  for (const e of missEx) console.log("   " + e);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extra2(turns: any[], convBlocks: Map<string, Array<{ t: number; props: string[]; texts: string }>>, pcById: Map<string, any>, convOk: Map<string, string | null>, out: string) {
  const all = [...convBlocks.values()].flat();
  const base: Record<string, string> = {};
  for (const t of TAGS) base[t.k] = pct(all.filter((b) => t.cond.test(b.texts)).length, all.length);
  console.log("\n■ 基準: 全送付のかたまりの文にその語が出る率", base);
  const W = turns.filter((t) => t.wantText && t.wtags.length);
  const DIR_RE = /(もう少し|もうすこし|もっと|より)[^。！!？?\n]{0,10}(広|狭|近|新し|安|高|大き|明る|静か|上)|(狭|遠|古|高)(い|すぎ|そう|め|かっ)|少な(い|め)|小さ(い|め)/;
  let dir = 0, eqNotInCond = 0, eqTotal = 0;
  const lines: string[] = [];
  for (const t of W) {
    const pc = pcById.get(convOk.get(t.conv) ?? "");
    const condW = pc ? parseEquipmentWants(pc).wants.map((w) => `${w.key}:${w.mode}`) : [];
    const newEq = (t.eqWants as string[]).filter((w) => !condW.includes(w));
    if ((t.eqWants as string[]).length) { eqTotal++; if (newEq.length) eqNotInCond++; }
    const d = DIR_RE.test(t.wantText); if (d) dir++;
    lines.push(`${t.conv.slice(0, 8)}\t${t.how}\t{${t.wtags.join(",")}}\teq=[${t.eqWants.join(",")}] new=[${newEq.join(",")}]\tdir=${d}\tnext=${t.nextSendH == null ? "-" : t.nextSendH.toFixed(0) + "h"}\t${mask(t.wantText).slice(0, 220)}`);
  }
  console.log(`  向きのある要望（もう少し広く・狭い・遠い・高い 等＝送った物件との比べ）${dir}/${W.length}`);
  console.log(`  設備の希望が読めた ${eqTotal} のうち、今の条件欄の設備の希望に無い物を含む ${eqNotInCond}`);
  if (out) writeFileSync(out, lines.join("\n"));
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const convs = await page("conversations", "id, line_source_type, property_customer_id, created_at", null);
  const convOk = new Map<string, string | null>();
  for (const c of convs) if (c.id !== YUMA && c.line_source_type !== "group") convOk.set(c.id, c.property_customer_id);
  const msgs: Msg[] = (await page("messages", "id, conversation_id, sender, text, image_url, created_at, is_aix_generated, quoted_message_id, line_message_id", since))
    .filter((m: Msg) => convOk.has(m.conversation_id)).map((m: Msg) => ({ ...m, t: Date.parse(m.created_at) }));
  // 画像 → 物件
  const imgProp = new Map<string, string>();
  for (const r of await page("sent_image_properties", "image_url, property_name, room_no, created_at", since)) {
    if (!r.image_url || !r.property_name) continue;
    const s = splitBuildingRoom(r.property_name);
    const key = `${normalizeBuildingName(s.building)}|${(r.room_no ?? s.room ?? "").toString().replace(/^0+/, "")}`;
    if (!imgProp.has(r.image_url)) imgProp.set(r.image_url, key);
  }
  const sp = await page("sent_properties", "image_url, property_name, room_no, conversation_id, sent_at, delivery, source", since, "sent_at");
  for (const r of sp) {
    if (!r.image_url || !r.property_name || imgProp.has(r.image_url)) continue;
    const s = splitBuildingRoom(r.property_name);
    imgProp.set(r.image_url, `${normalizeBuildingName(s.building)}|${(r.room_no ?? s.room ?? "").toString().replace(/^0+/, "")}`);
  }
  const aix = await page("aix_usage_logs", "conversation_id, aix_type, created_at, sent_at, generated_text", since);
  const pcs = await page("property_customers", "id, preferences, ng_points, other_requests, additional_conditions, floor_plan, layout, walk_minutes, building_age, rent_max, floor_area_min, initial_cost_limit, desired_area, area, updated_at, structure_types", null);
  const pcById = new Map(pcs.map((p) => [p.id, p]));

  const convBlocks = new Map<string, Array<{ t: number; props: string[]; texts: string }>>();
  const byConv = new Map<string, Msg[]>();
  for (const m of msgs) { const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  const byLineId = new Map<string, Msg>();
  for (const m of msgs) if (m.line_message_id) byLineId.set(m.line_message_id, m);
  const aixByConv = new Map<string, Array<{ type: string; t: number; text: string }>>();
  for (const a of aix) if (convOk.has(a.conversation_id)) { const l = aixByConv.get(a.conversation_id) ?? []; l.push({ type: a.aix_type, t: Date.parse(a.sent_at ?? a.created_at), text: a.generated_text ?? "" }); aixByConv.set(a.conversation_id, l); }

  type Turn = { parts: string[]; conv: string; t0: number; t1: number; text: string; quoted: Msg[]; msgIds: string[]; nth: number; props: string[]; sendAix: string[]; sendUnmappedImgs: number; sendT: number; kinds: string[]; tags: string[]; resolved: string; staffAfter: string; nextStaffT: number | null };
  const turns: Turn[] = [];
  let sendBlocks = 0; const blockSizes: Record<string, number> = {};
  for (const [conv, ms] of byConv) {
    let i = 0;
    let lastBlock: { props: string[]; aix: string[]; unm: number; t: number } | null = null;
    let nth = 0;
    while (i < ms.length) {
      if (ms[i].sender !== "customer") {
        // スタッフのかたまり
        const blk: Msg[] = [];
        while (i < ms.length && ms[i].sender !== "customer") blk.push(ms[i++]);
        const props = new Set<string>(); let unm = 0; const ax: string[] = [];
        let hasSend = false;
        for (const m of blk) {
          if (m.image_url) { const k = imgProp.get(m.image_url); if (k) { props.add(k); hasSend = true; } else if (m.is_aix_generated) { unm++; } }
          if (m.text && PROP_URL_RE.test(m.text)) { hasSend = true; unm++; }
        }
        const t0 = blk[0].t - 60e3, t1 = blk[blk.length - 1].t + 60e3;
        for (const a of aixByConv.get(conv) ?? []) if (a.t >= t0 && a.t <= t1 && ["property_send", "property_recommendation"].includes(a.type)) { ax.push(a.type); hasSend = true; }
        if (hasSend) {
          sendBlocks++;
          const n = props.size; blockSizes[n >= 4 ? "4+" : String(n)] = (blockSizes[n >= 4 ? "4+" : String(n)] ?? 0) + 1;
          lastBlock = { props: [...props], aix: ax, unm, t: blk[blk.length - 1].t }; nth = 0; { const cb = convBlocks.get(conv) ?? []; cb.push({ t: lastBlock.t, props: lastBlock.props, texts: blk.map((m) => m.text ?? "").join(" ") + " " + (aixByConv.get(conv) ?? []).filter((a) => a.t >= t0 && a.t <= t1).map((a) => a.text).join(" ") }); convBlocks.set(conv, cb); }
        }
        continue;
      }
      const tm: Msg[] = [];
      while (i < ms.length && ms[i].sender === "customer") tm.push(ms[i++]);
      const text = tm.map((m) => m.text ?? (m.image_url ? "[画像]" : "")).join(" / ");
      const nextStaff = ms.slice(i, i + 6).filter((m) => m.sender !== "customer");
      if (lastBlock && tm[0].t - lastBlock.t < 72 * 3600e3 && nth < 3 && tm.some((m) => m.text)) {
        nth++;
        const quoted = tm.map((m) => (m.quoted_message_id ? byLineId.get(m.quoted_message_id) : undefined)).filter(Boolean) as Msg[];
        turns.push({ parts: tm.map((m) => m.text ?? "").filter(Boolean), conv, t0: tm[0].t, t1: tm[tm.length - 1].t, text, quoted, msgIds: tm.map((m) => m.id), nth, props: lastBlock.props, sendAix: lastBlock.aix, sendUnmappedImgs: lastBlock.unm, sendT: lastBlock.t, kinds: [], tags: [], resolved: "", staffAfter: nextStaff.map((m) => m.text ?? "[画像]").join(" / ").slice(0, 300), nextStaffT: nextStaff[0]?.t ?? null });
      } else if (lastBlock && tm[0].t - lastBlock.t >= 72 * 3600e3) { /* 窓の外 */ }
    }
  }
  // 分類
  for (const tu of turns) {
    const text = tu.text.replace(/\[画像\]/g, "");
    tu.kinds = kindsOfTurn(tu.parts);
    tu.tags = WANT_TAGS.filter(([, re]) => re.test(text)).map(([k]) => k);
    // どの物件か
    const qp = tu.quoted.map((q) => (q.image_url ? imgProp.get(q.image_url) : null)).filter(Boolean) as string[];
    const nameHit = tu.props.filter((p) => { const b = p.split("|")[0]; if (b.length < 3) return false; const nt = normalizeBuildingName(text); return nt.includes(b.slice(0, Math.min(4, b.length))); });
    if (qp.length) tu.resolved = "引用";
    else if (tu.props.length === 1) tu.resolved = "1件だけ";
    else if (nameHit.length === 1) tu.resolved = "物件名";
    else if (tu.props.length === 0) tu.resolved = "物件不明(画像未読)";
    else if (ORD_RE.test(text)) tu.resolved = "順番の言葉";
    else tu.resolved = "決められない";
  }
  const reacts = turns.filter((t) => t.kinds.some((k) => ["good", "ng", "compare", "question"].includes(k)));
  console.log(`送付のかたまり ${sendBlocks}・物件数の内訳`, blockSizes);
  console.log(`送付後72h・3ターンまでのお客様ターン ${turns.length}（1ターン目 ${turns.filter((t) => t.nth === 1).length}）`);
  const kc: Record<string, number> = {};
  for (const t of turns) for (const k of t.kinds) kc[k] = (kc[k] ?? 0) + 1;
  console.log("種類（重なりあり）", kc);
  const primary = (t: Turn) => t.kinds.includes("ng") ? "ng" : t.kinds.includes("compare") ? "compare" : t.kinds.includes("good") ? "good" : t.kinds.includes("share") ? "share" : t.kinds.includes("question") ? "question" : t.kinds[0];
  const pc: Record<string, number> = {}; for (const t of turns) pc[primary(t)] = (pc[primary(t)] ?? 0) + 1; console.log("主な種類（ng>compare>good>question）", pc);
  const rc: Record<string, number> = {}; for (const t of reacts) rc[t.resolved] = (rc[t.resolved] ?? 0) + 1; console.log("反応（ack/other 除く）の物件の決まり方", reacts.length, rc);
  const tc: Record<string, number> = {}; for (const t of reacts) for (const g of t.tags) tc[g] = (tc[g] ?? 0) + 1; console.log("要望タグ", tc);
  console.log("会話数", new Set(turns.map((t) => t.conv)).size, "反応の会話数", new Set(reacts.map((t) => t.conv)).size);
  await extra(turns, convBlocks, pcById, convOk);
  extra2(turns, convBlocks, pcById, convOk, OUT ? OUT + ".wants.tsv" : "");
  if (OUT) {
    const lines: string[] = [];
    for (const t of turns) lines.push(`${t.conv.slice(0, 8)}\t${new Date(t.t0).toISOString().slice(0, 16)}\tn${t.nth}\t${primary(t)}\t[${t.kinds.join(",")}]\t${t.resolved}\tprops=${t.props.length}\t{${t.tags.join(",")}}\t${mask(t.text).slice(0, 260)}\t=> ${mask(t.staffAfter).slice(0, 200)}`);
    writeFileSync(OUT, lines.join("\n"));
  }
  void pcById; void parseEquipmentWants;
}
main();
