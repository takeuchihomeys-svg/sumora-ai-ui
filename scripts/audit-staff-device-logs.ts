// scripts/audit-staff-device-logs.ts — 過去のスタッフの送信を「送った端末」で見分ける（読むだけ・LLM なし・2026-10-08）
//   竹内「端末で分析して竹内か従業員か判断できてるのかな？」「よむ」（10/08: Supabase のアクセスの記録を端末を見分ける目的で読んでよい）
//   画面（ブラウザ）は送信の後に messages を supabase-js-web で直接 insert する → Supabase の edge_logs に User-Agent・回線の付いた
//   POST /rest/v1/messages が残る（約90日）。それを messages.created_at（ブラウザの時計）と 10 秒の枠で照合し、送信ごとに端末を決める。
//
//   入力: --edge=<dir> に 1日1ファイル（YYYY-MM-DD.b10・UTC の日）。中身は 1行:
//     <UAの印6桁>|<回線 K/D/S/B/…>|<接続元の印4桁>|<その日の 10 秒の枠（0〜8639）,...>;...
//     query_logs（mcp の supabase-line）で取る SQL は下の EDGE_SQL。IP はそのまま持たない（cityHash64 の頭4桁＝照合だけ）。
//   --map=<json> で端末の印 → 書き手（{"595E23":"takeuchi","AE72C3":"employee",...}）。無ければ端末ごとの集計だけ
//   --labels=<jsonl>（scripts/audit-staff-writer.ts --out の 1通1行）で文の癖の判定と突き合わせ、一致率を出す
//   --out=<jsonl> で端末で決まった通（id・端末・書き手）を書き出す → scripts/backfill-staff-writer.ts --device=<jsonl>
//
// 実行: npx tsx --env-file=.env.local scripts/audit-staff-device-logs.ts --edge=<dir> --labels=<jsonl> [--map=<json>] [--out=<jsonl>]
import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTestConversation } from "../app/lib/test-conversations";

export const EDGE_SQL = `select arrayStringConcat(groupArray(g), ';') d from (select concat(substring(hex(cityHash64(log_attributes['request.headers.user_agent'])),1,6),'|',multiIf(org like 'KDDI%','K',org like 'NTT DoCoMo%','D',org like 'STARCAT%','S',org like 'SoftBank%','B',substring(org,1,8)),'|',substring(hex(cityHash64(log_attributes['request.headers.cf_connecting_ip'])),1,4),'|',arrayStringConcat(arraySort(groupUniqArray(toString(intDiv(toUnixTimestamp64Milli(timestamp) % 86400000,10000)))),',')) g, log_attributes['request.cf.asOrganization'] org from logs where source='edge_logs' and log_attributes['request.method']='POST' and log_attributes['request.path']='/rest/v1/messages' and log_attributes['request.headers.x_client_info'] like 'supabase-js-web%' group by log_attributes['request.headers.user_agent'], org, log_attributes['request.headers.cf_connecting_ip'])`;

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const EDGE = arg("edge", "");
const LABELS = arg("labels", "");
const MAP = arg("map", "");
const OUT = arg("out", "");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

type Hit = { ua: string; net: string; ip: string };
/** 回線の場所の印: S＝STARCAT（ケーブル）・O＝KDDI の固定（毎日同じ接続元）・M＝携帯の回線・K＝その他の KDDI。IP そのものは出さない */
const FIXED_KDDI = (process.env.STAFF_DEVICE_FIXED_NET ?? "82B3").split(",");
const placeOf = (h: Hit) => (h.net === "S" ? "S" : h.net === "K" && FIXED_KDDI.includes(h.ip) ? "O" : h.net === "K" ? "K" : "M");
/** 端末の印＝UA の印＋場所（Windows の Chrome は版が同じなら UA が同じ＝別の PC でも同じ印になるので場所で分ける） */
const deviceKey = (h: Hit) => `${h.ua}@${placeOf(h)}`;
/** UA の印 → 端末名（10/08 に edge_logs から読んだ UA を app/lib/staff-device.deviceLabelOf の形で） */
const UA_LABELS: Record<string, string> = {
  "595E23": "iPhone iOS18.5 Safari18.5", AE72C3: "iPhone iOS18.7 Safari26.5.2", F0B065: "iPhone iOS18.7 Safari26.6", "59C39D": "iPhone iOS18.7 Safari26.6.1",
  "5F8837": "Windows Chrome149", "88292E": "Windows Chrome150", D106DE: "Windows Chrome151", "90A712": "Windows Chrome152", "62B1BA": "Windows Chrome153",
  "69808E": "Windows Chrome154", C94332: "Windows HeadlessChrome153（自動のテスト）",
};
const PLACE_LABELS: Record<string, string> = { S: "ケーブル回線（STARCAT）", O: "KDDI の固定回線（毎日同じ接続元）", M: "携帯の回線", K: "その他の KDDI" };
const devLabel = (d: string) => { const [u, p] = d.split("@"); return `${UA_LABELS[u] ?? u}・${PLACE_LABELS[p] ?? p}`; };
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");

