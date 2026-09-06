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

// Appended to a custom template's body when "Attach invoice/receipt details"
// is checked — not a real file attachment, just the invoice summary (or PAID
// confirmation) tacked onto the bottom of the email itself.
function invoiceDetailsHtml(invoice, paymentOptions, isPaid) {
  return `
    <div style="margin-top:20px; padding-top:16px; border-top:2px solid #e5e7eb;">
      ${isPaid ? `<div style="display:inline-block; background:#16a34a; color:#fff; font-weight:700; font-size:12px; padding:4px 12px; border-radius:999px; margin-bottom:10px;">PAID</div>` : ''}
      <div style="font-size:22px; font-weight:700; margin-bottom:8px;">$${Number(invoice.amount || 0).toFixed(2)}</div>
      <p style="font-size:14px; margin:0 0 4px;"><strong>${invoice.description || 'Invoice'}</strong></p>
      ${invoice.due_date ? `<p style="color:#6b7280; font-size:13px; margin:0;">Due ${invoice.due_date}</p>` : ''}
      ${!isPaid && paymentOptions.length ? `
        <div style="margin-top:12px;">
          <div style="font-weight:600; font-size:13px; margin-bottom:4px;">Ways to Pay</div>
          ${paymentOptions.map(p => `<div style="font-size:13px; color:#6b7280;">${p}</div>`).join('')}
        </div>
      ` : ''}
    </div>
  `;
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

const IMMEDIATE_EVENT_MAP = {
  'booking-confirmed': 'booking_confirmed',
  'booking-declined': 'booking_declined',
  'invoice-created': 'invoice_created',
  'payment-received': 'payment_received'
};

function renderMergeFields(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] != null ? String(vars[key]) : ''));
}

/* Looks for a business-authored, active template matching this event —
   scoped to the specific service when we can resolve one (bookings), or
   business-wide when we can't (invoices aren't cleanly tied to one service).
   Returns [] if nothing custom is configured, so the caller can fall back
   to the built-in default wording. */
async function findCustomTemplates(businessId, category, immediateEvent, serviceName) {
  let templateIds = null;

  if (serviceName) {
    const { data: service } = await supabase
      .from('appointment_type_templates')
      .select('id')
      .eq('business_id', businessId)
      .eq('name', serviceName)
      .maybeSingle();

    if (service) {
      const { data: applied } = await supabase
        .from('appointment_template_notices')
        .select('email_template_id')
        .eq('appointment_type_template_id', service.id);
      templateIds = (applied || []).map(a => a.email_template_id);
      if (!templateIds.length) return []; // service exists but has no notices applied — no custom template, use default
    }
  }

  let query = supabase.from('email_templates').select('*')
    .eq('business_id', businessId)
    .eq('category', category)
    .eq('trigger_type', 'immediate')
    .eq('immediate_event', immediateEvent)
    .eq('is_active', true);

  if (templateIds) query = query.in('id', templateIds);

  const { data: templates } = await query;
  return templates || [];
}

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

