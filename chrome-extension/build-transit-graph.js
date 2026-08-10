/**
 * build-transit-graph.js
 * Extracts LINE_STATION_ORDER from popup-maps.js and builds TRANSIT_GRAPH.
 * Run: node build-transit-graph.js   (from chrome-extension/ directory)
 *
 * Edge format (adj values): [neighborName, lineName, travelTimeMinutes]
 * Transfer edge:            [neighborName, "transfer", 5]
 */

const fs   = require('fs');
const path = require('path');

// ── Paths ──────────────────────────────────────────────────────────────────
const SRC_FILE  = path.join(__dirname, 'popup-maps.js');
const OUT_FILE  = path.join(__dirname, 'transit_graph.js');

// ── Travel time lookup (minutes per stop between consecutive stations) ─────
// Keys must match the exact line names used in popup-maps.js LINE_STATION_ORDER
// and in EXTRA_STATION_ORDERS below.
const LINE_TRAVEL_TIMES = {
  // 大阪メトロ全線 (2 min/stop)
  "大阪市高速軌道御堂筋線":     2,
  "大阪市高速軌道谷町線":       2,
  "大阪市高速軌道四つ橋線":     2,
  "大阪市高速軌道中央線":       2,
  "大阪市高速軌道千日前線":     2,
  "大阪市高速軌道堺筋線":       2,
  "大阪市高速軌道長堀鶴見緑地線": 2,
  "大阪市高速軌道今里筋線":     2,
  "大阪市高速軌道南港ポートタウン線": 2,

  // 北大阪急行
  "北大阪急行南北線":           2,

  // 阪急
  "阪急電鉄神戸線":             3,
  "阪急電鉄宝塚線":             3,
  "阪急電鉄京都線":             3,
  "阪急電鉄千里線":             2,
  "阪急電鉄箕面線":             3,

  // 阪神
  "阪神電鉄本線":               3,
  "阪神電鉄阪神なんば線":       3,

  // 南海
  "南海電鉄南海本線":           3,
  "南海電鉄高野線":             4,
  "南海電鉄泉北線":             3,
  "南海電鉄南本線":             3,

  // 京阪
  "京阪電気鉄道京阪線":         3,
  "京阪電気鉄道中之島線":       3,

  // JR
  "大阪環状線":                 2,
  "東海道本線":                 3,
  "JR東西線":                   3,
  "片町線":                     3,   // 学研都市線
  "阪和線":                     3,
  "関西本線":                   4,   // 大和路線
  "おおさか東線":               3,

  // 近鉄
  "近鉄難波・奈良線":           3,
  "近鉄南大阪線":               3,
  "近鉄大阪線":                 4,
  "近鉄けいはんな線":           3,
  "近鉄長野線":                 3,

  // モノレール
  "大阪モノレール本線":         3,
  "大阪モノレール彩都線":       3,

  // 能勢電鉄
  "能勢電鉄妙見線":             3,
  "能勢電鉄日生線":             3,

  // 阪堺（路面電車）
  "阪堺電気軌道上町線":         3,
  "阪堺電気軌道阪堺線":         3,

  // EXTRA lines added by this script
  "JR大和路線":                 4,
  "JR学研都市線":               3,
};
const DEFAULT_LINE_TIME = 3; // 未登録路線のデフォルト
const TRANSFER_TIME     = 5; // 乗り換え歩行+待ち時間

// ── Extra suburban lines / extensions not fully covered in popup-maps.js ───
const EXTRA_STATION_ORDERS = {
  "JR大和路線": [
    "JR難波","今宮","新今宮","天王寺","東部市場前","加美",
    "久宝寺","八尾","志紀","柏原","高井田中央","河内堅上",
    "三郷","王寺","大和小泉","郡山","大和郡山","法隆寺","王寺",
  ],
  "JR学研都市線": [
    "京橋","鴫野","鴻池新田","住道","野崎","四条畷",
    "忍ヶ丘","星田","東寝屋川","寝屋川公園","香里園","西木津",
  ],
};

