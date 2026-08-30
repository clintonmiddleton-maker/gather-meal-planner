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

export function buildGroceryList(state: any): {
  byCat: Record<string, AggItem[]>;
  anyItems: boolean;
} {
  const findRecipe = (id: string) => state.recipes.find((r: any) => r.id === id);

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

  Object.keys(state.plan || {}).forEach((key) => {
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

  return { byCat, anyItems: Object.keys(items).length > 0 };
}

export function formatQty(it: AggItem): string {
  return it.hasNumeric ? `${it.total}${it.unit ? " " + it.unit : ""}` : it.freeform.join(" + ");
}
