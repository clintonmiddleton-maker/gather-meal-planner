import { getStore } from "@netlify/blobs";
import { buildGroceryList } from "./groceryList.mts";
import type { AggItem, CustomItem } from "./groceryList.mts";
// bring-shopping is an unofficial, community-maintained package. Bring!
// doesn't publish a real developer API, so this could break if Bring!
// changes something on their end, without notice. It's the same approach
// several established community tools use (e.g. Home Assistant's Bring
// integration).
import BringApi from "bring-shopping";

// Shared by reminder-grocery-bring.mts (the Sunday 9am scheduled push) and
// sync-bring.mts (the "Sync to Bring now" button in the Grocery tab): one
// place for the actual push logic, two ways to trigger it.
//
// Only ever adds items. It never clears or removes anything already on
// the list, so it's safe to run repeatedly, whether on schedule or on
// demand.
//
// HOW ITEMS GET MATCHED TO BRING'S OWN CATALOG
// Bring has a built-in catalog of standard items (with pictures and store
// sections). Each catalog item has two fields: a display name in your
// language (e.g. "Milk") and an internal key called itemId (the German
// name, e.g. "Milch"). Bring only treats an item as a catalog item, with
// its picture and section, when it's sent the itemId. Send the plain
// display name and Bring files it as typed-in text instead (a plain
// letter tile, no section). So this looks each ingredient up in the
// catalog and sends the itemId when it finds a confident match.

export interface BringSyncResult {
  ok: boolean;
  message: string;
  pushed?: number;
  total?: number;
}

export interface CatalogEntry {
  itemId: string;
  name: string;
}
export interface IndexedEntry extends CatalogEntry {
  words: string[];
}
export interface CatalogMatch {
  entry: IndexedEntry;
  leftover: string;
}
export interface PlannedPush {
  key: string;
  pushName: string; // what gets sent to Bring (itemId when matched)
  displayName: string; // what a person would call it
  matched: boolean;
  spec: string;
  sources: string[]; // the original ingredient names folded into this item
}

/* ------------------------------------------------------------------ */
/* Cleaning ingredient names                                            */
/* ------------------------------------------------------------------ */

// Recipe data (especially anything pulled in from a photo) can have
// quantity text stuck on the front of the name, like "g wholewheat roll",
// "ml Soy sauce" or "(1 pc) Banana". These are stripped off the front.
const UNIT_TOKENS = new Set([
  "g", "kg", "mg", "ml", "l", "cl", "dl", "pc", "pcs", "piece", "pieces",
  "pinch", "dash", "tbsp", "tsp", "cup", "cups", "second", "scoop", "scoops",
  "can", "cans", "slice", "slices", "spray", "sprays", "unit", "units",
]);

// Preparation / state words that describe how something is cooked or cut,
// not what it is, so they don't help (and can confuse) a catalog match.
const PREP_WORDS = new Set([
  "cooked", "uncooked", "raw", "pressed", "chopped", "minced", "sliced",
  "diced", "crushed", "grated", "pasteurised", "pasteurized", "tinned",
  "canned", "fillet", "fillets", "pieces", "chunks", "cubes", "clove", "cloves",
]);

// "Almond milk" is not "Milk" and "Peanut butter" is not "Butter". If a
// plant or nut word is left over after matching a dairy-type item, the
// match is dropped so the full name goes on the list as typed text.
const NOT_DAIRY_WORDS = new Set([
  "almond", "soy", "soya", "oat", "coconut", "cashew", "hazelnut", "plant",
  "vegan", "peanut", "nut",
]);
const DAIRY_HEADS = new Set(["milk", "yoghurt", "yogurt", "butter", "cheese", "cream"]);

const LEFTOVER_IGNORE = new Set([
  "a", "the", "of", "with", "in", "any", "type", "large", "small", "mini",
  "extra", "thin", "original", "plain",
]);

const lettersOnly = (t: string) => t.toLowerCase().replace(/[^\p{L}]/gu, "");

