import { getStore } from "@netlify/blobs";
import { buildGroceryList, formatQty } from "./groceryList.mts";
// bring-shopping is an unofficial, community-maintained package — Bring!
// doesn't publish a real developer API. It could break if Bring! changes
// something on their end, without notice. It's the same approach several
// established community tools use (e.g. Home Assistant's Bring integration).
import BringApi from "bring-shopping";

// Shared by reminder-grocery-bring.mts (the Sunday 9am scheduled push) and
// sync-bring.mts (the "Sync to Bring now" button in the Grocery tab) — one
// place for the actual push logic, two ways to trigger it.
//
// Only ever adds items — never clears or removes anything already on the
// list, so it's safe to run repeatedly, whether on schedule or on demand.

export interface BringSyncResult {
  ok: boolean;
  message: string;
  pushed?: number;
  total?: number;
}

// Bring ships its own catalog of canonical item names, grouped into the
// same store-section categories the app itself uses (Fruits & Vegetables,
// Bread & Pastries, etc.) — this is what drives Bring's "automatic
// sorting" feature. Rather than push whatever name happens to be sitting
// in a recipe's ingredient list (which can be unnecessarily specific —
// "Peanut butter, 99% peanuts" rather than "Peanut Butter" — especially
// for recipes pulled in from a photo), this looks the ingredient up
// against Bring's own catalog first and, when there's a confident match,
// pushes using Bring's name instead. Falls back to the original name
// whenever nothing matches well, so nothing ever fails to push over this.
function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[(),.%]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

async function buildCatalogLookup(bring: any, locale: string): Promise<Map<string, string>> {
  const lookup = new Map<string, string>();
  try {
    const catalogResponse = await bring.loadCatalog(locale);
    const sections = catalogResponse?.catalog?.sections || [];
    for (const section of sections) {
      for (const item of section.items || []) {
        if (item?.name) lookup.set(item.name.toLowerCase(), item.name);
      }
    }
  } catch (e: any) {
    console.error("Could not load Bring's catalog — continuing with original ingredient names:", e?.message || e);
  }
  return lookup;
}

function matchCatalogName(rawName: string, lookup: Map<string, string>): string {
  const exact = lookup.get(rawName.toLowerCase().trim());
  if (exact) return exact;

  const rawWords = new Set(normalizeWords(rawName));
  let bestMatch: string | null = null;
  let bestWordCount = 0;

  for (const [catLower, catName] of lookup.entries()) {
    const catWords = normalizeWords(catLower);
    if (catWords.length === 0) continue;
    // Every word of the catalog entry has to appear as a whole word in the
    // ingredient name — e.g. "Egg" won't match inside "Eggplant", but
    // "Peanut Butter" will match "Peanut butter, 99% peanuts".
    const allWordsPresent = catWords.every((w) => rawWords.has(w));
    if (allWordsPresent && catWords.length > bestWordCount) {
      bestMatch = catName;
      bestWordCount = catWords.length;
    }
  }

  return bestMatch || rawName;
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
      return { ok: true, message: "Nothing planned this week — nothing to push to Bring.", pushed: 0, total: 0 };
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
    const catalogLookup = await buildCatalogLookup(bring, locale);

    const allItems = ([] as any[]).concat(byCat.produce, byCat.protein, byCat.dairy, byCat.pantry);
    const succeededNames: string[] = [];
    const failedNames: string[] = [];

    for (const it of allItems) {
      const pushName = matchCatalogName(it.name, catalogLookup);
      try {
        await bring.saveItem(target.listUuid, pushName, formatQty(it));
        succeededNames.push(pushName);
      } catch (e: any) {
        console.error(`Failed to add "${pushName}" to Bring:`, e?.message || e);
        failedNames.push(pushName);
      }
    }

    // Typed-in meals (e.g. "Coco pops", "Chicken burger") have no structured
    // ingredients to work from, so the meal name itself gets added as a
    // single item — a reminder of what to buy/prep rather than a precise
    // shopping quantity. Still worth matching against the catalog, in case
    // the whole typed phrase happens to line up with a known item.
    for (const it of customItems) {
      const pushName = matchCatalogName(it.title, catalogLookup);
      try {
        await bring.saveItem(target.listUuid, pushName, "");
        succeededNames.push(pushName);
      } catch (e: any) {
        console.error(`Failed to add "${pushName}" to Bring:`, e?.message || e);
        failedNames.push(pushName);
      }
    }

    const total = allItems.length + customItems.length;
    const succeeded = succeededNames.length;

    // Spell out every item name, not just a count — Bring's own automatic
    // categorisation can file a recognised item straight into a collapsed
    // category folder instead of the visible "new items" area, so this
    // list is the one place everything's guaranteed visible at a glance,
    // independent of how Bring chooses to display it.
    let message = `Pushed ${succeeded}/${total} items to Bring list "${listName}": ${succeededNames.join(", ")}.`;
    if (failedNames.length > 0) {
      message += ` Did NOT push (add these manually): ${failedNames.join(", ")}.`;
    }

    return {
      ok: failedNames.length === 0,
      message,
      pushed: succeeded,
      total,
    };
  } catch (e: any) {
    // Belt-and-braces: anything unexpected (reading saved data, building
    // the list, etc.) still comes back as a proper result instead of
    // crashing the function with no usable message for the caller.
    console.error("Unexpected error in syncGroceriesToBring:", e);
    return { ok: false, message: `Unexpected error: ${e?.message || e}` };
  }
}
