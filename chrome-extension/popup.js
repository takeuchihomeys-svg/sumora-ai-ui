"use strict";

const API_BASE = "https://sumora-ai-ui.vercel.app";

// ── 自動学習マップ（Supabase から起動時に取得・未知トークンは Web検索で自動解決）──
const LEARNED_WARD_MAP    = {};  // 地名 → 市区
const LEARNED_STATION_MAP = {};  // 駅名 → { ward, realpro_lines[], itandi_lines[], reins_line }

// 既存ハードコードデータをSupabaseにシード（DBが空のとき一度だけ実行）
async function seedMapsIfEmpty() {
  try {
    // DBに1件でもあればスキップ
    const [rRes, sRes] = await Promise.all([
      fetch(`${API_BASE}/api/region-map`),
      fetch(`${API_BASE}/api/station-map`),
    ]);
    const [rd, sd] = await Promise.all([rRes.json(), sRes.json()]);
    if ((rd.regions || []).length > 0 && (sd.stations || []).length > 0) return;

    console.log("[AX] DBが空 → 既存マップをシード中...");

    // ① NEIGHBORHOOD_WARD_MAP → region_map
    const regions = Object.entries(NEIGHBORHOOD_WARD_MAP).map(([token, ward]) => ({
      token, ward, source: "hardcoded", confidence: 100,
    }));

    // ② STATION_LINE_MAP → station_map（itandi/reins路線名も変換して保存）
    const stations = Object.entries(STATION_LINE_MAP).map(([token, rpLines]) => {
      const ward = STATION_WARD_MAP[token] || null;
      const itandiLines = rpLines.flatMap(l => {
        const v = ITANDI_LINE_MAP_FILL[l];
        return v ? (Array.isArray(v) ? v : [v]) : [];
      });
      const reinsLine = REINS_LINE_MAP[rpLines[0]] || null;
      return { token, ward, realpro_lines: rpLines, itandi_lines: itandiLines, reins_line: reinsLine, source: "hardcoded", confidence: 100 };
    });

    const res = await fetch(`${API_BASE}/api/seed-maps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ regions, stations }),
    });
    const result = await res.json();
    console.log("[AX] シード完了:", result);
  } catch (e) {
    console.warn("[AX] seed失敗:", e.message);
  }
}

// 起動時: 地名・駅マップを一括ロード
async function fetchLearnedMaps() {
  try {
    const [regionRes, stationRes] = await Promise.all([
      fetch(`${API_BASE}/api/region-map`,  { cache: "no-store" }),
      fetch(`${API_BASE}/api/station-map`, { cache: "no-store" }),
    ]);
    if (regionRes.ok) {
      const d = await regionRes.json();
      for (const { token, ward } of (d.regions || [])) LEARNED_WARD_MAP[token] = ward;
    }
    if (stationRes.ok) {
      const d = await stationRes.json();
      for (const r of (d.stations || [])) {
        LEARNED_STATION_MAP[r.token] = {
          ward: r.ward, realpro_lines: r.realpro_lines || [],
          itandi_lines: r.itandi_lines || [], reins_line: r.reins_line || null,
        };
      }
    }
    console.log("[AX] 学習済みロード: 地名", Object.keys(LEARNED_WARD_MAP).length,
      "件 / 駅", Object.keys(LEARNED_STATION_MAP).length, "件");
  } catch (e) {
    console.warn("[AX] 学習済みマップ取得失敗:", e.message);
  }
}

// 間違えて学習したエントリをDBから削除してローカルマップからも除去
async function deleteLearnedToken(token, type) {
  try {
    const endpoint = type === "station" ? "station-map" : "region-map";
    await fetch(`${API_BASE}/api/${endpoint}?token=${encodeURIComponent(token)}`, { method: "DELETE" });
    if (type === "station") { delete LEARNED_STATION_MAP[token]; }
    else                    { delete LEARNED_WARD_MAP[token]; }
    console.log("[AX] 削除完了:", token, "→ 次回またWeb検索で再解決");
    // 削除後に再描画して再解決を促す
    if (selectedCustomer && selectedSite) {
      const areaVal = document.getElementById("adj-area")?.value || (selectedCustomer.desired_area || selectedCustomer.area || "");
      showUnknownWarn(computeUnknownTokens(areaVal));
      renderInstrSteps(selectedSite, buildAdjCustomer(selectedCustomer));
    }
  } catch (e) {
    console.warn("[AX] 削除失敗:", e.message);
  }
}

// 未知トークンをWeb検索部隊（/api/token-resolve）で解決→LEARNED_MAPに追加→再描画
async function resolveUnknownTokensWithAI(tokens, onResolved) {
  if (!tokens || tokens.length === 0) return;
  try {
    const res = await fetch(`${API_BASE}/api/token-resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens }),
    });
    if (!res.ok) return;
    const data = await res.json();
    let anyNew = false;
    for (const [token, info] of Object.entries(data.result || {})) {
      const r = info;
      if (r.type === "region" && r.ward && !LEARNED_WARD_MAP[token]) {
        LEARNED_WARD_MAP[token] = r.ward;
        anyNew = true;
        console.log("[AX] 地名学習:", token, "→", r.ward, `(${r.source})`);
      } else if (r.type === "station" && !LEARNED_STATION_MAP[token]) {
        LEARNED_STATION_MAP[token] = {
          ward: r.ward, realpro_lines: r.realpro_lines || [],
          itandi_lines: r.itandi_lines || [], reins_line: r.reins_line || null,
        };
        anyNew = true;
        console.log("[AX] 駅学習:", token, "→", r.ward, r.realpro_lines, `(${r.source})`);
      }
    }
    if (anyNew && onResolved) onResolved();
  } catch (e) {
    console.warn("[AX] token-resolve 失敗:", e.message);
  }
}

// 地名 → 市区の解決（NEIGHBORHOOD_WARD_MAP → LEARNED_WARD_MAP の順に参照）
function resolveWard(token) {
  return NEIGHBORHOOD_WARD_MAP[token] || LEARNED_WARD_MAP[token] || null;
}


// 漢数字・全角数字 → 半角算用数字に正規化（「五丁目」→「5丁目」など）
function normalizeNumerals(s) {
  return s
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/一丁目/g, "1丁目").replace(/二丁目/g, "2丁目").replace(/三丁目/g, "3丁目")
    .replace(/四丁目/g, "4丁目").replace(/五丁目/g, "5丁目").replace(/六丁目/g, "6丁目")
    .replace(/七丁目/g, "7丁目").replace(/八丁目/g, "8丁目").replace(/九丁目/g, "9丁目")
    .replace(/十丁目/g, "10丁目");
}

// 「第一希望:枚方市」「大阪府以外:奈良」などのラベルプレフィックスと方向サフィックスを除去してエリアトークンを分解
function parseAreaTokens(rawArea) {
  if (!rawArea) return [];
  // 「AあたりからBあたりまで」「AからBまで」「A〜B」「A～B」→ 両端点をカンマで展開
  const expanded = rawArea
    .replace(/([^\s,、・\/～〜]+?)あたりから([^\s,、・\/～〜]+?)あたりまで/g, "$1,$2")
    .replace(/([^\s,、・\/～〜]+?)から([^\s,、・\/～〜]+?)まで/g, "$1,$2")
    .replace(/([^\s,、・\/]+?)[〜～]([^\s,、・\/]+)/g, "$1,$2")
    // 「Aか B」「AやB」「AまたはB」→ カンマ区切りに変換（例:「豊崎か北区」→「豊崎,北区」）
    .replace(/([^\s,、・\/～〜]{1,10})\s*[かや]\s*([^\s,、・\/～〜]{1,10})/g, "$1,$2");
  return expanded
    .split(/[,、・\/\s]+|又は|もしくは/)
    .map(t => t.replace(/^[^:]+:/, "")             // 「第一希望:」「第二希望:」「大阪府以外:」などを除去
                .replace(/以南$|以北$|以西$|以東$/, "") // 方向サフィックスを除去
                .replace(/通勤\d+分圏内|通勤\d+分以内|\d+分圏内/g, "") // 「通勤20分圏内」などを除去
                .replace(/駅|周辺|付近|近く|沿線|エリア|あたり/g, "")
                .trim())
    .map(normalizeNumerals)
    .filter(t => t.length >= 1);
}