export function cleanName(raw: string): string {
  const original = (raw || "").trim();
  let s = original
    .replace(/\([^)]*\)/g, " ")
    .replace(/[()]/g, " ")
    .replace(/\bfree[- ]range\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Everything after the first comma is usually a descriptor
  // ("Tuna, in water, tinned", "Brown rice, uncooked").
  const comma = s.indexOf(",");
  if (comma > 0) s = s.slice(0, comma);

  let tokens = s.split(" ").filter(Boolean);
  const isNumeric = (t: string) => /^[\d.\/~\-]+$/.test(t);
  while (tokens.length > 1 && (isNumeric(tokens[0]) || UNIT_TOKENS.has(lettersOnly(tokens[0])))) {
    tokens.shift();
  }
  const kept = tokens.filter((t) => !PREP_WORDS.has(lettersOnly(t)));
  if (kept.length > 0) tokens = kept; // never strip a name down to nothing

  s = tokens.join(" ").replace(/^[\s\-,;:]+|[\s\-,;:]+$/g, "");
  if (!s) return original;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ------------------------------------------------------------------ */
/* Matching against Bring's catalog                                     */
/* ------------------------------------------------------------------ */

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

// Light singular/plural folding, applied to both sides so
// "tomatoes" lines up with "tomato" and "eggs" with "egg".
export function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("oes")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}

const stemmedWords = (s: string): string[] => tokenize(s).map(stem);

