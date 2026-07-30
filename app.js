const CONFIG = window.COZINHA_CONFIG || {};
const STORE_PREFIX = "cozinha-v2:";
const COURSE_ORDER = ["principal", "entrada", "sobremesa"];
const COURSE_LABEL = {
  principal: "Pratos principais · escolha um",
  entrada: "Entrada · opcional",
  sobremesa: "Sobremesa · opcional",
};

const state = {
  data: null,
  profile: null,
  repoList: null,
  votes: readStore("votes", {}),
  liked: readStore("liked", {}),
  pendingVotes: readStore("pending-votes", []),
  checked: readStore("checked", {}),
  shopping: readStore("shopping-v3", {
    sourceSignature: "",
    list: {},
    checked: {},
    updatedAt: "",
  }),
  settings: readStore("settings", {
    worker: CONFIG.WORKER_URL || "",
    coupleName: CONFIG.NOME_CASAL || "Ana & Rafael",
  }),
  search: readStore("search", {
    query: "",
    results: [],
    status: "idle",
    jobId: "",
    startedAt: 0,
    kind: "buscar",
  }),
  activeWeekDay: 0,
  index: new Map(),
  remoteStorage: "local",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function readStore(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(STORE_PREFIX + key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function cssUrl(value) {
  return encodeURI(String(value || ""))
    .replaceAll("'", "%27")
    .replaceAll('"', "%22")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29");
}

function safeExternalLink(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
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

function slug(value) {
  return normalize(value).replace(/\s+/g, "-").slice(0, 60) || "prato";
}

function stableId(recipe) {
  if (recipe.id) return recipe.id;
  const source = recipe?.fonte?.url || recipe?.source?.url || "";
  return `${slug(recipe.nome)}-${smallHash(source || recipe.nome)}`;
}

function smallHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 7);
}

function normalizeRecipe(raw) {
  const recipe = { ...raw };
  recipe.id = stableId(recipe);
  recipe.curso = COURSE_ORDER.includes(String(recipe.curso).toLowerCase())
    ? String(recipe.curso).toLowerCase()
    : "principal";
  recipe.tags = Array.isArray(recipe.tags) ? recipe.tags : [];
  recipe.ingredientes = Array.isArray(recipe.ingredientes) ? recipe.ingredientes : [];
  recipe.preparo = Array.isArray(recipe.preparo) ? recipe.preparo : [];
  recipe.fonte = recipe.fonte || recipe.source || {
    status: recipe.url ? "unverified" : "missing",
    url: recipe.url || "",
  };
  recipe.imagem = recipe.imagem || recipe.image || { kind: "none", url: "" };
  if (!["source", "bank", "user"].includes(recipe.imagem.kind)) {
    recipe.imagem = { ...recipe.imagem, kind: recipe.imagem.url ? "user" : "none" };
  }
  return recipe;
}

async function fetchJson(path, fallback) {
  try {
    const response = await fetch(`${path}?v=${Date.now()}`, { cache: "no-store" });
    return response.ok ? await response.json() : fallback;
  } catch {
    return fallback;
  }
}

async function initialize() {
  const [data, profile, repoList] = await Promise.all([
    fetchJson("./data/receitas.json", {}),
    fetchJson("./data/perfil_gostos.json", {}),
    fetchJson("./data/lista_final.json", { itens: [] }),
  ]);
  state.data = data;
  state.profile = profile;
  state.repoList = repoList;
  await syncRemoteState();
  rebuildIndex();
  renderAll();
  bindShell();
  restorePendingSearch();
  refreshShoppingList();

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker
      .register("./sw.js", { updateViaCache: "none" })
      .then((registration) => registration.update())
      .catch(() => {});
  }
}

async function syncRemoteState() {
  if (!state.settings.worker) return;
  await flushPendingVotes();
  try {
    const response = await workerRequest({ action: "bootstrap" });
    state.remoteStorage = response.storage || "local";
    if (response.storage === "d1") {
      const remoteLiked = {};
      (response.favorites || []).map(normalizeRecipe).forEach((recipe) => {
        remoteLiked[recipe.id] = recipe;
        state.votes[recipe.id] = "like";
      });
      Object.keys(state.liked).forEach((id) => {
        if (!remoteLiked[id] && state.votes[id] === "like") delete state.votes[id];
      });
      state.liked = remoteLiked;
      writeStore("liked", state.liked);
      writeStore("votes", state.votes);
    }
    if (response.shopping && isRemoteNewer(response.shopping, state.shopping)) {
      state.shopping = normalizeShoppingState(response.shopping);
      state.checked = { ...(state.shopping.checked || {}) };
      writeStore("shopping-v3", state.shopping);
      writeStore("checked", state.checked);
    }
  } catch {
    // O app continua com o acervo e a lista salvos neste aparelho.
  }
}

async function flushPendingVotes() {
  if (!state.pendingVotes.length || !state.settings.worker) return;
  const remaining = [];
  for (const payload of state.pendingVotes.slice(-50)) {
    try {
      await workerRequest(payload);
    } catch {
      remaining.push(payload);
    }
  }
  state.pendingVotes = remaining;
  writeStore("pending-votes", state.pendingVotes);
}

function normalizeShoppingState(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    sourceSignature: String(input.sourceSignature || ""),
    list: input.list && typeof input.list === "object" && !Array.isArray(input.list) ? input.list : {},
    checked: input.checked && typeof input.checked === "object" && !Array.isArray(input.checked) ? input.checked : {},
    updatedAt: String(input.updatedAt || new Date().toISOString()),
  };
}

