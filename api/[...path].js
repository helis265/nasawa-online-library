const { createClient } = require("@supabase/supabase-js");

const json = (response, status, value) => response.status(status).json(value);

module.exports = async function handler(request, response) {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return json(response, 503, { error: "Server-side Supabase configuration is missing." });
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "PATCH" && request.method !== "DELETE") {
    response.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return json(response, 405, { error: "Method not allowed." });
  }

  const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json(response, 401, { error: "Sign in is required." });
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: { user }, error: authError } = await admin.auth.getUser(token);
  if (authError || !user) return json(response, 401, { error: "Your session is invalid or expired." });
  const route = Array.isArray(request.query.path)
    ? request.query.path
    : String(request.query.path || "").split("/").filter(Boolean);
  if (route[0] === "admin" && route[1] === "bootstrap" && route.length === 2 && request.method === "POST") {
    const initialAdminEmail = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
    if (!initialAdminEmail || user.email?.toLowerCase() !== initialAdminEmail || !user.email_confirmed_at) {
      return json(response, 200, { promoted: false });
    }
    const { data: promoted, error: promoteError } = await admin.rpc("provision_first_library_admin", { target_user_id: user.id });
    if (promoteError) return json(response, 500, { error: "Could not provision the first administrator." });
    return json(response, 200, { promoted });
  }
  const { data: caller, error: profileError } = await admin.from("profiles").select("role,active").eq("id", user.id).single();
  if (profileError || caller?.role !== "admin" || !caller.active) return json(response, 403, { error: "Administrator access is required." });
  if (route[0] !== "admin" || route[1] !== "users") return json(response, 404, { error: "Not found." });

  if (route.length === 2 && request.method === "GET") {
    const profiles = new Map();
    const { data: profileRows, error } = await admin.from("profiles").select("id,name,email,role,active,created_at");
    if (error) return json(response, 500, { error: "Could not load user profiles." });
    profileRows.forEach((profile) => profiles.set(profile.id, profile));
    const users = [];
    for (let page = 1; page <= 20; page += 1) {
      const { data, error: listError } = await admin.auth.admin.listUsers({ page, perPage: 500 });
      if (listError) return json(response, 500, { error: "Could not load authentication accounts." });
      for (const account of data.users) {
        const profile = profiles.get(account.id);
        if (profile) users.push({ ...profile, active: profile.active && !account.banned_until });
      }
      if (data.users.length < 500) break;
    }
    return json(response, 200, { users });
  }

  const targetId = route[2];
  if (!targetId || route.length !== 3) return json(response, 404, { error: "Not found." });
  const { data: target, error: targetError } = await admin.from("profiles").select("id,role,active").eq("id", targetId).single();
  if (targetError || !target) return json(response, 404, { error: "This account could not be found." });
  if (target.role !== "student" || target.id === user.id) return json(response, 400, { error: "Administrator accounts cannot be changed here." });

  if (request.method === "PATCH") {
    if (typeof request.body?.active !== "boolean") return json(response, 400, { error: "An active status is required." });
    const banDuration = request.body.active ? "none" : "876000h";
    const { error: authUpdateError } = await admin.auth.admin.updateUserById(targetId, { ban_duration: banDuration });
    if (authUpdateError) return json(response, 500, { error: "Could not update the authentication account." });
    const { data, error } = await admin.from("profiles").update({ active: request.body.active }).eq("id", targetId).select("id,name,email,role,active,created_at").single();
    if (error) {
      await admin.auth.admin.updateUserById(targetId, { ban_duration: target.active ? "none" : "876000h" });
      return json(response, 500, { error: "Could not update the account profile." });
    }
    return json(response, 200, { user: data });
  }

  if (request.method === "DELETE") {
    const { error } = await admin.auth.admin.deleteUser(targetId);
    if (error) return json(response, 500, { error: "Could not delete the student account." });
    return json(response, 200, { ok: true });
  }
  response.setHeader("Allow", "GET, PATCH, DELETE");
  return json(response, 405, { error: "Method not allowed." });
};
