// 返信の文の統括の配線（2026-11-05 作業員9）: COMPOSE_CONDUCTOR が off の時、generate-reply の文が1字も変わらない事を確かめる
// 実行: npx tsx app/lib/__tests__/reply-compose-conductor-wiring.test.ts
//   route.ts の中で composeConductor を使う所が全部「composeConductorOn() が on の時だけ値が入る変数」を通るか（off なら null＝注記も digest も足さない）を読む
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeConductorOn } from "../reply-compose-conductor";

let passed = 0, failed = 0;
const t = (name: string, ok: boolean, extra?: unknown) => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`, extra ?? ""); } };
const src = readFileSync(join(__dirname, "../../api/generate-reply/route.ts"), "utf8");

t("既定 off（空・off・ON 以外）", !composeConductorOn({}) && !composeConductorOn({ COMPOSE_CONDUCTOR: "off" }) && !composeConductorOn({ COMPOSE_CONDUCTOR: "1" }));
const decl = src.match(/const composeConductor = composeConductorOn\(\) && [^?]+\?/);
t("変数は composeConductorOn() の下でだけ作る（off なら null）", !!decl && /:\s*null;/.test(src.slice(src.indexOf("const composeConductor ="), src.indexOf("const composeConductor =") + 1400)));
const uses = [...src.matchAll(/composeConductor\b(?!On)/g)].map((m) => src.slice(Math.max(0, m.index! - 40), m.index! + 40));
t("使う所は宣言1・ログ5・注記2・digest 5 の13か所だけ（増えたら off の時の影響をここで見直す）", uses.length === 13, uses.length);
t("注記は composeConductor?.note がある時だけ", /if \(composeConductor\?\.note\) lines\.push\(composeConductor\.note\.trim\(\)\);/.test(src));
t("digest は composeConductor がある時だけ（無ければ {}）", /\.\.\.\(composeConductor \? \(\(\) => \{[\s\S]{0,600}\}\)\(\) : \{\}\)/.test(src));
t("ログは composeConductor がある時だけ", /if \(composeConductor\) console\.info\("\[compose-conductor\]"/.test(src));
t("本文を書き換えない（draftBody への代入に使わない）", !/draftBody\s*=\s*[^;\n]*composeConductor/.test(src));

t("近い番の割合を書き手の統括に渡す（nearKeepShare: composeNearKeepShare）", /nearKeepShare: composeNearKeepShare/.test(src));
t("近い番の割合を引くのは COMPOSE_CONDUCTOR が on で了承・検討の番だけ", /const composeNearKeepShare: number | null = composeConductorOn() && conversationId && (composeConductorScene === "ack" || composeConductorScene === "considering")/.test(src));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