// ── Step 1: Extract LINE_STATION_ORDER from popup-maps.js ──────────────────
const src = fs.readFileSync(SRC_FILE, 'utf8');

/**
 * Brace-counting parser: finds the object literal assigned to a given
 * const/let/var name, handling string literals and escape sequences so that
 * braces inside strings are ignored.
 */
function extractObjectLiteral(source, varName) {
  const startRe = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*\\{`);
  const match   = startRe.exec(source);
  if (!match) throw new Error(`Cannot find variable "${varName}" in source.`);

  const openBraceIdx = match.index + match[0].length - 1;
  let depth = 0;
  let inStr  = false;
  let strCh  = '';
  let i      = openBraceIdx;

  while (i < source.length) {
    const ch = source[i];

    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === strCh) inStr = false;
    } else {
      if (ch === '"' || ch === "'" || ch === '`') {
        inStr = true;
        strCh = ch;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) return source.slice(openBraceIdx, i + 1);
      }
    }
    i++;
  }
  throw new Error(`Unbalanced braces while parsing "${varName}".`);
}

const objLiteral = extractObjectLiteral(src, 'LINE_STATION_ORDER');

let LINE_STATION_ORDER;
try {
  LINE_STATION_ORDER = (new Function(`return ${objLiteral}`))();
} catch (e) {
  throw new Error(`eval of LINE_STATION_ORDER failed: ${e.message}`);
}

// Merge EXTRA_STATION_ORDERS (add or extend)
for (const [lineName, stations] of Object.entries(EXTRA_STATION_ORDERS)) {
  if (!LINE_STATION_ORDER[lineName]) {
    LINE_STATION_ORDER[lineName] = stations;
  }
  // If already present from popup-maps.js under the same key, skip (avoid duplication).
  // EXTRA entries use canonical JR/Kintetsu names distinct from popup-maps.js keys.
}

const lineNames = Object.keys(LINE_STATION_ORDER);
console.log(`Loaded ${lineNames.length} lines (${Object.keys(EXTRA_STATION_ORDERS).length} extra)`);

// ── Step 2: Named transfers ────────────────────────────────────────────────
const NAMED_TRANSFERS = [
  // 梅田エリア
  ["梅田", "東梅田"],
  ["梅田", "西梅田"],
  ["梅田", "大阪"],
  ["梅田", "北新地"],
  ["梅田", "大阪梅田"],
  ["東梅田", "西梅田"],
  ["東梅田", "大阪"],
  ["東梅田", "北新地"],
  ["東梅田", "大阪梅田"],
  ["西梅田", "大阪"],
  ["西梅田", "北新地"],
  ["西梅田", "大阪梅田"],
  ["大阪", "北新地"],
  ["大阪", "大阪梅田"],
  ["北新地", "大阪梅田"],

  // なんばエリア
  ["なんば", "難波"],
  ["なんば", "大阪難波"],
  ["なんば", "JR難波"],
  ["難波", "大阪難波"],
  ["難波", "JR難波"],
  ["大阪難波", "JR難波"],

  // 天王寺エリア
  ["天王寺", "大阪阿部野橋"],
  ["天王寺", "阿倍野"],
  ["大阪阿部野橋", "阿倍野"],

  // 各所
  ["新大阪", "西中島南方"],
  ["京橋", "大阪城北詰"],
  ["南森町", "大阪天満宮"],
  ["鶴橋", "今里"],
  ["天下茶屋", "岸里玉出"],
  ["恵美須町", "動物園前"],
  ["西九条", "安治川口"],
  ["北浜", "淀屋橋"],
  ["中百舌鳥", "白鷺"],
];

// ── Step 3: Build the graph ────────────────────────────────────────────────
// Internally: { name, lines: Set, adj: Map<key, {to, line, type, travel_time}> }

const nodes = new Map();

function getOrCreate(name) {
  if (!nodes.has(name)) {
    nodes.set(name, { name, lines: new Set(), adj: new Map() });
  }
  return nodes.get(name);
}

