// scripts/audit-aix-emoji-repeat-human.ts — AIX の1通目で「同じ絵文字の2回目」をスタッフが残したか・直したか（読むだけ）
//
// 2026-10-01 引き継ぎ（ブレインの AIX 選びの担当から）: 「AIX 内覧調整で 😊 が2回（…ご案内可能です😊！！／…御座いますでしょうか😊！！）。
//   aix/action には dedupeRepeatedEmoji が無い。実送信の約半分は重複を残しているので、送った文だけでは出口の線が引けない。
//   スタッフが書いた／直した通だけで数え直してから入口か出口かを決める」
//   竹内さんの決まり（10/01）: 同じ絵文字を1通で2回使わない（もう一つの絵文字を使うか省く）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-emoji-repeat-human.ts [--days=365] [--types=viewing_invite,property_check_result,...]
import { createClient } from "@supabase/supabase-js";
import { loadAixPairs } from "./aix-pairs";
import { dedupeRepeatedEmoji } from "../app/lib/emoji-repeat";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const args = process.argv.slice(2);
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "365")) || 365;
const TYPES = arg("types", "viewing_invite,property_check_result,meeting_place,application_push,property_send,property_recommendation,estimate_sheet").split(",");
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const rep = (t: string) => dedupeRepeatedEmoji(t).changes.length > 0;
const one = (s: string) => s.replace(/[^\s、。！!\n「」]{1,10}さん/g, "〈名〉さん").replace(/\n+/g, " ⏎ ");

async function main() {
  for (const type of TYPES) {
    const { pairs } = await loadAixPairs(sb, type, since);
    const H = pairs.filter((p) => p.firstOrigin === "human");
    const E = pairs.filter((p) => p.firstOrigin === "edited");
    const A = pairs.filter((p) => p.firstOrigin === "as_is");
    const eRepDraft = E.filter((p) => rep(p.firstDraft));
    const eFixed = eRepDraft.filter((p) => !rep(p.first));
    const eAdded = E.filter((p) => !rep(p.firstDraft) && rep(p.first));
    console.log(`\n== ${type}: 1通目 human ${H.length}（重複 ${H.filter((p) => rep(p.first)).length}）／ edited ${E.length}: 下書きに重複 ${eRepDraft.length} → スタッフが直した ${eFixed.length}・残した ${eRepDraft.length - eFixed.length}・自分で重複を作った ${eAdded.length} ／ as_is ${A.length}（重複 ${A.filter((p) => rep(p.first)).length}）`);
    // 2通目（スタッフが書いた）
    const H2 = pairs.filter((p) => p.second && p.secondOrigin === "human");
    if (H2.length) console.log(`   2通目 human ${H2.length}（重複 ${H2.filter((p) => rep(p.second!)).length}）`);
    for (const p of eRepDraft.slice(0, 4)) {
      const d = dedupeRepeatedEmoji(p.firstDraft);
      console.log(`   下書き: ${one(p.firstDraft).slice(0, 150)}\n   送った: ${one(p.first).slice(0, 150)}\n   出口なら: ${one(d.text).slice(0, 150)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
