// scripts/replay-scenarios-mine.ts
// 2026-10-01 竹内「実際の LINE のようにできていない部分を見つける」— YUMA で流す場面の候補を本番の実際の会話から掘る（読むだけ・書き込みなし・LLM なし）。
//   お客様の番（連投）ごとに「スタッフが実際にした事」（返事のまとまりの文／押した AIX）を line-watch-judge の staffWindowOf で取り、
//   お客様の文の語で場面の候補（初回・条件・物件の問い合わせ・費用・内覧・手続き…）に分け、場面ごとに数件ずつ書き出す。
//   書き出した候補を目で読んで scripts/replay-scenarios.json に採る（名前・電話・メールは伏せる＝maskText）。
//
// 実行: npx tsx --env-file=.env.local scripts/replay-scenarios-mine.ts [--days=90] [--per=6] [--out=<file.json>]
// 場面の作り直し: npx tsx --env-file=.env.local scripts/replay-scenarios-mine.ts --days=120 --per=1 --pick=scripts/replay-scenarios.keys.json
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "90"));
const PER = Number(arg("per", "6"));
const OUT = arg("out", "");
/** 場面に入れる前の発言の数（ブレインは最新30通を読む＝30通そろえると YUMA の古い発言が混ざらない） */
const CTX = Number(arg("ctx", "29"));
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

async function readAll<T>(q: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, cap = 300_000): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < cap; i += 1000) {
    const r = await q(i, i + 999);
    if (r.error) throw new Error(r.error.message);
    const d = (r.data ?? []) as T[];
    out.push(...d);
    if (d.length < 1000) break;
  }
  return out;
}

type Msg = WindowMsg & { conversation_id: string; image_url: string | null };
type Press = WindowPress & { conversation_id: string };
type Conv = { id: string; customer_name: string | null; line_source_type: string | null; status: string | null; created_at: string | null };

