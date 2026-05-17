"use strict";

const API_BASE = "https://sumora-ai-ui.vercel.app";

// ── 駅名 → 市区マッピング（広げて検索で所在地アナウンスに使用） ────────
const STATION_WARD_MAP = {
  // 大阪市北区
  "梅田": "大阪市北区", "西梅田": "大阪市北区", "東梅田": "大阪市北区",
  "中崎町": "大阪市北区", "扇町": "大阪市北区", "南森町": "大阪市北区",
  "天神橋筋六丁目": "大阪市北区", "淀屋橋": "大阪市北区",
  // 大阪市中央区
  "本町": "大阪市中央区", "堺筋本町": "大阪市中央区", "心斎橋": "大阪市中央区",
  "難波": "大阪市中央区", "北浜": "大阪市中央区", "天満橋": "大阪市中央区",
  "谷町四丁目": "大阪市中央区", "谷町六丁目": "大阪市中央区",
  "長堀橋": "大阪市中央区", "松屋町": "大阪市中央区",
  // 大阪市浪速区
  "なんば": "大阪市浪速区", "桜川": "大阪市浪速区",
  "千日前": "大阪市浪速区", "大国町": "大阪市浪速区",
  // 大阪市天王寺区
  "天王寺": "大阪市天王寺区", "四天王寺前夕陽ヶ丘": "大阪市天王寺区",
  "谷町九丁目": "大阪市天王寺区", "玉造": "大阪市天王寺区",
  // 大阪市西区
  "阿波座": "大阪市西区", "西長堀": "大阪市西区",
  "九条": "大阪市西区", "千代崎": "大阪市西区",
  // 大阪市港区
  "弁天町": "大阪市港区", "朝潮橋": "大阪市港区", "大阪港": "大阪市港区",
  // 大阪市城東区
  "京橋": "大阪市城東区", "森ノ宮": "大阪市城東区",
  // 大阪市東成区
  "今里": "大阪市東成区", "緑橋": "大阪市東成区",
  // 大阪市生野区
  "鶴橋": "大阪市生野区",
  // 大阪市住吉区
  "住吉": "大阪市住吉区", "長居": "大阪市住吉区", "我孫子道": "大阪市住吉区",
  "浅香": "大阪市住吉区",
  // 大阪市住之江区
  "住之江公園": "大阪市住之江区", "平林": "大阪市住之江区",
  // 大阪市大正区
  "大正": "大阪市大正区",
  // 大阪市西成区
  "天下茶屋": "大阪市西成区", "岸里": "大阪市西成区",
  // 大阪市淀川区
  "新大阪": "大阪市淀川区", "十三": "大阪市淀川区",
  "三国": "大阪市淀川区", "東三国": "大阪市淀川区",
  // 大阪市東淀川区
  "東淀川": "大阪市東淀川区", "南吹田": "大阪市東淀川区",
  // 大阪市旭区
  "千林大宮": "大阪市旭区", "関目高殿": "大阪市旭区",
  // 大阪市鶴見区
  "横堤": "大阪市鶴見区", "鶴見緑地": "大阪市鶴見区",
  // 大阪市平野区
  "平野": "大阪市平野区", "喜連瓜破": "大阪市平野区",
  // 豊中市
  "豊中": "豊中市", "蛍池": "豊中市", "曽根": "豊中市",
  "岡町": "豊中市", "柴原阪大前": "豊中市",
  // 池田市
  "池田": "池田市", "石橋阪大前": "池田市",
  // 吹田市
  "吹田": "吹田市", "江坂": "吹田市", "千里山": "吹田市",
  // 摂津市
  "摂津": "摂津市", "南摂津": "摂津市",
  // 東大阪市
  "布施": "東大阪市", "俊徳道": "東大阪市", "長瀬": "東大阪市",
  "弥刀": "東大阪市", "久宝寺口": "東大阪市",
  // 八尾市
  "八尾": "八尾市", "久宝寺": "八尾市",
  // 堺市
  "堺": "堺市堺区", "堺東": "堺市堺区", "百舌鳥": "堺市北区",
  "三国ヶ丘": "堺市堺区", "中百舌鳥": "堺市北区",
  // 門真市
  "門真南": "門真市", "古川橋": "門真市",
  // 守口市
  "守口": "守口市", "太秦天神川": "守口市",
  // 大阪市都島区
  "都島": "大阪市都島区", "桜ノ宮": "大阪市都島区",
  // 大阪市此花区
  "西九条": "大阪市此花区", "桜島": "大阪市此花区",
  "伝法": "大阪市此花区", "千鳥橋": "大阪市此花区",
  // 大阪市西淀川区
  "姫島": "大阪市西淀川区", "千船": "大阪市西淀川区",
  // 大阪市阿倍野区
  "阿倍野": "大阪市阿倍野区", "大阪阿部野橋": "大阪市阿倍野区",
  // 大阪市東住吉区
  "針中野": "大阪市東住吉区", "矢田": "大阪市東住吉区", "今川": "大阪市東住吉区",
  // 大阪市城東区（追加）
  "放出": "大阪市城東区", "鴫野": "大阪市城東区",
  // 大阪市住吉区（追加）
  "帝塚山": "大阪市住吉区",
  // 箕面市
  "箕面": "箕面市",
};

function findStationWard(areaText) {
  const normalized = areaText.replace(/駅|周辺|付近|近く|沿線/g, "").trim();
  return STATION_WARD_MAP[normalized] || STATION_WARD_MAP[areaText] || null;
}

