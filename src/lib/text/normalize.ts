/**
 * Persian-aware text normalisation for full-text search.
 *
 * The same function is applied before indexing and before querying, so a
 * query matches indexed text regardless of Arabic/Persian letter variants,
 * diacritics, digit scripts or Latin accents. Pure: no React, no storage.
 *
 * The zero-width non-joiner (U+200C) is preserved by {@link normalizeText}:
 * it is meaningful Persian orthography, and indexers should expand it with
 * {@link zwnjForms} so both the joined and the space-split form match.
 */

const ARABIC_TO_PERSIAN: Record<string, string> = {
  "\u064A": "\u06CC", // ي → ی (Arabic yeh → Persian yeh)
  "\u0643": "\u06A9", // ك → ک (Arabic kaf → Persian kaf)
  "\u0629": "\u0647", // ة → ه (teh marbuta → heh)
  "\u0624": "\u0648", // ؤ → و (waw with hamza → waw)
  "\u0623": "\u0627", // أ → ا (alef with hamza above → alef)
  "\u0625": "\u0627", // إ → ا (alef with hamza below → alef)
};

// Arabic diacritics (fathatan … sukun) plus superscript alef.
const DIACRITICS = /[\u064B-\u0652\u0670]/g;
// Tatweel (kashida), used for justification, carries no meaning.
const TATWEEL = /\u0640/g;

const DIGIT_MAP: Record<string, string> = {
  "\u06F0": "0",
  "\u06F1": "1",
  "\u06F2": "2",
  "\u06F3": "3",
  "\u06F4": "4",
  "\u06F5": "5",
  "\u06F6": "6",
  "\u06F7": "7",
  "\u06F8": "8",
  "\u06F9": "9", // Persian (extended Arabic-Indic) digits
  "\u0660": "0",
  "\u0661": "1",
  "\u0662": "2",
  "\u0663": "3",
  "\u0664": "4",
  "\u0665": "5",
  "\u0666": "6",
  "\u0667": "7",
  "\u0668": "8",
  "\u0669": "9", // Arabic-Indic digits
};

const ARABIC_LETTER = /[\u064A\u0643\u0629\u0624\u0623\u0625]/g;
const ANY_DIGIT = /[\u06F0-\u06F9\u0660-\u0669]/g;
// Latin combining diacritics only (U+0300–U+036F): stripping just these
// leaves Arabic/Persian marks (e.g. the maddah in آ) untouched after NFKD.
const LATIN_MARKS = /[\u0300-\u036F]/g;

export const ZWNJ = "\u200C";

/**
 * Normalise text for search: Arabic → Persian letters, diacritics and
 * tatweel removed, Persian/Arabic digits → Latin digits, Latin lowercased
 * with accents stripped. The zero-width non-joiner is preserved; see
 * {@link zwnjForms}.
 */
export function normalizeText(input: string): string {
  return input
    .replace(ARABIC_LETTER, (ch) => ARABIC_TO_PERSIAN[ch])
    .replace(DIACRITICS, "")
    .replace(TATWEEL, "")
    .replace(ANY_DIGIT, (ch) => DIGIT_MAP[ch])
    .normalize("NFKD")
    .replace(LATIN_MARKS, "")
    .normalize("NFC")
    .toLowerCase();
}

/**
 * Both search forms of a word containing a zero-width non-joiner: the
 * joined form (`میخوانم`) and the space-split form (`می خوانم`). Each form
 * is normalised. A word without a ZWNJ returns just its normalised form.
 */
export function zwnjForms(word: string): string[] {
  const normalized = normalizeText(word);
  if (!normalized.includes(ZWNJ)) return [normalized];
  const joined = normalized.replaceAll(ZWNJ, "");
  const split = normalized.replaceAll(ZWNJ, " ");
  return [...new Set([joined, split])];
}
