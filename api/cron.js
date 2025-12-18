import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BARK_GROUP = process.env.BARK_GROUP || 'Reminders';
const LOOKAHEAD_MIN = Number(process.env.REMINDER_LOOKAHEAD_MIN || 1);
const WINDOW_MS = Math.max(1, LOOKAHEAD_MIN) * 60 * 1000;

const toIsoMinute = (d) => {
  const dt = new Date(d);
  return new Date(dt.getTime() - dt.getTime() % 60000).toISOString();
};

const nextDateByCycle = (dateStr, cycle) => {
  const base = new Date(dateStr);
  if (Number.isNaN(base.getTime())) return null;
  switch (cycle) {
    case 'daily':
      base.setDate(base.getDate() + 1);
      break;
    case 'weekly':
      base.setDate(base.getDate() + 7);
      break;
    case 'monthly':
      base.setMonth(base.getMonth() + 1);
      break;
    default:
      return null; // once or unknown -> stop scheduling
  }
  return toIsoMinute(base).slice(0, 16); // align with frontend format
};

const sendBark = async (barkKey, title, body, level = 'active', sound = 'default') => {
  let baseUrl = 'https://api.day.app/';
  let cleanKey = barkKey;
  if (barkKey.startsWith('http')) {
    cleanKey = barkKey.endsWith('/') ? barkKey.slice(0, -1) : barkKey;
    baseUrl = '';
  }
  const url = `${baseUrl}${cleanKey}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=${encodeURIComponent(
    BARK_GROUP
  )}&level=${level}&sound=${sound}`;
  await fetch(url, { method: 'GET' });
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars' });
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    const [remResp, devResp, setResp] = await Promise.all([
      supabase.from('reminders').select('*'),
      supabase.from('devices').select('*'),
      supabase.from('settings').select('*').limit(1)
    ]);

    if (remResp.error) throw remResp.error;
    if (devResp.error) throw devResp.error;
    if (setResp.error && setResp.error.code !== 'PGRST116') throw setResp.error;

    const reminders = remResp.data || [];
    const devices = devResp.data || [];
    const settings = (setResp.data && setResp.data[0]) || { bark_critical: false };

    const now = Date.now();
    const due = reminders.filter((r) => {
      if (!r.next_date) return false;
      const target = new Date(r.next_date).getTime();
      if (Number.isNaN(target)) return false;
      const delta = target - now;
      return delta <= WINDOW_MS && delta >= -WINDOW_MS;
    });

    const results = [];

    for (const item of due) {
      const targetDevices =
        item.target_device_id && item.target_device_id !== 'all'
          ? devices.filter((d) => String(d.id) === String(item.target_device_id))
          : devices;

      if (!targetDevices.length) continue;

      const isCritical = item.is_critical || settings.bark_critical;
      const level = isCritical ? 'critical' : 'active';
      const sound = isCritical ? 'gotosleep' : 'default';

      await Promise.all(
        targetDevices.map((dev) =>
          sendBark(dev.bark_key, item.name, item.notes || '⏰ 时间到了，请尽快处理', level, sound)
        )
      );

      const nextDate = nextDateByCycle(item.next_date, item.cycle);
      await supabase
        .from('reminders')
        .update({ next_date: nextDate })
        .eq('id', item.id);

      results.push({ id: item.id, sentTo: targetDevices.map((d) => d.name), next_date: nextDate });
    }

    res.status(200).json({ sent: results.length, details: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Cron failed', detail: err.message });
  }
}
