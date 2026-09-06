import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return res.status(405).send('Method Not Allowed');
  }

  const { bookingId } = req.body;
  if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });

  try {
    // 1. Fetch booking details, assigned staff, and linked business timezone
    const { data: booking, error: bkErr } = await supabase
      .from('bookings')
      .select('*, pets(name), households(name), businesses(timezone)')
      .eq('id', bookingId)
      .single();

    if (bkErr || !booking || !booking.assigned_staff_id) {
      return res.status(200).json({ message: 'No staff assigned or booking not found; skipped Google sync.' });
    }

    // 2. Fetch staff OAuth tokens
    const { data: tokenData, error: tokenErr } = await supabase
      .from('staff_oauth_tokens')
      .select('*')
      .eq('staff_id', booking.assigned_staff_id)
      .eq('provider', 'google')
      .single();

    if (tokenErr || !tokenData) {
      return res.status(200).json({ message: 'Staff member has not connected Google Calendar; skipped Google sync.' });
    }

    // 3. Initialize Google Auth & Calendar Client
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

    // 4. Handle DELETE request
    if (req.method === 'DELETE') {
      if (booking.google_event_id) {
        await calendar.events.delete({ calendarId, eventId: booking.google_event_id });
      }
      return res.status(200).json({ success: true, deleted: true });
    }

    // 5. Handle POST request (Create/Update)
    // Pull the saved business timezone or fallback to America/New_York
    // 1. Resolve business timezone (or default to Eastern)
    const timeZone = booking.businesses?.timezone || 'America/New_York';
    const petName = booking.pets?.name ? ` - ${booking.pets.name}` : '';
    
    // 2. Strip any trailing 'Z' or offset if present on check_in / check_out strings
    // e.g., "2026-09-05T09:00:00"
    const cleanCheckIn = booking.check_in ? booking.check_in.split('.')[0].replace('Z', '') : null;
    const cleanCheckOut = booking.check_out ? booking.check_out.split('.')[0].replace('Z', '') : cleanCheckIn;
    
    const eventPayload = {
      summary: `${booking.service_name || 'BarkBoard Booking'}${petName}`,
      description: `Household: ${booking.households?.name || 'N/A'}\nNotes: ${booking.notes || ''}`,
      start: {
        dateTime: cleanCheckIn, // Pure local time string (YYYY-MM-DDTHH:MM:SS)
        timeZone: timeZone      // Explicit IANA timezone string
      },
      end: {
        dateTime: cleanCheckOut,
        timeZone: timeZone
      }
    };

    let googleEventId = booking.google_event_id;

    if (googleEventId) {
      // Patch existing Google Calendar event
      await calendar.events.patch({
        calendarId,
        eventId: googleEventId,
        requestBody: eventPayload
      });
    } else {
      // Insert new Google Calendar event
      const gEvent = await calendar.events.insert({
        calendarId,
        requestBody: eventPayload
      });
      googleEventId = gEvent.data.id;

      // Save generated google_event_id back to Supabase
      await supabase
        .from('bookings')
        .update({ google_event_id: googleEventId })
        .eq('id', booking.id);
    }

    return res.status(200).json({ success: true, googleEventId });
  } catch (error) {
    console.error('Sync to Google Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