// ── 駅名 → リアプロ沿線名マッピング ────────────────────────────────
const STATION_LINE_MAP = {
  // ── 御堂筋線 ──
  "梅田": ["大阪市高速軌道御堂筋線"],
  "中津": ["大阪市高速軌道御堂筋線"],
  "新大阪": ["大阪市高速軌道御堂筋線"],
  "西中島南方": ["大阪市高速軌道御堂筋線"],
  "東三国": ["大阪市高速軌道御堂筋線"],
  "江坂": ["大阪市高速軌道御堂筋線", "北大阪急行南北線"],
  "淀屋橋": ["大阪市高速軌道御堂筋線", "京阪電気鉄道京阪線"],
  "本町": ["大阪市高速軌道御堂筋線", "大阪市高速軌道中央線", "大阪市高速軌道四つ橋線"],
  "心斎橋": ["大阪市高速軌道御堂筋線", "大阪市高速軌道長堀鶴見緑地線"],
  "難波": ["大阪市高速軌道御堂筋線", "大阪市高速軌道四つ橋線"],
  "大国町": ["大阪市高速軌道御堂筋線", "大阪市高速軌道四つ橋線"],
  "動物園前": ["大阪市高速軌道御堂筋線", "大阪市高速軌道堺筋線"],
  "天王寺": ["大阪市高速軌道御堂筋線", "大阪市高速軌道谷町線"],
  "昭和町": ["大阪市高速軌道御堂筋線"],
  "西田辺": ["大阪市高速軌道御堂筋線"],
  "長居": ["大阪市高速軌道御堂筋線"],
  "我孫子": ["大阪市高速軌道御堂筋線"],
  "なかもず": ["大阪市高速軌道御堂筋線", "南海電鉄高野線"],
  // ── 谷町線 ──
  "大日": ["大阪市高速軌道谷町線"],
  "守口": ["大阪市高速軌道谷町線"],
  "千林大宮": ["大阪市高速軌道谷町線"],
  "関目高殿": ["大阪市高速軌道谷町線"],
  "野江内代": ["大阪市高速軌道谷町線"],
  "都島": ["大阪市高速軌道谷町線"],
  "天神橋筋六丁目": ["大阪市高速軌道谷町線", "大阪市高速軌道堺筋線", "阪急電鉄千里線"],
  "中崎町": ["大阪市高速軌道谷町線"],
  "東梅田": ["大阪市高速軌道谷町線"],
  "南森町": ["大阪市高速軌道谷町線", "大阪市高速軌道堺筋線"],
  "天満橋": ["大阪市高速軌道谷町線", "京阪電気鉄道京阪線"],
  "谷町四丁目": ["大阪市高速軌道谷町線", "大阪市高速軌道中央線"],
  "谷町六丁目": ["大阪市高速軌道谷町線", "大阪市高速軌道長堀鶴見緑地線"],
  "谷町九丁目": ["大阪市高速軌道谷町線", "大阪市高速軌道千日前線"],
  "四天王寺前夕陽ヶ丘": ["大阪市高速軌道谷町線"],
  "阿倍野": ["大阪市高速軌道谷町線"],
  "文の里": ["大阪市高速軌道谷町線"],
  "田辺": ["大阪市高速軌道谷町線"],
  "駒川中野": ["大阪市高速軌道谷町線"],
  "平野": ["大阪市高速軌道谷町線"],
  "喜連瓜破": ["大阪市高速軌道谷町線"],
  "出戸": ["大阪市高速軌道谷町線"],
  "長原": ["大阪市高速軌道谷町線"],
  "八尾南": ["大阪市高速軌道谷町線"],
  // ── 中央線 ──
  "コスモスクエア": ["大阪市高速軌道中央線"],
  "大阪港": ["大阪市高速軌道中央線"],
  "朝潮橋": ["大阪市高速軌道中央線"],
  "弁天町": ["大阪市高速軌道中央線"],
  "九条": ["大阪市高速軌道中央線", "阪神電鉄阪神なんば線"],
  "阿波座": ["大阪市高速軌道中央線", "大阪市高速軌道千日前線"],
  "堺筋本町": ["大阪市高速軌道中央線", "大阪市高速軌道堺筋線"],
  "緑橋": ["大阪市高速軌道中央線", "大阪市高速軌道今里筋線"],
  "深江橋": ["大阪市高速軌道中央線"],
  "高井田": ["大阪市高速軌道中央線"],
  "長田": ["大阪市高速軌道中央線"],
  // ── 堺筋線 ──
  "扇町": ["大阪市高速軌道堺筋線"],
  "北浜": ["大阪市高速軌道堺筋線", "京阪電気鉄道京阪線"],
  "長堀橋": ["大阪市高速軌道堺筋線", "大阪市高速軌道長堀鶴見緑地線"],
  "日本橋": ["大阪市高速軌道堺筋線", "大阪市高速軌道千日前線"],
  "恵美須町": ["大阪市高速軌道堺筋線"],
  "天下茶屋": ["大阪市高速軌道堺筋線", "南海電鉄高野線", "南海電鉄南本線"],
  // ── 四つ橋線 ──
  "西梅田": ["大阪市高速軌道四つ橋線"],
  "肥後橋": ["大阪市高速軌道四つ橋線"],
  "四ツ橋": ["大阪市高速軌道四つ橋線"],
  "花園町": ["大阪市高速軌道四つ橋線"],
  "岸里玉出": ["大阪市高速軌道四つ橋線"],
  "住之江公園": ["大阪市高速軌道四つ橋線"],
  // ── 千日前線 ──
  "野田阪神": ["大阪市高速軌道千日前線"],
  "玉川": ["大阪市高速軌道千日前線"],
  "西長堀": ["大阪市高速軌道千日前線", "大阪市高速軌道長堀鶴見緑地線"],
  "桜川": ["大阪市高速軌道千日前線", "阪神電鉄阪神なんば線"],
  "鶴橋": ["大阪市高速軌道千日前線", "近鉄難波・奈良線", "大阪環状線"],
  "今里": ["大阪市高速軌道千日前線", "大阪市高速軌道今里筋線"],
  // ── 長堀鶴見緑地線 ──
  "大正": ["大阪市高速軌道長堀鶴見緑地線"],
  "ドーム前千代崎": ["大阪市高速軌道長堀鶴見緑地線"],
  "西大橋": ["大阪市高速軌道長堀鶴見緑地線"],
  "松屋町": ["大阪市高速軌道長堀鶴見緑地線"],
  "玉造": ["大阪市高速軌道長堀鶴見緑地線", "大阪環状線"],
  "森ノ宮": ["大阪市高速軌道長堀鶴見緑地線", "大阪環状線"],
  "京橋": ["大阪市高速軌道長堀鶴見緑地線", "大阪環状線", "京阪電気鉄道京阪線", "JR東西線"],
  "蒲生四丁目": ["大阪市高速軌道長堀鶴見緑地線", "大阪市高速軌道今里筋線"],
  "横堤": ["大阪市高速軌道長堀鶴見緑地線"],
  "鶴見緑地": ["大阪市高速軌道長堀鶴見緑地線"],
  "門真南": ["大阪市高速軌道長堀鶴見緑地線"],
  // ── 今里筋線 ──
  "井高野": ["大阪市高速軌道今里筋線"],
  "太子橋今市": ["大阪市高速軌道今里筋線", "大阪市高速軌道谷町線"],
  "関目成育": ["大阪市高速軌道今里筋線"],
  // ── 大阪環状線 ──
  "大阪": ["大阪環状線"],
  "福島": ["大阪環状線", "阪神電鉄本線"],
  "野田": ["大阪環状線", "阪神電鉄本線"],
  "西九条": ["大阪環状線", "阪神電鉄阪神なんば線"],
  "芦原橋": ["大阪環状線"],
  "今宮": ["大阪環状線"],
  "新今宮": ["大阪環状線", "南海電鉄南本線", "南海電鉄高野線"],
  "寺田町": ["大阪環状線"],
  "桃谷": ["大阪環状線"],
  "大阪城公園": ["大阪環状線"],
  "桜ノ宮": ["大阪環状線"],
  "天満": ["大阪環状線"],
  // ── JR東西線 ──
  "北新地": ["JR東西線"],
  "新福島": ["JR東西線"],
  "海老江": ["JR東西線"],
  "御幣島": ["JR東西線"],
  "加島": ["JR東西線"],
  // ── 阪急神戸線 ──
  "大阪梅田": ["阪急電鉄神戸線", "阪急電鉄宝塚線", "阪急電鉄京都線"],
  "十三": ["阪急電鉄神戸線", "阪急電鉄宝塚線", "阪急電鉄京都線"],
  "神崎川": ["阪急電鉄神戸線"],
  "園田": ["阪急電鉄神戸線"],
  "塚口": ["阪急電鉄神戸線"],
  "武庫之荘": ["阪急電鉄神戸線"],
  // ── 阪急宝塚線 ──
  "三国": ["阪急電鉄宝塚線"],
  "庄内": ["阪急電鉄宝塚線"],
  "服部天神": ["阪急電鉄宝塚線"],
  "曽根": ["阪急電鉄宝塚線"],
  "豊中": ["阪急電鉄宝塚線"],
  "岡町": ["阪急電鉄宝塚線"],
  "池田": ["阪急電鉄宝塚線"],
  "石橋阪大前": ["阪急電鉄宝塚線"],
  "蛍池": ["阪急電鉄宝塚線", "大阪モノレール本線"],
  // ── 阪急京都線 ──
  "相川": ["阪急電鉄京都線"],
  "正雀": ["阪急電鉄京都線"],
  "摂津市": ["阪急電鉄京都線"],
  "南茨木": ["阪急電鉄京都線"],
  "茨木市": ["阪急電鉄京都線"],
  // ── 阪急千里線 ──
  "淡路": ["阪急電鉄千里線"],
  "柴島": ["阪急電鉄千里線"],
  "吹田": ["阪急電鉄千里線"],
  "豊津": ["阪急電鉄千里線"],
  "関大前": ["阪急電鉄千里線"],
  "千里山": ["阪急電鉄千里線"],
  "南千里": ["阪急電鉄千里線"],
  "山田": ["阪急電鉄千里線"],
  "北千里": ["阪急電鉄千里線"],
  // ── 近鉄難波・奈良線 ──
  "大阪難波": ["近鉄難波・奈良線"],
  "近鉄日本橋": ["近鉄難波・奈良線"],
  "大阪上本町": ["近鉄難波・奈良線"],
  "布施": ["近鉄難波・奈良線"],
  "俊徳道": ["近鉄難波・奈良線"],
  "長瀬": ["近鉄難波・奈良線"],
  "弥刀": ["近鉄難波・奈良線"],
  "久宝寺口": ["近鉄難波・奈良線"],
  "近鉄八尾": ["近鉄難波・奈良線"],
  // ── 南海本線・高野線 ──
  "堺": ["南海電鉄南本線"],
  "堺東": ["南海電鉄高野線"],
  "三国ヶ丘": ["南海電鉄高野線", "阪和線"],
  "百舌鳥": ["南海電鉄高野線"],
  "中百舌鳥": ["南海電鉄高野線", "大阪市高速軌道御堂筋線"],
  "岸里": ["南海電鉄高野線", "南海電鉄南本線"],
  "帝塚山": ["南海電鉄高野線", "南海電鉄南本線"],
  "住吉大社": ["南海電鉄南本線"],
  "住ノ江": ["南海電鉄南本線"],
  // ── 京阪本線 ──
  "野江": ["京阪電気鉄道京阪線"],
  "関目": ["京阪電気鉄道京阪線"],
  "森小路": ["京阪電気鉄道京阪線"],
  "千林": ["京阪電気鉄道京阪線"],
  "滝井": ["京阪電気鉄道京阪線"],
  "土居": ["京阪電気鉄道京阪線"],
  "守口市": ["京阪電気鉄道京阪線"],
  "西三荘": ["京阪電気鉄道京阪線"],
  "門真市": ["京阪電気鉄道京阪線", "大阪モノレール本線"],
  // ── 北大阪急行 ──
  "桃山台": ["北大阪急行南北線"],
  "緑地公園": ["北大阪急行南北線"],
  "千里中央": ["北大阪急行南北線", "大阪モノレール本線"],
  "箕面船場阪大前": ["北大阪急行南北線"],
  "箕面萱野": ["北大阪急行南北線"],
  // ── 阪神電鉄本線 ──
  "淀川": ["阪神電鉄本線"],
  "姫島": ["阪神電鉄本線"],
  "千船": ["阪神電鉄本線"],
  "杭瀬": ["阪神電鉄本線"],
  // ── 阪神なんば線 ──
  "ドーム前": ["阪神電鉄阪神なんば線"],
  "千鳥橋": ["阪神電鉄阪神なんば線"],
  "伝法": ["阪神電鉄阪神なんば線"],
  // ── おおさか東線 ──
  "放出": ["おおさか東線", "片町線"],
  "鴫野": ["おおさか東線", "片町線"],
  "JR河内永和": ["おおさか東線"],
  "JR俊徳道": ["おおさか東線"],
  "JR長瀬": ["おおさか東線"],
  "JR久宝寺": ["おおさか東線"],
  // ── 大阪モノレール ──
  "大阪空港": ["大阪モノレール本線"],
  "柴原阪大前": ["大阪モノレール本線"],
  "少路": ["大阪モノレール本線"],
  "万博記念公園": ["大阪モノレール本線", "大阪モノレール彩都線"],
  "公園東口": ["大阪モノレール本線"],
  "豊川": ["大阪モノレール彩都線"],
  "彩都西": ["大阪モノレール彩都線"],
  // ── 近鉄南大阪線 ──
  "大阪阿部野橋": ["近鉄南大阪線"],
  "河堀口": ["近鉄南大阪線"],
  "北田辺": ["近鉄南大阪線"],
  "矢田": ["近鉄南大阪線"],
  "針中野": ["近鉄南大阪線"],
  "今川": ["近鉄南大阪線"],
  "帝塚山": ["近鉄南大阪線", "南海電鉄高野線"],
  // ── 近鉄大阪線 ──
  "河内小阪": ["近鉄大阪線"],
  "河内永和": ["近鉄大阪線"],
  // ── JR阪和線 ──
  "堺市": ["阪和線"],
  "鳳": ["阪和線"],
  "和泉府中": ["阪和線"],
  // ── 谷町線（追加） ──
  "都島": ["大阪市高速軌道谷町線"],
  "桜ノ宮": ["大阪環状線"],
};

