module.exports = function handler(_request, response) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    response.status(503).json({ error: "Supabase is not configured for this deployment." });
    return;
  }
  response.setHeader("Cache-Control", "no-store");
  response.status(200).json({ url, anonKey });
};
