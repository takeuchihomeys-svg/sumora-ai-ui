// scripts/audit-brain-interference.ts
// 2026-10-09 竹内さん「テストの際、ブレインの判断を邪魔している部分があるか合わせて調査する」
//   ブレインの判断（brainReplyDirection・rawAction・avoid_topics）が決まった後に、生成の途中の経路
//   （型の方向・AIX の方向・確認の関門・出口のゲート・最終チェックの書き直し・古い判断・戦略の避ける話題）で
//   下書きがブレインと食い違った番を、経路ごとに数える。そのうち実送信（竹内さん＝staff_writer=takeuchi）が
//   ブレイン側に近かった番＝「邪魔で質が下がった番」を数える。読むだけ・LLM なし。
//   材料: ai_reply_examples（entry_source=line_reply）の reply_context_snapshot（生成の瞬間の値）・ai_draft・sent_reply
//         messages.staff_writer（送った人）
//   申込以降（application_push を押した後）・テストの会話は除く。
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-interference.ts [--days=40] [--show=3] [--writer=takeuchi|all] [--out=scripts/.replay-out/brain-interference.jsonl]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { isTestConversation } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "40"));
const SHOW = Number(arg("show", "3"));
const WRITER = arg("writer", "takeuchi");
const OUT = arg("out", "");

async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 400_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; }
  return out;
}
const one = (s: string | null | undefined, n = 90) => (s ?? "").replace(/\s+/g, " ").slice(0, n);

