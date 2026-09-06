import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

function renderMergeFields(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] != null ? String(vars[key]) : ''));
}

// SMTP settings are fetched once per business per run, not once per email —
// this cron can process many bookings/invoices across many businesses in one
// pass, so re-querying the same business's settings repeatedly would add up.
const transporterCache = new Map();
async function getTransporter(businessId) {
  if (transporterCache.has(businessId)) return transporterCache.get(businessId);

  const { data: emailSettings } = await supabase
    .from('business_email_settings')
    .select('*')
    .eq('business_id', businessId)
    .maybeSingle();

  const result = emailSettings?.smtp_host
    ? {
        transporter: nodemailer.createTransport({
          host: emailSettings.smtp_host,
          port: emailSettings.smtp_port || 587,
          secure: emailSettings.smtp_port === 465,
          auth: { user: emailSettings.smtp_username, pass: emailSettings.smtp_password }
        }),
        fromEmail: emailSettings.from_email,
        fromName: emailSettings.from_name
      }
    : null;

  transporterCache.set(businessId, result);
  return result;
}

async function alreadySent(templateId, bookingId, invoiceId) {
  let query = supabase.from('notice_send_log').select('id').eq('email_template_id', templateId).eq('status', 'sent').limit(1);
  query = bookingId ? query.eq('booking_id', bookingId) : query.eq('invoice_id', invoiceId);
  const { data } = await query;
  return !!(data && data.length);
}

