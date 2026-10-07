import { fieldLabelText } from "./descriptor.ts";
import { fieldKinds } from "./kinds.ts";
import type { AboutValue } from "./about.ts";
import type { FillField } from "../protocol.ts";

export type AlternateKind = "email" | "phone" | "address";

// Source: general language knowledge, not held-out pages or keys. The groups cover English, Spanish,
// French, German, Arabic, Hindi and Korean, then unspaced Chinese/Japanese compounds. No coverage study
// exists. Match whole words in spaced scripts, including combining marks, rather than English-only \b.
const SECONDARY = /(?<![\p{L}\p{M}\p{N}])(?:alternate|alternative|secondary|backup|other|additional|second|2nd|alternativ[oa]s?|secundari[oa]s?|otr[oa]s?|adicional|segund[oa]|de reserva|secondaire|alternatif|autre|supplémentaire|de secours|alternativ(?:e[rsnm]?)?|sekundär(?:e[rsnm]?)?|ersatz|weitere[rsnm]?|andere[rsnm]?|zweite[rsnm]?|احتياطي|الاحتياطي|بديل|البديل|آخر|الآخر|ثانوي|الثانوي|إضافي|الإضافي|ثاني|الثاني|वैकल्पिक|अन्य|दूसरा|दूसरी|अतिरिक्त|보조|대체|다른|추가|두 번째|예비|백업)(?![\p{L}\p{M}\p{N}])|备用|備用|其他|其它|第二|额外|額外|予備|代替|追加|別の|その他/iu;
const CONFIRM = /(?<![\p{L}\p{M}])(?:confirm(?:ation)?|re[ -]?enter|verify|again|confirmar|confirmación|verificar|repetir|de nuevo|confirmer|confirmation|vérifier|ressaisir|à nouveau|bestätigen|bestätigung|wiederholen|erneut|تأكيد|التأكيد|تحقق|التحقق|مرة أخرى|إعادة|पुष्टि|दोबारा|फिर से|확인|재입력|다시)(?![\p{L}\p{M}])|确认|確認|再次|重新输入|再入力|もう一度/iu;

export function alternateKind(label: string | null): AlternateKind | null {
  const cleaned = fieldLabelText(label)?.normalize("NFKC") ?? "";
  // Help text in parentheses does not rename a field: "Email (other people can see this)".
  const qualifier = new RegExp(`^(?:${SECONDARY.source})$`, "iu");
  const name = cleaned.replace(/\(([^)]*)\)|\[([^\]]*)\]/gu, (_all, round: string | undefined, square: string | undefined) => {
    const inside = (round ?? square ?? "").trim();
    return qualifier.test(inside) ? ` ${inside} ` : "";
  });
  if (CONFIRM.test(cleaned) || !SECONDARY.test(name)) return null;
  return primaryKind(name);
}

export function primaryKind(label: string | null): AlternateKind | null {
  const kinds = fieldKinds([label?.normalize("NFKC")]);
  return (["email", "phone", "address"] as const).find((k) => kinds.has(k)) ?? null;
}

export function alternateKey(kind: AlternateKind, value: string): string {
  const normalized = value.normalize("NFKC").toLowerCase().trim();
  // Formatting only, not near-match identity: do not guess country codes or postal abbreviations.
  return kind === "phone" ? normalized.replace(/[^\p{N}]/gu, "") : normalized.replace(/\s+/gu, " ");
}

export function ownAlternateValue(kind: AlternateKind, value: string, about: readonly AboutValue[]): boolean {
  const key = alternateKey(kind, value);
  return about.some((a) => a.kind === kind && alternateKey(kind, a.value) === key);
}

// Helper-local metadata, like fill's write mints. No new field on the host's wire contract.
const reasons = new WeakMap<FillField, string>();
export function setAlternateReason(field: FillField, reason: string): void { reasons.set(field, reason); }
export function alternateReason(field: FillField): string | null { return reasons.get(field) ?? null; }
