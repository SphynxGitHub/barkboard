// Supabase Edge Function: create-public-booking
//
// This is the ONLY way the public booking page writes to the database.
// It runs with the service role key (server-side, never exposed to the
// browser), so it can validate everything about the request — which
// business, whether that business has public booking turned on, that
// required fields are present, and resource availability — before
// inserting anything. This is safer than granting anonymous visitors
// direct RLS insert access to households/pets/bookings, which would make
// it far too easy to spam the system or write into another business's
// data by guessing a business_id.
//
// Deploy with:
//   supabase functions deploy create-public-booking
//
// Required secrets (set with `supabase secrets set`):
//   SUPABASE_URL              — auto-provided by Supabase, no need to set
//   SUPABASE_SERVICE_ROLE_KEY — auto-provided by Supabase, no need to set
// (Both are automatically available to every Edge Function; nothing extra
// to configure for this one specifically.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

/* Looks for an existing person in this business with a matching email or
   phone number, and returns their household_id if found. Email match is
   case-insensitive; phone match is exact (no normalization attempted —
   formatting differences like "(555) 123-4567" vs "555-123-4567" won't
   match, which is a deliberate simplification rather than guessing at a
   phone-normalization scheme). Email is checked first since it's the more
   reliable identifier when both are provided. */
async function findExistingHouseholdId(
  client: SupabaseClient,
  businessId: string,
  email: string,
  phone: string
): Promise<string | null> {
  if (email) {
    const { data } = await client
      .from("people")
      .select("household_id")
      .eq("business_id", businessId)
      .ilike("email", email)
      .limit(1)
      .maybeSingle();
    if (data?.household_id) return data.household_id;
  }
  if (phone) {
    const { data } = await client
      .from("people")
      .select("household_id")
      .eq("business_id", businessId)
      .eq("phone", phone)
      .limit(1)
      .maybeSingle();
    if (data?.household_id) return data.household_id;
  }
  return null;
}

/* Checks whether enough total free seats exist across every resource of the
   given type to cover `neededSeats` (the number of pets being booked
   together), not just whether at least one is free — a 2-pet booking needs
   2 free seats, not 1. Returns { checked: false } if the service doesn't
   require a resource type at all (nothing to check, so nothing blocks).
   This IS a hard block when it comes back unavailable — see where it's
   used below. */
async function checkResourceAvailability(
  client: SupabaseClient,
  businessId: string,
  resourceType: string | null,
  startDate: string,
  endDate: string,
  neededSeats: number
): Promise<{ checked: boolean; available: boolean }> {
  if (!resourceType) return { checked: false, available: true };

  const { data: resources } = await client
    .from("resources")
    .select("id, seats")
    .eq("business_id", businessId)
    .eq("type", resourceType);

  if (!resources || !resources.length) {
    // No resource of this type exists at all for this business.
    return { checked: true, available: false };
  }

  const rangeStart = `${startDate}T00:00:00`;
  const rangeEnd = `${endDate || startDate}T23:59:59`;
  const resourceIds = resources.map((r: { id: string }) => r.id);

  const { data: bookedRows } = await client
    .from("booking_resources")
    .select("resource_id, bookings!inner(check_in, check_out, status)")
    .in("resource_id", resourceIds)
    .neq("bookings.status", "cancelled")
    .lte("bookings.check_in", rangeEnd)
    .gte("bookings.check_out", rangeStart);

  const usage: Record<string, number> = {};
  (bookedRows || []).forEach((row: { resource_id: string }) => {
    usage[row.resource_id] = (usage[row.resource_id] || 0) + 1;
  });

  const totalFreeSeats = resources.reduce(
    (sum: number, r: { id: string; seats: number | null }) => sum + Math.max(0, (r.seats || 1) - (usage[r.id] || 0)),
    0
  );
  return { checked: true, available: totalFreeSeats >= neededSeats };
}

/* Sends a "new booking request" email through the BUSINESS'S OWN SMTP
   provider (credentials from business_email_settings — set up under
   Business → Email (SMTP) in the app), not a shared sender for every
   tenant. This is deliberately best-effort: if SMTP isn't configured, or
   sending fails for any reason, we log it and move on — the booking itself
   has already been created successfully by this point, and a notification
   failure shouldn't be reported to the visitor as a booking failure. */