// ── 中身の種類（約束・答え）を文から読む。ブレインの方向は「書かない・禁止」の節を除いてから読む ──
type Kind = "見積の約束" | "募集状況の確認" | "確認の約束" | "ピックアップ" | "内覧" | "申込" | "写真" | "全力サポート" | "相場・家賃の説明";
const KIND_RE: Record<Kind, { dir: RegExp; text: RegExp }> = {
  "見積の約束": { dir: /見積/, text: /御?見積書?[^。！!\n]{0,30}(お送り|作成|送らせ)|見積[^。\n]{0,8}(させて|致し)/ },
  "募集状況の確認": { dir: /募集状況|空室|空き状況/, text: /(募集状況|空室|空き状況)[^。！!\n]{0,12}確認/ },
  "確認の約束": { dir: /確認(する|させ|の約束|を約束|し次第|出来次第|でき次第)/, text: /確認(させて|致し|いたし|出来次第|でき次第)/ },
  "ピックアップ": { dir: /ピックアップ|新着/, text: /ピックアップ|新着/ },
  "内覧": { dir: /内覧|内見/, text: /内覧|内見/ },
  "申込": { dir: /申込|申し込|お部屋(を)?抑え|押さえ/, text: /申込|申し込|抑えさせ|押さえさせ/ },
  "写真": { dir: /写真|室内/, text: /写真|室内/ },
  "全力サポート": { dir: /全力|サポート/, text: /全力/ },
  "相場・家賃の説明": { dir: /相場/, text: /相場/ },
};
const NEG_RE = /(書かない|しない|禁止|不要|避け|触れない|入れない|言わない|控え|NG|ではなく|せず|やめ)/;
function dirKinds(dir: string): Set<Kind> {
  const s = new Set<Kind>();
  // 「言い方は実際の送信の形「…」」の引用は肯定の材料として残す。節は 。と（と、で区切る
  // 決まり文句（「同じ発言の他のご希望・ご質問（内覧の日時のご希望など）にも一言ずつ応える（例: …）」）と括弧の例は外す
  const cleaned = dir.replace(/brain方向性（参考）:?/g, "")
    .replace(/同じ発言の他のご希望・ご質問[^。]*。?/g, "")
    .replace(/（[^（）]*）/g, "").replace(/\([^()]*\)/g, "");
  const segs = cleaned.split(/[。\n]|、(?=[^「」]*$)/);
  for (const seg of segs) {
    if (!seg.trim() || NEG_RE.test(seg)) continue;
    for (const k of Object.keys(KIND_RE) as Kind[]) if (KIND_RE[k].dir.test(seg)) s.add(k);
  }
  return s;
}
function textKinds(t: string): Set<Kind> {
  const s = new Set<Kind>();
  for (const k of Object.keys(KIND_RE) as Kind[]) if (KIND_RE[k].text.test(t)) s.add(k);
  return s;
}
function sameDirection(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[。、！!？?\s]/g, "");
  const A = norm(a), B = norm(b);
  if (!A || !B) return false;
  if (A === B || A.includes(B) || B.includes(A)) return true;
  const grams = (s: string) => new Set(Array.from({ length: Math.max(s.length - 1, 0) }, (_, i) => s.slice(i, i + 2)));
  const ga = grams(A), gb = grams(B); let hit = 0; for (const g of ga) if (gb.has(g)) hit++;
  return (2 * hit) / (ga.size + gb.size) >= 0.6;
}
// 方向の出どころ（generate-reply の effectiveReplyDirection の分岐を文の頭で見分ける）
function directionSource(snap: Record<string, any>): string {
  const eff = String(snap.effectiveReplyDirection ?? ""), br = String(snap.brainReplyDirection ?? "");
  if (!eff) return "方向なし";
  if (br && sameDirection(br, eff) && !/brain方向性（参考）/.test(eff)) return "ブレインのまま";
  const rule = snap.turnPair?.ruleId as string | undefined;
  if (/brain方向性（参考）/.test(eff)) return `型（往復セル ${rule ?? "?"}）がブレインを参考に格下げ`;
  if (/^確認結果は直前の AIX/.test(eff)) return "確認の続き（checkAnsweredFollowUp）";
  if (/^条件提示/.test(eff)) return "条件提示の固定方向（conditionDirection）";
  if (/^内覧キャンセル/.test(eff)) return "内覧キャンセルの固定方向";
  if (/^顧客自身の断り|^否決・募集終了/.test(eff)) return "ネガ文脈の固定方向";
  if (/^入居時期情報/.test(eff)) return "退去・入居時期の固定方向";
  if (/^顧客が今は確認できない/.test(eff)) return "一時保留の固定方向";
  if (/^検討中の待ち/.test(eff)) return "検討中の固定方向";
  if (/^強推し直後/.test(eff)) return "強推し直後の固定方向";
  if (/^感謝を1行で受け取り/.test(eff)) return "感謝返しの固定方向（gratitudeActionHint）";
  if (/^不安対応/.test(eff)) return "不安対応の固定方向";
  if (/WE DO例/.test(eff)) return `AIX の方向（effectiveAction=${snap.effectiveAction ?? "?"}）`;
  if (/会話全体の方針/.test(eff)) return "古い戦略の方向（last_brain_meta）";
  if (rule) return `型（往復セル ${rule}）`;
  return "状態の既定（STATE_FALLBACK）ほか";
}

const contentWords = (s: string) => new Set((s.replace(/（[^（）]*）/g, "").replace(/同じ発言の他のご希望・ご質問[^。]*。?/g, "").match(/[一-龥]{2,}|[ァ-ヶー]{3,}|[A-Za-z]{3,}|\d{2,}/g) ?? []));
const GENERIC = /^(お客様|場合|内容|部分|形式|以下|以上|必要|可能|対応|確認|連絡|提案|送付|報告|実施|状況|今回|次回|文字|一行|一文|宣言|添える|受け取|合計|返信|約束|言い方|実際|送信|結果|一言|質問|希望|方向|回答|簡潔|丁寧|伝える|案内|次の|一手|最大限|割引|御見積書|見積書|募集状況|物件|お部屋|今後|共感|気持|受け止|感謝|お礼|締め|促す|誘導|会話|発言|直前)$/;
type Ex = { id: string; conversation_id: string; created_at: string; sent_at: string | null; customer_message: string | null; sent_reply: string | null; ai_draft: string | null; was_ai_used: boolean | null; reply_context_snapshot: Record<string, any> | null };
type Msg = { conversation_id: string; sender: string; created_at: string; text: string | null; staff_writer: string | null };

