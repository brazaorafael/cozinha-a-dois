/**
 * Cozinha Worker v2
 *
 * Segredos no painel Cloudflare:
 *   GEMINI_API_KEY, GITHUB_TOKEN, PEXELS_KEY (opcional)
 *
 * Variáveis comuns:
 *   REPO="usuario/cozinha-a-dois"
 *   ALLOWED_ORIGINS="https://usuario.github.io,http://localhost:8000"
 *   ALLOWED_RECIPE_HOSTS="panelinha.com.br,receitas.globo.com,tudogostoso.com.br"
 *   GEMINI_MODEL="gemini-2.5-flash"
 */

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_RECIPE_HOSTS = [
  "panelinha.com.br",
  "receitas.globo.com",
  "tudogostoso.com.br",
];
const SEARCH_TTL_SECONDS = 60 * 60 * 12;
const PENDING_TTL_SECONDS = 60;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const PROFILE = [
  "Casal jovem, jantar para 2, com sobra para o almoço de 1 quando fizer sentido.",
  "Prioridade em proteína; carne vermelha é a preferida; peixe no máximo 1x por semana.",
  "Pouca fritura. Preferir forno, grelha, airfryer ou refogado.",
  "Receitas práticas, com ingredientes acessíveis no Brasil e até cerca de 45 minutos.",
].join(" ");

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET") return respond({ ok: true, servico: "cozinha-a-dois-worker", versao: 2 }, 200, cors);
    if (request.method !== "POST") return respond({ error: "metodo_nao_permitido" }, 405, cors);
    if (!originAllowed(request, env)) return respond({ error: "origem_nao_permitida" }, 403, cors);

    const length = Number(request.headers.get("content-length") || 0);
    if (length > MAX_BODY_BYTES) return respond({ error: "pedido_muito_grande" }, 413, cors);

    let body;
    try {
      body = await request.json();
    } catch {
      return respond({ error: "json_invalido" }, 400, cors);
    }

    try {
      switch (body.action || "voto") {
        case "voto":
          return respond(await handleVote(body, env), 200, cors);
        case "buscar":
        case "com_ingredientes":
          return handleSearch(body, env, ctx, cors);
        case "buscar_status":
          return respond(await readSearchJob(body.job_id), 200, cors);
        case "imagem":
          return respond(await handleImage(body, env), 200, cors);
        case "foto":
          return respond(await handlePhoto(body, env), 200, cors);
        case "consolidar":
          return respond(await handleConsolidate(body, env), 200, cors);
        case "acompanhar":
          return respond(await handleSides(body, env), 200, cors);
        default:
          return respond({ error: "acao_desconhecida" }, 400, cors);
      }
    } catch (error) {
      console.error("cozinha_worker_error", {
        action: body.action,
        message: String(error?.message || error),
      });
      return respond({ error: "falha_temporaria", detalhe: safeError(error) }, 502, cors);
    }
  },
};