function findStationLines(areaText) {
  const normalized = areaText.replace(/駅|周辺|付近|近く/g, "").trim();
  return STATION_LINE_MAP[normalized] || STATION_LINE_MAP[areaText] || null;
}

// STATION_LINE_MAP から路線ごとの駅順リストを導出（定義順 = 地理順）
const LINE_STATION_ORDER = {};
for (const [station, lines] of Object.entries(STATION_LINE_MAP)) {
  for (const line of lines) {
    if (!LINE_STATION_ORDER[line]) LINE_STATION_ORDER[line] = [];
    if (!LINE_STATION_ORDER[line].includes(station)) LINE_STATION_ORDER[line].push(station);
  }
}

// 当駅が属する路線上の前後各1駅を返す（重複なし）
function getAdjacentStations(stationName, lines) {
  const adj = new Set();
  for (const line of (lines || [])) {
    const order = LINE_STATION_ORDER[line] || [];
    const idx = order.indexOf(stationName);
    if (idx > 0) adj.add(order[idx - 1]);
    if (idx >= 0 && idx < order.length - 1) adj.add(order[idx + 1]);
  }
  return [...adj];
}

// ── 市区コード（リアプロ city_code[]） ──────────────────────────────
const WARD_CODE_MAP = {
  "大阪市都島区":"27102","大阪市福島区":"27103","大阪市此花区":"27104",
  "大阪市西区":"27106","大阪市港区":"27107","大阪市大正区":"27108",
  "大阪市天王寺区":"27109","大阪市浪速区":"27111","大阪市西淀川区":"27113",
  "大阪市東淀川区":"27114","大阪市東成区":"27115","大阪市生野区":"27116",
  "大阪市旭区":"27117","大阪市城東区":"27118","大阪市阿倍野区":"27119",
  "大阪市住吉区":"27120","大阪市東住吉区":"27121","大阪市西成区":"27122",
  "大阪市淀川区":"27123","大阪市鶴見区":"27124","大阪市住之江区":"27125",
  "大阪市平野区":"27126","大阪市北区":"27127","大阪市中央区":"27128",
  "堺市堺区":"27141","堺市中区":"27142","堺市東区":"27143",
  "堺市西区":"27144","堺市南区":"27145","堺市北区":"27146","堺市美原区":"27147",
  "豊中市":"27203","池田市":"27204","吹田市":"27205","高槻市":"27207",
  "守口市":"27209","枚方市":"27210","茨木市":"27211","八尾市":"27212",
  "寝屋川市":"27215","東大阪市":"27227","門真市":"27223","摂津市":"27224",
  "岸和田市":"27202","泉大津市":"27206","貝塚市":"27208","泉佐野市":"27213",
  "富田林市":"27214","河内長野市":"27216","松原市":"27217","大東市":"27218",
  "和泉市":"27219","箕面市":"27220","柏原市":"27221","羽曳野市":"27222",
  "大阪狭山市":"27231","泉南市":"27228","四條畷市":"27229","交野市":"27230","阪南市":"27232",
};

