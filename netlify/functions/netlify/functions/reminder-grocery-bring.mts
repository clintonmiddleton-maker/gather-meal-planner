import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { buildGroceryList, formatQty } from "./utils/groceryList.mts";
// bring-shopping is an unofficial, community-maintained package — Bring!
// doesn't publish a real developer API. It could break if Bring! changes
// something on their end, without notice. It's the same approach several
// established community tools use (e.g. Home Assistant's Bring integration).
import BringApi from "bring-shopping";

// Sundays at 09:00 Johannesburg time — same schedule as the grocery email.
// Adds this week's items onto an existing Bring! list (matched by name,
// set via BRING_LIST_NAME). Never removes or clears anything already on
// the list, so it's safe to run even if last week's items weren't all
// checked off yet.

export default async () => {
  const email = Netlify.env.get("BRING_EMAIL");
  const password = Netlify.env.get("BRING_PASSWORD");
  const listName = Netlify.env.get("BRING_LIST_NAME") || "Groceries";

  if (!email || !password) {
    console.error("BRING_EMAIL / BRING_PASSWORD not set — skipping Bring sync.");
    return;
  }

  const store = getStore("gather-meal-planner");
  const state: any = await store.get("state", { type: "json" });
  if (!state || !state.plan || !state.recipes) {
    console.error("No saved plan found — skipping Bring sync.");
    return;
  }

  const { byCat, anyItems } = buildGroceryList(state);
  if (!anyItems) {
    console.log("Nothing planned this week — nothing to push to Bring.");
    return;
  }

  const bring = new BringApi({ mail: email, password });
  try {
    await bring.login();
  } catch (e: any) {
    console.error("Bring login failed:", e?.message || e);
    return;
  }

  let lists: any[] = [];
  try {
    const listsResponse = await bring.loadLists();
    lists = listsResponse?.lists || [];
  } catch (e: any) {
    console.error("Failed to load Bring lists:", e?.message || e);
    return;
  }

  const target = lists.find((l: any) => l.name?.toLowerCase() === listName.toLowerCase());
  if (!target) {
    console.error(
      `No Bring list found named "${listName}". Lists available: ${lists.map((l: any) => l.name).join(", ")}`
    );
    return;
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

  console.log(`Pushed ${succeeded}/${allItems.length} items to Bring list "${listName}".`);
};

export const config: Config = {
  schedule: "0 7 * * 0",
};
