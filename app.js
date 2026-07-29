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
  photos: readStore("photos", []),
  checked: readStore("checked", {}),
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
  rebuildIndex();
  renderAll();
  bindShell();
  restorePendingSearch();

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
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
  const hasImage = Boolean(image.url && ["source", "bank"].includes(image.kind));
  const sourceLabel = image.kind === "source"
    ? `Foto da fonte · ${escapeHtml(domainOf(recipe.fonte?.url))}`
    : image.kind === "bank"
      ? "Imagem ilustrativa · Pexels"
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

function localSearch(query, kind = "buscar") {
  const terms = normalize(query).split(" ").filter((term) => term.length > 1);
  if (!terms.length) return [];

  const unique = new Map();
  allGeneratedRecipes().forEach((recipe) => unique.set(recipe.id, recipe));
  Object.values(state.liked).map(normalizeRecipe).forEach((recipe) => unique.set(recipe.id, recipe));

  return [...unique.values()]
    .map((recipe) => {
      const haystack = searchHaystack(recipe);
      const name = normalize(recipe.nome);
      const ingredients = normalize((recipe.ingredientes || []).join(" "));
      const hits = terms.filter((term) => haystack.includes(term)).length;
      let score = hits * 3;
      score += terms.filter((term) => name.includes(term)).length * 4;
      if (kind === "com_ingredientes") {
        score += terms.filter((term) => ingredients.includes(term)).length * 5;
      }
      return { recipe, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ recipe }) => recipe);
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
    status.textContent = results.length
      ? `${results.length} resultado(s), ${verified} com fonte direta verificada.`
      : "Não encontrei uma receita com fonte confiável. Tente outras palavras.";
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
    await pollSearch(response.job_id, instant);
    return;
  }

  const remote = (response.pratos || []).map(normalizeRecipe);
  finishSearch(mergeRecipes(instant, remote));
}

async function pollSearch(jobId, instant, attempt = 0) {
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
      await pollSearch(jobId, instant, attempt + 1);
      return;
    }
    const remote = (response.pratos || []).map(normalizeRecipe);
    finishSearch(mergeRecipes(instant, remote));
  } catch {
    await pollSearch(jobId, instant, attempt + 1);
  }
}

function finishSearch(results) {
  state.search.results = results;
  state.search.status = "done";
  state.search.jobId = "";
  writeStore("search", state.search);
  rebuildIndex();
  renderSearch();
}

function mergeRecipes(local, remote) {
  const merged = new Map();
  [...remote, ...local].forEach((recipe) => {
    const normalized = normalizeRecipe(recipe);
    const key = normalized.fonte?.status === "verified" && normalized.fonte?.url
      ? normalized.fonte.url
      : normalize(normalized.nome);
    if (!merged.has(key)) merged.set(key, normalized);
  });
  return [...merged.values()].slice(0, 8);
}

function restorePendingSearch() {
  if (state.search.status !== "loading" || !state.search.jobId || !state.settings.worker) return;
  const instant = localSearch(state.search.query, state.search.kind);
  pollSearch(state.search.jobId, instant);
}

