import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Google watch channels expire after at most 7 days (set to exactly 7 in our
// own registration code) and are never auto-renewed by Google — something
// has to proactively re-subscribe before expiration or inbound sync just
// silently stops. This runs daily via Vercel Cron (see vercel.json) and
// renews anything expiring within the next 2 days, so there's margin even if
// a run gets skipped or delayed once.
export default async function handler(req, res) {
  // Vercel signs cron requests with this header automatically when
  // CRON_SECRET is set as an env var — this rejects anyone else from
  // triggering renewal (and burning API quota / rotating channels) by just
  // hitting the URL directly.
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send('Unauthorized');
  }

  const twoDaysFromNow = new Date();
  twoDaysFromNow.setDate(twoDaysFromNow.getDate() + 2);

  const { data: expiringChannels, error: fetchErr } = await supabase
    .from('calendar_watch_channels')
    .select('*, staff_oauth_tokens(*)')
    .lt('expiration', twoDaysFromNow.toISOString());

  if (fetchErr) {
    console.error('[Renew] Failed to fetch expiring channels:', fetchErr.message);
    return res.status(500).json({ error: fetchErr.message });
  }

  const results = [];

  for (const channel of expiringChannels || []) {
    try {
      // Same relationship gap as the webhook handler used to have — these
      // two tables aren't directly linked by a foreign key PostgREST can
      // embed reliably, so fetch tokens separately rather than trust the
      // embed above returned anything.
      const { data: tokenData, error: tokenErr } = await supabase
        .from('staff_oauth_tokens')
        .select('*')
        .eq('staff_id', channel.staff_id)
        .eq('provider', 'google')
        .single();

      if (tokenErr || !tokenData) {
        console.warn(`[Renew] No tokens for staff ${channel.staff_id}, skipping.`);
        results.push({ staff_id: channel.staff_id, status: 'skipped_no_tokens' });
        continue;
      }

      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
      oauth2Client.setCredentials({
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token
      });

      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      const calendarId = tokenData.calendar_id || 'primary';

      // Google has no "renew" operation — registering a new channel is the
      // only way. Stop the old one first (best-effort; a 404 here just means
      // it already expired or was already cleaned up, which is fine).
      try {
        await calendar.channels.stop({
          requestBody: { id: channel.channel_id, resourceId: channel.resource_id }
        });
      } catch (stopErr) {
        console.warn(`[Renew] Could not stop old channel ${channel.channel_id} (likely already expired):`, stopErr.message);
      }

      const newChannelId = `channel-staff-${channel.staff_id}-${Date.now()}`;
      const { data: watchResponse } = await calendar.events.watch({
        calendarId,
        requestBody: {
          id: newChannelId,
          type: 'web_hook',
          address: process.env.WEBHOOK_URL,
          expiration: Date.now() + 7 * 24 * 60 * 60 * 1000
        }
      });

      // Update the same row rather than upsert-by-staff_id — we don't know
      // for certain there's a unique constraint on staff_id (this table was
      // created outside the normal migration history), but we do already
      // have this exact row's primary key from the fetch above.
      await supabase.from('calendar_watch_channels').update({
        channel_id: watchResponse.id,
        resource_id: watchResponse.resourceId,
        expiration: new Date(parseInt(watchResponse.expiration, 10)).toISOString()
      }).eq('id', channel.id);

      console.log(`[Renew] Renewed channel for staff ${channel.staff_id}: ${newChannelId}`);
      results.push({ staff_id: channel.staff_id, status: 'renewed', channel_id: newChannelId });
    } catch (err) {
      console.error(`[Renew] Failed to renew channel for staff ${channel.staff_id}:`, err.message);
      results.push({ staff_id: channel.staff_id, status: 'error', error: err.message });
    }
  }

  return res.status(200).json({ processed: results.length, results });
}