function respond(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = allowedOrigins(env);
  const reflected = !origin || allowed.includes("*") || allowed.includes(origin) ? origin || "*" : "null";
  return {
    "Access-Control-Allow-Origin": reflected,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function originAllowed(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const allowed = allowedOrigins(env);
  return allowed.includes("*") || allowed.includes(origin.replace(/\/+$/, ""));
}

function requireSecret(env, key) {
  if (!env[key]) throw new Error(`${key} ausente`);
}

async function handleVote(body, env) {
  requireSecret(env, "GITHUB_TOKEN");
  const repo = String(env.REPO || "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("REPO inválido");
  if (!["like", "dislike", "remove"].includes(body.voto)) throw new Error("voto inválido");
  if (!body.receita?.id) throw new Error("receita sem id");

  const response = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "cozinha-app-worker-v2",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      event_type: "gosto",
      client_payload: {
        voto: body.voto,
        event_id: String(body.event_id || crypto.randomUUID()),
        receita: sanitizeRecipe(body.receita),
      },
    }),
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}`);
  return { ok: true };
}

async function handleSearch(body, env, ctx, cors) {
  requireSecret(env, "GEMINI_API_KEY");
  const action = body.action;
  const query = action === "com_ingredientes"
    ? (Array.isArray(body.ingredientes) ? body.ingredientes.join(", ") : String(body.texto || ""))
    : String(body.texto || "");
  const clean = query.trim().slice(0, 300);
  if (!clean) return respond({ pratos: [], status: "done" }, 200, cors);

  const jobId = await hashText(`${action}:${normalize(clean)}`);
  const ready = await readSearchJob(jobId);
  if (ready.status === "done") return respond(ready, 200, cors);
  if (ready.status === "processing") return respond(ready, 202, cors);

  await writeSearchJob(jobId, { status: "processing", job_id: jobId, started_at: Date.now() }, PENDING_TTL_SECONDS);
  ctx.waitUntil(
    runVerifiedSearch(action, clean, env)
      .then((pratos) => writeSearchJob(jobId, { status: "done", job_id: jobId, pratos }, SEARCH_TTL_SECONDS))
      .catch(async (error) => {
        console.error("search_background_error", { jobId, message: safeError(error) });
        await writeSearchJob(jobId, {
          status: "done",
          job_id: jobId,
          pratos: [],
          aviso: "A busca não encontrou fontes verificáveis.",
        }, 300);
      }),
  );
  return respond({ status: "processing", job_id: jobId }, 202, cors);
}

async function runVerifiedSearch(action, query, env) {
  const sourceInstruction = allowedRecipeHosts(env).map((host) => `site:${host}`).join(" OR ");
  const task = action === "com_ingredientes"
    ? `Crie opções usando principalmente estes ingredientes: ${query}.`
    : `Encontre receitas para este pedido: ${query}.`;
  const prompt = `
Você é um pesquisador de receitas para um casal brasileiro.
${PROFILE}
${task}
Pesquise agora, priorizando exclusivamente estas fontes: ${sourceInstruction}.
Retorne de 2 a 5 candidatos. A URL precisa ser a página direta da receita, nunca uma busca,
home, categoria, vídeo ou URL inventada. Não copie o texto da fonte.
Para cada candidato, retorne:
{
  "nome": string,
  "curso": "principal" | "entrada" | "sobremesa",
  "tempo": string,
  "url": string,
  "porque": string,
  "tags": string[],
  "rende_sobra": boolean,
  "ingredientes": string[],
  "preparo": string[]
}
`.trim();

  const raw = await geminiJson(env, prompt, true);
  const candidates = asRecipeArray(raw).slice(0, 5);
  const checked = await Promise.all(candidates.map((candidate) => enrichRecipe(candidate, env)));
  return checked
    .filter((recipe) => recipe)
    .sort((a, b) => sourceRank(b) - sourceRank(a))
    .slice(0, 4);
}

async function readSearchJob(jobId) {
  if (!jobId) return { status: "missing", pratos: [] };
  const response = await caches.default.match(searchCacheRequest(jobId));
  if (!response) return { status: "missing", pratos: [] };
  try {
    return await response.json();
  } catch {
    return { status: "missing", pratos: [] };
  }
}

async function writeSearchJob(jobId, payload, ttl) {
  const response = new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttl}`,
    },
  });
  await caches.default.put(searchCacheRequest(jobId), response);
}

function searchCacheRequest(jobId) {
  return new Request(`https://cozinha-cache.invalid/search/${encodeURIComponent(jobId)}`);
}

async function handleImage(body, env) {
  const name = String(body.consulta || body.nome || "").trim().slice(0, 160);
  const pageUrl = String(body.url || "").trim();
  let source = null;
  if (name && pageUrl) {
    const verified = await verifyRecipePage(name, pageUrl, env);
    if (verified?.image) {
      source = {
        url: verified.image,
        kind: "source",
        alt: name,
        source_url: verified.url,
      };
    }
  }
  if (source) return { imagem: source };
  const bank = await pexelsImage(name, body.excluir_ids || [], env);
  return { imagem: bank || { kind: "none", url: "", alt: name } };
}

async function handlePhoto(body, env) {
  requireSecret(env, "GEMINI_API_KEY");
  if (!body.imagem || String(body.imagem).length > 10_500_000) throw new Error("imagem ausente ou grande demais");
  const prompt = [
    "Leia esta imagem como uma receita ou lista de ingredientes.",
    "Retorne somente um array JSON de strings.",
    "Mantenha as quantidades visíveis. Não invente itens ilegíveis.",
    'Exemplo: ["2 cebolas", "500 g de carne"].',
  ].join(" ");
  const result = await geminiJson(env, prompt, false, [{
    inline_data: {
      mime_type: safeMime(body.mime),
      data: body.imagem,
    },
  }]);
  return { ingredientes: Array.isArray(result) ? result.slice(0, 100).map(String) : [] };
}