function isRemoteNewer(remote, local) {
  const remoteTime = Date.parse(remote?.updatedAt || 0) || 0;
  const localTime = Date.parse(local?.updatedAt || 0) || 0;
  return remoteTime > localTime;
}

function allGeneratedRecipes() {
  const daily = state.data?.diario?.pratos || [];
  const weekly = (state.data?.semanal?.dias || []).flatMap((day) => day.pratos || []);
  return [...daily, ...weekly].map(normalizeRecipe);
}

function rebuildIndex() {
  state.index.clear();
  allGeneratedRecipes().forEach((recipe) => state.index.set(recipe.id, recipe));
  Object.values(state.liked).forEach((raw) => {
    const recipe = normalizeRecipe(raw);
    state.index.set(recipe.id, recipe);
  });
  (state.search.results || []).forEach((raw) => {
    const recipe = normalizeRecipe(raw);
    state.index.set(recipe.id, recipe);
  });
}

function renderAll() {
  renderToday();
  renderWeek();
  renderSearch();
  renderList();
  renderProfile();
  renderBrand();
}

function renderBrand() {
  const label = $(".brand p");
  if (label) label.textContent = state.settings.coupleName || "Ana & Rafael";
}

function recipesByCourse(recipes) {
  const groups = new Map(COURSE_ORDER.map((course) => [course, []]));
  recipes.map(normalizeRecipe).forEach((recipe) => groups.get(recipe.curso).push(recipe));
  return groups;
}

function renderRecipeGroups(recipes, options = {}) {
  const groups = recipesByCourse(recipes);
  return COURSE_ORDER.map((course) => {
    const list = groups.get(course);
    if (!list.length) return "";
    return `
      <div class="course-heading">${COURSE_LABEL[course]}</div>
      <div class="recipe-grid ${list.length >= 3 ? "three" : ""}">
        ${list.map((recipe, index) => recipeCard(recipe, { featured: options.featureFirst && course === "principal" && index === 0 })).join("")}
      </div>
    `;
  }).join("");
}

function recipeCard(recipe, { featured = false } = {}) {
  const vote = state.votes[recipe.id];
  const image = recipe.imagem || {};
  const hasImage = Boolean(image.url && ["source", "bank", "user"].includes(image.kind));
  const sourceLabel = image.kind === "source"
    ? `Foto da fonte · ${escapeHtml(domainOf(recipe.fonte?.url))}`
    : image.kind === "bank"
      ? "Imagem ilustrativa · Pexels"
      : image.kind === "user"
        ? "Foto do casal"
      : "";
  const imageStyle = hasImage ? `style="background-image:url('${cssUrl(image.url)}')"` : "";
  const tags = [
    ...recipe.tags.slice(0, 3),
    ...(recipe.rende_sobra ? ["rende sobra"] : []),
  ];

  return `
    <article class="recipe-card ${featured ? "is-featured" : ""}" data-recipe-card="${escapeHtml(recipe.id)}">
      <button
        class="recipe-photo ${hasImage ? "has-image" : ""}"
        data-open-recipe="${escapeHtml(recipe.id)}"
        data-course="${escapeHtml(recipe.curso)}"
        ${imageStyle}
        aria-label="Abrir receita: ${escapeHtml(recipe.nome)}"
      >
        ${hasImage
          ? `<span class="photo-label">${sourceLabel}</span>`
          : `<span class="fallback-art"><strong>${escapeHtml(recipe.nome)}</strong></span>`}
        ${recipe.tempo ? `<span class="time-pill">◷ ${escapeHtml(recipe.tempo)}</span>` : ""}
      </button>
      <div class="recipe-card-body">
        <button class="recipe-open" data-open-recipe="${escapeHtml(recipe.id)}">
          <h3>${escapeHtml(recipe.nome)}</h3>
          <span class="tag-row">
            ${tags.map((tag) => `<span class="tag">${escapeHtml(String(tag).replaceAll("_", " "))}</span>`).join("")}
          </span>
        </button>
        <div class="vote-stack" aria-label="Avaliar prato">
          <button class="vote-button like ${vote === "like" ? "is-selected" : ""}" data-vote="like" data-recipe-id="${escapeHtml(recipe.id)}" aria-label="Gostei de ${escapeHtml(recipe.nome)}">↑</button>
          <button class="vote-button dislike ${vote === "dislike" ? "is-selected" : ""}" data-vote="dislike" data-recipe-id="${escapeHtml(recipe.id)}" aria-label="Não gostei de ${escapeHtml(recipe.nome)}">↓</button>
        </div>
      </div>
    </article>
  `;
}

function bindRecipeInteractions(root) {
  $$("[data-open-recipe]", root).forEach((button) => {
    button.addEventListener("click", () => openRecipe(button.dataset.openRecipe));
  });
  $$("[data-vote]", root).forEach((button) => {
    button.addEventListener("click", () => vote(button.dataset.recipeId, button.dataset.vote));
  });
}