function lineTime(lineName) {
  return LINE_TRAVEL_TIMES[lineName] ?? DEFAULT_LINE_TIME;
}

for (const [lineName, stations] of Object.entries(LINE_STATION_ORDER)) {
  const tt = lineTime(lineName);
  for (let i = 0; i < stations.length; i++) {
    const cur = getOrCreate(stations[i]);
    cur.lines.add(lineName);

    if (i > 0) {
      const prev = stations[i - 1];
      const next = stations[i];
      const pNode = getOrCreate(prev);
      pNode.adj.set(`>${next}|${lineName}`, { to: next, line: lineName, type: 'line', travel_time: tt });
      const nNode = getOrCreate(next);
      nNode.adj.set(`<${prev}|${lineName}`, { to: prev, line: lineName, type: 'line', travel_time: tt });
    }
  }
}

let warnCount = 0;
for (const [a, b] of NAMED_TRANSFERS) {
  const nodeA = nodes.get(a);
  const nodeB = nodes.get(b);
  if (!nodeA) { console.warn(`WARN: transfer station "${a}" not found`); warnCount++; continue; }
  if (!nodeB) { console.warn(`WARN: transfer station "${b}" not found`); warnCount++; continue; }
  nodeA.adj.set(`transfer|${b}`, { to: b, line: 'transfer', type: 'transfer', travel_time: TRANSFER_TIME });
  nodeB.adj.set(`transfer|${a}`, { to: a, line: 'transfer', type: 'transfer', travel_time: TRANSFER_TIME });
}

// ── Step 4: Serialize ──────────────────────────────────────────────────────
// adj values → compact array [neighborName, lineName, travelTimeMinutes]
const output = {};
let totalEdges = 0;

for (const [name, node] of nodes) {
  const adjObj = {};
  for (const [key, edge] of node.adj) {
    adjObj[key] = [edge.to, edge.line, edge.travel_time];
    totalEdges++;
  }
  output[name] = {
    name:  node.name,
    lines: Array.from(node.lines),
    adj:   adjObj,
  };
}

// ── Step 5: Write transit_graph.js ────────────────────────────────────────
const banner = [
  '// AUTO-GENERATED by build-transit-graph.js — do not edit manually.',
  `// Source: popup-maps.js  |  Lines: ${lineNames.length}  |  Stations: ${nodes.size}  |  Edges: ${totalEdges}`,
  `// Generated: ${new Date().toISOString()}`,
  '//',
  '// adj entry format: [neighborName, lineName, travelTimeMinutes]',
  '// transfer entry:   [neighborName, "transfer", 5]',
  '',
  '/* global TRANSIT_GRAPH */',
  'const TRANSIT_GRAPH = ',
  JSON.stringify(output, null, 2),
  ';',
  '',
  '// For Node.js (build/test usage)',
  'if (typeof module !== "undefined") module.exports = { TRANSIT_GRAPH };',
].join('\n');

fs.writeFileSync(OUT_FILE, banner, 'utf8');

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`\n=== Build complete ===`);
console.log(`  Lines:    ${lineNames.length}`);
console.log(`  Stations: ${nodes.size}`);
console.log(`  Edges:    ${totalEdges}  (adj entries, counting both directions)`);
if (warnCount) console.log(`  Warnings: ${warnCount} missing transfer stations`);
console.log(`  Output:   ${OUT_FILE}`);

// Spot-check: 西九条 and 梅田
console.log('\n--- Spot checks: 西九条 and 梅田 ---');
for (const s of ['西九条', '梅田']) {
  const n = output[s];
  if (!n) { console.log(`  ${s}: NOT FOUND`); continue; }
  console.log(`\n  ${s}:`);
  console.log(`    lines: [${n.lines.join(', ')}]`);
  console.log(`    adj (${Object.keys(n.adj).length} entries):`);
  for (const [key, val] of Object.entries(n.adj)) {
    console.log(`      ${key}: [${val.join(', ')}]`);
  }
}
