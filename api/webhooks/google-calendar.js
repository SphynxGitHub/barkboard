import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // Acknowledge Google immediately so it doesn't retry or drop the channel
  res.status(200).send('OK');

  const channelId = req.headers['x-goog-channel-id'];
  const resourceState = req.headers['x-goog-resource-state'];

  // Ignore initial ping upon watch channel creation
  if (resourceState === 'sync') return;

  try {
    // 1. Retrieve the watch channel. This used to be a single query embedding
    // staff_oauth_tokens and staff directly — but calendar_watch_channels has
    // no foreign key TO staff_oauth_tokens (they're siblings that separately
    // reference staff.id), so PostgREST couldn't resolve that embed and the
    // whole query errored out — which looked identical to "channel not
    // found" in the logs, even though the channel row existed the whole time.
    const { data: channel, error: chErr } = await supabase
      .from('calendar_watch_channels')
      .select('*')
      .eq('channel_id', channelId)
      .single();

    if (chErr || !channel) {
      console.warn(`[Webhook] No active channel found for ID: ${channelId}`);
      return;
    }

    const { data: tokenData, error: tokenErr } = await supabase
      .from('staff_oauth_tokens')
      .select('*')
      .eq('staff_id', channel.staff_id)
      .eq('provider', 'google')
      .single();

    if (tokenErr || !tokenData) {
      console.warn(`[Webhook] No Google OAuth tokens found for staff: ${channel.staff_id}`);
      return;
    }

    const { data: staffRow } = await supabase
      .from('staff')
      .select('business_id')
      .eq('id', channel.staff_id)
      .single();

    const businessId = staffRow?.business_id || null;

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    oauth2Client.setCredentials({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token
    });

    // Handle token auto-refresh events
    oauth2Client.on('tokens', async (updatedTokens) => {
      const updatePayload = {
        access_token: updatedTokens.access_token,
        expires_at: updatedTokens.expiry_date ? new Date(updatedTokens.expiry_date).toISOString() : null
      };
      if (updatedTokens.refresh_token) updatePayload.refresh_token = updatedTokens.refresh_token;

      await supabase.from('staff_oauth_tokens').update(updatePayload).eq('id', tokenData.id);
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = tokenData.calendar_id || 'primary';
    
    let listParams = { calendarId };
    if (tokenData.sync_token) {
      listParams.syncToken = tokenData.sync_token;
    } else {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      listParams.timeMin = thirtyDaysAgo.toISOString();
      listParams.singleEvents = true;
    }

    // 2. Fetch changed events (with 410 syncToken invalidation fallback)
    let eventsData;
    try {
      const response = await calendar.events.list(listParams);
      eventsData = response.data;
    } catch (listError) {
      if (listError.code === 410) {
        // Sync token expired/invalidated — fallback to timeMin fetch
        delete listParams.syncToken;
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        listParams.timeMin = thirtyDaysAgo.toISOString();
        listParams.singleEvents = true;

        const response = await calendar.events.list(listParams);
        eventsData = response.data;
      } else {
        throw listError;
      }
    }

    // 3. Save new syncToken for incremental updates
    if (eventsData.nextSyncToken) {
      await supabase.from('staff_oauth_tokens')
        .update({ sync_token: eventsData.nextSyncToken })
        .eq('id', tokenData.id);
    }

    // 4. Ingest events into Supabase
    for (const event of eventsData.items || []) {
      if (event.status === 'cancelled') {
        await supabase.from('bookings')
          .update({ status: 'cancelled' })
          .eq('google_event_id', event.id);
      } else {
        // Standardize timestamps (handle dateTime vs all-day date strings).
        // Google returns dateTime WITH a timezone offset attached (e.g.
        // "...09:00:00-04:00") — stripped here to a bare local-time string,
        // matching how every other timestamp in this app is stored (floating
        // local time, no offset), so downstream date/time parsing elsewhere
        // in the app doesn't get a value in a different shape than it expects.
        const startIso = event.start?.dateTime
          ? event.start.dateTime.replace(/\.\d+/, '').replace(/(Z|[+-]\d{2}:\d{2})$/, '')
          : `${event.start?.date}T09:00:00`;
        const endIso = event.end?.dateTime
          ? event.end.dateTime.replace(/\.\d+/, '').replace(/(Z|[+-]\d{2}:\d{2})$/, '')
          : `${event.end?.date}T17:00:00`;

        const { error: upsertErr } = await supabase.from('bookings').upsert({
          google_event_id: event.id,
          service_name: event.summary || 'External Appointment',
          check_in: startIso,
          check_out: endIso,
          assigned_staff_id: channel.staff_id,
          business_id: businessId, // Links event to the correct business tenant
          flexible_time: false,    // Satisfies NOT NULL constraint
          household_id: null,      // Handles non-client external events
          notes: event.description || '',
          status: 'confirmed'
        }, { onConflict: 'google_event_id' });

        if (upsertErr) {
          console.error(`[Webhook] Failed to save Google event ${event.id}:`, upsertErr.message);
        }
      }
    }
  } catch (error) {
    console.error('Webhook Handler Error:', error.message || error);
  }
}