async function logSend(businessId, { emailTemplateId = null, bookingId = null, invoiceId = null, recipientEmail = null, status, errorMessage = null }) {
  await supabase.from('notice_send_log').insert([{
    business_id: businessId, email_template_id: emailTemplateId, booking_id: bookingId, invoice_id: invoiceId,
    recipient_email: recipientEmail, status, error_message: errorMessage
  }]);
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
    if (bookingId || invoiceId) await logSend(businessId, { bookingId, invoiceId, status: 'skipped_no_smtp' });
    return res.status(200).json({ sent: false, reason: 'SMTP not configured' });
  }

  let recipientEmail = null;
  let emailsToSend = []; // [{ subject, html, emailTemplateId }]
  const category = type === 'change-request' ? null : (type.startsWith('booking') ? 'scheduling' : 'invoice');
  const immediateEvent = IMMEDIATE_EVENT_MAP[type] || null;

  try {
    if (type === 'booking-confirmed' || type === 'booking-declined') {
      const { data: booking } = await supabase.from('bookings').select('*, pets(name), households(id)').eq('id', bookingId).single();
      if (!booking) return res.status(404).json({ error: 'Booking not found' });
      const { data: person } = await supabase.from('people').select('email').eq('household_id', booking.household_id).not('email', 'is', null).limit(1).maybeSingle();
      recipientEmail = person?.email;
      const petName = booking.pets?.name;

      const custom = await findCustomTemplates(businessId, category, immediateEvent, booking.service_name);
      if (custom.length) {
        const when = booking.check_out && booking.check_out.slice(0, 10) !== booking.check_in.slice(0, 10)
          ? `${booking.check_in.slice(0, 10)} → ${booking.check_out.slice(0, 10)}`
          : `${booking.check_in.slice(0, 10)} at ${booking.check_in.slice(11, 16)}`;
        const vars = { business_name: business.name, owner_name: '', pet_name: petName || 'your pet', service_name: booking.service_name, date: when, amount: booking.amount ? `$${Number(booking.amount).toFixed(2)}` : '' };
        emailsToSend = custom.map(t => ({ subject: renderMergeFields(t.subject, vars), html: wrapEmail(headerHtml(business, settings) + `<div>${renderMergeFields(t.body, vars).replace(/\n/g, '<br>')}</div>`), emailTemplateId: t.id }));
      } else {
        emailsToSend = [{ ...(type === 'booking-confirmed' ? templateBookingConfirmed({ business, settings, booking, petName }) : templateBookingDeclined({ business, settings, booking, petName })), emailTemplateId: null }];
      }

    } else if (type === 'payment-received' || type === 'invoice-created') {
      const { data: invoice } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
      if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
      const { data: person } = await supabase.from('people').select('email').eq('household_id', invoice.household_id).not('email', 'is', null).limit(1).maybeSingle();
      recipientEmail = person?.email;

      const paymentOptions = [];
      if (settings?.venmo_handle) paymentOptions.push(`Venmo: ${settings.venmo_handle}`);
      if (settings?.zelle_info) paymentOptions.push(`Zelle: ${settings.zelle_info}`);
      if (settings?.cash_note) paymentOptions.push(`Cash: ${settings.cash_note}`);
      if (settings?.square_link) paymentOptions.push(`Square: ${settings.square_link}`);

      // Invoices aren't cleanly tied to one service (a linked booking's name
      // is the closest we have), so custom-template matching here is
      // business-wide rather than service-scoped.
      const custom = await findCustomTemplates(businessId, 'invoice', immediateEvent, null);
      if (custom.length) {
        const vars = {
          business_name: business.name, owner_name: '', service_name: invoice.description || 'Invoice',
          amount: `$${Number(invoice.amount || 0).toFixed(2)}`, due_date: invoice.due_date || '',
          payment_options: paymentOptions.join(' · ')
        };
        emailsToSend = custom.map(t => ({
          subject: renderMergeFields(t.subject, vars),
          html: wrapEmail(
            headerHtml(business, settings) +
            `<div>${renderMergeFields(t.body, vars).replace(/\n/g, '<br>')}</div>` +
            (t.attach_invoice ? invoiceDetailsHtml(invoice, paymentOptions, type === 'payment-received') : '')
          ),
          emailTemplateId: t.id
        }));
      } else {
        emailsToSend = [{ ...(type === 'payment-received' ? templatePaymentReceived({ business, settings, invoice }) : templateInvoiceCreated({ business, settings, invoice, paymentOptions })), emailTemplateId: null }];
      }

    } else if (type === 'change-request') {
      const { data: booking } = await supabase.from('bookings').select('*, pets(name)').eq('id', bookingId).single();
      if (!booking) return res.status(404).json({ error: 'Booking not found' });
      recipientEmail = business.notification_email;
      emailsToSend = [{ ...templateChangeRequest({ business, settings, booking, petName: booking.pets?.name, message: booking.customer_change_request }), emailTemplateId: null }];

    } else {
      return res.status(400).json({ error: `Unknown notification type: ${type}` });
    }

    if (!recipientEmail) {
      await logSend(businessId, { bookingId, invoiceId, status: 'skipped_no_recipient' });
      return res.status(200).json({ sent: false, reason: 'No recipient email on file' });
    }

    for (const email of emailsToSend) {
      try {
        await mail.transporter.sendMail({
          from: `"${mail.fromName || business.name}" <${mail.fromEmail}>`,
          to: recipientEmail,
          subject: email.subject,
          html: email.html
        });
        await logSend(businessId, { emailTemplateId: email.emailTemplateId, bookingId, invoiceId, recipientEmail, status: 'sent' });
      } catch (sendErr) {
        console.error('[send-notification] Send failed for one email:', sendErr.message);
        await logSend(businessId, { emailTemplateId: email.emailTemplateId, bookingId, invoiceId, recipientEmail, status: 'failed', errorMessage: sendErr.message });
      }
    }

    return res.status(200).json({ sent: true, count: emailsToSend.length });
  } catch (err) {
    console.error('[send-notification] Failed:', err.message);
    // 200, not 500 — a failed notification email should never surface as a
    // blocking error to whoever clicked "Confirm" or "Mark Paid" in the app;
    // the underlying action already succeeded in the database.
    return res.status(200).json({ sent: false, error: err.message });
  }
}
