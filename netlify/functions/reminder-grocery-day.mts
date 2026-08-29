import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { sendReminderEmail } from "./utils/email.mts";

// Sundays at 09:00 Johannesburg time (SAST is UTC+2, no daylight saving).
// Reads the same saved state the app itself uses, and re-runs the exact
// same grocery aggregation the Grocery List tab does — see
// renderGrocery()/addIngredientsToItems() in index.html for the client
// version of this logic, kept in sync by hand.

const CATS = ["produce", "protein", "dairy", "pantry"] as const;
const CAT_LABEL: Record<string, string> = {
  produce: "Produce",
  protein: "Protein",
  dairy: "Dairy",
  pantry: "Pantry & Grains",
};

interface Ingredient {
  name: string;
  qty: string;
  unit: string;
  cat: string;
}
interface Recipe {
  id: string;
  ingredients: Ingredient[];
}
interface AggItem {
  name: string;
  unit: string;
  cat: string;
  total: number;
  hasNumeric: boolean;
  freeform: string[];
}

export default async () => {
  const store = getStore("gather-meal-planner");
  const state: any = await store.get("state", { type: "json" });

  if (!state || !state.plan || !state.recipes) {
    console.error("No saved plan found — skipping grocery email.");
    return;
  }

  const findRecipe = (id: string): Recipe | undefined =>
    state.recipes.find((r: Recipe) => r.id === id);

  const items: Record<string, AggItem> = {};
  const addIngredients = (ingredients: Ingredient[]) => {
    ingredients.forEach((ing) => {
      const key = `${ing.name.toLowerCase()}|${ing.unit.toLowerCase()}`;
      if (!items[key]) {
        items[key] = {
          name: ing.name,
          unit: ing.unit,
          cat: (CATS as readonly string[]).includes(ing.cat) ? ing.cat : "pantry",
          total: 0,
          hasNumeric: true,
          freeform: [],
        };
      }
      const n = parseFloat(ing.qty);
      if (isNaN(n)) {
        items[key].hasNumeric = false;
        items[key].freeform.push(`${ing.qty} ${ing.unit}`.trim());
      } else {
        items[key].total += n;
      }
    });
  };

  Object.keys(state.plan).forEach((key) => {
    const entry = state.plan[key];
    if (!entry) return;
    Object.keys(entry).forEach((personId) => {
      const pe = entry[personId];
      if (!pe || pe.type !== "recipe") return;
      const r = findRecipe(pe.recipeId);
      if (r) addIngredients(r.ingredients);
    });
  });

  const byCat: Record<string, AggItem[]> = { produce: [], protein: [], dairy: [], pantry: [] };
  Object.values(items).forEach((it) => byCat[it.cat].push(it));

  const anyItems = Object.keys(items).length > 0;
  let html = "<p>Hi there,</p><p>Here's this week's grocery list, straight from Gather:</p>";

  if (!anyItems) {
    html += "<p>Nothing's planned for this week yet — open Gather and plan the week first.</p>";
  } else {
    CATS.forEach((cat) => {
      if (byCat[cat].length === 0) return;
      html += `<h3 style="margin-bottom:4px;">${CAT_LABEL[cat]}</h3><ul style="margin-top:0;">`;
      byCat[cat]
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((it) => {
          const qty = it.hasNumeric
            ? `${it.total}${it.unit ? " " + it.unit : ""}`
            : it.freeform.join(" + ");
          html += `<li>${it.name} — ${qty}</li>`;
        });
      html += "</ul>";
    });
  }

  await sendReminderEmail({
    subject: "This week's grocery list",
    html,
  });
};

export const config: Config = {
  schedule: "0 7 * * 0",
};
