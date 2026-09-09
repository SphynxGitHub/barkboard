import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const { staffId } = req.body || {};
  if (!staffId) return res.status(400).json({ error: 'staffId is required' });

  const { data: tokenData } = await supabase.from('staff_oauth_tokens').select('*').eq('staff_id', staffId).eq('provider', 'google').maybeSingle();
  const { data: channel } = await supabase.from('calendar_watch_channels').select('*').eq('staff_id', staffId).maybeSingle();

  // Best-effort: tell Google to actually stop sending push notifications to
  // this channel. Not critical if it fails (an expired/already-gone channel
  // throws here, which is fine — we're deleting our own record either way),
  // but doing it properly avoids leaving a dangling subscription on Google's
  // side pointed at a channel we're about to forget entirely.
  if (tokenData && channel) {
    try {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
      oauth2Client.setCredentials({ access_token: tokenData.access_token, refresh_token: tokenData.refresh_token });
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      await calendar.channels.stop({ requestBody: { id: channel.channel_id, resourceId: channel.resource_id } });
    } catch (err) {
      console.warn('[Disconnect] Could not stop Google watch channel (likely already expired):', err.message);
    }
  }

  await supabase.from('calendar_watch_channels').delete().eq('staff_id', staffId);
  await supabase.from('staff_oauth_tokens').delete().eq('staff_id', staffId).eq('provider', 'google');

  return res.status(200).json({ success: true });
}