async function main() {
  // 端末の枠: day → bucket → hits
  const days = readdirSync(EDGE).filter((f) => /^\d{4}-\d{2}-\d{2}\.b10$/.test(f)).sort();
  const idx = new Map<string, Hit[]>();
  for (const f of days) {
    const day = f.slice(0, 10);
    const s = readFileSync(join(EDGE, f), "utf8").trim(); if (!s) continue;
    for (const g of s.split(";")) {
      const [ua, net, ip, ts] = g.split("|"); if (!ts) continue;
      for (const b of ts.split(",")) { const k = `${day}|${b}`; (idx.get(k) ?? idx.set(k, []).get(k)!).push({ ua, net, ip }); }
    }
  }
  const first = days[0]?.slice(0, 10), last = days[days.length - 1]?.slice(0, 10);
  const map0: Record<string, string> = MAP ? JSON.parse(readFileSync(MAP, "utf8")) : {};
  // 対応は「UA の印@場所」か「UA の印」（場所を問わない）で書ける
  // 値の末尾の「?」＝たぶん（PC など同じ UA を別の人が使い得る端末）。無ければ確か
  const rawOf = (k: string) => map0[k] ?? map0[String(k).split("@")[0]];
  const map = new Proxy(map0, { get: (_t, k: string) => rawOf(k)?.replace(/\?$/, "") }) as Record<string, string>;
  const confOf = (k: string) => (rawOf(k)?.endsWith("?") ? "likely" : "sure");
  const labels = new Map<string, { src: string; writer: string | null; source: string | null; confidence: string }>();
  if (LABELS) for (const l of readFileSync(LABELS, "utf8").split("\n").filter(Boolean)) { const o = JSON.parse(l); labels.set(o.id, o); }

  const msgs: Array<{ id: string; conversation_id: string; created_at: string; text: string | null; is_aix_generated: boolean | null; speaker_user_id: string | null }> = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, created_at, text, is_aix_generated, speaker_user_id").eq("sender", "staff")
      .gte("created_at", `${first}T00:00:00Z`).lt("created_at", `${last}T23:59:59.999Z`).order("created_at").order("id").range(i, i + 999);
    if (error) throw new Error(error.message);
    msgs.push(...(data ?? []) as typeof msgs); if ((data ?? []).length < 1000) break;
  }
  const dayset = new Set(days.map((d) => d.slice(0, 10)));
  type Row = { id: string; conv: string; at: string; hourJst: number; dowJst: number; device: string | null; net: string | null; ambiguous: boolean; style: string | null; styleConf: string | null; src: string | null; aix: boolean };
  const rows: Row[] = [];
  for (const m of msgs) {
    if (isTestConversation(m.conversation_id) || m.speaker_user_id) continue;
    const t = Date.parse(m.created_at); const day = new Date(t).toISOString().slice(0, 10);
    if (!dayset.has(day)) continue;
    const b = Math.floor((t % 86400000) / 10000);
    // ブラウザの時計 → 記録の時刻は 0〜数秒後。同じ枠 → 次の枠 → 前の枠 の順に見る
    let hits: Hit[] = [];
    for (const d of [0, 1, -1, 2]) { const h = idx.get(`${day}|${b + d}`); if (h?.length) { hits = h; break; } }
    const uas = [...new Set(hits.map(deviceKey))];
    const lab = labels.get(m.id);
    const j = new Date(t + 9 * 3600_000);
    rows.push({ id: m.id, conv: m.conversation_id, at: m.created_at, hourJst: j.getUTCHours(), dowJst: j.getUTCDay(), device: uas.length === 1 ? uas[0] : null, net: uas.length === 1 ? [...new Set(hits.map((h) => h.net))].join("+") : null, ambiguous: uas.length > 1, style: lab?.writer ?? null, styleConf: lab?.confidence ?? null, src: lab?.src ?? null, aix: !!m.is_aix_generated });
  }
  console.log(`期間 ${first}〜${last}（edge のファイル ${days.length}日）・スタッフの通（グループ・テストを除く） ${rows.length}`);
  console.log(`  端末が1つに決まった ${rows.filter((r) => r.device).length}（${pct(rows.filter((r) => r.device).length, rows.length)}）・同じ枠に2台 ${rows.filter((r) => r.ambiguous).length}・記録なし（サーバの insert・予約送信・LINE の管理画面の直送 等） ${rows.filter((r) => !r.device && !r.ambiguous).length}`);

  // 端末ごと
  const devs = [...new Set(rows.map((r) => r.device).filter(Boolean) as string[])];
  console.log(`\n■ 端末ごと（送信数・時間帯・曜日・文の癖の判定）`);
  for (const d of devs.sort((a, b) => rows.filter((r) => r.device === b).length - rows.filter((r) => r.device === a).length)) {
    const l = rows.filter((r) => r.device === d);
    const nets = new Map<string, number>(); for (const r of l) nets.set(r.net!, (nets.get(r.net!) ?? 0) + 1);
    const night = l.filter((r) => r.hourJst < 10 || r.hourJst >= 21).length;
    const wkend = l.filter((r) => r.dowJst === 0 || r.dowJst === 6).length;
    const dd = [...new Set(l.map((r) => r.at.slice(0, 10)))].sort();
    const st = l.filter((r) => r.style && (r.src === "hand" || r.src === "edited"));
    const stSure = st.filter((r) => r.styleConf === "sure");
    console.log(`  ${d} ${devLabel(d)}${map[d] ? `（${map[d]}）` : ""}:${l.length}通・${dd.length}日（${dd[0]}〜${dd[dd.length - 1]}）・回線 ${[...nets].map(([k, v]) => `${k} ${v}`).join("・")}`);
    console.log(`     夜21〜朝10時 ${pct(night, l.length)}・土日 ${pct(wkend, l.length)}・時刻 ${[...Array(24).keys()].map((h) => l.filter((r) => r.hourJst === h).length).join(" ")}`);
    console.log(`     文の癖（手打ち・直しで決まった ${st.length}）竹内 ${pct(st.filter((r) => r.style === "takeuchi").length, st.length)}／確かだけ ${stSure.length} で竹内 ${pct(stSure.filter((r) => r.style === "takeuchi").length, stSure.length)}`);
  }

  // 一致率（端末の書き手が付いていれば）
  if (Object.keys(map0).length) {
    console.log(`\n■ 端末の書き手 × 文の癖の判定（手打ち・直し）`);
    for (const src of ["style", "style_context"]) for (const cf of ["sure", "likely"]) {
      const l = rows.filter((r) => r.device && map[r.device] && r.style && (r.src === "hand" || r.src === "edited") && r.styleConf === cf && (labels.get(r.id)?.source === src));
      const ok = l.filter((r) => r.style === map[r.device!]).length;
      const byW = (w: string) => { const x = l.filter((r) => map[r.device!] === w); return `${w} ${pct(x.filter((r) => r.style === w).length, x.length)}(${x.length})`; };
      console.log(`  ${src}/${cf}: 一致 ${ok}/${l.length}＝${pct(ok, l.length)}（${byW("takeuchi")}・${byW("employee")}）`);
    }
    // 向きごとの当たり（文の癖が「竹内」と言った通のうち端末も竹内の割合＝精度）。端末の無い過去の通の確からしさを決める物差し
    for (const src of ["style", "style_context"]) for (const w of ["takeuchi", "employee"]) for (const cf of ["sure", "likely"]) {
      const l = rows.filter((r) => r.device && map[r.device] && (r.src === "hand" || r.src === "edited") && r.style === w && r.styleConf === cf && labels.get(r.id)?.source === src);
      if (l.length) console.log(`  精度 ${src}/${w}/${cf}: 端末も同じ ${l.filter((r) => map[r.device!] === w).length}/${l.length}＝${pct(l.filter((r) => map[r.device!] === w).length, l.length)}（手打ち ${pct(l.filter((r) => r.src === "hand" && map[r.device!] === w).length, l.filter((r) => r.src === "hand").length)}・直し ${pct(l.filter((r) => r.src === "edited" && map[r.device!] === w).length, l.filter((r) => r.src === "edited").length)}）`);
    }
    const un = rows.filter((r) => r.device && map[r.device] && (r.src === "hand" || r.src === "edited") && !r.style);
    console.log(`  文の癖で不明だった手打ち・直し ${un.length} → 端末で 竹内 ${un.filter((r) => map[r.device!] === "takeuchi").length}・従業員 ${un.filter((r) => map[r.device!] === "employee").length}`);
    // 出所ごとの端末の書き手
    console.log(`\n■ 出所ごとの端末の書き手`);
    for (const src of ["hand", "edited", "asis", "aix", "template", "canned", "material", "auto", null]) {
      const l = rows.filter((r) => r.device && map[r.device] && r.src === src); if (!l.length) continue;
      console.log(`  ${String(src ?? "画像等").padEnd(8)} ${l.length}通 竹内 ${pct(l.filter((r) => map[r.device!] === "takeuchi").length, l.length)}`);
    }
    if (OUT) {
      const out = rows.filter((r) => r.device).map((r) => ({ id: r.id, device: r.device, writer: map[r.device!] ?? null, confidence: map[r.device!] ? confOf(r.device!) : null }));
      writeFileSync(OUT, out.map((o) => JSON.stringify(o)).join("\n"));
      console.log(`書き出し ${OUT}（${out.length}行）`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