async function handleConsolidate(body, env) {
  requireSecret(env, "GEMINI_API_KEY");
  const ingredients = Array.isArray(body.ingredientes)
    ? body.ingredientes.map(String).filter(Boolean).slice(0, 500)
    : [];
  if (!ingredients.length) return { lista: {} };
  const prompt = `
Consolide estes ingredientes numa lista de compras em português do Brasil.
- Agrupe nomes equivalentes e some apenas quantidades com unidades compatíveis.
- Para itens contáveis, arredonde a soma para cima.
- Não some "a gosto" com números.
- Categorias permitidas: Proteínas; Hortifruti; Laticínios e ovos; Mercearia; Padaria; Outros.
- Retorne apenas um objeto JSON: { "Categoria": ["quantidade item"] }.

INGREDIENTES:
${ingredients.map((item) => `- ${item}`).join("\n")}
`.trim();
  const result = await geminiJson(env, prompt, false);
  return { lista: result && typeof result === "object" && !Array.isArray(result) ? result : {} };
}

async function handleSides(body, env) {
  requireSecret(env, "GEMINI_API_KEY");
  const dish = String(body.prato || "").trim().slice(0, 180);
  if (!dish) return { acompanhamentos: [] };
  const prompt = `
Para "${dish}", sugira de 2 a 4 acompanhamentos simples que equilibrem o jantar.
${PROFILE}
Retorne apenas um array JSON de objetos { "nome": string, "dica": string }.
`.trim();
  const result = await geminiJson(env, prompt, false);
  return { acompanhamentos: Array.isArray(result) ? result.slice(0, 4) : [] };
}

async function geminiJson(env, prompt, useSearch, extraParts = []) {
  requireSecret(env, "GEMINI_API_KEY");
  const model = String(env.GEMINI_MODEL || DEFAULT_MODEL);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
  const body = {
    contents: [{ parts: [{ text: prompt }, ...extraParts] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: useSearch ? 0.25 : 0.15,
    },
  };
  if (useSearch) body.tools = [{ google_search: {} }];

  let response = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 16_000);
  if (!response.ok && response.status === 400 && body.generationConfig?.responseMimeType) {
    const fallbackBody = structuredClone(body);
    delete fallbackBody.generationConfig.responseMimeType;
    response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fallbackBody),
    }, 16_000);
  }
  if (!response.ok) throw new Error(`Gemini ${response.status}`);
  const payload = await response.json();
  const text = (payload?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text)
    .filter(Boolean)
    .join("");
  return parseJson(text);
}

async function enrichRecipe(raw, env) {
  const recipe = sanitizeRecipe(raw);
  if (!recipe.nome) return null;
  const verified = await verifyRecipePage(recipe.nome, raw.url, env);
  if (verified) {
    recipe.fonte = {
      status: "verified",
      url: verified.url,
      title: verified.title,
      domain: verified.domain,
      checked_at: new Date().toISOString(),
      confidence: verified.confidence,
    };
    recipe.imagem = verified.image
      ? { kind: "source", url: verified.image, alt: recipe.nome }
      : { kind: "none", url: "", alt: recipe.nome };
    recipe.tempo ||= verified.totalTime || "";
    recipe.ingredientes = recipe.ingredientes.length ? recipe.ingredientes : verified.ingredients;
    recipe.preparo = recipe.preparo.length ? recipe.preparo : verified.instructions;
  } else {
    recipe.fonte = {
      status: "unverified",
      url: "",
      suggested_url: safePublicUrl(raw.url, env) || "",
      checked_at: new Date().toISOString(),
    };
    const bank = await pexelsImage(recipe.nome, [], env);
    recipe.imagem = bank || { kind: "none", url: "", alt: recipe.nome };
  }
  recipe.id = stableRecipeId(recipe);
  return recipe;
}

