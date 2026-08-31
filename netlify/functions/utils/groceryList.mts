// Shared by reminder-grocery-day.mts (email) and reminder-grocery-bring.mts
// (Bring! push) so the two channels never drift apart. Mirrors
// renderGrocery()/addIngredientsToItems() in index.html — the client-side
// version of this same logic — kept in sync by hand.

export const CATS = ["produce", "protein", "dairy", "pantry"] as const;
export const CAT_LABEL: Record<string, string> = {
  produce: "Produce",
  protein: "Protein",
  dairy: "Dairy",
  pantry: "Pantry & Grains",
};

export interface Ingredient {
  name: string;
  qty: string;
  unit: string;
  cat: string;
}
export interface AggItem {
  name: string;
  unit: string;
  cat: string;
  total: number;
  hasNumeric: boolean;
  freeform: string[];
}

export interface CustomItem {
  title: string;
  count: number;
}

export function buildGroceryList(state: any): {
  byCat: Record<string, AggItem[]>;
  customItems: CustomItem[];
  anyItems: boolean;
} {
  const findRecipe = (id: string) => state.recipes.find((r: any) => r.id === id);

  const items: Record<string, AggItem> = {};
  const customCounts: Record<string, CustomItem> = {};
  const addIngredients = (ingredients: Ingredient[], multiplier: number) => {
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
        items[key].total += n * multiplier;
      }
    });
  };

  Object.keys(state.plan || {}).forEach((key) => {
    const entry = state.plan[key];
    if (!entry) return;
    // Group by recipe first, so a meal assigned to several people is only
    // shopped for once — scaled to how many people are actually eating it,
    // not the recipe's own default serving count.
    const recipeCounts: Record<string, number> = {};
    Object.keys(entry).forEach((personId) => {
      const pe = entry[personId];
      if (!pe) return;
      if (pe.type === "recipe") {
        recipeCounts[pe.recipeId] = (recipeCounts[pe.recipeId] || 0) + 1;
      } else if (pe.type === "custom" && pe.title && pe.title.trim()) {
        const titleKey = pe.title.trim().toLowerCase();
        if (!customCounts[titleKey]) {
          customCounts[titleKey] = { title: pe.title.trim(), count: 0 };
        }
        customCounts[titleKey].count++;
      }
    });
    Object.keys(recipeCounts).forEach((recipeId) => {
      const r = findRecipe(recipeId);
      if (!r) return;
      const peopleEating = recipeCounts[recipeId];
      const multiplier = r.servings > 0 ? peopleEating / r.servings : 1;
      addIngredients(r.ingredients, multiplier);
    });
  });

  const byCat: Record<string, AggItem[]> = { produce: [], protein: [], dairy: [], pantry: [] };
  Object.values(items).forEach((it) => byCat[it.cat].push(it));
  const customItems = Object.values(customCounts).sort((a, b) => a.title.localeCompare(b.title));

  return {
    byCat,
    customItems,
    anyItems: Object.keys(items).length > 0 || customItems.length > 0,
  };
}

export function formatQty(it: AggItem): string {
  const rounded = Math.round(it.total * 100) / 100;
  return it.hasNumeric ? `${rounded}${it.unit ? " " + it.unit : ""}` : it.freeform.join(" + ");
}
