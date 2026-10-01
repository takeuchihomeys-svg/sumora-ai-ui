// app/lib/aix-json-parts.ts
// 2026-10-02 ⑫（竹内「DEEPSEEKで一連の流れを実際にYUMAにLINEで送りまくって、弱い部分あるか見つける」）の2巡目で見つけた穴:
//   AIX の文を部品の JSON（{"greeting":…,"dates":…,"closing":…}）で作らせる経路は、JSON として読めないと**生の出力をそのまま文にしていた**。
//   YUMA の再生（flow4 t06・AIX【内覧調整】・DeepSeek）で出力が「{」無しで途中から始まり、
//   「10/3(土) 11:00〜13:00\n10/4(日) 14:00〜16:00にてご案内可能です😊！！","closing":"YUMAさんご都合…😌！！"}」が
//   そのまま文になり LINE に届いた（実送信・YUMA だけ）。本番の AIX は Claude だが、同じ穴は物件ピックアップ・書類依頼・申込へにもある。
// 決め: ①JSON として読めればそのまま ②JSON の断片（"キー":"値" の形）が残る出力は、読める部品だけを拾って並べる（先頭の名無しの値も拾う）
//   ③拾った後にも JSON の記号が残るなら空（＝文を作れなかった・呼び出し側はエラーにする）④JSON の形が無い普通の文はそのまま。
//   当たるのは LLM の生の出力だけ（人の文には当てない）＝誤削除の心配は「普通の文に "キー":" の形がある」時だけ（日本語の文には無い）
export type AixJsonParts = { text: string; parts: Record<string, string> | null; salvaged: boolean; failed: boolean };

const PAIR_RE = /"([A-Za-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
/** JSON の記号の名残（"キー": / ","キー" / 末尾の "}） */
export const JSON_RESIDUE_RE = /"[A-Za-z_]+"\s*:\s*"|"\s*,\s*"[A-Za-z_]+"|"\s*\}\s*$|^\s*\{\s*"/;

function unescape(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\t/g, " ").replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
}

export function joinAixJsonParts(raw: string, order: ReadonlyArray<string>, sep = "\n\n"): AixJsonParts {
  const s = String(raw ?? "");
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const c = JSON.parse(m[0]) as Record<string, unknown>;
      const parts: Record<string, string> = {};
      for (const [k, v] of Object.entries(c)) if (typeof v === "string") parts[k] = v;
      return { text: order.map((k) => parts[k] ?? "").filter(Boolean).join(sep), parts, salvaged: false, failed: false };
    } catch { /* 下の拾い方へ */ }
  }
  if (!JSON_RESIDUE_RE.test(s)) return { text: s, parts: null, salvaged: false, failed: false };
  // 断片から拾う。最初の "キー":" より前の文は、名前の無い部品の値の続き（「{"dates":"」が欠けた形）
  const parts: Record<string, string> = {};
  for (const p of s.matchAll(PAIR_RE)) parts[p[1]] = unescape(p[2]);
  const firstKey = s.search(/"\s*,\s*"[A-Za-z_]+"\s*:\s*"|^\s*\{?\s*"[A-Za-z_]+"\s*:\s*"/);
  let lead = firstKey > 0 ? s.slice(0, firstKey) : "";
  lead = unescape(lead.replace(/^\s*\{?\s*/, "")).trim();
  const known = order.map((k) => parts[k] ?? "").filter(Boolean);
  const text = [lead, ...known].filter(Boolean).join(sep).trim();
  if (!text || JSON_RESIDUE_RE.test(text) || /"\s*\}/.test(text)) return { text: "", parts: null, salvaged: true, failed: true };
  return { text, parts, salvaged: true, failed: false };
}