function renderToday() {
  const target = $("#today-content");
  const daily = state.data?.diario;
  const recipes = daily?.pratos || [];
  $("#today-label").textContent = daily?.dia_semana
    ? `${capitalize(daily.dia_semana)} · ${daily.data || "hoje"}`
    : "Jantar de hoje";
  target.innerHTML = recipes.length
    ? renderRecipeGroups(recipes, { featureFirst: true })
    : emptyState();
  bindRecipeInteractions(target);
}

function renderWeek() {
  const days = state.data?.semanal?.dias || [];
  $("#week-period").textContent = state.data?.semanal?.periodo || "";
  const strip = $("#day-strip");
  strip.innerHTML = days.map((day, index) => `
    <button type="button" role="tab" aria-selected="${index === state.activeWeekDay}" class="${index === state.activeWeekDay ? "is-active" : ""}" data-week-day="${index}">
      ${escapeHtml(shortDay(day.dia))}
    </button>
  `).join("");

  const active = days[state.activeWeekDay] || days[0];
  const target = $("#week-content");
  target.innerHTML = active?.pratos?.length
    ? `<div class="course-heading">${escapeHtml(active.dia)}</div>${renderRecipeGroups(active.pratos)}`
    : emptyState("O cardápio semanal chega no domingo à noite.");
  bindRecipeInteractions(target);
  $$("[data-week-day]", strip).forEach((button) => {
    button.addEventListener("click", () => {
      state.activeWeekDay = Number(button.dataset.weekDay);
      renderWeek();
    });
  });
}

function searchHaystack(recipe) {
  return normalize([
    recipe.nome,
    recipe.curso,
    recipe.porque,
    ...(recipe.tags || []),
    ...(recipe.ingredientes || []),
  ].join(" "));
}

const SEARCH_STOP_WORDS = new Set([
  "a", "ao", "as", "com", "da", "das", "de", "do", "dos", "e", "em", "na", "nas", "no", "nos",
  "o", "os", "para", "por", "pra", "prato", "principal", "receita", "receitas", "somente", "so",
  "facil", "faceis", "rapida", "rapidas", "rapido", "rapidos", "pratica", "praticas", "pratico", "praticos",
  "air", "fryer", "airfryer", "fritadeira", "sobremesa", "sobremesas", "doce", "doces", "entrada", "entradas",
  "carne", "carnes", "vermelha", "vermelhas", "frango", "galinha", "peixe", "peixes", "porco", "suino",
]);

const PROTEIN_TERMS = {
  carne_vermelha: [
    "carne bovina", "carne vermelha", "bife", "patinho", "alcatra", "maminha", "picanha",
    "file mignon", "contrafile", "acem", "musculo", "lagarto", "coxao", "cupim", "bovino", "boi",
  ],
  frango: ["frango", "galinha", "sobrecoxa", "coxa de frango", "peito de frango"],
  peixe: ["peixe", "salmao", "tilapia", "bacalhau", "atum", "pescada", "sardinha"],
  porco: ["porco", "suino", "lombo", "bisteca", "pernil", "costelinha", "panceta"],
  vegetariano: ["vegetariano", "vegano", "sem carne"],
};

function parseSearchIntent(query, kind = "buscar") {
  const text = normalize(query);
  let course = "";
  if (/(sobremesa|doce|bolo|pudim|mousse|brigadeiro|cookie|torta doce|sorvete)/.test(text)) {
    course = "sobremesa";
  } else if (/(entrada|petisco|aperitivo|canape)/.test(text)) {
    course = "entrada";
  } else if (/(prato principal|almoco|jantar)/.test(text)) {
    course = "principal";
  }

  let protein = "";
  if (/(carne vermelha|carne bovina|bife|patinho|alcatra|maminha|picanha|file mignon|contrafile|acem|coxao|cupim)/.test(text)) {
    protein = "carne_vermelha";
  } else if (/(frango|galinha|sobrecoxa)/.test(text)) {
    protein = "frango";
  } else if (/(peixe|salmao|tilapia|bacalhau|atum|pescada|sardinha)/.test(text)) {
    protein = "peixe";
  } else if (/(porco|suino|lombo|bisteca|pernil|costelinha|panceta)/.test(text)) {
    protein = "porco";
  } else if (/(vegetariano|vegano|sem carne)/.test(text)) {
    protein = "vegetariano";
  }

  let method = "";
  if (/(air ?fryer|fritadeira sem oleo)/.test(text)) method = "airfryer";
  else if (/(panela de pressao)/.test(text)) method = "pressao";
  else if (/(forno|assad[oa])/.test(text)) method = "forno";
  else if (/(grelhad[oa])/.test(text)) method = "grelha";

  const tokens = text
    .split(" ")
    .filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token));
  return { text, kind, course, protein, method, tokens: [...new Set(tokens)] };
}

function includesAny(text, terms = []) {
  return terms.some((term) => text.includes(term));
}

