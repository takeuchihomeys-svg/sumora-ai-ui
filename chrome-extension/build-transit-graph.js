/**
 * build-transit-graph.js
 * Extracts LINE_STATION_ORDER from popup-maps.js and builds TRANSIT_GRAPH.
 * Run: node build-transit-graph.js   (from chrome-extension/ directory)
 */

const fs   = require('fs');
const path = require('path');

// ── Paths ──────────────────────────────────────────────────────────────────
const SRC_FILE  = path.join(__dirname, 'popup-maps.js');
const OUT_FILE  = path.join(__dirname, 'transit_graph.js');

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

  // Start at the opening brace we matched
  const openBraceIdx = match.index + match[0].length - 1; // index of '{'
  let depth = 0;
  let inStr  = false;
  let strCh  = '';
  let i      = openBraceIdx;

  while (i < source.length) {
    const ch = source[i];

    if (inStr) {
      if (ch === '\\') {
        i += 2; // skip escaped char
        continue;
      }
      if (ch === strCh) inStr = false;
    } else {
      if (ch === '"' || ch === "'" || ch === '`') {
        inStr = true;
        strCh = ch;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return source.slice(openBraceIdx, i + 1);
        }
      }
    }
    i++;
  }
  throw new Error(`Unbalanced braces while parsing "${varName}".`);
}

const objLiteral = extractObjectLiteral(src, 'LINE_STATION_ORDER');

// Wrap in a JS expression and eval
let LINE_STATION_ORDER;
try {
  // Use Function constructor so we don't need full Node vm module
  LINE_STATION_ORDER = (new Function(`return ${objLiteral}`))();
} catch (e) {
  throw new Error(`eval of LINE_STATION_ORDER failed: ${e.message}`);
}

const lineNames = Object.keys(LINE_STATION_ORDER);
console.log(`Loaded ${lineNames.length} lines from popup-maps.js`);

// ── Step 2: Named transfers (physically adjacent but differently-named) ─────
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

// ── Step 3: Build the graph ───────────────────────────────────────────────
// Node structure:
//   { name, lines: Set<string>, adj: Map<key, {to, line, type}> }
// We use a direction-prefixed key "<prev|line" / ">next|line" to avoid
// collisions at terminal stations where the same line name appears twice.

const nodes = new Map(); // stationName → node

function getOrCreate(name) {
  if (!nodes.has(name)) {
    nodes.set(name, { name, lines: new Set(), adj: new Map() });
  }
  return nodes.get(name);
}

// Build edges from consecutive station pairs
for (const [lineName, stations] of Object.entries(LINE_STATION_ORDER)) {
  for (let i = 0; i < stations.length; i++) {
    const cur = getOrCreate(stations[i]);
    cur.lines.add(lineName);

    if (i > 0) {
      const prev = stations[i - 1];
      const next = stations[i];
      // prev → next
      const pNode = getOrCreate(prev);
      pNode.adj.set(`>${next}|${lineName}`, { to: next,  line: lineName, type: 'line' });
      // next → prev
      const nNode = getOrCreate(next);
      nNode.adj.set(`<${prev}|${lineName}`, { to: prev,  line: lineName, type: 'line' });
    }
  }
}

// Apply named transfers
let warnCount = 0;
for (const [a, b] of NAMED_TRANSFERS) {
  const nodeA = nodes.get(a);
  const nodeB = nodes.get(b);
  if (!nodeA) { console.warn(`WARN: transfer station "${a}" not found`); warnCount++; continue; }
  if (!nodeB) { console.warn(`WARN: transfer station "${b}" not found`); warnCount++; continue; }
  nodeA.adj.set(`transfer|${b}`, { to: b, line: 'transfer', type: 'transfer' });
  nodeB.adj.set(`transfer|${a}`, { to: a, line: 'transfer', type: 'transfer' });
}

// ── Step 4: Serialize to a plain JS object ────────────────────────────────
const output = {};
let totalEdges = 0;

for (const [name, node] of nodes) {
  const adjObj = {};
  for (const [key, edge] of node.adj) {
    adjObj[key] = edge;
    totalEdges++;
  }
  output[name] = {
    name:  node.name,
    lines: Array.from(node.lines),
    adj:   adjObj,
  };
}

// ── Step 5: Write transit_graph.js ───────────────────────────────────────
const banner = [
  '// AUTO-GENERATED by build-transit-graph.js — do not edit manually.',
  `// Source: popup-maps.js  |  Lines: ${lineNames.length}  |  Stations: ${nodes.size}  |  Edges: ${totalEdges}`,
  `// Generated: ${new Date().toISOString()}`,
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

// ── Report ────────────────────────────────────────────────────────────────
console.log(`\n=== Build complete ===`);
console.log(`  Lines:    ${lineNames.length}`);
console.log(`  Stations: ${nodes.size}`);
console.log(`  Edges:    ${totalEdges}  (adj entries, counting both directions)`);
if (warnCount) console.log(`  Warnings: ${warnCount} missing transfer stations`);
console.log(`  Output:   ${OUT_FILE}`);

// Print first 5 station entries as a spot-check (use serialized output, not raw nodes)
console.log('\n--- First 5 station entries ---');
let shown = 0;
for (const [name, n] of Object.entries(output)) {
  if (shown >= 5) break;
  const adjKeys = Object.keys(n.adj);
  console.log(`  ${name}: lines=[${n.lines.join(', ')}]  adj(${adjKeys.length})=[${adjKeys.slice(0,4).join(', ')}${adjKeys.length > 4 ? '...' : ''}]`);
  shown++;
}

// Spot-check key stations
console.log('\n--- Spot checks ---');
const checks = ['梅田','天王寺','なんば','鶴橋','布施','淡路'];
for (const s of checks) {
  const n = output[s];
  if (!n) { console.log(`  ${s}: NOT FOUND`); continue; }
  const adjKeys = Object.keys(n.adj);
  console.log(`  ${s}: lines=[${n.lines.join(', ')}]  adj(${adjKeys.length})=[${adjKeys.slice(0,6).join(', ')}${adjKeys.length>6?'...':''}]`);
}