// ── 沿線名 → route_id（リアプロ route_id[]） ──────────────────────
const LINE_ROUTE_MAP = {
  "大阪市高速軌道御堂筋線":"6701","大阪市高速軌道谷町線":"6702",
  "大阪市高速軌道四つ橋線":"6703","大阪市高速軌道中央線":"6704",
  "大阪市高速軌道千日前線":"6705","大阪市高速軌道堺筋線":"6706",
  "大阪市高速軌道南港ポートタウン線":"6707","大阪市高速軌道今里筋線":"6699",
  "大阪市高速軌道長堀鶴見緑地線":"6768","北大阪急行南北線":"6711",
  "大阪環状線":"6603","JR東西線":"6767","ＪＲ東西線":"6767",
  "片町線":"6645","桜島線":"6604","おおさか東線":"6650",
  "関西本線":"6426","阪和線":"6647","福知山線":"6605","東海道本線":"6171",
  "近鉄大阪線":"6541","近鉄難波・奈良線":"6551","近鉄奈良線":"6551",
  "近鉄南大阪線":"6555","近鉄長野線":"6557","近鉄道明寺線":"6558","近鉄けいはんな線":"6563",
  "京阪電気鉄道京阪線":"6651","京阪電気鉄道中之島線":"6658","京阪電気鉄道交野線":"6652",
  "阪急電鉄京都線":"6661","阪急電鉄千里線":"6662","阪急電鉄神戸線":"6664",
  "阪急電鉄宝塚線":"6668","阪急電鉄箕面線":"6669",
  "阪神電鉄本線":"6671","阪神電鉄阪神なんば線":"6673",
  "南海電鉄南海本線":"6681","南海電鉄南本線":"6681",
  "南海電鉄高野線":"6686","南海電鉄泉北線":"6694",
  "南海電鉄空港線":"6691","南海電鉄汐見橋線":"6766","南海電鉄多奈川線":"6684","南海電鉄高師浜線":"6683",
  "阪堺電気軌道阪堺線":"6689","阪堺電気軌道上町線":"6690",
  "大阪モノレール本線":"6709","大阪モノレール彩都線":"6772",
  "能勢電鉄":"6676","水間鉄道水間線":"6713","関西空港線":"6648",
};

// desired_area → city_codes & route_ids
function buildAreaRouteCodes(c) {
  const rawArea = (c.desired_area || c.area || "").trim();
  const city_codes = [], route_ids = [];
  if (!rawArea) return { city_codes, route_ids };

  // 「大阪市」「大阪市内」 → 全区
  if (/^大阪市(内)?$/.test(rawArea)) {
    Object.values(WARD_CODE_MAP).filter((_, i) => Object.keys(WARD_CODE_MAP)[i].startsWith("大阪市")).forEach(v => city_codes.push(v));
    return { city_codes, route_ids };
  }

  const parts = rawArea.split(/[,、・\/\s]+/).map(s => s.replace(/駅|周辺|付近|近く|沿線/g, "").trim()).filter(Boolean);
  for (const part of parts) {
    if (WARD_CODE_MAP[part]) {
      if (!city_codes.includes(WARD_CODE_MAP[part])) city_codes.push(WARD_CODE_MAP[part]);
      continue;
    }
    const ward = findStationWard(part);
    if (ward && WARD_CODE_MAP[ward] && !city_codes.includes(WARD_CODE_MAP[ward])) city_codes.push(WARD_CODE_MAP[ward]);
    const lines = STATION_LINE_MAP[part] || [];
    lines.forEach(l => { const id = LINE_ROUTE_MAP[l]; if (id && !route_ids.includes(id)) route_ids.push(id); });
  }
  return { city_codes, route_ids };
}

const STATUS_LABELS = {
  new_inquiry:      "新規問い合わせ",
  hot:              "毎日物件出し",
  property_search:  "物件出し",
  pending:          "検討中",
};

