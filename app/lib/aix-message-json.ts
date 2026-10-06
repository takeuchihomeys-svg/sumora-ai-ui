// app/lib/aix-message-json.ts
// AIX の文を {"message": "..."} の JSON で書かせる経路の読み取り（純関数・DB 依存なし）。
//
// 2026-10-06 ⑰（竹内「AIXテンプレートのズレ…実際のLINEと比べて根本的にずれている部分をみつけて改善する」）:
//   AIX【物件ピックアップ】の下書き 60日で 6通の末尾に『"}』が残り、先頭の名前の行が消えていた（9/20・10/04・10/05・スタッフが全部消して送った）。
//   原因は aix/action の `raw.match(/\{[\s\S]*\}/)` → JSON.parse → 失敗したら**生の出力をそのまま文にする**読み取り。
//   LLM が文字列の中に生の改行を入れると JSON.parse は失敗し、`{"message": "〇〇さん\n\n…"}` が文になる（後段で1行目が落ち、末尾の "} が残る）。
//   同じ読み取りが aix/action の十数か所にコピーされていた（設計知見「LLM に部品の JSON で書かせる経路は、読めない時に生の出力を文にしない」の取りこぼし）。
// 決め: ⑫ の joinAixJsonParts（app/lib/aix-json-parts.ts・読める部品だけ拾う・拾えなければ空・JSON の形が無い普通の文はそのまま）に
//   message の1部品で通す。読めた JSON に message が無い時も、旧の「生の JSON を文にする」をやめて空にする（呼び出し側の空の扱いに任せる）。
//   旧と同じく、二重に逃がした改行（\\n）は改行に戻す。
import { joinAixJsonParts } from "./aix-json-parts";

export type AixMessageRead = { text: string; salvaged: boolean; failed: boolean };

export function readAixMessageJson(raw: string | null | undefined): AixMessageRead {
  const j = joinAixJsonParts(String(raw ?? ""), ["message"]);
  return { text: j.text.replace(/\\n/g, "\n"), salvaged: j.salvaged, failed: j.failed };
}

// 2026-10-07 竹内（Ryoichi kiritsuke 10/05 13:46 の AIX【物件ピックアップした】の編集画面「ここのミスなくす」）:
//   下書きの末尾に『"}』が残っていた（aix_generate_log 8b139bd2・10/05 04:45 UTC）。⑰（6f1832a8・10/06 15:44 JST）より前の生成で、
//   ⑰ 以降の AIX の生成 37通には JSON の名残 0（60日の名残 8通は全部 ⑰ 前）。⑰ の読み取りで直っている。
//   ただ AIX の出口（aix/action の finalize）には名残を落とす決定論が無く、読み取りを通らない新しい経路が出来ると同じ形が下書き欄に入る。
//   送信 API（outgoing-residue）は止めるが、スタッフが手で消す手間が残る。
// 決め: 端（先頭・末尾）だけの名残を落とす。本文の中に JSON の鍵が残る時は触らない（どこまでが本文か決められない＝送信 API が止める）。
//   落とすのは ①末尾の『"}』『"]}』『"\n}』（ASCII の " の直後に } で終わる）②先頭の『{"message":"』（英字の鍵）とその時の末尾の『"』
//   人の文・AIX の送信で ASCII の " ＋ } で終わる通は 0（scripts/audit-aix-json-edge.ts で確かめる）。
const EDGE_TAIL_RE = /"\s*\]?\s*\}\s*$/;
const EDGE_HEAD_RE = /^\s*\{\s*"[A-Za-z_]{1,40}"\s*:\s*"/;
const INNER_KEY_RE = /"[A-Za-z_][A-Za-z0-9_]{0,40}"\s*:\s*(?:"|\[|\{)/;

export function stripJsonEdgeResidue(text: string | null | undefined): { text: string; stripped: boolean } {
  const s = String(text ?? "");
  let t = s;
  const head = EDGE_HEAD_RE.test(t);
  if (head) t = t.replace(EDGE_HEAD_RE, "");
  if (EDGE_TAIL_RE.test(t)) t = t.replace(EDGE_TAIL_RE, "");
  else if (head) t = t.replace(/"\s*$/, "");
  if (t === s) return { text: s, stripped: false };
  // 中に鍵が残る（部品の途中で切れた形）は触らない
  if (INNER_KEY_RE.test(t)) return { text: s, stripped: false };
  if (head) t = t.replace(/\\n/g, "\n").replace(/\\"/g, "\"");
  t = t.replace(/\s+$/, "");
  if (!t.trim()) return { text: s, stripped: false };
  return { text: t, stripped: true };
}
