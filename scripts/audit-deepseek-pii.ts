// 申込中の会話（個人情報が入る期間）が DeepSeek に届いていないかを数える（読み取りのみ・件数と会話ID 先頭8桁だけを出す・本文は出さない）
//
// 2026-09-26 竹内「申込の間の部分は DeepSeek に渡さず、申込落ちてステータスを切り替えたら、切り替えたところ以降渡せば個人情報防げるからその形にする」
//   = 申込中は DeepSeek に一切渡さない／否決で段階を戻したら「戻した時刻より後」のメッセージだけ渡す。Claude（ブレイン等）はそのまま。
//
// 見る物:
//   ① 本番（env=production）の DeepSeek 呼び出し（llm_usage_logs・model like deepseek%）を、その時点で
//      「申込の記録なし／申込中／戻した後」に分ける（申込の記録 = AIX【申込へ】押下 ∪ 本人確認書類の受信。post-apply.ts と同じ根拠）
//   ② 戻した後の呼び出しで、直近25件（page.tsx が generate-reply に渡す窓）に戻す前（申込中）のメッセージが何件入っていたか
//   ③ 今の status は申込前なのに「申込以降」扱いの会話（status_manual_back_at が前進で消えて、切り替えた時刻が失われた物）
//   ⚠ その時点の status と戻しの印は履歴が無い（status_manual_back_at は最後の1つだけ・前に進めると null に戻る）ので、
//     「申込中」に数えた物には、実は戻した後だった回が混ざりうる（切り替えた時刻を残していないことそのものが課題）
//   ⚠ 会話IDが残らない経路（property_image_read / property_image_detail / property_rank 等）と、llm_usage_logs に記録しない経路
//     （/api/evaluate-property・token-resolve・resolve-area）はここでは数えられない
//
// 実行: npx tsx --env-file=.env.local scripts/audit-deepseek-pii.ts [--days=30]
import { createClient } from "@supabase/supabase-js";
import { DRAFT_SKIP_STATUSES } from "../app/lib/conversation-status";
import { resolvePostApply } from "../app/lib/post-apply";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=30").split("=")[1]) || 30;
/** 申込以降の歯止め（post-apply.ts の記録ベース）を本番に出した時刻 2026-09-23 12:00 JST */
const GUARD_AT = Date.parse("2026-09-23T03:00:00Z");
const WINDOW = 25;
const PII_WORDS = /勤務先|勤続|年収|月収|手取り|緊急連絡先|連帯保証|保証人|生年月日|会社名|在籍|源泉|住民票|本籍|免許証|保険証|マイナンバー|健康保険|続柄|現住所/;
const T = (s: string | null | undefined) => (s ? new Date(s).getTime() : NaN);