export function buildIndex(sections: any[]): IndexedEntry[] {
  const out: IndexedEntry[] = [];
  const seen = new Set<string>();
  for (const section of sections || []) {
    for (const item of section?.items || []) {
      if (!item?.itemId || !item?.name || seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      out.push({ itemId: item.itemId, name: item.name, words: stemmedWords(item.name) });
    }
  }
  return out;
}

function matchOne(segment: string, index: IndexedEntry[]): CatalogMatch | null {
  const rawTokens = tokenize(segment);
  const stemmed = rawTokens.map(stem);
  if (stemmed.length === 0) return null;
  const present = new Set(stemmed);
  const head = stemmed[stemmed.length - 1]; // "chicken breast" -> breast
  const phrase = stemmed.join(" ");

  let best: IndexedEntry | null = null;
  let bestScore = -1;
  for (const entry of index) {
    if (entry.words.length === 0) continue;
    // Every word of the catalog name has to appear as a whole word, so
    // "Egg" can't match inside "Eggplant".
    if (!entry.words.every((w) => present.has(w))) continue;
    // A one-word catalog entry only counts if it's the main noun, so
    // "Frozen chicken burger patty" doesn't get filed under "Chicken".
    if (entry.words.length === 1 && stemmed.length > 1 && entry.words[0] !== head) continue;

    const exact = entry.words.join(" ") === phrase ? 1 : 0;
    const score = exact * 1000 + entry.words.length * 10 + (entry.words.includes(head) ? 1 : 0);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  if (!best) return null;

  const covered = new Set(best.words);
  const leftoverTokens = rawTokens.filter((t, i) => !covered.has(stemmed[i]) && !LEFTOVER_IGNORE.has(t));
  if (DAIRY_HEADS.has(head) && leftoverTokens.some((t) => NOT_DAIRY_WORDS.has(stem(t)))) return null;
  return { entry: best, leftover: leftoverTokens.join(" ") };
}

export function matchCatalog(cleaned: string, index: IndexedEntry[]): CatalogMatch | null {
  if (index.length === 0) return null;
  // "Salt and pepper" is two things, not one, so it's left as typed text.
  if (/\s(and|&|\+)\s/i.test(cleaned)) return null;
  // "Hummus/Houmous", "Tomato sauce or mayo": try each option in order.
  const alternatives = cleaned
    .split(/\s+or\s+|\//i)
    .map((a) => a.trim())
    .filter(Boolean);
  for (const alt of alternatives) {
    const m = matchOne(alt, index);
    if (m) return m;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Combining variants into one Bring item                               */
/* ------------------------------------------------------------------ */

export function mergeQuantity(parts: AggItem[]): string {
  const sums = new Map<string, { unit: string; total: number }>();
  const freeform: string[] = [];
  for (const p of parts) {
    const unit = (p.unit || "").trim();
    const key = unit.toLowerCase();
    if (p.total > 0) {
      const cur = sums.get(key) || { unit, total: 0 };
      cur.total += p.total;
      sums.set(key, cur);
    }
    for (const f of p.freeform) {
      const t = f.trim();
      if (t && !freeform.includes(t)) freeform.push(t);
    }
  }
  const numeric = [...sums.values()].map(
    (s) => `${Math.round(s.total * 100) / 100}${s.unit ? " " + s.unit : ""}`
  );
  return [...numeric, ...freeform].join(" + ");
}

export function planPushes(allItems: AggItem[], customItems: CustomItem[], index: IndexedEntry[]): PlannedPush[] {
  interface Group {
    push: PlannedPush;
    parts: AggItem[];
    leftovers: Set<string>;
  }
  const groups = new Map<string, Group>();

  const add = (rawName: string, part: AggItem | null) => {
    const cleaned = cleanName(rawName);
    if (!cleaned) return;
    const m = matchCatalog(cleaned, index);
    const key = m ? "id:" + m.entry.itemId : "txt:" + stemmedWords(cleaned).join(" ");
    let g = groups.get(key);
    if (!g) {
      g = {
        push: {
          key,
          pushName: m ? m.entry.itemId : cleaned,
          displayName: m ? m.entry.name : cleaned,
          matched: !!m,
          spec: "",
          sources: [],
        },
        parts: [],
        leftovers: new Set(),
      };
      groups.set(key, g);
    }
    if (!g.push.sources.includes(rawName)) g.push.sources.push(rawName);
    if (part) g.parts.push(part);
    if (m && m.leftover) g.leftovers.add(m.leftover.toLowerCase());
  };

  allItems.forEach((it) => add(it.name, it));
  // Typed-in meals (e.g. "Coco pops", "Chicken burger") have no structured
  // ingredients, so the meal name itself goes on the list as a reminder.
  customItems.forEach((c) => add(c.title, null));

  const out: PlannedPush[] = [];
  for (const g of groups.values()) {
    const qty = mergeQuantity(g.parts);
    const extra = [...g.leftovers].join(", ");
    let spec = [qty, extra ? `(${extra})` : ""].filter(Boolean).join(" ");
    if (spec.length > 80) spec = spec.slice(0, 77) + "...";
    g.push.spec = spec;
    out.push(g.push);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Talking to Bring                                                     */
/* ------------------------------------------------------------------ */

async function buildCatalogIndex(bring: any, locale: string): Promise<IndexedEntry[]> {
  try {
    const response = await bring.loadCatalog(locale);
    return buildIndex(response?.catalog?.sections || []);
  } catch (e: any) {
    console.error("Could not load Bring's catalog:", e?.message || e);
    return [];
  }
}

// The bring-shopping package's own saveItem pastes names and quantities
// straight into the request without encoding them (so "+", "&" and "%"
// get mangled) and never checks whether Bring accepted the item, so it
// can report success when nothing was added. This does the same request
// properly: encoded, and it throws if Bring says no.
export async function saveItemChecked(bring: any, listUuid: string, name: string, spec: string): Promise<void> {
  if (!bring.putHeaders || !bring.url) {
    await bring.saveItem(listUuid, name, spec);
    return;
  }
  const body = new URLSearchParams({
    purchase: name,
    recently: "",
    specification: spec,
    remove: "",
    sender: "null",
  }).toString();
  const resp = await fetch(`${bring.url}bringlists/${listUuid}`, {
    method: "PUT",
    headers: bring.putHeaders,
    body,
  });
  if (!resp.ok) throw new Error(`Bring answered ${resp.status}`);
}

async function saveWithRetry(bring: any, listUuid: string, name: string, spec: string): Promise<void> {
  try {
    await saveItemChecked(bring, listUuid, name, spec);
  } catch (first: any) {
    await new Promise((r) => setTimeout(r, 400));
    await saveItemChecked(bring, listUuid, name, spec); // second failure propagates
  }
}

async function runInBatches<T>(items: T[], size: number, worker: (item: T, i: number) => Promise<void>) {
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

const sameName = (a: string, b: string) => stemmedWords(a).join(" ") === stemmedWords(b).join(" ");

export async function pushToBring(
  bring: any,
  listUuid: string,
  listName: string,
  allItems: AggItem[],
  customItems: CustomItem[],
  index: IndexedEntry[]
): Promise<BringSyncResult> {
  const plan = planPushes(allItems, customItems, index);

  const results: { push: PlannedPush; ok: boolean }[] = plan.map((push) => ({ push, ok: false }));
  await runInBatches(plan, 5, async (push, i) => {
    try {
      await saveWithRetry(bring, listUuid, push.pushName, push.spec);
      results[i].ok = true;
    } catch (e: any) {
      console.error(`Failed to add "${push.displayName}" to Bring:`, e?.message || e);
    }
  });

  const pushedOk = results.filter((r) => r.ok).map((r) => r.push);
  const failed = results.filter((r) => !r.ok).map((r) => r.push);
  const matched = pushedOk.filter((p) => p.matched);
  const plain = pushedOk.filter((p) => !p.matched);

  const folded: string[] = [];
  for (const p of matched) {
    for (const src of p.sources) {
      if (!sameName(src, p.displayName)) folded.push(`"${src}" as ${p.displayName}`);
    }
  }

  const parts: string[] = [];
  if (index.length === 0) {
    parts.push("WARNING: Bring's catalog could not be loaded, so every item went in as plain text (no pictures, no sections).");
  }
  parts.push(
    `Pushed ${pushedOk.length}/${plan.length} items to Bring list "${listName}" (combined from ${allItems.length + customItems.length} recipe ingredients and typed-in meals).`
  );
  if (matched.length > 0) {
    parts.push(`Matched to Bring's catalog (should show a picture): ${matched.map((p) => p.displayName).join(", ")}.`);
  }
  if (plain.length > 0) {
    parts.push(`No catalog match, added as plain text: ${plain.map((p) => p.displayName).join(", ")}.`);
  }
  if (folded.length > 0) {
    const shown = folded.slice(0, 25).join("; ");
    parts.push(`Renamed or combined: ${shown}${folded.length > 25 ? "; and more" : ""}.`);
  }
  if (failed.length > 0) {
    parts.push(`Did NOT push (add these manually): ${failed.map((p) => p.displayName).join(", ")}.`);
  }

  return {
    ok: failed.length === 0,
    message: parts.join(" "),
    pushed: pushedOk.length,
    total: plan.length,
  };
}

export async function syncGroceriesToBring(): Promise<BringSyncResult> {
  try {
    const email = Netlify.env.get("BRING_EMAIL");
    const password = Netlify.env.get("BRING_PASSWORD");
    const listName = Netlify.env.get("BRING_LIST_NAME") || "Groceries";

    if (!email || !password) {
      return { ok: false, message: "BRING_EMAIL / BRING_PASSWORD are not set in Netlify's environment variables." };
    }

    const store = getStore("gather-meal-planner");
    const state: any = await store.get("state", { type: "json" });
    if (!state || !state.plan || !state.recipes) {
      return { ok: false, message: "No saved plan found." };
    }

    const { byCat, customItems, anyItems } = buildGroceryList(state);
    if (!anyItems) {
      return { ok: true, message: "Nothing planned this week, so nothing to push to Bring.", pushed: 0, total: 0 };
    }

    const bring = new BringApi({ mail: email, password });
    try {
      await bring.login();
    } catch (e: any) {
      return { ok: false, message: `Bring login failed: ${e?.message || e}` };
    }

    let lists: any[] = [];
    try {
      const listsResponse = await bring.loadLists();
      lists = listsResponse?.lists || [];
    } catch (e: any) {
      return { ok: false, message: `Failed to load Bring lists: ${e?.message || e}` };
    }

    const target = lists.find((l: any) => l.name?.toLowerCase() === listName.toLowerCase());
    if (!target) {
      return {
        ok: false,
        message: `No Bring list found named "${listName}". Lists available: ${lists.map((l: any) => l.name).join(", ")}`,
      };
    }

    const locale = Netlify.env.get("BRING_LOCALE") || "en-GB";
    const index = await buildCatalogIndex(bring, locale);

    const allItems = ([] as AggItem[]).concat(byCat.produce, byCat.protein, byCat.dairy, byCat.pantry);
    return await pushToBring(bring, target.listUuid, listName, allItems, customItems, index);
  } catch (e: any) {
    // Anything unexpected (reading saved data, building the list, etc.)
    // still comes back as a proper result instead of crashing the
    // function with no usable message for the caller.
    console.error("Unexpected error in syncGroceriesToBring:", e);
    return { ok: false, message: `Unexpected error: ${e?.message || e}` };
  }
}
