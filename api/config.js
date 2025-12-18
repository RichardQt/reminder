export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    res.status(500).json({ error: 'Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variable.' });
    return;
  }

  res.status(200).json({ url, key: anonKey });
}
