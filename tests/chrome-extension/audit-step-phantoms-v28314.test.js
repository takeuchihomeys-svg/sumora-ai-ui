/**
 * 2.8.314 「点検の段の幽霊」を見つける土台（機能が黙って消えるのを止める）。
 *
 *   実例（2026-11-27）: 2.8.162 の「指定駅・沿線だけ先に押す」（station_primary_only／line_primary_only）と
 *   2.8.166 の list_handoff_seen、2.8.284 の置き換えで消えた reset の段は、点検の保持表（search-audit.js の
 *   KEEP_STEP／RULE_STEP）には名前が残ったまま、出す側のコードだけ無かった（2.8.187 の復旧事故などで戻らなかった）。
 *   試験も「名前の文字がある」だけだったので、赤になったまま古い赤の山に埋もれていた。
 *
 *   → 保持表の名前を1つずつ取り出し、拡張のどこにも出てこない物を「幽霊」として数える。
 *     新しい幽霊が増えたら赤（受け入れ表 _audit-step-phantoms.json に理由つきで足すまで通さない）。
 *     受け入れ済みなのに直って幽霊でなくなった物も赤（表を片付ける）。
 */
const fs = require("fs");
const path = require("path");
const ext = path.join(__dirname, "..", "..", "chrome-extension");
const SA = require(path.join(ext, "search-audit.js"));

let pass = 0, fail = 0;
function ok(name, c, extra) { if (c) pass++; else { fail++; console.log("NG: " + name + (extra === undefined ? "" : " " + JSON.stringify(extra).slice(0, 400))); } }

/** 括弧の外の | で割る */
function splitTop(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "|" && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
/** 保持表の正規表現から、段の名前（page:／dl: の群は展開）を取り出す */
function tokens(re) {
  const inner = re.source.replace(/^\^\(/, "").replace(/\)(\$)?$/, "");
  const res = [];
  for (const t of splitTop(inner)) {
    const g = t.match(/^((?:page|dl):)\((.*)\)(\$?)$/);
    if (g) splitTop(g[2]).forEach((p) => res.push(g[1] + p));
    else res.push(t);
  }
  return res;
}

const toks = new Set([...tokens(SA.KEEP_STEP), ...tokens(SA.RULE_STEP)]);
ok("保持表から名前を200個以上取り出せた（取り出しの文が壊れていない）", toks.size >= 200, toks.size);

const all = fs.readdirSync(ext).filter((f) => f.endsWith(".js") && f !== "search-audit.js")
  .map((f) => fs.readFileSync(path.join(ext, f), "utf8")).join("\n");
const phantom = [];
for (const t of toks) {
  const name = t.replace(/\$$/, "").replace(/^(page|dl):/, "");
  if (!/^[a-z0-9_:.\-]+$/.test(name)) continue; // 正規表現の記号が入る物（接頭辞の組み立て等）は対象にしない
  if (all.indexOf(name) < 0) phantom.push(t);
}
const base = JSON.parse(fs.readFileSync(path.join(__dirname, "_audit-step-phantoms.json"), "utf8"));
const accepted = base.accepted || {};

const added = phantom.filter((p) => !(p in accepted));
ok("新しい幽霊が無い（保持表に名前があるのに、拡張のどこにも出す所が無い）", added.length === 0, added);
const healed = Object.keys(accepted).filter((p) => !phantom.includes(p));
ok("受け入れ表に、もう幽霊でない物が残っていない（直った物は表から消す）", healed.length === 0, healed);

console.log(`  保持表の名前 ${toks.size}・幽霊 ${phantom.length}（受け入れ済み ${Object.keys(accepted).length}・うち【未整理】${Object.values(accepted).filter((v) => /未整理/.test(v)).length}）`);
console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
