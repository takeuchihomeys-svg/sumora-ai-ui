// app/lib/ja-kanji.ts（純関数・依存なし・画面とサーバで共用）
// 読み取りの出力（画像の書き写し・物件名・条件の行）に混ざった中国の字形（簡体字・繁体字）を、日本の字形（新字体）に直す。
//
// 2026-10-14 竹内さん（P0 89bc2c3e「漢字は必ず日本語の漢字」）「漢字は日本語なのでそこも含めて理解すればかなり正確になる。
//   中国の漢字に引っ張られないように徹底」。読み取りは DeepSeek（中国の会社のモデル）なので、日本の漢字を中国の字形で書き写す恐れがある。
//
// 実データ（2026-10-14・保存済みの読み取りの全件・scripts/audit-reading-kanji.ts）:
//   image_details 4,893行中 17行（「1住戶」「浴室內」「1住户」）・property_sheet_facts 623行中 167行（文字層の「総戶数」＝ PDF の字のまま）・
//   sent_image_properties の駅「大國町」4件・物件名「La CASA駹川中野」（駒川）「スプランディッド雜波キャトル」（難波）。
//   日本の物件名・人名に普通にある旧字（淺沼・龍・澤・濱・萬・條（四條畷）・眞・髙・﨑）は資料の文字層にもそのまま出る＝直さない。
//
// 直し方（決定論の安全の線）:
//   ① 日本の漢字の範囲（JIS X 0208＝Shift_JIS）に無い中国の字形 → 日本の字形（下の SIMPLIFIED。左はどれも Shift_JIS に無い）
//   ② JIS に入っているが日本の資料では使わない繁体字・旧字 → 新字体（下の TRADITIONAL：區→区・驛→駅・樣→様・广→広 等）
//   ③ CJK 互換漢字・部首の字（⼈⾞・塚）→ NFKC で普通の漢字
//   ④ 地名の旧字（大國町→大国町）は地名の表と照らせる時だけ（place-name-fix.ts）。ここでは直さない（國分・國井 のような名前を壊さない）
// 戻す: JA_KANJI_NORMALIZE=off（読み取りの出力をそのまま使う）

/** 中国の字形（Shift_JIS に無い）→ 日本の字形 */
const SIMPLIFIED =
  "戶戸户戸內内驿駅乐楽样様滨浜话話费費东東车車门門间間问問闭閉开開关関闲閑阅閲长長张張场場汤湯杨楊阳陽扬揚肠腸书書买買卖売实実" +
  "马馬驾駕验験骑騎鸟鳥岛島鸡鶏鱼魚鲜鮮龙竜见見规規视視览覧观観现現觉覚亲親贝貝负負财財货貨贵貴资資质質购購贷貸贴貼账帳赁賃贩販" +
  "贸貿赔賠页頁顶頂项項顺順须須预預领領题題额額颜顔类類显顕风風飞飛轨軌转転轮輪软軟轻軽较較载載辆両输輸辅輔计計订訂认認让譲议議" +
  "记記讲講许許设設访訪证証评評识識诉訴词詞译訳试試该該详詳语語说説请請读読课課谁誰调調谈談谢謝约約级級纪紀纸紙线線练練组組细細" +
  "织織终終经経结結给給绝絶统統继継续続维維绿緑编編缘縁针針钉釘钢鋼钱銭铁鉄铜銅银銀铺舗锁鎖镜鏡饭飯饮飲馆館爱愛办弁备備边辺变変" +
  "补補层層产産尘塵迟遅处処础礎传伝达達带帯单単敌敵递逓电電动動冻凍对対队隊夺奪恶悪尔爾发発丰豊奋奮凤鳳妇婦复復冈岡刚剛沟溝构構" +
  "顾顧观観归帰龟亀过過汉漢护護华華怀懐欢歓环環还還换換获獲击撃积積极極际際济済夹挟坚堅简簡舰艦剑剣鉴鑑奖奨酱醤胶膠阶階节節洁潔" +
  "紧緊进進惊驚竞競举挙剧劇军軍壳殻垦墾恳懇块塊兰蘭栏欄烂爛劳労垒塁历歴丽麗炼錬两両疗療辽遼猎猟临臨邻隣灵霊龄齢岭嶺录録虑慮论論" +
  "罗羅络絡庙廟灭滅亩畝难難恼悩脑脳拟擬宁寧农農浓濃盘盤喷噴谱譜齐斉启啓迁遷桥橋倾傾庆慶穷窮驱駆权権劝勧确確热熱荣栄锐鋭润潤伞傘" +
  "丧喪扫掃涩渋杀殺伤傷赏賞烧焼绍紹摄摂绅紳审審绳縄胜勝圣聖师師诗詩时時势勢适適释釈兽獣树樹丝糸饲飼颂頌苏蘇肃粛岁歳孙孫损損缩縮" +
  "态態叹嘆讨討誊謄厅庁头頭图図团団违違围囲为為伟偉卫衛稳穏卧臥乌烏务務雾霧牺犠习習戏戯纤繊险険宪憲县県乡郷响響晓暁协協胁脅兴興" +
  "选選悬懸寻尋训訓压圧亚亜严厳盐塩养養药薬业業仪儀遗遺亿億忆憶义義艺芸阴陰隐隠樱桜应応营営拥擁优優忧憂邮郵狱獄园園员員圆円远遠" +
  "跃躍杂雑灾災赞賛脏臓责責择択泽沢赠贈斋斎债債战戦帐帳侦偵诊診镇鎮阵陣郑鄭职職执執钟鐘种種肿腫众衆诸諸贮貯铸鋳专専浊濁总総纵縦";