function findStationWard(areaText) {
  const normalized = areaText.replace(/駅|周辺|付近|近く|沿線/g, "").trim();
  // STATION_WARD_MAP → LEARNED_STATION_MAP の順で市区を解決
  return STATION_WARD_MAP[normalized] || STATION_WARD_MAP[areaText]
    || LEARNED_STATION_MAP[normalized]?.ward || LEARNED_STATION_MAP[areaText]?.ward || null;
}

// 駅名あいまい解決：完全一致→前方一致→部分一致の順で STATION_LINE_MAP → LEARNED_STATION_MAP を検索
function resolveStation(rawInput) {
  const clean = rawInput.replace(/駅|周辺|付近|近く|沿線/g, "").trim();
  if (!clean) return null;
  if (STATION_LINE_MAP[clean]) return clean;                                 // 完全一致（ハードコード）
  if (LEARNED_STATION_MAP[clean]) return clean;                             // 完全一致（学習済み）
  const keys = Object.keys(STATION_LINE_MAP);
  const sw = keys.find(k => k.startsWith(clean) && clean.length >= 2);
  if (sw) return sw;
  const ci = keys.find(k => clean.includes(k) && k.length >= 2);
  if (ci) return ci;
  const ki = keys.find(k => k.includes(clean) && clean.length >= 2);
  if (ki) return ki;
  // 学習済みマップでも検索
  const lKeys = Object.keys(LEARNED_STATION_MAP);
  const lk = lKeys.find(k => k === clean || k.includes(clean) || clean.includes(k));
  if (lk) return lk;
  return null;
}

// 学習済み駅の路線情報を取得（buildAreaRouteCodes で使用）
function getLearnedStationLines(token) {
  const info = LEARNED_STATION_MAP[token];
  return info ? info.realpro_lines || [] : [];
}

// 「JR高槻」「阪急梅田」のような「路線プレフィックス+駅名」形式を解決する
// 戻り値: { resolved: "高槻", type: "station" } or { resolved: "〇〇区", type: "ward" } or null
const LINE_PREFIXES_TO_STRIP = ["JR", "近鉄", "阪急", "阪神", "京阪", "南海", "大阪メトロ", "地下鉄"];
function resolveWithLinePrefixes(token) {
  for (const prefix of LINE_PREFIXES_TO_STRIP) {
    if (token.startsWith(prefix) && token.length > prefix.length) {
      const stripped = token.slice(prefix.length).trim();
      // STATION_LINE_MAP完全一致
      if (STATION_LINE_MAP[stripped]) return { resolved: stripped, type: "station" };
      // resolveStation（前方・部分一致）
      const via = resolveStation(stripped);
      if (via) return { resolved: via, type: "station" };
      // WARD_CODE_MAP（市区郡名）
      if (WARD_CODE_MAP[stripped]) return { resolved: stripped, type: "ward" };
      // NEIGHBORHOOD_WARD_MAP + LEARNED_WARD_MAP（地名）
      if (resolveWard(stripped)) return { resolved: stripped, type: "ward" };
    }
  }
  return null;
}


