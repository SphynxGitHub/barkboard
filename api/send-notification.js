import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- Shared "letterhead" header, matching the print/receipt consolidation
// already done elsewhere in the app (logo + name + contact info as one block).
function headerHtml(business, settings) {
  const contactLine = [business.contact_phone, business.contact_email, business.address].filter(Boolean).join(' &middot; ');
  return `
    <div style="display:flex; align-items:center; gap:14px; padding-bottom:14px; margin-bottom:16px; border-bottom:1px solid #e5e7eb;">
      ${settings?.logo_url ? `<img src="${settings.logo_url}" style="max-height:48px; max-width:90px; object-fit:contain;">` : ''}
      <div>
        <div style="font-weight:700; font-size:17px; color:#111827;">${business.name}</div>
        ${contactLine ? `<div style="color:#6b7280; font-size:12px; margin-top:2px;">${contactLine}</div>` : ''}
      </div>
    </div>
  `;
}

function wrapEmail(bodyHtml) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif; max-width:480px; margin:0 auto; padding:24px; color:#111827;">${bodyHtml}</div>`;
}

// --- Templates ---------------------------------------------------------

function templateBookingConfirmed({ business, settings, booking, petName }) {
  const when = booking.check_out && booking.check_out.slice(0, 10) !== booking.check_in.slice(0, 10)
    ? `${booking.check_in.slice(0, 10)} &rarr; ${booking.check_out.slice(0, 10)}`
    : `${booking.check_in.slice(0, 10)} at ${booking.check_in.slice(11, 16)}`;
  return {
    subject: `Confirmed: ${booking.service_name} for ${petName || 'your pet'}`,
    html: wrapEmail(`
      ${headerHtml(business, settings)}
      <h2 style="margin:0 0 8px; font-size:18px;">Your appointment is confirmed! ✅</h2>
      <p style="color:#374151; font-size:14px;">${petName || 'Your pet'} is booked for <strong>${booking.service_name}</strong>.</p>
      <table style="width:100%; font-size:14px; margin-top:12px;">
        <tr><td style="color:#6b7280; padding:4px 0;">When</td><td style="padding:4px 0;">${when}</td></tr>
        ${booking.amount ? `<tr><td style="color:#6b7280; padding:4px 0;">Amount</td><td style="padding:4px 0;">$${Number(booking.amount).toFixed(2)}</td></tr>` : ''}
      </table>
      <p style="color:#6b7280; font-size:13px; margin-top:16px;">We're looking forward to seeing you!</p>
    `)
  };
}

function templateBookingDeclined({ business, settings, booking, petName }) {
  return {
    subject: `Update on your ${booking.service_name} request`,
    html: wrapEmail(`
      ${headerHtml(business, settings)}
      <h2 style="margin:0 0 8px; font-size:18px;">We're unable to confirm this request</h2>
      <p style="color:#374151; font-size:14px;">Unfortunately we can't accommodate the request for <strong>${booking.service_name}</strong>${petName ? ` for ${petName}` : ''} on ${booking.check_in.slice(0, 10)}.</p>
      <p style="color:#6b7280; font-size:13px; margin-top:16px;">Please reach out to us directly if you'd like to find another time, or submit a new request through our booking page.</p>
    `)
  };
}

function templatePaymentReceived({ business, settings, invoice }) {
  return {
    subject: `Receipt: ${invoice.description || 'Payment received'}`,
    html: wrapEmail(`
      ${headerHtml(business, settings)}
      <div style="display:inline-block; background:#16a34a; color:#fff; font-weight:700; font-size:12px; letter-spacing:0.5px; padding:4px 12px; border-radius:999px; margin-bottom:12px;">PAID</div>
      <div style="font-size:26px; font-weight:700; margin-bottom:10px;">$${Number(invoice.amount || 0).toFixed(2)}</div>
      <p style="font-size:14px;"><strong>${invoice.description || 'Invoice'}</strong></p>
      ${invoice.paid_date ? `<p style="color:#6b7280; font-size:13px;">Paid ${invoice.paid_date}${invoice.payment_method ? ' via ' + invoice.payment_method : ''}</p>` : ''}
      <p style="color:#6b7280; font-size:13px; margin-top:16px;">Thank you!</p>
    `)
  };
}

function templateInvoiceCreated({ business, settings, invoice, paymentOptions }) {
  return {
    subject: `Invoice: ${invoice.description || 'Payment due'}`,
    html: wrapEmail(`
      ${headerHtml(business, settings)}
      <p style="color:#6b7280; font-size:13px; margin:0 0 4px;">Amount Due</p>
      <div style="font-size:26px; font-weight:700; margin-bottom:10px;">$${Number(invoice.amount || 0).toFixed(2)}</div>
      <p style="font-size:14px;"><strong>${invoice.description || 'Invoice'}</strong></p>
      ${invoice.due_date ? `<p style="color:#6b7280; font-size:13px;">Due ${invoice.due_date}</p>` : ''}
      ${paymentOptions.length ? `
        <div style="margin-top:16px; padding-top:12px; border-top:1px solid #e5e7eb;">
          <div style="font-weight:600; font-size:14px; margin-bottom:6px;">Ways to Pay</div>
          ${paymentOptions.map(p => `<div style="font-size:13px; color:#6b7280;">${p}</div>`).join('')}
        </div>
      ` : ''}
    `)
  };
}