/**
 * JIS に入っているが、日本の不動産資料では使わない繁体字・旧字・中国の字（保存済みの読み取りの全件で、資料の文字層にも物件名にも1件も無い）。
 * 名前に普通にある旧字（淺・龍・澤・濱・萬・條・眞・髙・﨑・國）は入れない
 */
const TRADITIONAL = "區区驛駅樣様號号會会臺台鐵鉄廳庁圖図體体學学實実價価賣売樓楼屬属广広价価窗窓从従儿児个個气気梦夢无無听聴坏壊盖蓋";

function pairMap(s: string): Map<string, string> {
  const m = new Map<string, string>();
  const cs = Array.from(s);
  for (let i = 0; i + 1 < cs.length; i += 2) m.set(cs[i], cs[i + 1]);
  return m;
}
const KANJI_MAP: Map<string, string> = new Map([...pairMap(SIMPLIFIED), ...pairMap(TRADITIONAL)]);
/** 中国の字形の1字を探す（数える・テスト用） */
export const CHINESE_FORM_RE = new RegExp(`[${[...KANJI_MAP.keys()].join("")}]`, "u");
/** CJK 互換漢字（F900–FAFF）・康煕部首（2F00–2FDF）・部首補助（2E80–2EFF） */
const COMPAT_RE = /[⺀-⿟豈-﫿]/gu;

export function jaKanjiEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.JA_KANJI_NORMALIZE ?? "").trim().toLowerCase() !== "off";
}

/** 文字列の中の中国の字形を日本の字形に直す（それ以外の字は1字も変えない）。直した字の数も返す */
export function toJapaneseKanjiCount(text: string): { text: string; changed: number } {
  if (!text) return { text, changed: 0 };
  let changed = 0;
  // ③ 互換漢字・部首の字は NFKC（﨑 U+FA11 のように NFKC で変わらない字はそのまま）
  let t = text.replace(COMPAT_RE, (c) => { const n = c.normalize("NFKC"); if (n !== c) changed++; return n; });
  if (!CHINESE_FORM_RE.test(t)) return { text: t, changed };
  t = Array.from(t).map((c) => { const j = KANJI_MAP.get(c); if (j) { changed++; return j; } return c; }).join("");
  return { text: t, changed };
}
export function toJapaneseKanji(text: string): string {
  return toJapaneseKanjiCount(text).text;
}
/** 環境変数で止められる版（読み取りの出力に当てる口） */
export function jaKanji(text: string, env: Record<string, string | undefined> = process.env): string {
  return jaKanjiEnabled(env) ? toJapaneseKanji(text) : text;
}
/** JSON の値（文字列・配列・オブジェクト）の中の文字列を全部直す（鍵は変えない・形は変えない） */
export function jaKanjiDeep<T>(v: T, env: Record<string, string | undefined> = process.env): T {
  if (!jaKanjiEnabled(env)) return v;
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return toJapaneseKanji(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") { const o: Record<string, unknown> = {}; for (const [k, val] of Object.entries(x as Record<string, unknown>)) o[k] = walk(val); return o; }
    return x;
  };
  return walk(v) as T;
}

/**
 * 読み取りの指示に入れる1行（全ての読み取りの指示で同じ文）。
 * ⚠ 中国の字形の例は指示に書かない（推論なしの読み取りは指示の例を写す＝設計知見 d6d4d331）
 */
export const JA_KANJI_INSTRUCTION = "- これは日本の不動産資料です。日本語の漢字（日本の字形・新字体）で書き写す。中国の簡体字・繁体字にしない。地名・駅名・物件名は日本の表記のまま";