function likedRecipes() {
  const merged = new Map();
  (state.repoList?.itens || []).map(normalizeRecipe).forEach((recipe) => merged.set(recipe.id, recipe));
  Object.values(state.liked).map(normalizeRecipe).forEach((recipe) => merged.set(recipe.id, recipe));
  Object.entries(state.votes).forEach(([id, voteValue]) => {
    if (voteValue === "dislike") merged.delete(id);
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

  const ingredients = [
    ...recipes.flatMap((recipe) => recipe.ingredientes || []),
    ...state.photos.flatMap((photo) => photo.ingredientes || []),
  ];
  renderShoppingList(ingredients);
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
  const ingredients = [
    ...recipes.flatMap((recipe) => recipe.ingredientes || []),
    ...state.photos.flatMap((photo) => photo.ingredientes || []),
  ];
  if (!ingredients.length || !state.settings.worker) {
    renderShoppingList(ingredients);
    return;
  }

  const signature = smallHash([...ingredients].sort().join("|"));
  const cached = readStore("shopping", {});
  if (cached.signature === signature && cached.list) {
    renderShoppingList(cached.list, true);
    return;
  }

  $("#shopping-list").innerHTML = `<div class="search-status"><span class="progress">Somando quantidades e organizando os corredores…</span></div>`;
  try {
    const response = await workerRequest({ action: "consolidar", ingredientes: ingredients });
    const list = response.lista && Object.keys(response.lista).length
      ? response.lista
      : fallbackConsolidate(ingredients);
    writeStore("shopping", { signature, list });
    renderShoppingList(list, true);
  } catch {
    renderShoppingList(ingredients);
  }
}

function renderShoppingList(input, alreadyGrouped = false) {
  const target = $("#shopping-list");
  const list = alreadyGrouped ? input : fallbackConsolidate(input);
  if (!input || (Array.isArray(input) && !input.length) || !Object.keys(list).length) {
    target.innerHTML = emptyState("Curta uma receita para montar a lista automaticamente.");
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
              <label class="shopping-item">
                <input type="checkbox" data-shopping-key="${key}" ${state.checked[key] ? "checked" : ""} />
                <span>${escapeHtml(item)}</span>
              </label>
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
    });
  });
}

async function handlePhotos(files) {
  if (!files?.length) return;
  const target = $("#photo-status");
  if (!state.settings.worker) {
    target.textContent = "Configure o Worker nos Ajustes para ler ingredientes de fotos.";
    return;
  }
  let count = 0;
  for (const file of files) {
    count += 1;
    target.innerHTML = `<span class="progress">Lendo foto ${count} de ${files.length}…</span>`;
    try {
      const data = await fileAsBase64(file);
      const response = await workerRequest({
        action: "foto",
        imagem: data,
        mime: file.type || "image/jpeg",
      });
      if (response.ingredientes?.length) {
        state.photos.push({
          id: `foto-${Date.now()}-${count}`,
          nome: file.name || `Foto ${count}`,
          ingredientes: response.ingredientes,
        });
      }
    } catch {
      target.textContent = `Não consegui ler ${file.name || "uma das fotos"}.`;
    }
  }
  writeStore("photos", state.photos);
  target.textContent = state.photos.length
    ? `${state.photos.length} receita(s) de foto incluída(s).`
    : "Nenhum ingrediente foi identificado.";
  renderList();
  refreshShoppingList();
}

function fileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
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
  const hasImage = Boolean(image.url && ["source", "bank"].includes(image.kind));
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

  if (!state.settings.worker) return;
  try {
    await workerRequest({
      action: "voto",
      voto: next || "remove",
      receita: recipe,
      event_id: `${id}:${Date.now()}:${smallHash(Math.random())}`,
    });
  } catch {
    // O voto local continua valendo e será visível neste aparelho.
  }
}

function bindShell() {
  $$(".bottom-nav [data-tab]").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.tab));
  });
  bindSearch();
  $("#photo-input").addEventListener("change", (event) => handlePhotos(event.target.files));
  $("#share-list").addEventListener("click", shareShoppingList);
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
  if (tab === "lista") refreshShoppingList();
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

function saveSettings(event) {
  event.preventDefault();
  state.settings = {
    worker: $("#worker-url").value.trim().replace(/\/+$/, ""),
    coupleName: $("#couple-name").value.trim() || "Ana & Rafael",
  };
  writeStore("settings", state.settings);
  renderBrand();
  $("#settings-dialog").close();
}

async function workerRequest(payload) {
  const url = state.settings.worker;
  if (!url) throw new Error("Worker não configurado");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);
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
  const recipes = likedRecipes();
  const ingredients = recipes.flatMap((recipe) => recipe.ingredientes || []);
  const grouped = fallbackConsolidate(ingredients);
  const text = Object.entries(grouped)
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
