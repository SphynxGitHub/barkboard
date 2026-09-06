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
    
      // 1. Fetch existing events from the staff member's Google Calendar
      const { data: initialEvents } = await calendar.events.list({
        calendarId: primaryCal.id,
        timeMin: thirtyDaysAgo.toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });
    
      // 2. Insert or update each event into BarkBoard (Supabase)
      for (const event of initialEvents.items || []) {
        if (event.status !== 'cancelled') {
          const startIso = event.start.dateTime || `${event.start.date}T00:00:00Z`;
          const endIso = event.end.dateTime || `${event.end.date}T23:59:59Z`;
    
          await supabase.from('bookings').upsert({
            google_event_id: event.id,
            service_name: event.summary || 'External Appointment',
            check_in: startIso,
            check_out: endIso,
            assigned_staff_id: staffId,
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