async function sendBookingNotificationEmail(
  client: SupabaseClient,
  businessId: string,
  businessName: string,
  details: { ownerName: string; petSummary: string; contactEmail: string; contactPhone: string }
): Promise<void> {
  const { data: emailSettings } = await client
    .from("business_email_settings")
    .select("smtp_host, smtp_port, smtp_username, smtp_password, from_email, from_name")
    .eq("business_id", businessId)
    .maybeSingle();

  if (!emailSettings?.smtp_host || !emailSettings?.smtp_username || !emailSettings?.smtp_password || !emailSettings?.from_email) {
    console.log("Email not sent: SMTP not fully configured for this business.");
    return;
  }

  // Recipient: the business's chosen notification address, falling back to
  // the owning staff account's login email if none was set.
  const { data: businessRow } = await client
    .from("businesses")
    .select("notification_email")
    .eq("id", businessId)
    .maybeSingle();

  let recipient = businessRow?.notification_email || "";
  if (!recipient) {
    const { data: ownerMember } = await client
      .from("business_members")
      .select("user_id")
      .eq("business_id", businessId)
      .eq("role", "owner")
      .limit(1)
      .maybeSingle();
    if (ownerMember?.user_id) {
      const { data: ownerUser } = await client.auth.admin.getUserById(ownerMember.user_id);
      recipient = ownerUser?.user?.email || "";
    }
  }

  if (!recipient) {
    console.log("Email not sent: no notification_email set and no owner email found.");
    return;
  }

  const smtpClient = new SMTPClient({
    connection: {
      hostname: emailSettings.smtp_host,
      port: emailSettings.smtp_port || 587,
      tls: (emailSettings.smtp_port || 587) === 465, // 465 = implicit TLS; 587 negotiates STARTTLS automatically
      auth: { username: emailSettings.smtp_username, password: emailSettings.smtp_password },
    },
  });

  // A hard timeout around the send itself — even running in the background
  // (via waitUntil), an SMTP connection that hangs forever (wrong host,
  // blocked port, unresponsive provider) would otherwise never resolve and
  // just leak the function instance. 15s is generous for a normal SMTP
  // handshake + send.
  function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)),
    ]);
  }

  try {
    await withTimeout(smtpClient.send({
      from: emailSettings.from_name ? `${emailSettings.from_name} <${emailSettings.from_email}>` : emailSettings.from_email,
      to: recipient,
      subject: `New booking request — ${details.petSummary} (${businessName})`,
      content: "auto",
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 480px;">
          <h2 style="margin:0 0 0.75rem;">New booking request</h2>
          <p style="margin:0 0 1rem; color:#6b7280;">Submitted through your public booking page.</p>
          <table style="width:100%; border-collapse: collapse; font-size: 0.92rem;">
            <tr><td style="padding:0.4rem 0; color:#6b7280;">Owner</td><td style="padding:0.4rem 0;">${details.ownerName}</td></tr>
            <tr><td style="padding:0.4rem 0; color:#6b7280; vertical-align:top;">Requested</td><td style="padding:0.4rem 0;">${details.petSummary.split('; ').join('<br>')}</td></tr>
            <tr><td style="padding:0.4rem 0; color:#6b7280;">Contact</td><td style="padding:0.4rem 0;">${details.contactEmail || ""} ${details.contactPhone || ""}</td></tr>
          </table>
          <p style="margin-top:1.25rem; font-size:0.85rem; color:#6b7280;">Log in to BarkBoard to confirm or decline this request.</p>
        </div>
      `,
    }), 15000);
  } catch (emailError) {
    console.error("Failed to send booking notification email:", emailError);
  } finally {
    try { await withTimeout(smtpClient.close(), 5000); } catch { /* already closed, never opened, or timed out — ignore */ }
  }
}

/* Creates one booking row, resolving (or creating) the pet first. Shared by
   every path below — boarding pets, boarding add-ons, and single-category
   service bookings — so there's one place that does this correctly. */
async function createBookingForPet(
  client: SupabaseClient,
  businessId: string,
  householdId: string,
  petName: string,
  petSpecies: string,
  serviceName: string,
  checkIn: string,
  checkOut: string,
  amount: number,
  notes: string,
  flexibleTime: boolean,
  parentBookingId: string | null
): Promise<{ id: string } | { error: string }> {
  const { data: existingPet } = await client
    .from("pets")
    .select("id")
    .eq("household_id", householdId)
    .ilike("name", petName)
    .limit(1)
    .maybeSingle();

  let petId: string;
  if (existingPet) {
    petId = existingPet.id;
  } else {
    const { data: newPet, error: petError } = await client
      .from("pets")
      .insert([{ name: petName, species: petSpecies || null, household_id: householdId, business_id: businessId }])
      .select()
      .single();
    if (petError || !newPet) {
      console.error("Pet creation failed:", petError);
      return { error: "Could not create booking. Please try again or contact us directly." };
    }
    petId = newPet.id;
  }

  const { data: booking, error: bookingError } = await client.from("bookings").insert([{
    household_id: householdId,
    pet_id: petId,
    service_name: serviceName,
    check_in: checkIn,
    check_out: checkOut,
    amount,
    status: "pending",
    source: "public",
    notes: notes || null,
    flexible_time: flexibleTime,
    parent_booking_id: parentBookingId,
    business_id: businessId,
  }]).select().single();

  if (bookingError || !booking) {
    console.error("Booking creation failed:", bookingError);
    return { error: "Could not create booking. Please try again or contact us directly." };
  }
  return { id: booking.id };
}

/* Computes a template's price for a given date range, honoring flat vs
   per-day pricing — same logic used throughout the rest of the app. */
function computeAmount(template: { default_price: number | null; pricing_unit: string | null } | null, startDate: string, endDate: string): number {
  if (template?.default_price == null) return 0;
  if (template.pricing_unit === "per_day" && endDate && endDate !== startDate) {
    const days = Math.max(1, Math.ceil(
      (new Date(endDate).getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24)
    ));
    return Number(template.default_price) * days;
  }
  return Number(template.default_price);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
  }

  const slug = String(body.slug || "").trim();
  const ownerName = String(body.ownerName || "").trim();
  const contactEmail = String(body.contactEmail || "").trim();
  const contactPhone = String(body.contactPhone || "").trim();
  const notes = String(body.notes || "").trim();

  // deno-lint-ignore no-explicit-any
  const rawGroups = Array.isArray(body.bookingGroups) ? (body.bookingGroups as any[]) : [];
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;

  type PetInput = { name: string; species: string; serviceName: string };
  type BookingGroup = {
    category: string;
    pets: PetInput[];
    // boarding fields
    startDate?: string; endDate?: string; dropoffTime?: string; pickupTime?: string;
    addOns?: { serviceName: string; petName: string }[];
    // single-service fields
    date?: string; time?: string;
  };

  const bookingGroups: BookingGroup[] = rawGroups.map((g) => ({
    category: String(g?.category || "").trim(),
    pets: (Array.isArray(g?.pets) ? g.pets : [])
      .map((p: any) => ({
        name: String(p?.name || "").trim(),
        species: String(p?.species || "").trim(),
        serviceName: String(p?.serviceName || "").trim(),
      }))
      .filter((p: PetInput) => p.name),
    startDate: g?.startDate ? String(g.startDate).trim() : undefined,
    endDate: g?.endDate ? String(g.endDate).trim() : undefined,
    dropoffTime: g?.dropoffTime ? String(g.dropoffTime).trim() : undefined,
    pickupTime: g?.pickupTime ? String(g.pickupTime).trim() : undefined,
    addOns: Array.isArray(g?.addOns)
      ? g.addOns.map((a: any) => ({ serviceName: String(a?.serviceName || "").trim(), petName: String(a?.petName || "").trim() })).filter((a: any) => a.serviceName && a.petName)
      : [],
    date: g?.date ? String(g.date).trim() : undefined,
    time: g?.time ? String(g.time).trim() : undefined,
  }));

  // --- Validation -----------------------------------------------------
  const missing: string[] = [];
  if (!slug) missing.push("slug");
  if (!ownerName) missing.push("ownerName");
  if (!contactEmail && !contactPhone) missing.push("contactEmail or contactPhone");
  if (!bookingGroups.length) missing.push("at least one booking");
  bookingGroups.forEach((g, i) => {
    if (!g.pets.length) missing.push(`pet(s) for booking #${i + 1}`);
    if (g.pets.some((p) => !p.serviceName)) missing.push(`service selection for every pet in booking #${i + 1}`);
    if (g.category === "boarding") {
      if (!g.startDate || !dateRe.test(g.startDate)) missing.push(`valid start date for booking #${i + 1}`);
      if (!g.endDate || !dateRe.test(g.endDate)) missing.push(`valid end date for booking #${i + 1}`);
    } else {
      if (!g.date || !dateRe.test(g.date)) missing.push(`valid date for booking #${i + 1}`);
      if (!g.time) missing.push(`time for booking #${i + 1}`);
    }
  });
  if (missing.length) {
    return jsonResponse({ success: false, error: `Missing required field(s): ${missing.join(", ")}` }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const client = createClient(supabaseUrl, serviceRoleKey);

  // --- Resolve the business from the slug, and confirm it opted in ----
  const { data: business, error: bizError } = await client
    .from("businesses")
    .select("id, name, public_booking_enabled")
    .eq("slug", slug)
    .maybeSingle();

  if (bizError) {
    console.error("Business lookup failed:", bizError);
    return jsonResponse({ success: false, error: "Could not look up business." }, 500);
  }
  if (!business || !business.public_booking_enabled) {
    return jsonResponse({ success: false, error: "This booking page is not available." }, 404);
  }

  const businessId = business.id;

  // --- Match to an existing household by email/phone, or create new ---
  const existingHouseholdId = await findExistingHouseholdId(client, businessId, contactEmail, contactPhone);

  let householdId: string;
  if (existingHouseholdId) {
    householdId = existingHouseholdId;
  } else {
    const { data: household, error: hhError } = await client
      .from("households")
      .insert([{ name: ownerName, business_id: businessId, note: "Created from public booking page" }])
      .select()
      .single();

    if (hhError || !household) {
      console.error("Household creation failed:", hhError);
      return jsonResponse({ success: false, error: "Could not create booking. Please try again or contact us directly." }, 500);
    }
    householdId = household.id;

    const { error: personError } = await client.from("people").insert([{
      household_id: householdId,
      name: ownerName,
      contact: contactEmail || contactPhone,
      email: contactEmail || null,
      phone: contactPhone || null,
      role: "Primary",
      category: "member",
      business_id: businessId,
    }]);
    if (personError) console.error("Person creation failed (continuing):", personError);
  }

  // Tracks how many seats of each resource_type have already been claimed by
  // an earlier pet/group in THIS SAME request — shared across every group in
  // the submission, since two different groups could still compete for the
  // same physical resource.
  const claimedThisRequest: Record<string, number> = {};
  const bookingSummaries: string[] = [];

  async function claimAndCheck(resourceType: string | null, startDate: string, endDate: string): Promise<string | null> {
    if (!resourceType) return null;
    const alreadyClaimed = claimedThisRequest[resourceType] || 0;
    const availability = await checkResourceAvailability(client, businessId, resourceType, startDate, endDate, alreadyClaimed + 1);
    if (!availability.available) return "no availability";
    claimedThisRequest[resourceType] = alreadyClaimed + 1;
    return null;
  }

  for (const group of bookingGroups) {
    if (group.category === "boarding") {
      const startDate = group.startDate!, endDate = group.endDate!;
      const checkIn = `${startDate}T${group.dropoffTime || "00:00"}:00`;
      const checkOut = `${endDate}T${group.pickupTime || "23:59"}:00`;

      const petIdByName: Record<string, string> = {};

      for (const pet of group.pets) {
        const { data: template } = await client
          .from("appointment_type_templates")
          .select("name, default_price, pricing_unit, resource_type")
          .eq("business_id", businessId)
          .eq("name", pet.serviceName || "")
          .maybeSingle();

        const claimError = await claimAndCheck(template?.resource_type || null, startDate, endDate);
        if (claimError) {
          return jsonResponse({
            success: false,
            error: `Sorry, we don't have boarding availability for ${pet.name} on those dates. Please try different dates or contact ${business.name} directly.`,
          }, 409);
        }

        const amount = computeAmount(template, startDate, endDate);
        const result = await createBookingForPet(
          client, businessId, householdId, pet.name, pet.species,
          pet.serviceName || "Boarding", checkIn, checkOut, amount, notes, false, null
        );
        if ("error" in result) return jsonResponse({ success: false, error: result.error }, 500);
        petIdByName[pet.name] = result.id;
        bookingSummaries.push(`${pet.name} — ${pet.serviceName} (${startDate} → ${endDate})`);
      }

      // Add-ons: separate flexible-time bookings, linked back to their pet's boarding booking.
      for (const addOn of group.addOns || []) {
        const parentBookingId = petIdByName[addOn.petName] || null;
        const { data: addOnTemplate } = await client
          .from("appointment_type_templates")
          .select("default_price, pricing_unit, resource_type")
          .eq("business_id", businessId)
          .eq("name", addOn.serviceName)
          .maybeSingle();

        const claimError = await claimAndCheck(addOnTemplate?.resource_type || null, startDate, endDate);
        if (claimError) {
          return jsonResponse({
            success: false,
            error: `Sorry, we don't have availability for the "${addOn.serviceName}" add-on (${addOn.petName}). Please remove it or contact ${business.name} directly.`,
          }, 409);
        }

        const petSpecies = group.pets.find((p) => p.name === addOn.petName)?.species || "";
        const amount = computeAmount(addOnTemplate, startDate, endDate);
        const addOnNotes = ["⚠️ Flexible time — schedule anytime during the stay, complete before pickup.", notes].filter(Boolean).join("\n\n");
        const result = await createBookingForPet(
          client, businessId, householdId, addOn.petName, petSpecies,
          addOn.serviceName, `${startDate}T00:00:00`, `${endDate}T00:00:00`,
          amount, addOnNotes, true, parentBookingId
        );
        if ("error" in result) return jsonResponse({ success: false, error: result.error }, 500);
        bookingSummaries.push(`${addOn.petName} — ${addOn.serviceName} (add-on, flexible time)`);
      }
    } else {
      // Grooming / Training / Daycare — shared date/time for the group, but
      // each pet now picks its own specific service.
      const checkIn = `${group.date}T${group.time}:00`;
      const checkOut = checkIn;
      const multiPetNote = group.pets.length > 1
        ? `⚠️ Requested together with ${group.pets.length - 1} other pet(s) at this time — actual appointment times may need to be staggered depending on staff availability.`
        : "";

      for (const pet of group.pets) {
        const { data: template } = await client
          .from("appointment_type_templates")
          .select("name, default_price, pricing_unit, resource_type, requires_staff_time")
          .eq("business_id", businessId)
          .eq("name", pet.serviceName || "")
          .maybeSingle();

        const claimError = await claimAndCheck(template?.resource_type || null, group.date!, group.date!);
        if (claimError) {
          return jsonResponse({
            success: false,
            error: `Sorry, we don't have availability for "${pet.serviceName}" (${pet.name}) on that date/time. Please try a different time or contact ${business.name} directly.`,
          }, 409);
        }

        const staffFlag = template?.requires_staff_time
          ? "⚠️ This service requires dedicated staff time — confirm staffing before accepting."
          : "";
        const petNotes = [staffFlag, multiPetNote, notes].filter(Boolean).join("\n\n");

        const amount = computeAmount(template, group.date!, group.date!);
        const result = await createBookingForPet(
          client, businessId, householdId, pet.name, pet.species,
          pet.serviceName || group.category, checkIn, checkOut, amount, petNotes, false, null
        );
        if ("error" in result) return jsonResponse({ success: false, error: result.error }, 500);
        bookingSummaries.push(`${pet.name} — ${pet.serviceName} (${group.date} ${group.time})`);
      }
    }
  }

  const allPetNames = Array.from(new Set(bookingGroups.flatMap((g) => g.pets.map((p) => p.name))));

  // Fire-and-forget: previously this was `await`ed, which meant if the SMTP
  // connection hung (unreachable host, blocked port, slow provider), the
  // whole function would eventually get killed by the platform's execution
  // timeout — and since it never got to send a response, the browser saw
  // that as a raw network failure ("Failed to fetch"), even though the
  // booking itself had already been written successfully by this point.
  // EdgeRuntime.waitUntil lets this keep running in the background after
  // the response below is already on its way to the visitor.
  const emailTask = sendBookingNotificationEmail(client, businessId, business.name, {
    ownerName, petSummary: bookingSummaries.join("; "), contactEmail, contactPhone,
  }).catch((e) => console.error("Notification email step failed:", e));

  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) {
    runtime.waitUntil(emailTask);
  }
  // If EdgeRuntime isn't available for some reason, emailTask still runs —
  // it just isn't guaranteed to finish before the function instance is
  // recycled. Either way, the response below is returned immediately.

  return jsonResponse({
    success: true,
    message: `Thanks! Your request${bookingGroups.length > 1 ? "s" : ""} for ${allPetNames.join(", ")} ${bookingGroups.length > 1 ? "have" : "has"} been sent to ${business.name}. They'll be in touch to confirm.`,
  });
});
