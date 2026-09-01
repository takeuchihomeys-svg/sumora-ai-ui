"use strict";

const API_BASE = "https://sumora-ai-ui.vercel.app";

// ── 自動学習マップ（Supabase から起動時に取得・未知トークンは Web検索で自動解決）──
const LEARNED_WARD_MAP    = {};  // 地名 → 市区
const LEARNED_STATION_MAP = {};  // 駅名 → { ward, realpro_lines[], itandi_lines[], reins_line }
const LEARNED_LINE_ORDER  = {};  // 路線名 → 駅配列（順序付き）- DBのline_stationsから起動時にロード

// ── 駅名エイリアス（ひらがな・略称 → 正式駅名）──────────────────────────────
// お客様が口語・ひらがな・略称で入力する場合に正式名に変換する。
// resolveStation の先頭で参照される。
const STATION_ALIASES = {
  // ひらがな
  "なんば":         "難波",
  "うめだ":         "梅田",
  "てんのうじ":     "天王寺",
  "しんさいばし":   "心斎橋",
  "ほんまち":       "本町",
  "しんおおさか":   "新大阪",
  "なかもず":       "中百舌鳥",
  "なんばえき":     "難波",
  "てんま":         "天満",
  "ふくしま":       "福島",
  "にしくじょう":   "西九条",
  "もりのみや":     "森ノ宮",
  "きたはまえき":   "北浜",
  "きたはま":       "北浜",
  "たにまち":       "谷町四丁目",
  "ながほりばし":   "長堀橋",
  "はなてん":       "放出",
  "にしむこう":     "西向日",
  // 略称
  "天六":           "天神橋筋六丁目",
  "てんろく":       "天神橋筋六丁目",
  "天四":           "天神橋筋四丁目",
  "天三":           "天神橋筋三丁目",
  "天二":           "天神橋筋二丁目",
  "谷四":           "谷町四丁目",
  "谷六":           "谷町六丁目",
  "谷九":           "谷町九丁目",
  "今里筋":         "今里",
};

// DB由来の駅→路線マップ（/api/station-route-cache から取得・24時間ローカルキャッシュ）
// null のあいだは getHubLines が既存の STATION_LINE_MAP / LEARNED_STATION_MAP にフォールバックする
let _dbStationRouteMap = null;