async function main() {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const exs = (await readAll<Ex>((f, t) => sb.from("ai_reply_examples").select("id, conversation_id, created_at, sent_at, customer_message, sent_reply, ai_draft, was_ai_used, reply_context_snapshot")
    .gte("created_at", since).eq("entry_source", "line_reply").not("reply_context_snapshot", "is", null).order("created_at").range(f, t)))
    .filter((e) => e.reply_context_snapshot && "brainReplyDirection" in e.reply_context_snapshot && !isTestConversation(e.conversation_id));
  const cids = [...new Set(exs.map((e) => e.conversation_id))];
  const msgs: Msg[] = []; const applyAt = new Map<string, string>();
  const tasks: Array<{ conversation_id: string; created_at: string; completed_at: string | null; resolved_at: string | null }> = [];
  for (let i = 0; i < cids.length; i += 80) {
    const part = cids.slice(i, i + 80);
    msgs.push(...await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, staff_writer").in("conversation_id", part).eq("sender", "staff").gte("created_at", since).order("created_at").range(f, t)));
    const ps = await readAll<{ conversation_id: string; created_at: string }>((f, t) => sb.from("aix_usage_logs").select("conversation_id, created_at").in("conversation_id", part).eq("aix_type", "application_push").order("created_at").range(f, t));
    for (const p of ps) if (!applyAt.has(p.conversation_id)) applyAt.set(p.conversation_id, p.created_at);
    // generate-reply は property_check のタスクが開いている間、replyHint「募集状況確認中★最重要（内覧・物件提案・見積の話は絶対にしない）」を入れ、
    //   ブレインの AIX の判断（replyAixInput）を null にする。記録に残らないので line_tasks から組み立てる
    tasks.push(...await readAll<{ conversation_id: string; created_at: string; completed_at: string | null; resolved_at: string | null }>((f, t) => sb.from("line_tasks").select("conversation_id, created_at, completed_at, resolved_at").in("conversation_id", part).eq("task_type", "property_check").order("created_at").range(f, t)));
  }
  const pcActive = (cid: string, at: string) => tasks.some((t) => t.conversation_id === cid && Date.parse(t.created_at) < Date.parse(at) && (() => { const end = t.completed_at ?? t.resolved_at; return !end || Date.parse(end) > Date.parse(at); })());
  const mBy = new Map<string, Msg[]>(); for (const m of msgs) { if (!mBy.has(m.conversation_id)) mBy.set(m.conversation_id, []); mBy.get(m.conversation_id)!.push(m); }
  const writerOf = (e: Ex): string | null => {
    const t0 = Date.parse(e.sent_at ?? e.created_at); const head = one(e.sent_reply, 12);
    let best: Msg | null = null; let bd = Infinity;
    for (const m of mBy.get(e.conversation_id) ?? []) { const d = Math.abs(Date.parse(m.created_at) - t0); if (d < 15 * 60_000 && d < bd && (!head || one(m.text, 12) === head || d < 90_000)) { best = m; bd = d; } }
    return best?.staff_writer ?? null;
  };

  type Row = { e: Ex; writer: string | null; paths: string[]; bK: Set<Kind>; dK: Set<Kind>; sK: Set<Kind>; diverged: boolean; harm: boolean; harmKinds: string[] };
  const rows: Row[] = [];
  for (const e of exs) {
    const a = applyAt.get(e.conversation_id); if (a && Date.parse(e.created_at) >= Date.parse(a)) continue;
    const s = e.reply_context_snapshot!; const draft = e.ai_draft ?? ""; const sent = e.sent_reply ?? "";
    if (!draft.trim() || !sent.trim()) continue;
    const br = String(s.brainReplyDirection ?? ""); if (!br) continue;
    const bK = dirKinds(br), dK = textKinds(draft), sK = textKinds(sent);
    const paths: string[] = [];
    const src = directionSource(s); if (src !== "ブレインのまま") paths.push(`方向:${src}`);
    for (const g of (s.postprocess?.gateEdits ?? []) as Array<{ rule: string }>) paths.push(`出口ゲート:${g.rule}`);
    for (const r of (Array.isArray(s.postprocess?.reverted) ? s.postprocess.reverted : []) as Array<{ code: string }>) paths.push(`出口の差し戻し:${r.code}`);
    const pre = new Set<string>((s.preRevisionCodes ?? []) as string[]); const post = new Set<string>((s.finalCheckCodes ?? []) as string[]);
    const fixed = [...pre].filter((c) => /:block|:warning/.test(c) && !post.has(c)).map((c) => c.split(":")[0]);
    if (fixed.length && s.revisionOutcome !== "exhausted") for (const c of fixed) paths.push(`最終チェックの書き直し:${c}`);
    if (s.confirmCtx?.allowed) paths.push(`確認の関門:${s.confirmCtx.source}`);
    if (pcActive(e.conversation_id, e.created_at)) paths.push("replyHint:募集状況確認中（AIX 判断を無効・内覧/提案/見積を禁止）");
    if (s.tier && s.tier !== "T1") paths.push(`古い判断:${s.tier}${s.isCachedMeta ? "/cached" : ""}`);
    else if (s.isCachedMeta) paths.push("古い判断:T1/cached");
    const avoid: string[] = s.brainStrategy?.avoid_topics ?? [];
    for (const k of bK) if (avoid.some((t) => KIND_RE[k].dir.test(t))) paths.push(`戦略の避ける話題がこの番の方向とぶつかる:${k}`);
    if ((s.rawAction ?? null) !== (s.effectiveAction ?? null)) paths.push(`AIX の一手を落とした:${s.rawAction}→${s.effectiveAction ?? "null"}`);
    // 食い違い: ブレインの種類と下書きの種類が違う
    const U = new Set<Kind>([...bK, ...dK]);
    const diffK = [...U].filter((k) => bK.has(k) !== dK.has(k));
    const diverged = diffK.length > 0;
    let bAgree = 0, dAgree = 0; const harmKinds: string[] = [];
    for (const k of diffK) {
      if (sK.has(k) === bK.has(k)) { bAgree++; harmKinds.push(bK.has(k) ? `ブレインの${k}を下書きが落とした` : `下書きが${k}を足した（ブレインに無い）`); }
      else dAgree++;
    }
    // 語の物差し（ブレインの方向にだけある内容語＝地名・物件名・項目が、下書きより実送信に多く入ったか）
    const W = [...contentWords(br)].filter((w) => !GENERIC.test(w));
    const hitD = W.filter((w) => draft.includes(w)).length, hitS = W.filter((w) => sent.includes(w)).length;
    const lexHarm = W.length >= 3 && (hitS - hitD) / W.length >= 0.25 && hitS / W.length >= 0.35;
    if (lexHarm) harmKinds.push(`ブレインの語が下書きに無く実送信にある（${W.filter((w) => sent.includes(w) && !draft.includes(w)).slice(0, 5).join("・")}）`);
    rows.push({ e, writer: writerOf(e), paths, bK, dK, sK, diverged: diverged || lexHarm, harm: (diverged && bAgree > dAgree) || lexHarm, harmKinds });
  }
  const target = WRITER === "all" ? rows : rows.filter((r) => r.writer === WRITER);
  console.log(`生成の記録 ${exs.length}件 → 下書きと実送信がある番 ${rows.length}（書き手 takeuchi ${rows.filter((r) => r.writer === "takeuchi").length}・employee ${rows.filter((r) => r.writer === "employee").length}・不明 ${rows.filter((r) => !r.writer).length}）／対象（${WRITER}）${target.length}`);
  console.log(`  ブレインと下書きの中身の種類が食い違った番 ${target.filter((r) => r.diverged).length}・そのうち実送信がブレイン側に近い（邪魔で質が下がった）番 ${target.filter((r) => r.harm).length}・下書き側に近い ${target.filter((r) => r.diverged && !r.harm).length}`);

  const tab = new Map<string, { n: number; div: number; harm: number; ex: Row[] }>();
  for (const r of target) for (const p of new Set(r.paths)) {
    const c = tab.get(p) ?? { n: 0, div: 0, harm: 0, ex: [] }; c.n++; if (r.diverged) c.div++; if (r.harm) { c.harm++; c.ex.push(r); } tab.set(p, c);
  }
  // 経路が1つも付かない「邪魔」は生成（LLM）自身の読み違い＝経路なし
  const noPath = target.filter((r) => r.harm && r.paths.length === 0);
  console.log(`\n経路 × 番（経路の付いた番・食い違い・邪魔＝実送信がブレイン側）`);
  console.log(["経路", "番", "食い違い", "邪魔", "邪魔/番"].join("\t"));
  for (const [p, c] of [...tab.entries()].sort((a, b) => b[1].harm - a[1].harm || b[1].n - a[1].n)) console.log([p, c.n, c.div, c.harm, c.n ? `${Math.round((c.harm / c.n) * 100)}%` : "-"].join("\t"));
  console.log(["（経路なし＝生成 LLM 自身）", "-", "-", noPath.length].join("\t"));
  // 経路が単独の邪魔（他の経路と重ならない）＝その経路の責任が確かな番
  console.log(`\n経路が1つだけの邪魔（責任が確かな番）`);
  const solo = new Map<string, number>(); for (const r of target.filter((x) => x.harm && x.paths.length === 1)) solo.set(r.paths[0], (solo.get(r.paths[0]) ?? 0) + 1);
  for (const [p, n] of [...solo.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${p}\t${n}`);
  console.log(`\n邪魔の中身の種類`);
  const hk = new Map<string, number>(); for (const r of target.filter((x) => x.harm)) for (const k of r.harmKinds) hk.set(k, (hk.get(k) ?? 0) + 1);
  for (const [k, n] of [...hk.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}\t${n}`);

  console.log(`\n実例（経路ごとに上位 ${SHOW}件）`);
  for (const [p, c] of [...tab.entries()].sort((a, b) => b[1].harm - a[1].harm).filter(([, c]) => c.harm > 0).slice(0, 14)) {
    console.log(`\n■ ${p}（邪魔 ${c.harm}）`);
    for (const r of c.ex.slice(0, SHOW)) {
      const s = r.e.reply_context_snapshot!;
      console.log(`  ${r.e.conversation_id.slice(0, 8)} ${r.e.created_at.slice(0, 16)} 書き手=${r.writer} 他の経路=${r.paths.filter((x) => x !== p).join(" / ") || "なし"}`);
      console.log(`    客 : ${one(r.e.customer_message, 100)}`);
      console.log(`    脳 : ${one(s.brainReplyDirection, 130)}`);
      console.log(`    方向: ${one(s.effectiveReplyDirection, 100)}`);
      console.log(`    下書: ${one(r.e.ai_draft, 130)}`);
      console.log(`    実送: ${one(r.e.sent_reply, 130)}`);
      console.log(`    差 : ${r.harmKinds.join("・")}`);
    }
  }
  if (OUT) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, target.map((r) => JSON.stringify({ id: r.e.id, cid: r.e.conversation_id, at: r.e.created_at, writer: r.writer, paths: r.paths, brain: [...r.bK], draft: [...r.dK], sent: [...r.sK], diverged: r.diverged, harm: r.harm, harmKinds: r.harmKinds })).join("\n"));
    console.log(`\n→ ${OUT}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
