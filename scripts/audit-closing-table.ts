// scripts/audit-closing-table.ts — 返信の締めの決め表（COMPOSE_CLOSING_TABLE）が竹内さんの締めと合うかを数える（AI を呼ばない・DB を読まない・費用0）
//   材料: 手元の竹内さんの 198番（exam-cache/anatomy-roles/roles-r1.json の文と役目＋anatomy-seven/seven-all198.json の誘導先・押す強さ）
//   ⚠ 表を作った数えと同じ番（中で測った値）。本当の効きは見ていない番で確かめる
// 実行: npx tsx scripts/audit-closing-table.ts [--show]
import fs from "node:fs";
import path from "node:path";
import { decideClosing, type Invite, type SignOff } from "../app/lib/compose-value-slots";
import { toNextDest, strengthFromSeven } from "../app/lib/next-move-types";

const EC = path.resolve(__dirname, "../../../exam-cache");
const roles = JSON.parse(fs.readFileSync(path.join(EC, "anatomy-roles/roles-r1.json"), "utf8")) as Array<{ id: string; scene: string; route?: string; sentences: string[]; roles: Array<{ role: string }>; customer?: string }>;
const seven = new Map((JSON.parse(fs.readFileSync(path.join(EC, "anatomy-seven/seven-all198.json"), "utf8")) as Array<{ id: string; reads: Array<{ lead?: string; push?: { push: boolean; strength: "strong" | "mid" | "weak" | null } }> }>).map((x) => [x.id, x.reads?.[0] ?? null]));
const show = process.argv.includes("--show");

function goldOf(s: string[]): { invite: Invite; sign: SignOff } {
  const tail = s.slice(-3).join("\n"), last = s[s.length - 1] ?? "";
  const invite: Invite = /お申込(?:み)?[^\n]{0,30}(?:抑|押)|お部屋(?:抑|押)え/.test(tail) ? "apply" : /ご内覧|ご案内させて|お日にち|ご都合/.test(tail) ? "viewing" : "none";
  const sign: SignOff = /何卒/.test(last) ? "nanitozo" : /ご査収/.test(last) ? "receipt" : /お気軽に|いつでも/.test(last) ? "kigaru" : "none";
  return { invite, sign };
}
let n = 0, inv = 0, sig = 0, both = 0;
const conf: Record<string, number> = {};
for (const r of roles) {
  if (r.route && r.route !== "reply") continue;
  const s7 = seven.get(r.id);
  const rl = r.roles.map((x) => x.role).filter((x) => x !== "close");
  const g = goldOf(r.sentences);
  const d = decideClosing({
    scene: r.scene, dest: toNextDest(s7?.lead ?? null, "lead_to"), strength: strengthFromSeven(s7?.push ?? null), hook: null,
    propertyState: /退去予定/.test(r.sentences.join("")) ? "vacating" : "none", sentThisTurn: false, considering: /検討/.test(r.customer ?? ""),
    urgent: /急ぎ|すぐにでも|早め/.test(r.customer ?? ""), sentenceCount: rl.length, firstContact: /ご連絡(?:頂|いただ)き/.test(r.sentences.join("")), customerAsked: /[?？]|ですか|ますか/.test(r.customer ?? ""), lastRole: rl[rl.length - 1] ?? null,
  });
  n++; const a = d.invite === g.invite, b = d.sign === g.sign;
  if (a) inv++; if (b) sig++; if (a && b) both++;
  const k = `誘い ${g.invite}→${d.invite}`; conf[k] = (conf[k] ?? 0) + 1;
  const k2 = `結び ${g.sign}→${d.sign}`; conf[k2] = (conf[k2] ?? 0) + 1;
  if (show && !(a && b)) console.log(`- ${r.id.slice(0, 8)} ${r.scene} 竹内=${g.invite}+${g.sign} 表=${d.invite}+${d.sign}｜${r.sentences.slice(-1)[0]?.slice(0, 50)}`);
}
console.log(`返信の番 ${n}: 誘い ${inv}/${n}（${Math.round((inv / n) * 100)}%）・結び ${sig}/${n}（${Math.round((sig / n) * 100)}%）・両方 ${both}/${n}（${Math.round((both / n) * 100)}%）`);
for (const [k, v] of Object.entries(conf).sort()) console.log(`  ${k}: ${v}`);