function recipeMatchesProtein(text, protein) {
  if (!protein) return true;
  if (protein === "carne_vermelha") {
    if (includesAny(text, PROTEIN_TERMS.carne_vermelha)) return true;
    const otherProtein = includesAny(text, [
      ...PROTEIN_TERMS.frango,
      ...PROTEIN_TERMS.peixe,
      ...PROTEIN_TERMS.porco,
    ]);
    return text.includes("carne") && !otherProtein;
  }
  return includesAny(text, PROTEIN_TERMS[protein] || []);
}

function recipeMatchesMethod(text, method) {
  if (!method) return true;
  const methods = {
    airfryer: ["airfryer", "air fryer", "fritadeira sem oleo"],
    pressao: ["panela de pressao", "pressao"],
    forno: ["forno", "assado", "assada"],
    grelha: ["grelha", "grelhado", "grelhada"],
  };
  return includesAny(text, methods[method] || []);
}

function scoreSearchRecipe(rawRecipe, intent) {
  const recipe = normalizeRecipe(rawRecipe);
  const haystack = searchHaystack(recipe);
  if (intent.course && recipe.curso !== intent.course) return null;
  if (!recipeMatchesProtein(haystack, intent.protein)) return null;
  if (!recipeMatchesMethod(haystack, intent.method)) return null;

  const name = normalize(recipe.nome);
  const ingredients = normalize((recipe.ingredientes || []).join(" "));
  const tags = normalize((recipe.tags || []).join(" "));
  const tokenHits = intent.tokens.filter((token) => haystack.includes(token));
  if (intent.tokens.length) {
    const required = intent.kind === "com_ingredientes"
      ? 1
      : Math.max(1, Math.ceil(intent.tokens.length * 0.5));
    if (tokenHits.length < required) return null;
  }

  let score = tokenHits.length * 5;
  score += intent.tokens.filter((token) => name.includes(token)).length * 9;
  score += intent.tokens.filter((token) => ingredients.includes(token)).length * (intent.kind === "com_ingredientes" ? 8 : 4);
  score += intent.tokens.filter((token) => tags.includes(token)).length * 4;
  if (intent.course) score += 18;
  if (intent.protein) score += 20;
  if (intent.method) score += 18;
  if (recipe.fonte?.status === "verified") score += 5;
  return { recipe, score };
}

function rankSearchRecipes(recipes, query, kind = "buscar", limit = 8) {
  const intent = parseSearchIntent(query, kind);
  return recipes
    .map((recipe) => scoreSearchRecipe(recipe, intent))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.recipe.nome.localeCompare(b.recipe.nome, "pt-BR"))
    .slice(0, limit)
    .map(({ recipe }) => recipe);
}

function localSearch(query, kind = "buscar") {
  const unique = new Map();
  allGeneratedRecipes().forEach((recipe) => unique.set(recipe.id, recipe));
  Object.values(state.liked).map(normalizeRecipe).forEach((recipe) => unique.set(recipe.id, recipe));
  return rankSearchRecipes([...unique.values()], query, kind, 6);
}

function renderSearch() {
  $("#search-query").value = state.search.kind === "buscar" ? state.search.query || "" : "";
  $("#pantry-query").value = state.search.kind === "com_ingredientes" ? state.search.query || "" : "";
  const target = $("#search-results");
  const results = state.search.results || [];
  target.innerHTML = results.length ? renderRecipeGroups(results) : "";
  bindRecipeInteractions(target);

  const status = $("#search-status");
  if (state.search.status === "loading") {
    status.innerHTML = `<span class="progress">Buscando fontes confiáveis. Você pode sair desta aba e voltar depois.</span>`;
  } else if (state.search.status === "local") {
    status.textContent = results.length
      ? "Resultados instantâneos do seu acervo. Conecte o Worker para ampliar a busca na web."
      : "Nada no acervo. Conecte o Worker nos Ajustes para pesquisar na web.";
  } else if (state.search.status === "done") {
    const verified = results.filter((recipe) => normalizeRecipe(recipe).fonte?.status === "verified").length;
    status.textContent = state.search.message || (results.length
      ? `${results.length} resultado(s), ${verified} com fonte direta verificada.`
      : "Não encontrei uma receita que corresponda ao pedido em uma fonte confiável. Tente outras palavras.");
  } else if (state.search.status === "error") {
    status.textContent = state.search.message || "Não consegui completar a busca. Os resultados locais continuam disponíveis.";
  } else {
    status.textContent = "";
  }
}

function bindSearch() {
  $("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    startSearch($("#search-query").value, "buscar");
  });
  $("#pantry-form").addEventListener("submit", (event) => {
    event.preventDefault();
    startSearch($("#pantry-query").value, "com_ingredientes");
  });
  $$("[data-quick-search]").forEach((button) => {
    button.addEventListener("click", () => {
      $("#search-query").value = button.dataset.quickSearch;
      startSearch(button.dataset.quickSearch, "buscar");
    });
  });
}

async function startSearch(query, kind) {
  const clean = String(query || "").trim();
  if (!clean) return;

  const instant = localSearch(clean, kind);
  state.search = {
    query: clean,
    results: instant,
    status: state.settings.worker ? "loading" : "local",
    jobId: "",
    startedAt: Date.now(),
    kind,
  };
  writeStore("search", state.search);
  rebuildIndex();
  renderSearch();

  if (!state.settings.worker) return;
  try {
    const payload = kind === "com_ingredientes"
      ? { action: kind, ingredientes: clean.split(",").map((item) => item.trim()).filter(Boolean) }
      : { action: kind, texto: clean };
    const response = await workerRequest(payload);
    await handleSearchResponse(response, instant);
  } catch (error) {
    state.search.status = "error";
    state.search.message = "A busca web não respondeu. Mostrei o que já existia no seu acervo.";
    writeStore("search", state.search);
    renderSearch();
  }
}

