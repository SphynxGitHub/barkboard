import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.status(200).send('OK');

  const channelId = req.headers['x-goog-channel-id'];
  const resourceState = req.headers['x-goog-resource-state'];

  if (resourceState === 'sync') return;

  try {
    const { data: channel } = await supabase
      .from('calendar_watch_channels')
      .select('*, staff_oauth_tokens(*)')
      .eq('channel_id', channelId)
      .single();

    if (!channel || !channel.staff_oauth_tokens) return;

    const tokenData = channel.staff_oauth_tokens;
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
    const listParams = { calendarId: tokenData.calendar_id || 'primary' };

    if (tokenData.sync_token) {
      listParams.syncToken = tokenData.sync_token;
    } else {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      listParams.timeMin = thirtyDaysAgo.toISOString();
    }

    const { data: eventsData } = await calendar.events.list(listParams);

    if (eventsData.nextSyncToken) {
      await supabase.from('staff_oauth_tokens')
        .update({ sync_token: eventsData.nextSyncToken })
        .eq('id', tokenData.id);
    }

    for (const event of eventsData.items || []) {
      if (event.status === 'cancelled') {
        await supabase.from('bookings')
          .update({ status: 'cancelled' })
          .eq('google_event_id', event.id);
      } else {
        const startIso = event.start.dateTime || `${event.start.date}T00:00:00Z`;
        const endIso = event.end.dateTime || `${event.end.date}T23:59:59Z`;

        await supabase.from('bookings').upsert({
          google_event_id: event.id,
          service_name: event.summary || 'External Appointment',
          check_in: startIso,
          check_out: endIso,
          assigned_staff_id: channel.staff_id,
          notes: event.description || '',
          status: 'confirmed'
        }, { onConflict: 'google_event_id' });
      }
    }
  } catch (error) {
    console.error('Webhook Handler Error:', error);
  }
}
