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

export async function syncGroceriesToBring(): Promise<BringSyncResult> {
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

  const allItems = ([] as any[]).concat(byCat.produce, byCat.protein, byCat.dairy, byCat.pantry);
  let succeeded = 0;
  for (const it of allItems) {
    try {
      await bring.saveItem(target.listUuid, it.name, formatQty(it));
      succeeded++;
    } catch (e: any) {
      console.error(`Failed to add "${it.name}" to Bring:`, e?.message || e);
    }
  }

  // Typed-in meals (e.g. "Coco pops", "Chicken burger") have no structured
  // ingredients to work from, so the meal name itself gets added as a
  // single item — a reminder of what to buy/prep rather than a precise
  // shopping quantity.
  for (const it of customItems) {
    try {
      await bring.saveItem(target.listUuid, it.title, "");
      succeeded++;
    } catch (e: any) {
      console.error(`Failed to add "${it.title}" to Bring:`, e?.message || e);
    }
  }

  const total = allItems.length + customItems.length;
  return {
    ok: true,
    message: `Pushed ${succeeded}/${total} items to Bring list "${listName}".`,
    pushed: succeeded,
    total,
  };
}