async function handleSearchResponse(response, instant) {
  if (response.status === "processing" && response.job_id) {
    state.search.jobId = response.job_id;
    writeStore("search", state.search);
    renderSearch();
    await pollSearch(response.job_id, instant, 0, state.search.startedAt);
    return;
  }

  const remote = (response.pratos || []).map(normalizeRecipe);
  finishSearch(
    mergeRecipes(instant, remote, state.search.query, state.search.kind),
    response.aviso || "",
  );
}

async function pollSearch(jobId, instant, attempt = 0, expectedStartedAt = state.search.startedAt) {
  if (state.search.startedAt !== expectedStartedAt) return;
  if (state.search.jobId && state.search.jobId !== jobId) return;
  if (!jobId || attempt > 25) {
    state.search.status = "error";
    state.search.message = "A busca continua demorando. Tente novamente; resultados prontos ficam em cache.";
    writeStore("search", state.search);
    renderSearch();
    return;
  }
  await wait(Math.min(1000 + attempt * 180, 2400));
  try {
    const response = await workerRequest({ action: "buscar_status", job_id: jobId });
    if (response.status === "processing") {
      await pollSearch(jobId, instant, attempt + 1, expectedStartedAt);
      return;
    }
    if (state.search.jobId && state.search.jobId !== jobId) return;
    const remote = (response.pratos || []).map(normalizeRecipe);
    finishSearch(
      mergeRecipes(instant, remote, state.search.query, state.search.kind),
      response.aviso || "",
    );
  } catch {
    await pollSearch(jobId, instant, attempt + 1, expectedStartedAt);
  }
}

function finishSearch(results, message = "") {
  state.search.results = results;
  state.search.status = "done";
  state.search.jobId = "";
  state.search.message = message;
  writeStore("search", state.search);
  rebuildIndex();
  renderSearch();
}

function mergeRecipes(local, remote, query, kind) {
  const merged = new Map();
  [...remote, ...local].forEach((recipe) => {
    const normalized = normalizeRecipe(recipe);
    const key = normalized.fonte?.status === "verified" && normalized.fonte?.url
      ? normalized.fonte.url
      : normalize(normalized.nome);
    if (!merged.has(key)) merged.set(key, normalized);
  });
  return rankSearchRecipes([...merged.values()], query, kind, 8);
}

function restorePendingSearch() {
  if (state.search.status !== "loading" || !state.search.jobId || !state.settings.worker) return;
  const instant = localSearch(state.search.query, state.search.kind);
  pollSearch(state.search.jobId, instant, 0, state.search.startedAt);
}

function likedRecipes() {
  const merged = new Map();
  if (state.remoteStorage !== "d1") {
    (state.repoList?.itens || []).map(normalizeRecipe).forEach((recipe) => merged.set(recipe.id, recipe));
  }
  Object.values(state.liked).map(normalizeRecipe).forEach((recipe) => merged.set(recipe.id, recipe));
  Object.entries(state.votes).forEach(([id, voteValue]) => {
    if (voteValue !== "like") merged.delete(id);
  });
  return [...merged.values()];
}

function renderList() {
  const recipes = likedRecipes();
  const likedTarget = $("#liked-recipes");
  likedTarget.innerHTML = recipes.length
    ? `<div class="course-heading">Receitas escolhidas · ${recipes.length}</div>${renderRecipeGroups(recipes)}`
    : "";
  bindRecipeInteractions(likedTarget);
  renderShoppingList(state.shopping.list);
}

function fallbackConsolidate(ingredients) {
  const unique = new Map();
  ingredients.forEach((item) => {
    const key = normalize(item);
    if (key && !unique.has(key)) unique.set(key, String(item).trim());
  });
  return { "Itens das receitas": [...unique.values()].sort((a, b) => a.localeCompare(b, "pt-BR")) };
}

async function refreshShoppingList() {
  const recipes = likedRecipes();
  const ingredients = recipes.flatMap((recipe) => recipe.ingredientes || []);
  const signature = shoppingSourceSignature(recipes);
  if (state.shopping.sourceSignature === signature) {
    renderShoppingList(state.shopping.list);
    return;
  }

  if (!ingredients.length) {
    await saveShoppingState({}, signature);
    return;
  }

  $("#shopping-list").innerHTML = `<div class="search-status"><span class="progress">Somando quantidades e organizando os corredores…</span></div>`;
  let list = fallbackConsolidate(ingredients);
  try {
    if (state.settings.worker) {
      const response = await workerRequest({ action: "consolidar", ingredientes: ingredients });
      if (response.lista && Object.keys(response.lista).length) list = response.lista;
    }
  } catch {
    // A consolidação local continua disponível.
  }
  await saveShoppingState(list, signature);
}