function findStationLines(areaText) {
  const normalized = areaText.replace(/駅|周辺|付近|近く/g, "").trim();
  return STATION_LINE_MAP[normalized] || STATION_LINE_MAP[areaText] || null;
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

// 「AからBまで」範囲指定の中間駅を展開する
// ① 同一路線上に両駅がある → その間の全駅を返す
// ② ない場合 → 1ホップ探索（A路線の駅 X が B路線にも属する → X〜Bの中間駅を返す）
function expandStationRange(stationA, stationB) {
  const result = [];
  const linesA = STATION_LINE_MAP[stationA] || [];
  const linesB = STATION_LINE_MAP[stationB] || [];

  // ① 直接共通路線
  for (const line of linesA) {
    if (!linesB.includes(line)) continue;
    const order = LINE_STATION_ORDER[line] || [];
    const idxA = order.indexOf(stationA), idxB = order.indexOf(stationB);
    if (idxA === -1 || idxB === -1) continue;
    const from = Math.min(idxA, idxB), to = Math.max(idxA, idxB);
    for (let i = from + 1; i < to; i++) {
      if (!result.includes(order[i])) result.push(order[i]);
    }
    return result; // 直接共通があれば終了
  }

  // ② 1ホップ探索: A側の各路線を走査して B側の路線につながる中間駅を探す
  for (const lineA of linesA) {
    const orderA = LINE_STATION_ORDER[lineA] || [];
    const idxA = orderA.indexOf(stationA);
    if (idxA === -1) continue;
    for (const mid of orderA) {
      if (mid === stationA) continue;
      const linesMid = STATION_LINE_MAP[mid] || [];
      for (const lineMid of linesMid) {
        if (!linesB.includes(lineMid)) continue;
        const orderMid = LINE_STATION_ORDER[lineMid] || [];
        const idxMid = orderMid.indexOf(mid), idxB = orderMid.indexOf(stationB);
        if (idxMid === -1 || idxB === -1) continue;
        // 中間駅 mid を追加
        if (!result.includes(mid)) result.push(mid);
        // mid〜stationB の中間駅を追加
        const from = Math.min(idxMid, idxB), to = Math.max(idxMid, idxB);
        for (let i = from + 1; i < to; i++) {
          if (!result.includes(orderMid[i])) result.push(orderMid[i]);
        }
        return result;
      }
    }
  }
  return result;
}


// desired_area → city_codes & route_ids
// mode: "station" → 駅マップのみ / "ward" → 地域マップのみ / "auto" → 従来の自動判定
function buildAreaRouteCodes(c, mode = "auto") {
  const rawArea = (c.desired_area || c.area || "").trim();
  const city_codes = [], route_ids = [];
  if (!rawArea) return { city_codes, route_ids };

  // 「大阪市」「大阪市内」 → 全区
  if (/^大阪市(内)?$/.test(rawArea)) {
    Object.values(WARD_CODE_MAP).filter((_, i) => Object.keys(WARD_CODE_MAP)[i].startsWith("大阪市")).forEach(v => city_codes.push(v));
    return { city_codes, route_ids };
  }

  const parts = parseAreaTokens(rawArea);
  for (const part of parts) {
    if (mode === "ward") {
      // 地域モード: WARD_CODE_MAP → NEIGHBORHOOD_WARD_MAP のみ。路線IDは追加しない
      if (WARD_CODE_MAP[part]) {
        if (!city_codes.includes(WARD_CODE_MAP[part])) city_codes.push(WARD_CODE_MAP[part]);
      } else {
          const neighWard = resolveWard(part);
        if (neighWard && WARD_CODE_MAP[neighWard] && !city_codes.includes(WARD_CODE_MAP[neighWard]))
          city_codes.push(WARD_CODE_MAP[neighWard]);
      }
      continue;
    }
    if (mode === "station") {
      // 駅モード: STATION_LINE_MAP → LEARNED_STATION_MAP の順で路線を解決
      const station = resolveStation(part);
      const stationKey = station || part;
      const ward = STATION_WARD_MAP[stationKey] || findStationWard(part);
      if (ward && WARD_CODE_MAP[ward] && !city_codes.includes(WARD_CODE_MAP[ward])) city_codes.push(WARD_CODE_MAP[ward]);
      const lines = STATION_LINE_MAP[stationKey] || LEARNED_STATION_MAP[stationKey]?.realpro_lines || [];
      lines.forEach(l => { const id = LINE_ROUTE_MAP[l]; if (id && !route_ids.includes(id)) route_ids.push(id); });
      continue;
    }
    // auto: 従来の自動判定
    if (WARD_CODE_MAP[part]) {
      if (!city_codes.includes(WARD_CODE_MAP[part])) city_codes.push(WARD_CODE_MAP[part]);
      continue;
    }
    const neighWard = resolveWard(part);
    if (neighWard && !STATION_LINE_MAP[part]) {
      if (WARD_CODE_MAP[neighWard] && !city_codes.includes(WARD_CODE_MAP[neighWard]))
        city_codes.push(WARD_CODE_MAP[neighWard]);
      continue;
    }
    const station = resolveStation(part);
    const stationKey = station || part;
    const ward = STATION_WARD_MAP[stationKey] || findStationWard(part);
    if (ward && WARD_CODE_MAP[ward] && !city_codes.includes(WARD_CODE_MAP[ward])) city_codes.push(WARD_CODE_MAP[ward]);
    const lines = STATION_LINE_MAP[stationKey] || LEARNED_STATION_MAP[stationKey]?.realpro_lines || [];
    lines.forEach(l => { const id = LINE_ROUTE_MAP[l]; if (id && !route_ids.includes(id)) route_ids.push(id); });
  }
  return { city_codes, route_ids };
}



// ── 各サイトの検索手順定義（ここを調整して使う） ──────────────────
const SITE_CONFIG = {
  realpro: {
    name: "リアプロ",
    icon: "🏠",
    steps: (c, mode = "pinpoint", areaMode = null) => {
      const d = buildCondData(c, mode);
      const areaText = d.area || "";
      const areaClean = normalizeNumerals(areaText.replace(/周辺|付近|近く|エリア/g, "").trim());
      const _resolvedWard = resolveWard(areaClean);
      const neighborhoodWard = (_resolvedWard && !STATION_LINE_MAP[areaClean]) ? _resolvedWard : null;

      // ボタン押下が絶対ルール。未選択時のみ自動判定
      let isLocation, isStation;
      if (areaMode === "ward") {
        isLocation = true; isStation = false;
      } else if (areaMode === "station") {
        isLocation = false; isStation = true;
      } else {
        isStation  = /駅|線/.test(areaText);
        isLocation = !!(neighborhoodWard) || /市|区|府|県|都|郡/.test(areaText);
      }
      const steps = [];
      let n = 1;

      // ── STEP 1: エリア絞り込み ──
      if (areaText) {
        if (isLocation && !isStation) {
          // 市・区・府・県など → 所在地
          const locationValue = neighborhoodWard
            ? neighborhoodWard + "（" + areaClean + "）"
            : areaText;
          steps.push({
            num: n++,
            field: "【所在地】絞り込み",
            value: locationValue,
            note: d.isWide ? "広げて：大阪市内なら同じ区内も対象 / 隣接エリアも視野に" : null,
            hint: "左メニュー「所在地絞り込み ＋」をクリック → 都道府県を選択 → 市区郡を選択 → 右側「詳細な地域の設定へ進む ›」→ 地域を選択 → 「確定してリストへ」",
          });
        } else {
          // 駅名・沿線名 → 沿線・駅
          const lines = findStationLines(areaText);
          const linesText = lines ? lines.join(" / ") : null;
          // 広げて検索：隣駅名を実際に計算して表示
          let wideStationNote = null;
          if (d.isWide && lines) {
            const stClean = areaText.replace(/駅|周辺|付近|近く/g, "").trim();
            const adj = getAdjacentStations(stClean, lines);
            if (adj.length > 0) {
              wideStationNote = "広げて：" + stClean + " ＋ 前後の駅「" + adj.join("・") + "」も追加で選択する";
            } else {
              wideStationNote = "広げて：この駅 ＋ 隣の駅も追加で選択する（「駅名から絞り込み」で隣駅を検索）";
            }
          }
          steps.push({
            num: n++,
            field: "【沿線・駅】絞り込み",
            value: areaText,
            linesNote: linesText ? "選択する沿線: " + linesText : null,
            note: wideStationNote,
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
        "東海道本線":                "JR東海道本線（JR京都線/JR神戸線）",
        "福知山線":                  "JR福知山線（JR宝塚線）",
        "関西本線":                  "JR関西本線（大和路線）",
        "桜島線":                    "JR桜島線（JRゆめ咲線）",
        "近鉄難波・奈良線":          "近鉄難波線/近鉄奈良線",
        "近鉄南大阪線":              "近鉄南大阪線",
        "近鉄大阪線":                "近鉄大阪線",
        "近鉄長野線":                "近鉄長野線",
        "近鉄道明寺線":              "近鉄道明寺線",
        "近鉄けいはんな線":          "近鉄けいはんな線",
        "南海電鉄南海本線":          "南海本線",
        "南海電鉄高野線":            "南海高野線",
        "南海電鉄空港線":            "南海空港線",
        "京阪電気鉄道中之島線":      "京阪中之島線",
        "京阪電気鉄道交野線":        "京阪交野線",
        "阪急電鉄箕面線":            "阪急箕面線",
        "阪神電鉄阪神なんば線":      "阪神なんば線",
        "能勢電鉄":                  "能勢電鉄妙見線",
        "大阪モノレール本線":        "大阪モノレール線",
        "大阪モノレール彩都線":      "国際文化公園都市線（大阪モノレール彩都線）",
      };

      // 駅に対応するitandi路線名を取得（STATION_LINE_MAP → LEARNED_STATION_MAP の順）
      const stationKey_i = rawArea ? rawArea.replace(/駅|周辺|付近|近く/g, "").trim() : "";
      const stationLines_i = STATION_LINE_MAP[stationKey_i] || [];
      let itandiLines;
      if (stationLines_i.length > 0) {
        itandiLines = stationLines_i.map(l => ITANDI_LINE_MAP[l] || l);
      } else if (LEARNED_STATION_MAP[stationKey_i]?.itandi_lines?.length > 0) {
        itandiLines = LEARNED_STATION_MAP[stationKey_i].itandi_lines;
      } else {
        itandiLines = [];
      }
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
      const rawArea = (c.desired_area || c.area || "").trim();
      const steps = [];
      let n = 1;

      // 物件種別（必須・固定）
      steps.push({
        num: n++,
        field: "物件種別",
        value: "賃貸マンション",
        hint: "「物件種別1」プルダウン →「賃貸マンション」を選択（必須）",
      });

      // エリア絞り込み（沿線・駅 or 所在地）
      const stationKey = rawArea.replace(/駅|周辺|付近|近く/g, "").trim();
      const stationLines = stationKey ? (STATION_LINE_MAP[stationKey] || []) : [];
      if (stationLines.length) {
        // 沿線モード — 内部名をREINS表記に変換
        const reinsLines = stationLines.map(l => REINS_LINE_MAP[l] || l);
        const wideNote = mode === "wide" ? "。広げて検索の場合は沿線2・3に複数路線を追加可" : "";
        steps.push({
          num: n++,
          field: "沿線名",
          value: reinsLines.join(" / "),
          hint: `「沿線1」の「入力ガイド」→ 近畿圏 → 大阪府 → 次へ → 路線選択${wideNote}`,
        });
        steps.push({
          num: n++,
          field: "駅名",
          value: stationKey,
          hint: "「駅名」欄に直接入力（「駅」不要）",
        });
      } else if (rawArea) {
        // 所在地モード（広げて検索の場合は所在地2・3に隣接エリアを追加）
        const wideNote = mode === "wide" ? "。広げて検索の場合は所在地2・3に隣接区も追加可" : "";
        steps.push({
          num: n++,
          field: "所在地（市・区）",
          value: rawArea,
          hint: `「所在地範囲選択1」の「入力ガイド」ボタン → 大阪府 → 市・区を選択${wideNote}`,
        });
      }

      // 駅から徒歩
      if (d.walkMin) {
        steps.push({
          num: n++,
          field: "駅から徒歩",
          value: d.walkMin,
          hint: "「駅から徒歩」欄に数字のみ入力（例：10）",
          copyRaw: c.walk_minutes ? String(c.walk_minutes) : null,
        });
      }

      // 賃料（万円）
      if (d.rentMax) {
        const rentMaxMan = d.rentMaxNum ? Math.ceil(d.rentMaxNum / 10000) : null;
        steps.push({
          num: n++,
          field: "賃料（上限）",
          value: d.rentMax,
          hint: "賃料の「上限」欄に万円単位で入力",
          copyRaw: rentMaxMan ? String(rentMaxMan) : null,
        });
      }

      // 建物使用部分面積（平米指定がある場合）
      if (d.areaMin) {
        steps.push({
          num: n++,
          field: "建物使用部分面積",
          value: `${d.areaMin}㎡以上`,
          hint: `「建物使用部分面積」の左欄（FROM）に「${d.areaMin}」を入力（マンション専用欄）`,
          copyRaw: String(d.areaMin),
        });
      }

      // 間取部屋数・間取タイプ（平米表記を除外してから処理）
      if (d.floorPlan) {
        const typeSet = new Set();
        const roomNums = [];
        d.floorPlan.split(/[・,、\/\.\s]+/).forEach(p => {
          p = p.trim();
          // 平米・㎡・m2 を含むトークンは面積条件なので間取り処理をスキップ
          if (/平米|㎡|m2|m²/i.test(p)) return;
          const pu = p.toUpperCase();
          // 間取部屋数の抽出
          const m = pu.match(/^(\d+)/);
          if (m) roomNums.push(parseInt(m[1]));
          else if (/^(R|K|DK|LK|LDK|SK|SDK|SLK|SLDK|ワンルーム)/.test(pu)) roomNums.push(1);
          // 間取タイプの抽出
          if (pu === "1R" || pu === "R") typeSet.add("ワンルーム");
          else if (/^\d*SLDK$/.test(pu)) typeSet.add("SLDK");
          else if (/^\d*SLK$/.test(pu)) typeSet.add("SLK");
          else if (/^\d*SDK$/.test(pu)) typeSet.add("SDK");
          else if (/^\d*SK$/.test(pu)) typeSet.add("SK");
          else if (/^\d*LDK$/.test(pu)) { typeSet.add("LDK"); if (mode === "wide") typeSet.add("DK"); }
          else if (/^\d*LK$/.test(pu)) typeSet.add("LK");
          else if (/^\d*DK$/.test(pu)) typeSet.add("DK");
          else if (/^\d*K$/.test(pu)) typeSet.add("K");
        });

        if (roomNums.length) {
          steps.push({
            num: n++,
            field: "間取部屋数",
            value: `${Math.min(...roomNums)}室 〜 ${Math.max(...roomNums)}室`,
            hint: "「間取部屋数」の FROM/TO 欄に室数を入力",
            copyRaw: String(Math.min(...roomNums)),
          });
        }
        if (typeSet.size) {
          steps.push({
            num: n++,
            field: "間取タイプ",
            value: Array.from(typeSet).join(" / "),
            hint: "「間取タイプ」のチェックボックスから選択（ワンルーム／K／DK／LK／LDK など）",
          });
        }
      }

      // 築年月（築N年以内 → YYYY年以降に変換）
      if (c.building_age) {
        const fromYear = new Date().getFullYear() - parseInt(c.building_age);
        steps.push({
          num: n++,
          field: "築年月（FROM）",
          value: `${fromYear}年以降（築${c.building_age}年以内）`,
          hint: `「築年月」の「FROM」ドロップダウンで「${fromYear}年」を選択`,
          copyRaw: String(fromYear),
        });
      }

      // 設備・条件・住宅性能等（テキストエリア）
      if (d.preferences) {
        steps.push({
          num: n++,
          field: "設備・条件",
          value: d.preferences,
          hint: "「設備・条件・住宅性能等」テキストエリアに入力。「入力ガイド」ボタンから選択肢を追加も可（ペット相談・駐車場など）",
        });
      }

      // NG条件（確認用）
      if (d.ngPoints) {
        steps.push({
          num: n++,
          field: "NG条件（確認用）",
          value: d.ngPoints,
          hint: "この条件に当てはまる物件は候補から外す",
        });
      }

      return steps.filter(s => s.value);
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
    areaMin:      parseAreaMin(c.floor_plan) || parseAreaMin(c.preferences) || parseAreaMin(c.other_requests) || null,
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

// preferencesテキストから面積下限を抽出（例: "25平米以上" → 25）
function parseAreaMin(prefs) {
  if (!prefs) return null;
  const m = prefs.match(/(\d+)\s*(?:平米|㎡|m2|m²)\s*以上/i);
  return m ? Number(m[1]) : null;
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
let currentAreaMode = "ward"; // "station" | "ward" — ボタン押下が絶対ルール（自動判定より優先）
let currentAccount = ""; // "" = すべて / "sumora" / "ieyasu" / "giga" / "hasu"
let linkedOnly = false;  // 紐付け済みのみ表示
let todayOnly  = false;  // 今日対応のみ表示

function needsActionToday(c) {
  if (c.status === "pending") return false;
  if (c.status === "new_inquiry") return true;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (c.status === "hot") {
    return !c.last_property_sent_at || new Date(c.last_property_sent_at) < todayStart;
  }
  if (c.status === "property_search") {
    if (!c.last_property_sent_at) return true;
    return (now.getTime() - new Date(c.last_property_sent_at).getTime()) / 86400000 >= 3;
  }
  return false;
}

function updateTodayBanner() {
  const count = allCustomers.filter(needsActionToday).length;
  const banner = document.getElementById("today-banner");
  if (!banner) return;
  if (count > 0) {
    banner.style.display = "block";
    banner.textContent = `🔥 今日対応 ${count}名 ← タップで絞り込み`;
  } else {
    banner.style.display = "block";
    banner.textContent = "✅ 今日の対応は完了！";
    banner.style.background = "#e8f5e9";
    banner.style.color = "#2e7d32";
    banner.style.cursor = "default";
  }
}

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

// iframe内（リアプロ/itandi）はページのPermissions-Policyによりclipboard操作が完全ブロックされる
// → underbar.js（コンテンツスクリプト）にpostMessageでコピーを委託する
// サイドパネルモードは execCommand で直接コピー
function copyText(text) {
  if (isUnderbar) {
    window.parent.postMessage({ from: "aixlinx-underbar", action: "copy", text }, "*");
    return Promise.resolve();
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand("copy"); } catch {}
  ta.remove();
  return Promise.resolve();
}

// ── View 1: Customer list ──────────────────────────────────────────
const CUSTOMER_CACHE_KEY = "aixlinx_customers";
const CUSTOMER_CACHE_TTL = 5 * 60 * 1000; // 5分

function getCachedCustomers() {
  try {
    const raw = sessionStorage.getItem(CUSTOMER_CACHE_KEY);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CUSTOMER_CACHE_TTL) return null;
    return data;
  } catch { return null; }
}

function setCachedCustomers(data) {
  try {
    sessionStorage.setItem(CUSTOMER_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}

async function loadCustomers(forceRefresh = false) {
  const list = document.getElementById("customer-list");

  // キャッシュ利用（強制更新でない場合）
  if (!forceRefresh) {
    const cached = getCachedCustomers();
    if (cached) {
      allCustomers = cached;
      updateTodayBanner();
      renderList(allCustomers);
      return;
    }
  }

  list.innerHTML = `<div class="state-msg">読み込み中...</div>`;

  try {
    const res = await fetch(`${API_BASE}/api/property-customers`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    allCustomers = await res.json();
    setCachedCustomers(allCustomers);
    updateTodayBanner();
    renderList(allCustomers);
  } catch (e) {
    list.innerHTML = `<div class="state-msg">⚠️ データ取得失敗<br><small>${esc(e.message)}</small></div>`;
  }
}

function renderList(customers) {
  const list = document.getElementById("customer-list");

  if (!customers.length) {
    list.innerHTML = `<div class="state-msg">${linkedOnly ? "🔗 紐付け済みのお客さんがいません" : "お客さんがいません"}</div>`;
    return;
  }

  // 紐付け済み・条件あり・条件なし の3グループに分類
  const linked   = customers.filter((c) => c.is_linked);
  const unlinked = customers.filter((c) => !c.is_linked);
  const withCond = unlinked.filter(hasConditions);
  const noCond   = unlinked.filter((c) => !hasConditions(c));
  const showSections = linked.length > 0 && (withCond.length > 0 || noCond.length > 0);

  let html = "";

  if (linked.length) {
    html += `<div class="section-divider linked-divider">🔗 紐付け済み (${linked.length}人)</div>`;
    linked.forEach((c) => { html += renderCustomerRow(c, false); });
  }

  if (withCond.length) {
    if (showSections || noCond.length) {
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
        <div class="c-name">${c.is_linked ? '<span class="link-chip">🔗</span>' : ""}${esc(c.customer_name)}</div>
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

  // 追加条件の表示・最新条件ボタン
  const addWrap = document.getElementById("additional-cond-wrap");
  const addText = document.getElementById("additional-cond-text");
  const mergeBtn = document.getElementById("merge-cond-btn");
  if (customer.additional_conditions) {
    addText.textContent = "追加条件: " + customer.additional_conditions.slice(0, 100) + (customer.additional_conditions.length > 100 ? "…" : "");
    addWrap.style.display = "block";
    mergeBtn.onclick = async () => {
      mergeBtn.textContent = "AIが統合中...";
      mergeBtn.disabled = true;
      try {
        const res = await fetch(API_BASE + "/api/merge-conditions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customer }),
        });
        if (res.ok) {
          const data = await res.json();
          const merged = data.merged;
          // selectedCustomer を merged の値で上書き
          selectedCustomer = { ...customer, ...merged };
          // adj フォームも更新
          if (document.getElementById("adj-area")) preloadAdjForm(selectedCustomer);
        }
      } catch (e) {
        console.error("[AX] merge-conditions error:", e);
      }
      mergeBtn.textContent = "最新条件で検索";
      mergeBtn.disabled = false;
    };
  } else {
    addWrap.style.display = "none";
  }

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

function renderInstrSteps(siteKey, cOverride) {
  const cfg = SITE_CONFIG[siteKey];
  const c = cOverride || selectedCustomer;
  const steps = cfg.steps(c, searchMode, currentAreaMode);

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
        copyText(text).then(() => {
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
  const allText = buildCopyAll(cfg.name, steps, c);
  document.getElementById("copy-all-btn").onclick = () => {
    copyText(allText).then(() => {
      const btn = document.getElementById("copy-all-btn");
      btn.textContent = "✓ コピーしました！";
      setTimeout(() => { btn.textContent = "📋 全条件をコピー"; }, 2000);
    });
  };
}

function setupAreaModeSelector(c, siteKey) {
  const rawA = (c.desired_area || c.area || "").trim();
  const toks = parseAreaTokens(rawA);

  const selectorEl = document.getElementById("area-mode-selector");
  const noticeEl   = document.getElementById("area-mixed-notice");
  const btnStation = document.getElementById("btn-mode-station");
  const btnWard    = document.getElementById("btn-mode-ward");

  if (!rawA) { selectorEl.style.display = "none"; return; }
  selectorEl.style.display = "block";
  noticeEl.style.display   = "none"; // 混在警告は不要（ユーザーが選択するため）

  // ボタン押下が絶対ルール: currentAreaMode を更新 → ステップ表示も即更新
  function setMode(mode) {
    currentAreaMode = mode;
    btnStation.classList.toggle("active", mode === "station");
    btnWard.classList.toggle("active", mode === "ward");
    renderInstrSteps(siteKey, buildAdjCustomer(c));
  }

  // デフォルト: WARD_CODE_MAP収録済み → 地域 / 駅名のみ → 駅 / それ以外 → 地域
  const hasWardToken    = toks.some(t => WARD_CODE_MAP[t] || NEIGHBORHOOD_WARD_MAP[t] || /[市区郡]/.test(t));
  const hasStationToken = toks.some(t => !WARD_CODE_MAP[t] && (STATION_LINE_MAP[t] || STATION_LINE_MAP[t.replace(/[町村]$/,"")]));
  const defaultMode = hasWardToken ? "ward" : (hasStationToken ? "station" : "ward");

  setMode(defaultMode);
  btnStation.onclick = () => setMode("station");
  btnWard.onclick    = () => setMode("ward");
}

function preloadAdjForm(c) {
  document.getElementById("adj-area").value      = c.desired_area || c.area || "";
  document.getElementById("adj-rent-max").value  = c.rent_max || c.max_rent || "";
  document.getElementById("adj-area-min").value  = c.area_min || c.min_area || parseAreaMin(c.floor_plan || c.layout) || parseAreaMin(c.preferences) || parseAreaMin(c.other_requests) || "";
  document.getElementById("adj-walk").value      = c.walk_minutes || "";
  document.getElementById("adj-age").value       = c.building_age || "";
  document.getElementById("adj-floor").value     = c.floor_plan || c.layout || "";
  document.getElementById("adj-structure").value = c.building_structure || c.structure || "";

  // ペット：全フィールドから検出
  const petFields = [c.preferences, c.notes, c.other_requests, c.additional_conditions].filter(Boolean).join(" ");
  document.getElementById("adj-pet").checked = /ペット|pet/i.test(petFields);

  // お客様名表示
  const labelEl = document.getElementById("adj-customer-label");
  if (labelEl) labelEl.textContent = c.customer_name ? c.customer_name + "様" : "";

  // 最終送信日：last_property_sent_at から初期値セット
  const lastSentEl = document.getElementById("adj-last-sent-date");
  if (lastSentEl) {
    const initDate = c.last_property_sent_at ? c.last_property_sent_at.split("T")[0] : "";
    lastSentEl.value = initDate;
    lastSentEl.oninput = () => {
      const el = document.getElementById("adj-update-days");
      if (el) el.value = calcUpdateDays(lastSentEl.value, c.status);
    };
  }

  // 更新日：日付から自動計算
  const updateDaysEl = document.getElementById("adj-update-days");
  if (updateDaysEl) {
    const initDate = c.last_property_sent_at ? c.last_property_sent_at.split("T")[0] : "";
    updateDaysEl.value = calcUpdateDays(initDate, c.status);
  }
}

function calcUpdateDays(dateStr, status) {
  if (!dateStr) {
    return { hot: "1", property_search: "3", new_inquiry: "" }[status] || "";
  }
  const daysSince = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (daysSince <= 1) return "1";
  if (daysSince <= 3) return "3";
  if (daysSince <= 7) return "7";
  return "14";
}

function buildAdjCustomer(c) {
  const adjArea    = document.getElementById("adj-area").value.trim();
  const adjRentMax = document.getElementById("adj-rent-max").value;
  const adjWalk    = document.getElementById("adj-walk").value;
  const adjAge     = document.getElementById("adj-age").value;
  const adjFloor   = document.getElementById("adj-floor").value.trim();
  return {
    ...c,
    desired_area: adjArea    || c.desired_area || c.area || null,
    area:         adjArea    || c.desired_area || c.area || null,
    rent_max:     adjRentMax ? Number(adjRentMax) : (c.rent_max || c.max_rent || null),
    max_rent:     adjRentMax ? Number(adjRentMax) : (c.rent_max || c.max_rent || null),
    walk_minutes: adjWalk    ? Number(adjWalk)    : (c.walk_minutes || null),
    building_age: adjAge     ? Number(adjAge)     : (c.building_age || null),
    floor_plan:   adjFloor   || c.floor_plan || c.layout || null,
    layout:       adjFloor   || c.floor_plan || c.layout || null,
  };
}

function openInstructions(siteKey) {
  selectedSite = siteKey;
  const cfg = SITE_CONFIG[siteKey];

  document.getElementById("instr-title").textContent = cfg.icon + " " + cfg.name;
  syncModeButtons();
  renderInstrSteps(siteKey);

  // 他サイトへのクロスサイトボタン
  const crossBar = document.getElementById("cross-site-bar");
  if (crossBar) {
    const others = Object.entries(SITE_CONFIG).filter(([k]) => k !== siteKey);
    crossBar.innerHTML = others.map(([k, c]) =>
      `<button class="copy-all-btn" data-site="${k}" style="flex:1;background:#f5f5f5;color:#555;font-size:11px;padding:6px 4px">${c.icon} ${c.name}でも探す</button>`
    ).join("");
    crossBar.style.display = "flex";
    crossBar.querySelectorAll("button[data-site]").forEach(btn => {
      btn.addEventListener("click", () => openInstructions(btn.dataset.site));
    });
  }

  // 自動入力ボタン＋一時調整フォーム（リアプロ＋アンダーバーモードのみ）
  const autofillBtn = document.getElementById("autofill-btn");
  const adjForm     = document.getElementById("adj-form");

  // ── 未登録地名ヘルパー（博士連携: 駅でも地名マップにもないトークンを検出） ──────
  function computeUnknownTokens(areaStr) {
    if (!areaStr) return [];
    return parseAreaTokens(areaStr)
      .filter(t => t.length >= 2 && !/^[0-9０-９]/.test(t))
      .filter(t =>
        !STATION_LINE_MAP[t] &&
        !STATION_LINE_MAP[t.replace(/[町村]$/, "")] &&
        !NEIGHBORHOOD_WARD_MAP[t] &&
        !LEARNED_WARD_MAP[t] &&        // AI学習済みマップも参照
        !WARD_CODE_MAP[t] &&
        !/[都道府県市区郡]/.test(t) &&
        !resolveStation(t)
      );
  }
  function showUnknownWarn(tokens) {
    const el = document.getElementById("unknown-warn");
    if (!el) return;
    if (!tokens || !tokens.length) { el.style.display = "none"; return; }

    // 路線プレフィックス解決を試みる（例: JR高槻 → 高槻）
    const analyzed = tokens.map(t => ({ original: t, suggestion: resolveWithLinePrefixes(t) }));
    const hasResolvable = analyzed.some(r => r.suggestion);

    let html = "⚠️ 未登録地名: <b>" + tokens.join("・") + "</b>";
    if (hasResolvable) {
      const hints = analyzed.filter(r => r.suggestion)
        .map(r => r.original + "→<b>" + r.suggestion.resolved + "</b>("
          + (r.suggestion.type === "station" ? "駅" : "地域") + ")");
      html += "<br>🔄 解決候補: " + hints.join("、")
        + ' <button id="unknown-resolve-btn" style="margin-left:6px;padding:2px 8px;'
        + 'font-size:11px;background:#1a73e8;color:white;border:none;border-radius:4px;cursor:pointer">✓ 反映する</button>';
    } else {
      html += '<br>🤖 Web検索で自動解決中... <span id="ai-resolve-status"></span>';
    }
    el.style.display = "block";
    el.innerHTML = html;

    // 解決候補がない場合はAI+Web検索で自動解決を依頼
    if (!hasResolvable) {
      const unresolvedTokens = analyzed.filter(r => !r.suggestion).map(r => r.original);
      resolveUnknownTokensWithAI(unresolvedTokens, () => {
        // 解決後: 結果をチェックして「間違い？」ボタンを表示
        if (selectedCustomer && selectedSite) {
          const adjAreaEl = document.getElementById("adj-area");
          const areaVal = adjAreaEl ? adjAreaEl.value : (selectedCustomer.desired_area || selectedCustomer.area || "");
          const stillUnknown = computeUnknownTokens(areaVal);
          if (stillUnknown.length === 0) {
            // 全解決 → 解決結果と「間違い？」ボタンを表示
            const resolved = unresolvedTokens.map(t => {
              const w = LEARNED_WARD_MAP[t] || LEARNED_STATION_MAP[t]?.ward;
              const type = LEARNED_STATION_MAP[t] ? "駅" : "地名";
              return w ? `<span style="color:#1a73e8;font-weight:bold">${t}→${w}(${type})</span>
                <button onclick="deleteLearnedToken('${t}','${LEARNED_STATION_MAP[t] ? 'station' : 'region'}')"
                  style="margin-left:4px;font-size:10px;padding:1px 5px;background:#f44336;color:white;border:none;border-radius:3px;cursor:pointer">✗ 間違い</button>` : t;
            }).join("　");
            el.innerHTML = `✅ 自動解決: ${resolved}`;
          } else {
            showUnknownWarn(stillUnknown);
          }
          renderInstrSteps(selectedSite, buildAdjCustomer(selectedCustomer));
        }
      });
    }

    if (hasResolvable) {
      const btn = document.getElementById("unknown-resolve-btn");
      if (btn) {
        btn.onclick = () => {
          const adjAreaEl = document.getElementById("adj-area");
          let areaVal = adjAreaEl.value;
          analyzed.forEach(r => {
            if (r.suggestion) {
              // 元トークンを解決済み名で置換
              areaVal = areaVal.replace(
                new RegExp(r.original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
                r.suggestion.resolved
              );
            }
          });
          adjAreaEl.value = areaVal;
          showUnknownWarn(computeUnknownTokens(areaVal));
          renderInstrSteps(selectedSite, buildAdjCustomer(selectedCustomer));
        };
      }
    }
  }

  if (siteKey === "itandi") {
    adjForm.style.display = "block";
    preloadAdjForm(selectedCustomer);
    setupAreaModeSelector(selectedCustomer, "itandi");
    autofillBtn.style.display = "block";
    autofillBtn.textContent = "⚡ itandiに自動入力";
    autofillBtn.className = "autofill-btn";
    // ボタン表示と同時に未登録地名チェック（クリック前に気づける）
    showUnknownWarn(computeUnknownTokens(selectedCustomer.desired_area || selectedCustomer.area || ""));

    autofillBtn.onclick = () => {
      const c = selectedCustomer;
      const adjArea      = document.getElementById("adj-area").value.trim();
      const adjRentMax   = document.getElementById("adj-rent-max").value;
      const adjAreaMin   = document.getElementById("adj-area-min").value;
      const adjWalk      = document.getElementById("adj-walk").value;
      const adjAge       = document.getElementById("adj-age").value;
      const adjFloor     = document.getElementById("adj-floor").value.trim();
      const adjStructure = document.getElementById("adj-structure").value.trim();
      const adjPet       = document.getElementById("adj-pet").checked;
      const rawArea = (adjArea || c.desired_area || c.area || "").trim();

      // 複数駅・複数地域対応（「第一希望:〇〇」「第二希望:〇〇」などのプレフィックスも除去）
      const tokens = parseAreaTokens(rawArea);

      const matchedStations = [];  // STATION_LINE_MAPにマッチした駅名
      const allRpLines = [];       // リアプロ内部路線名（重複なし）

      // ボタン押下が絶対ルール: 駅モードなら全トークンを駅マッチ / 地域モードならスキップ
      if (currentAreaMode === "station") {
        tokens.forEach(token => {
          let lines = STATION_LINE_MAP[token];
          let key = token;
          if (!lines) {
            const stripped = token.replace(/[町村]$/, "");
            if (stripped !== token && STATION_LINE_MAP[stripped]) {
              lines = STATION_LINE_MAP[stripped]; key = stripped;
            }
          }
          // 路線プレフィックス解決（「JR高槻」→「高槻」など）
          if (!lines) {
            const prefixResult = resolveWithLinePrefixes(token);
            if (prefixResult && prefixResult.type === "station" && STATION_LINE_MAP[prefixResult.resolved]) {
              lines = STATION_LINE_MAP[prefixResult.resolved]; key = prefixResult.resolved;
            }
          }
          // LEARNED_STATION_MAPフォールバック（Web検索で学習した駅）
          if (!lines && LEARNED_STATION_MAP[token]?.realpro_lines?.length > 0) {
            lines = LEARNED_STATION_MAP[token].realpro_lines; key = token;
          }
          if (lines && lines.length) {
            if (!matchedStations.includes(key)) matchedStations.push(key);
            lines.forEach(l => { if (!allRpLines.includes(l)) allRpLines.push(l); });
          }
        });
      }

      const stationClean = tokens[0] || rawArea.replace(/駅|周辺|付近|近く/g, "").trim();

      // 地域トークン収集: NEIGHBORHOOD_WARD_MAP → LEARNED_WARD_MAP の順（守口市等も対象）
      const neighborhoodTokens = currentAreaMode === "ward"
        ? tokens.filter(t => resolveWard(t) || WARD_CODE_MAP[t])
        : tokens.filter(t => resolveWard(t) && !STATION_LINE_MAP[t]);
      const neighborhoodWard = neighborhoodTokens.length > 0
        ? (resolveWard(neighborhoodTokens[0]) || neighborhoodTokens[0])
        : null;
      const allNeighborhoodWards = [...new Set(neighborhoodTokens.map(t => resolveWard(t) || t))];

      // ボタン押下が絶対ルール
      const isWardArea_itandi = currentAreaMode === "ward";

      // 未登録トークン検出: 駅でも地名マップにもない → page-scriptで警告ログ
      const unknownTokens = tokens.filter(t =>
        t.length >= 2 &&
        !/^[0-9０-９]/.test(t) &&
        !matchedStations.includes(t) &&
        !STATION_LINE_MAP[t] &&
        !STATION_LINE_MAP[t.replace(/[町村]$/,"")] &&
        !NEIGHBORHOOD_WARD_MAP[t] &&
        !WARD_CODE_MAP[t] &&                         // WARD_CODE_MAP収録済みも除外
        !/[都道府県市区郡]/.test(t)
      );

      // itandi路線名に変換（ITANDI_LINE_MAP_FILL）、重複排除
      const itandiLines = allRpLines.flatMap(l => {
        const v = ITANDI_LINE_MAP_FILL[l];
        if (!v) return [];
        return Array.isArray(v) ? v : [v];
      }).filter((v, i, arr) => arr.indexOf(v) === i);

      // 所在地名: NEIGHBORHOOD_WARD_MAP → 市区郡テキスト → STATION_WARD_MAP の優先順
      const wardName = isWardArea_itandi
        ? (neighborhoodWard || stationClean)
        : (STATION_WARD_MAP[stationClean] || null);

      // 駅名リスト（広げて検索：各マッチ駅＋前後駅、ピンポイント：マッチ駅のみ）
      let stationNames = null;
      if (!isWardArea_itandi && matchedStations.length > 0) {
        stationNames = [...matchedStations];
        if (searchMode === "wide") {
          matchedStations.forEach(st => {
            const stLines = STATION_LINE_MAP[st] || [];
            const adj = getAdjacentStations(st, stLines);
            adj.forEach(a => { if (!stationNames.includes(a)) stationNames.push(a); });
          });
        }
      }

      // 広げて検索：賃料上限を自動拡張
      // preloadAdjFormで初期値が入るためadjRentMaxは常にtruthy。
      // お客さんのデフォルト値と異なる場合のみ手動変更とみなす。
      const rawRentMax = c.rent_max || c.max_rent || null;
      const itandiRentManualChanged = adjRentMax && rawRentMax && Number(adjRentMax) !== rawRentMax;
      const itandiEffectiveRentMax = (() => {
        if (itandiRentManualChanged) return Number(adjRentMax);
        if (!rawRentMax) return null;
        if (searchMode === "wide") {
          const buffer = rawRentMax <= 100000 ? 5000 : 10000;
          return rawRentMax + buffer;
        }
        return rawRentMax;
      })();

      const conditions = {
        rent_max:        itandiEffectiveRentMax,
        walk_minutes:    adjWalk    ? Number(adjWalk)    : (c.walk_minutes || null),
        building_age:    adjAge     ? Number(adjAge)     : (c.building_age || null),
        floor_plan:      adjFloor   || c.floor_plan || c.layout || null,
        is_wide:         searchMode === "wide",
        area_min:        adjAreaMin ? Number(adjAreaMin) : (c.area_min || c.min_area || parseAreaMin(c.floor_plan || c.layout) || parseAreaMin(c.preferences) || parseAreaMin(c.other_requests) || null),
        structure_types: (adjStructure || c.building_structure || c.structure || "")
          .split(/[,、・\/\.\s]+/).map(s => s.trim()).filter(Boolean),
        pet_ok:      adjPet,
        preferences: c.preferences || c.notes || null,
        ward_name:   isWardArea_itandi ? wardName : null,
        ward_names:  isWardArea_itandi && allNeighborhoodWards.length > 0 ? allNeighborhoodWards : null,
        // 区ごとの町域トークンマップ: { "大阪市城東区": ["稲田本町","稲田新町"], "東大阪市": ["川保本町"] }
        ward_town_map: (() => {
          if (!isWardArea_itandi || searchMode === "wide" || neighborhoodTokens.length === 0) return null;
          const m = {};
          neighborhoodTokens.forEach(t => {
            const w = NEIGHBORHOOD_WARD_MAP[t];
            if (!w) return; // WARD_CODE_MAPのみマッチ（フルネーム）は対象外
            if (/[区市郡府県都]$/.test(t)) return; // 区名略称（生野区・浪速区等）は町域ではない
            if (!m[w]) m[w] = [];
            if (!m[w].includes(t)) m[w].push(t);
          });
          return Object.keys(m).length ? m : null;
        })(),
        town_area:   null, // ward_town_mapで代替（後方互換用として残す）
        itandi_lines: !isWardArea_itandi ? itandiLines : [],
        station_names: stationNames,
        unknown_tokens: unknownTokens.length > 0 ? unknownTokens : null,
      };
      // underbar（iframe）モード: postMessage経由 / サイドパネルモード: chrome.tabs.sendMessage経由
      if (isUnderbar) {
        window.parent.postMessage({ from: "aixlinx-underbar", action: "itandi-autofill", conditions }, "*");
      } else {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: "axlx-itandi-autofill", conditions });
        });
      }
      autofillBtn.textContent = "✓ 自動検索中...";
      autofillBtn.classList.add("done");
      setTimeout(() => {
        autofillBtn.textContent = "⚡ itandiに自動入力";
        autofillBtn.classList.remove("done");
      }, 8000);
    };
  } else if (isUnderbar && siteKey === "realpro") {
    autofillBtn.style.display = "block";
    autofillBtn.textContent = "🔍 リアプロで自動検索";
    autofillBtn.className = "autofill-btn";
    // ボタン表示と同時に未登録地名チェック
    showUnknownWarn(computeUnknownTokens(selectedCustomer.desired_area || selectedCustomer.area || ""));

    // 最終送信日・更新日フィールドを表示
    const lastSentRow = document.getElementById("adj-last-sent-row");
    if (lastSentRow) lastSentRow.style.display = "flex";
    const updateDaysRow = document.getElementById("adj-update-days-row");
    if (updateDaysRow) updateDaysRow.style.display = "flex";

    // 「送った」ボタン：今日の日付でDBを更新し日付欄・更新日を即反映
    const markSentBtn = document.getElementById("adj-mark-sent-btn");
    if (markSentBtn) {
      markSentBtn.onclick = async () => {
        const today = new Date().toISOString().split("T")[0];
        markSentBtn.textContent = "更新中...";
        markSentBtn.disabled = true;
        try {
          await fetch(`${API_BASE}/api/property-tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ customer_id: selectedCustomer.id }),
          });
          // 日付欄を今日に更新
          const lastSentEl = document.getElementById("adj-last-sent-date");
          if (lastSentEl) lastSentEl.value = today;
          // 更新日を再計算
          const updateDaysEl = document.getElementById("adj-update-days");
          if (updateDaysEl) updateDaysEl.value = calcUpdateDays(today, selectedCustomer.status);
          // selectedCustomer と allCustomers を更新してバナーも再計算
          const now = new Date().toISOString();
          selectedCustomer = { ...selectedCustomer, last_property_sent_at: now };
          allCustomers = allCustomers.map(c => c.id === selectedCustomer.id ? { ...c, last_property_sent_at: now } : c);
          updateTodayBanner();
          markSentBtn.textContent = "✅ 送った";
        } catch {
          markSentBtn.textContent = "✅ 送った";
        }
        markSentBtn.disabled = false;
      };
    }

    adjForm.style.display = "block";
    const c0 = selectedCustomer;
    preloadAdjForm(c0);

    // ── 駅/地域 切替ボタン（混在条件の検出） ──────────────────────────
    setupAreaModeSelector(c0, "realpro");

    autofillBtn.onclick = () => {
      const c = selectedCustomer;
      // 調整フォームの値を優先して使う
      const adjArea     = document.getElementById("adj-area").value.trim();
      const adjRentMax  = document.getElementById("adj-rent-max").value;
      const adjAreaMin    = document.getElementById("adj-area-min").value;
      const adjWalk       = document.getElementById("adj-walk").value;
      const adjAge        = document.getElementById("adj-age").value;
      const adjFloor      = document.getElementById("adj-floor").value.trim();
      const adjStructure  = document.getElementById("adj-structure").value.trim();
      const adjPet        = document.getElementById("adj-pet").checked;
      const adjUpdateDays = document.getElementById("adj-update-days")?.value || "";
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
      // ボタン押下が絶対ルール: currentAreaMode を buildAreaRouteCodes に渡す
      const { city_codes, route_ids } = buildAreaRouteCodes(adjC, currentAreaMode);

      // 駅名リスト: 駅モードのみ解決（地域モードでは空のまま）
      const adjAreaClean = (adjC.desired_area || adjC.area || "").trim();
      const areaParts = parseAreaTokens(adjAreaClean);
      const realpro_station_names = [];
      if (currentAreaMode === "station") {
        const resolvedStations = [];
        for (const part of areaParts) {
          const station = resolveStation(part);
          if (station) {
            resolvedStations.push(station);
            if (!realpro_station_names.includes(station)) realpro_station_names.push(station);
            if (searchMode === "wide") {
              const adj = getAdjacentStations(station, STATION_LINE_MAP[station] || []);
              adj.forEach(s => { if (!realpro_station_names.includes(s)) realpro_station_names.push(s); });
            }
          }
        }
        // 2駅ペア間の中間駅を展開（「本町〜南森町」のような範囲指定に対応）
        for (let i = 0; i < resolvedStations.length - 1; i++) {
          const intermediate = expandStationRange(resolvedStations[i], resolvedStations[i + 1]);
          intermediate.forEach(s => { if (!realpro_station_names.includes(s)) realpro_station_names.push(s); });
        }
      }

      // 地名マップから町字レベルのトークンを検索（区名・市名は対象外）
      const neighPart = areaParts.find(p =>
        NEIGHBORHOOD_WARD_MAP[p] && !STATION_LINE_MAP[p] &&
        !p.endsWith("区") && !p.endsWith("市")  // 区名・市名はcity_codesで処理するためスキップ
      ) || null;
      // detail_area: 町字名はピンポイントのみ（例:「喜連西」）
      const detailNeighborhood = (searchMode === "pinpoint" && neighPart) ? neighPart : null;
      // detail_ward: detail_areaがある時だけモーダルを使う
      // 区名だけの場合はcity_codesの直接チェックで複数区を同時選択（例:北区+福島区）
      const detailWard = detailNeighborhood ? resolveWard(neighPart) : null;

      // 広げて検索：賃料上限を自動拡張
      // preloadAdjFormで初期値が入るためadjRentMaxは常にtruthy。
      // お客さんのデフォルト値と異なる場合のみ手動変更とみなす。
      const rpRentDefault = c.rent_max || c.max_rent || null;
      const rpRentManualChanged = adjRentMax && rpRentDefault && Number(adjRentMax) !== rpRentDefault;
      const rpEffectiveRentMax = (() => {
        if (!adjC.rent_max) return null;
        if (rpRentManualChanged) return Number(adjRentMax);
        if (searchMode === "wide") {
          const buffer = adjC.rent_max <= 100000 ? 5000 : 10000;
          return adjC.rent_max + buffer;
        }
        return adjC.rent_max;
      })();

      const rpUnknownTokens = computeUnknownTokens(adjAreaClean);
      showUnknownWarn(rpUnknownTokens); // クリック後も最新状態で更新
      window.parent.postMessage({
        from: "aixlinx-underbar",
        action: "autofill",
        conditions: {
          rent_min:      adjC.rent_min,
          rent_max:      rpEffectiveRentMax,
          walk_minutes:  adjC.walk_minutes,
          floor_plan:    adjC.floor_plan,
          is_wide:       searchMode === "wide",
          building_age:  adjC.building_age
            ? (searchMode === "wide" ? adjC.building_age + 5 : adjC.building_age)
            : null,
          city_codes,
          route_ids,
          station_names: realpro_station_names,
          detail_area:   detailNeighborhood,
          detail_ward:   detailWard,
          area_min:        adjAreaMin ? Number(adjAreaMin) : (c.area_min || c.min_area || parseAreaMin(c.floor_plan || c.layout) || parseAreaMin(c.preferences) || parseAreaMin(c.other_requests) || null),
          area_max:        c.area_max || c.max_area || null,
          structure_types: adjC.structure_types,
          pet_ok: adjPet,
          rp_update_days: adjUpdateDays ? Number(adjUpdateDays) : null,
          unknown_tokens: rpUnknownTokens.length > 0 ? rpUnknownTokens : null,
        },
      }, "*");
      autofillBtn.textContent = "⏳ 検索中...";
      autofillBtn.classList.remove("done");
      autofillBtn.classList.add("searching");
      autofillBtn.disabled = true;
    };
  } else if (siteKey === "reins") {
    adjForm.style.display = "block";
    preloadAdjForm(selectedCustomer);
    setupAreaModeSelector(selectedCustomer, "reins");
    autofillBtn.style.display = "block";
    autofillBtn.textContent = "⚡ REINSに自動入力";
    autofillBtn.className = "autofill-btn";
    autofillBtn.onclick = () => {
      const adjC = buildAdjCustomer(selectedCustomer);
      renderInstrSteps("reins", adjC);

      // ボタン押下が絶対ルール: currentAreaMode で駅 or 地域を決定
      const rawArea = (adjC.desired_area || adjC.area || "").trim();
      const areaToks = parseAreaTokens(rawArea);
      const isStationMode = currentAreaMode === "station";

      // 駅モードのみ: 駅ごとに沿線を対応させたペア配列を構築（最大3駅）
      const reinsStationPairs = [];
      if (isStationMode) {
        for (const tok of areaToks) {
          const key = STATION_LINE_MAP[tok] ? tok : tok.replace(/[町村]$/, "");
          const lines = STATION_LINE_MAP[key] || [];
          let reinsLine = null;
          if (lines.length > 0) {
            reinsLine = REINS_LINE_MAP[lines[0]] || lines[0];
          } else if (LEARNED_STATION_MAP[key]?.reins_line) {
            // 学習済みマップからReins路線名を取得
            reinsLine = LEARNED_STATION_MAP[key].reins_line;
          } else if (LEARNED_STATION_MAP[tok]?.reins_line) {
            reinsLine = LEARNED_STATION_MAP[tok].reins_line;
          }
          if (reinsLine && !reinsStationPairs.some(p => p.line === reinsLine)) {
            reinsStationPairs.push({ line: reinsLine, station: key || tok });
          }
          if (reinsStationPairs.length >= 3) break;
        }
      }
      const reinsLine = reinsStationPairs[0]?.line || null;

      const adjPet     = document.getElementById("adj-pet")?.checked ?? false;
      const adjRegDate = document.getElementById("adj-reg-date")?.value || "";
      const conditions = {
        rent_max:       adjC.rent_max || null,
        walk_minutes:   adjC.walk_minutes || null,
        floor_plan:     adjC.floor_plan || null,
        building_age:   adjC.building_age || null,
        is_wide:        searchMode === "wide",
        area_min:       parseAreaMin(adjC.floor_plan) || parseAreaMin(adjC.preferences) || parseAreaMin(adjC.other_requests) || null,
        reins_station_pairs: isStationMode ? reinsStationPairs : [],
        reins_line:     isStationMode ? reinsLine : null,
        station_name:   isStationMode ? (reinsStationPairs[0]?.station || null) : null,
        ward_name:      !isStationMode ? rawArea : null,
        // 区ごとに1行ずつ入れるため、解決済みフル区名の配列を渡す（最大3件）
        ward_names:     !isStationMode ? areaToks.map(tok => {
          const r = resolveWard(tok);
          if (r) return r;                    // "東住吉区" → "大阪市東住吉区"
          if (WARD_CODE_MAP[tok]) return tok; // すでにフル区名
          return tok;                         // 生トークン（フォールバック）
        }).filter(Boolean).slice(0, 3) : [],
        pet_ok:         adjPet,
        reins_reg_date: adjRegDate || null,
      };

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return;
        chrome.tabs.sendMessage(tabs[0].id, {
          type: "axlx-reins-autofill",
          conditions,
        });
      });

      autofillBtn.textContent = "✓ 入力しました！";
      autofillBtn.classList.add("done");
      setTimeout(() => {
        autofillBtn.textContent = "⚡ REINSに自動入力";
        autofillBtn.classList.remove("done");
      }, 3000);
    };
  } else {
    autofillBtn.style.display = "none";
    adjForm.style.display = "none";
    document.getElementById("area-mode-selector").style.display = "none";
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

// ── Search + Account + Linked filter ──────────────────────────────
function getFilteredCustomers(q) {
  let result = allCustomers;
  if (currentAccount) result = result.filter((c) => (c.account || "") === currentAccount);
  if (linkedOnly) result = result.filter((c) => c.is_linked);
  if (todayOnly)  result = result.filter(needsActionToday);
  if (q && q.trim()) {
    const kw = q.trim().toLowerCase();
    result = result.filter((c) =>
      c.customer_name.toLowerCase().includes(kw) ||
      (c.desired_area || "").toLowerCase().includes(kw) ||
      (c.area || "").toLowerCase().includes(kw)
    );
  }
  return result;
}

function filterCustomers(q) {
  renderList(getFilteredCustomers(q));
}

// ── Init ───────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // DBが空なら既存ハードコードデータをシード → 学習済みマップをロード
  seedMapsIfEmpty().then(() => fetchLearnedMaps());
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
      if (e.data?.from === "aixlinx-fill-done") {
        const btn = document.getElementById("autofill-btn");
        if (btn) {
          btn.textContent = "🔍 リアプロで自動検索";
          btn.classList.remove("searching", "done");
          btn.disabled = false;
        }
      }
      // bulk-dl.jsからの顧客名要求（売上番長に送る時に自動反映）
      if (e.data?.from === "axlx-get-customer") {
        window.parent.postMessage({
          from: "axlx-customer-response",
          name: selectedCustomer?.customer_name ?? "",
        }, "*");
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
    loadCustomers(true);
  });

  // 🔗 紐付け済みフィルター
  document.getElementById("linked-filter-btn").addEventListener("click", () => {
    linkedOnly = !linkedOnly;
    document.getElementById("linked-filter-btn").classList.toggle("active", linkedOnly);
    filterCustomers(document.getElementById("search-input").value);
  });

  // 🔥 今日対応バナー（クリックでフィルター）
  document.getElementById("today-banner").addEventListener("click", () => {
    todayOnly = !todayOnly;
    const banner = document.getElementById("today-banner");
    banner.style.background = todayOnly ? "#ff6f00" : "#fff3e0";
    banner.style.color = todayOnly ? "white" : "#e65100";
    filterCustomers(document.getElementById("search-input").value);
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

  document.querySelectorAll(".acct-btn:not(#linked-filter-btn)").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".acct-btn:not(#linked-filter-btn)").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentAccount = btn.dataset.acct;
      filterCustomers(document.getElementById("search-input").value);
    });
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
