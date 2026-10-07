// 室内写真の依頼で「手元に室内イメージ（URL・画像）がある」を何で見分けるか（読み取りのみ・LLM 0）
// 2026-10-07 5巡目（竹内さん「AIX を直接出す」）: 手元に室内イメージの URL・画像がある時（資料・sent_image_properties・物件の記録から分かる）は
//   AIX【物件確認した→室内写真を確認した】を直接出す。無い時は今まで通り「撮影出来次第お送り」の約束→撮影後に AIX。
//   ここでは依頼の番（room-photo-request の検出・365日）ごとに、依頼の**前に**分かる手掛かりと、スタッフの最初の返し（72h）を並べる。
//   判定は app/lib/room-photo-material.photoMaterialAtHand（頼まれた物件の室内イメージをこちらが既に送っているか）。
//   初版で見た会話単位の手掛かり（室内イメージを送った事がある・お客様の持ち込みの URL・sent_properties の URL・sent_image_properties）は
//   どれも直接／撮影を分けなかった（直接 11・撮影 5・他 11）＝注記は room-photo-material.ts
//   返し: 直接（AIX 室内写真・URL/室内イメージ・画像）／撮影（撮影して送る）／他
// 実行: npx tsx --env-file=.env.local scripts/audit-photo-material-at-hand.ts [--days=365] [--show]
import { createClient } from "@supabase/supabase-js";
import { roomPhotoRequestSentence } from "../app/lib/room-photo-request";
import { TEST_CONVERSATION_IDS } from "../app/lib/test-conversations";
import { photoMaterialAtHand, photoTargetsFromThread } from "../app/lib/room-photo-material";
import { loadPropertyThreads } from "../app/lib/property-thread-server";
const PORTAL_URL_RE = /https?:\/\/(?:[\w-]+\.)*(?:homes\.co\.jp|suumo\.jp|athome\.co\.jp|yahoo\.co\.jp|chintai)/i;

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.argv.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 365);
const SHOW = process.argv.includes("--show");
const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const testSet = new Set(TEST_CONVERSATION_IDS);
type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; image_url: string | null };
const one = (s: string | null | undefined, n = 90) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function all<T>(q: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 200; p++) {
    const { data, error } = await q(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const cands = await all<Msg>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, image_url")
    .eq("sender", "customer").gte("created_at", since).or("text.ilike.%写真%,text.ilike.%画像%,text.ilike.%動画%,text.ilike.%URL%,text.ilike.%室内%,text.ilike.%内装%,text.ilike.%イメージ%,text.ilike.%リンク%").order("created_at").range(a, b));
  const hits = cands.filter((m) => !testSet.has(m.conversation_id) && !/^\s*\[画像\]/.test(m.text ?? "") && roomPhotoRequestSentence(m.text ?? ""));
  console.log(`依頼の通 ${hits.length}`);
  const tally = new Map<string, { direct: number; shoot: number; other: number }>();
  const add = (k: string, out: string) => { const t = tally.get(k) ?? { direct: 0, shoot: 0, other: 0 }; (t as Record<string, number>)[out]++; tally.set(k, t); };
  for (const h of hits) {
    const t0 = Date.parse(h.created_at);
    const { data: before } = await sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, image_url").eq("conversation_id", h.conversation_id)
      .lt("created_at", h.created_at).order("created_at", { ascending: false }).limit(150);
    const { data: after } = await sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, image_url").eq("conversation_id", h.conversation_id)
      .gt("created_at", h.created_at).lt("created_at", new Date(t0 + 72 * 3600_000).toISOString()).order("created_at").limit(40);
    const { data: aix } = await sb.from("aix_usage_logs").select("aix_type, check_pattern, created_at").eq("conversation_id", h.conversation_id)
      .gt("created_at", h.created_at).lt("created_at", new Date(t0 + 72 * 3600_000).toISOString()).limit(20);
    const { data: aixBefore } = await sb.from("aix_usage_logs").select("property_names, check_pattern").eq("conversation_id", h.conversation_id).eq("check_pattern", "interior_photo").lt("created_at", h.created_at).not("sent_at", "is", null).limit(50);
    const pt = await loadPropertyThreads(h.conversation_id, { asOf: h.created_at });
    const tgt = (pt?.turnTargets ?? []).filter((x) => Date.parse(x.at) >= t0 - 60_000).map((x) => x.display);
    const prev = ((before ?? []) as Msg[]).reverse();
    const m = photoMaterialAtHand({
      before: prev.map((x) => ({ sender: x.sender, text: x.text ?? "", createdAt: x.created_at, isImage: !!x.image_url })),
      requestText: h.text ?? "", targetNames: tgt, targetRooms: photoTargetsFromThread(pt, h.created_at),
      interiorAixNames: (aixBefore ?? []).flatMap((x) => (x.property_names as string[] | null) ?? []),
    });
    const staff = ((after ?? []) as Msg[]).filter((x) => x.sender !== "customer");
    const firstAt = staff[0]?.created_at ?? null;
    const firstWin = staff.filter((x) => firstAt && Date.parse(x.created_at) - Date.parse(firstAt) < 30 * 60_000);
    const txt = firstWin.map((x) => x.text ?? "").join("\n");
    const aixInterior = (aix ?? []).some((x) => x.check_pattern === "interior_photo" && (!firstAt || Date.parse(x.created_at as string) - Date.parse(firstAt) < 30 * 60_000));
    const out = aixInterior || /室内イメージ/.test(txt) || PORTAL_URL_RE.test(txt) || firstWin.some((x) => x.image_url || /^\s*\[(?:画像|動画)\]/.test(x.text ?? "")) ? "direct"
      : /撮影/.test(txt) ? "shoot" : "other";
        add(m.atHand ? "★ 手元にある（判定）" : "☆ 手元にない（判定）", out);
    if (SHOW) console.log(`${out.padEnd(6)} ${m.atHand ? "★" : "☆"} [${m.why}] ${h.conversation_id.slice(0, 8)} ${h.created_at.slice(0, 16)} 客「${one(h.text, 60)}」→ 店「${one(txt, 80)}」`);
  }
  console.log("\n手掛かり → スタッフの最初の返し（直接＝AIX室内写真・URL・画像／撮影の約束／他）");
  for (const [k, v] of [...tally.entries()].sort()) console.log(`  ${k.padEnd(22)} 直接 ${v.direct}・撮影 ${v.shoot}・他 ${v.other}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