function shoppingSourceSignature(recipes = likedRecipes()) {
  return smallHash(
    recipes
      .map((recipe) => `${recipe.id}:${smallHash((recipe.ingredientes || []).join("|"))}`)
      .sort()
      .join("|"),
  );
}

async function saveShoppingState(list, sourceSignature = state.shopping.sourceSignature, sync = true) {
  state.shopping = normalizeShoppingState({
    sourceSignature,
    list,
    checked: state.checked,
    updatedAt: new Date().toISOString(),
  });
  writeStore("shopping-v3", state.shopping);
  renderShoppingList(state.shopping.list);
  if (!sync || !state.settings.worker) return;
  try {
    await workerRequest({ action: "lista_salvar", shopping: state.shopping });
  } catch {
    // A lista local permanece intacta e será usada mesmo sem internet.
  }
}

function renderShoppingList(list = {}) {
  const target = $("#shopping-list");
  if (!list || !Object.keys(list).some((category) => (list[category] || []).length)) {
    target.innerHTML = emptyState("A lista está vazia. Curta uma receita ou adicione um item.");
    return;
  }
  target.innerHTML = `
    <div class="course-heading">Para comprar</div>
    ${Object.entries(list).map(([category, items]) => `
      <section class="shopping-category">
        <h3>${escapeHtml(category)}</h3>
        <div class="shopping-items">
          ${(items || []).map((item) => {
            const key = smallHash(`${category}:${item}`);
            return `
              <div class="shopping-item">
                <label>
                  <input type="checkbox" data-shopping-key="${key}" ${state.checked[key] ? "checked" : ""} />
                  <span>${escapeHtml(item)}</span>
                </label>
                <button type="button" class="remove-item" data-remove-shopping="${key}" aria-label="Retirar ${escapeHtml(item)} da lista">×</button>
              </div>
            `;
          }).join("")}
        </div>
      </section>
    `).join("")}
  `;
  $$("[data-shopping-key]", target).forEach((inputElement) => {
    inputElement.addEventListener("change", () => {
      state.checked[inputElement.dataset.shoppingKey] = inputElement.checked;
      writeStore("checked", state.checked);
      saveShoppingState(state.shopping.list);
    });
  });
  $$("[data-remove-shopping]", target).forEach((button) => {
    button.addEventListener("click", () => removeShoppingItem(button.dataset.removeShopping));
  });
}

async function addManualShoppingItem(value) {
  const item = String(value || "").trim();
  if (!item) return;
  const list = structuredClone(state.shopping.list || {});
  const items = Array.isArray(list.Outros) ? list.Outros : [];
  if (!items.some((current) => normalize(current) === normalize(item))) items.push(item);
  list.Outros = items;
  await saveShoppingState(list);
}

async function removeShoppingItem(key) {
  const list = structuredClone(state.shopping.list || {});
  Object.entries(list).forEach(([category, items]) => {
    list[category] = (items || []).filter((item) => smallHash(`${category}:${item}`) !== key);
    if (!list[category].length) delete list[category];
  });
  delete state.checked[key];
  writeStore("checked", state.checked);
  await saveShoppingState(list);
}

async function clearShoppingList() {
  state.checked = {};
  writeStore("checked", state.checked);
  await saveShoppingState({}, shoppingSourceSignature());
}

async function handlePhotos(files) {
  if (!files?.length) return;
  const target = $("#photo-status");
  if (!state.settings.worker) {
    target.textContent = "Configure o Worker nos Ajustes para guardar receitas por foto.";
    return;
  }
  let count = 0;
  let saved = 0;
  for (const file of files) {
    count += 1;
    target.innerHTML = `<span class="progress">Identificando e procurando a receita ${count} de ${files.length}…</span>`;
    try {
      const prepared = await prepareImageUpload(file);
      const response = await workerRequest({
        action: "foto_receita",
        imagem: prepared.base64,
        mime: prepared.mime,
        event_id: `foto:${Date.now()}:${count}:${smallHash(file.name)}`,
      }, 48_000);
      if (response.receita) {
        const recipe = normalizeRecipe(response.receita);
        state.liked[recipe.id] = recipe;
        state.votes[recipe.id] = "like";
        saved += 1;
      }
    } catch (error) {
      target.textContent = `Não consegui analisar ${file.name || "uma das imagens"}: ${error.message || "tente outra imagem"}.`;
    }
  }
  writeStore("liked", state.liked);
  writeStore("votes", state.votes);
  rebuildIndex();
  renderAll();
  await refreshShoppingList();
  target.textContent = saved
    ? `${saved} receita(s) guardada(s) em Gostei com a foto original.`
    : "Nenhuma receita foi adicionada.";
}

async function prepareImageUpload(file) {
  const originalMime = file.type || "image/jpeg";
  if (file.size <= 2_400_000) {
    return { base64: await fileAsBase64(file), mime: originalMime };
  }
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob) throw new Error("compressão indisponível");
    return { base64: await fileAsBase64(blob), mime: "image/jpeg" };
  } catch {
    return { base64: await fileAsBase64(file), mime: originalMime };
  }
}

function fileAsBase64(fileOrBlob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(fileOrBlob);
  });
}

