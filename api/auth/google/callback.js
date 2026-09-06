import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  const { code, state: staffId } = req.query;

  if (!code || !staffId) {
    return res.status(400).send('Missing authorization code or staff ID.');
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const { data: primaryCal } = await calendar.calendars.get({ calendarId: 'primary' });

    // Store Tokens in Supabase
    const { error: dbError } = await supabase.from('staff_oauth_tokens').upsert({
      staff_id: staffId,
      provider: 'google',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(tokens.expiry_date).toISOString(),
      calendar_id: primaryCal.id
    }, { onConflict: 'staff_id, provider' });

    if (dbError) throw dbError;

    // Register Push Notifications with Google
    const channelId = `channel-staff-${staffId}-${Date.now()}`;
    const { data: watchResponse } = await calendar.events.watch({
      calendarId: primaryCal.id,
      requestBody: {
        id: channelId,
        type: 'web_hook',
        address: process.env.WEBHOOK_URL,
        expiration: Date.now() + 7 * 24 * 60 * 60 * 1000
      }
    });

    await supabase.from('calendar_watch_channels').upsert({
      staff_id: staffId,
      channel_id: watchResponse.id,
      resource_id: watchResponse.resourceId,
      expiration: new Date(parseInt(watchResponse.expiration, 10)).toISOString()
    });

    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      // Bounded window — without a timeMax, a recurring event with no end
      // date gets expanded by Google into one instance per future
      // occurrence (potentially decades' worth), since singleEvents:true
      // expands recurrences across whatever window is given.
      const ninetyDaysOut = new Date();
      ninetyDaysOut.setDate(ninetyDaysOut.getDate() + 90);

      // Needed so imported events are actually visible to staff — every
      // booking read in the app is RLS-scoped to business_id = current
      // business, so a row without one is invisible even though it exists.
      const { data: staffRow } = await supabase
        .from('staff')
        .select('business_id')
        .eq('id', staffId)
        .single();
      const businessId = staffRow?.business_id || null;

      // 1. Fetch existing events from the staff member's Google Calendar
      const { data: initialEvents } = await calendar.events.list({
        calendarId: primaryCal.id,
        timeMin: thirtyDaysAgo.toISOString(),
        timeMax: ninetyDaysOut.toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });

      // 2. Insert or update each event into BarkBoard (Supabase)
      for (const event of initialEvents.items || []) {
        if (event.status !== 'cancelled') {
          // Bare local-time strings (no trailing Z) — matches how every other
          // timestamp in this app is stored (floating local time, not UTC).
          // An all-day Google event has no specific time, so it's given a
          // reasonable business-hours placeholder rather than midnight-to-
          // midnight, which read as an odd 24-hour block on the calendar.
          const startIso = event.start.dateTime
            ? event.start.dateTime.split('.')[0].replace('Z', '')
            : `${event.start.date}T09:00:00`;
          const endIso = event.end.dateTime
            ? event.end.dateTime.split('.')[0].replace('Z', '')
            : `${event.end.date}T17:00:00`;

          await supabase.from('bookings').upsert({
            google_event_id: event.id,
            service_name: event.summary || 'External Appointment',
            check_in: startIso,
            check_out: endIso,
            assigned_staff_id: staffId,
            business_id: businessId,
            flexible_time: false,
            household_id: null,
            notes: event.description || '',
            status: 'confirmed'
          }, { onConflict: 'google_event_id' });
        }
      }
    } catch (importErr) {
      console.error('Initial Google event import error:', importErr);
    }
    
    res.send(`
      <html>
        <body style="font-family:sans-serif; text-align:center; padding:2rem;">
          <h2>Google Calendar Connected!</h2>
          <p>You may close this window.</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'GOOGLE_OAUTH_SUCCESS' }, '*');
              window.close();
            }
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('OAuth Callback Error:', error);
    res.status(500).send('Authentication failed: ' + error.message);
  }
}