// ── 各サイトの検索手順定義（ここを調整して使う） ──────────────────
const SITE_CONFIG = {
  realpro: {
    name: "リアプロ",
    icon: "🏠",
    steps: (c, mode = "pinpoint") => {
      const d = buildCondData(c, mode);
      const areaText = d.area || "";
      // 「町」は駅名に頻出するため場所判定から除外（例：堺筋本町・中崎町）
      const isStation  = /駅|線/.test(areaText);
      const isLocation = /市|区|府|県|都|郡/.test(areaText);
      const steps = [];
      let n = 1;

      // ── STEP 1: エリア絞り込み ──
      if (areaText) {
        if (isLocation && !isStation) {
          // 市・区・府・県など → 所在地
          steps.push({
            num: n++,
            field: "【所在地】絞り込み",
            value: areaText,
            note: d.isWide ? "広げて：大阪市内なら同じ区内も対象 / 隣接エリアも視野に" : null,
            hint: "左メニュー「所在地絞り込み ＋」をクリック → 都道府県を選択 → 市区郡を選択 → 右側「詳細な地域の設定へ進む ›」→ 地域を選択 → 「確定してリストへ」",
          });
        } else {
          // 駅名・沿線名 → 沿線・駅
          const lines = findStationLines(areaText);
          const linesText = lines ? lines.join(" / ") : null;
          steps.push({
            num: n++,
            field: "【沿線・駅】絞り込み",
            value: areaText,
            linesNote: linesText ? "選択する沿線: " + linesText : null,
            note: d.isWide ? "広げて：この駅 ＋ 隣の駅も追加で選択する（「駅名から絞り込み」で隣駅を検索）" : null,
            hint: "左メニュー「沿線・駅絞り込み ＋」→「駅名から絞り込み」に駅名を入力 → 上記の沿線を選択 → 右側「駅の設定へ進む ›」→ 駅を選択 → 「確定してリストへ」",
          });

          // 広げて検索のみ：その駅がある市区を所在地でも追加アナウンス
          if (d.isWide) {
            const ward = findStationWard(areaText);
            steps.push({
              num: n++,
              field: "【所在地でも検索】広げてオプション",
              value: ward ? ward : areaText + " 周辺の市区",
              note: ward
                ? `${areaText} がある市区 → 所在地でも検索して候補を広げる`
                : "この駅がある市区を所在地で検索して候補を広げる",
              hint: "左メニュー「所在地絞り込み ＋」→ 都道府県 → 市区郡（上記の市区）→ 詳細地域 → 「確定してリストへ」",
            });
          }
        }
      }

      // ── STEP 2: 駅からの移動手段（徒歩） ──
      if (d.walkMin) {
        steps.push({
          num: n++,
          field: "駅からの徒歩",
          value: d.walkMin,
          hint: "左メニュー「駅からの移動手段」の分数入力欄に入力",
          copyRaw: c.walk_minutes ? String(c.walk_minutes) : null,
        });
      }

      // ── STEP 3: 賃料 ──
      if (d.rentMax) {
        steps.push({
          num: n++,
          field: d.isWide ? "賃料（広げて上限）" : "賃料（上限）",
          value: d.rentMax,
          note: d.rentWideNote,
          hint: "右側の詳細条件エリアで賃料上限を入力（管理費込みで考慮推奨）",
          copyRaw: d.rentMaxNum ? String(d.rentMaxNum) : null,
        });
      }

      // ── STEP 4: 間取り ──
      if (d.floorPlan) {
        steps.push({
          num: n++,
          field: "間取り",
          value: d.floorPlan,
          hint: "間取りのチェックボックスで該当を選択",
        });
      }

      // ── STEP 5: 築年数 ──
      if (d.buildingAge) {
        steps.push({
          num: n++,
          field: "築年数",
          value: d.buildingAge,
          hint: "「築〇年以内」で絞り込み",
        });
      }

      // ── STEP 6: 入居時期 ──
      if (d.moveInTime) {
        steps.push({
          num: n++,
          field: "入居時期",
          value: d.moveInTime,
          hint: "入居可能日・時期の条件で設定",
        });
      }

      // ── STEP 7: こだわり・設備 ──
      if (d.preferences) {
        steps.push({
          num: n++,
          field: "こだわり・設備",
          value: d.preferences,
          hint: "詳細検索の設備・条件から該当を選択",
        });
      }

      // ── STEP 8: NG条件（確認用） ──
      if (d.ngPoints) {
        steps.push({
          num: n++,
          field: "NG・除外条件（確認用）",
          value: d.ngPoints,
          hint: "この条件が当てはまる物件は除外して候補を絞る",
        });
      }

      // ── 広げて：広さの許容ルール（常に表示） ──
      if (d.isWide) {
        steps.push({
          num: n++,
          field: "広さの許容ルール",
          value: "30㎡未満 → −5㎡まで OK　／　30㎡以上 → −10㎡まで OK",
          hint: "専有面積がお客さんの希望より少し小さい物件も候補に含めて確認する",
        });
      }

      return steps;
    },
  },

  itandi: {
    name: "itandi BB",
    icon: "📋",
    steps: (c, mode = "pinpoint") => {
      const d = buildCondData(c, mode);
      const rawArea = (c.desired_area || c.area || "").trim();

      // 大阪メトロの路線名変換（itandiは「高速電気軌道第N号線」表記）
      const ITANDI_LINE_MAP = {
        "大阪市高速軌道御堂筋線":   "高速電気軌道第1号線（大阪メトロ御堂筋線）",
        "大阪市高速軌道谷町線":     "高速電気軌道第2号線（大阪メトロ谷町線）",
        "大阪市高速軌道四つ橋線":   "高速電気軌道第3号線（大阪メトロ四つ橋線）",
        "大阪市高速軌道中央線":     "高速電気軌道第4号線（大阪メトロ中央線）",
        "大阪市高速軌道千日前線":   "高速電気軌道第5号線（大阪メトロ千日前線）",
        "大阪市高速軌道堺筋線":     "高速電気軌道第6号線（大阪メトロ堺筋線）",
        "大阪市高速軌道長堀鶴見緑地線": "高速電気軌道第7号線（大阪メトロ長堀鶴見緑地線）",
        "大阪市高速軌道今里筋線":   "高速電気軌道第8号線（大阪メトロ今里筋線）",
        "大阪市高速軌道南港ポートタウン線": "大阪市高速鉄道南港ポートタウン線（大阪メトロ南港ポートタウン線）",
        "北大阪急行南北線":         "北大阪急行電鉄",
        "阪急電鉄神戸線":           "阪急神戸本線",
        "阪急電鉄宝塚線":           "阪急宝塚本線",
        "阪急電鉄京都線":           "阪急京都本線",
        "阪急電鉄千里線":           "阪急千里線",
        "阪神電鉄本線":             "阪神本線",
        "阪神電鉄阪神なんば線":     "阪神なんば線",
        "南海電鉄南海本線":         "南海本線",
        "南海電鉄南本線":           "南海本線",
        "南海電鉄高野線":           "南海高野線",
        "京阪電気鉄道京阪線":       "京阪本線",
        "大阪モノレール本線":        "大阪モノレール線",
        "大阪モノレール彩都線":      "国際文化公園都市線（大阪モノレール彩都線）",
        "おおさか東線":              "おおさか東線",
        "大阪環状線":                "大阪環状線",
        "JR東西線":                  "JR東西線",
        "片町線":                    "JR片町線（学研都市線）",
        "阪和線":                    "阪和線（天王寺〜和歌山）",
      };

      // 駅に対応するitandi路線名を取得
      const stationLines = rawArea ? (STATION_LINE_MAP[rawArea.replace(/駅|周辺|付近|近く/g, "").trim()] || []) : [];
      const itandiLines = stationLines.map(l => ITANDI_LINE_MAP[l] || l);
      const linesNote = itandiLines.length ? itandiLines.join(" / ") : null;

      // ペット条件の検出
      const petNote = /ペット|pet/i.test(c.preferences || c.notes || "") ? "ページ最下部「入居条件（その他）」→「ペット相談」にチェック" : null;

      return [
        {
          num: 1,
          field: "エリア絞り込み",
          value: d.area,
          hint: "「所在地で絞り込み」→ 大阪府 → 市区選択 → 確定\nまたは「路線・駅で絞り込み」→ 大阪府 → 路線 → 駅 → 確定",
          linesNote: linesNote ? `itandiの路線名：${linesNote}` : null,
        },
        {
          num: 2,
          field: "賃料（上限）",
          value: d.rentMax,
          hint: "賃料の上限欄に入力（万円単位）。「管理費・共益費込み」にもチェックを忘れずに",
          copyRaw: d.rentMaxNum ? String(d.rentMaxNum) : null,
        },
        {
          num: 3,
          field: "駅徒歩",
          value: d.walkMin,
          hint: "「駅徒歩」欄に分数を入力",
        },
        {
          num: 4,
          field: "間取り",
          value: d.floorPlan,
          hint: "「間取り」セクションのチェックボックスから選択（1R〜5K以上）",
        },
        {
          num: 5,
          field: "築年数",
          value: d.buildingAge,
          hint: "「築年数」欄に数字を入力（例：15 → 15年以内）",
        },
        {
          num: 6,
          field: "特記設備",
          value: d.preferences,
          hint: "バス・トイレ別はサイドバー「バス・トイレ」→「バス・トイレ別」をチェック",
        },
        {
          num: 7,
          field: "NG条件（確認用）",
          value: d.ngPoints,
          hint: "この条件に当てはまる物件は候補から除外",
        },
        petNote ? {
          num: 8,
          field: "ペット相談",
          value: "チェックあり",
          hint: petNote,
        } : null,
      ].filter(Boolean).filter((s) => s.value);
    },
  },

  reins: {
    name: "レインズ",
    icon: "🔍",
    steps: (c, mode = "pinpoint") => {
      const d = buildCondData(c, mode);
      return [
        {
          num: 1,
          field: "所在地",
          value: d.area,
          hint: "所在地 → 都道府県 → 市区町村の順に選択",
        },
        {
          num: 2,
          field: "賃料（上限）",
          value: d.rentMax,
          hint: "賃料の「上限」欄に入力",
          copyRaw: d.rentMaxNum ? String(d.rentMaxNum) : null,
        },
        {
          num: 3,
          field: "間取り",
          value: d.floorPlan,
          hint: "「間取り」のチェックボックスを選択",
        },
        {
          num: 4,
          field: "交通（徒歩）",
          value: d.walkMin,
          hint: "交通条件の「徒歩〇分以内」で絞り込み",
        },
        {
          num: 5,
          field: "築年数",
          value: d.buildingAge,
          hint: "建物の「築〇年以内」で設定",
        },
        {
          num: 6,
          field: "入居時期",
          value: d.moveInTime,
          hint: "入居可能時期の条件を設定",
        },
        {
          num: 7,
          field: "設備・条件",
          value: d.preferences,
          hint: "詳細条件の設備から選択",
        },
      ].filter((s) => s.value);
    },
  },
};

