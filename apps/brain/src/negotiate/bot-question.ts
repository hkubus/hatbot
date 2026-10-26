// Whether the seller is writing to a bot is the owner's to answer, so asking it holds the negotiation.

const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ł/g, "l")
    .replace(/(?<![\p{L}\p{N}])a\.i\.?/gu, "ai");

const terms = (list: string[]) =>
  list.map((t) => t.replace(/[.]/g, "\\.").replace(/\*/g, "\\p{L}*")).join("|");

const BOT = terms([
  "bot",
  "bota",
  "botem",
  "botu",
  "chatbot*",
  "czatbot*",
  "ai",
  "sztuczn* inteligencj*",
  "chatgpt",
  "czatgpt",
  "chat gpt",
  "czat gpt",
  "gpt",
  "robot",
  "robotem",
  "llm",
]);
const HUMAN = terms([
  "czlowiek",
  "czlowiekiem",
  "czlowieka",
  "prawdziw* osob*",
  "zyw* osob*",
  "real person",
  "human",
]);
/** Words about who is writing. A bare "to" ("czy to bot?") only counts right before a bot word. */
const WRITER = terms([
  "jestes*",
  "jest pan",
  "jest pani",
  "pan jest",
  "pani jest",
  "piszesz",
  "pisze z",
  "pisze ze",
  "rozmawiam*",
  "gadam",
  "odpisuje*",
  "odpowiada*",
  "are you",
  "am i",
  "is this",
  "is it",
  "talking to",
  "chatting with",
  "writing to",
]);

const W = "[^\\p{L}\\p{N}]+";
const W0 = "[^\\p{L}\\p{N}]*";
const gap = (n: number) => `(?:${W}[\\p{L}\\p{N}]+){0,${n}}${W}`;
const word = (re: string) => `(?<![\\p{L}\\p{N}])(?:${re})(?![\\p{L}\\p{N}])`;
const ASKED = [
  `${word(WRITER)}${gap(3)}(?<t>${word(`${BOT}|${HUMAN}`)})`,
  `(?<t>${word(`${BOT}|${HUMAN}`)})${gap(3)}${word(WRITER)}`,
  `${word("to")}${gap(1)}(?<t>${word(BOT)})`,
  `(?<t>${word(BOT)})${W}(?:czy|or)${W}${word(HUMAN)}`,
  `${word(HUMAN)}${W}(?:czy|or)${W}(?<t>${word(BOT)})`,
  `^${W0}(?<t>${BOT})${W0}$`,
].map((s) => new RegExp(s, "gu"));

/** A bot word that's in the title is the item's ("Czy ten robot jeździ?" about a robot vacuum). */
export function askedIfBot(text: string, title: string): boolean {
  const own = new Set(fold(title).split(/[^\p{L}\p{N}]+/u));
  return fold(text)
    .split(/[.!?\n]+/)
    .some((sentence) =>
      ASKED.some((re) =>
        [...sentence.matchAll(re)].some(
          (m) => !(m.groups?.t ?? "").split(" ").some((w) => own.has(w)),
        ),
      ),
    );
}
