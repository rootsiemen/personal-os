import { describe, expect, it } from "vitest";
import { normalizeText, zwnjForms } from "@/lib/text/normalize";

describe("normalizeText", () => {
  it("maps Arabic letters to Persian letters", () => {
    expect(normalizeText("ي")).toBe("ی");
    expect(normalizeText("ك")).toBe("ک");
    expect(normalizeText("مدرسة")).toBe("مدرسه");
    expect(normalizeText("مؤمن")).toBe("مومن");
    expect(normalizeText("أحمد")).toBe("احمد");
    expect(normalizeText("إلى")).toBe("الى");
    expect(normalizeText("علي كتاب")).toBe("علی کتاب");
  });

  it("removes diacritics and tatweel", () => {
    expect(normalizeText("کِتاب")).toBe("کتاب");
    expect(normalizeText("کـتاب")).toBe("کتاب");
    expect(normalizeText("مُحَمَّد")).toBe("محمد");
  });

  it("converts Persian and Arabic digits to Latin digits", () => {
    expect(normalizeText("۱۴۰۵")).toBe("1405");
    expect(normalizeText("١٤٠٥")).toBe("1405");
    expect(normalizeText("سال ۱۴۰۵ و ١٤٠٥")).toBe("سال 1405 و 1405");
  });

  it("lowercases Latin text and strips accents", () => {
    expect(normalizeText("Café")).toBe("cafe");
    expect(normalizeText("HELLO World")).toBe("hello world");
    expect(normalizeText("résumé")).toBe("resume");
  });

  it("preserves the zero-width non-joiner for zwnjForms to expand", () => {
    expect(normalizeText("می‌خوانم")).toBe("می‌خوانم");
  });

  it("handles empty input and mixed text", () => {
    expect(normalizeText("")).toBe("");
    expect(normalizeText("کتاب ۱۴۰۵ Café")).toBe("کتاب 1405 cafe");
  });
});

describe("zwnjForms", () => {
  it("returns the joined and space-split forms of a ZWNJ word", () => {
    expect(zwnjForms("می‌خوانم")).toEqual(["میخوانم", "می خوانم"]);
  });

  it("normalises each form", () => {
    expect(zwnjForms("می‌خوانم ۱۴۰۵")).toEqual(["میخوانم 1405", "می خوانم 1405"]);
  });

  it("returns just the normalised form when there is no ZWNJ", () => {
    expect(zwnjForms("کتاب")).toEqual(["کتاب"]);
    expect(zwnjForms("Café")).toEqual(["cafe"]);
  });
});