function renderProfile() {
  const remote = state.profile || {};
  const localRecipes = Object.entries(state.votes)
    .map(([id, voteValue]) => ({ recipe: state.index.get(id), vote: voteValue }))
    .filter(({ recipe }) => recipe);
  const counters = { ...(remote.contadores || {}) };
  localRecipes.forEach(({ recipe, vote: voteValue }) => {
    (recipe.tags || []).forEach((tag) => {
      counters[tag] = (counters[tag] || 0) + (voteValue === "like" ? 1 : -1);
    });
  });

  const positive = Object.entries(counters).filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]);
  const negative = Object.entries(counters).filter(([, score]) => score < 0).sort((a, b) => a[1] - b[1]);
  const likes = new Set([...(remote.curtidas || []).map((item) => item.id), ...Object.entries(state.votes).filter(([, value]) => value === "like").map(([id]) => id)]);
  const dislikes = new Set([...(remote.rejeitadas || []).map((item) => item.id), ...Object.entries(state.votes).filter(([, value]) => value === "dislike").map(([id]) => id)]);
  const summary = remote.resumo || buildProfileSummary(positive, negative);

  $("#profile-content").innerHTML = `
    <div class="profile-card">
      <p class="eyebrow" style="color:var(--yellow)">Resumo do paladar</p>
      <strong>${escapeHtml(summary || "Ainda estamos aprendendo. Os primeiros votos já começam a formar o perfil.")}</strong>
      <div class="profile-score">
        <div><strong>${likes.size}</strong><span>pratos curtidos</span></div>
        <div><strong>${dislikes.size}</strong><span>pratos evitados</span></div>
      </div>
    </div>
    ${positive.length ? `<div class="course-heading">Vocês tendem a gostar</div><div class="taste-cloud">${positive.slice(0, 10).map(([tag]) => `<span class="taste-chip positive">${escapeHtml(tag.replaceAll("_", " "))}</span>`).join("")}</div>` : ""}
    ${negative.length ? `<div class="course-heading">Melhor evitar</div><div class="taste-cloud">${negative.slice(0, 10).map(([tag]) => `<span class="taste-chip negative">${escapeHtml(tag.replaceAll("_", " "))}</span>`).join("")}</div>` : ""}
  `;
}

function buildProfileSummary(positive, negative) {
  const liked = positive.slice(0, 4).map(([tag]) => tag.replaceAll("_", " "));
  const avoided = negative.slice(0, 3).map(([tag]) => tag.replaceAll("_", " "));
  const parts = [];
  if (liked.length) parts.push(`Vocês curtem ${joinNatural(liked)}`);
  if (avoided.length) parts.push(`costumam evitar ${joinNatural(avoided)}`);
  return parts.join("; ");
}

function openRecipe(id) {
  const recipe = state.index.get(id);
  if (!recipe) return;
  const dialog = $("#recipe-dialog");
  const image = recipe.imagem || {};
  const hasImage = Boolean(image.url && ["source", "bank", "user"].includes(image.kind));
  const verified = recipe.fonte?.status === "verified" && recipe.fonte?.url;
  const sourceUrl = verified && safeExternalLink(recipe.fonte.url)
    ? safeExternalLink(recipe.fonte.url)
    : `https://www.google.com/search?q=${encodeURIComponent(`${recipe.nome} receita`)}`;
  const sourceTitle = verified
    ? `Abrir receita original em ${domainOf(recipe.fonte.url)}`
    : "Procurar uma fonte para esta receita";

  $("#recipe-detail").innerHTML = `
    <header class="detail-hero ${hasImage ? "has-image" : ""}" ${hasImage ? `style="background-image:url('${cssUrl(image.url)}')"` : ""}>
      <button class="dialog-close" type="button" data-close-recipe aria-label="Fechar receita">×</button>
      <div class="detail-hero-content">
        <p class="eyebrow" style="color:var(--yellow)">${escapeHtml(recipe.curso)}${recipe.tempo ? ` · ${escapeHtml(recipe.tempo)}` : ""}</p>
        <h2>${escapeHtml(recipe.nome)}</h2>
        <div class="tag-row">${recipe.tags.map((tag) => `<span class="tag">${escapeHtml(tag.replaceAll("_", " "))}</span>`).join("")}</div>
      </div>
    </header>
    <div class="detail-body">
      ${recipe.porque ? `<p class="detail-reason">${escapeHtml(recipe.porque)}</p>` : ""}
      <section class="detail-section">
        <h3>Ingredientes</h3>
        ${recipe.ingredientes.map((item) => `<label class="ingredient"><input type="checkbox" /> <span>${escapeHtml(item)}</span></label>`).join("")}
      </section>
      <section class="detail-section">
        <h3>Preparo</h3>
        ${recipe.preparo.map((step, index) => `<div class="step"><b>${index + 1}</b><span>${escapeHtml(step)}</span></div>`).join("")}
      </section>
      <section class="detail-section">
        <div class="source-box ${verified ? "" : "is-unverified"}">
          <strong>${verified ? "Fonte verificada" : "Fonte direta não confirmada"}</strong>
          <span>${verified ? `A página respondeu e corresponde ao nome do prato · verificada em ${escapeHtml(recipe.fonte.checked_at || "data da geração")}` : "Para evitar levar você à página errada, o app abre uma busca pelo nome do prato."}</span>
          <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(sourceTitle)} ↗</a>
        </div>
      </section>
      <div class="vote-stack">
        <button class="primary-button" data-detail-vote="like" data-recipe-id="${escapeHtml(recipe.id)}">Gostei</button>
        <button class="secondary-button" data-detail-vote="dislike" data-recipe-id="${escapeHtml(recipe.id)}">Não curti</button>
      </div>
    </div>
  `;

  $("[data-close-recipe]", dialog).addEventListener("click", () => dialog.close());
  $$("[data-detail-vote]", dialog).forEach((button) => {
    button.addEventListener("click", () => {
      vote(button.dataset.recipeId, button.dataset.detailVote);
      dialog.close();
    });
  });
  dialog.showModal();
}

