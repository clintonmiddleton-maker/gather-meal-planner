import type { Context, Config } from "@netlify/functions";

// Builds a recipe either from photos (existing flow) or from a short
// text description (new flow, for recipes you know from memory but
// have no photo of). Uses the Anthropic API — needs ANTHROPIC_API_KEY
// set in Netlify's environment variables.
//
// This only ever returns extracted/estimated data for the client to
// show in the review form — nothing is saved until confirmed there.

const MAX_IMAGES = 6;

const SCHEMA_BLOCK = `Match this exact shape:
{
  "name": string,
  "mealType": array of one or more from "breakfast" | "lunch" | "dinner" | "snack" | "treat" (most recipes need just one; only include more than one if the dish genuinely suits either, e.g. a dish that works equally as lunch or dinner),
  "dietType": one of "vegan" | "vegetarian" | "pescatarian" | "omnivore" (choose the strictest that applies — e.g. no meat/fish/dairy/egg = vegan),
  "contains": array drawn only from "dairy" | "gluten" | "nuts" | "egg" | "fish" | "spicy" — include any that visibly apply, omit ones that don't,
  "kidFriendly": boolean, your best judgement of whether this is a mild, kid-typical dish,
  "servings": number (if the card gives macros for a single portion, use 1),
  "prepMin": number (minutes),
  "cookMin": number (minutes),
  "nutrition": { "cal": number, "protein": number, "carbs": number, "fat": number, "fiber": number },
  "ingredients": array of { "name": string, "qty": string, "unit": string, "cat": one of "produce" | "protein" | "dairy" | "pantry" },
  "steps": array of strings, each one method step, rewritten in your own words rather than copied verbatim from the source
}`;

const EXTRACTION_PROMPT_PHOTOS = `You are extracting a recipe from one or more photos into a strict JSON schema for a meal-planning app. Output ONLY valid JSON — no markdown code fences, no commentary before or after.

If more than one photo is given, they are all part of the SAME recipe — likely different pages or sections of it (e.g. ingredients on one page, method on another, or a nutrition panel on a third). Combine everything across all the photos into ONE recipe object, not one output per photo.

${SCHEMA_BLOCK}

If a field isn't visible anywhere across the photos (e.g. fiber isn't listed), give your best reasonable estimate rather than leaving it blank or zero. Keep ingredient names and quantities as close to the source as you can read them.`;

const EXTRACTION_PROMPT_TEXT = `You are building a recipe entry from a short, casual description into a strict JSON schema for a meal-planning app. The description is likely just a dish name and rough ingredients, written from memory, with no quantities, macros, or method given. Output ONLY valid JSON — no markdown code fences, no commentary before or after.

${SCHEMA_BLOCK}

The description will rarely include exact quantities, macros, or method steps. Use your best reasonable judgement, based on how this dish is typically made, to fill in sensible quantities, a plausible method, and estimated nutrition — never leave a field blank or zero just because it wasn't stated. If the description names a portion (e.g. "50g biltong"), respect it exactly rather than guessing a typical serving size.`;

interface ImageInput {
  imageBase64: string;
  mediaType: string;
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY is not set in Netlify environment variables." }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  let body: { images?: ImageInput[]; description?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const images = body.images || [];
  const description = (body.description || "").trim();

  if (images.length === 0 && !description) {
    return new Response(JSON.stringify({ error: "Provide photos or a description." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  let content: any[];

  if (images.length > 0) {
    if (images.length > MAX_IMAGES) {
      return new Response(JSON.stringify({ error: `Please send ${MAX_IMAGES} photos or fewer at a time.` }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const invalidImage = images.find((img) => !img.imageBase64 || !img.mediaType);
    if (invalidImage) {
      return new Response(JSON.stringify({ error: "One of the images is missing data." }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const imageBlocks = images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.imageBase64 },
    }));
    content = [...imageBlocks, { type: "text", text: EXTRACTION_PROMPT_PHOTOS }];
  } else {
    content = [{ type: "text", text: `${EXTRACTION_PROMPT_TEXT}\n\nDescription: ${description}` }];
  }

  let anthropicRes: Response;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 2000,
        messages: [{ role: "user", content }],
      }),
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: `Could not reach the Anthropic API: ${e?.message || e}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(JSON.stringify({ error: `Anthropic API error (${anthropicRes.status}): ${errText}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  const data = await anthropicRes.json();
  const textBlock = (data?.content || []).find((b: any) => b.type === "text");
  const rawText: string = textBlock?.text || "";

  let parsed: any;
  try {
    const cleaned = rawText
      .trim()
      .replace(/^```(json)?/i, "")
      .replace(/```$/, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return new Response(
      JSON.stringify({ error: "Couldn't build a recipe from that. Try rephrasing, or enter it manually." }),
      { status: 422, headers: { "content-type": "application/json" } }
    );
  }

  return new Response(JSON.stringify(parsed), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/extract-recipe",
};