function templateChangeRequest({ business, settings, booking, petName, message }) {
  return {
    subject: `Change request: ${petName || 'a customer'} — ${booking.service_name}`,
    html: wrapEmail(`
      ${headerHtml(business, settings)}
      <h2 style="margin:0 0 8px; font-size:18px;">A customer requested a change</h2>
      <p style="font-size:14px;"><strong>${petName || 'Pet'}</strong> — ${booking.service_name} on ${booking.check_in.slice(0, 10)}</p>
      <div style="margin-top:10px; padding:12px; background:#fef3c7; border-radius:8px; font-size:14px; color:#92400e;">"${message}"</div>
      <p style="color:#6b7280; font-size:13px; margin-top:16px;">Log in to BarkBoard to respond.</p>
    `)
  };
}

// -------------------------------------------------------------------------

async function getTransporter(businessId) {
  const { data: emailSettings } = await supabase
    .from('business_email_settings')
    .select('*')
    .eq('business_id', businessId)
    .maybeSingle();

  if (!emailSettings?.smtp_host) return null; // SMTP not configured — caller should skip silently

  const transporter = nodemailer.createTransport({
    host: emailSettings.smtp_host,
    port: emailSettings.smtp_port || 587,
    secure: emailSettings.smtp_port === 465,
    auth: { user: emailSettings.smtp_username, pass: emailSettings.smtp_password }
  });

  return { transporter, fromEmail: emailSettings.from_email, fromName: emailSettings.from_name };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const { businessId, type, bookingId, invoiceId } = req.body || {};
  if (!businessId || !type) return res.status(400).json({ error: 'businessId and type are required' });

  const { data: business } = await supabase.from('businesses').select('*').eq('id', businessId).single();
  if (!business) return res.status(404).json({ error: 'Business not found' });

  const { data: settings } = await supabase.from('business_settings').select('*').eq('business_id', businessId).maybeSingle();

  const mail = await getTransporter(businessId);
  if (!mail) {
    // Not an error — SMTP just isn't set up for this business yet. Fail quiet,
    // same principle as the rest of the app: email is a bonus, not a blocker.
    return res.status(200).json({ sent: false, reason: 'SMTP not configured' });
  }

  let recipientEmail = null;
  let emailContent = null;

  try {
    if (type === 'booking-confirmed' || type === 'booking-declined') {
      const { data: booking } = await supabase.from('bookings').select('*, pets(name), households(id)').eq('id', bookingId).single();
      if (!booking) return res.status(404).json({ error: 'Booking not found' });
      const { data: person } = await supabase.from('people').select('email').eq('household_id', booking.household_id).not('email', 'is', null).limit(1).maybeSingle();
      recipientEmail = person?.email;
      emailContent = type === 'booking-confirmed'
        ? templateBookingConfirmed({ business, settings, booking, petName: booking.pets?.name })
        : templateBookingDeclined({ business, settings, booking, petName: booking.pets?.name });

    } else if (type === 'payment-received') {
      const { data: invoice } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
      if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
      const { data: person } = await supabase.from('people').select('email').eq('household_id', invoice.household_id).not('email', 'is', null).limit(1).maybeSingle();
      recipientEmail = person?.email;
      emailContent = templatePaymentReceived({ business, settings, invoice });

    } else if (type === 'invoice-created') {
      const { data: invoice } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
      if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
      const { data: person } = await supabase.from('people').select('email').eq('household_id', invoice.household_id).not('email', 'is', null).limit(1).maybeSingle();
      recipientEmail = person?.email;
      const paymentOptions = [];
      if (settings?.venmo_handle) paymentOptions.push(`Venmo: ${settings.venmo_handle}`);
      if (settings?.zelle_info) paymentOptions.push(`Zelle: ${settings.zelle_info}`);
      if (settings?.cash_note) paymentOptions.push(`Cash: ${settings.cash_note}`);
      if (settings?.square_link) paymentOptions.push(`Square: ${settings.square_link}`);
      emailContent = templateInvoiceCreated({ business, settings, invoice, paymentOptions });

    } else if (type === 'change-request') {
      const { data: booking } = await supabase.from('bookings').select('*, pets(name)').eq('id', bookingId).single();
      if (!booking) return res.status(404).json({ error: 'Booking not found' });
      recipientEmail = business.notification_email;
      emailContent = templateChangeRequest({ business, settings, booking, petName: booking.pets?.name, message: booking.customer_change_request });

    } else {
      return res.status(400).json({ error: `Unknown notification type: ${type}` });
    }

    if (!recipientEmail) {
      return res.status(200).json({ sent: false, reason: 'No recipient email on file' });
    }

    await mail.transporter.sendMail({
      from: `"${mail.fromName || business.name}" <${mail.fromEmail}>`,
      to: recipientEmail,
      subject: emailContent.subject,
      html: emailContent.html
    });

    return res.status(200).json({ sent: true });
  } catch (err) {
    console.error('[send-notification] Failed:', err.message);
    // 200, not 500 — a failed notification email should never surface as a
    // blocking error to whoever clicked "Confirm" or "Mark Paid" in the app;
    // the underlying action already succeeded in the database.
    return res.status(200).json({ sent: false, error: err.message });
  }
}