async function verifyRecipePage(name, rawUrl, env) {
  const url = safePublicUrl(rawUrl, env);
  if (!url) return null;

  let response;
  try {
    response = await fetchWithTimeout(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CozinhaRecipeVerifier/2.0)",
        "Accept": "text/html,application/xhtml+xml",
      },
    }, 5500);
  } catch {
    return null;
  }

  if (!response.ok) return null;
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return null;
  const length = Number(response.headers.get("content-length") || 0);
  if (length > 2_000_000) return null;
  const html = (await response.text()).slice(0, 2_000_000);
  const recipeSchema = extractRecipeSchema(html);
  const title = decodeHtml(
    recipeSchema?.name
      || metaContent(html, "og:title")
      || firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)
      || "",
  );
  const similarity = titleSimilarity(name, title);
  const hasRecipeEvidence = Boolean(
    recipeSchema
    || /itemtype=["'][^"']*schema\.org\/Recipe/i.test(html)
    || /ingredientes|modo de preparo|ingredients|instructions/i.test(html),
  );
  if (similarity < 0.42 || !hasRecipeEvidence) return null;

  const finalUrl = response.url || url;
  const canonicalRaw = firstMatch(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || firstMatch(html, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  const canonical = resolveUrl(canonicalRaw, finalUrl) || finalUrl;
  if (!safePublicUrl(canonical, env)) return null;

  const schemaImage = Array.isArray(recipeSchema?.image)
    ? recipeSchema.image[0]
    : typeof recipeSchema?.image === "object"
      ? recipeSchema.image.url
      : recipeSchema?.image;
  const imageRaw = schemaImage || metaContent(html, "og:image") || metaContent(html, "twitter:image");
  const image = safeImageUrl(resolveUrl(imageRaw, finalUrl));

  return {
    url: canonical,
    title: cleanText(title).slice(0, 220),
    domain: new URL(canonical).hostname.replace(/^www\./, ""),
    confidence: Number(similarity.toFixed(2)),
    image,
    totalTime: String(recipeSchema?.totalTime || ""),
    ingredients: Array.isArray(recipeSchema?.recipeIngredient) ? recipeSchema.recipeIngredient.map(String).slice(0, 60) : [],
    instructions: schemaInstructions(recipeSchema?.recipeInstructions),
  };
}

function extractRecipeSchema(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of blocks.slice(0, 20)) {
    try {
      const data = JSON.parse(decodeHtml(match[1].trim()));
      const recipes = flattenLd(data).filter((item) => {
        const types = Array.isArray(item?.["@type"]) ? item["@type"] : [item?.["@type"]];
        return types.some((type) => String(type).toLowerCase() === "recipe");
      });
      if (recipes[0]) return recipes[0];
    } catch {
      // Páginas com JSON-LD inválido ainda podem ser validadas pelos metadados.
    }
  }
  return null;
}

function flattenLd(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenLd);
  if (typeof value !== "object") return [];
  return [value, ...flattenLd(value["@graph"] || [])];
}

function schemaInstructions(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((step) => {
    if (typeof step === "string") return [cleanText(step)];
    if (Array.isArray(step?.itemListElement)) return schemaInstructions(step.itemListElement);
    return step?.text ? [cleanText(step.text)] : [];
  }).filter(Boolean).slice(0, 20);
}

async function pexelsImage(query, excludedIds, env) {
  if (!env.PEXELS_KEY || !query || String(env.ENABLE_PEXELS_FALLBACK || "false").toLowerCase() !== "true") return null;
  const excluded = new Set((excludedIds || []).map(String));
  const endpoint = `https://api.pexels.com/v1/search?per_page=12&orientation=landscape&locale=pt-BR&query=${encodeURIComponent(`${query} comida prato`)}`;
  try {
    const response = await fetchWithTimeout(endpoint, {
      headers: { "Authorization": env.PEXELS_KEY },
    }, 4500);
    if (!response.ok) return null;
    const payload = await response.json();
    const terms = usefulTokens(query);
    const scored = (payload.photos || [])
      .filter((photo) => !excluded.has(String(photo.id)))
      .map((photo) => {
        const alt = normalize(photo.alt || "");
        const score = terms.filter((term) => alt.includes(term)).length;
        return { photo, score };
      })
      .sort((a, b) => b.score - a.score);
    const best = scored.find(({ score }) => score > 0)?.photo;
    if (!best) return null;
    return {
      kind: "bank",
      url: best.src?.large || best.src?.medium || "",
      alt: best.alt || query,
      bank_id: String(best.id),
      credit: best.photographer || "Pexels",
    };
  } catch {
    return null;
  }
}

