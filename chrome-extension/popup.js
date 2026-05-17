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
};

function findStationWard(areaText) {
  const normalized = areaText.replace(/駅|周辺|付近|近く|沿線/g, "").trim();
  return STATION_WARD_MAP[normalized] || STATION_WARD_MAP[areaText] || null;
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
          steps.push({
            num: n++,
            field: "【沿線・駅】絞り込み",
            value: areaText,
            note: d.isWide ? "広げて：この駅 ＋ 隣の駅も追加で選択する（「駅名から絞り込み」で隣駅を検索）" : null,
            hint: "左メニュー「沿線・駅絞り込み ＋」→「駅名から絞り込み」に駅名を入力 → 沿線を選択 → 右側「駅の設定へ進む ›」→ 駅を選択 → 「確定してリストへ」",
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
      return [
        {
          num: 1,
          field: "地域・駅",
          value: d.area,
          hint: "エリアタブまたは路線タブから絞り込み",
        },
        {
          num: 2,
          field: "家賃（上限）",
          value: d.rentMax,
          hint: "家賃上限を入力（管理費別の場合に注意）",
          copyRaw: d.rentMaxNum ? String(d.rentMaxNum) : null,
        },
        {
          num: 3,
          field: "間取り",
          value: d.floorPlan,
          hint: "間取り絞り込みタブから選択",
        },
        {
          num: 4,
          field: "駅徒歩",
          value: d.walkMin,
          hint: "「駅から徒歩〇分以内」を選択",
        },
        {
          num: 5,
          field: "築年数",
          value: d.buildingAge,
          hint: "「築〇年以内」の条件を設定",
        },
        {
          num: 6,
          field: "入居可能日",
          value: d.moveInTime,
          hint: "入居可能日の条件で絞り込み",
        },
        {
          num: 7,
          field: "特徴・設備",
          value: d.preferences,
          hint: "詳細条件の設備・特徴タブから選択",
        },
        {
          num: 8,
          field: "NG条件（確認用）",
          value: d.ngPoints,
          hint: "この条件の物件は除外して候補を絞る",
        },
      ].filter((s) => s.value);
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

// ── View switching ─────────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(id).classList.add("active");
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
function openInstructions(siteKey) {
  selectedSite = siteKey;
  const cfg = SITE_CONFIG[siteKey];
  const steps = cfg.steps(selectedCustomer, searchMode);

  document.getElementById("instr-title").textContent = cfg.icon + " " + cfg.name;

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

  document.getElementById("refresh-btn").addEventListener("click", () => {
    showView("view-list");
    loadCustomers();
  });

  // 検索モード切替
  const modeDescs = {
    pinpoint: "条件ぴったりで検索",
    wide: "エリア・家賃・広さを少し広げて検索",
  };
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      searchMode = btn.dataset.mode;
      document.querySelectorAll(".mode-btn").forEach((b) => {
        b.classList.remove("active", "pinpoint", "wide");
      });
      btn.classList.add("active", searchMode);
      document.getElementById("mode-desc").textContent = modeDescs[searchMode];
    });
  });
  // 初期状態のスタイル設定
  document.querySelector(".mode-btn[data-mode='pinpoint']").classList.add("pinpoint");

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