/** 場面の候補（お客様の文の語）。上から順に最初に当たった物 */
export const CANDIDATE_SCENES: Array<[string, RegExp]> = [
  ["rent_included", /家賃込|前家賃.*(?:含|入)/],
  ["procedure", /審査.*(?:期間|日数|どのくらい|何日|かかり)|必要書類|入居まで.*(?:流れ|期間)|書類.*(?:何|必要)/],
  ["documents", /マイナンバー|免許証|保険証|パスポート|住民票|源泉/],
  ["apply", /申し?込(?:み|ん|む)|申込/],
  ["meeting_date", /(?:\d{1,2}\s*[\/月]\s*\d{1,2}|\d{1,2}日).*(?:\d{1,2}\s*時|\d{1,2}:\d{2})|(?:\d{1,2}\s*時|\d{1,2}:\d{2}).*(?:でお願い|大丈夫|可能|行けます)/],
  ["viewing", /内覧|内見|見学|見に行/],
  ["url_inquiry", /suumo|homes\.co|athome|https?:\/\//i],
  ["vacancy", /空いて|空き|募集(?:中|して)|まだあり/],
  ["cost", /初期費用|いくら|見積|費用|安く|値引|割引/],
  ["phone", /電話/],
  ["pet_parking", /ペット|犬|猫|駐車|駐輪|バイク/],
  ["equipment", /エアコン|クーラー|ネット|wi-?fi|コンロ|洗濯|独立洗面|オートロック|宅配|収納|日当たり|スーパー/i],
  ["more_props", /他に|ほかに|他の|もっと|別の|ありますか|ないですか|ないでしょうか/],
  ["decline_wait", /検討|また連絡|見送|やめ|保留|一旦|考え/],
  ["conditions", /エリア|万円?|間取り|1K|1LDK|2LDK|駅|徒歩|築|㎡|帖|畳|区/i],
  ["thanks", /ありがと|了解|わかりました|分かりました|承知|よろしく|お願いします/],
];

export function sceneOfCustomerText(t: string, isFirst: boolean, hasImage: boolean): string {
  if (isFirst) return "first_contact";
  if (!t.trim() && hasImage) return "image";
  for (const [k, re] of CANDIDATE_SCENES) if (re.test(t)) return k;
  return hasImage ? "image" : "other";
}

/** 申込の書類（記入済み）の印。これより後の番は場面にしない */
const APP_PII_RE = /申込者様記入欄|同居人記入欄|緊急連絡先欄|生年月日|年収|勤務先電話/;
// 2026-10-02 ⑫: URL の中の数字（suumo の bc_1000…・homes の bid=…）まで電話番号として伏せていた → URL はそのまま残し、URL の外だけ伏せる（maskText）
const URL_OR_PHONE_RE = /https?:\/\/[^\s　]+|0\d{1,4}[-ー－]?\d{1,4}[-ー－]?\d{3,4}/g;
const MAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/g;
/** スタッフが呼びかけに使った名前（「〇〇さん⏎」「〇〇さんに/の/が/お/ご/達」）。会話ごとに集める */
const NOT_NAME = /^(?:お客|皆|旦那|奥|管理会社|担当|YUMA|同居人|オーナー|業者|大家|貸主|保証会社|ご主人|主人|彼女|彼氏|お子|弟|妹|兄|姉|母|父|ご両親|親御|内覧担当|鈴木|管理人|みな$)/;
export function addressNamesOf(staffTexts: ReadonlyArray<string>): string[] {
  const out = new Set<string>();
  for (const t of staffTexts) {
    for (const m of String(t ?? "").matchAll(/(?:^|\n|、|。|！|\s|\/)([^\s\n、。！!?？「」()（）・/]{1,10}?)(?:さん|様)(?=\n|に|の|が|お|ご|達|、|！|😊|😌|$|\s)/g)) {
      const nm = m[1];
      if (!NOT_NAME.test(nm) && !/[0-9０-９]/.test(nm)) out.add(nm);
    }
  }
  return [...out];
}
/** 名前・電話・メールを伏せる。customerName の全体（2文字以上）・スペースで分けた部分・スタッフの呼びかけの名前を「YUMA」に */
export function maskText(t: string, customerName: string | null, extraNames: ReadonlyArray<string> = []): string {
  let s = String(t ?? "");
  const names = new Set<string>();
  const n = (customerName ?? "").trim();
  if (n.length >= 2) { names.add(n); for (const p of n.split(/[\s　]+/)) if (p.length >= 2) names.add(p); }
  for (const x of extraNames) if (x) names.add(x);
  for (const nm of [...names].sort((a, b) => b.length - a.length)) {
    s = s.split(`${nm}さん`).join("YUMAさん").split(`${nm}様`).join("YUMA様");
    if (nm.length >= 2) s = s.split(nm).join("YUMA");
  }
  // 紹介者の名前（「〇〇様から紹介いただきました」）
  s = s.replace(/[^\s、。！!]{2,8}(様|さん)から(ご)?紹介/g, "ご紹介者様から$2紹介");
  // スタッフの文の頭の呼びかけ「〇〇さん」
  s = s.replace(/^([^\n]{1,14}?)(さん|様)(\n)/, "YUMA$2$3");
  // 2026-10-02 ⑫: 伏せ字を携帯の番号の形（090-0000-0000）にすると手順書の個人情報の網（test-pii-guard の携帯の番号）に当たり場面が流れない（45場面中 9・流れ 13/17）→ 番号の形にしない
  return s.replace(URL_OR_PHONE_RE, (m) => (/^https?:/.test(m) ? m : "（電話番号）")).replace(MAIL_RE, "yuma@example.com");
}

async function main() {
  const nowMs = Date.now();
  const since = new Date(nowMs - DAYS * 86_400_000).toISOString();
  const convs = await readAll<Conv>((f, t) => sb.from("conversations").select("id, customer_name, line_source_type, status, created_at").range(f, t));
  const convBy = new Map(convs.map((c) => [c.id, c]));
  const msgs = await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated, image_url").gte("created_at", since).order("created_at").order("id").range(f, t));
  const presses = await readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").gte("created_at", since).not("aix_type", "is", null).order("created_at").range(f, t));
  console.log(`messages ${msgs.length}・AIX ${presses.length}`);
  const group = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = group(msgs), pBy = group(presses);

  type Cand = { scene: string; conv: string; at: string; customer: string[]; staff_texts: string[]; staff_aix: Array<{ aix: string; cp: string | null }>; staff_aix_texts: string[]; context: Array<{ s: string; t: string; aix?: boolean; img?: boolean }>; status: string | null };
  const out: Cand[] = [];
  for (const [cid, ms] of mBy) {
    const conv = convBy.get(cid);
    if (!conv || isTestConversation(cid)) continue;
    if (conv.line_source_type && conv.line_source_type !== "user") continue;
    if (/グループ/.test(conv.customer_name ?? "")) continue;
    const ps = pBy.get(cid) ?? [];
    const nm = addressNamesOf(ms.filter((x) => x.sender !== "customer").map((x) => x.text ?? ""));
    const mask = (t: string) => maskText(t, conv.customer_name, nm);
    const applyAt = ps.find((p) => p.aix_type === "application_push")?.created_at ?? null;
    let firstCustomerSeen = false;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (m.sender !== "customer") continue;
      if (i > 0 && ms[i - 1].sender === "customer") continue; // 連投の頭だけ
      // 2026-10-02 ⑫: 期間の最初のお客様の発言でも、会話が期間より前からあれば初回ではない（旧は初回として場面にし、スタッフの「お世話になっております」と比べて外れにしていた）
      const convStartedInWindow = !conv.created_at || Date.parse(conv.created_at) >= Date.parse(since) - 86_400_000;
      const isFirst = convStartedInWindow && !firstCustomerSeen && !ms.slice(0, i).some((x) => x.sender === "customer");
      firstCustomerSeen = true;
      if (applyAt && Date.parse(m.created_at) >= Date.parse(applyAt)) break; // 申込以降は対象外
      // 申込の書類（記入済みのフォーム）が出た後も対象外（申込へを押さずにフォームが届く会話がある・2026-10-01 個人情報が場面に混ざった）
      if (ms.slice(0, i).some((x) => APP_PII_RE.test(x.text ?? ""))) break;
      const w = staffWindowOf({ customerTurnAt: m.created_at, msgs: ms, presses: ps, nowMs });
      if (!w.closed || !w.staffFirstAt) continue;
      const burstTexts = w.texts.filter((t) => t.burst).map((t) => t.text);
      const burstAix = w.presses.filter((p) => p.burst).map((p) => ({ aix: p.aix_type, cp: p.check_pattern }));
      if (!burstTexts.length && !burstAix.length) continue;
      const turn: Msg[] = [];
      for (let j = i; j < ms.length && ms[j].sender === "customer"; j++) turn.push(ms[j]);
      const text = turn.map((x) => x.text ?? "").join("\n");
      const hasImage = turn.some((x) => !!x.image_url && !(x.text ?? "").trim());
      const scene = sceneOfCustomerText(text, isFirst, hasImage);
      const ctx = ms.slice(Math.max(0, i - CTX), i).map((x) => ({ s: x.sender === "customer" ? "customer" : "staff", t: mask(x.text ?? (x.image_url ? "[画像]" : "")), ...(x.is_aix_generated ? { aix: true } : {}), ...(x.image_url && !(x.text ?? "").trim() ? { img: true } : {}) }));
      // 返事のまとまりの中の AIX の文（is_aix_generated・画像は除く）。AIX の文の比べに使う
      const lastMs = Date.parse(w.customerLastAt);
      const burstEnd = Math.max(...[...w.texts.filter((t) => t.burst).map((t) => Date.parse(t.at)), ...w.presses.filter((p) => p.burst).map((p) => Date.parse(p.at)), lastMs]);
      const aixTexts = ms.filter((x) => x.sender !== "customer" && x.is_aix_generated && (x.text ?? "").trim() && Date.parse(x.created_at) > lastMs && Date.parse(x.created_at) <= burstEnd + 5 * 60_000).map((x) => mask(x.text ?? ""));
      out.push({
        scene, conv: cid, at: m.created_at, status: conv.status,
        customer: turn.map((x) => mask(x.text ?? (x.image_url ? "[画像]" : ""))),
        staff_texts: burstTexts.map(mask), staff_aix: burstAix, staff_aix_texts: aixTexts, context: ctx,
      });
    }
  }
  const byScene = new Map<string, Cand[]>();
  for (const c of out) { if (!byScene.has(c.scene)) byScene.set(c.scene, []); byScene.get(c.scene)!.push(c); }
  console.log(`\n番 ${out.length}`);
  const picked: Cand[] = [];
  for (const [k, list] of [...byScene].sort((a, b) => b[1].length - a[1].length)) {
    const aixShare = list.filter((c) => c.staff_aix.length).length;
    const kinds = new Map<string, number>();
    for (const c of list) { const key = c.staff_aix.length ? c.staff_aix.map((a) => a.aix).join("+") : "返信"; kinds.set(key, (kinds.get(key) ?? 0) + 1); }
    console.log(`${k.padEnd(14)} ${String(list.length).padStart(5)}  AIX ${Math.round((aixShare / list.length) * 100)}%  ${[...kinds].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, n]) => `${a}:${n}`).join(" ")}`);
    // 新しい順に、会話が重ならないように PER 件
    const seen = new Set<string>();
    for (const c of [...list].reverse()) { if (seen.has(c.conv)) continue; seen.add(c.conv); picked.push(c); if (seen.size >= PER) break; }
  }
  if (OUT) { writeFileSync(OUT, JSON.stringify(picked, null, 1)); console.log(`\n書き出し ${picked.length} 件 → ${OUT}`); }
  // 2026-10-02 竹内「DEEPSEEKで一連の流れを実際にYUMAにLINEで送りまくって、弱い部分あるか見つける…自動で繰り返し続ける」（⑫）:
  //   --flows=N: 初回から内覧・申込の手前までの「一連の流れ」を会話ごとに丸ごと場面にする（お客様の番ごとに1場面・前の通は文脈）。
  //   選ぶ会話: 初回の番がある・番が5つ以上・内覧／日時／申込の意思の番がある・--exclude-keys の会話は除く。新しい順に --flows-skip 件飛ばして N 件
  //   （巡ごとに skip を変えて別の会話にする）。申込以降・記入済みの申込フォームの後は上の掘り方で既に切ってある
  // --declare-stats: 場面ごとに、スタッフが「その場で物件を送った（AIX 物件ピックアップ/オススメ）」「探す宣言の手打ち」「他の手打ち」「他の AIX」のどれだったか
  //   （⑫ 1巡目: 条件の言い直し・他の物件・設備で ブレインが 物件ピックアップ を選び、スタッフは探す宣言の手打ち＝穴:G2 の線を引く）
  if (process.argv.includes("--declare-stats")) {
    const { classifyStaffTextFacts } = await import("../app/lib/action-ledger");
    const st = new Map<string, Record<string, number>>();
    for (const c of out) {
      const k = c.scene;
      if (!st.has(k)) st.set(k, { n: 0, send_now: 0, declare: 0, other_text: 0, other_aix: 0 });
      const r = st.get(k)!;
      r.n++;
      const aix = c.staff_aix.map((a) => a.aix);
      if (aix.some((a) => a === "property_send" || a === "property_recommendation")) r.send_now++;
      else if (aix.length) r.other_aix++;
      else if (c.staff_texts.some((t) => classifyStaffTextFacts(t, null).some((e) => e.kind === "pickup_declared" && e.status === "promised"))) r.declare++;
      else r.other_text++;
    }
    for (const [k, r] of [...st].sort((a, b) => b[1].n - a[1].n)) console.log(`${k.padEnd(14)} n=${r.n} その場で送る ${r.send_now}・探す宣言の手打ち ${r.declare}・他の手打ち ${r.other_text}・他の AIX ${r.other_aix}`);
  }
  const FLOWS = Number(arg("flows", "0"));
  if (FLOWS > 0) {
    const skip = Number(arg("flows-skip", "0"));
    const maxTurns = Number(arg("flows-max-turns", "12"));
    const exclude = new Set<string>();
    const ek = arg("exclude-keys", "");
    for (const f of ek.split(",").filter(Boolean)) for (const k of JSON.parse(readFileSync(f, "utf8")) as Array<[number, string, string, string]>) exclude.add(k[2]);
    const byConv = new Map<string, Cand[]>();
    for (const c of out) { if (!byConv.has(c.conv)) byConv.set(c.conv, []); byConv.get(c.conv)!.push(c); }
    const flows = [...byConv].filter(([cid, cs]) => !exclude.has(cid) && cs[0].scene === "first_contact" && cs.length >= 5 && cs.some((c) => ["viewing", "meeting_date", "apply"].includes(c.scene)))
      .sort((a, b) => Date.parse(b[1][0].at) - Date.parse(a[1][0].at)).slice(skip, skip + FLOWS);
    const exp = JSON.parse(readFileSync("scripts/replay-scenarios.expect.json", "utf8")) as { stage_ja: Record<string, string> };
    const scen = flows.flatMap(([cid, cs], fi) => cs.slice(0, maxTurns).map((c, ti) => {
      const aix = [...new Set(c.staff_aix.map((a) => a.aix))];
      let accept = aix.length ? aix : ["reply"];
      if (accept.some((a) => a === "property_send" || a === "property_recommendation")) accept = [...new Set([...accept, "property_send", "property_recommendation"])];
      return {
        id: `flow${skip + fi + 1}_${cid.slice(0, 6)}_t${String(ti + 1).padStart(2, "0")}_${c.scene}`, stage: c.scene, stage_ja: exp.stage_ja[c.scene] ?? c.scene, src: `${cid.slice(0, 8)} ${c.at.slice(0, 16)}`,
        context: c.context, customer: c.customer,
        staff: { aix: c.staff_aix, texts: c.staff_texts, aix_texts: c.staff_aix_texts },
        expect: { accept, why: aix.length ? `スタッフは AIX【${aix.join("+")}】` : "スタッフは返信（手打ち）" },
      };
    }));
    const dest = arg("flows-out", "scripts/.replay-out/flows.json");
    writeFileSync(dest, JSON.stringify({ version: new Date().toISOString().slice(0, 10), note: "一連の流れ（本番の会話・申込前・名前/電話/メールを伏せた）。git に入れない", scenarios: scen }, null, 1));
    console.log(`一連の流れ ${flows.length}会話・${scen.length}番 → ${dest}`);
    for (const [cid, cs] of flows) console.log(`  ${cid.slice(0, 8)} ${cs[0].at.slice(0, 10)} 番${cs.length}: ${cs.slice(0, maxTurns).map((c) => c.scene).join(" → ")}`);
  }
  // --pick=<keys.json>（[[_, 場面, 会話ID, 時刻], …]）: 目で選んだ番を場面の形で書き出す（既定 scripts/replay-scenarios.json）。
  //   正解の道（expect）は scripts/replay-scenarios.expect.json（src＝会話IDの頭8桁＋時刻で引く・個人情報なし）から入れる。
  //   場面の文（本番の会話・名前/電話/メールは伏せた）は git に入れない（.gitignore）＝必要な時にこのコマンドで作り直す
  const PICK = arg("pick", "");
  if (PICK) {
    const keys = JSON.parse(readFileSync(PICK, "utf8")) as Array<[number, string, string, string]>;
    const exp = JSON.parse(readFileSync(arg("expect", "scripts/replay-scenarios.expect.json"), "utf8")) as { stage_ja: Record<string, string>; scenarios: Record<string, { id: string; accept: string[]; why: string; must?: string[]; mustNot?: string[] }> };
    const rows = keys.map(([, , conv, at]) => out.find((c) => c.conv === conv && Date.parse(c.at) === Date.parse(at))).filter((c): c is Cand => !!c);
    const scen = rows.map((c, k) => {
      const src = `${c.conv.slice(0, 8)} ${c.at.slice(0, 16)}`;
      const e = exp.scenarios[src];
      const aix = [...new Set(c.staff_aix.map((a) => a.aix))];
      let accept = aix.length ? aix : ["reply"];
      if (accept.some((a) => a === "property_send" || a === "property_recommendation")) accept = [...new Set([...accept, "property_send", "property_recommendation"])];
      return {
        id: e?.id ?? `${c.scene}_${String(k + 1).padStart(2, "0")}`, stage: c.scene, stage_ja: exp.stage_ja[c.scene] ?? c.scene, src,
        context: c.context, customer: c.customer,
        staff: { aix: c.staff_aix, texts: c.staff_texts, aix_texts: c.staff_aix_texts },
        expect: e ? { accept: e.accept, why: e.why, ...(e.must ? { must: e.must } : {}), ...(e.mustNot ? { mustNot: e.mustNot } : {}) } : { accept, why: aix.length ? `スタッフは AIX【${aix.join("+")}】` : "スタッフは返信（手打ち）" },
      };
    });
    const dest = arg("pick-out", "scripts/replay-scenarios.json");
    writeFileSync(dest, JSON.stringify({ version: new Date().toISOString().slice(0, 10), note: "本番の実際の会話（申込前・名前/電話/メールを伏せた）から選んだ場面。git に入れない", scenarios: scen }, null, 1));
    console.log(`選んだ番 ${scen.length}/${keys.length} → ${dest}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