function sanitizeRecipe(raw) {
  const recipe = raw && typeof raw === "object" ? raw : {};
  return {
    id: String(recipe.id || "").slice(0, 120),
    nome: cleanText(recipe.nome || recipe.titulo || "").slice(0, 180),
    curso: ["principal", "entrada", "sobremesa"].includes(String(recipe.curso).toLowerCase())
      ? String(recipe.curso).toLowerCase()
      : "principal",
    tempo: cleanText(recipe.tempo || "").slice(0, 40),
    porque: cleanText(recipe.porque || "").slice(0, 400),
    tags: Array.isArray(recipe.tags) ? recipe.tags.map((tag) => normalize(tag).replace(/\s+/g, "_")).filter(Boolean).slice(0, 8) : [],
    rende_sobra: Boolean(recipe.rende_sobra),
    ingredientes: Array.isArray(recipe.ingredientes) ? recipe.ingredientes.map((item) => cleanText(item).slice(0, 240)).filter(Boolean).slice(0, 80) : [],
    preparo: Array.isArray(recipe.preparo) ? recipe.preparo.map((step) => cleanText(step).slice(0, 600)).filter(Boolean).slice(0, 20) : [],
    fonte: recipe.fonte && typeof recipe.fonte === "object"
      ? {
          status: recipe.fonte.status === "verified" ? "verified" : "unverified",
          url: safeLooseHttpUrl(recipe.fonte.url),
          title: cleanText(recipe.fonte.title || "").slice(0, 220),
          domain: cleanText(recipe.fonte.domain || "").slice(0, 120),
          checked_at: cleanText(recipe.fonte.checked_at || "").slice(0, 80),
        }
      : undefined,
    imagem: recipe.imagem && typeof recipe.imagem === "object"
      ? {
          kind: ["source", "bank"].includes(recipe.imagem.kind) ? recipe.imagem.kind : "none",
          url: safeLooseHttpUrl(recipe.imagem.url),
          alt: cleanText(recipe.imagem.alt || "").slice(0, 220),
          credit: cleanText(recipe.imagem.credit || "").slice(0, 160),
        }
      : undefined,
  };
}

function safeLooseHttpUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function asRecipeArray(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.pratos)) return value.pratos;
  if (Array.isArray(value?.recipes)) return value.recipes;
  return [];
}

function safePublicUrl(raw, env) {
  try {
    const url = new URL(String(raw || ""));
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!allowedRecipeHosts(env).some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeImageUrl(raw) {
  try {
    const url = new URL(String(raw || ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function allowedRecipeHosts(env) {
  const configured = String(env.ALLOWED_RECIPE_HOSTS || "")
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/^www\./, ""))
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_RECIPE_HOSTS;
}

function titleSimilarity(name, title) {
  const a = usefulTokens(name);
  const b = new Set(usefulTokens(title));
  if (!a.length || !b.size) return 0;
  const matches = a.filter((token) => b.has(token)).length;
  const coverage = matches / a.length;
  const minimumMatchBonus = matches >= Math.min(2, a.length) ? 0.16 : 0;
  return Math.min(1, coverage * 0.84 + minimumMatchBonus);
}

function usefulTokens(value) {
  const stop = new Set([
    "receita", "facil", "rapida", "rapido", "caseiro", "caseira", "como",
    "fazer", "para", "com", "uma", "por", "dos", "das", "de", "da", "do", "e",
  ]);
  return normalize(value).split(" ").filter((token) => token.length > 2 && !stop.has(token));
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value) {
  return decodeHtml(String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return firstMatch(html, new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"))
    || firstMatch(html, new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"));
}

function firstMatch(text, regex) {
  return text.match(regex)?.[1]?.trim() || "";
}

function resolveUrl(raw, base) {
  try {
    return raw ? new URL(raw, base).toString() : "";
  } catch {
    return "";
  }
}

function sourceRank(recipe) {
  const verified = recipe.fonte?.status === "verified" ? 10 : 0;
  const sourceImage = recipe.imagem?.kind === "source" ? 3 : 0;
  return verified + sourceImage + Number(recipe.fonte?.confidence || 0);
}

function stableRecipeId(recipe) {
  const raw = `${normalize(recipe.nome)}|${recipe.fonte?.url || ""}`;
  let hash = 2166136261;
  for (const char of raw) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${normalize(recipe.nome).replace(/\s+/g, "-").slice(0, 50)}-${(hash >>> 0).toString(36)}`;
}

function safeMime(value) {
  const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
  return allowed.has(String(value).toLowerCase()) ? String(value).toLowerCase() : "image/jpeg";
}

function parseJson(text) {
  const value = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(value);
  } catch {
    const objectStart = value.indexOf("{");
    const objectEnd = value.lastIndexOf("}");
    const arrayStart = value.indexOf("[");
    const arrayEnd = value.lastIndexOf("]");
    if (arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart)) {
      return JSON.parse(value.slice(arrayStart, arrayEnd + 1));
    }
    if (objectStart >= 0) return JSON.parse(value.slice(objectStart, objectEnd + 1));
    throw new Error("Resposta do modelo não era JSON");
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function hashText(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function safeError(error) {
  const message = String(error?.message || error || "erro").replace(/[<>{}]/g, "");
  return message.slice(0, 180);
}