async function logSend(businessId, { emailTemplateId, bookingId = null, invoiceId = null, recipientEmail = null, status, errorMessage = null }) {
  await supabase.from('notice_send_log').insert([{
    business_id: businessId, email_template_id: emailTemplateId, booking_id: bookingId, invoice_id: invoiceId,
    recipient_email: recipientEmail, status, error_message: errorMessage
  }]);
}

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).send('Unauthorized');
  }

  const { data: templates } = await supabase
    .from('email_templates')
    .select('*')
    .eq('is_active', true)
    .in('trigger_type', ['before', 'after']);

  const results = [];

  for (const template of templates || []) {
    // "2 days before" an appointment on date X means: send when today = X - 2,
    // i.e. the target date to look for is today + offset_days. "1 day after"
    // means the target event date was offset_days days ago.
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + (template.trigger_type === 'before' ? template.offset_days : -template.offset_days));
    const targetDateStr = targetDate.toISOString().slice(0, 10);

    const { data: business } = await supabase.from('businesses').select('*').eq('id', template.business_id).single();
    if (!business) continue;
    const { data: settings } = await supabase.from('business_settings').select('*').eq('business_id', template.business_id).maybeSingle();
    const mail = await getTransporter(template.business_id);
    if (!mail) continue; // SMTP not configured for this business — nothing to send

    if (template.category === 'scheduling') {
      const { data: applied } = await supabase.from('appointment_template_notices').select('appointment_type_template_id').eq('email_template_id', template.id);
      const serviceIds = (applied || []).map(a => a.appointment_type_template_id);
      if (!serviceIds.length) continue;
      const { data: services } = await supabase.from('appointment_type_templates').select('name').in('id', serviceIds);
      const serviceNames = (services || []).map(s => s.name);
      if (!serviceNames.length) continue;

      const { data: bookings } = await supabase.from('bookings').select('*, pets(name)')
        .eq('business_id', template.business_id)
        .eq('status', 'confirmed')
        .in('service_name', serviceNames)
        .gte('check_in', `${targetDateStr}T00:00:00`)
        .lte('check_in', `${targetDateStr}T23:59:59`);

      for (const booking of bookings || []) {
        if (await alreadySent(template.id, booking.id, null)) continue;

        const { data: person } = await supabase.from('people').select('email').eq('household_id', booking.household_id).not('email', 'is', null).limit(1).maybeSingle();
        if (!person?.email) {
          await logSend(template.business_id, { emailTemplateId: template.id, bookingId: booking.id, status: 'skipped_no_recipient' });
          continue;
        }

        const when = booking.check_out && booking.check_out.slice(0, 10) !== booking.check_in.slice(0, 10)
          ? `${booking.check_in.slice(0, 10)} → ${booking.check_out.slice(0, 10)}`
          : `${booking.check_in.slice(0, 10)} at ${booking.check_in.slice(11, 16)}`;
        const vars = { business_name: business.name, pet_name: booking.pets?.name || 'your pet', service_name: booking.service_name, date: when, amount: booking.amount ? `$${Number(booking.amount).toFixed(2)}` : '' };

        try {
          await mail.transporter.sendMail({
            from: `"${mail.fromName || business.name}" <${mail.fromEmail}>`,
            to: person.email,
            subject: renderMergeFields(template.subject, vars),
            html: wrapEmail(headerHtml(business, settings) + `<div>${renderMergeFields(template.body, vars).replace(/\n/g, '<br>')}</div>`)
          });
          await logSend(template.business_id, { emailTemplateId: template.id, bookingId: booking.id, recipientEmail: person.email, status: 'sent' });
          results.push({ template: template.name, bookingId: booking.id, status: 'sent' });
        } catch (err) {
          await logSend(template.business_id, { emailTemplateId: template.id, bookingId: booking.id, recipientEmail: person.email, status: 'failed', errorMessage: err.message });
          results.push({ template: template.name, bookingId: booking.id, status: 'failed', error: err.message });
        }
      }

    } else {
      // Invoice notices aren't scoped to a specific service (see the same
      // limitation noted in send-notification.js) — business-wide by due_date.
      const { data: invoices } = await supabase.from('invoices').select('*')
        .eq('business_id', template.business_id)
        .eq('status', 'unpaid')
        .eq('due_date', targetDateStr);

      const paymentOptions = [];
      if (settings?.venmo_handle) paymentOptions.push(`Venmo: ${settings.venmo_handle}`);
      if (settings?.zelle_info) paymentOptions.push(`Zelle: ${settings.zelle_info}`);
      if (settings?.cash_note) paymentOptions.push(`Cash: ${settings.cash_note}`);
      if (settings?.square_link) paymentOptions.push(`Square: ${settings.square_link}`);

      for (const invoice of invoices || []) {
        if (await alreadySent(template.id, null, invoice.id)) continue;

        const { data: person } = await supabase.from('people').select('email').eq('household_id', invoice.household_id).not('email', 'is', null).limit(1).maybeSingle();
        if (!person?.email) {
          await logSend(template.business_id, { emailTemplateId: template.id, invoiceId: invoice.id, status: 'skipped_no_recipient' });
          continue;
        }

        const vars = { business_name: business.name, service_name: invoice.description || 'Invoice', amount: `$${Number(invoice.amount || 0).toFixed(2)}`, due_date: invoice.due_date || '', payment_options: paymentOptions.join(' · ') };

        try {
          await mail.transporter.sendMail({
            from: `"${mail.fromName || business.name}" <${mail.fromEmail}>`,
            to: person.email,
            subject: renderMergeFields(template.subject, vars),
            html: wrapEmail(headerHtml(business, settings) + `<div>${renderMergeFields(template.body, vars).replace(/\n/g, '<br>')}</div>`)
          });
          await logSend(template.business_id, { emailTemplateId: template.id, invoiceId: invoice.id, recipientEmail: person.email, status: 'sent' });
          results.push({ template: template.name, invoiceId: invoice.id, status: 'sent' });
        } catch (err) {
          await logSend(template.business_id, { emailTemplateId: template.id, invoiceId: invoice.id, recipientEmail: person.email, status: 'failed', errorMessage: err.message });
          results.push({ template: template.name, invoiceId: invoice.id, status: 'failed', error: err.message });
        }
      }
    }
  }

  return res.status(200).json({ processed: results.length, results });
}