async function vote(id, value) {
  const recipe = state.index.get(id);
  if (!recipe) return;
  const next = state.votes[id] === value ? null : value;
  if (next) state.votes[id] = next;
  else delete state.votes[id];
  if (next === "like") state.liked[id] = recipe;
  else delete state.liked[id];
  writeStore("votes", state.votes);
  writeStore("liked", state.liked);
  renderAll();
  await refreshShoppingList();

  const payload = {
    action: "voto",
    voto: next || "remove",
    receita: recipe,
    event_id: `${id}:${Date.now()}:${smallHash(Math.random())}`,
  };
  if (!state.settings.worker) {
    state.pendingVotes.push(payload);
    state.pendingVotes = state.pendingVotes.slice(-50);
    writeStore("pending-votes", state.pendingVotes);
    return;
  }
  try {
    await workerRequest(payload);
  } catch {
    state.pendingVotes.push(payload);
    state.pendingVotes = state.pendingVotes.slice(-50);
    writeStore("pending-votes", state.pendingVotes);
  }
}

function bindShell() {
  $$(".bottom-nav [data-tab]").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });
  bindSearch();
  ["#camera-input", "#gallery-input"].forEach((selector) => {
    $(selector).addEventListener("change", async (event) => {
      await handlePhotos(event.target.files);
      event.target.value = "";
    });
  });
  $("#share-list").addEventListener("click", shareShoppingList);
  $("#clear-list").addEventListener("click", clearShoppingList);
  $("#manual-item-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#manual-item");
    await addManualShoppingItem(input.value);
    input.value = "";
  });
  $("#open-settings").addEventListener("click", openSettings);
  $("#save-settings").addEventListener("click", saveSettings);
  $("#recipe-dialog").addEventListener("click", (event) => {
    if (event.target === $("#recipe-dialog")) $("#recipe-dialog").close();
  });
  $("#settings-dialog").addEventListener("click", (event) => {
    if (event.target === $("#settings-dialog")) $("#settings-dialog").close();
  });
}

function activateTab(tab) {
  $$(".bottom-nav [data-tab]").forEach((button) => button.classList.toggle("is-active", button.dataset.tab === tab));
  $$(".view").forEach((view) => view.classList.toggle("is-active", view.dataset.view === tab));
  if (tab === "lista") renderList();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openSettings() {
  $("#worker-url").value = state.settings.worker || "";
  $("#couple-name").value = state.settings.coupleName || "";
  $("#sync-indicator").textContent = state.settings.worker
    ? "Sincronização configurada neste aparelho."
    : "Sem Worker: votos e acervo local funcionam; busca web, fotos e sincronização ficam desativadas.";
  $("#settings-dialog").showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  state.settings = {
    worker: $("#worker-url").value.trim().replace(/\/+$/, ""),
    coupleName: $("#couple-name").value.trim() || "Ana & Rafael",
  };
  writeStore("settings", state.settings);
  renderBrand();
  $("#settings-dialog").close();
  await syncRemoteState();
  rebuildIndex();
  renderAll();
  await refreshShoppingList();
}

async function workerRequest(payload, timeoutMs = 18_000) {
  const url = state.settings.worker;
  if (!url) throw new Error("Worker não configurado");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.detalhe || data.error || `HTTP ${response.status}`);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function shareShoppingList() {
  const text = Object.entries(state.shopping.list || {})
    .map(([category, items]) => `${category}\n${items.map((item) => `• ${item}`).join("\n")}`)
    .join("\n\n");
  if (!text) return;
  try {
    if (navigator.share) {
      await navigator.share({ title: "Lista de compras — Cozinha", text });
    } else {
      await navigator.clipboard.writeText(text);
      $("#photo-status").textContent = "Lista copiada.";
    }
  } catch {
    // Cancelar o compartilhamento não exige mensagem.
  }
}

function emptyState(message = "") {
  const template = $("#empty-template").content.cloneNode(true);
  if (message) $(".empty-state p", template).textContent = message;
  const wrapper = document.createElement("div");
  wrapper.append(template);
  return wrapper.innerHTML;
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function shortDay(day) {
  return String(day || "").slice(0, 3).replace(/^./, (char) => char.toUpperCase());
}

function capitalize(value) {
  return String(value || "").replace(/^./, (char) => char.toUpperCase());
}

function joinNatural(items) {
  if (items.length < 2) return items[0] || "";
  return `${items.slice(0, -1).join(", ")} e ${items.at(-1)}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

initialize();