// ── 条件データの整形 ──────────────────────────────────────────────
function buildCondData(c, mode = "pinpoint") {
  const rentMaxRaw = c.rent_max || c.max_rent || null;
  const rentMin    = c.rent_min || null;

  // 広げて検索：家賃上限を自動拡張
  let effectiveRentMax = rentMaxRaw;
  let rentWideNote = null;
  if (mode === "wide" && rentMaxRaw) {
    const buffer = rentMaxRaw <= 100000 ? 5000 : 10000;
    effectiveRentMax = rentMaxRaw + buffer;
    rentWideNote = `元の上限 ${formatYen(rentMaxRaw)} ＋${buffer.toLocaleString()}円まで許容`;
  }

  return {
    area:         c.desired_area || c.area || null,
    rentMax:      effectiveRentMax ? formatYen(effectiveRentMax) : null,
    rentMaxNum:   effectiveRentMax,
    rentWideNote: rentWideNote,
    rentMin:      rentMin ? formatYen(rentMin) : null,
    rentRange:    buildRentRange(rentMin, effectiveRentMax),
    floorPlan:    c.floor_plan || c.layout || null,
    walkMin:      c.walk_minutes ? c.walk_minutes + "分以内" : null,
    buildingAge:  c.building_age ? c.building_age + "年以内" : null,
    initialCost:  c.initial_cost_limit ? formatYen(c.initial_cost_limit) : null,
    moveInTime:   c.move_in_time || null,
    preferences:  c.preferences || null,
    ngPoints:     c.ng_points || null,
    otherReqs:    c.other_requests || null,
    isWide:       mode === "wide",
  };
}

function formatYen(n) {
  if (!n) return null;
  if (n >= 10000) return (n / 10000).toFixed(1) + "万円";
  return n.toLocaleString() + "円";
}

function buildRentRange(min, max) {
  if (!min && !max) return null;
  if (!min) return "〜" + formatYen(max);
  if (!max) return formatYen(min) + "〜";
  return formatYen(min) + "〜" + formatYen(max);
}

function hasConditions(c) {
  return !!(
    c.desired_area || c.area ||
    c.rent_max || c.max_rent || c.rent_min ||
    c.floor_plan || c.layout ||
    c.walk_minutes || c.building_age
  );
}

// ── HTML helper ───────────────────────────────────────────────────
function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── State ─────────────────────────────────────────────────────────
let allCustomers = [];
let selectedCustomer = null;
let selectedSite = null;
let searchMode = "pinpoint"; // "pinpoint" | "wide"

// ── アンダーバーモード検出 ─────────────────────────────────────────
// リアプロページに iframe として埋め込まれているときは true
const isUnderbar = window.self !== window.top;

function notifyParent(action) {
  if (!isUnderbar) return;
  window.parent.postMessage({ from: "aixlinx-underbar", action }, "*");
}

// ── View switching ─────────────────────────────────────────────────
function setMiniMode(mini) {
  document.body.classList.toggle("mini-mode", mini);
}

function showView(id) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  if (isUnderbar) {
    const mini = id === "view-list";
    setMiniMode(mini);
    notifyParent(mini ? "collapse" : "expand");
  }
}

// ── View 1: Customer list ──────────────────────────────────────────
async function loadCustomers() {
  const list = document.getElementById("customer-list");
  list.innerHTML = `<div class="state-msg">読み込み中...</div>`;

  try {
    const res = await fetch(`${API_BASE}/api/property-customers`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    allCustomers = await res.json();
    renderList(allCustomers);
  } catch (e) {
    list.innerHTML = `<div class="state-msg">⚠️ データ取得失敗<br><small>${esc(e.message)}</small></div>`;
  }
}

function renderList(customers) {
  const list = document.getElementById("customer-list");

  if (!customers.length) {
    list.innerHTML = `<div class="state-msg">お客さんがいません</div>`;
    return;
  }

  const withCond = customers.filter(hasConditions);
  const noCond   = customers.filter((c) => !hasConditions(c));

  let html = "";

  if (withCond.length) {
    if (noCond.length) {
      html += `<div class="section-divider">条件登録済み (${withCond.length}人)</div>`;
    }
    withCond.forEach((c) => { html += renderCustomerRow(c, false); });
  }

  if (noCond.length) {
    html += `<div class="section-divider">条件未登録 (${noCond.length}人)</div>`;
    noCond.forEach((c) => { html += renderCustomerRow(c, true); });
  }

  list.innerHTML = html;

  list.querySelectorAll(".customer-item").forEach((el) => {
    el.addEventListener("click", () => {
      const c = allCustomers.find((x) => String(x.id) === el.dataset.id);
      if (c) openSiteView(c);
    });
  });
}

function renderCustomerRow(c, dimmed) {
  const d = buildCondData(c);
  const metaParts = [];
  if (d.area)        metaParts.push("📍" + d.area);
  if (d.rentRange)   metaParts.push(d.rentRange);
  if (d.floorPlan)   metaParts.push(d.floorPlan);
  if (d.walkMin)     metaParts.push("徒歩" + d.walkMin);

  const meta = metaParts.join("  ");
  const label = STATUS_LABELS[c.status] || c.status;

  return `
    <div class="customer-item${dimmed ? " dimmed" : ""}" data-id="${esc(String(c.id))}">
      <div class="c-dot dot-${esc(c.status)}"></div>
      <div class="c-body">
        <div class="c-name">${esc(c.customer_name)}</div>
        ${meta ? `<div class="c-meta">${esc(meta)}</div>` : ""}
      </div>
      <span class="s-badge badge-${esc(c.status)}">${esc(label)}</span>
      <svg class="c-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
    </div>`;
}

// ── View 2: Site selection ─────────────────────────────────────────
function openSiteView(customer) {
  selectedCustomer = customer;
  document.getElementById("site-customer-name").textContent = customer.customer_name;

  const d = buildCondData(customer);
  const chips = [d.area, d.rentRange, d.floorPlan, d.walkMin && "徒歩" + d.walkMin, d.buildingAge && "築" + d.buildingAge]
    .filter(Boolean);

  const summaryEl = document.getElementById("conditions-summary");
  summaryEl.innerHTML = chips.length
    ? `<div class="cond-chips">${chips.map((ch) => `<span class="cond-chip">${esc(ch)}</span>`).join("")}</div>`
    : `<div class="cond-empty">物件条件が未登録です。先に物件条件ページで登録してください。</div>`;

  showView("view-site");
}

// ── View 3: Instructions ───────────────────────────────────────────
function syncModeButtons() {
  const modeDescs = { pinpoint: "条件ぴったりで検索", wide: "エリア・家賃・広さを少し広げて検索" };
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.classList.remove("active", "pinpoint", "wide");
    if (b.dataset.mode === searchMode) b.classList.add("active", searchMode);
  });
  document.getElementById("mode-desc").textContent = modeDescs[searchMode];
}