// 起動時: DBの駅→路線キャッシュをロード（chrome.storage.local に24時間キャッシュ）
async function fetchStationRouteCache() {
  // ★ 修正(Bug2): v2に版数UP。旧キャッシュには重複キーバグ（新大阪の御堂筋線消失）で
  // 汚染されたデータが24時間TTLで固定化されていたため、キー変更で強制再取得させる
  const CACHE_KEY = "stationRouteCache_v2";
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24時間
  try {
    // 1) ローカルキャッシュ確認（24時間以内ならAPIを叩かず使用）
    const stored = await new Promise((resolve) => {
      try {
        chrome.storage.local.get([CACHE_KEY], (res) => resolve(res || {}));
      } catch (_) { resolve({}); }
    });
    const cached = stored[CACHE_KEY];
    if (cached && cached.data && typeof cached.ts === "number" && (Date.now() - cached.ts) < CACHE_TTL_MS) {
      _dbStationRouteMap = cached.data;
      return _dbStationRouteMap;
    }
    // 2) キャッシュなし/期限切れ → APIから取得（10秒タイムアウト）
    const res = await fetch(`${API_BASE}/api/station-route-cache`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const data = (json && typeof json === "object")
      ? (json.data || json.stations || json)
      : null;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid payload");
    _dbStationRouteMap = data;
    // 3) 取得結果を {data, ts} 形式で保存
    try {
      chrome.storage.local.set({ [CACHE_KEY]: { data, ts: Date.now() } });
    } catch (_) {}
    return _dbStationRouteMap;
  } catch (e) {
    console.warn("[AX] station-route-cache 取得失敗（hardcodedマップにフォールバック）:", e);
    return null;
  }
}

// ハードコードマップとSupabase DBを差分sync（DBにないtokenだけupsert）
async function seedMapsIfEmpty() {
  try {
    const [rRes, sRes] = await Promise.all([
      fetch(`${API_BASE}/api/region-map`),
      fetch(`${API_BASE}/api/station-map`),
    ]);
    const [rd, sd] = await Promise.all([rRes.json(), sRes.json()]);

    const dbRegionTokens  = new Set((rd.regions  || []).map(r => r.token));
    const dbStationTokens = new Set((sd.stations || []).map(s => s.token));

    // DBにないtokenだけ抽出
    const regions = Object.entries(NEIGHBORHOOD_WARD_MAP)
      .filter(([token]) => !dbRegionTokens.has(token))
      .map(([token, ward]) => ({ token, ward, source: "hardcoded", confidence: 100 }));

    const stations = Object.entries(STATION_LINE_MAP)
      .filter(([token]) => !dbStationTokens.has(token))
      .map(([token, rpLines]) => {
        const ward = STATION_WARD_MAP[token] || null;
        const itandiLines = rpLines.flatMap(l => {
          const v = ITANDI_LINE_MAP_FILL[l];
          return v ? (Array.isArray(v) ? v : [v]) : [];
        });
        const reinsLine = REINS_LINE_MAP[rpLines[0]] || null;
        return { token, ward, realpro_lines: rpLines, itandi_lines: itandiLines, reins_line: reinsLine, source: "hardcoded", confidence: 100 };
      });

    if (regions.length === 0 && stations.length === 0) return;

    console.log("[AX] 差分sync: 地名", regions.length, "件 / 駅", stations.length, "件 を追加");
    const res = await fetch(`${API_BASE}/api/seed-maps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ regions, stations }),
    });
    const result = await res.json();
    console.log("[AX] 差分sync完了:", result);
  } catch {
    // ネットワーク一時失敗は無視（次回ロード時に再試行される）
  }
}

// 起動時: 地名・駅マップを一括ロード（タイムアウト付き・失敗時サイレントリトライ）
async function fetchLearnedMaps() {
  const tryFetch = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const [regionRes, stationRes, lineRes] = await Promise.all([
        fetch(`${API_BASE}/api/region-map`,    { cache: "no-store", signal: ctrl.signal }),
        fetch(`${API_BASE}/api/station-map`,   { cache: "no-store", signal: ctrl.signal }),
        fetch(`${API_BASE}/api/line-stations`, { cache: "no-store", signal: ctrl.signal }),
      ]);
      clearTimeout(timer);
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
      if (lineRes.ok) {
        const d = await lineRes.json();
        Object.assign(LEARNED_LINE_ORDER, d.lines || {});
      }
      console.log("[AX] 学習済みロード: 地名", Object.keys(LEARNED_WARD_MAP).length,
        "件 / 駅", Object.keys(LEARNED_STATION_MAP).length,
        "件 / 路線", Object.keys(LEARNED_LINE_ORDER).length, "本");
      return true;
    } catch {
      clearTimeout(timer);
      return false;
    }
  };

  // 1回目試行、失敗したら3秒後に1回リトライ（エラーはサイレント）
  if (await tryFetch()) return;
  await new Promise(r => setTimeout(r, 3000));
  await tryFetch();
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
      const _stV = document.getElementById("adj-area-station")?.value || "";
      const _wdV = document.getElementById("adj-area-ward")?.value || "";
      const areaVal = [_stV, _wdV].filter(Boolean).join("・") || (selectedCustomer.desired_area || selectedCustomer.area || "");
      showUnknownWarn(computeUnknownTokens(areaVal));
      renderInstrSteps(selectedSite, buildAdjCustomer(selectedCustomer));
    }
  } catch (e) {
    console.warn("[AX] 削除失敗:", e.message);
  }
}

// 「✗ 間違い」→正しい市区名が入力された場合: 正解として region_map にupsert（ブロック解除も込み）
async function correctLearnedToken(token, ward) {
  try {
    const res = await fetch(`${API_BASE}/api/region-map`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ward }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // ローカルマップも即時更新（誤learned駅エントリは除去して地名として上書き）
    delete LEARNED_STATION_MAP[token];
    LEARNED_WARD_MAP[token] = ward;
    console.log("[AX] 正解学習:", token, "→", ward, "（次回からDB完全一致で解決）");
    if (selectedCustomer && selectedSite) {
      const _stV2 = document.getElementById("adj-area-station")?.value || "";
      const _wdV2 = document.getElementById("adj-area-ward")?.value || "";
      const areaVal = [_stV2, _wdV2].filter(Boolean).join("・") || (selectedCustomer.desired_area || selectedCustomer.area || "");
      showUnknownWarn(computeUnknownTokens(areaVal));
      renderInstrSteps(selectedSite, buildAdjCustomer(selectedCustomer));
    }
    return true;
  } catch (e) {
    console.warn("[AX] 正解学習失敗:", e.message);
    return false;
  }
}

// 「✗ 間違い」押下時: 正しい市区名の入力フォームをインライン表示
// 入力→保存: 正解をDBに学習（correctLearnedToken）/ わからない: 従来どおり削除＋永久ブロック
function showCorrectionForm(container, token, type) {
  const old = container.querySelector(".token-correct-form");
  if (old) old.remove();
  const div = document.createElement("div");
  div.className = "token-correct-form";
  div.style.cssText = "margin-top:5px;padding:4px;background:#fff3e0;border-radius:4px";
  div.innerHTML = `「${esc(token)}」の正しい市区名: `
    + `<input type="text" class="tc-input" placeholder="例: 富田林市" style="width:110px;font-size:11px;padding:2px 4px;border:1px solid #ccc;border-radius:3px">`
    + ` <button class="tc-save" style="font-size:10px;padding:2px 7px;background:#1a73e8;color:#fff;border:none;border-radius:3px;cursor:pointer">✓ 保存して学習</button>`
    + ` <button class="tc-block" style="font-size:10px;padding:2px 7px;background:#9e9e9e;color:#fff;border:none;border-radius:3px;cursor:pointer">わからない（今後解決しない）</button>`;
  container.appendChild(div);
  const input = div.querySelector(".tc-input");
  input.focus();
  const save = async () => {
    const ward = input.value.trim();
    // 「〇〇市」「大阪市〇〇区」「〇〇郡〇〇町」形式のみ受け付ける
    if (!ward || !/[市区郡]/.test(ward)) {
      input.style.borderColor = "#f44336";
      input.placeholder = "市/区/郡を含めて入力";
      return;
    }
    const btn = div.querySelector(".tc-save");
    btn.disabled = true;
    btn.textContent = "保存中...";
    const ok = await correctLearnedToken(token, ward);
    if (!ok) { btn.disabled = false; btn.textContent = "保存失敗（再試行）"; }
  };
  div.querySelector(".tc-save").addEventListener("click", save);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  div.querySelector(".tc-block").addEventListener("click", () => deleteLearnedToken(token, type));
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
        // 誤学習ガード: 「〜線」で終わるトークン（例: 御堂筋線・学研都市線）がAIに"station"判定されても
        // 駅マップには入れない。実在駅で「線」で終わる駅名は無いため一律スキップで安全。
        // （LEARNED_STATION_MAP汚染 → 線名ガードすり抜け → リアプロで駅選択失敗、の再発防止）
        if (token.endsWith("線")) {
          console.warn("[AX] 「〜線」トークンのため駅学習をスキップ:", token);
          continue;
        }
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

// ── resolve-area API: 路線名・未登録地名を全サイト用コードに変換 ────────────
// 呼び出し条件（background.js の needApi と同一ロジック）:
//   ① 路線名トークン（STATION_LINE_MAPにないもの）がある
//   ② computeUnknownTokens > 0（未登録地名がある）
//   ③ エリア入力はあるのにローカル解決結果が空
//      ＝「マップ上は既知だがコード化できない」トークン（例: NEIGHBORHOOD_WARD_MAP に
//        あるが WARD_CODE_MAP に無い区、路線も所在区も引けない駅）。
//        ①②では検出できず、無条件検索が黙って走っていた。
const _resolveAreaCache = new Map(); // key: `${area}|${mode}`, value: { data, ts }
let _fillDoneWatchdog = null; // fill-done 25秒タイムアウト監視タイマー
const _RESOLVE_AREA_CACHE_MAX = 50;
const _RESOLVE_AREA_CACHE_TTL = 10 * 60 * 1000; // 10分
async function resolveAreaWithAPI(rawArea, areaMode, customerId) {
  if (!rawArea) return null;

  // キャッシュ判定はガードより先。API結果で LEARNED_*_MAP が埋まると
  // hasUnknown / localEmpty が反転し、2回目以降が null を返して
  // 取得済みデータを捨てる（かつ再フェッチを繰り返す）ため。
  const _cacheKey = `${rawArea}|${areaMode}`;
  const _cached = _resolveAreaCache.get(_cacheKey);
  if (_cached && Date.now() - _cached.ts < _RESOLVE_AREA_CACHE_TTL) {
    return _cached.data;
  }

  const toks = parseAreaTokens(rawArea);
  const hasRoute   = toks.some(t => t.endsWith("線") && !STATION_LINE_MAP[t] && !lineNameToRouteId(t));
  const hasUnknown = computeUnknownTokens(rawArea).length > 0;
  // "auto" は最も広く解決するモード → auto で空なら ward/station でも必ず空
  const _local = buildAreaRouteCodes({ desired_area: rawArea }, "auto");
  const localEmpty = !_local.city_codes.length && !_local.route_ids.length;
  // 数字始まり・1文字トークンしかない場合はAPIを無駄打ちしない
  const hasMeaningfulToken = toks.some(t => t.length >= 2 && !/^[0-9０-９]/.test(t));

  // 「梅田から20分以内」「梅田まで電車20分」等の電車通勤時間制約パターンでAPIを呼ぶ
  // 「梅田まで徒歩20分」（徒歩モード）はtransitReで対象駅のみ追加するので API不要
  const hasCommutePattern = /(?:まで|から|へ)(?:電車|バス)?\d+分/.test(rawArea);
  // 乗り換えなし・直通は parseAreaTokens が路線展開するが制約情報は失われるためAPI必須
  const hasTransferNone = /乗り換えなし|直通/.test(rawArea);
  // 通いやすい・アクセスしやすい系は自然言語解析（Haiku）でないと意図が取れない
  const hasCommuteExpression = /通いやすい|アクセスしやすい|通勤しやすい|便利/.test(rawArea);
  // LEARNED_STATION_MAP にあるが realpro_lines が空（壊れたレコード）→ 再解決が必要
  const hasIncompleteLearnedStation = toks.some(t => {
    const entry = LEARNED_STATION_MAP[t];
    return entry && entry.realpro_lines && entry.realpro_lines.length === 0;
  });
  // LEARNED_STATION_MAP に路線名はあるが lineNameToRouteId で全て解決できない
  // （例: "Osaka Metro御堂筋線" 等の非標準表記が混入 → buildAreaRouteCodes が route_id を取れない）
  const hasUnresolvableLearnedStation = toks.some(t => {
    const entry = LEARNED_STATION_MAP[t];
    if (!entry?.realpro_lines?.length) return false;
    return entry.realpro_lines.every(l => !lineNameToRouteId(l));
  });
  // 「鶴見区槇塚」のような 区+地名 複合トークン: resolveWardLoose では区として解決できるが
  // WARD_CODE_MAP/NEIGHBORHOOD_WARD_MAP に直接登録されておらず buildAreaRouteCodes が区コードを落とす
  const hasWardCompoundToken = toks.some(t => {
    if (WARD_CODE_MAP[t] || NEIGHBORHOOD_WARD_MAP[t]) return false;
    return !!resolveWardLoose(t);
  });
  const needApi = hasRoute || hasUnknown || hasCommutePattern || hasTransferNone || hasCommuteExpression || hasIncompleteLearnedStation || hasUnresolvableLearnedStation || hasWardCompoundToken || (localEmpty && hasMeaningfulToken);
  if (!needApi) return null;
  const _triggerReason = hasRoute ? "路線名未解決" : hasUnknown ? "未知トークン" : hasCommutePattern ? "通勤時間制約" : hasTransferNone ? "乗り換えなし/直通" : hasCommuteExpression ? "通勤便利系表現" : hasIncompleteLearnedStation ? "LEARNED駅データ不完全" : hasUnresolvableLearnedStation ? "LEARNED路線名解決不能" : hasWardCompoundToken ? "区+地名複合トークン" : "ローカル解決が空";
  console.log("[AX] resolve-area 呼び出し:", _triggerReason, rawArea);
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 10000);
    // タイムアウト短縮: 10s でタイムアウトして既知情報のみで検索（固まり防止）
    // 通常: Claude NL抽出(~3s) + DeepSeek fallback(~9s) → 初回未知トークンは null 返却で ok
    const res = await fetch(`${API_BASE}/api/resolve-area`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ desired_area: rawArea, area_mode: areaMode }),
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!res.ok) return null;
    const data = await res.json();
    // 新規学習をローカルキャッシュに反映
    (data.new_stations || []).forEach(({ token, ward, realpro_lines, itandi_lines, reins_line }) => {
      if (!LEARNED_STATION_MAP[token]) {
        LEARNED_STATION_MAP[token] = { ward, realpro_lines: realpro_lines || [], itandi_lines: itandi_lines || [], reins_line: reins_line || null };
        console.log("[AX] resolve-area 駅学習:", token, "→", ward);
      }
    });
    (data.new_regions || []).forEach(({ token, ward }) => {
      if (!LEARNED_WARD_MAP[token]) {
        LEARNED_WARD_MAP[token] = ward;
        console.log("[AX] resolve-area 地名学習:", token, "→", ward);
      }
    });
    // LRU: 上限超過時は最古エントリを削除
    if (_resolveAreaCache.size >= _RESOLVE_AREA_CACHE_MAX) {
      const _oldestKey = [..._resolveAreaCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0][0];
      _resolveAreaCache.delete(_oldestKey);
    }
    _resolveAreaCache.set(_cacheKey, { data, ts: Date.now() });
    // area_normalized をDBに書き戻し（fire-and-forget: ネットワーク失敗は無視）
    if (customerId && data?.normalized_area) {
      fetch(`${API_BASE}/api/property-customers`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: customerId, area_normalized: data.normalized_area }),
      }).catch(() => {});
      console.log("[AX] area_normalized 書き戻し:", data.normalized_area, "→ customer", customerId);
    }
    return data;
  } catch (e) {
    console.warn("[AX] resolve-area 失敗:", e.message);
    return null;
  }
}

// ── 物件検索ブレイン: RAG統合エンドポイント ──────────────────────────────────
// resolve-area + 顧客条件 + 送付履歴 を1本にまとめて返す。
// レスポンスは resolve-area と同一キー構造のため apiData として既存コードがそのまま動く。
// 追加フィールド: exclude_property_keys / sent_summary / recommendation / nearby_stations
const _brainParamsCache = new Map(); // customerId_area → {data, ts}
const _BRAIN_PARAMS_CACHE_TTL = 5 * 60 * 1000; // 5分

async function fetchBrainSearchParams(customerId, rawArea) {
  if (!customerId) return null;
  const _key = `${customerId}|${rawArea || ""}`;
  const _cached = _brainParamsCache.get(_key);
  if (_cached && Date.now() - _cached.ts < _BRAIN_PARAMS_CACHE_TTL) return _cached.data;

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 15000);
    const params = new URLSearchParams({ customerId });
    if (rawArea) params.set("area", rawArea);
    const res = await fetch(`${API_BASE}/api/property-brain/search-params?${params}`, {
      signal: ctrl.signal,
    });
    clearTimeout(tid);
    if (!res.ok) return null;
    const data = await res.json();

    // resolve-area と同じ学習キャッシュ更新（コード再利用）
    (data.new_stations || []).forEach(({ token, ward, realpro_lines, itandi_lines, reins_line }) => {
      if (!LEARNED_STATION_MAP[token]) {
        LEARNED_STATION_MAP[token] = { ward, realpro_lines: realpro_lines || [], itandi_lines: itandi_lines || [], reins_line: reins_line || null };
        console.log("[BRAIN] 駅学習:", token, "→", ward);
      }
    });
    (data.new_regions || []).forEach(({ token, ward }) => {
      if (!LEARNED_WARD_MAP[token]) {
        LEARNED_WARD_MAP[token] = ward;
        console.log("[BRAIN] 地名学習:", token, "→", ward);
      }
    });

    // hold 警告（連続未返信2件以上で催促リスク）
    if (data.recommendation === "hold") {
      console.warn(`[BRAIN] ⚠️ ${data.property_send_count}件連続未返信。物件検索を保留推奨。`);
    }
    if (data.exclude_property_keys?.length > 0) {
      console.log(`[BRAIN] 除外リスト ${data.exclude_property_keys.length}件:`, data.exclude_property_keys.slice(0, 5));
    }

    _brainParamsCache.set(_key, { data, ts: Date.now() });
    return data;
  } catch (e) {
    console.warn("[BRAIN] fetchBrainSearchParams 失敗:", e.message);
    return null;
  }
}

// 地名 → 市区の解決（NEIGHBORHOOD_WARD_MAP → LEARNED_WARD_MAP → 市サフィックス補完 の順に参照）
function resolveWard(token) {
  if (NEIGHBORHOOD_WARD_MAP[token]) return NEIGHBORHOOD_WARD_MAP[token];
  if (LEARNED_WARD_MAP[token]) return LEARNED_WARD_MAP[token];
  // 市サフィックス補完: 「富田林」→「富田林市」「羽曳野」→「羽曳野市」
  // WARD_CODE_MAP に実在する市名のみ（AI・fuzzy検索に頼らずコスト0で正解できる）
  if (WARD_CODE_MAP[token + "市"]) return token + "市";
  return null;
}

// 「鶴見区横堤」→「鶴見区」→「大阪市鶴見区」のように先頭の市区郡部分で部分一致解決
function resolveWardLoose(token) {
  const direct = resolveWard(token);
  if (direct) return direct;
  if (WARD_CODE_MAP[token]) return token;
  // 先頭の「〜市/区/郡」部分を切り出して再解決（「鶴見区横堤」→「鶴見区」）
  const m = token.match(/^(.+?[市区郡])/);
  if (m) {
    const partial = m[1];
    const r = resolveWard(partial) || (WARD_CODE_MAP[partial] ? partial : null);
    if (r) return r;
  }
  return null;
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

// セパレーターなしで連結された複数駅名を分解（例: "寝屋川萱島大和田古川橋門真" → ["寝屋川市","萱島","大和田","古川橋","門真市"]）
// 区名連結にも対応（例: "西区北区都島区中央区" → ["大阪市西区","大阪市北区","大阪市都島区","大阪市中央区"]）
function decomposeToken(token) {
  if (token.length < 4) return null;
  const keys = Object.keys(STATION_LINE_MAP);
  // 候補: 完全一致 + "市/区"なしバリアント（寝屋川→寝屋川市 など）
  const candidates = [];
  for (const k of keys) {
    candidates.push({ match: k, result: k });
    if (k.endsWith("市") || k.endsWith("区")) {
      candidates.push({ match: k.slice(0, -1), result: k });
    }
  }
  candidates.sort((a, b) => b.match.length - a.match.length);
  const n = token.length;
  const dp = new Array(n + 1).fill(null);
  dp[0] = [];
  for (let i = 1; i <= n; i++) {
    for (const { match, result } of candidates) {
      const len = match.length;
      if (i >= len && token.slice(i - len, i) === match && dp[i - len] !== null) {
        dp[i] = [...dp[i - len], result];
        break;
      }
    }
  }
  if (dp[n] !== null && dp[n].length >= 2) return dp[n];
  // 第2フォールバック: NEIGHBORHOOD_WARD_MAP + WARD_CODE_MAP で連結区名を分解
  const wardCands = [];
  for (const [k, v] of Object.entries(NEIGHBORHOOD_WARD_MAP)) {
    wardCands.push({ match: k, result: v });
  }
  for (const k of Object.keys(WARD_CODE_MAP)) {
    if (!wardCands.find(c => c.match === k)) wardCands.push({ match: k, result: k });
  }
  wardCands.sort((a, b) => b.match.length - a.match.length);
  const dp2 = new Array(n + 1).fill(null);
  dp2[0] = [];
  for (let i = 1; i <= n; i++) {
    for (const { match, result } of wardCands) {
      const len = match.length;
      if (i >= len && token.slice(i - len, i) === match && dp2[i - len] !== null) {
        dp2[i] = [...dp2[i - len], result];
        break;
      }
    }
  }
  if (dp2[n] !== null && dp2[n].length >= 2) return dp2[n];
  // 第3フォールバック: 区/市名+駅名のハイブリッド分解（例: "鶴見区横堤" → ["大阪市鶴見区", "横堤"]）
  // 駅名が末尾に付いた「地名+駅名」連結パターン（"鶴見区横堤"など）を検出する
  const stKeys = Object.keys(STATION_LINE_MAP).sort((a, b) => b.length - a.length);
  for (const stk of stKeys) {
    if (token.endsWith(stk) && stk.length < token.length) {
      const wardPart = token.slice(0, token.length - stk.length);
      if (wardPart.length >= 1) {
        const ward = resolveWard(wardPart) || (WARD_CODE_MAP[wardPart] ? wardPart : null);
        if (ward) return [ward, stk];
      }
    }
  }
  // 第4フォールバック: 路線名+駅名の連結分解（例: "谷町線駒川中野" → ["駒川中野"]）
  // 路線名部分は返さない: 返すと autofill で「路線名→全線展開」ルートに入り谷町線全駅が選択されてしまうため
  // 駅名だけ返せば STATION_LINE_MAP から路線が自動判定される
  for (const stk of stKeys) {
    if (token.endsWith(stk) && stk.length < token.length) {
      const linePart = token.slice(0, token.length - stk.length);
      if (linePart.endsWith("線") && linePart.length >= 2) {
        return [stk];
      }
    }
  }
  return null;
}

// 「第一希望:枚方市」「大阪府以外:奈良」などのラベルプレフィックスと方向サフィックスを除去してエリアトークンを分解
function parseAreaTokens(rawArea) {
  if (!rawArea) return [];
  // 「大阪市内（環状線エリア）」「梅田（御堂筋線エリア）」→ 路線名トークンに変換（ward展開より先に処理）
  rawArea = rawArea.replace(
    /[^\s,、・\/（(]*[（(]([^)）]*?線)(?:エリア)?[）)]/g,
    (_, lineName) => lineName.trim()
  );
  // 「大阪市内(北区、都島区)」→「大阪市北区,大阪市都島区」に展開（括弧除去より先に処理）
  rawArea = rawArea.replace(
    /([^\s,、・\/（(]{1,8}市)内?[（(]([^)）]+)[）)]/g,
    (_, city, wardList) =>
      wardList
        .split(/[,、・\/\s]+/)
        .map(w => w.trim())
        .filter(w => w.length > 0)
        .map(w => (w.startsWith(city) ? w : city + w))
        .join(",")
  );
  // 「路線名（駅A〜駅B）」→ 区間内の駅リストに展開（例: おおさか東線（野江〜放出）→ JR野江,鴫野,放出）
  rawArea = rawArea.replace(/([ぁ-鿿\w]+線)[（(]([^)）〜～]+)[〜～]([^)）]+)[）)]/g, function(match, lineName, fromStr, toStr) {
    const rangeStations = expandLineRange(lineName, fromStr.trim(), toStr.trim());
    if (rangeStations && rangeStations.length > 0) return rangeStations.join(",");
    return lineName; // 解決できない場合は路線名のみ（全線動作）
  });
  // 括弧内の補足説明を除去（「西中島南方（〜じゃなくても可、大阪市内）」→「西中島南方」）
  rawArea = rawArea.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "").trim();
  // 「野田阪神駅・住之江駅へ乗り換え1回で行けるところ」→ 1乗り換え到達路線に展開
  rawArea = rawArea.replace(
    /([^\s,、\/（(]{1,40})(?:から|へ|に)?乗り換え[1一]回(?:で行けるところ|以内)?/g,
    (_, stationsStr) => {
      const hubs = stationsStr
        .split(/[・,、\/]/)
        .map(s => s.replace(/駅$/, "").trim())
        .filter(s => s.length > 0);
      const expanded = getOneTransferLines(hubs);
      return expanded.length > 0 ? expanded.join(",") : stationsStr;
    }
  );
  // 「大阪市内の御堂筋線」→「大阪市内,御堂筋線」に分割（市内/府内 + 線名の複合表現）
  rawArea = rawArea.replace(/([^\s,、・\/（(]*(?:市内|府内))の([^\s,、・\/（(]+線)/g, "$1,$2");
  // 「江坂まで20分くらいの」→「江坂」（時間ベースエリア表現から目的駅名を抽出）
  // 数字+分 が続く「まで」「から」は場所指定用。AからBまで展開より先に処理する。
  rawArea = rawArea.replace(/([^\s,、・\/（(]{1,8})駅?まで(?:徒歩|電車|バス|歩いて)?\d+分[^,、・\/]*/g, "$1");
  rawArea = rawArea.replace(/([^\s,、・\/（(]{1,8})駅?から(?:徒歩|電車|バス|歩いて)?\d+分[^,、・\/]*/g, "$1");
  // 「AあたりからBあたりまで」「AからBまで」「A〜B」「A～B」→ 両端点をカンマで展開
  const expanded = rawArea
    .replace(/([^\s,、・\/～〜]+?)あたりから([^\s,、・\/～〜]+?)あたりまで/g, "$1,$2")
    .replace(/([^\s,、・\/～〜]+?)から([^\s,、・\/～〜]+?)まで/g, "$1,$2")
    .replace(/([^\s,、・\/]+?)[〜～]([^\s,、・\/]+)/g, function(match, from, to) {
      const fromClean = from.replace(/駅$|あたり$/g, "").trim();
      const toClean   = to.replace(/駅$|あたり$/g, "").trim();
      const intermediate = expandStationRange(fromClean, toClean);
      // 中間駅があれば「布施,河内永和,河内小阪,八戸ノ里」のように両端+中間を展開
      if (intermediate && intermediate.length > 0) {
        return [fromClean, ...intermediate, toClean].join(",");
      }
      return fromClean + "," + toClean;
    })
    // 「Aか B」「AやB」「AまたはB」→ カンマ区切りに変換（例:「豊崎か北区」→「豊崎,北区」）
    .replace(/([^\s,、・\/～〜]{1,10})\s*[かや]\s*([^\s,、・\/～〜]{1,10})/g, "$1,$2");
  const raw = expanded
    .split(/[,、・\/\s]+|又は|もしくは|など/)
    .map(t => t.replace(/^[^:]+:/, "")             // 「第一希望:」「第二希望:」「大阪府以外:」などを除去
                .replace(/以南$|以北$|以西$|以東$/, "") // 方向サフィックスを除去
                .replace(/の[南北東西](の方)?$|の方$/, "") // 「八尾の南の方」→「八尾」「東淀川の方」→「東淀川」
                .replace(/通勤\d+分圏内|通勤\d+分以内|\d+分圏内/g, "") // 「通勤20分圏内」などを除去
                .replace(/(?:徒歩|電車|バス|歩いて)?\d+分(?:以内|圏内)/g, "") // 「徒歩20分以内」などを除去
                .replace(/駅|周辺|付近|近く|近辺|沿線|エリア|あたり/g, "")
                .replace(/[かや]$/, "")  // 「〜駅か」→駅除去後に残る末尾助詞を除去
                .trim())
    .map(normalizeNumerals)
    .filter(t => t.length >= 1);
  // 連結駅名を自動分解（例: "寝屋川萱島大和田古川橋門真"）
  const result = [];
  for (const t of raw) {
    const decomposed = decomposeToken(t);
    if (decomposed) result.push(...decomposed);
    else result.push(t);
  }
  return result;
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
  // ひらがな・略称エイリアス解決（例: "なんば" → "難波", "天六" → "天神橋筋六丁目"）
  const _aliased = STATION_ALIASES[clean];
  if (_aliased && (STATION_LINE_MAP[_aliased] || LEARNED_STATION_MAP[_aliased])) return _aliased;
  if (STATION_LINE_MAP[clean]) return clean;                                 // 完全一致（ハードコード）
  if (LEARNED_STATION_MAP[clean]) return clean;                             // 完全一致（学習済み）
  // の/ノ・ヶ/ケ 表記ゆれ正規化（「八戸の里」→「八戸ノ里」）
  const normKana = clean.replace(/の/g, "ノ").replace(/ヶ/g, "ケ");
  if (normKana !== clean) {
    if (STATION_LINE_MAP[normKana]) return normKana;
    if (LEARNED_STATION_MAP[normKana]) return normKana;
  }
  // 地域名ガード: 市・区・郡・市内・通り・丁目・地区などで終わるトークンは駅名のあいまい一致に回さない
  // （例: "大阪市内" → "大阪" 駅、"京橋通り" → "京橋" 駅 への誤変換を防止。
  //   摂津市駅・堺市駅など実在の「〜市」駅は上の完全一致で既に解決済みなのでここには来ない）
  if (/(?:市内|府内|県内|都内|[市区郡都府県]|通り|丁目|地区)$/.test(clean)) return null;
  // 「茨木市など北摂」のように市区郡を含むが STATION_LINE_MAP に完全一致しない複合トークンは地域名と判断
  if (/[市区郡]/.test(clean) && !STATION_LINE_MAP[clean]) return null;
  const keys = Object.keys(STATION_LINE_MAP);
  const sw = keys.find(k => k.startsWith(clean) && clean.length >= 2);
  if (sw) return sw;
  // WARD_CODE_MAP に登録済みの市名（茨木市・摂津市等）が複合トークン内で駅と誤判定されるのを防ぐ
  const ci = keys.find(k => clean.includes(k) && k.length >= 2 && !WARD_CODE_MAP[k]);
  if (ci) return ci;
  const ki = keys.find(k => k.includes(clean) && clean.length >= 2);
  if (ki) return ki;
  // 学習済みマップでも検索
  const lKeys = Object.keys(LEARNED_STATION_MAP);
  const lk = lKeys.find(k => k === clean || k.includes(clean) || clean.includes(k));
  if (lk) return lk;
  return null;
}

// 既知駅マップに存在するかチェック（APIレスポンス検証・地域名の混入防止）
// STATION_LINE_MAP（ハードコード）/ _dbStationRouteMap（DB）/ LEARNED_STATION_MAP（学習済み）の順に照合
function isKnownStation(name) {
  const clean = (name || '').replace(/駅$/, '').trim();
  if (!clean || clean.length < 2) return false;
  if (STATION_LINE_MAP[clean]) return true;
  if (_dbStationRouteMap && _dbStationRouteMap[clean]) return true;
  if (typeof LEARNED_STATION_MAP !== 'undefined' && LEARNED_STATION_MAP[clean]) return true;
  return false;
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


// 「路線名（駅A〜駅B）」の区間内駅リストを LINE_STATION_ORDER から取得
// 駅名のJR・阪急等のプレフィックスを正規化して曖昧一致（野江→JR野江）
function expandLineRange(lineName, fromStation, toStation) {
  const order = LINE_STATION_ORDER[lineName] || (typeof LEARNED_LINE_ORDER !== 'undefined' && LEARNED_LINE_ORDER[lineName]) || [];
  if (!order.length) return null;
  const stripPfx = s => s.replace(/^(?:JR|近鉄|阪急|阪神|南海|京阪|地下鉄)\s*/, '').trim();
  const fromNorm = stripPfx(fromStation), toNorm = stripPfx(toStation);
  const fromIdx = order.findIndex(s => s === fromStation || stripPfx(s) === fromNorm);
  const toIdx   = order.findIndex(s => s === toStation   || stripPfx(s) === toNorm);
  if (fromIdx < 0 || toIdx < 0) return null;
  const lo = Math.min(fromIdx, toIdx), hi = Math.max(fromIdx, toIdx);
  return order.slice(lo, hi + 1);
}

// 同一事業者の複数路線は最初の1路線に絞る
// 例: 十三 = ["阪急電鉄神戸線","阪急電鉄宝塚線","阪急電鉄京都線"] → ["阪急電鉄神戸線"]
// 異事業者混在（大阪市高速軌道 + 阪急電鉄等）はそのまま全路線返す
function deduplicateSameOperatorLines(lines) {
  if (!lines || lines.length <= 1) return lines;
  let prefix = lines[0];
  for (let i = 1; i < lines.length; i++) {
    let j = 0;
    while (j < prefix.length && j < lines[i].length && prefix[j] === lines[i][j]) j++;
    prefix = prefix.slice(0, j);
  }
  return prefix.length >= 2 ? [lines[0]] : lines;
}


// 当駅が属する路線上の前後各1駅を返す（重複なし）
// LINE_STATION_ORDER（ハードコード）→ LEARNED_LINE_ORDER（DB）の順で参照
function getAdjacentStations(stationName, lines) {
  const adj = new Set();
  for (const line of (lines || [])) {
    const order = LINE_STATION_ORDER[line] || LEARNED_LINE_ORDER[line] || [];
    const idx = order.indexOf(stationName);
    if (idx > 0) adj.add(order[idx - 1]);
    if (idx >= 0 && idx < order.length - 1) adj.add(order[idx + 1]);
  }
  return [...adj];
}

// BFS: startStation から maxTransfers 回乗換以内で到達できる全駅を返す
// TRANSIT_GRAPH (transit_graph.js) を参照。未ロード時は startStation のみ返す
function getStationsWithinTransfers(startStation, maxTransfers) {
  if (typeof TRANSIT_GRAPH === 'undefined' || !TRANSIT_GRAPH[startStation]) return [startStation];

  const results = new Set([startStation]);
  // BFS: state = { station, line, transfers }
  const queue = [{ station: startStation, line: null, transfers: 0 }];
  const visited = new Map(); // "station|line" → min transfers used

  while (queue.length) {
    const { station, line, transfers } = queue.shift();
    const node = TRANSIT_GRAPH[station];
    if (!node) continue;

    // 隣接駅（同一路線・乗換なし or 路線変更で+1）
    for (const edge of Object.values(node.adj || {})) {
      const neighbor = edge[0] ?? edge.to;
      const edgeLine = edge[1] ?? edge.line;
      const cost = (line && line !== edgeLine) ? 1 : 0;
      const newT = transfers + cost;
      const key = neighbor + '|' + edgeLine;
      if (newT <= maxTransfers && (!visited.has(key) || visited.get(key) > newT)) {
        visited.set(key, newT);
        results.add(neighbor);
        queue.push({ station: neighbor, line: edgeLine, transfers: newT });
      }
    }

    // 名称乗換（物理的な徒歩接続、例: 梅田↔大阪）
    if (transfers < maxTransfers) {
      for (const xfer of (node.transfers || [])) {
        if (!results.has(xfer)) {
          results.add(xfer);
          queue.push({ station: xfer, line: null, transfers: transfers + 1 });
        }
      }
    }
  }

  results.delete(startStation);
  return [...results];
}

// Dijkstra: startStation から maxMinutes 分以内で到達できる全駅を返す
// 戻り値: [{ station, minutes }, ...] （到達時間昇順、出発駅を除く）
function getStationsWithinMinutes(startStation, maxMinutes) {
  if (typeof TRANSIT_GRAPH === 'undefined' || !TRANSIT_GRAPH[startStation]) return [];

  const minTime = {};
  minTime[startStation + '|'] = 0;
  const queue = [{ station: startStation, line: null, minutes: 0 }];

  while (queue.length) {
    queue.sort((a, b) => a.minutes - b.minutes);
    const { station, line, minutes } = queue.shift();

    const stateKey = station + '|' + (line || '');
    if (minutes > (minTime[stateKey] ?? Infinity) + 0.1) continue;

    const node = TRANSIT_GRAPH[station];
    if (!node) continue;

    for (const edge of Object.values(node.adj || {})) {
      const neighbor = edge[0] ?? edge.to;
      const edgeLine  = edge[1] ?? edge.line;
      const edgeTime  = edge[2] ?? edge.time ?? 3;

      // 路線切り替えペナルティ（transfer エッジ自体にはペナルティ不要、transfer経由後の最初の路線もスキップ）
      const penalty = (line && line !== 'transfer' && line !== edgeLine && edgeLine !== "transfer") ? 3 : 0;
      const total   = minutes + edgeTime + penalty;

      const neighborKey = neighbor + '|' + (edgeLine || '');
      if (total <= maxMinutes && (minTime[neighborKey] === undefined || minTime[neighborKey] > total)) {
        minTime[neighborKey] = total;
        queue.push({ station: neighbor, line: edgeLine, minutes: total });
      }
    }
  }

  // station|line キーから駅ごとの最短時間を集約（マルチ路線ハブの重複を除去）
  const stationMin = {};
  for (const [key, t] of Object.entries(minTime)) {
    const [s] = key.split('|');
    if (s !== startStation && (stationMin[s] === undefined || stationMin[s] > t)) {
      stationMin[s] = t;
    }
  }

  return Object.entries(stationMin)
    .sort((a, b) => a[1] - b[1])
    .map(([s, t]) => ({ station: s, minutes: Math.round(t) }));
}

function getStationNamesWithinMinutes(startStation, maxMinutes) {
  return getStationsWithinMinutes(startStation, maxMinutes).map(r => r.station);
}

let currentSearchMode = 'transfer';
function setSearchMode(mode) {
  currentSearchMode = mode;
  document.getElementById('transferCountDiv').style.display = mode === 'transfer' ? 'flex' : 'none';
  document.getElementById('travelTimeDiv').style.display = mode === 'time' ? 'flex' : 'none';
  document.getElementById('modeTransfer').classList.toggle('active-mode', mode === 'transfer');
  document.getElementById('modeTime').classList.toggle('active-mode', mode === 'time');
  updateTransferCountLabel();
  if (selectedSite) renderInstrSteps(selectedSite, buildAdjCustomer(selectedCustomer));
}

// ── エリア条件テキスト自動パース ─────────────────────────────────────

const AREA_STATION_ALIASES = {
  "大阪梅田": "梅田",
  "てんのうじ": "天王寺",
  "テンノウジ": "天王寺",
  "おおさか": "大阪",
  "うめだ": "梅田",
};

/**
 * parseAreaCondition(text)
 * DB の desired_area / area フィールドをパースしてオブジェクトを返す
 * mode: "time"     → { station, mode, minutes }
 * mode: "transfer" → { station, mode, transfers }
 * mode: "vicinity" → { station, mode }
 * 複数条件 → Array  /  認識不能 → null
 */
function parseAreaCondition(text) {
  if (!text || typeof text !== "string") return null;

  function kanjiToNum(s) {
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const T = { 零:0, 〇:0, 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9, 十:10, 百:100 };
    let r = 0, cur = 0;
    for (const ch of s) {
      const n = T[ch];
      if (n == null) continue;
      if (n >= 10) { r += (cur || 1) * n; cur = 0; } else cur = n;
    }
    return r + cur;
  }

  function normalizeStation(raw) {
    const name = raw.replace(/(?:駅|から|まで|へ|で)$/, "").trim();
    if (!name || /^[零〇一二三四五六七八九十百\d]+$/.test(name)) return null;
    return AREA_STATION_ALIASES[name] || name;
  }

  const NUM = `(?:\\d+|[零〇一二三四五六七八九十百]+)`;

  function parseSingle(t) {
    t = t.trim();
    if (!t) return null;
    let m;
    // 直通
    m = t.match(/^(.+?)(?:駅)?直通$/);
    if (m) { const s = normalizeStation(m[1]); if (s) return { station: s, mode: "transfer", transfers: 0 }; }
    // 所要時間
    m = t.match(new RegExp(`^(.+?)(?:駅)?(?:から|まで|へ)?(?:(?:電車|徒歩)で?)?(${NUM})分(?:以内|くらい|程度|圏内)?$`));
    if (m) { const s = normalizeStation(m[1]); if (s) return { station: s, mode: "time", minutes: kanjiToNum(m[2]) }; }
    // 乗り換え
    m = t.match(new RegExp(`^(.+?)(?:駅)?(?:から|まで|で)?乗り換え(?:(なし|ゼロ)|(${NUM})回?(?:以内|まで)?)$`));
    if (m) { const s = normalizeStation(m[1]); if (s) return { station: s, mode: "transfer", transfers: m[2] ? 0 : kanjiToNum(m[3]) }; }
    // 周辺
    m = t.match(/^(.+?)(?:駅)?(?:周辺|付近|エリア|近く|近辺|界隈)$/);
    if (m) { const s = normalizeStation(m[1]); if (s) return { station: s, mode: "vicinity" }; }
    return null;
  }

  const parts = text.split(/[、，,・\/]/);
  if (parts.length > 1) {
    const results = parts.map(parseSingle).filter(Boolean);
    if (results.length === 0) return null;
    return results.length === 1 ? results[0] : results;
  }
  return parseSingle(text);
}

/**
 * applyParsedCondition(parsed)
 * parseAreaCondition の結果を Transfer UI に反映し、自動認識バナーを表示する
 */
function applyParsedCondition(parsed) {
  if (!parsed) return;

  // 不明な駅名はバナーを出さずサイレントスキップ（misleading UX防止）
  const stationExists = parsed.station && (
    (typeof STATION_LINE_MAP !== 'undefined' && STATION_LINE_MAP[parsed.station]) ||
    (typeof TRANSIT_GRAPH !== 'undefined' && TRANSIT_GRAPH[parsed.station])
  );
  if (!stationExists) {
    console.warn('[applyParsedCondition] 未知の駅名のためスキップ:', parsed.station);
    return;
  }

  // View 3 がアクティブでない場合はバナーもUI変更も行わない
  // （#transfer-search-row はDOM上で常に存在するため element の有無ではなく active クラスで判定）
  if (!document.getElementById('view-instructions')?.classList.contains('active')) return;
  const row = document.getElementById('transfer-search-row');
  if (!row) return;

  // バナー表示（クリックで即消し・4秒で自動消滅）
  let banner = document.getElementById('auto-parse-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'auto-parse-banner';
    banner.style.cssText = [
      'position:fixed', 'bottom:68px', 'left:50%', 'transform:translateX(-50%)',
      'background:#1565C0', 'color:#fff', 'padding:5px 14px', 'border-radius:20px',
      'font-size:12px', 'cursor:pointer', 'z-index:9999',
      'box-shadow:0 2px 8px rgba(0,0,0,.3)', 'white-space:nowrap', 'transition:opacity .3s',
    ].join(';');
    banner.onclick = () => banner.remove();
    document.body.appendChild(banner);
  }

  if (parsed.mode === 'vicinity') {
    banner.textContent = `🤖 ${parsed.station} 周辺を自動認識`;
    setTimeout(() => banner?.remove(), 3000);
    return;
  }

  // チェックボックスON・オプション表示
  const cb = document.getElementById('enableTransfer');
  if (cb && !cb.checked) {
    cb.checked = true;
    const opts = document.getElementById('transfer-options');
    if (opts) opts.style.display = 'flex';
  }

  if (parsed.mode === 'time') {
    setSearchMode('time');
    const sel = document.getElementById('maxMinutes');
    if (sel) {
      const MINUTE_OPTIONS = [15, 20, 30, 45, 60];
      const snappedMinutes = MINUTE_OPTIONS.reduce((best, opt) =>
        Math.abs(opt - (parsed.minutes || 30)) < Math.abs(best - (parsed.minutes || 30)) ? opt : best
      );
      sel.value = String(snappedMinutes);
    }
    banner.textContent = `🤖 自動設定済み: ${parsed.station} から ${parsed.minutes}分以内`;
  } else {
    setSearchMode('transfer');
    const sel = document.getElementById('maxTransfers');
    if (sel) sel.value = String(parsed.transfers ?? 1);
    const transferLabel = parsed.transfers === 0 ? '直通' : `乗り換え${parsed.transfers}回以内`;
    banner.textContent = `🤖 自動設定済み: ${parsed.station} ${transferLabel}`;
  }

  updateTransferCountLabel();
  setTimeout(() => banner?.remove(), 4000);
}

function getExpandedStations(startStation) {
  const enabled = document.getElementById('enableTransfer')?.checked;
  if (!enabled) return [startStation];
  if (currentSearchMode === 'time') {
    const maxMin = parseInt(document.getElementById('maxMinutes')?.value || '30');
    return [startStation, ...getStationNamesWithinMinutes(startStation, maxMin)];
  } else {
    const maxT = parseInt(document.getElementById('maxTransfers')?.value || '1');
    return [startStation, ...getStationsWithinTransfers(startStation, maxT)];
  }
}

// 「AからBまで」範囲指定の中間駅を展開する（両端は含まない）
// - 駅名を正規化（あたり/駅 除去・の→ノ・ヶ→ケ・鉄道会社プレフィックス除去）してマッチング
// ① 同一路線上に両駅がある → その間の全駅を返す
// ② ない場合 → 1ホップ探索（A路線の駅 X が B路線にも属する → X〜Bの中間駅を返す）
function expandStationRange(stationA, stationB) {
  const norm = s => s
    .replace(/駅$|あたり$/g, "")
    .replace(/の/g, "ノ").replace(/ヶ/g, "ケ")
    .replace(/^(?:JR|近鉄|阪急|阪神|南海|京阪|大阪メトロ|地下鉄)\s*/, "")
    .trim();
  const normA = norm(stationA), normB = norm(stationB);
  if (!normA || !normB || normA === normB) return [];
  // 正規化後の名前で STATION_LINE_MAP のキーを逆引き
  const findKey = (n) => STATION_LINE_MAP[n]
    ? n
    : (Object.keys(STATION_LINE_MAP).find(k => norm(k) === n) || null);
  const keyA = findKey(normA) || stationA;
  const keyB = findKey(normB) || stationB;
  const linesA = STATION_LINE_MAP[keyA] || LEARNED_STATION_MAP[stationA]?.realpro_lines || [];
  const linesB = STATION_LINE_MAP[keyB] || LEARNED_STATION_MAP[stationB]?.realpro_lines || [];
  const getOrder = (line) => LINE_STATION_ORDER[line] || LEARNED_LINE_ORDER[line] || [];
  // 路線配列上のインデックスを正規化マッチで検索
  const findIdx = (order, n) => order.findIndex(s => norm(s) === n);
  const result = [];

  // ① 直接共通路線
  for (const line of linesA) {
    if (!linesB.includes(line)) continue;
    const order = getOrder(line);
    const idxA = findIdx(order, normA), idxB = findIdx(order, normB);
    if (idxA === -1 || idxB === -1) continue;
    const from = Math.min(idxA, idxB), to = Math.max(idxA, idxB);
    for (let i = from + 1; i < to; i++) {
      if (!result.includes(order[i])) result.push(order[i]);
    }
    return result; // 直接共通があれば終了
  }

  // ② 1ホップ探索: A側の各路線を走査して B側の路線につながる中間駅を探す
  for (const lineA of linesA) {
    const orderA = getOrder(lineA);
    const idxA = findIdx(orderA, normA);
    if (idxA === -1) continue;
    for (const mid of orderA) {
      if (norm(mid) === normA) continue;
      const linesMid = STATION_LINE_MAP[mid] || LEARNED_STATION_MAP[mid]?.realpro_lines || [];
      for (const lineMid of linesMid) {
        if (!linesB.includes(lineMid)) continue;
        const orderMid = getOrder(lineMid);
        const idxMid = findIdx(orderMid, norm(mid)), idxB = findIdx(orderMid, normB);
        if (idxMid === -1 || idxB === -1) continue;
        if (!result.includes(mid)) result.push(mid);
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
// 難波・心斎橋エリア = 中央区・浪速区・西区 の広げて検索クラスター
const NAMBA_CLUSTER_CODES = ["27128", "27111", "27106"]; // 中央区・浪速区・西区
const NAMBA_CLUSTER_WARDS = ["大阪市中央区", "大阪市浪速区", "大阪市西区"];

// 乗換時間込みで到達可能駅を返す（METRO_GRAPH + Dijkstra使用）
function getTransitStations(targetStation, maxMin) {
  if (typeof getReachableStations === 'undefined') return [];
  return getReachableStations(targetStation, maxMin);
}

// 地域モード+広げて検索で難波クラスター内のコードがあれば3区全部追加
function expandNambaCodes(city_codes) {
  if (!NAMBA_CLUSTER_CODES.some(code => city_codes.includes(code))) return city_codes;
  const expanded = [...city_codes];
  NAMBA_CLUSTER_CODES.forEach(code => { if (!expanded.includes(code)) expanded.push(code); });
  return expanded;
}

function expandNambaWards(ward_names) {
  if (!NAMBA_CLUSTER_WARDS.some(w => ward_names.includes(w))) return ward_names;
  const expanded = [...ward_names];
  NAMBA_CLUSTER_WARDS.forEach(w => { if (!expanded.includes(w)) expanded.push(w); });
  return expanded;
}

// 路線名 → route_id 解決（表記ゆれ吸収）
// 「御堂筋線」(短縮名) / 「大阪市高速軌道御堂筋線」(リアプロ内部名) / 「大阪市高速電気軌道御堂筋線」(大阪メトロ現名称・学習データに混入しがち)
// のいずれでも route_id を返す。解決できなければ null。
function lineNameToRouteId(name) {
  if (!name) return null;
  if (LINE_ROUTE_MAP[name]) return LINE_ROUTE_MAP[name];
  const alias = (typeof LINE_ALIAS_MAP !== 'undefined' && LINE_ALIAS_MAP[name]) || null;
  if (alias && LINE_ROUTE_MAP[alias]) return LINE_ROUTE_MAP[alias];
  // 表記ゆれ正規化: 「大阪市高速電気軌道」「大阪メトロ」「地下鉄」→ リアプロ内部名「大阪市高速軌道」
  // route.ts の resolveLineInternal と同じ変換規則を適用（APIとローカルで統一）
  const normalized = name
    .replace("大阪市高速電気軌道", "大阪市高速軌道")
    .replace(/^大阪メトロ/, "大阪市高速軌道")
    .replace(/^地下鉄/, "大阪市高速軌道");
  if (LINE_ROUTE_MAP[normalized]) return LINE_ROUTE_MAP[normalized];
  // サフィックス一致（例: 学習データの「Osaka Metro御堂筋線」等 → 「大阪市高速軌道御堂筋線」）
  const hit = Object.keys(LINE_ROUTE_MAP).find(k => k.endsWith(name) || name.endsWith(k));
  return hit ? LINE_ROUTE_MAP[hit] : null;
}

// 路線名 → LINE_ROUTE_MAP 内部キー（STATION_LINE_MAP の値と同形式）を返す
function lineNameToInternalName(name) {
  if (!name) return null;
  if (LINE_ROUTE_MAP[name]) return name;
  const alias = (typeof LINE_ALIAS_MAP !== 'undefined' && LINE_ALIAS_MAP[name]) || null;
  if (alias && LINE_ROUTE_MAP[alias]) return alias;
  const normalized = name.replace("大阪市高速電気軌道", "大阪市高速軌道").replace(/^大阪メトロ/, "大阪市高速軌道");
  if (LINE_ROUTE_MAP[normalized]) return normalized;
  const hit = Object.keys(LINE_ROUTE_MAP).find(k => k.endsWith(name) || name.endsWith(k));
  return hit || null;
}

// 路線名 → その路線に属する全駅名リスト（LEARNED_LINE_ORDER 優先、なければ STATION_LINE_MAP 反転）
function getStationsForLine(name) {
  const internalName = lineNameToInternalName(name);
  if (!internalName) return [];
  const ordered = LEARNED_LINE_ORDER[internalName];
  if (ordered && ordered.length > 0) return ordered;
  return Object.keys(STATION_LINE_MAP).filter(s => (STATION_LINE_MAP[s] || []).includes(internalName));
}

// ハブ駅展開: 「梅田」→ 梅田・東梅田・西梅田・大阪梅田・大阪 の全路線をまとめて返す
// ハブでない場合は単一駅の路線リストをそのまま返す
function getHubLines(stationKey) {
  const hubStations = (typeof STATION_HUB_MAP !== "undefined" && STATION_HUB_MAP[stationKey])
    ? STATION_HUB_MAP[stationKey]
    : [stationKey];
  const lines = [];
  for (const st of hubStations) {
    // DBキャッシュ（_dbStationRouteMap）を最優先。値は配列 or {realpro_lines:[...]} の両形式に対応
    let dbLines = null;
    if (_dbStationRouteMap) {
      const v = _dbStationRouteMap[st];
      if (Array.isArray(v)) dbLines = v;
      else if (v && Array.isArray(v.realpro_lines)) dbLines = v.realpro_lines;
    }
    // ★ 修正(Bug2): DBキャッシュ単独優先 → ローカルマップとの和集合に変更。
    // seedMapsIfEmpty は既存DB行を修復しないため、重複キーバグ時代に汚染された
    // DB行（新大阪=東海道本線・おおさか東線のみ等）が残っていても、
    // ローカルマップの正しい路線（御堂筋線）が欠落しないようにする
    const localLines = STATION_LINE_MAP[st] || LEARNED_STATION_MAP[st]?.realpro_lines || [];
    const stLines = (dbLines && dbLines.length > 0)
      ? dbLines.concat(localLines.filter(l => !dbLines.includes(l)))
      : localLines;
    for (const l of stLines) {
      if (!lines.includes(l)) lines.push(l);
    }
  }
  return lines;
}

// 指定駅から乗り換え1回で到達できる全路線名を返す（STATION_LINE_MAP を逆引き）
function getOneTransferLines(hubStations) {
  const lines = new Set();
  for (const rawSt of hubStations) {
    const candidates = (typeof STATION_HUB_MAP !== "undefined" && STATION_HUB_MAP[rawSt])
      ? STATION_HUB_MAP[rawSt]
      : [rawSt];
    for (const st of candidates) {
      const directLines = STATION_LINE_MAP[st] || LEARNED_STATION_MAP[st]?.realpro_lines || [];
      for (const line of directLines) lines.add(line);
      // 直通路線に属する全駅のSTATION_LINE_MAPエントリから乗り換え路線を収集
      for (const line of directLines) {
        for (const stLines of Object.values(STATION_LINE_MAP)) {
          if (stLines.includes(line)) {
            for (const tl of stLines) lines.add(tl);
          }
        }
      }
    }
  }
  return [...lines];
}

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
  const _stationRoutePairs = []; // 駅モード用: greedy covering set 計算に使用
  for (const part of parts) {
    // 広域地名マップ（北摂・河内等: 1トークン→複数市区）を最優先でチェック
    if (MULTI_WARD_MAP[part]) {
      MULTI_WARD_MAP[part].forEach(ward => {
        if (WARD_CODE_MAP[ward] && !city_codes.includes(WARD_CODE_MAP[ward]))
          city_codes.push(WARD_CODE_MAP[ward]);
      });
      continue;
    }
    if (mode === "ward") {
      // 地域モード: WARD_CODE_MAP → NEIGHBORHOOD_WARD_MAP のみ。路線IDは追加しない
      // resolveWardLoose を使い「鶴見区横堤」→「鶴見区」のような区名+駅名連結トークンも正しく解決する
      if (WARD_CODE_MAP[part]) {
        if (!city_codes.includes(WARD_CODE_MAP[part])) city_codes.push(WARD_CODE_MAP[part]);
      } else {
        const neighWard = resolveWardLoose(part);
        if (neighWard && WARD_CODE_MAP[neighWard] && !city_codes.includes(WARD_CODE_MAP[neighWard]))
          city_codes.push(WARD_CODE_MAP[neighWard]);
      }
      continue;
    }
    if (mode === "station") {
      // 駅モード: 線名トークン（例: 御堂筋線）→ lineNameToRouteId で路線ID直指定
      // （「〜線」で終わる実在駅は除外。路線として解決できない場合は従来通り駅解決にフォールスルー）
      // ※ LEARNED_STATION_MAP は判定に使わない: 「御堂筋線」が駅として誤学習される事故（2026-06-24 web_search由来）で
      //   ガードがすり抜け、駅名として送信→リアプロで死ぬバグがあった。路線として解決できるなら学習データより優先する。
      // 都市名・府県名トークンを駅として解決しない（「大阪・難波」の「大阪」が大阪環状線になるのを防ぐ）
      const AREA_PREFIX_SKIP = new Set(["大阪", "大阪府", "東京", "京都", "神戸", "兵庫", "奈良", "大阪市"]);
      if (AREA_PREFIX_SKIP.has(part)) continue;
      if (part.endsWith('線') && !STATION_LINE_MAP[part]) {
        const lineId = lineNameToRouteId(part);
        if (lineId) {
          if (!route_ids.includes(lineId)) route_ids.push(lineId);
          continue;
        }
      }
      // 駅モード: 路線IDのみ追加（city_codesは追加しない → 所在地フィールドに入らないようにする）
      let station = resolveStation(part);
      // 「阪急茨木市」「JR高槻」等: 市サフィックスガードでnull→resolveWithLinePrefixesで再解決
      if (!station) {
        const _pfxR = resolveWithLinePrefixes(part);
        if (_pfxR?.type === "station") station = _pfxR.resolved;
      }
      const stationKey = station || part;
      const lines = getHubLines(stationKey);
      const _stIds = [];
      lines.forEach(l => { const id = lineNameToRouteId(l); if (id && !_stIds.includes(id)) _stIds.push(id); });
      _stationRoutePairs.push({ stationKey, routeIds: _stIds });
      continue;
    }
    // auto: 従来の自動判定
    if (WARD_CODE_MAP[part]) {
      if (!city_codes.includes(WARD_CODE_MAP[part])) city_codes.push(WARD_CODE_MAP[part]);
      continue;
    }
    // 「大阪市内」トークン → 大阪市全区コード
    if (part === '大阪市内') {
      Object.entries(WARD_CODE_MAP)
        .filter(([k]) => k.startsWith('大阪市'))
        .forEach(([, v]) => { if (!city_codes.includes(v)) city_codes.push(v); });
      continue;
    }
    // 短縮線名（例: 御堂筋線）→ LINE_ALIAS_MAP → LINE_ROUTE_MAP
    if (part.endsWith('線') && typeof LINE_ALIAS_MAP !== 'undefined') {
      const fullLineName = LINE_ALIAS_MAP[part] || part;
      const lineId = LINE_ROUTE_MAP[fullLineName];
      if (lineId && !route_ids.includes(lineId)) route_ids.push(lineId);
      continue;
    }
    const neighWard = resolveWard(part);
    // LEARNED_STATION_MAPに収録済みの駅は地域ガードを通過させない（学習済み駅が地域扱いされるバグ修正）
    const _isLearnedSt = LEARNED_STATION_MAP[part]?.realpro_lines?.length > 0;
    if (neighWard && !STATION_LINE_MAP[part] && !_isLearnedSt) {
      if (WARD_CODE_MAP[neighWard] && !city_codes.includes(WARD_CODE_MAP[neighWard]))
        city_codes.push(WARD_CODE_MAP[neighWard]);
      continue;
    }
    let station = resolveStation(part);
    // 「阪急茨木市」「JR高槻」等: 市サフィックスガードでnull→resolveWithLinePrefixesで再解決
    if (!station) {
      const _pfxR = resolveWithLinePrefixes(part);
      if (_pfxR?.type === "station") station = _pfxR.resolved;
    }
    const stationKey = station || part;
    const ward = STATION_WARD_MAP[stationKey] || findStationWard(part);
    if (ward && WARD_CODE_MAP[ward] && !city_codes.includes(WARD_CODE_MAP[ward])) city_codes.push(WARD_CODE_MAP[ward]);
    const lines = getHubLines(stationKey); // ハブ駅展開
    // LINE_ROUTE_MAP[l] 直参照ではなく lineNameToRouteId() 経由で表記ゆれ吸収
    // 学習データの「Osaka Metro〇〇線」等も正しく route_id に変換できる
    lines.forEach(l => { const id = lineNameToRouteId(l); if (id && !route_ids.includes(id)) route_ids.push(id); });
  }
  // 駅モード: 各駅の全沿線IDをそのまま追加（駅に紐づく全路線を対象にする）
  if (mode === "station" && _stationRoutePairs.length > 0) {
    _stationRoutePairs.forEach(p => {
      p.routeIds.forEach(rid => { if (!route_ids.includes(rid)) route_ids.push(rid); });
    });
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

      // 明示的な地域/駅フィールドがある場合はそちらを優先（UI 2フィールド化対応）
      const _explWard = (c.area_ward    || "").trim();
      const _explSt   = (c.area_station || "").trim();
      if (_explWard && !_explSt)  areaMode = "ward";
      if (_explSt)                areaMode = "station"; // 駅があれば駅優先

      // areaText は「駅フィールド > 地域フィールド > d.area」の順で使う
      const areaText = _explSt || _explWard || d.area || "";
      const areaClean = normalizeNumerals(areaText.replace(/周辺|付近|近く|エリア/g, "").trim());
      const _resolvedWard = resolveWard(areaClean);
      const neighborhoodWard = (_resolvedWard && !STATION_LINE_MAP[areaClean]) ? _resolvedWard : null;

      // ボタン押下 or 明示フィールドが絶対ルール。未選択時のみ自動判定
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

      // 地域・駅の両フィールドが埋まっている場合: 地域ステップを先に追加
      if (_explWard && _explSt) {
        const _wToks = parseAreaTokens(_explWard);
        const _multiWard = _wToks.length >= 2 && _wToks.every(t => !!WARD_CODE_MAP[t]) ? _wToks.join("　") : null;
        steps.push({
          num: n++,
          field: "【所在地】絞り込み",
          value: _multiWard || _explWard,
          hint: "左メニュー「所在地絞り込み ＋」をクリック → 都道府県を選択 → 市区郡を選択 → 右側「詳細な地域の設定へ進む ›」→ 地域を選択 → 「確定してリストへ」",
        });
        // 駅ステップは既存ロジックで続けて追加（areaMode = "station" 設定済み）
      }

      // ── STEP: エリア絞り込み ──
      if (areaText) {
        if (isLocation && !isStation) {
          // 市・区・府・県など → 所在地
          // 連結区名（例:「西区北区都島区中央区」）→「大阪市西区　大阪市北区　...」に展開
          let multiWardLabel = null;
          if (!neighborhoodWard) {
            const wardToks = parseAreaTokens(areaClean);
            if (wardToks.length >= 2 && wardToks.every(t => !!WARD_CODE_MAP[t])) {
              multiWardLabel = wardToks.join("　");
            }
          }
          const locationValue = multiWardLabel
            ? multiWardLabel
            : neighborhoodWard
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
          // トークン単位で「駅名」か「路線名（全線）」かを判別して個別ステップ表示
          const toks = parseAreaTokens(areaText);
          const _routeCandidates = toks.filter(t => t.endsWith("線") && !STATION_LINE_MAP[t] && !STATION_LINE_MAP[t.replace(/[町村]$/, "")]);
          const _stCandidates = toks.filter(t => !_routeCandidates.includes(t));
          const lineToks = _routeCandidates.filter(routeTok => {
            const routeInternal = lineNameToInternalName(routeTok) || routeTok;
            const isContextRoute = _stCandidates.some(stTok => {
              const stLines = findStationLines(stTok) ||
                              (LEARNED_STATION_MAP[stTok] && LEARNED_STATION_MAP[stTok].realpro_lines) || [];
              return stLines.some(sl => sl === routeInternal || sl === routeTok);
            });
            return !isContextRoute;
          });
          const stToks = _stCandidates;  // 路線候補トークンを完全に除外した残り

          // 駅名ステップ
          if (stToks.length > 0) {
            const stFirst = stToks[0];
            // STATION_LINE_MAP → LEARNED_STATION_MAP の順でフォールバック（学習済み駅でも隣接駅を表示）
            const lines = findStationLines(stFirst)
              || (LEARNED_STATION_MAP[stFirst]?.realpro_lines?.length ? LEARNED_STATION_MAP[stFirst].realpro_lines : null)
              || findStationLines(areaText);
            const linesText = lines ? lines.join(" / ") : null;
            let wideStationNote = null;
            if (d.isWide) {
              // linesがnullでも「隣の駅も選択する」ガイドは常に表示
              const adj = lines ? getAdjacentStations(stFirst, lines) : [];
              wideStationNote = adj.length > 0
                ? "広げて：" + stFirst + " ＋ 前後の駅「" + adj.join("・") + "」も追加で選択する"
                : "広げて：この駅 ＋ 隣の駅も追加で選択する（「駅名から絞り込み」で隣駅を検索）";
            }
            steps.push({
              num: n++,
              field: "【沿線・駅】絞り込み",
              value: stToks.join("・"),
              linesNote: linesText ? "選択する沿線: " + linesText : null,
              note: wideStationNote,
              hint: "左メニュー「沿線・駅絞り込み ＋」→「駅名から絞り込み」に駅名を入力 → 上記の沿線を選択 → 右側「駅の設定へ進む ›」→ 駅を選択 → 「確定してリストへ」",
            });
            if (d.isWide) {
              const ward = findStationWard(stFirst);
              steps.push({
                num: n++,
                field: "【所在地でも検索】広げてオプション",
                value: ward ? ward : stFirst + " 周辺の市区",
                note: ward ? stFirst + " がある市区 → 所在地でも検索して候補を広げる" : "この駅がある市区を所在地で検索して候補を広げる",
                hint: "左メニュー「所在地絞り込み ＋」→ 都道府県 → 市区郡（上記の市区）→ 詳細地域 → 「確定してリストへ」",
              });
            }
          }

          // 路線名ステップ（全線）
          lineToks.forEach(ln => {
            // 短縮線名（例: 御堂筋線）→ 正式名（大阪市高速軌道御堂筋線）を併記
            const fullLn = (typeof LINE_ALIAS_MAP !== 'undefined' && LINE_ALIAS_MAP[ln]) || ln;
            steps.push({
              num: n++,
              field: "【沿線・駅】絞り込み（全線）",
              value: (fullLn !== ln ? ln + "（" + fullLn + "）" : ln) + "：全線",
              hint: "左メニュー「沿線・駅絞り込み ＋」→「沿線から絞り込み」に路線名を入力 → 路線を選択 → 「全駅を選択」→ 「確定してリストへ」",
            });
          });

          // どちらも空（parseAreaTokens が機能しなかった場合）→ 元のareaTextで表示
          if (stToks.length === 0 && lineToks.length === 0) {
            const lines = findStationLines(areaText);
            steps.push({
              num: n++,
              field: "【沿線・駅】絞り込み",
              value: areaText,
              linesNote: lines ? "選択する沿線: " + lines.join(" / ") : null,
              hint: "左メニュー「沿線・駅絞り込み ＋」→「駅名から絞り込み」に駅名を入力 → 上記の沿線を選択 → 右側「駅の設定へ進む ›」→ 駅を選択 → 「確定してリストへ」",
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

      // ── STEP 2b: 電車での通勤距離（Dijkstra展開済み）──
      // 「○○駅まで電車で△分」「○○まで乗り換えX回で△分」形式。徒歩・bare パターンは対象外
      if (d.commuteByTrain) {
        steps.push({
          num: n++,
          field: "電車での通勤距離",
          value: d.commuteByTrain.station + "まで電車で" + d.commuteByTrain.minutes + "分以内",
          hint: "Dijkstra展開で到達可能な駅を自動選択済み。絞り込み欄への追加入力は不要",
        });
      }

      // ── STEP 2c: 乗り換え回数（お客さんが明示した場合のみ）──
      if (d.transferCount) {
        steps.push({
          num: n++,
          field: "乗り換え回数",
          value: d.transferCount.text,
          hint: "通勤ルートの乗り換え回数制限（自動展開時の Dijkstra 探索条件）",
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
          value: "面積下限を自動で −5㎡ 引き下げ（例: 25㎡以上 → 20㎡以上）",
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
      // ITANDI_LINE_MAP_FILL（popup-maps.js）と内容を統一。手順書ステップ表示に使用。
      // ※ カッコは ITANDI UI に合わせて半角。配列値は最初の項目を使用（近鉄難波・奈良線・東海道本線）
      const ITANDI_LINE_MAP = {
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
        "南海電鉄泉北線":                   "南海泉北線(泉北線)",   // 追加: 未変換だったため
        "南海電鉄空港線":                   "南海空港線",
        "南海電鉄汐見橋線":                 "南海汐見橋線",         // 追加
        "南海電鉄多奈川線":                 "南海多奈川線",         // 追加
        "南海電鉄高師浜線":                 "南海高師浜線",         // 追加
        "京阪電気鉄道京阪線":               "京阪本線",
        "京阪電気鉄道中之島線":             "京阪中之島線",
        "京阪電気鉄道交野線":               "京阪交野線",
        "大阪モノレール本線":               "大阪モノレール線",
        "大阪モノレール彩都線":             "国際文化公園都市線(大阪モノレール彩都線)",
        "能勢電鉄":                         "能勢電鉄妙見線",
        "能勢電鉄妙見線":                   "能勢電鉄妙見線",       // 追加
        "能勢電鉄日生線":                   "能勢電鉄日生線",       // 追加
        "近鉄難波・奈良線":                 "近鉄難波線/近鉄奈良線",
        "近鉄南大阪線":                     "近鉄南大阪線",
        "近鉄大阪線":                       "近鉄大阪線",
        "近鉄長野線":                       "近鉄長野線",
        "近鉄道明寺線":                     "近鉄道明寺線",
        "近鉄けいはんな線":                 "近鉄けいはんな線",
        "近鉄信貴線":                       "近鉄信貴線",           // 追加
        "近鉄西信貴ケーブル線":             "近鉄西信貴鋼索線(西信貴ケーブル)", // 追加
        "水間鉄道水間線":                   "水間鉄道水間線",       // 追加
        "おおさか東線":                     "おおさか東線",
        "大阪環状線":                       "JR大阪環状線",
        "JR東西線":                         "JR東西線",
        "片町線":                           "JR片町線(学研都市線)",     // 全角→半角括弧に統一
        "阪和線":                           "阪和線(天王寺～和歌山)",   // 全角→半角括弧に統一
        "東海道本線":                       "JR東海道本線(京都～大阪)(JR京都線)", // FILL版に合わせ
        "福知山線":                         "JR福知山線(新大阪～篠山口)(JR宝塚線)", // 経由区間を追記
        "関西本線":                         "JR関西本線(加茂～ＪＲ難波)(大和路線)", // 経由区間を追記
        "桜島線":                           "JR桜島線(JRゆめ咲線)",
        "関西空港線":                       "JR関西空港線",         // 追加
        "阪堺電気軌道阪堺線":               "阪堺電軌阪堺線",
        "阪堺電気軌道上町線":               "阪堺電軌上町線",
      };

      // 駅に対応するitandi路線名を取得（STATION_LINE_MAP → LEARNED_STATION_MAP の順）
      const _itandiToks = parseAreaTokens(rawArea);
      const _itandiStTok = _itandiToks.find(t =>
        STATION_LINE_MAP[t] ||
        (LEARNED_STATION_MAP[t] && LEARNED_STATION_MAP[t].itandi_lines && LEARNED_STATION_MAP[t].itandi_lines.length > 0)
      );
      const stationKey_i = _itandiStTok || (rawArea ? rawArea.replace(/駅|周辺|付近|近く/g, "").trim() : "");
      const stationLines_i = getHubLines(stationKey_i); // ハブ駅展開（梅田→御堂筋+谷町+四つ橋+阪急3線+阪神等）
      let itandiLines;
      if (stationLines_i.length > 0) {
        itandiLines = stationLines_i.map(l => ITANDI_LINE_MAP[l] || l);
      } else if (LEARNED_STATION_MAP[stationKey_i]?.itandi_lines?.length > 0) {
        itandiLines = LEARNED_STATION_MAP[stationKey_i].itandi_lines;
      } else {
        itandiLines = [];
      }
      const linesNote = itandiLines.length ? itandiLines.join(" / ") : null;

      // ペット条件の検出（動物種名も含む）
      const petNote = c.pet === true || /ペット|pet|犬|猫|ねこ|豆柴|マメ柴|柴犬|小型犬|中型犬|大型犬|動物飼育|動物可/i.test([c.preferences, c.notes, c.other_requests, c.additional_conditions].filter(Boolean).join(" ")) ? "ページ最下部「入居条件（その他）」→「ペット相談」にチェック" : null;

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
        // _o: 電車通勤・乗り換え回数で追加されるステップ数（num の基底に加算）
        ...(function() {
          const _o = (d.commuteByTrain ? 1 : 0) + (d.transferCount ? 1 : 0);
          return [
            d.commuteByTrain ? {
              num: 4,
              field: "電車での通勤距離",
              value: d.commuteByTrain.station + "まで電車で" + d.commuteByTrain.minutes + "分以内",
              hint: "Dijkstra展開で到達可能な駅を自動選択済み。絞り込み欄への追加入力は不要",
            } : null,
            d.transferCount ? {
              num: 4 + (d.commuteByTrain ? 1 : 0),
              field: "乗り換え回数",
              value: d.transferCount.text,
              hint: "通勤ルートの乗り換え回数制限（自動展開時の探索条件）",
            } : null,
            {
              num: 4 + _o,
              field: "間取り",
              value: d.floorPlan,
              hint: "「間取り」セクションのチェックボックスから選択（1R〜5K以上）",
            },
            {
              num: 5 + _o,
              field: "築年数",
              value: d.buildingAge,
              hint: "「築年数」欄に数字を入力（例：15 → 15年以内）",
            },
            {
              num: 6 + _o,
              field: "特記設備",
              value: d.preferences,
              hint: "バス・トイレ別はサイドバー「バス・トイレ」→「バス・トイレ別」をチェック",
            },
            {
              num: 7 + _o,
              field: "NG条件（確認用）",
              value: d.ngPoints,
              hint: "この条件に当てはまる物件は候補から除外",
            },
            petNote ? {
              num: 8 + _o,
              field: "ペット相談",
              value: "チェックあり",
              hint: petNote,
            } : null,
          ];
        })(),
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
      const _reinsToks = parseAreaTokens(rawArea);
      const _reinsStTok = _reinsToks.find(t =>
        STATION_LINE_MAP[t] ||
        (LEARNED_STATION_MAP[t] && LEARNED_STATION_MAP[t].reins_line)
      );
      const stationKey = _reinsStTok || rawArea.replace(/駅|周辺|付近|近く/g, "").trim();
      const stationLines = stationKey ? getHubLines(stationKey) : []; // ハブ駅展開
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

      // 電車での通勤距離（Dijkstra展開済み）
      if (d.commuteByTrain) {
        steps.push({
          num: n++,
          field: "電車での通勤距離",
          value: d.commuteByTrain.station + "まで電車で" + d.commuteByTrain.minutes + "分以内",
          hint: "Dijkstra展開で到達可能な駅を自動選択済み。絞り込み欄への追加入力は不要",
        });
      }

      // 乗り換え回数（お客さんが明示した場合のみ）
      if (d.transferCount) {
        steps.push({
          num: n++,
          field: "乗り換え回数",
          value: d.transferCount.text,
          hint: "通勤ルートの乗り換え回数制限（自動展開時の探索条件）",
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
    areaMin:      (function() {
      const raw = c.floor_area_min || parseAreaMin(c.floor_plan) || parseAreaMin(c.preferences) || parseAreaMin(c.other_requests) || null;
      if (!raw || mode !== "wide") return raw;
      return Math.max(0, raw - 5); // 広げて検索: 面積下限を -5㎡ 自動引き下げ
    })(),
    areaMax:      c.floor_area_max || null,
    petOk:        c.pet === true,
    walkMin:      c.walk_minutes ? c.walk_minutes + "分以内" : null,
    commuteByTrain: (function() {
      const rawText = c.desired_area || c.area || "";
      // ① 電車/バス 明示パターン「○○まで電車で45分」
      let m = rawText.match(/([^\s、。,　]{1,10}?)駅?(?:まで|から)(?:電車|バス)で?(\d+)分/);
      // ② 乗り換えX回+分数パターン「○○まで乗り換え1回で30分」（電車省略でも乗り換え指定なら電車確定）
      if (!m) m = rawText.match(/([^\s、。,　]{1,10}?)駅?(?:まで|から)乗り換え\d+回[^\d]*(\d+)分/);
      if (!m) return null;
      const station = m[1].replace(/^(?:JR|阪急|阪神|南海|近鉄|京阪|大阪メトロ|地下鉄)\s*/, "").trim();
      const mins = parseInt(m[2], 10);
      return (station && mins > 0) ? { station: station, minutes: mins } : null;
    })(),
    transferCount: (function() {
      const allText = [c.desired_area, c.area, c.preferences, c.other_requests].filter(Boolean).join(" ");
      // 直通・乗り換えなし
      if (/乗り換えなし|乗換なし|直通/.test(allText)) return { transfers: 0, text: "なし（直通）" };
      // 乗り換えX回 / X回乗り換え（各種表記）
      const m = allText.match(/(?:乗り換え|乗換え?)(\d+)回|(\d+)回(?:乗り換え|乗換え?)/);
      if (!m) return null;
      const n = parseInt(m[1] || m[2], 10);
      return { transfers: n, text: n + "回以内" };
    })(),
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

// 敷金礼金なし希望の検出（ng_points / preferences / other_requests から）
function detectShikireiFlag(c) {
  const text = `${c.preferences || ""} ${c.ng_points || ""} ${c.other_requests || ""}`;
  return /敷礼なし|敷金礼金なし|敷金礼金0|敷金0礼金0|敷0礼0/.test(text);
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
let _areaModeSource = "auto"; // "auto"=静的/API自動判定, "user"=手動クリック — "user"のときAPIによる上書きを禁止
let currentAccount = ""; // "" = すべて / "sumora" / "ieyasu" / "giga" / "hasu"
let currentAreaTypeFilter = ""; // "" = all / "station" = 駅 / "ward" = 地域
let linkedOnly = true;   // 紐付け済みのみ表示（デフォルトON・初期表示を軽くする）
let todayOnly  = false;  // 今日対応のみ表示
const selectedCustomerIds = new Set(); // 一括検索: チェック中の顧客IDセット（文字列）

// アプリの「要対応」と同じ基準: linked_conversation.is_flagged === true かつ申込後ステータス除外
var _POST_APPLY_STATUSES = new Set(["applying", "screening", "contract", "closed_won", "closed_lost"]);
function needsActionToday(c) {
  var conv = c.linked_conversation;
  if (!conv || !conv.is_flagged) return false;
  return !_POST_APPLY_STATUSES.has(conv.status);
}

function isCompletedToday(c) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return !!(
    (c.last_property_sent_at  && new Date(c.last_property_sent_at)  >= today) ||
    (c.property_viewed_at     && new Date(c.property_viewed_at)     >= today)
  );
}

function isViewedToday(c) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return !!(c.property_viewed_at && new Date(c.property_viewed_at) >= today);
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
  // ビュー切替時に残留バナーを即時削除（View 2 でサイトボタンの上に被らないように）
  document.getElementById('auto-parse-banner')?.remove();
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
      filterCustomers(document.getElementById("search-input")?.value || "");
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
    filterCustomers(document.getElementById("search-input")?.value || "");
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

  // 一括検索チェックボックス — stopPropagation で行クリックと分離
  list.querySelectorAll(".bulk-check-wrap").forEach((wrap) => {
    wrap.addEventListener("click", (e) => e.stopPropagation());
  });
  list.querySelectorAll(".bulk-check").forEach((cb) => {
    const id = cb.dataset.id;
    if (selectedCustomerIds.has(id)) cb.checked = true; // フィルタ再描画後も選択状態を復元
    cb.addEventListener("change", () => {
      if (cb.checked) selectedCustomerIds.add(id);
      else selectedCustomerIds.delete(id);
      updateBulkToolbar();
    });
  });

  list.querySelectorAll(".viewed-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (btn.classList.contains("viewed-done")) return;
      await markPropertyViewed(btn.dataset.id);
    });
  });
}

function computeAreaModeBadgeHtml(areaText) {
  if (!areaText) return '';
  const toks = parseAreaTokens(areaText);
  // 駅判定: setupAreaModeSelector の hasStationToken と同一基準
  // ・WARD_CODE_MAP収録トークン（守口市・摂津市など市名と衝突する駅名）は駅扱いしない
  // ・LEARNED_STATION_MAP は realpro_lines 必須（路線名誤学習レコードの混入防止・2026-06-24事故対策）
  const _cpRe = /^(?:阪急|阪神|南海|近鉄|JR|京阪|大阪メトロ|地下鉄)/;
  const isStationToken = (t) => {
    if (WARD_CODE_MAP[t]) return false;
    const vs = [t, t.replace(/[町村]$/, ""), t.replace(_cpRe, ""), t.replace(_cpRe, "").replace(/[町村]$/, "")];
    return vs.some(v => STATION_LINE_MAP[v] || (LEARNED_STATION_MAP[v]?.realpro_lines?.length > 0)) ||
      Object.values(REINS_LINE_MAP).some(v => v === t || v.endsWith(t));
  };
  const hasStation = /駅|線/.test(areaText) || toks.some(isStationToken);
  // 地域判定: 市区郡府県サフィックス or WARD_CODE_MAP or resolveWardLoose
  // ・resolveWardLoose = NEIGHBORHOOD_WARD_MAP → LEARNED_WARD_MAP → 市サフィックス補完 → 区+地名複合分解
  // ・NEIGHBORHOOD_WARD_MAP 等には駅名（天神橋筋六丁目・天王寺等）も収録されているため駅トークンは除外
  // ・「堺市」のように駅名と市名が同一のトークンはサフィックス判定で両バッジ表示
  const hasWard = toks.some(t =>
    !t.endsWith("線") && (
      WARD_CODE_MAP[t] ||
      /[市区郡府県]$|(?:市|府|県|都)内$/.test(t) ||
      (!isStationToken(t) && !!resolveWardLoose(t))
    )
  );

  let html = '';
  if (hasStation) html += '<span class="area-mode-badge badge-area-station">駅</span>';
  if (hasWard)    html += '<span class="area-mode-badge badge-area-ward">地域</span>';
  return html;
}

async function markPropertyViewed(id) {
  try {
    const now = new Date().toISOString();
    const res = await fetch(`${API_BASE}/api/property-customers`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, property_viewed_at: now, property_send_count: 0 }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const idx = allCustomers.findIndex((c) => String(c.id) === String(id));
    if (idx >= 0) {
      allCustomers[idx] = { ...allCustomers[idx], property_viewed_at: now, property_send_count: 0 };
      setCachedCustomers(allCustomers);
      filterCustomers(document.getElementById("search-input")?.value || "");
    }
  } catch (e) {
    console.error("[AX] markPropertyViewed failed:", e);
  }
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

  const doneClass = isCompletedToday(c) ? " done-today" : "";
  return `
    <div class="customer-item${dimmed ? " dimmed" : ""}${doneClass}" data-id="${esc(String(c.id))}">
      <label class="bulk-check-wrap"><input type="checkbox" class="bulk-check" data-id="${esc(String(c.id))}"></label>
      <div class="c-dot dot-${esc(c.status)}"></div>
      <div class="c-body">
        <div class="c-name">${c.is_linked ? '<span class="link-chip">🔗</span>' : ""}${esc(c.customer_name)}${computeAreaModeBadgeHtml(d.area)}</div>
        ${meta ? `<div class="c-meta">${esc(meta)}</div>` : ""}
      </div>
      <span class="s-badge badge-${esc(c.status)}">${esc(label)}</span>
      <button class="viewed-btn${isViewedToday(c) ? " viewed-done" : ""}" data-id="${esc(String(c.id))}">${isViewedToday(c) ? "☑" : "確認"}</button>
      <svg class="c-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>
    </div>`;
}

// ── AIランキング用：顧客の希望条件を1行文字列に変換 ─────────────────────
// LINE送信時の「🌟 一番オススメ」判定（/api/merge-pdfs の rankAndAnnotateSummaries）に渡す。
// 単発検索（popup応答）と一括検索（storageフォールバック）の両方で同じ文字列を使う。
function buildCustomerConditionsString(c) {
  if (!c) return null;
  var parts = [];
  var rentMax = c.rent_max || c.max_rent;
  if (rentMax) {
    var rentDisplay = rentMax >= 10000 ? (Math.round(rentMax / 10000)) + "万円" : rentMax + "円";
    parts.push("予算" + rentDisplay + "以内");
  }
  var layout = c.floor_plan || c.layout;
  if (layout) parts.push(layout + "希望");
  if (c.walk_minutes) parts.push("徒歩" + c.walk_minutes + "分以内");
  if (c.building_age) parts.push("築" + c.building_age + "年以内");
  var areaMin = c.floor_area_min || c.area_min || c.min_area;
  if (areaMin) parts.push(areaMin + "㎡以上");
  if (c.pet === true) parts.push("ペット可");
  else if (c.pet === false) parts.push("ペット不可");
  var area = c.desired_area || c.area;
  if (area) parts.push("エリア:" + area);
  return parts.length > 0 ? parts.join("・") : null;
}

// ── View 2: Site selection ─────────────────────────────────────────
function openSiteView(customer) {
  selectedCustomer = customer;
  // ★ 顧客選択時に名前・ID・条件文字列をstorageに保存
  //   （全ページ送る時のLINEヘッダー名 ＋ 一番オススメAIランキングのフォールバック用。
  //    リアプロは検索実行でページがリロードされ popup iframe ごと消えるため、
  //    一括検索の Case C 起動時は必ずこの storage フォールバックが使われる）
  if (customer.customer_name) {
    chrome.storage.local.set({
      current_customer_name: customer.customer_name,
      current_customer_id: customer.id || null,
      current_customer_conditions: buildCustomerConditionsString(customer)
    });
  }
  document.getElementById("site-customer-name").textContent = customer.customer_name;

  // スコアオーバーレイ用にお客さん条件をセッションに保存
  try {
    chrome.storage.session.set({ axlx_score_data: {
      rent_max:             customer.rent_max || customer.max_rent || null,
      walk_minutes:         customer.walk_minutes || null,
      floor_plan:           customer.floor_plan || customer.layout || null,
      building_age:         customer.building_age || null,
      area_min:             customer.floor_area_min || customer.area_min || customer.min_area || parseAreaMin(customer.preferences) || parseAreaMin(customer.other_requests) || null,
      customer_name:        customer.customer_name,
      property_customer_id: customer.id || null,
      initial_cost_limit:   customer.initial_cost_limit || null,
      prefer_no_shikirei:   detectShikireiFlag(customer),
      ng_points:            customer.ng_points || null,
      pet_ok:               customer.pet === true || customer.pet === 'true' || /ペット|pet|犬|猫|ねこ|豆柴|マメ柴|柴犬|小型犬|中型犬|大型犬|動物飼育|動物可/i.test([customer.preferences, customer.notes, customer.other_requests, customer.additional_conditions].filter(Boolean).join(" ")),
      admin_fee_max:        customer.admin_fee_max || null,
    }});
  } catch (_) { /* ignore（非extension環境での実行対策）*/ }

  const d = buildCondData(customer);

  // 面積・構造
  const _areaMinStr = d.areaMin ? d.areaMin + "㎡以上" : null;
  const _areaMaxStr = d.areaMax ? d.areaMax + "㎡以下" : null;
  const _areaSizeStr = [_areaMinStr, _areaMaxStr].filter(Boolean).join("〜") || null;
  const _structure = customer.building_structure || customer.structure || null;
  // エリアラベル（DB area_mode 優先 → computeAreaModeBadgeHtml と同一ロジック）
  const _areaLabel = (() => {
    const _dbMode = customer.area_mode;
    if (_dbMode === "station") return "駅";
    if (_dbMode === "ward")    return "地域";
    if (!d.area) return "エリア";
    const _badge = computeAreaModeBadgeHtml(d.area);
    if (_badge.includes("badge-area-station")) return "駅";
    if (_badge.includes("badge-area-ward"))   return "地域";
    return "エリア";
  })();

  // 条件グリッド（拡張ツールステップと同じ全項目）
  // full:true → 横幅100%  / 省略 → 2カラム
  const _condRows = [
    d.area           && { label: _areaLabel,   value: d.area,          full: true },
    d.commuteByTrain && { label: "電車通勤",   value: d.commuteByTrain.station + "まで電車" + d.commuteByTrain.minutes + "分以内", full: true },
    d.transferCount  && { label: "乗り換え",   value: d.transferCount.text },
    d.rentRange      && { label: "家賃",        value: d.rentRange },
    d.floorPlan      && { label: "間取り",      value: d.floorPlan },
    d.walkMin        && { label: "駅徒歩",      value: d.walkMin },
    d.buildingAge    && { label: "築年数",      value: d.buildingAge },
    d.moveInTime     && { label: "入居",        value: d.moveInTime },
    _areaSizeStr     && { label: "面積",        value: _areaSizeStr },
    d.initialCost    && { label: "初期費用",    value: d.initialCost },
    _structure       && { label: "構造",        value: _structure },
    d.petOk          && { label: "ペット",      value: "相談可" },
    d.preferences    && { label: "希望",        value: d.preferences.length > 80 ? d.preferences.slice(0, 80) + "…" : d.preferences, full: true },
    d.ngPoints       && { label: "NG",          value: d.ngPoints.length > 60 ? d.ngPoints.slice(0, 60) + "…" : d.ngPoints, full: true },
    d.otherReqs      && { label: "その他",      value: d.otherReqs.length > 60 ? d.otherReqs.slice(0, 60) + "…" : d.otherReqs, full: true },
  ].filter(Boolean);

  const summaryEl = document.getElementById("conditions-summary");
  const _modeBadge = d.area ? computeAreaModeBadgeHtml(d.area) : "";
  summaryEl.innerHTML = _condRows.length
    ? `${_modeBadge ? `<div class="cond-mode-bar">${_modeBadge}</div>` : ""}<div class="cond-grid">${_condRows.map(r =>
        `<div class="cond-row${r.full ? " full" : ""}"><span class="cond-label">${esc(r.label)}</span><span class="cond-val">${esc(r.value)}</span></div>`
      ).join("")}</div>`
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

// 乗り換え検索UIの表示制御（駅が選択されているときのみ表示）
function updateTransferUI() {
  const row = document.getElementById('transfer-search-row');
  if (!row) return;
  const area = document.getElementById('adj-area-station')?.value.trim()
    || document.getElementById('adj-area')?.value.trim()
    || (selectedCustomer && (selectedCustomer.desired_area || selectedCustomer.area || ''));
  const toks = area ? parseAreaTokens(area) : [];
  const hasStation = toks.some(t => STATION_LINE_MAP[t] || STATION_LINE_MAP[t.replace(/[町村]$/, '')] || LEARNED_STATION_MAP[t]);
  row.style.display = hasStation ? 'block' : 'none';
  if (!hasStation) {
    const cb = document.getElementById('enableTransfer');
    if (cb) cb.checked = false;
    const opts = document.getElementById('transfer-options');
    if (opts) opts.style.display = 'none';
  }
}

function updateTransferCountLabel() {
  const label = document.getElementById('transfer-count-label');
  if (!label) return;
  const enabled = document.getElementById('enableTransfer')?.checked;
  if (!enabled) { label.textContent = ''; return; }
  const area = document.getElementById('adj-area-station')?.value.trim()
    || document.getElementById('adj-area')?.value.trim()
    || (selectedCustomer && (selectedCustomer.desired_area || selectedCustomer.area || ''));
  const toks = area ? parseAreaTokens(area) : [];
  const stations = toks.filter(t => STATION_LINE_MAP[t] || STATION_LINE_MAP[t.replace(/[町村]$/, '')] || LEARNED_STATION_MAP[t]);
  if (!stations.length) { label.textContent = ''; return; }
  let total = 0;
  if (currentSearchMode === 'time') {
    const maxMin = parseInt(document.getElementById('maxMinutes')?.value || '30', 10);
    for (const st of stations) {
      total += getStationNamesWithinMinutes(st, maxMin).length;
    }
    label.textContent = `+${total}駅が対象（${maxMin}分以内）`;
  } else {
    const maxT = parseInt(document.getElementById('maxTransfers')?.value || '1', 10);
    for (const st of stations) {
      total += getStationsWithinTransfers(st, maxT).length;
    }
    label.textContent = `+${total}駅が対象`;
  }
}

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

/**
 * トークンリストを「駅」「地域」に分類して返す（コンテキスト補正付き）。
 * 各トークンを複数シグナルで独立分類し、曖昧なものは周囲の明確トークンの多数決で解決する。
 *
 * 分類シグナル（優先順）:
 *   ① 〜線で終わる → 路線（駅系）
 *   ② JR/阪急 等プレフィックス → 駅（明確）
 *   ③ 市区郡サフィックス → 地域（明確）
 *   ④ STATION_LINE_MAP にあり WARD_CODE_MAP にない → 駅
 *   ⑤ WARD_CODE_MAP にあり STATION_LINE_MAP にない → 地域
 *   ⑥ 両方 or どちらにもない → ambiguous → 周囲の多数決で解決（同数は駅優先）
 */
function classifyAreaTokens(tokens) {
  const _lineRe = /^(?:阪急|阪神|南海|近鉄|JR|京阪|大阪メトロ|地下鉄)/;
  const classified = tokens.map(function(t) {
    if (t.endsWith("線")) return { t: t, type: "station", reason: "route_suffix" };
    if (_lineRe.test(t))  return { t: t, type: "station", reason: "line_prefix" };
    if (/[市区郡]$/.test(t)) return { t: t, type: "area", reason: "area_suffix" };
    var tBase = t.replace(/[町村]$/, "");
    var inStation = !!(STATION_LINE_MAP[t] || STATION_LINE_MAP[tBase] ||
      (LEARNED_STATION_MAP[t] && LEARNED_STATION_MAP[t].realpro_lines && LEARNED_STATION_MAP[t].realpro_lines.length > 0));
    // WARD_CODE_MAP = 実際の区コード（大阪市淀川区 等）→ 強い地名シグナル
    // NEIGHBORHOOD_WARD_MAP = 地名→区の対応（十三→淀川区 等）→ 弱い地名シグナル（駅名に負ける）
    var inStrictWard = !!WARD_CODE_MAP[t];
    var inWard = !!(WARD_CODE_MAP[t] || NEIGHBORHOOD_WARD_MAP[t] || LEARNED_WARD_MAP[t]);
    // STATION_LINE_MAP にある → 駅。ただし WARD_CODE_MAP に完全一致する純粋な市区名は地域優先
    if (inStation && !inStrictWard) return { t: t, type: "station",   reason: "station_map" };
    if (inStation && inStrictWard)  return { t: t, type: "ambiguous", reason: "both_maps" };
    if (!inStation && inWard)       return { t: t, type: "area",      reason: "ward_map" };
    return { t: t, type: "unknown", reason: "not_found" };
  });
  var stationCount = classified.filter(function(c) { return c.type === "station"; }).length;
  var areaCount    = classified.filter(function(c) { return c.type === "area"; }).length;
  var stationTokens = [], areaTokens = [];
  for (var _i = 0; _i < classified.length; _i++) {
    var _c = classified[_i];
    if (_c.type === "station") {
      stationTokens.push(_c.t);
    } else if (_c.type === "area") {
      areaTokens.push(_c.t);
    } else {
      // ambiguous / unknown → 多数決（同数は駅優先: 駅はより具体的な条件）
      if (stationCount >= areaCount) stationTokens.push(_c.t);
      else areaTokens.push(_c.t);
    }
  }
  console.log("[AX] 仕分け:", classified.map(function(c) { return c.t + "→" + c.type + "(" + c.reason + ")"; }).join(", "));
  return {
    stationTokens: stationTokens,
    areaTokens:    areaTokens,
    hasStation:    stationTokens.length > 0,
    hasArea:       areaTokens.length > 0,
    details:       classified,
  };
}

function setupAreaModeSelector(c, siteKey) {
  const rawA = (c.desired_area || c.area || "").trim();
  const toks = parseAreaTokens(rawA);

  // classifyAreaTokens で駅・地域トークンを分類（コンテキスト補正付き）
  const _cl = classifyAreaTokens(toks);
  // 路線名として解決可能なトークンがあるか（route_ids 設定用）
  const hasResolvableRoute = _cl.stationTokens.some(t => t.endsWith("線") && lineNameToRouteId(t));
  // 区レベルの明確な地域トークン（市レベルは含まない）
  // 市レベル + 駅 → 駅優先 / 区レベル + 駅 → 区優先（具体的な区指定を従来通り優先）
  const hasSpecificWardToken = _cl.areaTokens.some(t =>
    /[区郡]$/.test(t) || WARD_CODE_MAP[t] || NEIGHBORHOOD_WARD_MAP[t]);
  // resolveWardLoose で解決できる区+地名複合トークン（「鶴見区槇塚」等）
  const hasWardCompoundToken = _cl.areaTokens.some(t =>
    !WARD_CODE_MAP[t] && !NEIGHBORHOOD_WARD_MAP[t] && resolveWardLoose(t));
  // DBのarea_modeが明示設定されている場合は分類結果より優先
  const _dbMode = (c.area_mode === 'station' || c.area_mode === 'ward') ? c.area_mode : null;
  const defaultMode = _dbMode ||
    ((_cl.hasStation || hasResolvableRoute)
      ? ((hasSpecificWardToken || hasWardCompoundToken) ? "ward" : "station")
      : "ward");

  // DOM がない状態（underbarモード等）でも currentAreaMode だけはセットしておく
  _areaModeSource = "auto";
  currentAreaMode = defaultMode;

  const selectorEl = document.getElementById("area-mode-selector");
  const noticeEl   = document.getElementById("area-mixed-notice");
  const btnStation = document.getElementById("btn-mode-station");
  const btnWard    = document.getElementById("btn-mode-ward");

  // DOM 要素が存在しない場合は UI 更新のみスキップ（currentAreaMode は上でセット済み）
  if (!selectorEl || !noticeEl || !btnStation || !btnWard) return;
  if (!rawA) { selectorEl.style.display = "none"; return; }
  selectorEl.style.display = "block";
  noticeEl.style.display   = "none";

  // ボタン押下が絶対ルール: currentAreaMode を更新 → ステップ表示も即更新
  function setMode(mode) {
    currentAreaMode = mode;
    btnStation.classList.toggle("active", mode === "station");
    btnWard.classList.toggle("active", mode === "ward");
    renderInstrSteps(siteKey, buildAdjCustomer(c));
  }

  setMode(defaultMode);
  btnStation.onclick = () => { _areaModeSource = "user"; setMode("station"); };
  btnWard.onclick    = () => {
    // 通勤時間パターン（「梅田から20分以内」等）は駅モードでのみ有効。地域モードへの切替をブロック
    const _rawCurrent = (document.getElementById("adj-area-ward")?.value || "").trim();
    if (/(?:まで|から|へ)(?:電車|バス|徒歩|歩いて)?\d+分/.test(_rawCurrent)) {
      showToast && showToast("「〇〇から△分以内」は駅タブで処理されます", "info");
      return;
    }
    _areaModeSource = "user"; setMode("ward");
  };

  // 自動判定が曖昧（静的マップで判定できなかった）場合 → APIで補完
  // resolveAreaWithAPI はキャッシュがあれば即返る。未知トークンがなければ null を返してスキップ。
  // hasWardCompoundToken: 区+地名複合でローカル解決が不完全な場合も API を呼んで補完
  if ((!_cl.hasArea && !_cl.hasStation) || hasWardCompoundToken) {
    resolveAreaWithAPI(rawA, "auto").then(function(apiData) {
      if (!apiData || _areaModeSource !== "auto") return; // ユーザーが手動クリック済みなら無視
      var hasApiSt = (apiData.realpro?.station_names?.length > 0) || (apiData.realpro?.route_ids?.length > 0);
      var hasApiWd = (apiData.realpro?.city_codes?.length > 0);
      if (hasApiSt && !hasApiWd) { console.log("[AX] setupAreaMode API→station"); setMode("station"); }
      else if (hasApiWd && !hasApiSt) { console.log("[AX] setupAreaMode API→ward"); setMode("ward"); }
    }).catch(function() {});
  }
}

function preloadAdjForm(c) {
  const _rawArea  = c.desired_area || c.area || "";
  const _areaMode = c.area_mode || "auto";
  let _wardStr = "", _stStr = "";
  if (_areaMode === "ward") {
    _wardStr = _rawArea;
  } else if (_areaMode === "station") {
    _stStr = _rawArea;
  } else {
    // auto: classifyAreaTokens で統一（setupAreaModeSelector と同一ロジック）
    const _toks = _rawArea ? parseAreaTokens(_rawArea) : [];
    const _cl = classifyAreaTokens(_toks);
    _stStr   = _cl.stationTokens.join("・");
    _wardStr = _cl.areaTokens.join("・") || (_cl.stationTokens.length === 0 ? _rawArea : "");
  }
  document.getElementById("adj-area-station").value = _stStr;
  document.getElementById("adj-area-ward").value    = _wardStr;
  document.getElementById("adj-area").value          = _rawArea; // hidden: 内部互換用
  document.getElementById("adj-rent-max").value  = c.rent_max || c.max_rent || "";
  document.getElementById("adj-area-min").value  = c.floor_area_min || c.area_min || c.min_area || parseAreaMin(c.floor_plan || c.layout) || parseAreaMin(c.preferences) || parseAreaMin(c.other_requests) || "";
  document.getElementById("adj-area-max").value  = c.floor_area_max || c.area_max || c.max_area || "";
  document.getElementById("adj-walk").value      = c.walk_minutes || "";
  document.getElementById("adj-age").value       = c.building_age || "";
  document.getElementById("adj-floor").value     = c.floor_plan || c.layout || "";
  document.getElementById("adj-structure").value   = c.building_structure || c.structure || "";
  document.getElementById("adj-move-in").value     = c.move_in_time || c.move_in || "";
  document.getElementById("adj-initial-cost").value = c.initial_cost_limit || "";

  // ペット飼育: DBのpetフィールドを優先、未設定ならテキスト検出フォールバック
  if (c.pet === true) {
    document.getElementById("adj-pet").checked = true;
  } else if (c.pet === false) {
    document.getElementById("adj-pet").checked = false;
  } else {
    const petFields = [c.preferences, c.notes, c.other_requests, c.additional_conditions].filter(Boolean).join(" ");
    document.getElementById("adj-pet").checked = /ペット|pet|犬|猫|ねこ|豆柴|マメ柴|柴犬|小型犬|中型犬|大型犬|動物飼育|動物可/i.test(petFields);
  }

  // お客様名表示
  const labelEl = document.getElementById("adj-customer-label");
  if (labelEl) labelEl.textContent = c.customer_name ? c.customer_name + "様" : "";

  // 最終送信日：last_property_sent_at から初期値セット
  const lastSentEl = document.getElementById("adj-last-sent-date");
  if (lastSentEl) {
    // JSTの日付で表示する（UTCのsplit("T")[0]だと早朝送信時に1日ズレる）
    const initDate = c.last_property_sent_at
      ? new Date(new Date(c.last_property_sent_at).getTime() + 9 * 3600 * 1000).toISOString().split("T")[0]
      : "";
    lastSentEl.value = initDate;
    lastSentEl.oninput = () => {
      const el = document.getElementById("adj-update-days");
      if (el) el.value = calcUpdateDays(lastSentEl.value, c.status);
    };
  }

  // 更新日：アプリで上書き済みなら優先、なければ日付から自動計算
  const updateDaysEl = document.getElementById("adj-update-days");
  if (updateDaysEl) {
    if (c.rp_update_days) {
      updateDaysEl.value = String(c.rp_update_days);
    } else {
      const initDate = c.last_property_sent_at ? c.last_property_sent_at.split("T")[0] : "";
      updateDaysEl.value = calcUpdateDays(initDate, c.status);
    }
  }

  // レインズ登録日：初めての物件出しは絞り込まない
  const regDateEl = document.getElementById("adj-reg-date");
  if (regDateEl && !c.last_property_sent_at) {
    regDateEl.value = "";
  }

  // エリア条件を自動パースしてTransfer UIに反映
  const _rawAreaForParse = c.desired_area || c.area || '';
  if (_rawAreaForParse) {
    const _parsed = parseAreaCondition(_rawAreaForParse);
    const _first = Array.isArray(_parsed) ? _parsed[0] : _parsed;
    if (_first) {
      applyParsedCondition(_first);
      // 複数条件がある場合はlabelのtitleにヒントを追加
      if (Array.isArray(_parsed) && _parsed.length > 1) {
        const label = document.getElementById('transfer-count-label');
        if (label) label.title = '他にも: ' + _parsed.slice(1).map(p => p.station + (p.minutes ? ` ${p.minutes}分以内` : '')).join('、');
      }
    }
  }
}

function calcUpdateDays(dateStr, status) {
  if (!dateStr) {
    return ""; // 初めての物件出し → 絞り込まない
  }
  // new Date("YYYY-MM-DD") はUTC深夜0時として解釈されJSTと9時間ズレる。
  // +09:00 を明示してJST深夜0時基準で日数を計算する。
  const jstMidnight = new Date(dateStr + "T00:00:00+09:00");
  const daysSince = Math.floor((Date.now() - jstMidnight.getTime()) / 86400000);
  if (daysSince <= 1) return "1";
  if (daysSince <= 3) return "3";
  if (daysSince <= 7) return "7";
  return "14";
}

function buildAdjCustomer(c) {
  const adjWard    = document.getElementById("adj-area-ward")?.value.trim()    || "";
  const adjStation = document.getElementById("adj-area-station")?.value.trim() || "";
  // 地域・駅フィールドを合わせて area を構築（hidden adj-area はフォールバック）
  let adjArea = [adjStation, adjWard].filter(Boolean).join("・")
             || document.getElementById("adj-area")?.value.trim() || "";
  // area_mode の自動導出（明示フィールドで確定）
  const _derivedMode = (adjWard && !adjStation) ? "ward"
    : (adjStation && !adjWard) ? "station"
    : (adjWard && adjStation)  ? "both"
    : (c.area_mode || "auto");
  const adjRentMax     = document.getElementById("adj-rent-max").value;
  const adjWalk        = document.getElementById("adj-walk").value;
  const adjAge         = document.getElementById("adj-age").value;
  const adjFloor       = document.getElementById("adj-floor").value.trim();
  const adjMoveIn      = document.getElementById("adj-move-in")?.value.trim() || "";
  const adjInitialCost = document.getElementById("adj-initial-cost")?.value || "";

  // 乗り換え検索が有効なら隣接駅をエリア文字列に追加
  const transferEnabled = document.getElementById("enableTransfer")?.checked;
  if (transferEnabled) {
    const baseArea = adjArea || c.desired_area || c.area || "";
    const toks = parseAreaTokens(baseArea);
    const extra = new Set();
    const isTimeMode = currentSearchMode === "time";
    if (isTimeMode) {
      const maxMins = parseInt(document.getElementById("maxMinutes")?.value || "30", 10);
      for (const st of toks) {
        if (STATION_LINE_MAP[st] || STATION_LINE_MAP[st.replace(/[町村]$/, "")] || LEARNED_STATION_MAP[st]) {
          getStationNamesWithinMinutes(st, maxMins).forEach(s => extra.add(s));
        }
      }
    } else {
      const maxT = parseInt(document.getElementById("maxTransfers")?.value || "1", 10);
      for (const st of toks) {
        if (STATION_LINE_MAP[st] || STATION_LINE_MAP[st.replace(/[町村]$/, "")] || LEARNED_STATION_MAP[st]) {
          getStationsWithinTransfers(st, maxT).forEach(s => extra.add(s));
        }
      }
    }
    if (extra.size > 0) {
      adjArea = [baseArea, ...[...extra]].join("・");
    }
  }

  return {
    ...c,
    desired_area:  adjArea    || c.desired_area || c.area || null,
    area:          adjArea    || c.desired_area || c.area || null,
    area_ward:     adjWard    || null,
    area_station:  adjStation || null,
    area_mode:     _derivedMode,
    rent_max:     adjRentMax ? Number(adjRentMax) : (c.rent_max || c.max_rent || null),
    max_rent:     adjRentMax ? Number(adjRentMax) : (c.rent_max || c.max_rent || null),
    walk_minutes: adjWalk    ? Number(adjWalk)    : (c.walk_minutes || null),
    building_age: adjAge     ? Number(adjAge)     : (c.building_age || null),
    floor_plan:         adjFloor       || c.floor_plan || c.layout || null,
    layout:             adjFloor       || c.floor_plan || c.layout || null,
    move_in_time:       adjMoveIn      || c.move_in_time || c.move_in || null,
    initial_cost_limit: adjInitialCost ? Number(adjInitialCost) : (c.initial_cost_limit || null),
  };
}

// ── 未登録地名ヘルパー（博士連携: 駅でも地名マップにもないトークンを検出） ──────
// ※ トップレベル定義必須: deleteLearnedToken / correctLearnedToken（トップレベル関数）から
//    呼ばれるため、openInstructions 内に置くと strict mode で ReferenceError になる
function computeUnknownTokens(areaStr) {
  if (!areaStr) return [];
  return parseAreaTokens(areaStr)
    .filter(t => t.length >= 2 && !/^[0-9０-９]/.test(t))
    .filter(t =>
      !STATION_LINE_MAP[t] &&
      !STATION_LINE_MAP[t.replace(/[町村]$/, "")] &&
      !NEIGHBORHOOD_WARD_MAP[t] &&
      !MULTI_WARD_MAP[t] &&          // 広域地名（北摂等）はAI解決不要
      !LEARNED_WARD_MAP[t] &&        // AI学習済みマップも参照
      !WARD_CODE_MAP[t] &&
      !WARD_CODE_MAP[t + "市"] &&    // 市サフィックス補完（「富田林」→富田林市）はAI解決不要
      !(t.endsWith("線") && lineNameToRouteId(t)) &&  // 既知路線名はAI解決不要（「御堂筋線」が駅として誤学習される汚染ループの遮断）
      !resolveWardLoose(t) &&  // resolveWardLooseで解決できる区名+駅名連結（「鶴見区横堤」等）はAI不要
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

  let html = "⚠️ 未登録地名: <b>" + tokens.map(t => esc(t)).join("・") + "</b>";
  if (hasResolvable) {
    const hints = analyzed.filter(r => r.suggestion)
      .map(r => esc(r.original) + "→<b>" + esc(r.suggestion.resolved) + "</b>("
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
        const adjAreaEl = document.getElementById("adj-area-station") || document.getElementById("adj-area");
        const areaVal = adjAreaEl ? adjAreaEl.value : (selectedCustomer.desired_area || selectedCustomer.area || "");
        const stillUnknown = computeUnknownTokens(areaVal);
        if (stillUnknown.length === 0) {
          // 全解決 → 解決結果と「間違い？」ボタンを表示
          const resolved = unresolvedTokens.map(t => {
            const w = LEARNED_WARD_MAP[t] || LEARNED_STATION_MAP[t]?.ward;
            const type = LEARNED_STATION_MAP[t] ? "駅" : "地名";
            return w ? `<span style="color:#1a73e8;font-weight:bold">${esc(t)}→${esc(w)}(${type})</span>
              <button class="learned-token-del" data-token="${esc(t)}" data-type="${LEARNED_STATION_MAP[t] ? 'station' : 'region'}"
                style="margin-left:4px;font-size:10px;padding:1px 5px;background:#f44336;color:white;border:none;border-radius:3px;cursor:pointer">✗ 間違い</button>` : esc(t);
          }).join("　");
          el.innerHTML = `✅ 自動解決: ${resolved}`;
          el.querySelectorAll(".learned-token-del").forEach(btn => {
            // ✗押下 → 即削除ではなく正解入力フォームを表示（正解をDBに学習させる）
            btn.addEventListener("click", () => showCorrectionForm(el, btn.dataset.token, btn.dataset.type));
          });
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
        const adjAreaEl = document.getElementById("adj-area-station") || document.getElementById("adj-area");
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

function openInstructions(siteKey) {
  // webappからは "realnetpro" で来るが SITE_CONFIG のキーは "realpro"
  if (siteKey === "realnetpro") siteKey = "realpro";
  selectedSite = siteKey;
  const cfg = SITE_CONFIG[siteKey];

  document.getElementById("instr-title").textContent = cfg.icon + " " + cfg.name;
  syncModeButtons();
  renderInstrSteps(siteKey);
  updateTransferUI();

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

  if (siteKey === "itandi") {
    adjForm.style.display = "block";
    preloadAdjForm(selectedCustomer);
    setupAreaModeSelector(selectedCustomer, "itandi");
    autofillBtn.style.display = "block";
    autofillBtn.textContent = "🔍 itandiで自動検索";
    autofillBtn.className = "autofill-btn";
    // ボタン表示と同時に未登録地名チェック（クリック前に気づける）
    showUnknownWarn(computeUnknownTokens(selectedCustomer.desired_area || selectedCustomer.area || ""));

    autofillBtn.onclick = async () => {
      const isAutomated_itandi = !!autofillBtn.dataset.automated;
      const isAutoSendAll_itandi = !!autofillBtn.dataset.auto_send_all;
      const _lockedMode_itandi = autofillBtn.dataset.area_mode_locked || null; // await前に取得
      let c = selectedCustomer;
      const _adjWard_it    = document.getElementById("adj-area-ward")?.value.trim()    || "";
      const _adjStation_it = document.getElementById("adj-area-station")?.value.trim() || "";
      const adjArea      = [_adjStation_it, _adjWard_it].filter(Boolean).join("・")
                        || document.getElementById("adj-area")?.value.trim() || "";
      const adjRentMax   = document.getElementById("adj-rent-max").value;
      const adjAreaMin   = document.getElementById("adj-area-min").value;
      const adjAreaMax   = document.getElementById("adj-area-max").value;
      const adjWalk      = document.getElementById("adj-walk").value;
      const adjAge       = document.getElementById("adj-age").value;
      const adjFloor     = document.getElementById("adj-floor").value.trim();
      const adjStructure = document.getElementById("adj-structure").value.trim();
      const adjPet       = document.getElementById("adj-pet").checked;
      const rawArea = (adjArea || c.desired_area || c.area || "").trim();

      // ブレイン経由: resolve-area + 送付履歴 + 除外リストを1本で取得
      const apiData = c.id
        ? await fetchBrainSearchParams(c.id, rawArea)
        : await resolveAreaWithAPI(rawArea, "auto", c.id);
      if (apiData?.suggested_walk_minutes && !c.walk_minutes) {
        c = { ...c, walk_minutes: apiData.suggested_walk_minutes };
      }

      // 自動判定モードの場合のみ: API結果でモードを補正（手動クリック済みは無視）
      if (_areaModeSource === "auto" && apiData?.realpro) {
        const _hasApiSt = (apiData.realpro.station_names?.length > 0) || (apiData.realpro.route_ids?.length > 0);
        const _hasApiWd = (apiData.realpro.city_codes?.length > 0);
        if (_hasApiSt && !_hasApiWd && currentAreaMode !== "station") {
          currentAreaMode = "station";
          document.getElementById("btn-mode-station")?.classList.add("active");
          document.getElementById("btn-mode-ward")?.classList.remove("active");
        } else if (_hasApiWd && !_hasApiSt && currentAreaMode !== "ward") {
          currentAreaMode = "ward";
          document.getElementById("btn-mode-ward")?.classList.add("active");
          document.getElementById("btn-mode-station")?.classList.remove("active");
        }
      }
      // ローカル補正: STATION_LINE_MAPに一致する既知駅があれば駅モードへ自動切替
      // （既知駅はAPIを呼ばないためAPIによるモード補正が動かない問題を解消する）
      if (_areaModeSource === "auto" && currentAreaMode !== "station") {
        const _localToks = parseAreaTokens(rawArea);
        const _hasKnownStation = _localToks.some(t => {
          const s = t.replace(/[町村]$/, "");
          return !!(STATION_LINE_MAP[t] || STATION_LINE_MAP[s] ||
                    LEARNED_STATION_MAP[t]?.realpro_lines?.length > 0);
        });
        if (_hasKnownStation) {
          currentAreaMode = "station";
          document.getElementById("btn-mode-station")?.classList.add("active");
          document.getElementById("btn-mode-ward")?.classList.remove("active");
        }
      }

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
      // resolveWardLoose で「鶴見区横堤」→「大阪市鶴見区」のような部分一致も解決
      // 「大阪市内」「大阪市」は ITANDI の batchCity（全区一括選択）を正しく動かすため、
      // WARD_CODE_MAP 内の全 大阪市XX区 に展開してから neighborhoodTokens を構築する
      const wardExpandedTokens = [];
      for (const t of tokens) {
        if (/^大阪市(内)?$/.test(t)) {
          Object.keys(WARD_CODE_MAP)
            .filter(k => k.startsWith("大阪市"))
            .forEach(k => { if (!wardExpandedTokens.includes(k)) wardExpandedTokens.push(k); });
        } else if (MULTI_WARD_MAP[t]) {
          // 広域地名（北摂等）→ 構成市をすべて展開してitandi選択に渡す
          MULTI_WARD_MAP[t].forEach(ward => {
            if (!wardExpandedTokens.includes(ward)) wardExpandedTokens.push(ward);
          });
        } else {
          wardExpandedTokens.push(t);
        }
      }
      const neighborhoodTokens = currentAreaMode === "ward"
        ? wardExpandedTokens.filter(t => resolveWardLoose(t) || WARD_CODE_MAP[t])
        : wardExpandedTokens.filter(t => resolveWardLoose(t) && !STATION_LINE_MAP[t]);
      const neighborhoodWard = neighborhoodTokens.length > 0
        ? (resolveWardLoose(neighborhoodTokens[0]) || neighborhoodTokens[0])
        : null;
      const allNeighborhoodWards = [...new Set(neighborhoodTokens.map(t => resolveWardLoose(t) || t))];

      // ボタン押下が絶対ルール（let: 臨機応変フォールバックで更新する可能性あり）
      let isWardArea_itandi = currentAreaMode === "ward";

      // 未登録トークン検出: 駅でも地名マップにもない → page-scriptで警告ログ
      const unknownTokens = tokens.filter(t =>
        t.length >= 2 &&
        !/^[0-9０-９]/.test(t) &&
        !matchedStations.includes(t) &&
        !STATION_LINE_MAP[t] &&
        !STATION_LINE_MAP[t.replace(/[町村]$/,"")] &&
        !NEIGHBORHOOD_WARD_MAP[t] &&
        !MULTI_WARD_MAP[t] &&                        // 広域地名（北摂等）は既知
        !WARD_CODE_MAP[t] &&                         // WARD_CODE_MAP収録済みも除外
        !/[都道府県市区郡]/.test(t)
      );

      // DB優先でitandi路線名を構築（LEARNED_STATION_MAP = station_map全件キャッシュ）
      const itandiLines = [];
      const _itandiUnknown = [];
      tokens.forEach(function(tok) {
        // 「阪急十三」「JR高槻」等の路線プレフィックスを除去してから検索
        var resolved = tok;
        if (!STATION_HUB_MAP[tok] && !STATION_LINE_MAP[tok]) {
          var pfxR = resolveWithLinePrefixes(tok);
          if (pfxR && pfxR.type === "station") resolved = pfxR.resolved;
        }
        // ハブ駅展開: 梅田→[梅田,東梅田,西梅田,大阪梅田,大阪]等、全ハブ駅の路線を集約
        var hubList = (STATION_HUB_MAP && STATION_HUB_MAP[resolved]) ? STATION_HUB_MAP[resolved] : [resolved];
        hubList.forEach(function(hubTok) {
          var dbEntry = LEARNED_STATION_MAP[hubTok];
          if (dbEntry && dbEntry.itandi_lines && dbEntry.itandi_lines.length > 0) {
            dbEntry.itandi_lines.forEach(function(l) { if (!itandiLines.includes(l)) itandiLines.push(l); });
          } else {
            // DBにない → 静的マップフォールバック
            var rpLines = STATION_LINE_MAP[hubTok] || [];
            if (!rpLines.length && dbEntry && dbEntry.realpro_lines && dbEntry.realpro_lines.length) {
              rpLines = dbEntry.realpro_lines;
            }
            rpLines.forEach(function(l) {
              var v = ITANDI_LINE_MAP_FILL[l];
              (Array.isArray(v) ? v : (v ? [v] : [])).forEach(function(m) {
                if (!itandiLines.includes(m)) itandiLines.push(m);
              });
            });
          }
        });
        // 未知（DBにitandi_linesが無い）はAPIで解決
        var origEntry = LEARNED_STATION_MAP[tok];
        if (!origEntry || !origEntry.itandi_lines || !origEntry.itandi_lines.length) {
          _itandiUnknown.push(tok);
        }
      });
      // API補完（resolve-area の結果も追加）
      if (apiData?.itandi?.line_names) {
        apiData.itandi.line_names.forEach(function(n) { if (!itandiLines.includes(n)) itandiLines.push(n); });
      }
      // itandi ward_names API補完（リアプロのcity_codes補完と同等）
      if (apiData && Array.isArray(apiData.itandi?.ward_names)) {
        apiData.itandi.ward_names.forEach(function(wn) {
          if (!allNeighborhoodWards.includes(wn)) allNeighborhoodWards.push(wn);
        });
      }
      // 未知トークンを非同期でDB解決（次回以降のLEARNED_STATION_MAP更新）
      if (_itandiUnknown.length > 0) {
        fetch(API_BASE + "/api/itandi-resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tokens: _itandiUnknown }),
          signal: AbortSignal.timeout(10000),
        }).then(function(r) { return r.ok ? r.json() : null; }).then(function(data) {
          if (!data || !data.resolved) return;
          Object.entries(data.resolved).forEach(function([tok, info]) {
            if (info.itandi_lines && info.itandi_lines.length > 0) {
              LEARNED_STATION_MAP[tok] = Object.assign({}, LEARNED_STATION_MAP[tok], info);
            }
          });
        }).catch(function() {});
      }

      const adjC = buildAdjCustomer(c);
      // 臨機応変フォールバック(itandi): station モードで itandiLines 空かつ ward データある → ward に降格
      if (_areaModeSource === "auto" && !isWardArea_itandi && itandiLines.length === 0 && (neighborhoodWard || (apiData?.itandi?.ward_names?.length > 0))) {
        console.log("[AX] 臨機応変(itandi): station→ward 降格（itandiLines 空, ward データあり）");
        currentAreaMode = "ward";
        isWardArea_itandi = true;
        document.getElementById("btn-mode-ward")?.classList.add("active");
        document.getElementById("btn-mode-station")?.classList.remove("active");
        renderInstrSteps("itandi", adjC);
      } else if (_areaModeSource === "auto" && isWardArea_itandi && itandiLines.length > 0 && !neighborhoodWard && !(apiData?.itandi?.ward_names?.length > 0)) {
        // ward モードで ward データ取れず station データある → station に昇格
        console.log("[AX] 臨機応変(itandi): ward→station 昇格（ward データ空, itandiLines あり）");
        currentAreaMode = "station";
        isWardArea_itandi = false;
        document.getElementById("btn-mode-station")?.classList.add("active");
        document.getElementById("btn-mode-ward")?.classList.remove("active");
        renderInstrSteps("itandi", adjC);
      }

      // 所在地名: NEIGHBORHOOD_WARD_MAP → 市区郡テキスト → STATION_WARD_MAP の優先順
      const wardName = isWardArea_itandi
        ? (neighborhoodWard || stationClean)
        : (STATION_WARD_MAP[stationClean] || null);

      // 駅名リスト（広げて検索：各マッチ駅＋前後駅、ピンポイント：マッチ駅のみ）
      let stationNames = null;
      if (!isWardArea_itandi && matchedStations.length > 0) {
        stationNames = [...matchedStations];
        // ハブ駅展開: 梅田→東梅田/西梅田/大阪梅田 等、各路線モーダルで駅クリックが効くよう全ハブ駅名を追加
        matchedStations.forEach(function(st) {
          if (STATION_HUB_MAP && STATION_HUB_MAP[st]) {
            STATION_HUB_MAP[st].forEach(function(hubSt) {
              if (!stationNames.includes(hubSt)) stationNames.push(hubSt);
            });
          }
        });
        if (searchMode === "wide") {
          matchedStations.forEach(st => {
            const stLines = STATION_LINE_MAP[st] || [];
            // 4路線以上かつ同一事業者の場合のみ「広域ハブ」として隣接駅を省略
            // 旧実装は >1 で抑制していたため、本町（3路線）等も隣接駅が追加されないバグがあった
            const _isSameOpHub = stLines.length > 3 && deduplicateSameOperatorLines(stLines).length === 1;
            if (!_isSameOpHub) {
              const adj = getAdjacentStations(st, stLines);
              adj.forEach(a => { if (!stationNames.includes(a)) stationNames.push(a); });
            }
          });
        }
      }
      // API補完: 路線→駅一覧を station_names に追加（路線指定の場合 matchedStations は空）
      // isKnownStation で検証: 地域名・町字名がAIにより駅と誤分類されても混入しない
      if (!isWardArea_itandi && apiData?.itandi?.station_names?.length > 0) {
        if (!stationNames) stationNames = [];
        apiData.itandi.station_names.forEach(s => {
          if (stationNames.includes(s)) return;
          if (isKnownStation(s)) {
            stationNames.push(s);
          } else {
            console.log('[AX] itandi API補完: 非駅トークンを除外:', s);
          }
        });
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
        area_mode:       _lockedMode_itandi || currentAreaMode,
        shikirei_free:   detectShikireiFlag(c),
        walk_minutes:    adjWalk    ? Number(adjWalk)    : (c.walk_minutes || null),
        building_age:    adjAge     ? Number(adjAge)     : (c.building_age || null),
        floor_plan:      adjFloor   || c.floor_plan || c.layout || null,
        is_wide:         searchMode === "wide",
        area_min:        adjAreaMin ? Number(adjAreaMin) : (c.floor_area_min || c.area_min || c.min_area || parseAreaMin(c.floor_plan || c.layout) || parseAreaMin(c.preferences) || parseAreaMin(c.other_requests) || null),
        area_max:        adjAreaMax ? Number(adjAreaMax) : (c.floor_area_max || null),
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
            const w = NEIGHBORHOOD_WARD_MAP[t] || resolveWardLoose(t);
            if (!w) return;
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
      // スコアオーバーレイ用に有効条件（adj後）で上書き保存
      try {
        chrome.storage.session.set({ axlx_score_data: {
          rent_max:             conditions.rent_max,
          walk_minutes:         conditions.walk_minutes || null,
          floor_plan:           conditions.floor_plan || null,
          building_age:         conditions.building_age || null,
          area_min:             conditions.area_min || null,
          customer_name:        selectedCustomer.customer_name,
          property_customer_id: selectedCustomer.id || null,
          initial_cost_limit:   selectedCustomer.initial_cost_limit || null,
          prefer_no_shikirei:   detectShikireiFlag(selectedCustomer),
          ng_points:            selectedCustomer.ng_points || null,
          pet_ok:               selectedCustomer.pet === true || selectedCustomer.pet === 'true' || false,
          admin_fee_max:        selectedCustomer.admin_fee_max || null,
        }});
      } catch (_) { /* ignore */ }
      console.log('[AX] itandi autofill送信:', {
        area_mode:       conditions.area_mode,
        station_names:   conditions.station_names,
        ward_name:       conditions.ward_name,
        area_min:        conditions.area_min,
        area_max:        conditions.area_max,
        structure_types: conditions.structure_types,
        building_age:    conditions.building_age,
        floor_plan:      conditions.floor_plan,
      });
      // underbar（iframe）モード: postMessage経由 / サイドパネルモード: chrome.tabs.sendMessage経由
      if (isUnderbar) {
        window.parent.postMessage({ from: "aixlinx-underbar", action: "itandi-autofill", conditions, source: isAutoSendAll_itandi ? "flagged_batch" : (isAutomated_itandi ? "automated" : "manual") }, "*");
      } else {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: "axlx-itandi-autofill", conditions }, () => {
            if (chrome.runtime.lastError) {
              console.warn("[popup] sendMessage failed:", chrome.runtime.lastError.message);
              autofillBtn.textContent = "⚠ itandiのタブで開いてください";
              autofillBtn.classList.remove("done");
              return;
            }
          });
        });
      }
      autofillBtn.textContent = "✓ 自動検索中...";
      autofillBtn.classList.add("done");
      setTimeout(() => {
        autofillBtn.textContent = "🔍 itandiで自動検索";
        autofillBtn.classList.remove("done");
      }, 8000);
    };
  } else if (isUnderbar && siteKey === "realpro") {
    autofillBtn.style.display = "block";
    autofillBtn.textContent = "🔍 リアプロで自動検索";
    autofillBtn.className = "autofill-btn";
    autofillBtn.disabled = false; // 前顧客のfill-done未着で残ったdisabledをリセット
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

    autofillBtn.onclick = async () => {
      // pendingPopupCmd（自動バッチ）経由の click か手動クリックかを区別
      const isAutomated = !!autofillBtn.dataset.automated;
      const isAutoSendAll = !!autofillBtn.dataset.auto_send_all;
      const _lockedMode = autofillBtn.dataset.area_mode_locked || null; // await前に取得（非同期後は dataset が削除済み）
      const c = c0;
      // 調整フォームの値を優先して使う
      const _adjWard_rp    = document.getElementById("adj-area-ward")?.value.trim()    || "";
      const _adjStation_rp = document.getElementById("adj-area-station")?.value.trim() || "";
      const adjArea     = [_adjStation_rp, _adjWard_rp].filter(Boolean).join("・")
                       || document.getElementById("adj-area")?.value.trim() || "";
      const adjRentMax  = document.getElementById("adj-rent-max").value;
      const adjAreaMin    = document.getElementById("adj-area-min").value;
      const adjAreaMax    = document.getElementById("adj-area-max").value;
      const adjWalk       = document.getElementById("adj-walk").value;
      const adjAge        = document.getElementById("adj-age").value;
      const adjFloor      = document.getElementById("adj-floor").value.trim();
      const adjStructure  = document.getElementById("adj-structure").value.trim();
      const adjPet        = document.getElementById("adj-pet").checked;
      const adjUpdateDays = document.getElementById("adj-update-days")?.value || "";
      const adjC = {
        desired_area: adjArea     || c.desired_area || c.area  || null,
        area:         adjArea     || c.desired_area || c.area  || null,
        area_ward:    _adjWard_rp    || null,
        area_station: _adjStation_rp || null,
        rent_max:     adjRentMax  ? Number(adjRentMax)  : (c.rent_max || c.max_rent || null),
        rent_min:     c.rent_min  || null,
        walk_minutes: adjWalk     ? Number(adjWalk)     : (c.walk_minutes || null),
        building_age: adjAge      ? Number(adjAge)      : (c.building_age || null),
        floor_plan:   adjFloor    || c.floor_plan || c.layout || null,
        structure_types: adjStructure
          ? adjStructure.split(/[,、・\/\.\s]+/).map(s => s.trim()).filter(Boolean)
          : [],
      };
      const adjAreaClean = (adjC.desired_area || adjC.area || "").trim();

      // ① API呼び出しを先に実施（モード判定 + 補完データ取得を兼ねる）
      // キャッシュがあれば即返る。未知トークンがなければ null。
      // ── ボタンを即座にローディング表示（APIを待たせても固まって見えないように）──
      autofillBtn.textContent = "⏳ エリア解決中...";
      autofillBtn.disabled = true;
      // 「エリア解決中...」固まり防衛: 20秒以内に「検索中...」に進まなければ自動リセット
      // （APIエラー・JSエラー等で中断した場合、ボタンが永遠に disabled のままになるのを防ぐ）
      var _areaResolveWatchdog = setTimeout(function() {
        var _b = document.getElementById("autofill-btn");
        if (_b && _b.disabled && (_b.textContent || "").includes("エリア解決中")) {
          _b.textContent = "🔍 リアプロで自動検索";
          _b.disabled = false;
          console.warn("[AX] エリア解決中 タイムアウト(20s): 自動リセット");
        }
      }, 20000);
      // ブレイン経由: resolve-area + 送付履歴 + 除外リストを1本で取得
      // フォールバック: c.id がない場合（旧顧客）は既存 resolveAreaWithAPI を使う
      const apiData = c.id
        ? await fetchBrainSearchParams(c.id, adjAreaClean)
        : await resolveAreaWithAPI(adjAreaClean, "auto", adjC.id);

      // ② ブレインAPI結果を地域・駅フィールドに反映（明示分離）
      if (apiData) {
        const _apiStNames = apiData.realpro?.station_names || [];
        const _apiWdNames = apiData.itandi?.ward_names || apiData.reins?.ward_names || [];
        if (_apiStNames.length > 0) {
          document.getElementById("adj-area-station").value = _apiStNames.join("・");
          document.getElementById("adj-area").value = _apiStNames.join("・"); // hidden sync
        }
        if (_apiWdNames.length > 0) {
          document.getElementById("adj-area-ward").value = _apiWdNames.join("・");
        }
      }

      // ③ 自動判定モードの場合のみ: API結果でモードを補正（手動クリック済みは無視）
      if (_areaModeSource === "auto" && apiData?.realpro) {
        const _hasApiSt = (apiData.realpro.station_names?.length > 0) || (apiData.realpro.route_ids?.length > 0);
        const _hasApiWd = (apiData.realpro.city_codes?.length > 0);
        if (_hasApiSt && !_hasApiWd && currentAreaMode !== "station") {
          console.log("[AX] autofill: API補正 ward→station");
          currentAreaMode = "station";
          document.getElementById("btn-mode-station")?.classList.add("active");
          document.getElementById("btn-mode-ward")?.classList.remove("active");
          renderInstrSteps("realpro", adjC);
        } else if (_hasApiWd && !_hasApiSt && currentAreaMode !== "ward") {
          console.log("[AX] autofill: API補正 station→ward");
          currentAreaMode = "ward";
          document.getElementById("btn-mode-ward")?.classList.add("active");
          document.getElementById("btn-mode-station")?.classList.remove("active");
          renderInstrSteps("realpro", adjC);
        }
      }

      // ③-pre ローカル補正: APIが不要（学習済み駅はneedApi=false→API null返却）でも
      //   LEARNED_STATION_MAPにrealpro_linesがある駅は駅モードへ自動切替
      //   ※ 同ロジックがitandiハンドラ(2546)にも存在。リアプロ側は2926以前に置くこと
      if (_areaModeSource === "auto" && currentAreaMode !== "station") {
        const _localToks = parseAreaTokens(adjAreaClean);
        const _hasKnownStation = _localToks.some(t => {
          const s = t.replace(/[町村]$/, "");
          return !!(STATION_LINE_MAP[t] || STATION_LINE_MAP[s] ||
                    LEARNED_STATION_MAP[t]?.realpro_lines?.length > 0);
        });
        if (_hasKnownStation) {
          console.log("[AX] autofill(realpro): ローカル補正 ward→station(LEARNED)");
          currentAreaMode = "station";
          document.getElementById("btn-mode-station")?.classList.add("active");
          document.getElementById("btn-mode-ward")?.classList.remove("active");
          renderInstrSteps("realpro", adjC);
        }
      }

      // ③ ボタン押下が絶対ルール: currentAreaMode を buildAreaRouteCodes に渡す
      let { city_codes, route_ids } = buildAreaRouteCodes(adjC, currentAreaMode);
      // 地域モード+広げて検索: 難波/心斎橋エリアは中央区・浪速区・西区を全域追加
      if (currentAreaMode === "ward" && searchMode === "wide") {
        city_codes = expandNambaCodes(city_codes);
      }

      // ④ APIデータを route_ids / city_codes に追記
      if (apiData?.realpro) {
        (apiData.realpro.route_ids || []).forEach(r => { if (!route_ids.includes(r)) route_ids.push(r); });
        // ※ パラメータ名は cc: 外側の const c = selectedCustomer をシャドウしないため
        (apiData.realpro.city_codes || []).forEach(cc => { if (!city_codes.includes(cc)) city_codes.push(cc); });
      }

      // ⑤ 臨機応変フォールバック: 解決結果とモードが食い違う場合に自動補正
      // （手動クリック "user" は尊重。"auto"/"bulk" は結果優先）
      if (_areaModeSource === "auto") {
        if (currentAreaMode === "station" && route_ids.length === 0 && city_codes.length > 0) {
          // 駅モードなのに route_ids が取れず city_codes だけある → 地域で検索に降格
          console.log("[AX] 臨機応変(realpro): station→ward 降格（route_ids 空, city_codes あり）");
          currentAreaMode = "ward";
          document.getElementById("btn-mode-ward")?.classList.add("active");
          document.getElementById("btn-mode-station")?.classList.remove("active");
          renderInstrSteps("realpro", adjC);
        } else if (currentAreaMode === "ward" && city_codes.length === 0 && route_ids.length > 0) {
          // 地域モードなのに city_codes が取れず route_ids だけある → 駅で検索に昇格
          console.log("[AX] 臨機応変(realpro): ward→station 昇格（city_codes 空, route_ids あり）");
          currentAreaMode = "station";
          document.getElementById("btn-mode-station")?.classList.add("active");
          document.getElementById("btn-mode-ward")?.classList.remove("active");
          renderInstrSteps("realpro", adjC);
        }
      }

      const areaParts = parseAreaTokens(adjAreaClean);
      const realpro_station_names = [];
      if (currentAreaMode === "station") {
        const resolvedStations = [];
        // 駅名ページのDOM表記エイリアス（難波=漢字→南海、なんば=ひらがな→大阪メトロ）
        const _STATION_DOM_ALIASES = { "難波": "なんば", "なんば": "難波" };
        for (const part of areaParts) {
          // 都市名・府県名トークンは駅名として station_names に追加しない
          const _SNAME_SKIP = new Set(["大阪", "大阪府", "東京", "京都", "神戸", "兵庫", "奈良", "大阪市"]);
          if (_SNAME_SKIP.has(part)) continue;
          // 路線名トークン（例: 阪急千里線・御堂筋線）→ その路線の全駅を展開してstation_namesに追加
          // ※ 沿線モーダル（label.one_line）は不安定なため、駅個別選択方式で代替する
          // ※ LEARNED_STATION_MAP で路線名が誤学習されても station_names には混入させない
          if (part.endsWith("線") && !STATION_LINE_MAP[part]) {
            const lineStations = getStationsForLine(part);
            if (lineStations.length > 0) {
              lineStations.forEach(s => { if (!realpro_station_names.includes(s)) realpro_station_names.push(s); });
              continue;
            }
            if (lineNameToRouteId(part)) continue; // 駅一覧が取れない場合もスキップ（station_map汚染防止）
          }
          let station = resolveStation(part);
          if (!station) {
            // 「阪急茨木市」「JR高槻」等: resolveStation は "市" サフィックスガードで null を返すため
            // resolveWithLinePrefixes でプレフィックス除去後に再解決する
            const _pfxR = resolveWithLinePrefixes(part);
            if (_pfxR?.type === "station") station = _pfxR.resolved;
          }
          if (station) {
            resolvedStations.push(station);
            if (!realpro_station_names.includes(station)) realpro_station_names.push(station);
            // 漢字↔ひらがなエイリアスも追加（難波→なんば でOsaka MetroのDOM、なんば→難波 で南海のDOM）
            const _stAlias = _STATION_DOM_ALIASES[station];
            if (_stAlias && !realpro_station_names.includes(_stAlias)) realpro_station_names.push(_stAlias);
            if (searchMode === "wide") {
              // STATION_LINE_MAP → LEARNED_STATION_MAP の順でその駅の路線を取得
              const stLines = STATION_LINE_MAP[station] || getLearnedStationLines(station) || [];
              // 4路線以上かつ同一事業者の場合のみ「広域ハブ」として隣接駅を省略
              // >1では本町(3路線)・堺筋本町(2路線)等も隣接駅が追加されないバグがあった（指示生成側と同じ>3に統一）
              const _isSameOpHub = stLines.length > 3 && deduplicateSameOperatorLines(stLines).length === 1;
              if (!_isSameOpHub) {
                const adj = getAdjacentStations(station, stLines);
                // itandi側と同じシンプルな実装: getAdjacentStationsは常に1駅隣のみ返すため
                // 旧クロスライン汚染チェック（every）は 十三→大阪梅田（京都線で1駅隣だが
                // 神戸・宝塚では2駅）等の正当な隣接駅を誤除外するバグがあった → 削除
                adj.forEach(s => {
                  if (!realpro_station_names.includes(s)) realpro_station_names.push(s);
                });
              }
            }
          }
        }
        // 2駅ペア間の中間駅を展開（「本町〜南森町」のような範囲指定に対応）
        // ガード: 〜/～/から〜までのような範囲記号がある場合のみ展開する
        // カンマ区切りの独立した駅リスト（例: 十三、野田阪神、福島）では展開しない
        const hasRangeSyntax = /[〜～]|から.{0,5}まで/.test(adjAreaClean);
        if (hasRangeSyntax) {
          for (let i = 0; i < resolvedStations.length - 1; i++) {
            const intermediate = expandStationRange(resolvedStations[i], resolvedStations[i + 1]);
            intermediate.forEach(s => { if (!realpro_station_names.includes(s)) realpro_station_names.push(s); });
          }
        }
      }
      // ★ station/ward モードに関わらず常に実行: 通勤時間パターン（「梅田から20分以内」等）のDijkstra展開
      // ward モードに切り替わっても Dijkstra で駅を展開し、強制的に station モードに昇格させる
      {
        const transitRe = /([^\s、。,　]{1,10}?)駅?(?:まで|から)(徒歩|電車|バス|歩いて)?(\d+)分/g;
        let _tm;
        while ((_tm = transitRe.exec(adjAreaClean)) !== null) {
          let tgt = _tm[1].replace(/駅$/, '').trim();
          const modeStr = _tm[2] || '';
          const maxMin  = parseInt(_tm[3], 10);
          for (const _pfx of LINE_PREFIXES_TO_STRIP) {
            if (tgt.startsWith(_pfx) && tgt.length > _pfx.length) { tgt = tgt.slice(_pfx.length).trim(); break; }
          }
          if (!tgt || !(maxMin > 0) || maxMin > 90) continue;
          const isWalkMode = modeStr === '徒歩' || modeStr === '歩いて';
          if (isWalkMode) {
            const hubSt = (STATION_HUB_MAP && STATION_HUB_MAP[tgt]) ? STATION_HUB_MAP[tgt] : [tgt];
            hubSt.forEach(s => { if (!realpro_station_names.includes(s)) realpro_station_names.push(s); });
          } else {
            if (typeof getStationNamesWithinMinutes === 'function') {
              // 梅田・難波等のハブ駅は複数の物理駅(阪急・JR・地下鉄等)を含む→全hub駅からDijkstraしてマージ
              const _hubStations = (STATION_HUB_MAP && STATION_HUB_MAP[tgt]) ? STATION_HUB_MAP[tgt] : [tgt];
              const _reachedSet = new Set();
              _hubStations.forEach(function(hubSt) {
                getStationNamesWithinMinutes(hubSt, maxMin).forEach(function(s) { _reachedSet.add(s); });
              });
              const _reached = Array.from(_reachedSet);
              _reached.forEach(s => { if (!realpro_station_names.includes(s)) realpro_station_names.push(s); });
              // 駅が見つかった場合は ward モードでも station モードに強制昇格
              if (_reached.length > 0 && currentAreaMode !== 'station') {
                currentAreaMode = 'station';
                updateAreaModeUI && updateAreaModeUI();
              }
            }
          }
        }
      }

      // API補完: 路線名→駅一覧を station_names に追加（currentAreaMode に関わらず実行）
      // isKnownStation で検証: 地域名・町字名がAIにより駅と誤分類されても混入しない（堀江等の防止）
      // ※ currentAreaMode === "station" 条件を削除: route_idsのみ返りstation_namesが空の場合に
      //   APIが駅名を補完していても除外されてしまうBug2-root-2を修正
      if (apiData?.realpro?.station_names?.length > 0) {
        apiData.realpro.station_names.forEach(s => {
          if (realpro_station_names.includes(s)) return;
          if (isKnownStation(s)) {
            realpro_station_names.push(s);
          } else {
            console.log('[AX] リアプロ API補完: 非駅トークンを除外:', s);
          }
        });
        // 駅が追加された場合: currentAreaMode が station でなければ昇格
        if (realpro_station_names.length > 0 && currentAreaMode !== 'station') {
          currentAreaMode = 'station';
          updateAreaModeUI && updateAreaModeUI();
          console.log('[AX] リアプロ API補完: 駅発見 → station モードに昇格');
        }
      }

      // 地名マップから町字レベルのトークンを検索（駅モード時はスキップ：所在地フィールドに入らないようにする）
      const neighPart = currentAreaMode === "station" ? null : (areaParts.find(p =>
        NEIGHBORHOOD_WARD_MAP[p] && !STATION_LINE_MAP[p] &&
        !p.endsWith("区") && !p.endsWith("市")  // 区名・市名はcity_codesで処理するためスキップ
      ) || null);
      // detail_area: 町字名はピンポイントのみ（例:「喜連西」）
      const detailNeighborhood = (searchMode === "pinpoint" && neighPart) ? neighPart : null;
      // detail_ward: detail_areaがある時だけモーダルを使う
      // 区名だけの場合はcity_codesの直接チェックで複数区を同時選択（例:北区+福島区）
      const detailWard = detailNeighborhood ? resolveWard(neighPart) : null;

      // town_names (Supabase property_customers.town_names): 複数町字指定
      // TOWN_CODE_MAP 逆引きで ward を特定 → detail_ward を上書き設定してモーダルを開く
      const customerTownNames = (c.town_names && c.town_names.length > 0) ? c.town_names : null;
      let townNamesDetailWard = null;
      if (customerTownNames) {
        const firstTown = customerTownNames[0];
        for (const ward of Object.keys(TOWN_CODE_MAP || {})) {
          if (TOWN_CODE_MAP[ward][firstTown]) { townNamesDetailWard = ward; break; }
        }
      }
      const effectiveDetailWard = townNamesDetailWard || detailWard;
      // town_names 使用時は detail_area 不要（STEP5 で townNamesForStep5 を全てクリック）
      const effectiveDetailArea = customerTownNames ? null : detailNeighborhood;

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

      // adjacent_ok: 顧客の主エリアに隣接する市区コードを city_codes に追加
      if (c.adjacent_ok && typeof ADJACENT_AREA_MAP !== 'undefined') {
        const mainWards = new Set();
        // town_names から主エリアを特定
        if (customerTownNames) {
          for (const ward of Object.keys(TOWN_CODE_MAP || {})) {
            if (customerTownNames.some(t => TOWN_CODE_MAP[ward][t])) mainWards.add(ward);
          }
        }
        // city_codes に含まれるエリアも考慮
        for (const [wardName, code] of Object.entries(WARD_CODE_MAP || {})) {
          if (city_codes.includes(code)) mainWards.add(wardName);
        }
        // 隣接エリアのコードを追加
        for (const ward of mainWards) {
          for (const adj of (ADJACENT_AREA_MAP[ward] || [])) {
            const adjCode = WARD_CODE_MAP[adj];
            if (adjCode && !city_codes.includes(adjCode)) city_codes.push(adjCode);
          }
        }
      }

      console.log('[AX] autofill送信:', {
        area_mode:       _lockedMode || currentAreaMode,
        station_names:   realpro_station_names.slice(),
        route_ids:       route_ids.slice(),
        city_codes:      city_codes.slice(),
        area:            adjAreaClean.slice(0, 40),
        area_min:        adjAreaMin ? Number(adjAreaMin) : (c.floor_area_min || c.area_min || null),
        area_max:        adjAreaMax ? Number(adjAreaMax) : (c.floor_area_max || null),
        structure_types: adjC.structure_types || null,
        building_age:    adjC.building_age || null,
        floor_plan:      adjC.floor_plan || null,
      });
      window.parent.postMessage({
        from: "aixlinx-underbar",
        action: "autofill",
        source: isAutoSendAll ? "flagged_batch" : (isAutomated ? "automated" : "manual"),
        conditions: {
          area_mode:     _lockedMode || currentAreaMode,
          rent_min:      adjC.rent_min,
          rent_max:      rpEffectiveRentMax,
          walk_minutes:  adjC.walk_minutes || apiData?.suggested_walk_minutes || null,
          floor_plan:    adjC.floor_plan,
          is_wide:       searchMode === "wide",
          building_age:  adjC.building_age
            ? (searchMode === "wide" ? adjC.building_age + 5 : adjC.building_age)
            : null,
          city_codes,
          route_ids,
          station_names: realpro_station_names,
          detail_area:   effectiveDetailArea,
          detail_ward:   effectiveDetailWard,
          town_names:    customerTownNames,
          area_min:        adjAreaMin ? Number(adjAreaMin) : (c.floor_area_min || c.area_min || c.min_area || parseAreaMin(c.floor_plan || c.layout) || parseAreaMin(c.preferences) || parseAreaMin(c.other_requests) || null),
          area_max:        adjAreaMax ? Number(adjAreaMax) : (c.floor_area_max || null),
          structure_types: adjC.structure_types,
          pet_ok: adjPet,
          shikirei_free: detectShikireiFlag(c),
          rp_update_days: adjUpdateDays ? Number(adjUpdateDays) : null,
          unknown_tokens: rpUnknownTokens.length > 0 ? rpUnknownTokens : null,
        },
      }, "*");
      // ページリロード後も自動送信が再開できるようフラグを立てる（手動・自動バッチ共通）
      // ★ 2026-08-17 修正: 以前は `if (!isAutomated)` で手動クリック限定にしていたが、
      //   リアプロは検索実行（div.go_search クリック）でページが再読み込みされるため
      //   bulk-dl.js のモジュール変数（_autoSendArmed 等）は毎回破棄される。
      //   結果ページで自動送信を起動できる経路は Case C（chrome.storage.session）だけ。
      //   手動限定にすると自動バッチ（axlx-switch-customer 経由 = isAutomated=1）は
      //   フラグが立たず、残留フラグを消費した1人目だけ動いて2人目以降が無音で死ぬ。
      //   Case A（AJAX経路）が先に発火した場合は bulk-dl.js 側でフラグを remove するため
      //   二重送信にはならない。
      try { chrome.storage.session.set({ axlx_pending_auto_send: true }); } catch (_) {}
      // スコアオーバーレイ用に有効条件（adj後）で上書き保存
      try {
        chrome.storage.session.set({ axlx_score_data: {
          rent_max:             rpEffectiveRentMax,
          walk_minutes:         adjC.walk_minutes || apiData?.suggested_walk_minutes || null,
          floor_plan:           adjC.floor_plan || null,
          building_age:         adjC.building_age || null,
          area_min:             adjAreaMin ? Number(adjAreaMin) : (c.floor_area_min || c.area_min || c.min_area || parseAreaMin(c.preferences) || parseAreaMin(c.other_requests) || null),
          customer_name:        c.customer_name,
          property_customer_id: c.id || null,
          initial_cost_limit:   c.initial_cost_limit || null,
          prefer_no_shikirei:   detectShikireiFlag(c),
          ng_points:            c.ng_points || null,
          pet_ok:               c.pet === true || c.pet === 'true' || false,
          admin_fee_max:        c.admin_fee_max || null,
        }});
      } catch (_) { /* ignore */ }
      clearTimeout(_areaResolveWatchdog); // エリア解決完了 → ウォッチドッグ解除
      autofillBtn.textContent = "⏳ 検索中...";
      autofillBtn.classList.remove("done");
      autofillBtn.classList.add("searching");
      autofillBtn.disabled = true;
      // fill-done が 25秒以内に来なければ自動リセット（固まり防衛）
      clearTimeout(_fillDoneWatchdog);
      _fillDoneWatchdog = setTimeout(() => {
        const _b = document.getElementById("autofill-btn");
        if (_b && _b.classList.contains("searching")) {
          _b.textContent = "🔍 リアプロで自動検索";
          _b.classList.remove("searching", "done");
          _b.disabled = false;
          console.warn("[AX] fill-done タイムアウト: 25秒以内に完了通知が来なかったためリセット");
        }
      }, 25000);
    };
  } else if (siteKey === "reins") {
    adjForm.style.display = "block";
    const c0 = selectedCustomer;
    preloadAdjForm(c0);
    setupAreaModeSelector(c0, "reins");
    autofillBtn.style.display = "block";
    autofillBtn.textContent = "⚡ REINSに自動入力";
    autofillBtn.className = "autofill-btn";
    autofillBtn.onclick = async () => {
      const adjC = buildAdjCustomer(c0);
      renderInstrSteps("reins", adjC);

      // ボタン押下が絶対ルール: currentAreaMode で駅 or 地域を決定
      const rawArea = (adjC.desired_area || adjC.area || "").trim();
      // ブレイン経由: resolve-area + 送付履歴 + 除外リストを1本で取得
      const apiData = adjC.id
        ? await fetchBrainSearchParams(adjC.id, rawArea)
        : await resolveAreaWithAPI(rawArea, "auto", adjC.id);

      // 自動判定モードの場合のみ: API結果でモードを補正（手動クリック済みは無視）
      if (_areaModeSource === "auto" && apiData?.realpro) {
        const _hasApiSt = (apiData.realpro.station_names?.length > 0) || (apiData.realpro.route_ids?.length > 0);
        const _hasApiWd = (apiData.realpro.city_codes?.length > 0);
        if (_hasApiSt && !_hasApiWd && currentAreaMode !== "station") {
          currentAreaMode = "station";
          document.getElementById("btn-mode-station")?.classList.add("active");
          document.getElementById("btn-mode-ward")?.classList.remove("active");
        } else if (_hasApiWd && !_hasApiSt && currentAreaMode !== "ward") {
          currentAreaMode = "ward";
          document.getElementById("btn-mode-ward")?.classList.add("active");
          document.getElementById("btn-mode-station")?.classList.remove("active");
        }
      }

      // 臨機応変フォールバック(reins): API補正後に現在モードでローカル解決できるかを確認
      // （API未呼出ケース / needApi=false でAPIモード補正がスキップされた場合をカバー）
      if (_areaModeSource === "auto") {
        const _rLocal = buildAreaRouteCodes({ desired_area: rawArea }, currentAreaMode);
        const _rEmpty = currentAreaMode === "station" ? _rLocal.route_ids.length === 0 : _rLocal.city_codes.length === 0;
        if (_rEmpty) {
          const _altMode = currentAreaMode === "station" ? "ward" : "station";
          const _rAlt = buildAreaRouteCodes({ desired_area: rawArea }, _altMode);
          const _rAltHas = _altMode === "station" ? _rAlt.route_ids.length > 0 : _rAlt.city_codes.length > 0;
          if (_rAltHas) {
            console.log(`[AX] 臨機応変(reins): ${currentAreaMode}→${_altMode} 補正`);
            currentAreaMode = _altMode;
            document.getElementById("btn-mode-station")?.classList.toggle("active", _altMode === "station");
            document.getElementById("btn-mode-ward")?.classList.toggle("active", _altMode === "ward");
          }
        }
      }

      const areaToks = parseAreaTokens(rawArea);
      const isStationMode = currentAreaMode === "station";

      // 駅モードのみ: 駅ごとに沿線を対応させたペア配列を構築（最大3駅）
      const reinsStationPairs = [];
      const _reinsLineCpRe = /^(?:阪急|阪神|南海|近鉄|JR|京阪|大阪メトロ|地下鉄)/;
      if (isStationMode) {
        for (const tok of areaToks) {
          // lookup: そのまま → [町村]除去 → 会社名プレフィックス除去 → 両方除去
          const _vs = [tok, tok.replace(/[町村]$/, ""), tok.replace(_reinsLineCpRe, ""), tok.replace(_reinsLineCpRe, "").replace(/[町村]$/, "")];
          const key = _vs.find(v => STATION_LINE_MAP[v]) || null;
          const lines = key ? (STATION_LINE_MAP[key] || []) : [];
          let reinsLine = null;
          if (lines.length > 0) {
            reinsLine = REINS_LINE_MAP[lines[0]] || lines[0];
          } else if (LEARNED_STATION_MAP[key]?.reins_line) {
            // 学習済みマップからReins路線名を取得
            reinsLine = LEARNED_STATION_MAP[key].reins_line;
          } else if (LEARNED_STATION_MAP[tok]?.reins_line) {
            reinsLine = LEARNED_STATION_MAP[tok].reins_line;
          } else {
            // 路線名として直接マッチング（「堺筋線」→「大阪メトロ堺筋線」等）
            reinsLine = Object.values(REINS_LINE_MAP).find(v => v === tok || v.endsWith(tok)) || null;
          }
          if (reinsLine && !reinsStationPairs.some(p => p.line === reinsLine)) {
            // key が確定している場合のみ実際の駅名として使用
            const isRealStation = !!key;
            reinsStationPairs.push({ line: reinsLine, station: isRealStation ? key : null });
          }
          if (reinsStationPairs.length >= 3) break;
        }
      }
      // API補完: 路線名トークン由来の REINS 路線名ペアを追加（上記ループで見逃した路線）
      if (isStationMode && apiData?.reins?.station_pairs) {
        apiData.reins.station_pairs.forEach(p => {
          if (reinsStationPairs.length < 3 && !reinsStationPairs.some(x => x.line === p.line)) {
            reinsStationPairs.push(p);
          }
        });
      }
      const reinsLine = reinsStationPairs[0]?.line || null;

      const adjPet     = document.getElementById("adj-pet")?.checked ?? false;
      const adjAreaMax = document.getElementById("adj-area-max")?.value || "";
      const adjAreaMin = document.getElementById("adj-area-min")?.value || "";
      const adjRegDate = document.getElementById("adj-reg-date")?.value || "";
      const conditions = {
        rent_max:       adjC.rent_max || null,
        walk_minutes:   adjC.walk_minutes || apiData?.suggested_walk_minutes || null,
        floor_plan:     adjC.floor_plan || null,
        building_age:   adjC.building_age || null,
        is_wide:        searchMode === "wide",
        area_min:       adjAreaMin ? Number(adjAreaMin) : (adjC.floor_area_min || parseAreaMin(adjC.floor_plan) || parseAreaMin(adjC.preferences) || parseAreaMin(adjC.other_requests) || null),
        area_max:       adjAreaMax ? Number(adjAreaMax) : (adjC.floor_area_max || null),
        reins_station_pairs: isStationMode ? reinsStationPairs : [],
        reins_line:     isStationMode ? reinsLine : null,
        station_name:   isStationMode ? (reinsStationPairs[0]?.station || null) : null,
        ward_name:      !isStationMode ? rawArea : null,
        // 区ごとに1行ずつ入れるため、解決済みフル区名の配列を渡す（最大3件）
        ward_names:     !isStationMode ? (() => {
          let wards = areaToks.map(tok => {
            const r = resolveWard(tok);
            if (r) return r;
            if (WARD_CODE_MAP[tok]) return tok;
            return null;
          }).filter(Boolean);
          // API補完: 概念エリア名・ベクトル検索で解決した区名を追加（未読だったフィールドを反映）
          if (apiData?.reins?.ward_names) {
            apiData.reins.ward_names.forEach(w => { if (!wards.includes(w)) wards.push(w); });
          }
          // 地域モード+広げて検索: 難波/心斎橋エリアは中央区・浪速区・西区を全域追加
          if (searchMode === "wide") wards = expandNambaWards(wards);
          return wards.slice(0, 3);
        })() : [],
        pet_ok:         adjPet,
        reins_reg_date: adjRegDate || null,
      };

      // スコアオーバーレイ用に有効条件（adj後）で上書き保存
      try {
        chrome.storage.session.set({ axlx_score_data: {
          rent_max:             conditions.rent_max,
          walk_minutes:         conditions.walk_minutes || null,
          floor_plan:           conditions.floor_plan || null,
          building_age:         conditions.building_age || null,
          area_min:             conditions.area_min || null,
          customer_name:        c0.customer_name,
          property_customer_id: c0.id || null,
          initial_cost_limit:   c0.initial_cost_limit || null,
          prefer_no_shikirei:   detectShikireiFlag(c0),
          ng_points:            c0.ng_points || null,
          pet_ok:               c0.pet === true || c0.pet === 'true' || false,
          admin_fee_max:        c0.admin_fee_max || null,
        }});
      } catch (_) { /* ignore */ }
      console.log('[AX] reins autofill送信:', {
        station_pairs: conditions.reins_station_pairs,
        ward_names:    conditions.ward_names,
        area_min:      conditions.area_min,
        area_max:      conditions.area_max,
        building_age:  conditions.building_age,
        floor_plan:    conditions.floor_plan,
      });
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return;
        chrome.tabs.sendMessage(tabs[0].id, {
          type: "axlx-reins-autofill",
          conditions,
        }, () => {
          if (chrome.runtime.lastError) {
            console.warn("[popup] sendMessage failed:", chrome.runtime.lastError.message);
            autofillBtn.textContent = "⚠ REINSのタブで開いてください";
            autofillBtn.classList.remove("done");
            return;
          }
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

// ── エリアタイプ判定（駅/地域フィルター用）─────────────────────────────
// DB の area_mode を優先。auto / 未設定時はテキストを classifyAreaTokens で判定。
// 混在（地域も駅も含む）お客さんは station も ward も true になる。
function customerMatchesAreaTypeFilter(c, filterMode) {
  const areaMode = c.area_mode || "auto";
  if (filterMode === "station") {
    if (areaMode === "station") return true;
    if (areaMode === "ward")    return false;
  } else if (filterMode === "ward") {
    if (areaMode === "ward")    return true;
    if (areaMode === "station") return false;
  }
  // auto / 不明 → computeAreaModeBadgeHtml で判定（バッジ表示と完全一致）
  const rawArea = (c.desired_area || c.area || "").trim();
  if (!rawArea) return false;
  const _badge = computeAreaModeBadgeHtml(rawArea);
  return filterMode === "station"
    ? _badge.includes("badge-area-station")
    : _badge.includes("badge-area-ward");
}

// ── Search + Account + AreaType + Linked filter ────────────────────
function getFilteredCustomers(q) {
  let result = allCustomers;
  if (currentAccount === "__needs_action__") {
    result = result.filter(needsActionToday);
  } else {
    if (currentAccount) result = result.filter((c) => (c.account || "") === currentAccount);
    if (linkedOnly) result = result.filter((c) => c.is_linked);
  }
  if (todayOnly) result = result.filter(needsActionToday);
  // 駅/地域フィルター（混在お客さんは両方に表示）
  if (currentAreaTypeFilter) {
    result = result.filter((c) => customerMatchesAreaTypeFilter(c, currentAreaTypeFilter));
  }
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

// ── 一括検索ツールバー ──────────────────────────────────────────────
function updateBulkToolbar() {
  const toolbar = document.getElementById("bulk-toolbar");
  const label   = document.getElementById("bulk-count-label");
  if (!toolbar) return;
  const n = selectedCustomerIds.size;
  if (n === 0) {
    toolbar.style.display = "none";
  } else {
    toolbar.style.display = "flex";
    if (label) label.textContent = n + "人選択中";
  }
}

function executeBulkSearch(site) {
  const ids = Array.from(selectedCustomerIds);
  if (!ids.length) return;

  // ループをbackground.jsに委ねる（popup.jsはリアプロページリロードで消えるため）
  chrome.runtime.sendMessage({
    type: "axlx-manual-bulk-search",
    customerIds: ids,
    site, // "realnetpro" / "itandi" / "reins" そのまま渡す
  }, () => { void chrome.runtime.lastError; });

  // 即座にチェックをクリア（backgroundが連続処理する）
  selectedCustomerIds.clear();
  updateBulkToolbar();
  document.querySelectorAll(".bulk-check").forEach((cb) => { cb.checked = false; });
}

// ── スタッフモード ──────────────────────────────────────────────────
// ONの間このPCの拡張は自動化コマンド（DBポーリングclaim・Realtimeコマンド）を無視する。
// 実際の抑止判定は background.js（_isStaffModeActive）が行う。ここはUI表示と切替のみ。
// 状態は chrome.storage.local { staffMode, staffModeAt }。2時間TTLで自動OFF（background側で判定）。
var _staffModeOn = false;

function _renderStaffMode(on) {
  _staffModeOn = !!on;
  var btn = document.getElementById("staff-mode-btn");
  var banner = document.getElementById("staff-mode-banner");
  if (btn) {
    btn.classList.toggle("on", _staffModeOn);
    btn.textContent = _staffModeOn ? "スタッフモード中" : "スタッフモード";
  }
  if (banner) banner.style.display = _staffModeOn ? "block" : "none";
}

function _initStaffModeUI() {
  try {
    chrome.storage.local.get(["staffMode"], function(res) {
      var on = !!(res && res.staffMode);
      _renderStaffMode(on);
      // ポップアップ起動時にスタッフモードONなら要対応をデフォルトに
      if (on) {
        currentAccount = "__needs_action__";
        var _acctSel0 = document.getElementById("acct-select");
        if (_acctSel0) _acctSel0.value = "__needs_action__";
      }
    });
    // 他のpopupインスタンス（サイドパネル/各タブのアンダーバー）での切替・TTL自動OFFを同期
    chrome.storage.local.onChanged.addListener(function(changes) {
      if (changes.staffMode) _renderStaffMode(!!changes.staffMode.newValue);
    });
  } catch (_) { /* ignore */ }
  var btn = document.getElementById("staff-mode-btn");
  if (btn) {
    btn.addEventListener("click", function() {
      var next = !_staffModeOn;
      _renderStaffMode(next); // 即時反映（storage.onChanged でも同期される）
      try {
        chrome.storage.local.set({ staffMode: next, staffModeAt: next ? Date.now() : null });
      } catch (_) { /* ignore */ }
      // スタッフモードON → 要対応へ自動切替
      if (next) {
        currentAccount = "__needs_action__";
        var _acctSel1 = document.getElementById("acct-select");
        if (_acctSel1) _acctSel1.value = "__needs_action__";
        filterCustomers(document.getElementById("search-input").value);
      }
    });
  }
}

// ── Init ───────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  _initStaffModeUI();
  // DBが空なら既存ハードコードデータをシード → 学習済みマップをロード
  seedMapsIfEmpty().then(() => fetchLearnedMaps());
  // DBの駅→路線キャッシュをロード（24hローカルキャッシュ・失敗時はhardcodedマップで動作継続）
  fetchStationRouteCache();
  // loadCustomers 完了後に pendingPopupCmd を確認して顧客を自動選択
  // 修正④b: 読み取り成功後にバッジをクリア（openPopup失敗時の赤バッジ '!' を消す）
  loadCustomers().then(function() {
    chrome.storage.session.get(["pendingPopupCmd"], function(res) {
      var cmd = res.pendingPopupCmd;
      if (!cmd) return;
      chrome.storage.session.remove("pendingPopupCmd");
      // openPopup() 失敗時に background.js が立てた赤バッジを消す（スタッフモード中はバッジ「手動」を維持）
      try { chrome.action.setBadgeText({ text: _staffModeOn ? '手動' : '' }); } catch (_) {}
      var c = allCustomers.find(function(x) {
        return String(x.id) === String(cmd.customerId);
      });
      if (!c) return;
      openSiteView(c);
      if (cmd.site) {
        // 顧客切替のたびに searchMode を明示的にセット（前顧客の wide 状態が引き継がれるバグを防止）
        if (cmd.is_wide) {
          var wBtnEl = document.querySelector('.mode-btn[data-mode="wide"]');
          if (wBtnEl) wBtnEl.click();
        } else {
          var pBtnEl = document.querySelector('.mode-btn[data-mode="pinpoint"]');
          if (pBtnEl) pBtnEl.click();
        }
        openInstructions(cmd.site);
        // Step ④a: setupAreaModeSelector の自動判定をウェブアプリのボタン押下で上書きする
        // 'both' のとき: 1回目は ward として実行（2回目の station は webapp が 10秒後に発火）
        if (cmd.areaMode === 'station' || cmd.areaMode === 'ward' || cmd.areaMode === 'both') {
          var _modeBtn = (cmd.areaMode === 'station') ? 'btn-mode-station' : 'btn-mode-ward';
          var btnEl = document.getElementById(_modeBtn);
          if (btnEl) btnEl.click();
        }
        // Step ④ auto-click: autofill-btnをユーザー操作に近い遅延で自動クリックする
        var _lockedAreaMode = currentAreaMode; // 顧客切替・API非同期コールバックによる上書きを防ぐ
        var _autoClickDelay = 800 + Math.floor(Math.random() * 400); // 800-1200ms
        setTimeout(function() {
          var aBtn = document.getElementById('autofill-btn');
          if (aBtn && aBtn.style.display !== 'none') {
            aBtn.dataset.automated = "1"; // 自動バッチであることを onclick ハンドラに伝える
            aBtn.dataset.auto_send_all = cmd.auto_send_all ? "1" : "";
            aBtn.dataset.area_mode_locked = _lockedAreaMode;
            aBtn.click();
            delete aBtn.dataset.automated;
            delete aBtn.dataset.auto_send_all;
            delete aBtn.dataset.area_mode_locked;
          }
        }, _autoClickDelay);
      }
    });
  });
  // popup already open のとき DOMContentLoaded は再発火しないため
  // storage.onChanged で pendingPopupCmd をリアルタイム検知して自動選択を補完する
  chrome.storage.session.onChanged.addListener(function(changes) {
    if (!changes.pendingPopupCmd || !changes.pendingPopupCmd.newValue) return;
    var cmd = changes.pendingPopupCmd.newValue;
    // allCustomers 未ロードなら DOMContentLoaded の then() 側で処理されるので無視
    if (!allCustomers || allCustomers.length === 0) return;
    chrome.storage.session.remove("pendingPopupCmd");
    try { chrome.action.setBadgeText({ text: _staffModeOn ? '手動' : '' }); } catch (_) {}
    var c = allCustomers.find(function(x) {
      return String(x.id) === String(cmd.customerId);
    });
    if (!c) return;
    openSiteView(c);
    if (cmd.site) {
      // 顧客切替のたびに searchMode を明示的にセット（前顧客の wide 状態が引き継がれるバグを防止）
      if (cmd.is_wide) {
        var wBtnEl2 = document.querySelector('.mode-btn[data-mode="wide"]');
        if (wBtnEl2) wBtnEl2.click();
      } else {
        var pBtnEl2 = document.querySelector('.mode-btn[data-mode="pinpoint"]');
        if (pBtnEl2) pBtnEl2.click();
      }
      openInstructions(cmd.site);
      // 'both' のとき: 1回目は ward として実行（2回目の station は webapp が 10秒後に発火）
      if (cmd.areaMode === 'station' || cmd.areaMode === 'ward' || cmd.areaMode === 'both') {
        var _modeBtn2 = (cmd.areaMode === 'station') ? 'btn-mode-station' : 'btn-mode-ward';
        var btnEl2 = document.getElementById(_modeBtn2);
        if (btnEl2) btnEl2.click();
      }
      // Step ④ auto-click (onChanged path)
      var _lockedAreaMode2 = currentAreaMode; // 顧客切替・API非同期コールバックによる上書きを防ぐ
      var _autoClickDelay2 = 800 + Math.floor(Math.random() * 400);
      setTimeout(function() {
        var aBtn = document.getElementById('autofill-btn');
        if (aBtn && aBtn.style.display !== 'none') {
          aBtn.dataset.automated = "1"; // 自動バッチであることを onclick ハンドラに伝える
          aBtn.dataset.auto_send_all = cmd.auto_send_all ? "1" : "";
          aBtn.dataset.area_mode_locked = _lockedAreaMode2;
          aBtn.click();
          delete aBtn.dataset.automated;
          delete aBtn.dataset.auto_send_all;
          delete aBtn.dataset.area_mode_locked;
        }
      }, _autoClickDelay2);
    }
  });

  // 初期状態で「紐付け済み」ボタンをONに見せる
  document.getElementById("linked-filter-btn").classList.add("active");

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
        clearTimeout(_fillDoneWatchdog); // 正常完了 → タイムアウト監視をキャンセル
        const btn = document.getElementById("autofill-btn");
        if (btn) {
          const _resetLabel = selectedSite === "itandi" ? "🔍 itandiで自動検索"
            : selectedSite === "reins" ? "⚡ REINSに自動入力"
            : "🔍 リアプロで自動検索";
          btn.textContent = _resetLabel;
          btn.classList.remove("searching", "done");
          btn.disabled = false;
        }
      }
      // bulk-dl.jsからの顧客名要求（売上番長に送る時に自動反映）
      if (e.data?.from === "axlx-get-customer") {
        window.parent.postMessage({
          from: "axlx-customer-response",
          name: selectedCustomer?.customer_name ?? "",
          id: selectedCustomer?.id ?? null,
          conditions: buildCustomerConditionsString(selectedCustomer),
        }, "*");
      }
      // ── underbar.js経由の顧客切替指示（Approach D: tabs.sendMessage → postMessage 2段中継）──
      // chrome.runtime.sendMessage のiframe frame登録ラグを回避するため
      // background.js → tabs.sendMessage → underbar.js → postMessage → ここ の経路を使う
      if (e.data?.from === "underbar-parent" && e.data?.action === "switch-customer") {
        (async function() {
          // allCustomers ロード完了待ち（初回ロード時の非同期フェッチ完了前に届く場合を吸収 Bug 1 fix）
          var deadline = Date.now() + 5000;
          while ((!allCustomers || !allCustomers.length) && Date.now() < deadline) {
            await new Promise(function(r) { setTimeout(r, 100); });
          }
          var c = (allCustomers || []).find(function(x) {
            return String(x.id) === String(e.data.customerId);
          });
          if (!c) {
            console.warn("[popup] switch-customer postMessage: 顧客が見つかりません id=", e.data.customerId);
            return;
          }
          openSiteView(c);
          if (e.data.site) {
            // 顧客切替のたびに searchMode を明示的にセット（前顧客の wide 状態が引き継がれるバグを防止）
            if (e.data.is_wide) {
              var wBtn = document.querySelector('.mode-btn[data-mode="wide"]');
              if (wBtn) wBtn.click();
            } else {
              var pBtn = document.querySelector('.mode-btn[data-mode="pinpoint"]');
              if (pBtn) pBtn.click();
            }
            openInstructions(e.data.site);
            if (e.data.areaMode === 'station' || e.data.areaMode === 'ward') {
              var mBtn = document.getElementById(
                e.data.areaMode === 'station' ? 'btn-mode-station' : 'btn-mode-ward'
              );
              if (mBtn) mBtn.click();
            }
            await new Promise(function(r) {
              setTimeout(r, 800 + Math.floor(Math.random() * 400));
            });
            var aBtn = document.getElementById('autofill-btn');
            if (aBtn) {
              aBtn.dataset.automated = "1";
              aBtn.dataset.auto_send_all = e.data.auto_send_all ? "1" : "";
              aBtn.click();
              delete aBtn.dataset.automated;
              delete aBtn.dataset.auto_send_all;
            }
          }
        })();
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

  // 乗り換え検索チェックボックス
  document.getElementById("enableTransfer")?.addEventListener("change", function() {
    const opts = document.getElementById("transfer-options");
    if (opts) opts.style.display = this.checked ? "flex" : "none";
    updateTransferCountLabel();
    if (selectedSite) renderInstrSteps(selectedSite, buildAdjCustomer(selectedCustomer));
  });
  document.getElementById("maxTransfers")?.addEventListener("change", () => {
    updateTransferCountLabel();
    if (selectedSite) renderInstrSteps(selectedSite, buildAdjCustomer(selectedCustomer));
  });
  document.getElementById("maxMinutes")?.addEventListener("change", () => {
    updateTransferCountLabel();
    if (selectedSite) renderInstrSteps(selectedSite, buildAdjCustomer(selectedCustomer));
  });

  document.getElementById("search-input").addEventListener("input", (e) => {
    filterCustomers(e.target.value);
  });

  document.getElementById("acct-select")?.addEventListener("change", (e) => {
    currentAccount = e.target.value;
    filterCustomers(document.getElementById("search-input").value);
  });

  // ── 駅/地域フィルターボタン（トグル式・排他選択）──────────────────────────
  ["filter-station-btn", "filter-ward-btn"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", () => {
      const mode = id === "filter-station-btn" ? "station" : "ward";
      if (currentAreaTypeFilter === mode) {
        // 同じボタンを再クリック → 解除（すべて表示）
        currentAreaTypeFilter = "";
        document.getElementById(id).classList.remove("active");
      } else {
        currentAreaTypeFilter = mode;
        document.getElementById("filter-station-btn").classList.toggle("active", mode === "station");
        document.getElementById("filter-ward-btn").classList.toggle("active", mode === "ward");
      }
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
    if (!btn.dataset.site) return; // estimate-btn 等 data-site なしのボタンはスキップ
    btn.addEventListener("click", () => {
      openInstructions(btn.dataset.site);
    });
  });

  // ── 見積書クイックボタン（View 1・紐付け済みタブ右）──────────────────────────
  document.getElementById("estimate-quick-btn")?.addEventListener("click", () => {
    chrome.tabs.create({ url: `${API_BASE}/estimate` });
  });

  // ── 見積書ボタン（View 2） ──────────────────────────────────────────
  document.getElementById("estimate-btn")?.addEventListener("click", () => {
    if (!selectedCustomer) {
      alert("お客さんを選択してください");
      return;
    }
    const rent = selectedCustomer.rent_max || selectedCustomer.max_rent || 0;
    const customerName = encodeURIComponent(selectedCustomer.customer_name || "");
    const account = encodeURIComponent(selectedCustomer.account || "");

    // 既存の見積書タブ & リアプロタブを探す
    chrome.tabs.query({}, function (tabs) {
      var estimateTab = null;
      var realproTab = null;
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].url && tabs[i].url.includes(API_BASE + "/estimate")) {
          estimateTab = tabs[i];
        }
        if (!realproTab && tabs[i].url && tabs[i].url.includes("realnetpro.com")) {
          realproTab = tabs[i];
        }
      }

      if (estimateTab && estimateTab.id) {
        // 既存タブがあれば前面に出して自動モードをトリガー
        var tabId = estimateTab.id;
        chrome.tabs.update(tabId, { active: true }, function () {
          setTimeout(function () {
            chrome.scripting.executeScript({
              target: { tabId: tabId },
              world: "MAIN",
              func: function () {
                if (typeof window.__axlxRunEstimateAuto === "function") {
                  window.__axlxRunEstimateAuto();
                  return true;
                }
                return false;
              },
            }, function (results) {
              var triggered = results && results[0] && results[0].result;
              if (!triggered) {
                alert("見積書ページが準備できていません。\n画像をアップロードしてから再度お試しください。");
              }
            });
          }, 300);
        });
      } else if (realproTab && realproTab.id) {
        // リアプロタブがあればフリーワードを読んで直接検索
        var rpTabId = realproTab.id;
        chrome.scripting.executeScript({
          target: { tabId: rpTabId },
          world: "MAIN",
          func: function() {
            var sels = [
              'input[name="keyword"]',
              'input[type="search"]',
              'input[name="free_word"]',
              'input[name="freeword"]',
              'input[name="building_name"]',
              'input[placeholder*="フリーワード"]',
              'input[placeholder*="物件名"]',
            ];
            for (var i = 0; i < sels.length; i++) {
              var el = document.querySelector(sels[i]);
              if (el && el.value && el.value.trim()) return el.value.trim();
            }
            return "";
          }
        }, function(results) {
          var fwValue = (results && results[0] && results[0].result) || "";
          if (fwValue) {
            // フリーワードに値あり → リアプロ自動検索（background.jsが見積書ページを開く）
            chrome.runtime.sendMessage({
              type: "axlx-estimate-realpro-search",
              propertyName: fwValue,
              roomNumber: "",
              fromPopup: true
            }, function(resp) {
              void chrome.runtime.lastError;
              if (!resp || !resp.ok) {
                alert("リアプロ検索エラー: " + ((resp && resp.error) || "不明なエラー"));
              }
            });
          } else {
            // フリーワード空 → 見積書ページを開く
            chrome.tabs.create({ url: `${API_BASE}/estimate` });
          }
        });
      } else {
        // リアプロタブも見つからなければ見積書ページを開く
        chrome.tabs.create({
          url: `${API_BASE}/estimate`,
        });
      }
    });
  });
});

// ── フィードバック機能 ──────────────────────────────
(function() {
  var fbBtn = document.getElementById('feedback-btn');
  var fbOverlay = document.getElementById('feedback-overlay');
  var fbCancel = document.getElementById('feedback-cancel-btn');
  var fbSubmit = document.getElementById('feedback-submit-btn');
  var fbStatus = document.getElementById('feedback-status');

  if (!fbBtn || !fbOverlay) return;

  fbBtn.addEventListener('click', function() {
    fbOverlay.style.display = 'flex';
    fbStatus.textContent = '';
  });
  fbCancel.addEventListener('click', function() {
    fbOverlay.style.display = 'none';
  });
  fbOverlay.addEventListener('click', function(e) {
    if (e.target === fbOverlay) fbOverlay.style.display = 'none';
  });
  fbSubmit.addEventListener('click', async function() {
    var category = document.getElementById('feedback-category').value;
    var content = document.getElementById('feedback-text').value.trim();
    if (!content) { fbStatus.textContent = '内容を入力してください'; return; }
    fbSubmit.disabled = true;
    fbStatus.textContent = '送信中…';
    try {
      var areaRaw = (selectedCustomer) ? (selectedCustomer.desired_area || selectedCustomer.area || '') : '';
      var siteKey = selectedSite || '';
      var res = await fetch(API_BASE + '/api/chrome-extension-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: category, content: content, area_raw: areaRaw, site: siteKey })
      });
      var json = await res.json();
      if (json.ok) {
        fbStatus.textContent = '✅ 送信しました！';
        document.getElementById('feedback-text').value = '';
        setTimeout(function() { fbOverlay.style.display = 'none'; }, 1200);
      } else {
        fbStatus.textContent = '❌ 送信失敗: ' + (json.error || '不明なエラー');
      }
    } catch(e) {
      fbStatus.textContent = '❌ 通信エラー: ' + e.message;
    }
    fbSubmit.disabled = false;
  });
})();

// ── axlx-switch-customer: 連続顧客切替メッセージハンドラ ──────────────────────
// background.js から送られてくる { type: "axlx-switch-customer", customerId, site, areaMode }
// を受け取り、ポップアップを即座に該当顧客・サイトに切り替えて autofill を自動実行する。
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type === "axlx-switch-customer") {
    (async function() {
      try {
        // allCustomers からIDで顧客を検索
        var c = (allCustomers || []).find(function(x) {
          return String(x.id) === String(msg.customerId);
        });
        if (!c) {
          console.warn("[popup] axlx-switch-customer: 顧客が見つかりません id=", msg.customerId);
          sendResponse({ ok: false, reason: "customer not found" });
          return;
        }
        // 顧客サイト選択ビューに切り替え（selectedCustomer を更新し view-site を表示）
        openSiteView(c);
        if (msg.site) {
          // wide モードを正しく切り替え（else がないと前顧客の wide が引き継がれる）
          if (msg.is_wide) {
            var wBtnEl = document.querySelector('.mode-btn[data-mode="wide"]');
            if (wBtnEl) wBtnEl.click();
          } else {
            var pBtnEl = document.querySelector('.mode-btn[data-mode="pinpoint"]');
            if (pBtnEl) pBtnEl.click();
          }
          // サイト別手順ビューを開く（selectedSite を更新）
          openInstructions(msg.site);
          // areaMode が指定されていればモードをセット
          // ※ modeBtn.click() は _areaModeSource="user" にしてしまいAPIによる自動補正を封じるため
          //   一括検索（DB設定）では "auto" に留め、臨機応変フォールバックが働くようにする
          if (msg.areaMode === 'station' || msg.areaMode === 'ward') {
            var modeBtn = document.getElementById(
              msg.areaMode === 'station' ? 'btn-mode-station' : 'btn-mode-ward'
            );
            if (modeBtn) {
              modeBtn.click(); // UI更新（active class 切り替え）
              _areaModeSource = "auto"; // "user" → "auto" に戻して臨機応変補正を許可
            }
          }
          // DOM レンダリング完了を待って autofill-btn をクリック
          await new Promise(function(resolve) {
            setTimeout(resolve, 800 + Math.floor(Math.random() * 400));
          });
          var aBtn = document.getElementById('autofill-btn');
          if (aBtn) {
            aBtn.dataset.auto_send_all = msg.auto_send_all ? "1" : "";
            aBtn.click(); // display:noneでもonclickは発火する
            delete aBtn.dataset.auto_send_all;
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false });
          }
        } else {
          // Bug 3 fix: msg.site が falsy の場合も必ず sendResponse を呼ぶ（チャンネル放置防止）
          sendResponse({ ok: false, reason: "no-site" });
        }
      } catch(e) {
        console.error("[popup] axlx-switch-customer error:", e);
        sendResponse({ ok: false });
      }
    })();
    return true; // 非同期 sendResponse のためチャンネルを開いたままにする
  }
});

// ── 一括検索ツールバーボタン ──────────────────────────────────────
(function() {
  document.querySelectorAll(".bulk-site-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      executeBulkSearch(btn.dataset.bulkSite);
    });
  });
  var cancelBtn = document.getElementById("bulk-cancel-btn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", function() {
      selectedCustomerIds.clear();
      updateBulkToolbar();
      document.querySelectorAll(".bulk-check").forEach(function(cb) { cb.checked = false; });
    });
  }
})();