async function all<T>(b: (a: number, z: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 100; p++) {
    const { data, error } = await b(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const alt = await all<{ created_at: string; action: string | null; conversation_id: string | null }>((a, z) => sb.from("llm_usage_logs").select("created_at, action, conversation_id").ilike("model", "%deepseek%").eq("env", "production").gte("created_at", since).order("created_at").range(a, z));
  const convs = await all<{ id: string; status: string | null; is_post_apply: boolean | null; status_manual_back_at: string | null }>((a, z) => sb.from("conversations").select("id, status, is_post_apply, status_manual_back_at").range(a, z));
  const pushes = await all<{ conversation_id: string; created_at: string }>((a, z) => sb.from("aix_usage_logs").select("conversation_id, created_at").eq("aix_type", "application_push").range(a, z));
  const idDocs = await all<{ conversation_id: string; created_at: string }>((a, z) => sb.from("messages").select("conversation_id, created_at").eq("image_type", "id_document").eq("sender", "customer").range(a, z));
  const byId = new Map(convs.map((c) => [c.id, c]));
  const ev = new Map<string, number[]>();
  for (const r of [...pushes, ...idDocs]) { const a = ev.get(r.conversation_id) ?? []; a.push(T(r.created_at)); ev.set(r.conversation_id, a); }
  for (const a of ev.values()) a.sort((x, y) => x - y);

  console.log(`=== ① 本番の DeepSeek 呼び出し（直近${days}日・${alt.length}回）を、その時点の段階で分ける ===`);
  type Bucket = { n: number; convs: Set<string>; byAct: Map<string, number> };
  const cat = new Map<string, Bucket>();
  const add = (k: string, cid: string, act: string) => { const e = cat.get(k) ?? { n: 0, convs: new Set<string>(), byAct: new Map<string, number>() }; e.n++; if (cid) e.convs.add(cid); e.byAct.set(act, (e.byAct.get(act) ?? 0) + 1); cat.set(k, e); };
  const movedBack: Array<{ cid: string; t: number }> = [];
  for (const r of alt) {
    const act = r.action ?? "?"; const cid = r.conversation_id ?? "";
    if (!cid) { add("会話IDなし（紐付けできない）", "", act); continue; }
    const t = T(r.created_at); const c = byId.get(cid); const evs = (ev.get(cid) ?? []).filter((x) => x < t);
    const phase = t >= GUARD_AT ? "歯止めの後" : "歯止めの前";
    if (evs.length === 0) {
      add(c && (DRAFT_SKIP_STATUSES.has(c.status ?? "") || c.is_post_apply) ? "申込の記録なし・今は申込以降（その時点の status 不明）" : "申込前", cid, act);
      continue;
    }
    const back = T(c?.status_manual_back_at);
    if (Number.isFinite(back) && back < t && back > evs[evs.length - 1]) { add(`戻した後・${phase}`, cid, act); movedBack.push({ cid, t }); }
    else add(`申込中（申込へ押下・本人確認書類の後）・${phase}`, cid, act);
  }
  for (const [k, e] of cat) console.log(`   ${k}: ${e.n}回・${e.convs.size}会話  [${[...e.byAct].map(([a, n]) => `${a}:${n}`).join(" ")}]${k.startsWith("申込中") || k.startsWith("戻した") ? `  会話: ${[...e.convs].map((x) => x.slice(0, 8)).join(",")}` : ""}`);

  console.log(`\n=== ② 戻した後の呼び出しで、直近${WINDOW}件に入っていた「戻す前の申込中」のメッセージ ===`);
  for (const cid of [...new Set(movedBack.map((x) => x.cid))]) {
    const msgs = await all<{ created_at: string; text: string | null; image_type: string | null }>((a, z) => sb.from("messages").select("created_at, text, image_type").eq("conversation_id", cid).order("created_at").range(a, z));
    const back = T(byId.get(cid)?.status_manual_back_at); const first = ev.get(cid)![0];
    const calls = movedBack.filter((x) => x.cid === cid);
    let inWin = 0, pii = 0, idd = 0, anyBefore = 0;
    for (const call of calls) {
      const last = msgs.filter((m) => T(m.created_at) < call.t).slice(-WINDOW);
      const w = last.filter((m) => T(m.created_at) >= first && T(m.created_at) <= back);
      inWin += w.length; pii += w.filter((m) => PII_WORDS.test(m.text ?? "")).length; idd += w.filter((m) => m.image_type === "id_document").length;
      anyBefore += last.filter((m) => T(m.created_at) <= back).length;
    }
    console.log(`   ${cid.slice(0, 8)} 呼び出し${calls.length}回: 戻す前のメッセージ 延べ${anyBefore}件（うち申込中の期間 ${inWin}件・個人情報の語 ${pii}件・本人確認書類の印 ${idd}件）`);
  }

  console.log(`\n=== ③ 今の status は申込前なのに「申込以降」扱い＝切り替えた時刻が残っていない会話 ===`);
  const lost = new Map<string, string[]>();
  for (const c of convs) {
    const evs = ev.get(c.id); if (!evs || DRAFT_SKIP_STATUSES.has(c.status ?? "") || c.is_post_apply) continue;
    const r = resolvePostApply({ status: c.status, isPostApply: c.is_post_apply, applicationPushAt: new Date(evs[evs.length - 1]).toISOString(), idDocumentAt: null, statusManualBackAt: c.status_manual_back_at });
    const k = r.postApply ? `status=${c.status}・戻しの印なし（前進で消えた／同期で戻った）` : `status=${c.status}・戻した扱い`;
    const a = lost.get(k) ?? []; a.push(c.id.slice(0, 8)); lost.set(k, a);
  }
  for (const [k, v] of lost) console.log(`   ${k}: ${v.length}会話`);
}
main().catch((e) => { console.error(e); process.exit(1); });