function renderInstrSteps(siteKey) {
  const cfg = SITE_CONFIG[siteKey];
  const steps = cfg.steps(selectedCustomer, searchMode);

  const modeLabel = searchMode === "wide"
    ? `<div class="wide-banner">🔎 広げて検索モード（家賃・エリア・広さを少し緩めて検索）</div>`
    : "";

  document.getElementById("instr-customer-card").innerHTML = `
    ${modeLabel}
    <div class="instr-for">${esc(selectedCustomer.customer_name)} の検索条件</div>
    <div class="instr-site">${esc(cfg.name)} で以下の条件を入力してください</div>
  `;

  const stepsEl = document.getElementById("instr-steps");
  if (!steps.length) {
    stepsEl.innerHTML = `<div class="state-msg">条件が登録されていません。<br>物件条件ページで登録してください。</div>`;
  } else {
    stepsEl.innerHTML = steps.map((s) => {
      const copyAttr = s.copyRaw ? esc(s.copyRaw) : esc(s.value);
      return `
        <div class="step-card">
          <div class="step-top">
            <span class="step-num">${s.num}</span>
            <span class="step-field">${esc(s.field)}</span>
          </div>
          <div class="step-value-row">
            <span class="step-val">${esc(s.value)}</span>
            <button class="copy-btn" data-copy="${copyAttr}">コピー</button>
          </div>
          ${s.linesNote ? `<div class="step-lines-note">🚇 ${esc(s.linesNote)}</div>` : ""}
          ${s.note ? `<div class="step-note">▲ ${esc(s.note)}</div>` : ""}
          <div class="step-hint">${esc(s.hint)}</div>
        </div>`;
    }).join("");

    stepsEl.querySelectorAll(".copy-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const text = btn.dataset.copy;
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = "✓ 済";
          btn.classList.add("copied");
          setTimeout(() => {
            btn.textContent = "コピー";
            btn.classList.remove("copied");
          }, 1800);
        });
      });
    });
  }

  // コピーオールのテキスト
  const allText = buildCopyAll(cfg.name, steps, selectedCustomer);
  document.getElementById("copy-all-btn").onclick = () => {
    navigator.clipboard.writeText(allText).then(() => {
      const btn = document.getElementById("copy-all-btn");
      btn.textContent = "✓ コピーしました！";
      setTimeout(() => { btn.textContent = "📋 全条件をコピー"; }, 2000);
    });
  };
}

