"use strict";

// Keep the interface state in memory; user accounts, books, and activity live on the server.
const COVER_TONES = ["sage", "sand", "blue", "rose", "gold", "lavender"];
const state = {
  user: null,
  books: [],
  videos: [],
  departments: [],
  developers: [],
  view: "home",
  category: "All departments",
  departmentId: "",
  selectedLevel: "",
  selectedSubject: "",
  videoCategory: "All departments",
  query: "",
  adminTab: "books",
  authMode: "login"
};

// Escape all server-provided text before placing it into generated interface markup.
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const authScreen = $("#auth-screen");
const app = $("#app");
const pageContent = $("#page-content");
const authForm = $("#auth-form");

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function formatSize(bytes) {
  if (!bytes) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(date));
}

function initials(name = "Nasawa") {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function notify(message, isError = false) {
  const toast = document.createElement("div");
  toast.className = `toast${isError ? " is-error" : ""}`;
  toast.textContent = message;
  $("#toast-region").append(toast);
  window.setTimeout(() => toast.remove(), 3800);
}

let supabase;
let supabaseReady;

async function getSupabase() {
  if (!supabaseReady) {
    supabaseReady = (async () => {
      const response = await fetch("/api/config", { cache: "no-store" });
      if (!response.ok) throw new Error("Supabase is not configured for this deployment.");
      const config = await response.json();
      if (!config.url || !config.anonKey || !window.supabase?.createClient) {
        throw new Error("Supabase configuration or the Supabase client is unavailable.");
      }
      supabase = window.supabase.createClient(config.url, config.anonKey);
      return supabase;
    })();
  }
  return supabaseReady;
}

function throwIfError(error) {
  if (error) throw new Error(error.message || "The Supabase request failed.");
}

async function activeUser() {
  const client = await getSupabase();
  const { data: { user }, error } = await client.auth.getUser();
  throwIfError(error);
  if (!user) throw new Error("Please log in to continue.");
  const result = await client.from("profiles").select("id,name,email,role,active,created_at").eq("id", user.id).single();
  throwIfError(result.error);
  if (!result.data.active) {
    await client.auth.signOut();
    throw new Error("This account has been suspended. Contact the library administrator.");
  }
  return { ...result.data, createdAt: result.data.created_at };
}

async function departmentTree(client) {
  client ||= await getSupabase();
  const [departments, levels, subjects] = await Promise.all([
    client.from("departments").select("*").order("sort_order").order("name"),
    client.from("levels").select("*").order("sort_order").order("name"),
    client.from("subjects").select("*").order("name")
  ]);
  throwIfError(departments.error);
  throwIfError(levels.error);
  throwIfError(subjects.error);
  return departments.data.map((department) => ({
    id: department.id,
    name: department.name,
    levels: levels.data.filter((level) => level.department_id === department.id).map((level) => ({
      id: level.id,
      name: level.name,
      subjects: subjects.data.filter((subject) => subject.level_id === level.id).map((subject) => ({
        id: subject.id,
        name: subject.name
      }))
    }))
  }));
}

async function signedAsset(client, bucket, path) {
  if (!path) return "";
  const { data, error } = await client.storage.from(bucket).createSignedUrl(path, 3600);
  throwIfError(error);
  return data.signedUrl;
}

async function mapResource(client, row, favorite = false) {
  const bucket = row.storage_bucket;
  return {
    id: row.id,
    type: row.kind,
    title: row.title,
    author: row.author || "",
    description: row.description || "",
    category: row.departments?.name || "",
    level: row.levels?.name || "",
    subject: row.subjects?.name || "",
    departmentId: row.department_id,
    levelId: row.level_id,
    subjectId: row.subject_id,
    extension: row.extension,
    size: row.size_bytes,
    downloads: row.downloads || 0,
    uploadedAt: row.created_at,
    fileUrl: await signedAsset(client, bucket, row.storage_path),
    favorite
  };
}

async function getResources(kind, admin = false, currentUser = null) {
  const client = await getSupabase();
  const query = client.from("resources").select("*,departments(name),levels(name),subjects(name)").eq("kind", kind).order("created_at", { ascending: false });
  const { data, error } = await query;
  throwIfError(error);
  const user = admin ? null : currentUser || await activeUser();
  let saved = new Set();
  if (user && kind === "book" && data.length) {
    const result = await client.from("favorites").select("resource_id").eq("user_id", user.id).in("resource_id", data.map((item) => item.id));
    throwIfError(result.error);
    saved = new Set(result.data.map((item) => item.resource_id));
  }
  return Promise.all(data.map((item) => mapResource(client, item, saved.has(item.id))));
}

async function storeFiles(client, bucket, paths) {
  if (!paths.length) return;
  const { error } = await client.storage.from(bucket).remove(paths);
  throwIfError(error);
}

async function api(url, options = {}) {
  const client = await getSupabase();
  const method = options.method || "GET";
  const path = new URL(url, location.origin).pathname;
  const id = decodeURIComponent(path.split("/").filter(Boolean).at(-1) || "");
  const body = options.body instanceof FormData ? options.body : options.body ? JSON.parse(options.body) : {};
  const currentUser = ["/api/auth/register", "/api/auth/login", "/api/auth/logout"].includes(path) ? null : await activeUser();

  if (path === "/api/auth/register" && method === "POST") {
    const { data, error } = await client.auth.signUp({
      email: body.email,
      password: body.password,
      options: { data: { name: String(body.name || "").trim() } }
    });
    throwIfError(error);
    if (!data.session) return { user: null, confirmationRequired: true };
    await bootstrapAdministrator(client);
    return { user: await activeUser() };
  }
  if (path === "/api/auth/login" && method === "POST") {
    const { error } = await client.auth.signInWithPassword({ email: body.email, password: body.password });
    throwIfError(error);
    await bootstrapAdministrator(client);
    return { user: await activeUser() };
  }
  if (path === "/api/auth/logout" && method === "POST") {
    const { error } = await client.auth.signOut();
    throwIfError(error);
    return { ok: true };
  }
  if (path === "/api/me") return { user: currentUser };

  if (path === "/api/departments" || path === "/api/admin/departments") {
    if (method === "GET") return { departments: await departmentTree(client) };
  }
  if (path === "/api/books" && method === "GET") return { books: await getResources("book", false, currentUser) };
  if (path === "/api/videos" && method === "GET") return { videos: await getResources("video", false, currentUser) };

  if (path === "/api/about" || path === "/api/admin/about") {
    const { data, error } = await client.from("developers").select("*").order("sort_order");
    throwIfError(error);
    const developers = await Promise.all(data.map(async (developer) => ({
      ...developer,
      photoUrl: await signedAsset(client, "profile-photos", developer.photo_path),
      photo: developer.photo_path || ""
    })));
    return { developers };
  }

  if (path === "/api/activity" && method === "GET") {
    const { data, error } = await client.from("activity").select("action,created_at,resources(title)").eq("user_id", currentUser.id).order("created_at", { ascending: false }).limit(100);
    throwIfError(error);
    return { activity: data.map((item) => ({ action: item.action, title: item.resources?.title || "Library resource", at: item.created_at })) };
  }
  if (path === "/api/activity" && method === "POST") {
    const { error } = await client.from("activity").insert({ user_id: currentUser.id, resource_id: body.resourceId, action: body.action });
    throwIfError(error);
    return { ok: true };
  }
  if (path === "/api/admin/bootstrap" && method === "POST") return bootstrapAdministrator(client);

  if (path === "/api/admin/stats" && method === "GET") {
    const [books, videos, users, downloads, reads] = await Promise.all([
      client.from("resources").select("id", { count: "exact", head: true }).eq("kind", "book"),
      client.from("resources").select("id", { count: "exact", head: true }).eq("kind", "video"),
      client.from("profiles").select("id", { count: "exact", head: true }).eq("role", "student"),
      client.from("activity").select("id", { count: "exact", head: true }).eq("action", "downloaded"),
      client.from("activity").select("id", { count: "exact", head: true }).eq("action", "opened")
    ]);
    [books, videos, users, downloads, reads].forEach((result) => throwIfError(result.error));
    return { books: books.count, videos: videos.count, users: users.count, downloads: downloads.count, reads: reads.count };
  }
  if (path === "/api/admin/users" && method === "GET") {
    const { data: { session } } = await client.auth.getSession();
    const response = await fetch("/api/admin/users", { headers: { Authorization: `Bearer ${session.access_token}` } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load student accounts.");
    if (currentUser.role !== "admin") throw new Error("Administrator access is required.");
    return result;
  }
  const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userMatch && ["PATCH", "DELETE"].includes(method)) {
    const { data: { session } } = await client.auth.getSession();
    const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
      method,
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: method === "PATCH" ? JSON.stringify(body) : undefined
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not update this account.");
    return result;
  }

  const adminResourceMatch = path.match(/^\/api\/admin\/(books|videos)(?:\/([^/]+))?$/);
  if (adminResourceMatch) {
    const kind = adminResourceMatch[1] === "books" ? "book" : "video";
    const resourceId = adminResourceMatch[2];
    if (!resourceId && method === "GET") return { [adminResourceMatch[1]]: await getResources(kind, true) };
    if (!resourceId && method === "POST" && body instanceof FormData) {
      const file = body.get("file");
      const title = String(body.get("title") || file?.name?.replace(/\.[^.]+$/, "") || "").trim();
      const ext = `.${file?.name?.split(".").pop()?.toLowerCase() || ""}`;
      const allowed = kind === "book"
        ? [".pdf",".doc",".docx",".ppt",".pptx",".pptm",".xls",".xlsx",".txt",".rtf",".csv",".md",".epub",".odt",".ods",".odp",".jpg",".jpeg",".png"]
        : [".mp4",".webm",".mov",".m4v"];
      const allowedMime = kind === "book" ? {
        ".pdf": ["application/pdf"], ".doc": ["application/msword"],
        ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
        ".ppt": ["application/vnd.ms-powerpoint"],
        ".pptx": ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
        ".pptm": ["application/vnd.ms-powerpoint.presentation.macroEnabled.12"],
        ".xls": ["application/vnd.ms-excel"],
        ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
        ".txt": ["text/plain"], ".rtf": ["text/rtf", "application/rtf"],
        ".csv": ["text/csv", "application/vnd.ms-excel"], ".md": ["text/markdown", "text/plain"],
        ".epub": ["application/epub+zip"], ".odt": ["application/vnd.oasis.opendocument.text"],
        ".ods": ["application/vnd.oasis.opendocument.spreadsheet"],
        ".odp": ["application/vnd.oasis.opendocument.presentation"],
        ".jpg": ["image/jpeg"], ".jpeg": ["image/jpeg"], ".png": ["image/png"]
      } : {
        ".mp4": ["video/mp4"], ".webm": ["video/webm"], ".mov": ["video/quicktime"],
        ".m4v": ["video/x-m4v", "video/mp4"]
      };
      const maximum = kind === "book" ? 50 * 1024 * 1024 : 300 * 1024 * 1024;
      if (!(file instanceof File) || !allowed.includes(ext) || (file.type && !allowedMime[ext].includes(file.type)) || file.size > maximum || !title) throw new Error("Choose a supported file within the upload size limit and enter a title.");
      const departmentId = body.get("departmentId"), levelId = body.get("levelId"), subjectId = body.get("subjectId");
      const assetPath = `${crypto.randomUUID()}${ext}`;
      const bucket = kind === "book" ? "books" : "videos";
      const uploaded = await client.storage.from(bucket).upload(assetPath, file, { contentType: file.type || allowedMime[ext][0], upsert: false });
      throwIfError(uploaded.error);
      const inserted = await client.from("resources").insert({
        kind, title, author: kind === "book" ? String(body.get("author") || "").trim() : "",
        description: String(body.get("description") || "").trim(), department_id: departmentId, level_id: levelId,
        subject_id: subjectId, original_name: file.name, extension: ext, size_bytes: file.size,
        storage_bucket: bucket, storage_path: assetPath, uploaded_by: currentUser.id
      }).select("*,departments(name),levels(name),subjects(name)").single();
      if (inserted.error) {
        await client.storage.from(bucket).remove([assetPath]);
        throwIfError(inserted.error);
      }
      const result = await mapResource(client, inserted.data);
      return kind === "book" ? { book: result } : { video: result };
    }
    if (resourceId && method === "PATCH") {
      const update = {};
      if (body.title) update.title = String(body.title).trim();
      if (body.departmentId) {
        update.department_id = body.departmentId;
        update.level_id = body.levelId;
        update.subject_id = body.subjectId;
      }
      const result = await client.from("resources").update(update).eq("id", resourceId).eq("kind", kind).select("id").single();
      throwIfError(result.error);
      return { ok: true };
    }
    if (resourceId && method === "DELETE") {
      const result = await client.from("resources").select("storage_bucket,storage_path").eq("id", resourceId).eq("kind", kind).single();
      throwIfError(result.error);
      await storeFiles(client, result.data.storage_bucket, [result.data.storage_path]);
      const removed = await client.from("resources").delete().eq("id", resourceId).eq("kind", kind);
      throwIfError(removed.error);
      return { ok: true };
    }
  }

  const favoriteMatch = path.match(/^\/api\/books\/([^/]+)\/favorite$/);
  if (favoriteMatch && method === "PUT") {
    const { data, error } = await client.from("favorites").select("id").eq("user_id", currentUser.id).eq("resource_id", favoriteMatch[1]).maybeSingle();
    throwIfError(error);
    if (data) {
      const result = await client.from("favorites").delete().eq("id", data.id);
      throwIfError(result.error);
    } else {
      const result = await client.from("favorites").insert({ user_id: user.id, resource_id: favoriteMatch[1] });
      throwIfError(result.error);
    }
    return { ok: true };
  }

  if (path === "/api/admin/about" && method === "PUT") {
    const updates = await Promise.all(body.developers.map((developer) =>
      client.from("developers").update({
        name: developer.name.trim(), role: developer.role.trim(), bio: developer.bio.trim(), accent: developer.accent
      }).eq("id", developer.id)
    ));
    updates.forEach((result) => throwIfError(result.error));
    return { ok: true };
  }
  if (path === "/api/admin/about/photo" && method === "POST" && body instanceof FormData) {
    const file = body.get("file"), developerId = body.get("developerId");
    const ext = `.${file?.name?.split(".").pop()?.toLowerCase() || ""}`;
    if (!(file instanceof File) || ![".jpg", ".jpeg", ".png"].includes(ext) || (file.type && file.type !== "image/jpeg" && file.type !== "image/png") || file.size > 5 * 1024 * 1024) throw new Error("Choose a JPG or PNG photo under 5 MB.");
    const assetPath = `${developerId}/${crypto.randomUUID()}${ext}`;
    const upload = await client.storage.from("profile-photos").upload(assetPath, file, { contentType: file.type || (ext === ".png" ? "image/png" : "image/jpeg"), upsert: false });
    throwIfError(upload.error);
    const previous = await client.from("developers").select("photo_path").eq("id", developerId).single();
    throwIfError(previous.error);
    const saved = await client.from("developers").update({ photo_path: assetPath }).eq("id", developerId).select("*").single();
    if (saved.error) {
      await client.storage.from("profile-photos").remove([assetPath]);
      throwIfError(saved.error);
    }
    if (previous.data.photo_path) await storeFiles(client, "profile-photos", [previous.data.photo_path]);
    return { developer: { ...saved.data, photo: assetPath, photoUrl: await signedAsset(client, "profile-photos", assetPath) } };
  }
  const photoDelete = path.match(/^\/api\/admin\/about\/photo\/([^/]+)$/);
  if (photoDelete && method === "DELETE") {
    const previous = await client.from("developers").select("*").eq("id", photoDelete[1]).single();
    throwIfError(previous.error);
    if (previous.data.photo_path) await storeFiles(client, "profile-photos", [previous.data.photo_path]);
    const saved = await client.from("developers").update({ photo_path: null }).eq("id", photoDelete[1]).select("*").single();
    throwIfError(saved.error);
    return { developer: { ...saved.data, photo: "", photoUrl: "" } };
  }

  const hierarchy = path.match(/^\/api\/admin\/(departments|levels|subjects)(?:\/([^/]+))?(?:\/(levels|subjects))?$/);
  if (hierarchy) {
    const [, type, objectId, childType] = hierarchy;
    const table = childType || type;
    if (method === "POST") {
      const parentId = objectId;
      const values = { name: String(body.name || "").trim() };
      if (!values.name) throw new Error("A name is required.");
      if (!childType && type === "departments") {
        const result = await client.from(table).insert(values).select("*").single();
        throwIfError(result.error);
        return { department: result.data };
      }
      values[table === "levels" ? "department_id" : "level_id"] = parentId;
      const result = await client.from(table).insert(values).select("*").single();
      throwIfError(result.error);
      return { [table === "levels" ? "level" : "subject"]: result.data };
    }
    if (objectId && method === "PATCH") {
      const result = await client.from(table).update({ name: String(body.name || "").trim() }).eq("id", objectId).select("*").single();
      throwIfError(result.error);
      return { ok: true };
    }
    if (objectId && method === "DELETE") {
      let resourceQuery = client.from("resources").select("storage_bucket,storage_path");
      if (type === "departments") resourceQuery = resourceQuery.eq("department_id", objectId);
      if (type === "levels") resourceQuery = resourceQuery.eq("level_id", objectId);
      if (type === "subjects") resourceQuery = resourceQuery.eq("subject_id", objectId);
      const resources = await resourceQuery;
      throwIfError(resources.error);
      for (const bucket of ["books", "videos"]) {
        const paths = resources.data.filter((resource) => resource.storage_bucket === bucket).map((resource) => resource.storage_path);
        await storeFiles(client, bucket, paths);
      }
      const result = await client.from(table).delete().eq("id", objectId);
      throwIfError(result.error);
      return { ok: true };
    }
  }
  throw new Error("This library action is not available.");
}

async function bootstrapAdministrator(client) {
  const { data: { session } } = await client.auth.getSession();
  if (!session) return;
  const response = await fetch("/api/admin/bootstrap", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.access_token}` }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Could not verify administrator access.");
}

function showAuth() {
  state.user = null;


  app.classList.add("is-hidden");
  authScreen.classList.remove("is-hidden");
  setAuthMode("login");
}

function setAuthMode(mode) {
  
  state.authMode = mode; 












  const registering = mode === "register";
  $("#name-field").classList.toggle("is-hidden", !registering);
  $('[name="name"]', authForm).required = registering;
  $("#auth-kicker").textContent = registering ? "START SOMETHING GREAT" : "WELCOME BACK";
  $("#auth-title").textContent = registering ? "Your library awaits." : "Good to see you.";
  $("#auth-subtitle").textContent = registering ? "Create your account and explore." : "Sign in to continue your learning journey.";
  $("#auth-submit-label").textContent = registering ? "Create account" : "Log in";
  $('[name="password"]', authForm).autocomplete = registering ? "new-password" : "current-password";
  $$(".auth-tab").forEach((button) => {
    const active = button.dataset.authMode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#auth-message").textContent = "";
}

async function loadLibrary() {
  const result = await api("/api/books");
  state.books = result.books;
  if (state.view !== "admin") renderPage();
  renderDepartments();
}

async function loadDepartments() {
  const result = await api("/api/departments");
  state.departments = result.departments || [];
  if (!state.departments.some((department) => department.id === state.departmentId)) {
    state.departmentId = "";
    state.category = "All departments";
  } else {
    state.category = state.departments.find((department) => department.id === state.departmentId).name;
  }
  renderDepartments();
  if (["home", "department-levels", "department-subjects"].includes(state.view)) renderPage();
}

async function loadAbout() {
  const result = await api("/api/about");
  state.developers = result.developers || [];
}

async function loadVideos() {
  const result = await api("/api/videos");
  state.videos = result.videos;
  if (state.view === "videos") renderVideos();
}

async function enterLibrary(user) {
  state.user = user;
  authScreen.classList.add("is-hidden");
  app.classList.remove("is-hidden");
  $("#sidebar-name").textContent = user.name;
  $("#sidebar-role").textContent = user.role === "admin" ? "Library administrator" : "Student account";
  $("#sidebar-avatar").textContent = initials(user.name);
  $("#topbar-avatar").textContent = initials(user.name);
  const oldAdminLink = $('[data-view="admin"]');
  if (oldAdminLink) oldAdminLink.remove();
  if (user.role === "admin") {
    const adminLink = document.createElement("button");
    adminLink.className = "nav-link";
    adminLink.dataset.view = "admin";
    adminLink.innerHTML = '<span class="nav-icon">⚙</span>Admin dashboard';
    $(".nav-list").append(adminLink);
  }
  state.view = "home";
  state.category = "All departments";
  await Promise.all([loadAbout(), loadLibrary(), loadVideos(), loadDepartments()]);
}

function renderDepartments() {
  $("#department-nav").innerHTML = state.departments.map((department) => `
    <button class="nav-link${["department-levels", "department-subjects", "subject-books"].includes(state.view) && state.departmentId === department.id ? " is-active" : ""}" data-department="${escapeHTML(department.id)}">
      <span class="nav-icon">↗</span>${escapeHTML(department.name)}
    </button>`).join("");
}

function booksForDepartment(department) {
  return state.books.filter((book) => book.category === department);
}

function renderDepartmentLevels() {
  const department = state.departments.find((item) => item.id === state.departmentId);
  if (!department) return renderHome();
  const books = booksForDepartment(state.category);
  const levels = department.levels || [];
  $("#breadcrumb-current").textContent = department.name;
  pageContent.innerHTML = `
    <div class="page-intro"><span class="eyebrow">DEPARTMENT LIBRARY</span><h1>${escapeHTML(department.name)}</h1><p>Choose a level to browse its subjects.</p></div>
    <div class="hierarchy-grid">
      ${levels.length ? levels.map((level) => `
        <button class="hierarchy-card" data-level="${escapeHTML(level.id)}">
          <span class="hierarchy-card-icon">▤</span>
          <span><strong>${escapeHTML(level.name)}</strong><small>${books.filter((book) => book.levelId === level.id).length} resources</small></span>
          <span class="hierarchy-card-arrow">→</span>
        </button>`).join("") : '<div class="empty-state"><strong>No levels in this department yet</strong>Add levels from the administrator dashboard.</div>'}
    </div>`;
  syncNavigation();
}

function renderDepartmentSubjects() {
  const department = state.departments.find((item) => item.id === state.departmentId);
  const level = department?.levels.find((item) => item.id === state.selectedLevel);
  if (!department || !level) return renderDepartmentLevels();
  const books = booksForDepartment(state.category).filter((book) => book.levelId === level.id);
  const subjects = level.subjects || [];
  $("#breadcrumb-current").textContent = `${department.name} / ${level.name}`;
  pageContent.innerHTML = `
    <div class="hierarchy-breadcrumb"><button class="text-button" data-back-to-levels>← ${escapeHTML(department.name)}</button></div>
    <div class="page-intro"><span class="eyebrow">${escapeHTML(department.name)}</span><h1>${escapeHTML(level.name)}</h1><p>Choose a subject to open its learning resources.</p></div>
    <div class="hierarchy-grid">
      ${subjects.length ? subjects.map((subject) => `
        <button class="hierarchy-card" data-subject="${escapeHTML(subject.id)}">
          <span class="hierarchy-card-icon">▧</span>
          <span><strong>${escapeHTML(subject.name)}</strong><small>${books.filter((book) => book.subjectId === subject.id).length} resources</small></span>
          <span class="hierarchy-card-arrow">→</span>
        </button>`).join("") : '<div class="empty-state"><strong>No subjects in this level yet</strong>Add subjects from the administrator dashboard.</div>'}
    </div>`;
  syncNavigation();
}

function bookTone(category) {
  let total = 0;
  for (const character of category) total = (total * 31 + character.charCodeAt(0)) >>> 0;
  return COVER_TONES[total % COVER_TONES.length];
}

function bookCard(book) {
  const extension = book.extension.replace(".", "").toUpperCase();
  const tone = bookTone(book.category);
  const glyph = escapeHTML((book.title.trim()[0] || "N").toUpperCase());
  return `
    <article class="book-card" data-open-book="${book.id}" tabindex="0" role="button" aria-label="Open ${escapeHTML(book.title)}">
      <div class="book-cover cover-${tone}">
        <span class="cover-glyph">${glyph}</span><span class="cover-type">${escapeHTML(extension)}</span>
        <button class="favorite-button${book.favorite ? " is-saved" : ""}" data-favorite="${book.id}" aria-label="${book.favorite ? "Remove saved book" : "Save book"}" title="${book.favorite ? "Remove from saved" : "Save book"}">${book.favorite ? "♥" : "♡"}</button>
      </div>
      <h3>${escapeHTML(book.title)}</h3>
      <p class="book-author">${escapeHTML(book.author || "Nasawa Technical College")}</p>
      <div class="book-meta"><span class="book-tag">${escapeHTML(book.category)}</span><span>${formatSize(book.size)}</span></div>
    </article>`;
}

function visibleBooks() {
  let books = [...state.books];
  if (state.view === "saved") books = books.filter((book) => book.favorite);
  if (state.view === "category") books = books.filter((book) => book.category === state.category);
  if (state.view === "subject-books") {
    books = books.filter((book) => {
      return book.departmentId === state.departmentId && book.levelId === state.selectedLevel && book.subjectId === state.selectedSubject;
    });
  }
  if (state.query) {
    const query = state.query.toLocaleLowerCase();
    books = books.filter((book) => [book.title, book.author, book.category, book.description].some((value) => (value || "").toLocaleLowerCase().includes(query)));
  }
  return books.sort((left, right) => new Date(right.uploadedAt) - new Date(left.uploadedAt));
}

// Render cards from the current search, department, and saved-book filters.
function cardsMarkup(books) {
  if (!books.length) {
    const title = state.view === "saved" ? "Nothing saved just yet" : "Your library is ready to grow";
    const detail = state.query ? "Try a different search term." : state.user.role === "admin" ? "Add your first learning resource from the admin dashboard." : "Check back soon for learning resources from your department.";
    return `<div class="empty-state"><strong>${title}</strong>${detail}</div>`;
  }
  return books.map(bookCard).join("");
}

function renderAbout() {
  $("#breadcrumb-current").textContent = "About";
  const developers = state.developers.length ? state.developers : [
    { id: "richard-cameron", name: "Richard Cameron", role: "Lead Developer & Systems Architect", bio: "Builds the library experience, product flow, and technical systems behind a smooth learning environment.", accent: "sage" },
    { id: "joshua", name: "Joshua", role: "Co-Developer & Product Partner", bio: "Helps shape the academic experience, feature planning, and student-first improvements across the platform.", accent: "gold" }
  ];
  pageContent.innerHTML = `
    <div class="page-intro"><span class="eyebrow">WHO BUILT THIS</span><h1>About the development team</h1><p>We created this library to support practical learning, digital access, and a stronger student experience.</p></div>
    <div class="team-grid">
      ${developers.map((developer) => `
        <article class="team-card ${developer.accent || "sage"}">
          <div class="member-photo">${developer.photo ? `<img src="${escapeHTML(developer.photoUrl)}" alt="${escapeHTML(developer.name)}">` : escapeHTML(initials(developer.name))}</div>
          <div class="member-meta">
            <h3>${escapeHTML(developer.name)}</h3>
            <p class="member-role">${escapeHTML(developer.role)}</p>
            <p class="member-bio">${escapeHTML(developer.bio)}</p>
          </div>
        </article>`).join("")}
    </div>`;
  syncNavigation();
}

function renderVideos() {
  $("#breadcrumb-current").textContent = "Video lessons";
  const departments = state.departments;
  const query = state.query.toLocaleLowerCase();
  const videos = state.videos.filter((video) => (
    (state.videoCategory === "All departments" || video.departmentId === state.videoCategory)
    && (!query || [video.title, video.category, video.description].some((value) => (value || "").toLocaleLowerCase().includes(query)))
  ));
  pageContent.innerHTML = `
    <div class="page-intro"><span class="eyebrow">WATCH AND LEARN</span><h1>Video lessons</h1><p>Explore practical lessons uploaded for each department.</p></div>
    <label class="field video-filter">Department
      <select id="video-department-filter">
        <option ${state.videoCategory === "All departments" ? "selected" : ""}>All departments</option>
        ${departments.map((department) => `<option value="${escapeHTML(department.id)}" ${state.videoCategory === department.id ? "selected" : ""}>${escapeHTML(department.name)}</option>`).join("")}
      </select>
    </label>
    <div class="video-grid">
      ${videos.length ? videos.map((video) => `
        <article class="video-card">
          <video controls preload="metadata" playsinline data-resource-video="${escapeHTML(video.id)}" src="${escapeHTML(video.fileUrl)}">${escapeHTML(video.title)}</video>
          <div class="video-card-copy"><span class="book-tag">${escapeHTML(video.category)}</span><h2>${escapeHTML(video.title)}</h2>
            ${video.description ? `<p>${escapeHTML(video.description)}</p>` : ""}
          </div>
        </article>`).join("") : '<div class="empty-state"><strong>No video lessons yet</strong>Videos added by the library administrator will appear here.</div>'}
    </div>`;
  syncNavigation();
}

function renderHome() {
  const books = visibleBooks();
  const department = state.departments.find((item) => item.id === state.departmentId);
  const level = department?.levels.find((item) => item.id === state.selectedLevel);
  const subject = level?.subjects.find((item) => item.id === state.selectedSubject);
  const subjectVideos = state.view === "subject-books" ? state.videos.filter((video) => (
    video.departmentId === state.departmentId && video.levelId === state.selectedLevel && video.subjectId === state.selectedSubject
    && (!state.query || [video.title, video.description].some((value) => (value || "").toLocaleLowerCase().includes(state.query.toLocaleLowerCase())))
  )) : [];
  const categoryCount = new Set(state.books.map((book) => book.category)).size;
  const savedCount = state.books.filter((book) => book.favorite).length;
  const heading = state.view === "saved" ? "Saved books" : state.view === "category" ? state.category : state.view === "subject-books" ? subject?.name || "Subject" : "Explore the collection";
  const description = state.view === "saved" ? "Your personal reading list, all in one place." : state.view === "category" ? "Resources from this department." : state.view === "subject-books" ? `${department?.name || ""} · ${level?.name || ""}` : "Practical knowledge for every path you're building.";
  $("#breadcrumb-current").textContent = state.view === "saved" ? "Saved books" : state.view === "category" ? state.category : state.view === "subject-books" ? `${department?.name || ""} / ${level?.name || ""} / ${subject?.name || ""}` : "Discover";
  pageContent.innerHTML = `
    ${state.view === "home" ? `
      <section class="welcome-banner">
        <div class="banner-copy"><span class="eyebrow">YOUR CAMPUS. YOUR NEXT CHAPTER.</span><h1>Welcome in, ${escapeHTML(state.user.name.split(/\s+/)[0])}.</h1><p>Find the knowledge that moves your future forward.</p></div>
        <div class="banner-decoration" aria-hidden="true">✳</div>
      </section>
      <div class="stats-strip">
        <div class="stat-item"><span class="stat-icon">▤</span><span><strong class="stat-value">${state.books.length}</strong><span class="stat-label">Learning resources</span></span></div>
        <div class="stat-item"><span class="stat-icon">⌘</span><span><strong class="stat-value">${categoryCount}</strong><span class="stat-label">Departments</span></span></div>
        <div class="stat-item"><span class="stat-icon">♡</span><span><strong class="stat-value">${savedCount}</strong><span class="stat-label">Saved for later</span></span></div>
      </div>
      <div class="section-heading"><div><h2>Browse by department</h2><p>Find resources for what you're learning.</p></div></div>
      <div class="category-pills">
        <button class="category-pill${state.category === "All departments" ? " is-active" : ""}" data-category="All departments">All departments</button>
        ${state.departments.map((department) => `<button class="category-pill${state.departmentId === department.id ? " is-active" : ""}" data-department="${escapeHTML(department.id)}">${escapeHTML(department.name)}</button>`).join("")}
      </div>` : `
      <div class="page-intro"><span class="eyebrow">NASAWA LIBRARY</span><h1>${escapeHTML(heading)}</h1><p>${escapeHTML(description)}</p></div>`}
    ${state.view === "subject-books" ? `<div class="hierarchy-breadcrumb"><button class="text-button" data-back-to-subjects>← ${escapeHTML(level?.name || "Level")} subjects</button></div>` : ""}
    <div class="section-heading"><div><h2>${state.view === "home" ? "Recently added" : `${books.length} ${books.length === 1 ? "resource" : "resources"}`}</h2><p>${state.view === "home" ? "A fresh place to start." : "Explore and keep learning."}</p></div>${state.user.role === "admin" && state.view === "home" ? '<button class="button button-quiet button-small" data-action="upload">＋ Add resource</button>' : ""}</div>
    <div class="book-grid">${cardsMarkup(state.view === "home" ? books.slice(0, 8) : books)}</div>
    ${state.view === "subject-books" ? `<div class="video-grid subject-video-grid">${subjectVideos.map((video) => `<article class="video-card"><video controls preload="metadata" playsinline data-resource-video="${escapeHTML(video.id)}" src="${escapeHTML(video.fileUrl)}">${escapeHTML(video.title)}</video><div class="video-card-copy"><h2>${escapeHTML(video.title)}</h2>${video.description ? `<p>${escapeHTML(video.description)}</p>` : ""}</div></article>`).join("")}</div>` : ""}
    ${state.view === "home" && books.length > 8 ? '<div class="section-heading"><button class="text-button" data-view="all-books">View all resources →</button></div>' : ""}`;
  syncNavigation();
}

async function renderActivity() {
  $("#breadcrumb-current").textContent = "My activity";
  pageContent.innerHTML = '<div class="page-intro"><span class="eyebrow">YOUR LEARNING JOURNEY</span><h1>My activity</h1><p>Your recently opened and downloaded resources.</p></div><div class="activity-list"><div class="empty-state">Loading your activity…</div></div>';
  syncNavigation();
  try {
    const { activity } = await api("/api/activity");
    if (state.view !== "activity") return;
    $(".activity-list").innerHTML = activity.length ? activity.map((item) => `
      <div class="activity-row"><span class="activity-icon">${item.action === "downloaded" ? "↓" : "◉"}</span><div><strong>${escapeHTML(item.title)}</strong><p>${item.action === "downloaded" ? "Downloaded" : "Opened"} · ${formatDate(item.at)}</p></div></div>`).join("") : '<div class="empty-state"><strong>Your story starts here</strong>Open or download a book and it will show up here.</div>';
  } catch (error) {
    notify(error.message, true);
  }
}

function syncNavigation() {
  $$(".nav-link", $(".nav-list")).forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === state.view);
  });
  $$(".nav-link", $("#department-nav")).forEach((button) => {
    button.classList.toggle("is-active", ["department-levels", "department-subjects", "subject-books"].includes(state.view) && button.dataset.department === state.departmentId);
  });
}

async function renderAdmin() {
  $("#breadcrumb-current").textContent = "Admin dashboard";
  pageContent.innerHTML = '<div class="empty-state">Loading dashboard…</div>';
  syncNavigation();
  try {
    const stats = await api("/api/admin/stats");
    const isBooks = state.adminTab === "books";
    const isUsers = state.adminTab === "users";
    const isVideos = state.adminTab === "videos";
    const isAbout = state.adminTab === "about";
    const isDepartments = state.adminTab === "departments";
    pageContent.innerHTML = `
      <div class="section-heading">
        <div class="page-intro"><span class="eyebrow">LIBRARY MANAGEMENT</span><h1>Admin dashboard</h1><p>Manage learning resources, people, and the campus story.</p></div>
        <div class="admin-toolbar">
          ${isBooks ? '<button class="button button-primary button-small" data-action="upload">＋ Upload resource</button>' : ""}
          ${isVideos ? '<button class="button button-primary button-small" data-action="upload-video">＋ Upload video</button>' : ""}
          <button class="button button-quiet button-small" data-action="manage-users">Manage users</button>
        </div>
      </div>
      <div class="admin-overview">
        <div class="admin-stat"><span>Library resources</span><strong>${stats.books}</strong></div>
        <div class="admin-stat"><span>Video lessons</span><strong>${stats.videos}</strong></div>
        <div class="admin-stat"><span>Student accounts</span><strong>${stats.users}</strong></div>
        <div class="admin-stat"><span>Downloads</span><strong>${stats.downloads}</strong></div>
        <div class="admin-stat"><span>Online reads</span><strong>${stats.reads}</strong></div>
      </div>
      <div class="admin-tabs">
        <button class="admin-tab${isBooks ? " is-active" : ""}" data-admin-tab="books">Library catalog</button>
        <button class="admin-tab${isVideos ? " is-active" : ""}" data-admin-tab="videos">Video lessons</button>
        <button class="admin-tab${isDepartments ? " is-active" : ""}" data-admin-tab="departments">Departments</button>
        <button class="admin-tab${isUsers ? " is-active" : ""}" data-admin-tab="users">User accounts</button>
        <button class="admin-tab${isAbout ? " is-active" : ""}" data-admin-tab="about">About team</button>
      </div>
      <div class="admin-panel" id="admin-panel"><div class="empty-state">Loading…</div></div>`;
    await renderAdminTable();
  } catch (error) {
    pageContent.innerHTML = `<div class="empty-state"><strong>Dashboard unavailable</strong>${escapeHTML(error.message)}</div>`;
  }
}

async function renderAdminTable() {
  const panel = $("#admin-panel");
  if (!panel) return;
  if (state.adminTab === "departments") return renderAdminDepartments();
  if (state.adminTab === "about") {
    const { developers } = await api("/api/admin/about");
    panel.innerHTML = `
      <div class="admin-panel-header"><h2>Development team</h2><span>${developers.length} team profiles</span></div>
      <form id="about-form" class="about-form">
        <div class="about-fields">
          ${developers.map((developer, index) => `
            <fieldset class="developer-editor" data-developer-id="${escapeHTML(developer.id)}" data-developer-index="${index}">
              <legend>${escapeHTML(developer.name || `Developer ${index + 1}`)}</legend>
              <div class="profile-photo-editor">
                <div class="member-photo">${developer.photo ? `<img src="${escapeHTML(developer.photoUrl)}" alt="${escapeHTML(developer.name)}">` : escapeHTML(initials(developer.name))}</div>
                <div class="profile-photo-actions">
                  <label class="button button-quiet button-small">Change photo<input type="file" accept=".jpg,.jpeg,.png" data-developer-photo="${escapeHTML(developer.id)}" hidden></label>
                  <button class="button button-danger button-small${developer.photo ? "" : " is-hidden"}" type="button" data-remove-photo="${escapeHTML(developer.id)}">Remove photo</button>
                </div>
              </div>
              <label class="field">Name<input name="name-${index}" value="${escapeHTML(developer.name || "")}" maxlength="80"></label>
              <label class="field">Role<input name="role-${index}" value="${escapeHTML(developer.role || "")}" maxlength="80"></label>
              <label class="field">Accent<select name="accent-${index}">
                ${["sage","sand","blue","rose","gold","lavender"].map((accent) => `<option value="${accent}" ${developer.accent === accent ? "selected" : ""}>${escapeHTML(accent)}</option>`).join("")}
              </select></label>
              <label class="field">Bio<textarea name="bio-${index}" rows="3" maxlength="300">${escapeHTML(developer.bio || "")}</textarea></label>
            </fieldset>`).join("")}
        </div>
        <div class="dialog-actions about-save-row"><button class="button button-primary" type="submit">Save profiles</button></div>
      </form>`;
    return;
  }
  const booksTab = state.adminTab === "books";
  const videosTab = state.adminTab === "videos";
  const data = await api(booksTab ? "/api/admin/books" : videosTab ? "/api/admin/videos" : "/api/admin/users");
  if (booksTab) {
    panel.innerHTML = `
      <div class="admin-panel-header"><h2>Library catalog</h2><span>${data.books.length} total resources</span></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>RESOURCE</th><th>DEPARTMENT</th><th>FORMAT</th><th>DOWNLOADS</th><th>ACTION</th></tr></thead>
      <tbody>${data.books.length ? data.books.map((book) => `<tr>
        <td><form class="resource-title-form" data-resource-kind="book" data-resource-id="${escapeHTML(book.id)}"><input name="title" value="${escapeHTML(book.title)}" maxlength="140" aria-label="Book title"><button class="button button-quiet button-small" type="submit">Save</button></form><br>${escapeHTML(book.author)}</td><td>${escapeHTML(book.category)} / ${escapeHTML(book.level)} / ${escapeHTML(book.subject)}</td>
        <td>${escapeHTML(book.extension.replace(".", "").toUpperCase())} · ${formatSize(book.size)}</td><td>${book.downloads}</td>
        <td><button class="button button-danger button-small" data-delete-book="${book.id}">Delete</button></td>
      </tr>`).join("") : '<tr><td colspan="5">No resources yet. Upload the first book to get started.</td></tr>'}</tbody></table></div>`;
  } else if (videosTab) {
    panel.innerHTML = `
      <div class="admin-panel-header"><h2>Video lessons</h2><span>${data.videos.length} total videos</span></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>VIDEO</th><th>DEPARTMENT</th><th>FORMAT</th><th>SIZE</th><th>ACTION</th></tr></thead>
      <tbody>${data.videos.length ? data.videos.map((video) => `<tr>
        <td><form class="resource-title-form" data-resource-kind="video" data-resource-id="${escapeHTML(video.id)}"><input name="title" value="${escapeHTML(video.title)}" maxlength="140" aria-label="Video title"><button class="button button-quiet button-small" type="submit">Save</button></form></td><td>${escapeHTML(video.category)} / ${escapeHTML(video.level)} / ${escapeHTML(video.subject)}</td>
        <td>${escapeHTML(video.extension.replace(".", "").toUpperCase())}</td><td>${formatSize(video.size)}</td>
        <td><button class="button button-danger button-small" data-delete-video="${escapeHTML(video.id)}">Delete</button></td>
      </tr>`).join("") : '<tr><td colspan="5">No videos yet. Upload the first department lesson.</td></tr>'}</tbody></table></div>`;
  } else {
    panel.innerHTML = `
      <div class="admin-panel-header"><h2>User accounts</h2><span>${data.users.length} accounts</span></div>
      <div class="table-wrap"><table class="data-table"><thead><tr><th>NAME</th><th>EMAIL</th><th>ROLE</th><th>STATUS</th><th>ACTION</th></tr></thead>
      <tbody>${data.users.length ? data.users.map((user) => `<tr>
        <td><strong>${escapeHTML(user.name)}</strong></td><td>${escapeHTML(user.email)}</td><td>${user.role === "admin" ? "Administrator" : "Student"}</td>
        <td><span class="status-badge${user.active ? "" : " is-inactive"}">${user.active ? "Active" : "Suspended"}</span></td>
        <td>${user.role === "admin" ? "—" : `<div class="table-actions"><button class="button button-quiet button-small" data-toggle-user="${user.id}" data-active="${user.active}">${user.active ? "Suspend" : "Restore"}</button><button class="button button-danger button-small" data-delete-user="${user.id}">Delete</button></div>`}</td>
      </tr>`).join("") : '<tr><td colspan="5">No accounts found.</td></tr>'}</tbody></table></div>`;
  }
}

async function renderAdminDepartments() {
  const panel = $("#admin-panel");
  const [{ departments }, { books }, { videos }] = await Promise.all([
    api("/api/admin/departments"), api("/api/admin/books"), api("/api/admin/videos")
  ]);
  panel.innerHTML = `
    <div class="admin-panel-header"><h2>Department structure</h2><span>${departments.length} departments</span></div>
    <form class="hierarchy-add-form" data-hierarchy-add="department"><label class="field">New department<input name="name" maxlength="100" required></label><button class="button button-primary button-small" type="submit">Add department</button></form>
    <div class="hierarchy-admin-list">
      ${departments.map((department) => `
        <section class="hierarchy-admin-department">
          <div class="hierarchy-admin-heading">
            <form class="hierarchy-edit-form" data-hierarchy-edit="department" data-id="${escapeHTML(department.id)}"><input name="name" value="${escapeHTML(department.name)}" maxlength="100" aria-label="Department name"><button class="button button-quiet button-small" type="submit">Save</button><button class="button button-danger button-small" type="button" data-delete-hierarchy="department" data-id="${escapeHTML(department.id)}">Delete</button></form>
            <form class="hierarchy-add-form" data-hierarchy-add="level" data-parent-id="${escapeHTML(department.id)}"><input name="name" maxlength="80" placeholder="New level" aria-label="New level name" required><button class="button button-quiet button-small" type="submit">Add level</button></form>
          </div>
          ${(department.levels || []).map((level) => `
            <section class="hierarchy-admin-level">
              <div class="hierarchy-admin-heading">
                <form class="hierarchy-edit-form" data-hierarchy-edit="level" data-id="${escapeHTML(level.id)}"><input name="name" value="${escapeHTML(level.name)}" maxlength="80" aria-label="Level name"><button class="button button-quiet button-small" type="submit">Save</button><button class="button button-danger button-small" type="button" data-delete-hierarchy="level" data-id="${escapeHTML(level.id)}">Delete</button></form>
                <form class="hierarchy-add-form" data-hierarchy-add="subject" data-parent-id="${escapeHTML(level.id)}"><input name="name" maxlength="100" placeholder="New subject" aria-label="New subject name" required><button class="button button-quiet button-small" type="submit">Add subject</button></form>
              </div>
              ${(level.subjects || []).map((subject) => {
                const subjectBooks = books.filter((book) => book.subjectId === subject.id);
                const subjectVideos = videos.filter((video) => video.subjectId === subject.id);
                const location = `data-department-id="${escapeHTML(department.id)}" data-level-id="${escapeHTML(level.id)}" data-subject-id="${escapeHTML(subject.id)}"`;
                const resourceLocationFields = (resource) => {
                  const selectedDepartment = state.departments.find((item) => item.id === resource.departmentId);
                  const selectedLevel = selectedDepartment?.levels.find((item) => item.id === resource.levelId);
                  return `<select name="departmentId" data-resource-department aria-label="Resource department">${state.departments.map((item) => `<option value="${escapeHTML(item.id)}" ${item.id === resource.departmentId ? "selected" : ""}>${escapeHTML(item.name)}</option>`).join("")}</select><select name="levelId" data-resource-level aria-label="Resource level">${(selectedDepartment?.levels || []).map((item) => `<option value="${escapeHTML(item.id)}" ${item.id === resource.levelId ? "selected" : ""}>${escapeHTML(item.name)}</option>`).join("")}</select><select name="subjectId" data-resource-subject aria-label="Resource subject">${(selectedLevel?.subjects || []).map((item) => `<option value="${escapeHTML(item.id)}" ${item.id === resource.subjectId ? "selected" : ""}>${escapeHTML(item.name)}</option>`).join("")}</select>`;
                };
                return `<section class="hierarchy-admin-subject">
                  <div class="hierarchy-admin-heading">
                    <form class="hierarchy-edit-form" data-hierarchy-edit="subject" data-id="${escapeHTML(subject.id)}"><input name="name" value="${escapeHTML(subject.name)}" maxlength="100" aria-label="Subject name"><button class="button button-quiet button-small" type="submit">Save</button><button class="button button-danger button-small" type="button" data-delete-hierarchy="subject" data-id="${escapeHTML(subject.id)}">Delete</button></form>
                    <span class="hierarchy-resource-count">${subjectBooks.length + subjectVideos.length} resources</span>
                  </div>
                  <div class="hierarchy-resource-actions"><button class="button button-quiet button-small" data-upload-subject="book" ${location}>＋ Book</button><button class="button button-quiet button-small" data-upload-subject="video" ${location}>＋ Video</button></div>
                  <div class="hierarchy-resource-list">
                    ${subjectBooks.map((book) => `<form class="resource-title-form" data-resource-kind="book" data-resource-id="${escapeHTML(book.id)}"><span>Book</span><input name="title" value="${escapeHTML(book.title)}" maxlength="140" aria-label="Book title">${resourceLocationFields(book)}<button class="button button-quiet button-small" type="submit">Save</button><button class="button button-danger button-small" type="button" data-delete-book="${escapeHTML(book.id)}">Delete</button></form>`).join("")}
                    ${subjectVideos.map((video) => `<form class="resource-title-form" data-resource-kind="video" data-resource-id="${escapeHTML(video.id)}"><span>Video</span><input name="title" value="${escapeHTML(video.title)}" maxlength="140" aria-label="Video title">${resourceLocationFields(video)}<button class="button button-quiet button-small" type="submit">Save</button><button class="button button-danger button-small" type="button" data-delete-video="${escapeHTML(video.id)}">Delete</button></form>`).join("")}
                    ${subjectBooks.length + subjectVideos.length ? "" : '<span class="hierarchy-resource-empty">No resources in this subject.</span>'}
                  </div>
                </section>`;
              }).join("")}
            </section>`).join("")}
          ${department.levels?.length ? "" : '<p class="hierarchy-resource-empty">No levels added.</p>'}
        </section>`).join("")}
    </div>`;
}

function renderPage() {
  if (!state.user) return;
  if (state.view === "about") return void renderAbout();
  if (state.view === "activity") return void renderActivity();
  if (state.view === "videos") return void renderVideos();
  if (state.view === "department-levels") return void renderDepartmentLevels();
  if (state.view === "department-subjects") return void renderDepartmentSubjects();
  if (state.view === "admin") return void renderAdmin();
  renderHome();
}

function setView(view, category = state.category) {
  state.view = view;
  state.category = category;
  if (view === "category") $("#breadcrumb-current").textContent = category;
  renderPage();
  $("#sidebar").classList.remove("is-open");
}

function dialogHeader(title) {
  return `<div class="dialog-header"><h2>${escapeHTML(title)}</h2><button class="icon-button" data-dialog-close aria-label="Close dialog">×</button></div>`;
}

function showBook(bookId) {
  const book = state.books.find((item) => item.id === bookId);
  if (!book) return;
  const dialog = $("#book-dialog");
  api("/api/activity", {
    method: "POST",
    body: JSON.stringify({ resourceId: book.id, action: "opened" })
  }).catch((error) => notify(error.message, true));
  const extension = book.extension;
  const canPreview = [".pdf", ".txt", ".md", ".csv", ".jpg", ".jpeg", ".png"].includes(extension);
  const fileUrl = book.fileUrl;
  let preview = "";
  if (canPreview) {
    if ([".txt", ".md", ".csv"].includes(extension)) {
      preview = `<iframe class="reader-frame" title="Preview ${escapeHTML(book.title)}" src="${fileUrl}"></iframe>`;
    } else if ([".jpg", ".jpeg", ".png"].includes(extension)) {
      preview = `<img class="reader-frame" alt="${escapeHTML(book.title)}" src="${fileUrl}">`;
    } else {
      preview = `<iframe class="reader-frame" title="Preview ${escapeHTML(book.title)}" src="${fileUrl}"></iframe>`;
    }
  } else {
    preview = '<div class="empty-state"><strong>Ready when you are</strong>This file format is available to download and open in your preferred app.</div>';
  }
  dialog.className = "dialog-shell book-dialog";
  dialog.innerHTML = `
    ${dialogHeader("Resource details")}
    <div class="dialog-body">
      <div class="book-cover dialog-book-cover cover-${bookTone(book.category)}"><span class="cover-glyph">${escapeHTML((book.title[0] || "N").toUpperCase())}</span><span class="cover-type">${escapeHTML(extension.slice(1).toUpperCase())}</span></div>
      <div class="dialog-book-copy"><h2>${escapeHTML(book.title)}</h2><p>${escapeHTML(book.author)} · ${escapeHTML(book.category)} · ${formatSize(book.size)}</p>
        ${book.description ? `<p>${escapeHTML(book.description)}</p>` : ""}
      </div>
      <div class="reader-content">${preview}</div>
    </div>
    <div class="dialog-actions">
      <button class="button button-quiet" data-dialog-close>Close</button>
      <a class="button button-primary" data-download-book="${escapeHTML(book.id)}" href="${fileUrl}" download>Download resource ↓</a>
    </div>`;
  dialog.showModal();
}

function showUploadDialog(type = "book", location = null) {
  const isVideo = type === "video";
  const formId = isVideo ? "video-upload-form" : "upload-form";
  const extensions = isVideo ? ".mp4,.webm,.mov,.m4v" : ".pdf,.doc,.docx,.ppt,.pptx,.pptm,.xls,.xlsx,.txt,.rtf,.csv,.md,.epub,.odt,.ods,.odp,.jpg,.jpeg,.png";
  const dialog = $("#upload-dialog");
  dialog.className = "dialog-shell upload-dialog";
  dialog.innerHTML = `
    ${dialogHeader(isVideo ? "Upload a department video" : "Add a learning resource")}
    <form id="${formId}">
      <div class="dialog-body">
        <label class="upload-drop" id="upload-drop" for="upload-file"><strong>Choose a file or drop it here</strong><span>${isVideo ? "MP4, WebM, MOV, or M4V · Up to 300 MB" : "PDF, Word, PowerPoint, Excel, EPUB, images and more · Up to 50 MB"}</span><input id="upload-file" name="file" type="file" accept="${extensions}" required hidden></label>
        <div class="upload-preview is-hidden" id="upload-preview"><span id="upload-file-name"></span><span id="upload-file-size"></span></div>
        <div class="upload-fields-row">
          <label class="field">${isVideo ? "Video title" : "Resource title"}<input name="title" maxlength="140" placeholder="e.g. Workshop safety essentials"></label>
          ${isVideo ? "" : '<label class="field">Author or publisher<input name="author" maxlength="100" placeholder="Nasawa Technical College"></label>'}
        </div>
        <div class="upload-location-row">
          <label class="field">Department<select name="departmentId" data-upload-department required><option value="">Select department</option>${state.departments.map((department) => `<option value="${escapeHTML(department.id)}">${escapeHTML(department.name)}</option>`).join("")}</select></label>
          <label class="field">Level<select name="levelId" data-upload-level required disabled><option value="">Select level</option></select></label>
          <label class="field">Subject<select name="subjectId" data-upload-subject required disabled><option value="">Select subject</option></select></label>
        </div>
        <label class="field upload-description-field">About this resource<textarea name="description" rows="3" maxlength="1200" placeholder="A short description to help students choose this resource."></textarea></label>
        <p class="form-message" id="upload-message" aria-live="polite"></p>
      </div>
      <div class="dialog-actions"><button class="button button-quiet" type="button" data-dialog-close>Cancel</button><button class="button button-primary" type="submit">${isVideo ? "Upload video ↑" : "Upload resource ↑"}</button></div>
    </form>`;
  dialog.showModal();
  const departmentSelect = $(`[data-upload-department]`, dialog);
  const levelSelect = $(`[data-upload-level]`, dialog);
  const subjectSelect = $(`[data-upload-subject]`, dialog);
  const fillSubjects = (levelId, subjectId = "") => {
    const department = state.departments.find((item) => item.id === departmentSelect.value);
    const level = department?.levels.find((item) => item.id === levelId);
    subjectSelect.innerHTML = `<option value="">Select subject</option>${(level?.subjects || []).map((subject) => `<option value="${escapeHTML(subject.id)}">${escapeHTML(subject.name)}</option>`).join("")}`;
    subjectSelect.disabled = !level;
    subjectSelect.value = subjectId;
  };
  const fillLevels = (departmentId, levelId = "", subjectId = "") => {
    const department = state.departments.find((item) => item.id === departmentId);
    levelSelect.innerHTML = `<option value="">Select level</option>${(department?.levels || []).map((level) => `<option value="${escapeHTML(level.id)}">${escapeHTML(level.name)}</option>`).join("")}`;
    levelSelect.disabled = !department;
    levelSelect.value = levelId;
    fillSubjects(levelId, subjectId);
  };
  departmentSelect.addEventListener("change", () => fillLevels(departmentSelect.value));
  levelSelect.addEventListener("change", () => fillSubjects(levelSelect.value));
  if (location) {
    departmentSelect.value = location.departmentId;
    fillLevels(location.departmentId, location.levelId, location.subjectId);
  }
  const fileInput = $("#upload-file", dialog);
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    $("#upload-preview", dialog).classList.toggle("is-hidden", !file);
    if (file) {
      $("#upload-file-name", dialog).textContent = file.name;
      $("#upload-file-size", dialog).textContent = formatSize(file.size);
    }
  });
  const drop = $("#upload-drop", dialog);
  drop.addEventListener("dragover", (event) => { event.preventDefault(); drop.classList.add("is-dragging"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-dragging"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("is-dragging");
    const [file] = event.dataTransfer.files;
    if (file) {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new Event("change"));
    }
  });
}

function showUsersDialog() {
  state.adminTab = "users";
  renderAdmin();
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(authForm);
  const registering = state.authMode === "register";
  const button = $('[type="submit"]', authForm);
  const message = $("#auth-message");
  button.disabled = true;
  $("#auth-submit-label").textContent = registering ? "Creating account…" : "Signing in…";
  message.textContent = "";
  message.classList.remove("is-success");
  try {
    const result = await api(registering ? "/api/auth/register" : "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        name: formData.get("name"), email: formData.get("email"), password: formData.get("password")
      })
    });
    authForm.reset();
    if (result.confirmationRequired) {
      message.textContent = "Check your email to confirm your account, then log in.";
      message.classList.add("is-success");
      return;
    }
    await enterLibrary(result.user);
  } catch (error) {
    if (state.user) showAuth();
    message.textContent = error.message;
  } finally {
    button.disabled = false;
    $("#auth-submit-label").textContent = registering ? "Create account" : "Log in";
  }
});

$$(".auth-tab").forEach((button) => button.addEventListener("click", () => setAuthMode(button.dataset.authMode)));

document.addEventListener("click", async (event) => {
  // Event delegation keeps dynamic book cards and admin tables wired after each render.
  const viewButton = event.target.closest("[data-view]");
  const categoryButton = event.target.closest("[data-category]");
  const favoriteButton = event.target.closest("[data-favorite]");
  const card = event.target.closest("[data-open-book]");
  const dialogClose = event.target.closest("[data-dialog-close]");
  const action = event.target.closest("[data-action]");

  if (viewButton) {
    event.preventDefault();
    setView(viewButton.dataset.view === "all-books" ? "all" : viewButton.dataset.view);
  }
  const departmentButton = event.target.closest("[data-department]");
  if (departmentButton) {
    const department = state.departments.find((item) => item.id === departmentButton.dataset.department);
    if (!department) return;
    state.departmentId = department.id;
    state.category = department.name;
    state.selectedLevel = "";
    state.selectedSubject = "";
    setView("department-levels");
  }
  const levelButton = event.target.closest("[data-level]");
  if (levelButton) {
    state.selectedLevel = levelButton.dataset.level;
    setView("department-subjects");
  }
  const subjectButton = event.target.closest("[data-subject]");
  if (subjectButton) {
    state.selectedSubject = subjectButton.dataset.subject;
    setView("subject-books");
  }
  if (event.target.closest("[data-back-to-levels]")) setView("department-levels");
  if (event.target.closest("[data-back-to-subjects]")) setView("department-subjects");
  if (categoryButton) {
    const category = categoryButton.dataset.category;
    state.category = category;
    setView(category === "All departments" ? "home" : "category", category);
  }
  if (favoriteButton) {
    event.stopPropagation();
    try {
      await api(`/api/books/${encodeURIComponent(favoriteButton.dataset.favorite)}/favorite`, { method: "PUT" });
      await loadLibrary();
    } catch (error) {
      notify(error.message, true);
    }
  } else if (card && !event.target.closest("button")) {
    showBook(card.dataset.openBook);
  }
  if (dialogClose) dialogClose.closest("dialog").close();
  const download = event.target.closest("[data-download-book]");
  if (download) {
    api("/api/activity", {
      method: "POST",
      body: JSON.stringify({ resourceId: download.dataset.downloadBook, action: "downloaded" })
    }).catch((error) => notify(error.message, true));
  }
  if (action?.dataset.action === "upload") showUploadDialog();
  if (action?.dataset.action === "upload-video") showUploadDialog("video");
  const subjectUpload = event.target.closest("[data-upload-subject]");
  if (subjectUpload) {
    showUploadDialog(subjectUpload.dataset.uploadSubject, {
      departmentId: subjectUpload.dataset.departmentId,
      levelId: subjectUpload.dataset.levelId,
      subjectId: subjectUpload.dataset.subjectId
    });
  }
  if (action?.dataset.action === "manage-users") {
    state.adminTab = "users";
    renderAdmin();
  }
  const adminTab = event.target.closest("[data-admin-tab]");
  if (adminTab) {
    state.adminTab = adminTab.dataset.adminTab;
    renderAdmin();
  }
  const deleteBook = event.target.closest("[data-delete-book]");
  if (deleteBook && window.confirm("Delete this resource? This also removes its uploaded file.")) {
    try {
      await api(`/api/admin/books/${encodeURIComponent(deleteBook.dataset.deleteBook)}`, { method: "DELETE" });
      notify("Resource deleted.");
      await loadLibrary();
      await renderAdmin();
    } catch (error) {
      notify(error.message, true);
    }
  }
  const deleteHierarchy = event.target.closest("[data-delete-hierarchy]");
  if (deleteHierarchy && window.confirm(`Delete this ${deleteHierarchy.dataset.deleteHierarchy}? Its nested structure and resources will also be deleted.`)) {
    const type = deleteHierarchy.dataset.deleteHierarchy;
    const route = type === "department" ? `/api/admin/departments/${deleteHierarchy.dataset.id}`
      : type === "level" ? `/api/admin/levels/${deleteHierarchy.dataset.id}` : `/api/admin/subjects/${deleteHierarchy.dataset.id}`;
    try {
      await api(route, { method: "DELETE" });
      await Promise.all([loadDepartments(), loadLibrary(), loadVideos()]);
      notify(`${type[0].toUpperCase()}${type.slice(1)} deleted.`);
      await renderAdmin();
    } catch (error) {
      notify(error.message, true);
    }
  }
  const toggleUser = event.target.closest("[data-toggle-user]");
  if (toggleUser) {
    try {
      await api(`/api/admin/users/${encodeURIComponent(toggleUser.dataset.toggleUser)}`, {
        method: "PATCH", body: JSON.stringify({ active: toggleUser.dataset.active !== "true" })
      });
      notify("Account status updated.");
      await renderAdmin();
    } catch (error) {
      notify(error.message, true);
    }
  }
  const deleteUser = event.target.closest("[data-delete-user]");
  if (deleteUser && window.confirm("Permanently delete this student account?")) {
    try {
      await api(`/api/admin/users/${encodeURIComponent(deleteUser.dataset.deleteUser)}`, { method: "DELETE" });
      notify("Student account deleted.");
      await renderAdmin();
    } catch (error) {
      notify(error.message, true);
    }
  }
  const deleteVideo = event.target.closest("[data-delete-video]");
  if (deleteVideo && window.confirm("Delete this video lesson? This also removes its uploaded file.")) {
    try {
      await api(`/api/admin/videos/${encodeURIComponent(deleteVideo.dataset.deleteVideo)}`, { method: "DELETE" });
      notify("Video deleted.");
      await loadVideos();
      await renderAdmin();
    } catch (error) {
      notify(error.message, true);
    }
  }
  const removePhoto = event.target.closest("[data-remove-photo]");
  if (removePhoto && window.confirm("Remove this developer photo?")) {
    try {
      const developerId = removePhoto.dataset.removePhoto;
      const result = await api(`/api/admin/about/photo/${encodeURIComponent(developerId)}`, { method: "DELETE" });
      state.developers = state.developers.map((developer) => developer.id === developerId ? result.developer : developer);
      await renderAdmin();
      notify("Developer photo removed.");
    } catch (error) {
      notify(error.message, true);
    }
  }
});

document.addEventListener("submit", async (event) => {
  const hierarchyAdd = event.target.closest("[data-hierarchy-add]");
  const hierarchyEdit = event.target.closest("[data-hierarchy-edit]");
  const resourceEdit = event.target.closest("[data-resource-kind]");
  if (hierarchyAdd || hierarchyEdit || resourceEdit) {
    event.preventDefault();
    const form = event.target;
    const name = form.elements.name?.value?.trim();
    try {
      if (hierarchyAdd) {
        const type = form.dataset.hierarchyAdd;
        const route = type === "department" ? "/api/admin/departments"
          : type === "level" ? `/api/admin/departments/${encodeURIComponent(form.dataset.parentId)}/levels`
            : `/api/admin/levels/${encodeURIComponent(form.dataset.parentId)}/subjects`;
        await api(route, { method: "POST", body: JSON.stringify({ name }) });
      } else if (hierarchyEdit) {
        const type = form.dataset.hierarchyEdit;
        const route = type === "department" ? `/api/admin/departments/${encodeURIComponent(form.dataset.id)}`
          : type === "level" ? `/api/admin/levels/${encodeURIComponent(form.dataset.id)}`
            : `/api/admin/subjects/${encodeURIComponent(form.dataset.id)}`;
        await api(route, { method: "PATCH", body: JSON.stringify({ name }) });
      } else {
        const type = form.dataset.resourceKind;
        const route = `/api/admin/${type === "book" ? "books" : "videos"}/${encodeURIComponent(form.dataset.resourceId)}`;
        const payload = { title: form.elements.title.value };
        if (form.elements.departmentId) {
          payload.departmentId = form.elements.departmentId.value;
          payload.levelId = form.elements.levelId.value;
          payload.subjectId = form.elements.subjectId.value;
        }
        await api(route, { method: "PATCH", body: JSON.stringify(payload) });
        await Promise.all([loadLibrary(), loadVideos()]);
      }
      await Promise.all([loadDepartments(), loadLibrary(), loadVideos()]);
      notify("Changes saved.");
      await renderAdmin();
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (event.target.id === "about-form") {
    event.preventDefault();
    const form = event.target;
    const developers = Array.from(form.querySelectorAll(".developer-editor")).map((fieldSet) => ({
      id: fieldSet.dataset.developerId,
      name: form.elements[`name-${fieldSet.dataset.developerIndex}`].value,
      role: form.elements[`role-${fieldSet.dataset.developerIndex}`].value,
      accent: form.elements[`accent-${fieldSet.dataset.developerIndex}`].value,
      bio: form.elements[`bio-${fieldSet.dataset.developerIndex}`].value
    }));
    try {
      await api("/api/admin/about", { method: "PUT", body: JSON.stringify({ developers }) });
      const result = await api("/api/about");
      state.developers = result.developers;
      notify("Developer profiles updated.");
      await renderAdmin();
    } catch (error) {
      notify(error.message, true);
    }
    return;
  }
  if (!["upload-form", "video-upload-form"].includes(event.target.id)) return;
  event.preventDefault();
  const form = event.target;
  const isVideo = form.id === "video-upload-form";
  const fileInput = $('[name="file"]', form);
  const message = $("#upload-message", form);
  const submit = $('[type="submit"]', form);
  if (!fileInput.files[0]) {
    message.textContent = "Choose a file before uploading.";
    return;
  }
  submit.disabled = true;
  submit.textContent = "Uploading…";
  message.textContent = "";
  try {
    const result = await api(isVideo ? "/api/admin/videos" : "/api/admin/books", { method: "POST", body: new FormData(form) });
    $("#upload-dialog").close();
    notify(`${isVideo ? result.video.title : result.book.title} is now in the library.`);
    if (isVideo) await loadVideos();
    else await loadLibrary();
    await renderAdmin();
  } catch (error) {
    message.textContent = error.message;
    submit.disabled = false;
    submit.textContent = isVideo ? "Upload video ↑" : "Upload resource ↑";
  }
});

document.addEventListener("change", async (event) => {
  if (event.target.matches("[data-resource-department], [data-resource-level]")) {
    const form = event.target.closest(".resource-title-form");
    const departmentSelect = $("[data-resource-department]", form);
    const levelSelect = $("[data-resource-level]", form);
    const subjectSelect = $("[data-resource-subject]", form);
    if (event.target.matches("[data-resource-department]")) {
      const department = state.departments.find((item) => item.id === departmentSelect.value);
      levelSelect.innerHTML = (department?.levels || []).map((level) => `<option value="${escapeHTML(level.id)}">${escapeHTML(level.name)}</option>`).join("");
    }
    const department = state.departments.find((item) => item.id === departmentSelect.value);
    const level = department?.levels.find((item) => item.id === levelSelect.value);
    subjectSelect.innerHTML = (level?.subjects || []).map((subject) => `<option value="${escapeHTML(subject.id)}">${escapeHTML(subject.name)}</option>`).join("");
  }
  if (event.target.matches("[data-developer-photo]")) {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("developerId", input.dataset.developerPhoto);
    formData.append("file", file);
    input.disabled = true;
    try {
      const result = await api("/api/admin/about/photo", { method: "POST", body: formData });
      state.developers = state.developers.map((developer) => developer.id === result.developer.id ? result.developer : developer);
      const fieldSet = input.closest(".developer-editor");
      const preview = $(".member-photo", fieldSet);
      preview.innerHTML = `<img src="${escapeHTML(result.developer.photoUrl)}" alt="${escapeHTML(result.developer.name)}">`;
      $("[data-remove-photo]", fieldSet).classList.remove("is-hidden");
      notify("Developer photo updated.");
    } catch (error) {
      notify(error.message, true);
    } finally {
      input.disabled = false;
      input.value = "";
    }
  }
  if (event.target.id === "video-department-filter") {
    state.videoCategory = event.target.value;
    renderVideos();
  }
});

document.addEventListener("play", (event) => {
  const video = event.target.closest("video[data-resource-video]");
  if (!video || video.dataset.activityRecorded) return;
  video.dataset.activityRecorded = "true";
  api("/api/activity", {
    method: "POST",
    body: JSON.stringify({ resourceId: video.dataset.resourceVideo, action: "opened" })
  }).catch((error) => notify(error.message, true));
}, true);

$("#search-input").addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  if (["activity", "admin", "department-levels", "department-subjects"].includes(state.view)) state.view = "home";
  renderPage();
});

$("#refresh-button").addEventListener("click", async () => {
  try {
    await loadLibrary();
    notify("Library refreshed.");
  } catch (error) {
    notify(error.message, true);
  }
});

$("#logout-button").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    showAuth();
  } catch (error) {
    notify(error.message, true);
  }
});

$("#menu-button").addEventListener("click", () => $("#sidebar").classList.add("is-open"));
$("#sidebar-close").addEventListener("click", () => $("#sidebar").classList.remove("is-open"));
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    $("#search-input").focus();
  }
  if (event.key === "Escape") $("#sidebar").classList.remove("is-open");
  if (event.key === "Enter" && event.target.matches("[data-open-book]")) showBook(event.target.dataset.openBook);
});

async function initialize() {
  try {
    const { user } = await api("/api/me");
    await enterLibrary(user);
  } catch (error) {
    if (error.message !== "Please log in to continue.") notify(error.message, true);
    showAuth();
  }
}

initialize();