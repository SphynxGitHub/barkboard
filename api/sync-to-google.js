import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { bookingId } = req.body;
  if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });

  try {
    // 1. Fetch the booking details and assigned staff ID
    const { data: booking, error: bkErr } = await supabase
      .from('bookings')
      .select('*, pets(name), households(name)')
      .eq('id', bookingId)
      .single();

    if (bkErr || !booking || !booking.assigned_staff_id) {
      return res.status(200).json({ message: 'No staff assigned or booking not found; skipped Google sync.' });
    }

    // 2. Fetch the staff member's Google OAuth tokens
    const { data: tokenData, error: tokenErr } = await supabase
      .from('staff_oauth_tokens')
      .select('*')
      .eq('staff_id', booking.assigned_staff_id)
      .eq('provider', 'google')
      .single();

    if (tokenErr || !tokenData) {
      return res.status(200).json({ message: 'Staff member has not connected Google Calendar; skipped Google sync.' });
    }

    // 3. Initialize Google Calendar Client
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

    const petName = booking.pets?.name ? ` - ${booking.pets.name}` : '';
    const eventPayload = {
      summary: `${booking.service_name || 'BarkBoard Booking'}${petName}`,
      description: `Household: ${booking.households?.name || 'N/A'}\nNotes: ${booking.notes || ''}`,
      start: { dateTime: new Date(booking.check_in).toISOString() },
      end: { dateTime: new Date(booking.check_out || booking.check_in).toISOString() }
    };

    let googleEventId = booking.google_event_id;

    if (googleEventId) {
      // Update existing Google Event
      await calendar.events.patch({
        calendarId,
        eventId: googleEventId,
        requestBody: eventPayload
      });
    } else {
      // Insert new Google Event
      const gEvent = await calendar.events.insert({
        calendarId,
        requestBody: eventPayload
      });
      googleEventId = gEvent.data.id;

      // Save the returned google_event_id back to Supabase
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