function openInstructions(siteKey) {
  selectedSite = siteKey;
  const cfg = SITE_CONFIG[siteKey];

  document.getElementById("instr-title").textContent = cfg.icon + " " + cfg.name;
  syncModeButtons();
  renderInstrSteps(siteKey);

  // 自動入力ボタン＋一時調整フォーム（リアプロ＋アンダーバーモードのみ）
  const autofillBtn = document.getElementById("autofill-btn");
  const adjForm     = document.getElementById("adj-form");
  if (isUnderbar && siteKey === "itandi") {
    autofillBtn.style.display = "block";
    autofillBtn.textContent = "⚡ itandiに自動入力";
    autofillBtn.className = "autofill-btn";
    adjForm.style.display = "none";

    autofillBtn.onclick = () => {
      const c = selectedCustomer;
      const rawArea = (c.desired_area || c.area || "").trim();
      const stationClean = rawArea.replace(/駅|周辺|付近|近く/g, "").trim();
      const isWardArea = /[都道府県市区町村郡]/.test(stationClean);

      // リアプロ路線名 → itandi路線名（実画面DevToolsで確認した正式名称）
      // 配列の場合は複数路線に展開される（例: 近鉄難波・奈良線 → 2路線）
      const ITANDI_LINE_MAP_FILL = {
        "大阪市高速軌道御堂筋線":           "高速電気軌道第1号線(大阪メトロ御堂筋線)",
        "大阪市高速軌道谷町線":             "高速電気軌道第2号線(大阪メトロ谷町線)",
        "大阪市高速軌道四つ橋線":           "高速電気軌道第3号線(大阪メトロ四つ橋線)",
        "大阪市高速軌道中央線":             "高速電気軌道第4号線(大阪メトロ中央線)",
        "大阪市高速軌道千日前線":           "高速電気軌道第5号線(大阪メトロ千日前線)",
        "大阪市高速軌道堺筋線":             "高速電気軌道第6号線(大阪メトロ堺筋線)",
        "大阪市高速軌道長堀鶴見緑地線":     "高速電気軌道第7号線(大阪メトロ長堀鶴見緑地線)",
        "大阪市高速軌道今里筋線":           "高速電気軌道第8号線(大阪メトロ今里筋線)",
        "大阪市高速軌道南港ポートタウン線": "大阪市高速電気軌道南港ポートタウン線(大阪メトロ南港ポートタウン線)",
        "北大阪急行南北線":                 "北大阪急行電鉄",
        "阪急電鉄神戸線":                   "阪急神戸本線",
        "阪急電鉄宝塚線":                   "阪急宝塚本線",
        "阪急電鉄京都線":                   "阪急京都本線",
        "阪急電鉄千里線":                   "阪急千里線",
        "阪急電鉄箕面線":                   "阪急箕面線",
        "阪神電鉄本線":                     "阪神本線",
        "阪神電鉄阪神なんば線":             "阪神なんば線",
        "南海電鉄南海本線":                 "南海本線",
        "南海電鉄南本線":                   "南海本線",
        "南海電鉄高野線":                   "南海高野線",
        "南海電鉄泉北線":                   "南海泉北線(泉北線)",
        "京阪電気鉄道京阪線":               "京阪本線",
        "大阪環状線":                       "大阪環状線",
        "JR東西線":                         "JR東西線",
        "片町線":                           "JR片町線(学研都市線)",
        "阪和線":                           "阪和線(天王寺～和歌山)",
        "おおさか東線":                     "おおさか東線",
        "近鉄難波・奈良線":                 ["近鉄難波線", "近鉄奈良線"],
        "近鉄南大阪線":                     "近鉄南大阪線",
        "近鉄大阪線":                       "近鉄大阪線",
        "近鉄けいはんな線":                 "近鉄けいはんな線",
        "大阪モノレール本線":               "大阪モノレール線",
        "大阪モノレール彩都線":             "国際文化公園都市線(大阪モノレール彩都線)",
      };

      // STATION_LINE_MAPに収録済みなら必ず駅（「町」「村」が含まれていても駅名の場合がある）
      const inStationMap = !!(STATION_LINE_MAP[stationClean]);
      const isWardArea_itandi = !inStationMap && /[都道府県市区郡]/.test(stationClean);

      const stationLines = !isWardArea_itandi ? (STATION_LINE_MAP[stationClean] || []) : [];
      // 配列値を flatMap で展開（近鉄難波・奈良線 → 2路線など）
      const itandiLines = stationLines.flatMap(l => {
        const v = ITANDI_LINE_MAP_FILL[l];
        if (!v) return [];
        return Array.isArray(v) ? v : [v];
      });
      const wardName = isWardArea_itandi ? stationClean : (STATION_WARD_MAP[stationClean] || null);

      // 駅名リスト（広げて検索：当駅＋前後各1駅、ピンポイント：当駅のみ）
      let stationNames = null;
      if (!isWardArea_itandi) {
        stationNames = [stationClean];
        if (searchMode === "wide") {
          const adj = getAdjacentStations(stationClean, stationLines);
          stationNames = [stationClean, ...adj]; // 当駅を先頭に前後駅を追加
        }
      }

      const conditions = {
        rent_max:        c.rent_max || c.max_rent || null,
        walk_minutes:    c.walk_minutes || null,
        building_age:    c.building_age || null,
        floor_plan:      c.floor_plan || c.layout || null,
        structure_types: (c.building_structure || c.structure || "")
          .split(/[,、・\/\.\s]+/).map(s => s.trim()).filter(Boolean),
        pet_ok:      /ペット|pet/i.test(c.preferences || c.notes || ""),
        preferences: c.preferences || c.notes || null,
        ward_name:    isWardArea_itandi ? wardName : null,
        itandi_lines: !isWardArea_itandi ? itandiLines : [],
        station_names: stationNames, // 配列（広げて：最大3駅、ピンポイント：1駅）
      };
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (!tabs[0]) return;
        chrome.tabs.sendMessage(tabs[0].id, { type: "axlx-itandi-autofill", conditions });
      });
      autofillBtn.textContent = "✓ 入力しました！";
      autofillBtn.classList.add("done");
      setTimeout(() => {
        autofillBtn.textContent = "⚡ itandiに自動入力";
        autofillBtn.classList.remove("done");
      }, 3000);
    };
  } else if (isUnderbar && siteKey === "realpro") {
    autofillBtn.style.display = "block";
    autofillBtn.textContent = "⚡ リアプロに自動入力";
    autofillBtn.className = "autofill-btn";

    // 調整フォームに現在値をセット
    adjForm.style.display = "block";
    const c0 = selectedCustomer;
    document.getElementById("adj-area").value     = c0.desired_area || c0.area || "";
    document.getElementById("adj-rent-max").value = c0.rent_max || c0.max_rent || "";
    document.getElementById("adj-walk").value     = c0.walk_minutes || "";
    document.getElementById("adj-age").value      = c0.building_age || "";
    document.getElementById("adj-floor").value      = c0.floor_plan || c0.layout || "";
    document.getElementById("adj-structure").value  = c0.building_structure || c0.structure || "";
    // ペット相談：お客さんの preferences にペット関連があれば初期チェック
    const petPref = (c0.preferences || c0.notes || "");
    document.getElementById("adj-pet").checked = /ペット|pet/i.test(petPref);

    autofillBtn.onclick = () => {
      const c = selectedCustomer;
      // 調整フォームの値を優先して使う
      const adjArea     = document.getElementById("adj-area").value.trim();
      const adjRentMax  = document.getElementById("adj-rent-max").value;
      const adjWalk     = document.getElementById("adj-walk").value;
      const adjAge      = document.getElementById("adj-age").value;
      const adjFloor     = document.getElementById("adj-floor").value.trim();
      const adjStructure = document.getElementById("adj-structure").value.trim();
      const adjPet       = document.getElementById("adj-pet").checked;
      const adjC = {
        desired_area: adjArea     || c.desired_area || c.area  || null,
        area:         adjArea     || c.desired_area || c.area  || null,
        rent_max:     adjRentMax  ? Number(adjRentMax)  : (c.rent_max || c.max_rent || null),
        rent_min:     c.rent_min  || null,
        walk_minutes: adjWalk     ? Number(adjWalk)     : (c.walk_minutes || null),
        building_age: adjAge      ? Number(adjAge)      : (c.building_age || null),
        floor_plan:   adjFloor    || c.floor_plan || c.layout || null,
        structure_types: adjStructure
          ? adjStructure.split(/[,、・\/\.\s]+/).map(s => s.trim()).filter(Boolean)
          : [],
      };
      const { city_codes, route_ids } = buildAreaRouteCodes(adjC);
      window.parent.postMessage({
        from: "aixlinx-underbar",
        action: "autofill",
        conditions: {
          rent_min:     adjC.rent_min,
          rent_max:     adjC.rent_max,
          walk_minutes: adjC.walk_minutes,
          floor_plan:   adjC.floor_plan,
          building_age: adjC.building_age,
          city_codes,
          route_ids,
          structure_types: adjC.structure_types,
          pet_ok: adjPet,
        },
      }, "*");
      autofillBtn.textContent = "✓ 入力しました！";
      autofillBtn.classList.add("done");
      setTimeout(() => {
        autofillBtn.textContent = "⚡ リアプロに自動入力";
        autofillBtn.classList.remove("done");
      }, 3000);
    };
  } else {
    autofillBtn.style.display = "none";
    adjForm.style.display = "none";
  }

  showView("view-instructions");
}

function buildCopyAll(siteName, steps, c) {
  const lines = [
    `【${siteName} 検索条件】`,
    `お客さん: ${c.customer_name}`,
    "",
    ...steps.map((s) => `${s.field}: ${s.value}`),
  ];
  if (c.other_requests) lines.push(`その他要望: ${c.other_requests}`);
  return lines.join("\n");
}

// ── Search filter ──────────────────────────────────────────────────
function filterCustomers(q) {
  if (!q.trim()) { renderList(allCustomers); return; }
  const kw = q.trim().toLowerCase();
  renderList(
    allCustomers.filter((c) =>
      c.customer_name.toLowerCase().includes(kw) ||
      (c.desired_area || "").toLowerCase().includes(kw) ||
      (c.area || "").toLowerCase().includes(kw)
    )
  );
}

// ── Init ───────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  loadCustomers();

  // フローティングミニモードの初期化
  if (isUnderbar) {
    // 起動時はミニ（52x52）で表示
    setMiniMode(true);
    notifyParent("collapse");

    // 親ページのドラッグオーバーレイがクリックを検出して展開指示を送ってくる
    window.addEventListener("message", (e) => {
      if (e.data?.from === "underbar-parent" && e.data?.action === "expand-from-parent") {
        setMiniMode(false);
      }
    });
  }

  document.getElementById("collapse-btn").addEventListener("click", () => {
    if (isUnderbar) {
      setMiniMode(true);
      notifyParent("collapse");
    } else {
      showView("view-list");
    }
  });

  document.getElementById("refresh-btn").addEventListener("click", () => {
    showView("view-list");
    loadCustomers();
  });

  // 検索モード切替
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      searchMode = btn.dataset.mode;
      syncModeButtons();
      if (selectedSite && document.getElementById("view-instructions").classList.contains("active")) {
        renderInstrSteps(selectedSite);
      }
    });
  });
  syncModeButtons();

  document.getElementById("search-input").addEventListener("input", (e) => {
    filterCustomers(e.target.value);
  });

  document.getElementById("back-to-list").addEventListener("click", () => {
    showView("view-list");
  });

  document.getElementById("back-to-site").addEventListener("click", () => {
    showView("view-site");
  });

  document.querySelectorAll(".site-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      openInstructions(btn.dataset.site);
    });
  });
});
