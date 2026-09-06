// Credentials
const SUPABASE_URL = 'https://qhfdtnylbpbooicsbhct.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFoZmR0bnlsYnBib29pY3NiaGN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0NTI5NDMsImV4cCI6MjEwNDAyODk0M30.SnLDb2BP0WVI2HCyuDLxt5qdnGBzRmd6cjgHDCpQKRo';

async function attachResourceNames(client, bookings) {
    if (!bookings || !bookings.length) return bookings || [];
    const { data: allResources } = await client.from('resources').select('id, name, type');
    const map = {};
    (allResources || []).forEach(r => { map[r.id] = r; });
    bookings.forEach(bk => {
        bk.resources = bk.space_id ? (map[bk.space_id] || null) : null;
        bk.staff_time_resource = bk.staff_time_resource_id ? (map[bk.staff_time_resource_id] || null) : null;
    });

    // Also pull the new multi-resource assignments so display code can show all of them.
    // Joined manually in JS (rather than a nested PostgREST embed) since booking_resources
    // has more than one relationship to resources and the embed can't disambiguate it.
    const bookingIds = bookings.map(bk => bk.id);
    const { data: assignments } = await client.from('booking_resources').select('*').in('booking_id', bookingIds);
    const byBooking = {};
    (assignments || []).forEach(a => {
        if (!byBooking[a.booking_id]) byBooking[a.booking_id] = [];
        const res = map[a.resource_id];
        byBooking[a.booking_id].push({
            name: res?.name || 'Resource',
            type: res?.type || '',
            allDay: a.all_day,
            startTime: a.start_time,
            endTime: a.end_time
        });
    });
    bookings.forEach(bk => { bk.resourceAssignments = byBooking[bk.id] || []; });

    return bookings;
}

function padSingleDigitResourceName(name) {
    if (!name) return '';
    // Replaces standalone single digits or numbers prefixed with space/hash/hyphen
    return name.replace(/(^|[\s#\-])(\d)(?!\d)/g, '$10$2');
}

async function attachInvoiceStatuses(client, bookings) {
    if (!bookings || !bookings.length) return bookings || [];
    const invoiceIds = bookings.map(bk => bk.invoice_id).filter(Boolean);
    if (!invoiceIds.length) return bookings;
    const { data: invoices } = await client.from('invoices').select('id, status').in('id', invoiceIds);
    const map = {};
    (invoices || []).forEach(inv => { map[inv.id] = inv.status; });
    bookings.forEach(bk => {
        bk.invoiceStatus = bk.invoice_id ? (map[bk.invoice_id] || null) : null;
    });
    return bookings;
}

function getSupabase() {
    if (!window.supabaseClient) {
        if (!window.supabase || typeof window.supabase.createClient !== 'function') {
            console.error('Supabase Client SDK has not loaded yet.');
            return null;
        }
        window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            // Without this, this staff app and the customer portal (portal.html)
            // share the exact same localStorage session slot by default (same
            // origin, same Supabase project) — logging into one silently logs
            // out the other. A distinct storage key per surface keeps their
            // sessions completely independent.
            auth: { storageKey: 'barkboard-staff-auth' }
        });
    }
    return window.supabaseClient;
}

/**
 * Safely triggers Lucide icon generation after dynamic DOM updates
 */
function refreshIcons() {
    if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
        lucide.createIcons();
    }
}

/* ==========================================================================
   AUTH GATE: Supabase Auth login required before the app boots
   ========================================================================== */

let currentBusinessId = null;
let currentUser = null;

function showAuthGate(errorMessage) {
    document.getElementById('auth-gate')?.classList.remove('hidden');
    const errEl = document.getElementById('auth-error');
    if (errEl) {
        if (errorMessage) {
            errEl.textContent = errorMessage;
            errEl.classList.remove('hidden');
        } else {
            errEl.classList.add('hidden');
        }
    }
}

function hideAuthGate() {
    document.getElementById('auth-gate')?.classList.add('hidden');
}

/* Toggles between the Sign In and Create Account forms on the auth gate. */
function showAuthTab(tab) {
    const isSignup = tab === 'signup';
    document.getElementById('auth-login-form')?.classList.toggle('hidden', isSignup);
    document.getElementById('auth-signup-form')?.classList.toggle('hidden', !isSignup);
    document.getElementById('auth-toggle-to-signup')?.classList.toggle('hidden', isSignup);
    document.getElementById('auth-toggle-to-login')?.classList.toggle('hidden', !isSignup);
    document.getElementById('auth-gate-subtitle').textContent = isSignup ? 'Create your business account' : 'Sign in to your business';
    document.getElementById('auth-error')?.classList.add('hidden');
    document.getElementById('signup-error')?.classList.add('hidden');
    document.getElementById('auth-success-box')?.classList.add('hidden');
}

async function handleLoginSubmit() {
    const client = getSupabase();
    if (!client) return showAuthGate('Database connection unavailable.');

    const email = document.getElementById('auth-email')?.value.trim();
    const password = document.getElementById('auth-password')?.value;
    const submitBtn = document.getElementById('auth-submit-btn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Signing in...'; }

    const { data, error } = await client.auth.signInWithPassword({ email, password });

    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Sign In'; }

    if (error) {
        showAuthGate(error.message);
        return;
    }

    currentUser = data.user;
    await resolveBusinessAndEnterApp();
}

/* Creates a new Supabase Auth user AND a new business for them in one flow,
   using the create_business_for_current_user() RPC (see migration 005) so
   the business + owner-membership rows are created atomically and safely,
   without needing to loosen RLS on businesses/business_members directly. */
async function handleSignupSubmit() {
    const client = getSupabase();
    if (!client) return showSignupError('Database connection unavailable.');

    const businessName = document.getElementById('signup-business-name')?.value.trim();
    const email = document.getElementById('signup-email')?.value.trim();
    const password = document.getElementById('signup-password')?.value;
    const submitBtn = document.getElementById('signup-submit-btn');

    if (!businessName) return showSignupError('Please enter your business name.');

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Creating account...'; }

    const { data: signUpData, error: signUpError } = await client.auth.signUp({
        email,
        password,
        options: {
            // Stashed here specifically so the business can still be created after
            // email confirmation, when signUp() doesn't hand back a session and
            // this browser tab has no memory of what was typed by the time they
            // actually log in later — see the pending_business_name check in
            // resolveBusinessAndEnterApp().
            data: { pending_business_name: businessName },
            // Explicit redirect target so confirmation always lands back on this
            // app regardless of what's configured as the project's Site URL —
            // that dashboard setting is still required as a fallback/allowlist
            // entry, but this takes precedence when both are set.
            emailRedirectTo: window.location.origin + window.location.pathname
        }
    });

    if (signUpError) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Create Account'; }
        return showSignupError(signUpError.message);
    }

    // If the Supabase project has email confirmation turned on, signUp()
    // succeeds but doesn't return a usable session yet — the person has to
    // confirm their email and then log in normally. If confirmation is off,
    // a session comes back immediately and we can finish setup right away.
    if (!signUpData.session) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Create Account'; }
        showAuthTab('login');
        const successBox = document.getElementById('auth-success-box');
        if (successBox) {
            successBox.textContent = 'Account created! Check your email to confirm it, then sign in below.';
            successBox.classList.remove('hidden');
        }
        return;
    }

    currentUser = signUpData.user;

    const slug = slugify(businessName) || `business-${Date.now()}`;
    const { error: bizError } = await client.rpc('create_business_for_current_user', {
        business_name: businessName,
        business_slug: slug
    });

    if (bizError) {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Create Account'; }
        return showSignupError('Account created, but setting up your business failed: ' + bizError.message + '. Please contact support.');
    }

    await resolveBusinessAndEnterApp();
}

function showSignupError(message) {
    const errEl = document.getElementById('signup-error');
    if (!errEl) return;
    errEl.textContent = message;
    errEl.classList.remove('hidden');
}

async function handleLogout() {
    const client = getSupabase();
    if (client) await client.auth.signOut();
    // Full reload rather than trying to hand-reset every in-memory variable
    // and re-show the gate — much less error-prone for a full sign-out.
    window.location.reload();
}

/* Looks up which business the signed-in user belongs to (via the
   current_business_id() RPC added in the multi-tenant migration), then
   reveals the app. If the user isn't attached to any business, they're kept
   at the gate with an explanatory error rather than let into an app that
   can't resolve business_id for any of its inserts. */
async function resolveBusinessAndEnterApp() {
    const client = getSupabase();
    if (!client) return showAuthGate('Database connection unavailable.');

    let { data: businessId, error } = await client.rpc('current_business_id');

    // No business yet — but if this login is completing a signup that required
    // email confirmation (pending_business_name was stashed on the user at
    // signup time), finish creating it now instead of leaving them stuck.
    if ((error || !businessId) && currentUser?.user_metadata?.pending_business_name) {
        const pendingName = currentUser.user_metadata.pending_business_name;
        const slug = slugify(pendingName) || `business-${Date.now()}`;
        const { data: newBusinessId, error: createError } = await client.rpc('create_business_for_current_user', {
            business_name: pendingName,
            business_slug: slug
        });

        if (createError) {
            showAuthGate('Could not finish setting up your business: ' + createError.message + '. Please contact support.');
            return;
        }

        businessId = newBusinessId;
        error = null;

        // Clear the pending flag now that it's been used, so a later signup
        // hiccup or metadata edit can't accidentally re-trigger this.
        await client.auth.updateUser({ data: { pending_business_name: null } });
    }

    if (error || !businessId) {
        showAuthGate("Your account isn't linked to a business yet. Contact your admin.");
        return;
    }

    currentBusinessId = businessId;
    hideAuthGate();

    const { data: business } = await client.from('businesses').select('name, onboarding_completed').eq('id', currentBusinessId).single();
    if (business && !business.onboarding_completed) {
        openOnboardingWizard(business.name);
    } else {
        bootstrapApp();
    }
}

/* Runs once on page load: checks for an existing Supabase Auth session
   (returning visit) before falling back to showing the login form. */
async function initAuthGate() {
    const client = getSupabase();
    if (!client) return showAuthGate('Database connection unavailable.');

    const { data: { session } } = await client.auth.getSession();
    if (session?.user) {
        currentUser = session.user;
        await resolveBusinessAndEnterApp();
    } else {
        showAuthGate();
    }

    // Without this, a tab that's already showing the app as one user has no
    // way to notice if the underlying Supabase session changes out from under
    // it — e.g. confirming a signup in a new tab while an old session was
    // still active in this one, or another tab signing out. Supabase updates
    // its session in localStorage and fires this across tabs; a full reload
    // is the simplest way to guarantee every in-memory variable (currentUser,
    // currentBusinessId, whatever's already rendered) gets rebuilt from
    // scratch for whoever is actually logged in now, rather than trying to
    // hot-swap partial state and risk exactly the kind of stale-business
    // mix-up this was added to prevent.
    let lastKnownUserId = session?.user?.id || null;
    client.auth.onAuthStateChange((event, newSession) => {
        const newUserId = newSession?.user?.id || null;
        if (newUserId !== lastKnownUserId) {
            lastKnownUserId = newUserId;
            window.location.reload();
        }
    });
}

/* ==========================================================================
   ONBOARDING WIZARD — shown once after signup to collect starter data
   (staff, resources, services) and turn it into real records, rather than
   leaving a brand-new account completely empty. Re-openable later via
   Business settings (openOnboardingWizard called with reopen=true skips
   touching onboarding_completed on finish, since it's already been done).
   ========================================================================== */

let obCurrentStep = 0;
let obRowCounter = 0;
let obIsReopen = false;
const OB_STEP_COUNT = 8; // steps 0-7
const OB_DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const OB_STEP_META = [
    { title: 'Welcome!', subtitle: "Let's get your business set up.", icon: '🐾' },
    { title: 'Business Info', subtitle: 'How customers will see and reach you.', icon: '🏢' },
    { title: 'Hours of Operation', subtitle: 'When are you open?', icon: '🕐' },
    { title: 'Payment Info', subtitle: 'How can customers pay you?', icon: '💳' },
    { title: 'Your Team', subtitle: 'Add the people who work with you.', icon: '👥' },
    { title: 'Your Spaces', subtitle: 'What do you have room for?', icon: '🏠' },
    { title: 'Your Services', subtitle: 'What can customers book?', icon: '📋' },
    { title: "You're all set!", subtitle: '', icon: '✅' },
];

async function openOnboardingWizard(businessName, reopen = false) {
    obIsReopen = reopen;
    obCurrentStep = 0;
    obRowCounter = 0;
    document.getElementById('ob-staff-rows').innerHTML = '';
    document.getElementById('ob-resource-rows').innerHTML = '';
    document.getElementById('ob-service-rows').innerHTML = '';
    document.getElementById('ob-finish-error')?.classList.add('hidden');
    obAddStaffRow();
    obAddResourceRow();
    obAddServiceRow();

    // Prefill Business Info + Hours from whatever's already saved, so
    // reopening the wizard later (or a slow double-open) doesn't clobber
    // real settings with blanks.
    const client = getSupabase();
    if (client && currentBusinessId) {
        const { data: biz } = await client.from('businesses')
            .select('logo_url, accent_color, notification_email, public_booking_enabled, contact_phone, contact_email, address')
            .eq('id', currentBusinessId).single();
        document.getElementById('ob-logo-url').value = biz?.logo_url || '';
        updateOnboardingLogoPreview();
        document.getElementById('ob-accent-color').value = biz?.accent_color || '#4f46e5';
        document.getElementById('ob-notify-email').value = biz?.notification_email || '';
        document.getElementById('ob-contact-phone').value = biz?.contact_phone || '';
        document.getElementById('ob-contact-email').value = biz?.contact_email || '';
        document.getElementById('ob-address').value = biz?.address || '';
        document.getElementById('ob-enable-public-booking').checked = !!biz?.public_booking_enabled;

        // 2. Prefill the onboarding timezone selector (defaults to America/New_York)
        const tzSelect = document.getElementById('ob-timezone');
        if (tzSelect) {
            tzSelect.value = biz?.timezone || 'America/New_York';
        }

        const settings = typeof getBusinessSettings === 'function' ? await getBusinessSettings() : null;
        document.getElementById('ob-pay-venmo').value = settings?.venmo_handle || '';
        document.getElementById('ob-pay-zelle').value = settings?.zelle_info || '';
        document.getElementById('ob-pay-cash').value = settings?.cash_note || '';
        document.getElementById('ob-pay-square').value = settings?.square_link || '';

        obRenderHoursRows(client);
    } else {
        obRenderHoursRows(null);
    }

    renderObStep();
    document.getElementById('onboarding-modal')?.classList.remove('hidden');
}

async function obRenderHoursRows(client) {
    let byDay = {};
    if (client && currentBusinessId) {
        const { data: hours } = await client.from('business_hours').select('*').eq('business_id', currentBusinessId);
        (hours || []).forEach(h => { byDay[h.day_of_week] = h; });
    }
    const container = document.getElementById('ob-hours-rows');
    if (!container) return;
    container.innerHTML = OB_DAYS_OF_WEEK.map((dayName, i) => {
        const h = byDay[i];
        const isClosed = h ? h.is_closed : (i === 0);
        const openVal = h?.open_time ? h.open_time.slice(0, 5) : '09:00';
        const closeVal = h?.close_time ? h.close_time.slice(0, 5) : '17:00';
        return `
            <div style="display:flex; align-items:center; gap:0.5rem;">
                <span style="width:80px; font-size:0.82rem; font-weight:600;">${dayName}</span>
                <label style="display:flex; align-items:center; gap:0.3rem; font-size:0.75rem; font-weight:400; width:64px;">
                    <input type="checkbox" class="ob-hours-closed-chk" data-day="${i}" ${isClosed ? 'checked' : ''} onchange="obToggleHoursRowClosed(${i})"> Closed
                </label>
                <input type="time" class="ob-hours-open" data-day="${i}" value="${openVal}" ${isClosed ? 'disabled' : ''} style="flex:1;">
                <span style="color:var(--text-muted); font-size:0.78rem;">to</span>
                <input type="time" class="ob-hours-close" data-day="${i}" value="${closeVal}" ${isClosed ? 'disabled' : ''} style="flex:1;">
            </div>
        `;
    }).join('');
}

function obToggleHoursRowClosed(day) {
    const closed = document.querySelector(`.ob-hours-closed-chk[data-day="${day}"]`)?.checked;
    document.querySelectorAll(`.ob-hours-open[data-day="${day}"], .ob-hours-close[data-day="${day}"]`).forEach(el => {
        el.disabled = closed;
    });
}

function renderObStep() {
    document.querySelectorAll('.ob-step').forEach((el, i) => el.classList.toggle('hidden', i !== obCurrentStep));
    const meta = OB_STEP_META[obCurrentStep];
    document.getElementById('ob-step-title').textContent = meta.title;
    document.getElementById('ob-step-subtitle').textContent = meta.subtitle;
    document.getElementById('ob-step-icon').textContent = meta.icon;
    document.getElementById('ob-skip-row').classList.toggle('hidden', obCurrentStep === OB_STEP_COUNT - 1);

    const progress = document.getElementById('ob-progress');
    progress.innerHTML = Array.from({ length: OB_STEP_COUNT }).map((_, i) =>
        `<span style="width:8px; height:8px; border-radius:50%; background:${i === obCurrentStep ? 'var(--primary)' : 'var(--border)'};"></span>`
    ).join('');
}

function obNextStep() {
    if (obCurrentStep < OB_STEP_COUNT - 1) {
        obCurrentStep++;
        renderObStep();
    }
}

function obPrevStep() {
    if (obCurrentStep > 0) {
        obCurrentStep--;
        renderObStep();
    }
}

function obRemoveRow(rowId) {
    document.getElementById(rowId)?.remove();
}

function obAddStaffRow() {
    const id = `ob-staff-row-${obRowCounter++}`;
    const el = document.createElement('div');
    el.id = id;
    el.style.cssText = 'display:flex; gap:0.5rem; align-items:center;';
    el.innerHTML = `
        <input type="text" class="ob-staff-name" placeholder="Name" style="flex:2;">
        <input type="text" class="ob-staff-role" placeholder="Role (e.g. Groomer)" style="flex:2;">
        <button type="button" onclick="obRemoveRow('${id}')" style="background:none; border:none; cursor:pointer; color:var(--text-muted); font-size:1.1rem; padding:0.25rem;">×</button>
    `;
    document.getElementById('ob-staff-rows').appendChild(el);
}

function obAddResourceRow() {
    const id = `ob-resource-row-${obRowCounter++}`;
    const el = document.createElement('div');
    el.id = id;
    el.style.cssText = 'display:flex; gap:0.5rem; align-items:center;';
    el.innerHTML = `
        <input type="text" class="ob-resource-type" placeholder="e.g. Dog Suite" style="flex:3;">
        <input type="number" class="ob-resource-count" placeholder="Count" min="1" style="flex:1;">
        <button type="button" onclick="obRemoveRow('${id}')" style="background:none; border:none; cursor:pointer; color:var(--text-muted); font-size:1.1rem; padding:0.25rem;">×</button>
    `;
    document.getElementById('ob-resource-rows').appendChild(el);
}

function obAddServiceRow() {
    const id = `ob-service-row-${obRowCounter++}`;
    const el = document.createElement('div');
    el.id = id;
    el.style.cssText = 'display:flex; gap:0.5rem; align-items:center;';
    el.innerHTML = `
        <input type="text" class="ob-service-name" placeholder="e.g. Boarding" style="flex:2;">
        <input type="number" step="0.01" class="ob-service-price" placeholder="Price" style="flex:1;">
        <select class="ob-service-unit" style="flex:1;">
            <option value="flat">Flat</option>
            <option value="per_day">Per day</option>
        </select>
        <button type="button" onclick="obRemoveRow('${id}')" style="background:none; border:none; cursor:pointer; color:var(--text-muted); font-size:1.1rem; padding:0.25rem;">×</button>
    `;
    document.getElementById('ob-service-rows').appendChild(el);
}

/* Reads every filled-in row across all three steps and bulk-inserts them as
   real records. Empty rows (no name typed) are silently skipped rather than
   erroring — someone may have added a row and decided not to use it. */
async function obFinish(skip = false) {
    const client = getSupabase();
    if (!client) return;

    const finishBtn = document.getElementById('ob-finish-btn');
    if (finishBtn) { finishBtn.disabled = true; finishBtn.textContent = 'Saving...'; }

    if (!skip) {
        const staffRows = Array.from(document.querySelectorAll('#ob-staff-rows > div')).map(row => ({
            name: row.querySelector('.ob-staff-name')?.value.trim(),
            role: row.querySelector('.ob-staff-role')?.value.trim() || null,
        })).filter(r => r.name);

        const resourceRows = Array.from(document.querySelectorAll('#ob-resource-rows > div')).map(row => ({
            type: row.querySelector('.ob-resource-type')?.value.trim(),
            count: parseInt(row.querySelector('.ob-resource-count')?.value, 10) || 1,
        })).filter(r => r.type);

        const serviceRows = Array.from(document.querySelectorAll('#ob-service-rows > div')).map(row => ({
            name: row.querySelector('.ob-service-name')?.value.trim(),
            price: row.querySelector('.ob-service-price')?.value,
            unit: row.querySelector('.ob-service-unit')?.value || 'flat',
        })).filter(r => r.name);

        try {
            // Read timezone from either onboarding step 2 or staff settings dropdown
            const selectedTimezone = document.getElementById('ob-timezone')?.value 
                || document.getElementById('staff-timezone')?.value 
                || 'America/New_York';

            // Business info (logo, accent color, notify email, contact info, public booking toggle, timezone)
            await client.from('businesses').update({
                logo_url: document.getElementById('ob-logo-url')?.value.trim() || null,
                accent_color: document.getElementById('ob-accent-color')?.value || '#4f46e5',
                notification_email: document.getElementById('ob-notify-email')?.value.trim() || null,
                contact_phone: document.getElementById('ob-contact-phone')?.value.trim() || null,
                contact_email: document.getElementById('ob-contact-email')?.value.trim() || null,
                address: document.getElementById('ob-address')?.value.trim() || null,
                public_booking_enabled: document.getElementById('ob-enable-public-booking')?.checked || false,
                timezone: selectedTimezone // <--- PERSISTS TIMEZONE TO SUPABASE
            }).eq('id', currentBusinessId);

            // Hours of operation — one row per day, upserted by (business_id, day_of_week)
            const hourRows = OB_DAYS_OF_WEEK.map((_, i) => ({
                business_id: currentBusinessId,
                day_of_week: i,
                is_closed: document.querySelector(`.ob-hours-closed-chk[data-day="${i}"]`)?.checked || false,
                open_time: document.querySelector(`.ob-hours-open[data-day="${i}"]`)?.value || null,
                close_time: document.querySelector(`.ob-hours-close[data-day="${i}"]`)?.value || null,
            }));
            await client.from('business_hours').upsert(hourRows, { onConflict: 'business_id,day_of_week' });

            // Payment info — same table/columns as Business → Payment Settings
            const { data: bizForPayment } = await client.from('businesses').select('name').eq('id', currentBusinessId).single();
            const paymentPayload = {
                business_name: bizForPayment?.name || '',
                venmo_handle: document.getElementById('ob-pay-venmo')?.value.trim() || '',
                zelle_info: document.getElementById('ob-pay-zelle')?.value.trim() || '',
                cash_note: document.getElementById('ob-pay-cash')?.value.trim() || '',
                square_link: document.getElementById('ob-pay-square')?.value.trim() || '',
            };
            const existingSettings = typeof getBusinessSettings === 'function' ? await getBusinessSettings() : null;
            if (existingSettings) {
                await client.from('business_settings').update(paymentPayload).eq('id', existingSettings.id);
            } else {
                await client.from('business_settings').insert([{ ...paymentPayload, business_id: currentBusinessId }]);
            }

            if (staffRows.length) {
                await client.from('staff').insert(staffRows.map(r => ({ name: r.name, role: r.role, business_id: currentBusinessId })));
            }
            if (resourceRows.length) {
                await client.from('resources').insert(resourceRows.map(r => ({
                    name: r.type, type: r.type, seats: r.count, default_mode: 'all_day', business_id: currentBusinessId
                })));
            }
            if (serviceRows.length) {
                await client.from('appointment_type_templates').insert(serviceRows.map(r => ({
                    name: r.name,
                    default_price: r.price ? parseFloat(r.price) : null,
                    pricing_unit: r.unit,
                    business_id: currentBusinessId
                })));
            }
        } catch (e) {
            console.error('Onboarding save failed:', e);
            const errEl = document.getElementById('ob-finish-error');
            if (errEl) {
                errEl.textContent = 'Something went wrong saving your setup — you can add these later from Templates and Business settings.';
                errEl.classList.remove('hidden');
            }
        }
    }

    if (!obIsReopen) {
        await client.from('businesses').update({ onboarding_completed: true }).eq('id', currentBusinessId);
    }

    document.getElementById('onboarding-modal')?.classList.add('hidden');
    if (finishBtn) { finishBtn.disabled = false; finishBtn.textContent = 'Finish Setup'; }

    if (obIsReopen) {
        if (typeof initStaffView === 'function') initStaffView();
        alert('Setup saved.');
    } else {
        bootstrapApp();
    }
}

/* ==========================================================================
   APP CONTROLLER: Event Handlers & View Management
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    refreshIcons();
    initAuthGate();
});

/* Everything that used to run directly on DOMContentLoaded now runs here,
   only after login succeeds and a business_id has been resolved. */
function bootstrapApp() {
    let restoredProfile = false;
    try {
        const lastView = localStorage.getItem('barkboard-last-view');
        if (lastView && document.getElementById(lastView) && document.getElementById(lastView).classList.contains('view-panel')) {
            switchView(lastView);
        }
        if (lastView === 'crm-view') {
            const lastProfileRaw = localStorage.getItem('barkboard-last-profile');
            if (lastProfileRaw) {
                const { type, id } = JSON.parse(lastProfileRaw);
                if (type && id) {
                    openFullWidthProfile(type, id);
                    restoredProfile = true;
                }
            }
        }
    } catch (e) { /* storage unavailable, ignore */ }

    if (!restoredProfile && typeof renderAllDashboards === 'function') {
        renderAllDashboards();
    }
    if (typeof renderStaffGuests === 'function') {
        renderStaffGuests();
    }
    if (typeof renderTodaysOverview === 'function') {
        renderTodaysOverview();
    }
    if (typeof renderTodoPanel === 'function') {
        renderTodoPanel();
    }
}

/* ==========================================================================
   DASHBOARD METRICS SYSTEM (Staff Feed "Today's Overview")
   ========================================================================== */

const DEFAULT_DASHBOARD_METRICS = ['pending-requests', 'change-requests', 'tasks-today', 'unpaid-invoices', 'training-sessions'];
const MAX_DASHBOARD_METRICS = 10;

// Static metric definitions. Resource-type metrics (kennels/suites/runs/etc.)
// are appended dynamically in getAvailableMetrics() below, pulled from
// whatever types actually exist in the resources table — not hardcoded to
// "cat/dog/other", since a business's resource types are whatever they've
// set up in Templates → Resources.
const STATIC_METRIC_DEFS = {
    'pending-requests': { label: 'Pending Requests', icon: 'bell' },
    'change-requests': { label: 'Customer Change Requests', icon: 'message-square' },
    'tasks-today': { label: 'Tasks Remaining', icon: 'list-checks' },
    'unpaid-invoices': { label: 'Pending Invoices', icon: 'receipt' },
    'training-sessions': { label: 'Training Sessions', icon: 'dumbbell' },
    'active-bookings-today': { label: "Today's Bookings", icon: 'calendar-check' },
};

async function getAvailableMetrics(client) {
    const { data: resourceRows } = await client.from('resources').select('type');
    const types = Array.from(new Set((resourceRows || []).map(r => r.type).filter(Boolean))).sort();
    const dynamic = types.map(t => ({ key: `resource-type:${t}`, label: `${t} Occupancy`, icon: 'home' }));
    const staticList = Object.keys(STATIC_METRIC_DEFS).map(key => ({ key, ...STATIC_METRIC_DEFS[key] }));
    return [...staticList, ...dynamic];
}

function metricLabel(key, availableMetrics) {
    const found = availableMetrics.find(m => m.key === key);
    if (found) return found.label;
    if (key.startsWith('resource-type:')) return `${key.slice('resource-type:'.length)} Occupancy`;
    return key;
}

/* Computes today's value for one metric. `ctx` carries pre-computed date
   strings so every metric doesn't redo the same Date math. */
async function computeMetricValue(key, client, ctx) {
    if (key === 'pending-requests') {
        // A flexible-time add-on (e.g. a grooming session tacked onto a boarding
        // stay, to be scheduled whenever works during the visit) stays counted
        // here even after being "confirmed" — confirming it isn't the same as
        // actually giving it a real time, and it's easy for a flexible request
        // with no set time to quietly fall through the cracks otherwise.
        const { data } = await client.from('bookings').select('id')
            .eq('source', 'public')
            .or('status.eq.pending,and(flexible_time.eq.true,status.neq.cancelled)');
        const count = (data || []).length;
        return { value: String(count), alert: count > 0 };
    }
    if (key === 'change-requests') {
        const { data } = await client.from('bookings').select('id')
            .not('customer_change_request', 'is', null)
            .eq('customer_change_request_resolved', false);
        const count = (data || []).length;
        return { value: String(count), alert: count > 0 };
    }
    if (key === 'tasks-today') {
        const { data } = await client.from('staff_tasks').select('id').eq('due_date', ctx.today).eq('is_done', false);
        return { value: String((data || []).length) };
    }
    if (key === 'unpaid-invoices') {
        const { data } = await client.from('invoices').select('id').eq('status', 'unpaid');
        const count = (data || []).length;
        return { value: String(count), alert: count > 0 };
    }
    if (key === 'training-sessions') {
        const { data } = await client.from('bookings').select('id')
            .eq('requires_staff_time', true).neq('status', 'cancelled')
            .lte('check_in', ctx.todayEnd).gte('check_out', ctx.todayStart);
        return { value: String((data || []).length) };
    }
    if (key === 'active-bookings-today') {
        const { data } = await client.from('bookings').select('id')
            .neq('status', 'cancelled')
            .lte('check_in', ctx.todayEnd).gte('check_out', ctx.todayStart);
        return { value: String((data || []).length) };
    }
    if (key.startsWith('resource-type:')) {
        const type = key.slice('resource-type:'.length);
        const { data: resources } = await client.from('resources').select('id').eq('type', type);
        const resourceIds = (resources || []).map(r => r.id);
        let occupied = 0;
        if (resourceIds.length) {
            const { data: bookedRows } = await client.from('booking_resources')
                .select('resource_id, bookings!inner(check_in, check_out, status)')
                .in('resource_id', resourceIds)
                .neq('bookings.status', 'cancelled')
                .lte('bookings.check_in', ctx.todayEnd).gte('bookings.check_out', ctx.todayStart);
            occupied = new Set((bookedRows || []).map(r => r.resource_id)).size;
        }
        return { value: `${occupied} / ${resourceIds.length}` };
    }
    return { value: '—' };
}

/* Fetches the underlying list behind a metric, for the click-through detail
   modal. Each item gets an optional onclick (jump to the record) and an
   optional `actions` array (inline buttons — confirm/decline, mark done,
   mark paid — so status changes can happen right from this list without
   navigating away). Action onclick strings call back into
   refreshMetricDetail(key) afterward so the list updates in place. */
async function getMetricDetailItems(key, client, ctx) {
    if (key === 'pending-requests') {
        const { data } = await client.from('bookings')
            .select('id, service_name, check_in, household_id, status, flexible_time, pets(name), households(name)')
            .eq('source', 'public')
            .or('status.eq.pending,and(flexible_time.eq.true,status.neq.cancelled)')
            .order('check_in');
        return (data || []).map(b => {
            const stillPending = b.status === 'pending';
            const needsScheduling = b.flexible_time && !stillPending;
            return {
                title: `${b.pets?.name || 'Pet'} — ${b.service_name || 'Service'}${needsScheduling ? ' (flexible — needs a time)' : ''}`,
                sub: `${b.households?.name || 'Unknown household'} · ${b.check_in ? b.check_in.slice(0, 10) : ''}`,
                onclick: `closeMetricDetailModal(); switchView('crm-view'); openFullWidthProfile('household', '${b.household_id}')`,
                actions: stillPending ? [
                    { label: 'Confirm', onclick: `event.stopPropagation(); setBookingStatusFromDetail('${b.id}', 'confirmed', '${key}')` },
                    { label: 'Decline', onclick: `event.stopPropagation(); setBookingStatusFromDetail('${b.id}', 'cancelled', '${key}')` }
                ] : []
            };
        });
    }
    if (key === 'change-requests') {
        const { data } = await client.from('bookings')
            .select('id, service_name, check_in, household_id, customer_change_request, pets(name), households(name)')
            .not('customer_change_request', 'is', null)
            .eq('customer_change_request_resolved', false)
            .order('customer_change_requested_at', { ascending: false });
        return (data || []).map(b => ({
            title: `${b.pets?.name || 'Pet'} — ${b.service_name || 'Service'}`,
            sub: `${b.households?.name || 'Unknown household'} · "${b.customer_change_request}"`,
            onclick: `closeMetricDetailModal(); switchView('crm-view'); openFullWidthProfile('household', '${b.household_id}')`,
            actions: [
                { label: 'Mark Resolved', onclick: `event.stopPropagation(); resolveChangeRequestFromDetail('${b.id}', '${key}')` }
            ]
        }));
    }
    if (key === 'tasks-today') {
        const { data } = await client.from('staff_tasks').select('id, task_text, staff(name)').eq('due_date', ctx.today).eq('is_done', false);
        return (data || []).map(t => ({
            title: t.task_text,
            sub: t.staff?.name || 'Unassigned',
            actions: [
                { label: 'Mark Done', onclick: `event.stopPropagation(); setTaskDoneFromDetail('${t.id}', '${key}')` }
            ]
        }));
    }
    if (key === 'unpaid-invoices') {
        const { data } = await client.from('invoices').select('id, description, amount, household_id, households(name)').eq('status', 'unpaid').order('due_date');
        return (data || []).map(i => ({
            title: `${i.households?.name || 'Household'} — $${Number(i.amount || 0).toFixed(2)}`,
            sub: i.description || 'Invoice',
            onclick: `closeMetricDetailModal(); switchView('crm-view'); openFullWidthProfile('household', '${i.household_id}')`,
            actions: [
                { label: 'Mark Paid', onclick: `event.stopPropagation(); setInvoiceStatusFromDetail('${i.id}', 'paid', '${key}')` }
            ]
        }));
    }
    if (key === 'training-sessions' || key === 'active-bookings-today') {
        let q = client.from('bookings').select('id, service_name, status, household_id, pets(name), households(name)')
            .neq('status', 'cancelled').lte('check_in', ctx.todayEnd).gte('check_out', ctx.todayStart);
        if (key === 'training-sessions') q = q.eq('requires_staff_time', true);
        const { data } = await q;
        return (data || []).map(b => ({
            title: `${b.pets?.name || 'Pet'} — ${b.service_name || 'Service'}`,
            sub: b.households?.name || '',
            onclick: `closeMetricDetailModal(); switchView('crm-view'); openFullWidthProfile('household', '${b.household_id}')`,
            actions: b.status !== 'completed' ? [
                { label: 'Mark Completed', onclick: `event.stopPropagation(); setBookingStatusFromDetail('${b.id}', 'completed', '${key}')` }
            ] : []
        }));
    }
    if (key.startsWith('resource-type:')) {
        const type = key.slice('resource-type:'.length);
        const { data: resources } = await client.from('resources').select('id, name').eq('type', type);
        const resourceIds = (resources || []).map(r => r.id);
        if (!resourceIds.length) return [];
        const { data: bookedRows } = await client.from('booking_resources')
            .select('resource_id, bookings!inner(id, household_id, check_in, check_out, status, pets(name), households(name))')
            .in('resource_id', resourceIds)
            .neq('bookings.status', 'cancelled')
            .lte('bookings.check_in', ctx.todayEnd).gte('bookings.check_out', ctx.todayStart);
        const resourceNameById = {};
        resources.forEach(r => { resourceNameById[r.id] = r.name; });
        return (bookedRows || []).map(row => ({
            title: `${resourceNameById[row.resource_id] || 'Resource'} — ${row.bookings?.pets?.name || 'Pet'}`,
            sub: row.bookings?.households?.name || '',
            onclick: row.bookings?.household_id ? `closeMetricDetailModal(); switchView('crm-view'); openFullWidthProfile('household', '${row.bookings.household_id}')` : undefined
        }));
    }
    return [];
}

/* Shared handlers for the inline action buttons in the metric detail modal.
   Each updates the record, then re-renders both the open modal (so the item
   often just disappears from the list once it no longer matches the metric's
   filter) and the dashboard behind it (so the count stays in sync). */
/* Bookings created through the internal modal auto-generate & link an invoice
   at creation time (see saveBooking's "AUTO-GENERATE & LINK INVOICE" block).
   Public booking-page submissions skip that entirely — they're created by
   the Edge Function, which only ever touches `bookings`, never `invoices` —
   so nothing ever invoiced them even after being confirmed. This mirrors
   that same invoice-creation logic for a single already-existing booking,
   called at confirm-time instead of create-time. Safe to call on any
   booking: no-ops if it's already linked to an invoice or has no amount. */
async function ensureInvoiceForConfirmedBooking(client, bookingId) {
    const { data: booking } = await client.from('bookings').select('*').eq('id', bookingId).single();
    if (!booking || booking.invoice_id || !booking.amount || booking.amount <= 0) return;

    const startDate = (booking.check_in || '').slice(0, 10);
    const endDate = (booking.check_out || '').slice(0, 10);
    const when = endDate && endDate !== startDate ? `${startDate} → ${endDate}` : startDate;

    let petNames = '';
    if (booking.pet_id) {
        const { data: pet } = await client.from('pets').select('name').eq('id', booking.pet_id).single();
        petNames = pet?.name || '';
    }

    const { data: createdInvoices, error: invErr } = await client.from('invoices').insert([{
        household_id: booking.household_id,
        booking_id: booking.id,
        description: `${booking.service_name || 'Event'} — ${when}`,
        amount: booking.amount,
        status: 'unpaid',
        due_date: startDate || null,
        service_start_date: startDate || null,
        service_end_date: endDate || startDate || null,
        pet_names: petNames,
        business_id: booking.business_id
    }]).select();

    if (invErr) {
        console.error('Failed to auto-create invoice for confirmed booking:', invErr);
        return;
    }
    if (createdInvoices && createdInvoices.length) {
        await client.from('bookings').update({ invoice_id: createdInvoices[0].id }).eq('id', booking.id);
    }
}

async function setBookingStatusFromDetail(bookingId, newStatus, key) {
    const client = getSupabase();
    if (!client) return;
    const { error } = await client.from('bookings').update({ status: newStatus }).eq('id', bookingId);
    if (error) return alert('Failed to update: ' + error.message);
    if (newStatus === 'confirmed') await ensureInvoiceForConfirmedBooking(client, bookingId);
    if (newStatus === 'confirmed' || newStatus === 'cancelled') {
        notifyEmail(newStatus === 'confirmed' ? 'booking-confirmed' : 'booking-declined', { bookingId });
    }
    refreshMetricDetail(key);
    if (typeof renderActivities === 'function') renderActivities();
}

async function resolveChangeRequestFromDetail(bookingId, key) {
    const client = getSupabase();
    if (!client) return;
    const { error } = await client.from('bookings').update({ customer_change_request_resolved: true }).eq('id', bookingId);
    if (error) return alert('Failed to update: ' + error.message);
    refreshMetricDetail(key);
    if (typeof renderActivities === 'function') renderActivities();
}

async function setTaskDoneFromDetail(taskId, key) {
    const client = getSupabase();
    if (!client) return;
    const { error } = await client.from('staff_tasks').update({ is_done: true }).eq('id', taskId);
    if (error) return alert('Failed to update: ' + error.message);
    refreshMetricDetail(key);
    if (typeof renderTodoPanel === 'function') renderTodoPanel();
}

async function setInvoiceStatusFromDetail(invoiceId, newStatus, key) {
    const client = getSupabase();
    if (!client) return;
    const payload = { status: newStatus };
    if (newStatus === 'paid') {
        payload.paid_date = new Date().toISOString().slice(0, 10);
        payload.payment_method = await promptForPaymentMethod();
    }
    const { error } = await client.from('invoices').update(payload).eq('id', invoiceId);
    if (error) return alert('Failed to update: ' + error.message);
    if (newStatus === 'paid') notifyEmail('payment-received', { invoiceId });
    refreshMetricDetail(key);
}

/* Re-renders the currently-open metric detail modal in place, and the
   dashboard grid behind it (so counts reflect the change immediately). */
async function refreshMetricDetail(key) {
    renderTodaysOverview();
    const client = getSupabase();
    if (!client) return;
    const today = new Date().toISOString().slice(0, 10);
    const ctx = { today, todayStart: today + 'T00:00:00', todayEnd: today + 'T23:59:59' };
    const items = await getMetricDetailItems(key, client, ctx);
    renderMetricDetailItems(items);
}

let dashboardBusinessNotificationEmail = null; // not used directly here, placeholder for future

async function renderTodaysOverview() {
    const client = getSupabase();
    if (!client) return;

    const grid = document.getElementById('dashboard-metrics-grid');
    if (!grid) return;

    const today = new Date().toISOString().slice(0, 10);
    const ctx = { today, todayStart: today + 'T00:00:00', todayEnd: today + 'T23:59:59' };

    const { data: business } = await client.from('businesses').select('dashboard_metrics').eq('id', currentBusinessId).single();
    const availableMetrics = await getAvailableMetrics(client);
    const availableKeys = new Set(availableMetrics.map(m => m.key));

    let chosenKeys = (business?.dashboard_metrics && business.dashboard_metrics.length)
        ? business.dashboard_metrics.filter(k => availableKeys.has(k))
        : DEFAULT_DASHBOARD_METRICS.filter(k => availableKeys.has(k));
    if (!chosenKeys.length) chosenKeys = availableMetrics.slice(0, 4).map(m => m.key);
    chosenKeys = chosenKeys.slice(0, MAX_DASHBOARD_METRICS);

    const results = await Promise.all(chosenKeys.map(key => computeMetricValue(key, client, ctx)));

    grid.innerHTML = chosenKeys.map((key, idx) => {
        const def = availableMetrics.find(m => m.key === key) || { label: metricLabel(key, availableMetrics), icon: 'circle' };
        const r = results[idx];
        return `
            <div class="stat-card biz-clickable ${r.alert ? 'alert' : ''}" onclick="openMetricDetail('${key.replace(/'/g, "\\'")}')">
                <h3><i data-lucide="${def.icon}" style="width:14px;height:14px;vertical-align:-2px;"></i> ${def.label}</h3>
                <p>${r.value}</p>
                <div class="stat-card-hint">View details</div>
            </div>
        `;
    }).join('');
    refreshIcons();

    // Pending-requests callout — separate from the metrics grid since it's an
    // action prompt, not just a number, and should stay visible even if the
    // person hasn't chosen "Pending Requests" as one of their picked metrics.
    const { data: pending } = await client.from('bookings').select('id')
        .eq('source', 'public')
        .or('status.eq.pending,and(flexible_time.eq.true,status.neq.cancelled)');
    const pendingCount = (pending || []).length;
    const callout = document.getElementById('pending-requests-callout');
    if (callout) {
        callout.classList.toggle('hidden', pendingCount === 0);
        const textEl = document.getElementById('pending-requests-text');
        if (textEl) textEl.textContent = `${pendingCount} new booking request${pendingCount === 1 ? '' : 's'} need${pendingCount === 1 ? 's' : ''} your review`;
    }
}

async function openMetricDetail(key) {
    const client = getSupabase();
    if (!client) return;

    const today = new Date().toISOString().slice(0, 10);
    const ctx = { today, todayStart: today + 'T00:00:00', todayEnd: today + 'T23:59:59' };
    const availableMetrics = await getAvailableMetrics(client);

    document.getElementById('metric-detail-title').textContent = metricLabel(key, availableMetrics);
    const body = document.getElementById('metric-detail-body');
    body.innerHTML = '<div class="biz-empty">Loading...</div>';
    document.getElementById('metric-detail-modal')?.classList.remove('hidden');

    const items = await getMetricDetailItems(key, client, ctx);
    renderMetricDetailItems(items);
}

/* Shared renderer for the metric detail list — used both on initial open and
   when refreshMetricDetail() re-fetches after an inline action changes
   something. Item action buttons stop click propagation so they don't also
   trigger the item's own onclick (which navigates away to the household). */
function renderMetricDetailItems(items) {
    const body = document.getElementById('metric-detail-body');
    if (!body) return;
    body.innerHTML = items.length ? items.map(it => `
        <div style="padding:0.6rem 0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover,#f9fafb); ${it.onclick ? 'cursor:pointer;' : ''}" ${it.onclick ? `onclick="${it.onclick}"` : ''}>
            <div style="font-weight:600; font-size:0.88rem;">${it.title}</div>
            ${it.sub ? `<div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.15rem;">${it.sub}</div>` : ''}
            ${it.actions && it.actions.length ? `
                <div style="display:flex; gap:0.4rem; margin-top:0.5rem;">
                    ${it.actions.map(a => `<button type="button" class="btn" style="font-size:0.75rem; padding:0.25rem 0.6rem;" onclick="${a.onclick}">${a.label}</button>`).join('')}
                </div>
            ` : ''}
        </div>
    `).join('') : '<div class="biz-empty">Nothing here right now.</div>';
}

function closeMetricDetailModal() {
    document.getElementById('metric-detail-modal')?.classList.add('hidden');
}

async function openDashboardSettingsModal() {
    const client = getSupabase();
    if (!client) return;

    const { data: business } = await client.from('businesses').select('dashboard_metrics').eq('id', currentBusinessId).single();
    const availableMetrics = await getAvailableMetrics(client);
    const chosen = new Set(
        (business?.dashboard_metrics && business.dashboard_metrics.length ? business.dashboard_metrics : DEFAULT_DASHBOARD_METRICS)
            .filter(k => availableMetrics.some(m => m.key === k))
    );

    const list = document.getElementById('dashboard-settings-list');
    list.innerHTML = availableMetrics.map(m => `
        <label style="display:flex; align-items:center; gap:0.5rem; padding:0.5rem 0.65rem; border:1px solid var(--border); border-radius:0.375rem; font-weight:400; cursor:pointer;">
            <input type="checkbox" class="dash-metric-chk" value="${m.key}" ${chosen.has(m.key) ? 'checked' : ''} onchange="updateDashboardSettingsCount()">
            <i data-lucide="${m.icon}" style="width:15px;height:15px;"></i> ${m.label}
        </label>
    `).join('');
    refreshIcons();
    updateDashboardSettingsCount();

    document.getElementById('dashboard-settings-modal')?.classList.remove('hidden');
}

function updateDashboardSettingsCount() {
    const checked = document.querySelectorAll('.dash-metric-chk:checked');
    const countEl = document.getElementById('dashboard-settings-count');
    if (countEl) countEl.textContent = `${checked.length} / ${MAX_DASHBOARD_METRICS} selected`;

    // Once 10 are picked, disable the rest rather than letting the count go over
    const atLimit = checked.length >= MAX_DASHBOARD_METRICS;
    document.querySelectorAll('.dash-metric-chk').forEach(chk => {
        if (!chk.checked) chk.disabled = atLimit;
    });
}

function closeDashboardSettingsModal() {
    document.getElementById('dashboard-settings-modal')?.classList.add('hidden');
}

async function saveDashboardSettings() {
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const chosen = Array.from(document.querySelectorAll('.dash-metric-chk:checked')).map(chk => chk.value).slice(0, MAX_DASHBOARD_METRICS);
    if (!chosen.length) return alert('Please select at least one metric.');

    const { error } = await client.from('businesses').update({ dashboard_metrics: chosen }).eq('id', currentBusinessId);
    if (error) return alert('Failed to save: ' + error.message);

    closeDashboardSettingsModal();
    renderTodaysOverview();
}

async function openPendingRequestsModal() {
    const client = getSupabase();
    if (!client) return;

    const list = document.getElementById('pending-requests-list');
    list.innerHTML = '<div class="biz-empty">Loading...</div>';
    document.getElementById('pending-requests-modal')?.classList.remove('hidden');

    const { data } = await client.from('bookings')
        .select('id, service_name, check_in, check_out, amount, notes, flexible_time, status, household_id, pets(name), households(name)')
        .eq('source', 'public')
        .or('status.eq.pending,and(flexible_time.eq.true,status.neq.cancelled)')
        .order('check_in');

    const requests = data || [];
    list.innerHTML = requests.length ? requests.map(b => `
        <div style="padding:0.85rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
            <div style="display:flex; justify-content:space-between; align-items:start; gap:0.5rem;">
                <div>
                    <strong>${b.pets?.name || 'Pet'}</strong> <span style="color:var(--text-muted); font-size:0.85rem;">(${b.households?.name || 'Unknown'})</span>
                    ${b.flexible_time ? `<span style="display:inline-block; font-size:0.7rem; font-weight:700; text-transform:uppercase; background:#fef3c7; color:#92400e; padding:0.1rem 0.45rem; border-radius:999px; margin-left:0.4rem;">Needs Scheduling</span>` : ''}
                    <div style="font-size:0.85rem; margin-top:0.2rem;">${b.service_name || 'Service'} · ${(b.check_in || '').slice(0, 10)}${b.check_out && b.check_out.slice(0, 10) !== (b.check_in || '').slice(0, 10) ? ' → ' + b.check_out.slice(0, 10) : ''}</div>
                    ${b.amount ? `<div style="font-size:0.85rem; color:var(--text-muted);">$${Number(b.amount).toFixed(2)}</div>` : ''}
                    ${b.notes ? `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.35rem; white-space:pre-wrap;">${b.notes}</div>` : ''}
                </div>
            </div>
            <div style="display:flex; gap:0.5rem; margin-top:0.65rem;">
                ${b.flexible_time
                    ? `<button class="btn btn-primary" style="font-size:0.8rem; padding:0.35rem 0.75rem;" onclick="closePendingRequestsModal(); openBookingModal(null, '${b.id}');">Schedule Now</button>`
                    : `<button class="btn btn-primary" style="font-size:0.8rem; padding:0.35rem 0.75rem;" onclick="respondToPendingRequest('${b.id}', 'confirmed')">Confirm</button>`
                }
                <button class="btn" style="font-size:0.8rem; padding:0.35rem 0.75rem;" onclick="respondToPendingRequest('${b.id}', 'cancelled')">Decline</button>
                <button class="btn" style="font-size:0.8rem; padding:0.35rem 0.75rem; margin-left:auto;" onclick="closePendingRequestsModal(); switchView('crm-view'); openFullWidthProfile('household', '${b.household_id}')">View Household</button>
            </div>
        </div>
    `).join('') : '<div class="biz-empty">No pending requests.</div>';
}

async function respondToPendingRequest(bookingId, newStatus) {
    const client = getSupabase();
    if (!client) return;
    const { error } = await client.from('bookings').update({ status: newStatus }).eq('id', bookingId);
    if (error) {
        alert('Failed to update: ' + error.message);
        return;
    }
    if (newStatus === 'confirmed') await ensureInvoiceForConfirmedBooking(client, bookingId);
    if (newStatus === 'confirmed' || newStatus === 'cancelled') {
        notifyEmail(newStatus === 'confirmed' ? 'booking-confirmed' : 'booking-declined', { bookingId });
    }
    openPendingRequestsModal(); // refresh the list in place
    renderTodaysOverview();
    if (typeof renderActivities === 'function') renderActivities();
}

function closePendingRequestsModal() {
    document.getElementById('pending-requests-modal')?.classList.add('hidden');
}



async function renderTodoPanel() {
    const body = document.getElementById('todo-list-body');
    const dateLabel = document.getElementById('todo-date-label');
    const progressLabel = document.getElementById('todo-progress-label');
    const progressBar = document.getElementById('todo-progress-bar');
    if (!body) return;

    const client = getSupabase();
    if (!client) return;

    const today = new Date();
    const todayKey = today.toISOString().slice(0, 10);
    if (dateLabel) dateLabel.textContent = today.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

    const { data: tasks } = await client.from('staff_tasks').select('*, staff(name)').eq('due_date', todayKey).order('is_done');

    const list = tasks || [];
    const done = list.filter(t => t.is_done).length;

    if (progressLabel) progressLabel.textContent = `${done} / ${list.length}`;
    if (progressBar) progressBar.style.width = list.length ? `${Math.round((done / list.length) * 100)}%` : '0%';

    body.innerHTML = list.length ? list.map(t => `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:0.5rem 0; border-bottom:1px solid var(--border);">
            <label style="display:flex; align-items:center; gap:0.5rem; ${t.is_done ? 'color:var(--text-muted); text-decoration:line-through;' : ''}">
                <input type="checkbox" ${t.is_done ? 'checked' : ''} onchange="toggleTodoTask('${t.id}', this.checked)">
                ${t.task_text}${t.staff?.name ? ' <span style="font-size:0.78rem; color:var(--text-muted);">(' + t.staff.name + ')</span>' : ''}
            </label>
        </div>
    `).join('') : '<div class="biz-empty">No tasks due today.</div>';
}

async function toggleTodoTask(id, isDone) {
    const client = getSupabase();
    if (!client) return;
    await client.from('staff_tasks').update({ is_done: isDone }).eq('id', id);
    renderTodoPanel();
    renderTodaysOverview();
}

async function addCustomTask() {
    const input = document.getElementById('todo-new-input');
    const text = input?.value.trim();
    if (!text) return;

    const client = getSupabase();
    if (!client) return;

    const today = new Date().toISOString().slice(0, 10);
    const { error } = await client.from('staff_tasks').insert([{ task_text: text, due_date: today, priority: 'normal', is_done: false, business_id: currentBusinessId }]);

    if (error) {
        alert('Failed to add task: ' + error.message);
        return;
    }

    if (input) input.value = '';
    renderTodoPanel();
    renderTodaysOverview();
}

async function renderStaffGuests() {
    const container = document.getElementById('staff-guests-container');
    if (!container) return;

    const client = getSupabase();
    if (!client) return;

    const now = new Date();
    const todayStart = now.toISOString().slice(0, 10) + 'T00:00:00';
    const weekOut = new Date(now); weekOut.setDate(weekOut.getDate() + 14);
    const windowEnd = weekOut.toISOString().slice(0, 10) + 'T23:59:59';

    const { data: bookings } = await client.from('bookings')
        .select('*, pets(name, species), households(name)')
        .gte('check_out', todayStart).lte('check_in', windowEnd)
        .neq('status', 'cancelled')
        .order('check_in');

    if (!bookings || !bookings.length) {
        container.innerHTML = '<div class="biz-empty">No active or upcoming guests in the next two weeks.</div>';
        return;
    }

    // Pull in whichever invoices are linked to these bookings so payment status can show alongside appointment status.
    const invoiceIds = bookings.map(bk => bk.invoice_id).filter(Boolean);
    const { data: linkedInvoices } = invoiceIds.length
        ? await client.from('invoices').select('id, status').in('id', invoiceIds)
        : { data: [] };
    const invoiceStatusById = {};
    (linkedInvoices || []).forEach(inv => { invoiceStatusById[inv.id] = inv.status; });

    container.innerHTML = bookings.map(bk => {
        const isActiveNow = bk.check_in <= (now.toISOString()) && bk.check_out >= (now.toISOString());
        const invoiceStatus = bk.invoice_id ? invoiceStatusById[bk.invoice_id] : null;
        return `
        <div style="padding:0.85rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card); cursor:pointer;" onclick="switchView('crm-view'); openFullWidthProfile('pet', '${bk.pet_id}')">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:0.4rem; flex-wrap:wrap;">
                <strong><i data-lucide="${bk.pets?.species === 'cat' ? 'cat' : bk.pets?.species === 'other' ? 'rabbit' : 'dog'}" style="width:14px;height:14px;"></i> ${bk.pets?.name || 'Pet'}</strong>
                <div style="display:flex; align-items:center; gap:0.35rem;" onclick="event.stopPropagation();">
                    ${isActiveNow ? `<span style="font-size:0.7rem; color:#16a34a; font-weight:600;">● Checked In</span>` : ''}
                    ${renderStatusTag('appointment', bk.id, bk.status || 'pending', 'setStaffFeedAppointmentStatus')}
                    ${bk.invoice_id ? renderStatusTag('invoice', bk.invoice_id, invoiceStatus || 'unpaid', 'setStaffFeedInvoiceStatus') : ''}
                </div>
            </div>
            <div style="font-size:0.82rem; color:var(--text-muted); margin-top:0.2rem;">${bk.service_name || 'Event'} · ${bk.households?.name || ''}</div>
            <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.15rem;">${(bk.check_in || '').slice(0, 10)}${bk.check_in && bk.check_in.slice(11,16) !== '00:00' ? ' at ' + bk.check_in.slice(11, 16) : ''} → ${(bk.check_out || '').slice(0, 10)}</div>
            ${bk.amount ? `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.1rem;">$${Number(bk.amount).toFixed(2)}</div>` : ''}
        </div>
    `;}).join('');
    refreshIcons();
}

function switchView(viewId) {
    document.querySelectorAll('.view-panel').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('#admin-nav .nav-btn').forEach(b => b.classList.remove('active'));
    
    const targetView = document.getElementById(viewId);
    if (targetView) targetView.classList.remove('hidden');

    const activeBtn = Array.from(document.querySelectorAll('#admin-nav .nav-btn'))
        .find(b => b.getAttribute('onclick') && b.getAttribute('onclick').includes(viewId));
    if (activeBtn) activeBtn.classList.add('active');

    try { localStorage.setItem('barkboard-last-view', viewId); } catch (e) { /* storage unavailable, ignore */ }

    // Hooks for view-specific initializations
    if (viewId === 'staff-view' && typeof renderStaffGuests === 'function') {
        renderStaffGuests();
        if (typeof renderTodaysOverview === 'function') renderTodaysOverview();
        if (typeof renderTodoPanel === 'function') renderTodoPanel();
    }
    if (viewId === 'staff-mgmt-view') {
        initStaffView();
    }
    if (viewId === 'biz-view' && typeof renderBizDashboard === 'function') {
        renderBizDashboard();
    }
    if (viewId === 'activities-view' && typeof initActivitiesView === 'function') {
        initActivitiesView();
    }
    if (viewId === 'templates-view' && typeof switchTemplatesTab === 'function') {
        switchTemplatesTab('appt');
    }
}

function setEntityFilter(filterType) {
    if (typeof currentEntityFilter !== 'undefined') {
        currentEntityFilter = filterType;
    }
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    
    // Normalize singular/plural filter IDs
    const targetId = filterType === 'households' ? 'filter-household' : 'filter-' + filterType;
    const filterBtn = document.getElementById(targetId) || document.getElementById('filter-' + filterType);
    if (filterBtn) filterBtn.classList.add('active');

    if (typeof renderAllDashboards === 'function') {
        renderAllDashboards();
    }
}

function toggleLayout() {
    if (typeof isCardLayoutMode !== 'undefined') {
        isCardLayoutMode = !isCardLayoutMode;
    }
    if (typeof renderAllDashboards === 'function') {
        renderAllDashboards();
    }
}

function executeAction(actionName, id) {
    alert(`CRM Action: [${actionName}] requested for household key: ${id}`);
}

function activateOwnerView(householdId) {
    if (typeof currentOwnerHouseholdId !== 'undefined') {
        currentOwnerHouseholdId = householdId;
    }
    if (typeof households === 'undefined') return;
    const h = households.find(x => x.id === householdId);
    if (!h) return;

    const banner = document.getElementById('owner-banner');
    const bannerName = document.getElementById('owner-banner-name');
    if (banner) banner.classList.remove('hidden');
    if (bannerName) bannerName.innerText = h.name;

    document.querySelectorAll('.view-panel').forEach(p => p.classList.add('hidden'));
    const ownerView = document.getElementById('owner-view');
    if (ownerView) ownerView.classList.remove('hidden');

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function exitOwnerView() {
    if (typeof currentOwnerHouseholdId !== 'undefined') {
        currentOwnerHouseholdId = null;
    }
    const banner = document.getElementById('owner-banner');
    if (banner) banner.classList.add('hidden');
    switchView('crm-view');
}

// Window resize listener
var resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (typeof applyLayout === 'function') {
            applyLayout();
        }
    }, 80);
});

let editingBookingId = null;
let bookingHouseholdId = null;

function toggleBookingTypeFields() {
    const type = document.getElementById('bk-type')?.value;
    const startLabel = document.getElementById('bk-start-label');
    const startTimeLabel = document.getElementById('bk-start-time-label');
    const timeField = document.getElementById('bk-time-field');
    const endDateField = document.getElementById('bk-end-date-field');
    const endTimeField = document.getElementById('bk-end-time-field');

    if (type === 'stay') {
        if (startLabel) startLabel.textContent = 'Start Date *';
        if (startTimeLabel) startTimeLabel.textContent = 'Drop-off Time';
        if (timeField) timeField.classList.remove('hidden');
        if (endDateField) endDateField.classList.remove('hidden');
        if (endTimeField) endTimeField.classList.remove('hidden');
    } else {
        if (startLabel) startLabel.textContent = 'Date *';
        if (startTimeLabel) startTimeLabel.textContent = 'Time';
        if (timeField) timeField.classList.remove('hidden');
        if (endDateField) endDateField.classList.add('hidden');
        if (endTimeField) endTimeField.classList.add('hidden');
    }
}

async function openBookingModal(householdId = null, bookingId = null) {
    editingBookingId = bookingId;
    bookingHouseholdId = householdId;

    const titleEl = document.getElementById('booking-modal-title');
    const typeSel = document.getElementById('bk-type');
    const serviceInput = document.getElementById('bk-service-type');
    const startDateInput = document.getElementById('bk-start-date');
    const startTimeInput = document.getElementById('bk-start-time');
    const endDateInput = document.getElementById('bk-end-date');
    const amountInput = document.getElementById('bk-amount');
    const statusSel = document.getElementById('bk-status');
    const staffSel = document.getElementById('bk-staff-id');
    const notesInput = document.getElementById('bk-notes');
    const petBox = document.getElementById('bk-pet-checkboxes');
    const staffTimeField = document.getElementById('bk-staff-time-field');
    const staffTimeMinutesInput = document.getElementById('bk-staff-time-minutes');

    if (titleEl) titleEl.textContent = bookingId ? 'Edit Event' : 'Add Event';
    document.getElementById('bk-delete-btn')?.classList.toggle('hidden', !bookingId);
    document.getElementById('bk-calendar-btn')?.classList.toggle('hidden', !bookingId);

    // Reset fields
    if (typeSel) typeSel.value = 'appointment';
    if (serviceInput) serviceInput.value = '';
    if (startDateInput) startDateInput.value = '';
    if (startTimeInput) startTimeInput.value = '';
    if (endDateInput) endDateInput.value = '';
    if (document.getElementById('bk-end-time')) document.getElementById('bk-end-time').value = '';
    if (amountInput) amountInput.value = '';
    if (document.getElementById('bk-rate-per-day')) document.getElementById('bk-rate-per-day').value = '';
    if (document.getElementById('bk-discount')) document.getElementById('bk-discount').value = '';
    if (document.getElementById('bk-days-display')) document.getElementById('bk-days-display').textContent = '1';
    if (document.getElementById('bk-subtotal-display')) document.getElementById('bk-subtotal-display').textContent = '$0.00';
    if (document.getElementById('bk-final-total')) document.getElementById('bk-final-total').textContent = '$0.00';
    if (statusSel) statusSel.value = 'pending';
    if (notesInput) notesInput.value = '';
    if (document.getElementById('bk-notes-visible-customer')) document.getElementById('bk-notes-visible-customer').checked = false;
    if (document.getElementById('bk-flexible-time')) document.getElementById('bk-flexible-time').checked = false;
    document.getElementById('bk-flexible-time-row')?.classList.add('hidden');
    bkEventResources = [];
    activeServicePerDayRate = null;
    if (staffTimeField) staffTimeField.classList.add('hidden');
    if (staffTimeMinutesInput) staffTimeMinutesInput.value = '';
    document.getElementById('bk-invoice-section')?.classList.add('hidden');
    document.getElementById('bk-service-type-results')?.classList.add('hidden');

    if (!bookingId && pendingCalendarDate && startDateInput) {
        startDateInput.value = pendingCalendarDate;
    }
    pendingCalendarDate = null;
    toggleBookingTypeFields();

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    // Load staff dropdown options
    const { data: staff } = await client.from('staff').select('id, name, role').order('name');
    if (staffSel) {
        const staffOptions = (staff || []).map(s => `<option value="${s.id}">${s.name}${s.role ? ' · ' + s.role : ''}</option>`).join('');
        staffSel.innerHTML = `<option value="">Unassigned</option>${staffOptions}`;
    }

    let selectedPetIds = [];
    let existingBooking = null;

    if (bookingId) {
        const { data: bk } = await client.from('bookings').select('*').eq('id', bookingId).single();
        existingBooking = bk;
        if (bk?.household_id) bookingHouseholdId = bk.household_id;
        if (bk?.pet_id) selectedPetIds = [bk.pet_id];
    }

    // PET SELECTION & GLOBAL SEARCH RENDERER
    if (petBox) {
        if (bookingHouseholdId) {
            const { data: pets } = await client.from('pets').select('id, name, species').eq('household_id', bookingHouseholdId).order('name');
            renderPetSelectionCheckboxes(pets || [], selectedPetIds);
        } else {
            petBox.innerHTML = `
                <div style="margin-bottom:0.5rem;">
                    <label style="font-size:0.8rem; font-weight:600; color:var(--text-muted);">Search Pet across All Households</label>
                    <input type="text" id="bk-global-pet-search" placeholder="Type pet name or owner..." class="biz-select" style="width:100%; padding:0.4rem; font-size:0.85rem;" onkeyup="searchGlobalPetsForBooking(this.value)" onfocus="searchGlobalPetsForBooking(this.value)">
                    <div id="bk-global-pet-results" style="margin-top:0.35rem; display:flex; flex-direction:column; gap:0.3rem; max-height:160px; overflow-y:auto;"></div>
                </div>
                <div id="bk-selected-pets-container"></div>
            `;
            searchGlobalPetsForBooking('');
        }
    }

    // Populate existing booking details if editing
    if (existingBooking) {
        const checkInDate = existingBooking.check_in ? existingBooking.check_in.slice(0, 10) : '';
        const checkInTime = existingBooking.check_in ? existingBooking.check_in.slice(11, 16) : '';
        const checkOutDate = existingBooking.check_out ? existingBooking.check_out.slice(0, 10) : '';
        const checkOutTime = existingBooking.check_out ? existingBooking.check_out.slice(11, 16) : '';
        const isStay = checkOutDate && checkOutDate !== checkInDate;

        if (typeSel) typeSel.value = isStay ? 'stay' : 'appointment';
        if (serviceInput) serviceInput.value = existingBooking.service_name || '';
        if (startDateInput) startDateInput.value = checkInDate;
        if (startTimeInput) startTimeInput.value = checkInTime;
        if (isStay && endDateInput) endDateInput.value = checkOutDate;
        if (isStay && document.getElementById('bk-end-time')) document.getElementById('bk-end-time').value = checkOutTime;
        // Subtotal field shows amount + discount (reconstructing the pre-discount figure);
        // the Discount field shows what was actually taken off. Older bookings saved before
        // discounts existed will have discount_amount = 0/null, so Subtotal just equals amount.
        const discountAmount = existingBooking.discount_amount != null ? parseFloat(existingBooking.discount_amount) : 0;
        if (amountInput) amountInput.value = existingBooking.amount != null ? (parseFloat(existingBooking.amount) + discountAmount) : '';
        if (document.getElementById('bk-discount')) document.getElementById('bk-discount').value = discountAmount ? discountAmount : '';
        if (statusSel) statusSel.value = existingBooking.status || 'pending';
        if (staffSel) staffSel.value = existingBooking.assigned_staff_id || '';
        if (notesInput) notesInput.value = existingBooking.notes || '';
        if (document.getElementById('bk-notes-visible-customer')) document.getElementById('bk-notes-visible-customer').checked = !!existingBooking.notes_visible_to_customer;
        // Only show the flexible-time toggle at all when the booking actually IS
        // flexible — staff resolve it by unchecking once they've set a real time,
        // rather than being able to set it themselves (it's only ever set by the
        // public booking flow for add-ons).
        const flexRow = document.getElementById('bk-flexible-time-row');
        const flexChk = document.getElementById('bk-flexible-time');
        if (existingBooking.flexible_time) {
            flexRow?.classList.remove('hidden');
            if (flexChk) flexChk.checked = true;
        } else {
            flexRow?.classList.add('hidden');
            if (flexChk) flexChk.checked = false;
        }
        toggleBookingTypeFields();

        // Restore the per-day rate directly from the booking itself (set whenever it was last
        // saved), so editing recalculates the total immediately and automatically — no
        // re-selecting the template required. Older bookings saved before this existed won't
        // have a stored rate_per_day, so fall back to deriving one from subtotal ÷ days.
        const subtotalForRate = existingBooking.amount != null ? (parseFloat(existingBooking.amount) + discountAmount) : 0;
        let restoredRate = existingBooking.rate_per_day != null ? parseFloat(existingBooking.rate_per_day) : null;
        if (restoredRate == null) {
            let fallbackDays = 1;
            if (isStay && checkInDate && checkOutDate) {
                const diffDays = Math.ceil((new Date(checkOutDate).getTime() - new Date(checkInDate).getTime()) / (1000 * 60 * 60 * 24));
                fallbackDays = diffDays > 0 ? diffDays : 1;
            }
            restoredRate = fallbackDays > 0 ? subtotalForRate / fallbackDays : subtotalForRate;
        }
        activeServicePerDayRate = restoredRate;
        if (document.getElementById('bk-rate-per-day')) document.getElementById('bk-rate-per-day').value = restoredRate != null ? restoredRate : '';
        calculateBookingTotalAmount(); // reflects the correct days, subtotal, and discounted total immediately

        // Load this event's resource assignments (event-level, not tied to any one pet)
        bkEventResources = await loadExistingBookingResources(existingBooking.id);
        renderBkResourcesList();

        const needsStaffTime = existingBooking.requires_staff_time || false;
        if (needsStaffTime) {
            if (staffTimeField) staffTimeField.classList.remove('hidden');
            if (staffTimeMinutesInput) staffTimeMinutesInput.value = existingBooking.staff_time_minutes || '';
        }

        // Show linked invoice section
        const invoiceSection = document.getElementById('bk-invoice-section');
        const invoiceInfo = document.getElementById('bk-invoice-info');
        if (invoiceSection && invoiceInfo) {
            invoiceSection.classList.remove('hidden');
            if (existingBooking.invoice_id) {
                const { data: linkedInv } = await client.from('invoices').select('*').eq('id', existingBooking.invoice_id).single();
                invoiceInfo.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:0.5rem 0.65rem; border:1px solid var(--border); border-radius:0.25rem; background:var(--bg-hover,#f9fafb); font-size:0.85rem;">
                        <span>${linkedInv?.description || 'Invoice'} · $${Number(linkedInv?.amount || 0).toFixed(2)} · <span style="text-transform:capitalize;">${linkedInv?.status || 'unpaid'}</span></span>
                        <button type="button" class="btn" style="font-size:0.75rem; padding:0.25rem 0.5rem;" onclick="closeBookingModal(); openInvoiceModal('${bookingHouseholdId}', '${existingBooking.invoice_id}')">View / Edit</button>
                    </div>
                `;
            } else {
                invoiceInfo.innerHTML = `
                    <input type="text" id="bk-invoice-link-search" placeholder="Type to filter this household's invoices..." style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:0.25rem;" onkeyup="searchInvoicesForBooking(this.value, '${existingBooking.id}')">
                    <div id="bk-invoice-link-results" style="margin-top:0.4rem; display:flex; flex-direction:column; gap:0.3rem; max-height:180px; overflow-y:auto;"></div>
                    <button type="button" class="btn" style="font-size:0.8rem; padding:0.35rem 0.7rem; margin-top:0.5rem;" onclick="closeBookingModal(); openInvoiceModal('${bookingHouseholdId}', null, '${existingBooking.id}')">+ Create New Invoice</button>
                `;
                await searchInvoicesForBooking('', existingBooking.id);
            }
        }
    }

    const modal = document.getElementById('booking-modal');
    if (modal) {
        modal.classList.remove('hidden');
        refreshIcons();
    }
}

/* Helper to render household pet checkboxes */
function renderPetSelectionCheckboxes(pets, selectedIds = []) {
    const petBox = document.getElementById('bk-pet-checkboxes');
    if (!petBox) return;

    petBox.innerHTML = (pets && pets.length)
        ? pets.map(p => `
            <label style="display:flex; align-items:center; gap:0.4rem; font-size:0.85rem; margin-bottom:0.35rem;">
                <input type="checkbox" class="bk-pet-checkbox" value="${p.id}" data-species="${(p.species || '').toLowerCase()}" ${selectedIds.includes(p.id) ? 'checked' : ''}>
                ${p.name} (${p.species})
            </label>
        `).join('')
        : '<span style="font-size:0.8rem; color:var(--text-muted);">No pets found.</span>';
}

/* Searches ALL pets across BarkBoard when starting an appointment from Activities */
async function searchGlobalPetsForBooking(query) {
    const container = document.getElementById('bk-global-pet-results');
    if (!container) return;

    const client = getSupabase();
    if (!client) return;

    const q = (query || '').trim().toLowerCase();
    let dbQuery = client.from('pets').select('id, name, species, household_id, households(name)').order('name').limit(15);
    if (q) {
        dbQuery = dbQuery.or(`name.ilike.%${q}%,species.ilike.%${q}%`);
    }

    const { data: pets } = await dbQuery;

    if (!pets || !pets.length) {
        container.innerHTML = '<div style="font-size:0.8rem; color:var(--text-muted); padding:0.3rem;">No matching pets found.</div>';
        return;
    }

    container.innerHTML = pets.map(p => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.35rem 0.5rem; border:1px solid var(--border); border-radius:0.25rem; background:var(--bg-card); font-size:0.82rem; cursor:pointer;" onclick="selectGlobalPetForBooking('${p.id}', '${p.household_id}')">
            <span><strong>${p.name}</strong> (${p.species}) ${p.households?.name ? '· ' + p.households.name : ''}</span>
            <button type="button" class="btn btn-primary" style="font-size:0.7rem; padding:0.15rem 0.45rem;">Select</button>
        </div>
    `).join('');
}

/* Selecting a pet automatically binds its household and populates all household pets */
async function selectGlobalPetForBooking(petId, householdId) {
    bookingHouseholdId = householdId;
    const client = getSupabase();
    if (!client || !householdId) return;

    const { data: pets } = await client.from('pets').select('id, name, species').eq('household_id', householdId).order('name');
    renderPetSelectionCheckboxes(pets || [], [petId]);
}

/* Calculates Total Amount based on Service Per-Day / Per-Service Rate × Days */
let activeServicePerDayRate = null;

/* Unified pricing model: Rate/day × days = Subtotal, always — a single-day appointment is
   just days=1. Rate/day is always the editable source of truth (pre-filled from a template
   when one's picked, but freely overridable). Subtotal (bk-amount) is a hidden field that
   just carries the computed value through to save/discount math. */
function calculateBookingTotalAmount() {
    const type = document.getElementById('bk-type')?.value || 'appointment';
    const startDateStr = document.getElementById('bk-start-date')?.value;
    const endDateStr = document.getElementById('bk-end-date')?.value;
    const amountInput = document.getElementById('bk-amount');
    const rateInput = document.getElementById('bk-rate-per-day');
    const daysDisplay = document.getElementById('bk-days-display');
    const subtotalDisplay = document.getElementById('bk-subtotal-display');

    if (!amountInput) return;

    let days = 1;
    if (type === 'stay' && startDateStr && endDateStr) {
        const start = new Date(startDateStr);
        const end = new Date(endDateStr);
        const diffTime = end.getTime() - start.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        days = diffDays > 0 ? diffDays : 1;
    }

    const rateRaw = rateInput?.value;
    const rate = rateRaw !== '' && rateRaw != null ? parseFloat(rateRaw) : 0;
    activeServicePerDayRate = rateRaw !== '' && rateRaw != null && !isNaN(rate) ? rate : null;

    const subtotal = (isNaN(rate) ? 0 : rate) * days;
    amountInput.value = subtotal.toFixed(2);
    if (daysDisplay) daysDisplay.textContent = days;
    if (subtotalDisplay) subtotalDisplay.textContent = '$' + subtotal.toFixed(2);

    updateDiscountedTotalDisplay();
}

/* Subtracts the Discount field from the Subtotal to show the actual final total.
   The Subtotal itself is never mutated by the discount — only this read-only display is. */
function updateDiscountedTotalDisplay() {
    const totalEl = document.getElementById('bk-final-total');
    if (!totalEl) return;
    const subtotal = parseFloat(document.getElementById('bk-amount')?.value) || 0;
    const discount = parseFloat(document.getElementById('bk-discount')?.value) || 0;
    const final = Math.max(0, subtotal - discount);
    totalEl.textContent = '$' + final.toFixed(2);
}

async function searchResourcesForBooking(query) {
    const container = document.getElementById('bk-resource-search-results');
    if (!container) return;

    const client = getSupabase();
    if (!client) return;

    const q = (query || '').trim();
    const type = document.getElementById('bk-type')?.value || 'appointment';
    const startDate = document.getElementById('bk-start-date')?.value;
    const startTime = document.getElementById('bk-start-time')?.value || '00:00';
    const endDate = document.getElementById('bk-end-date')?.value || startDate;

    // Fetch resources matching search query
    let dbQuery = client.from('resources').select('*').order('name').limit(20);
    if (q) {
        dbQuery = dbQuery.or(`name.ilike.%${q}%,type.ilike.%${q}%`);
    }
    const { data: allResources } = await dbQuery;

    // Calculate resource seat utilization for the date range
    let usageCounts = {};
    if (startDate) {
        const rangeStart = type === 'stay' ? `${startDate}T00:00:00` : `${startDate}T${startTime}:00`;
        const rangeEnd = type === 'stay' ? `${endDate}T23:59:59` : `${startDate}T23:59:59`;

        const { data: bookedRows } = await client.from('booking_resources')
            .select('resource_id, bookings!inner(id, check_in, check_out, status)')
            .neq('bookings.status', 'cancelled')
            .lte('bookings.check_in', rangeEnd)
            .gte('bookings.check_out', rangeStart);

        (bookedRows || []).forEach(row => {
            // Ignore the booking currently being edited
            if (editingBookingId && row.bookings?.id === editingBookingId) return;

            const bkStart = (row.bookings?.check_in || '').slice(0, 10);
            const bkEnd = (row.bookings?.check_out || bkStart).slice(0, 10);

            // Same-Day Turnover Rule: Check-out day frees the seat for new afternoon check-ins
            if (bkStart !== bkEnd && bkEnd === startDate) return;

            usageCounts[row.resource_id] = (usageCounts[row.resource_id] || 0) + 1;
        });
    }

    // Don't re-offer resources already added to this event
    const selectedIds = new Set(bkEventResources.map(r => r.resourceId));
    const list = (allResources || []).filter(r => !selectedIds.has(r.id));

    if (!list.length) {
        container.innerHTML = '<div style="font-size:0.8rem; color:var(--text-muted); padding:0.4rem;">No matching resources found.</div>';
        return;
    }

    container.innerHTML = list.map(r => {
        const seats = r.seats || 1;
        const used = usageCounts[r.id] || 0;
        const freeSeats = Math.max(0, seats - used);
        const full = used >= seats;

        return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:0.25rem; background:var(--bg-card); font-size:0.82rem; margin-bottom:0.25rem;">
                <div>
                    <strong>${r.name}</strong>
                    <span style="color:var(--text-muted); font-size:0.78rem;">(${r.type || 'General'}${seats > 1 ? ' · ' + freeSeats + '/' + seats + ' seats free' : ''})</span>
                    ${full ? ' <span style="color:#dc2626; font-weight:600; font-size:0.75rem;">— FULL</span>' : ''}
                </div>
                <button type="button" class="btn btn-primary" style="font-size:0.72rem; padding:0.2rem 0.5rem;" ${full ? 'disabled style="opacity:0.5; cursor:not-allowed;"' : ''} onclick="addResourceToBooking('${r.id}', '${r.name.replace(/'/g, "\\'")}', '${(r.type || '').replace(/'/g, "\\'")}', '${r.default_mode || 'all_day'}')">
                    Add
                </button>
            </div>
        `;
    }).join('');
}

// Resources of a given type are treated as interchangeable, and a resource's "seats" setting
// controls how many bookings can use it at once (e.g. a "Kennels" resource with 10 seats).
// This shows only resources with a free seat for the currently entered dates.
// NOTE: availability checking here is date-range granularity only — a time-based resource
// already assigned to another booking on an overlapping date counts against its seat total
// even if the specific times wouldn't actually conflict. True time-slot-level conflict
// resolution (the "matrix") is a bigger follow-up piece, not built yet.

let bkEventResources = []; // [{ resourceId, name, type, defaultMode, allDay, startTime, endTime }]
// Resources belong to the EVENT/appointment as a whole, not to any one pet — a multi-pet
// event (e.g. two dogs sharing a training session) applies the same resource list to every
// booking row generated for that event. See saveBooking()'s resource-save loop.

/* Adds a resource to this event's resource list (not tied to any specific pet) */
function addResourceToBooking(resourceId, name, type, defaultMode) {
    if (bkEventResources.some(r => r.resourceId === resourceId)) return;

    bkEventResources.push({
        resourceId,
        name,
        type,
        defaultMode,
        allDay: defaultMode !== 'time_based',
        startTime: '',
        endTime: ''
    });
    renderBkResourcesList();

    // Clear search input and results dropdown
    const searchInput = document.getElementById('bk-resource-search');
    if (searchInput) searchInput.value = '';
    const resultsContainer = document.getElementById('bk-resource-search-results');
    if (resultsContainer) resultsContainer.innerHTML = '';
}

function renderBkResourcesList() {
    const el = document.getElementById('bk-event-resources-list');
    if (!el) return;

    el.innerHTML = bkEventResources.length ? bkEventResources.map((r, idx) => `
        <div style="padding:0.4rem 0.5rem; border:1px solid var(--border); border-radius:0.25rem; background:var(--bg-card);">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <strong style="font-size:0.8rem;">${r.name} <span style="color:var(--text-muted); font-weight:400;">(${r.type})</span></strong>
                <button type="button" class="btn-icon" onclick="removeBkResource(${idx})" title="Remove" style="background:none; border:none; cursor:pointer;"><i data-lucide="x" style="width:13px;height:13px;"></i></button>
            </div>
            <label style="display:flex; align-items:center; gap:0.4rem; font-size:0.78rem; margin-top:0.3rem;">
                <input type="checkbox" ${r.allDay ? 'checked' : ''} onchange="setBkResourceAllDay(${idx}, this.checked)"> All day
            </label>
            ${!r.allDay ? `
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:0.4rem; margin-top:0.3rem;">
                    <input type="time" value="${r.startTime || ''}" onchange="setBkResourceTime(${idx}, 'startTime', this.value)" style="padding:0.35rem; border:1px solid var(--border); border-radius:0.25rem; font-size:0.78rem;">
                    <input type="time" value="${r.endTime || ''}" onchange="setBkResourceTime(${idx}, 'endTime', this.value)" style="padding:0.35rem; border:1px solid var(--border); border-radius:0.25rem; font-size:0.78rem;">
                </div>
            ` : ''}
        </div>
    `).join('') : '<p style="font-size:0.78rem; color:var(--text-muted);">No resources assigned yet.</p>';
    refreshIcons();
}

function setBkResourceAllDay(idx, checked) {
    if (bkEventResources[idx]) bkEventResources[idx].allDay = checked;
    renderBkResourcesList();
}

function setBkResourceTime(idx, field, value) {
    if (bkEventResources[idx]) bkEventResources[idx][field] = value;
}

function removeBkResource(idx) {
    bkEventResources.splice(idx, 1);
    renderBkResourcesList();
}

async function searchServiceTypeForBooking(query) {
    const container = document.getElementById('bk-service-type-results');
    if (!container) return;
    const q = query.trim();

    const client = getSupabase();
    if (!client) return;

    let dbQuery = client.from('appointment_type_templates').select('*').order('name').limit(20);
    if (q) dbQuery = dbQuery.ilike('name', `%${q}%`);
    const { data: allMatches } = await dbQuery;

    // Restrict to templates that apply to the currently-checked pet(s)' species —
    // a template with no species set (null/empty) is unrestricted and always shows.
    // With multiple pets of different species checked, a template shows if it
    // matches ANY of them (union), not all.
    const checkedSpecies = new Set(
        Array.from(document.querySelectorAll('.bk-pet-checkbox:checked'))
            .map(cb => cb.dataset.species)
            .filter(Boolean)
    );
    const matches = checkedSpecies.size
        ? (allMatches || []).filter(t => !Array.isArray(t.species) || !t.species.length || t.species.some(s => checkedSpecies.has(s)))
        : (allMatches || []);

    const rows = matches.slice(0, 8).map(t => `
        <div style="padding:0.5rem 0.65rem; cursor:pointer; font-size:0.85rem; border-bottom:1px solid var(--border);" onmousedown='selectServiceTypeTemplate(${JSON.stringify(t.name)}, ${JSON.stringify(t.resource_type || null)}, ${t.default_price != null ? t.default_price : 'null'}, ${!!t.requires_staff_time}, ${t.staff_time_minutes || 'null'}, ${JSON.stringify(t.staff_time_resource_type || null)}, ${JSON.stringify(t.pricing_unit || 'flat')})'>
            <strong>${t.name}</strong>
            <span style="color:var(--text-muted); font-size:0.78rem;">${t.default_price != null ? ' · $' + Number(t.default_price).toFixed(2) + (t.pricing_unit === 'per_day' ? '/day' : '') : ''}${t.resource_type ? ' · needs ' + t.resource_type : ''}${t.requires_staff_time ? ' · staff time' : ''}</span>
        </div>
    `).join('');

    const customRow = q ? `<div style="padding:0.5rem 0.65rem; cursor:pointer; font-size:0.85rem; color:var(--text-muted);" onmousedown='selectServiceTypeTemplate(${JSON.stringify(q)}, null, null, false, null, null, "flat")'>Use custom: "${q}"</div>` : '';

    container.innerHTML = rows + customRow || '<div style="padding:0.5rem 0.65rem; font-size:0.82rem; color:var(--text-muted);">No matching services — start typing to enter a custom one.</div>';
    container.classList.remove('hidden');
}

function selectServiceTypeTemplate(name, resourceType, price, requiresStaffTime, staffTimeMinutes, staffTimeResourceType, pricingUnit) {
    const serviceInput = document.getElementById('bk-service-type');
    if (serviceInput) serviceInput.value = name;
    document.getElementById('bk-service-type-results')?.classList.add('hidden');

    const staffTimeField = document.getElementById('bk-staff-time-field');
    const staffTimeMinutesInput = document.getElementById('bk-staff-time-minutes');

    if (staffTimeField) staffTimeField.classList.toggle('hidden', !requiresStaffTime);
    if (staffTimeMinutesInput && requiresStaffTime) staffTimeMinutesInput.value = staffTimeMinutes || '';

    // Pre-fill the Rate/Day field from the template's price — for a single-day appointment
    // this just becomes "rate × 1 day", so it works as a flat amount there automatically.
    // Note: for a multi-day stay, this now always multiplies by nights regardless of whether
    // the template was marked "flat" or "per day" — see note in chat about this tradeoff.
    const rateInput = document.getElementById('bk-rate-per-day');
    if (rateInput) rateInput.value = price != null ? price : '';
    calculateBookingTotalAmount();

    // If a resource type is declared, prefill the event resource search to nudge toward it.
    if (resourceType && !bkEventResources.length) {
        const searchInput = document.getElementById('bk-resource-search');
        if (searchInput) {
            searchInput.value = resourceType;
            searchResourcesForBooking(resourceType);
        }
    }
}

async function loadExistingBookingResources(bookingId) {
    const client = getSupabase();
    if (!client) return [];

    // Fetching booking_resources and resources as two plain queries and joining in JS,
    // rather than a nested PostgREST embed — the embed kept failing with PGRST201
    // ("more than one relationship") no matter which column/constraint hint was given,
    // so this sidesteps that ambiguity entirely regardless of how the FKs are set up.
    const { data: rows, error } = await client.from('booking_resources').select('*').eq('booking_id', bookingId);
    if (error) {
        console.error('Failed to load resource assignments:', error);
        return [];
    }
    if (!rows || !rows.length) return [];

    const resourceIds = Array.from(new Set(rows.map(r => r.resource_id).filter(Boolean)));
    let resourcesById = {};
    if (resourceIds.length) {
        const { data: resourceRows, error: resErr } = await client.from('resources').select('id, name, type, default_mode').in('id', resourceIds);
        if (resErr) {
            console.error('Failed to load resource details:', resErr);
        } else {
            (resourceRows || []).forEach(r => { resourcesById[r.id] = r; });
        }
    }

    return rows.map(row => {
        const res = resourcesById[row.resource_id];
        return {
            resourceId: row.resource_id,
            name: res?.name || 'Resource',
            type: res?.type || '',
            defaultMode: res?.default_mode || 'all_day',
            allDay: row.all_day,
            startTime: row.start_time || '',
            endTime: row.end_time || ''
        };
    });
}

async function searchInvoicesForBooking(query, bookingId) {
    const container = document.getElementById('bk-invoice-link-results');
    if (!container) return;
    const q = query.trim();

    const client = getSupabase();
    if (!client) return;

    let dbQuery = client.from('invoices').select('id, description, amount, status')
        .eq('household_id', bookingHouseholdId)
        .order('due_date', { ascending: false })
        .limit(20);
    if (q) dbQuery = dbQuery.ilike('description', `%${q}%`);

    const { data: invoices } = await dbQuery;

    container.innerHTML = (invoices && invoices.length) ? invoices.map(inv => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:0.25rem; background:var(--bg-card); font-size:0.82rem;">
            <span>${inv.description || 'Invoice'} · $${Number(inv.amount || 0).toFixed(2)} · <span style="text-transform:capitalize;">${inv.status || 'unpaid'}</span></span>
            <button class="btn btn-primary" style="font-size:0.72rem; padding:0.2rem 0.45rem;" onclick="linkBookingToInvoice('${bookingId}', '${inv.id}')">Link</button>
        </div>
    `).join('') : '<div style="font-size:0.8rem; color:var(--text-muted);">No existing invoices for this household yet.</div>';
}

async function linkBookingToInvoice(bookingId, invoiceId) {
    const client = getSupabase();
    if (!client) return;
    await client.from('bookings').update({ invoice_id: invoiceId }).eq('id', bookingId);
    openBookingModal(bookingHouseholdId, bookingId);
}

function closeBookingModal() {
    editingBookingId = null;
    bookingHouseholdId = null;
    const modal = document.getElementById('booking-modal');
    if (modal) modal.classList.add('hidden');
}

async function saveBookingResources(client, bookingId, resourceList) {
    if (!client || !bookingId) return;

    // Clear old assignments for this booking
    const { error: deleteError } = await client.from('booking_resources').delete().eq('booking_id', bookingId);
    if (deleteError) {
        console.error('Failed to clear old resource assignments:', deleteError);
        alert('Could not update resource assignments: ' + deleteError.message);
        return;
    }

    if (!resourceList || !resourceList.length) return;

    // Format rows for Supabase insertion
    const rows = resourceList.map(r => ({
        booking_id: bookingId,
        resource_id: r.resourceId,
        all_day: r.allDay !== false,
        start_time: r.allDay ? null : (r.startTime || null),
        end_time: r.allDay ? null : (r.endTime || null),
        business_id: currentBusinessId
    }));

    const { error: insertError } = await client.from('booking_resources').insert(rows);
    if (insertError) {
        // Previously failed silently here — this is almost certainly why resource
        // assignments looked like they "weren't sticking": the insert was failing
        // (e.g. an RLS policy or constraint on booking_resources) with no feedback.
        console.error('Failed to save resource assignments:', insertError);
        alert('Could not save resource assignments: ' + insertError.message);
    }
}

async function saveBooking() {
    console.log("1. saveBooking initiated");
    const client = getSupabase();
    if (!client) {
        console.error("Supabase client unavailable");
        return alert('Database connection unavailable.');
    }

    const type = document.getElementById('bk-type')?.value || 'appointment';
    const serviceName = document.getElementById('bk-service-type')?.value.trim() || '';
    const startDate = document.getElementById('bk-start-date')?.value || '';
    const startTimeRaw = document.getElementById('bk-start-time')?.value || '';
    const endDate = document.getElementById('bk-end-date')?.value || '';
    const endTimeRaw = document.getElementById('bk-end-time')?.value || '';
    const amountRaw = document.getElementById('bk-amount')?.value;
    const discountRaw = document.getElementById('bk-discount')?.value;
    const rateRaw = document.getElementById('bk-rate-per-day')?.value;
    const status = document.getElementById('bk-status')?.value || 'pending';
    const staffId = document.getElementById('bk-staff-id')?.value || null;
    const requiresStaffTime = !document.getElementById('bk-staff-time-field')?.classList.contains('hidden');
    const staffTimeMinutes = document.getElementById('bk-staff-time-minutes')?.value;
    const notes = document.getElementById('bk-notes')?.value.trim() || '';
    const notesVisibleToCustomer = document.getElementById('bk-notes-visible-customer')?.checked || false;
    
    const flexibleTime = document.getElementById('bk-flexible-time-row') && !document.getElementById('bk-flexible-time-row').classList.contains('hidden')
        ? (document.getElementById('bk-flexible-time')?.checked || false)
        : false; // Safely defaults to false to avoid NOT NULL DB constraint errors
    
    const petCheckboxes = Array.from(document.querySelectorAll('.bk-pet-checkbox:checked'));
    const petIds = petCheckboxes.map(cb => cb.value);
    const petNames = petCheckboxes.map(cb => cb.parentElement?.textContent.trim() || '').filter(Boolean);

    console.log("2. Form values:", { type, startDate, petIdsCount: petIds.length, bookingHouseholdId });

    if (!startDate) return alert('Please choose a date.');
    if (!startTimeRaw) return alert(type === 'stay' ? 'Please choose a drop-off time.' : 'Please choose a time.');
    if (type === 'stay' && !endDate) return alert('Please choose an end date for a multi-day stay.');
    if (type === 'stay' && !endTimeRaw) return alert('Please choose a pickup time.');
    if (petIds.length === 0) return alert('Please select at least one pet.');

    const startTime = startTimeRaw;
    const endTime = type === 'stay' ? endTimeRaw : startTimeRaw;

    let targetHouseholdId = bookingHouseholdId;
    if (!targetHouseholdId && petIds.length) {
        console.log("3. Resolving household ID from selected pet...");
        const { data: petData, error: petErr } = await client.from('pets').select('household_id').eq('id', petIds[0]).single();
        if (petErr) console.error("Error resolving pet household:", petErr);
        if (petData?.household_id) targetHouseholdId = petData.household_id;
    }

    console.log("4. Resolved targetHouseholdId:", targetHouseholdId);
    if (!targetHouseholdId) return alert('Could not resolve household for selected pet.');

    const subtotal = amountRaw ? parseFloat(amountRaw) : 0;
    const discount = discountRaw ? parseFloat(discountRaw) : 0;
    const amount = Math.max(0, subtotal - discount);
    const ratePerDay = (rateRaw !== '' && rateRaw != null) ? parseFloat(rateRaw) : null;

    const checkIn = `${startDate}T${startTime}:00`;
    const checkOut = type === 'stay' ? `${endDate}T${endTime}:00` : checkIn;

    console.log("5. Submitting to Supabase...");
    
    const basePayload = {
        household_id: targetHouseholdId,
        service_name: serviceName,
        check_in: checkIn,
        check_out: checkOut,
        amount: amount,
        status: status,
        assigned_staff_id: staffId || null,
        requires_staff_time: requiresStaffTime,
        staff_time_minutes: requiresStaffTime && staffTimeMinutes ? parseInt(staffTimeMinutes, 10) : null,
        notes: notes,
        notes_visible_to_customer: notesVisibleToCustomer,
        flexible_time: flexibleTime,
        rate_per_day: ratePerDay,
        discount_amount: discount,
        business_id: typeof currentBusinessId !== 'undefined' ? currentBusinessId : null
    };

    let response;
    let firstNewBookingId = null;
    let petIdToBookingId = {};
    let existingBookingInvoiceId = null;

    if (editingBookingId) {
        const { data: currentBk } = await client.from('bookings').select('invoice_id').eq('id', editingBookingId).single();
        existingBookingInvoiceId = currentBk?.invoice_id || null;

        const [firstPetId, ...extraPetIds] = petIds;
        response = await client.from('bookings').update({ ...basePayload, pet_id: firstPetId }).eq('id', editingBookingId);
        petIdToBookingId[firstPetId] = editingBookingId;
        
        if (!response.error && extraPetIds.length) {
            const extraRows = extraPetIds.map(pid => ({ ...basePayload, pet_id: pid }));
            const extraResponse = await client.from('bookings').insert(extraRows).select();
            if (extraResponse.error) response = extraResponse;
            else (extraResponse.data || []).forEach(r => { petIdToBookingId[r.pet_id] = r.id; });
        }
    } else {
        const rows = petIds.map(pid => ({ ...basePayload, pet_id: pid }));
        response = await client.from('bookings').insert(rows).select();
        if (!response.error && response.data && response.data.length) {
            firstNewBookingId = response.data[0].id;
            response.data.forEach(r => { petIdToBookingId[r.pet_id] = r.id; });
        }
    }

    if (response.error) {
        alert('Failed to save event: ' + response.error.message);
        console.error('Supabase booking error:', response.error);
    } else {
        // 1. Save resource assignments and trigger background push to Google Calendar
        for (const pid of Object.keys(petIdToBookingId)) {
            const bookingId = petIdToBookingId[pid];
            if (typeof saveBookingResources === 'function' && typeof bkEventResources !== 'undefined') {
                await saveBookingResources(client, bookingId, bkEventResources);
            }
            
            // Push event directly to Google Calendar if assigned staff has synced Google
            if (typeof pushBookingToGoogleCalendar === 'function') {
                pushBookingToGoogleCalendar(bookingId);
            }
        }

        // 2. Invoice sync logic
        if (editingBookingId && existingBookingInvoiceId && typeof syncInvoiceTotals === 'function') {
            await syncInvoiceTotals(client, existingBookingInvoiceId);
        }
        if (editingBookingId && !existingBookingInvoiceId && status === 'confirmed' && amount > 0 && typeof ensureInvoiceForConfirmedBooking === 'function') {
            await ensureInvoiceForConfirmedBooking(client, editingBookingId);
        }

        // 3. Auto-generate & link invoice for new bookings
        if (firstNewBookingId && amount > 0) {
            const when = type === 'stay' ? `${startDate} → ${endDate}` : startDate;
            
            const { data: createdInvoices, error: invErr } = await client.from('invoices').insert([{
                household_id: targetHouseholdId,
                booking_id: firstNewBookingId,
                description: `${serviceName || 'Event'} — ${when}`,
                amount: amount,
                status: 'unpaid',
                due_date: startDate,
                service_start_date: startDate,
                service_end_date: type === 'stay' ? endDate : startDate,
                pet_names: petNames.join(', '),
                business_id: typeof currentBusinessId !== 'undefined' ? currentBusinessId : null
            }]).select();

            if (!invErr && createdInvoices && createdInvoices.length) {
                const newInvoiceId = createdInvoices[0].id;
                const allBookingIds = Object.values(petIdToBookingId);
                
                await client.from('bookings')
                    .update({ invoice_id: newInvoiceId })
                    .in('id', allBookingIds);
            }
        }

        closeBookingModal();

        // 4. Refresh active views
        if (targetHouseholdId && typeof openFullWidthProfile === 'function' && document.getElementById('crm-list-container')?.querySelector('.full-width-profile-view')) {
            openFullWidthProfile('household', targetHouseholdId);
        }
        if (typeof renderActivities === 'function') await renderActivities();
        if (typeof renderActivitiesCalendar === 'function') await renderActivitiesCalendar();
        if (typeof renderCalendar === 'function') await renderCalendar();
    }
}

async function deleteBooking(id, householdId) {
    if (!confirm('Remove this scheduled event?')) return;
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    // Grab the linked invoice (if any) before deleting so its total can be resynced after.
    const { data: bk } = await client.from('bookings').select('invoice_id').eq('id', id).single();
    const linkedInvoiceId = bk?.invoice_id || null;

    const { error } = await client.from('bookings').delete().eq('id', id);
    if (error) {
        alert('Error deleting event: ' + error.message);
    } else {
        if (linkedInvoiceId) await syncInvoiceTotals(client, linkedInvoiceId);
        openFullWidthProfile('household', householdId);
    }
}

// Delete button inside the appointment edit modal itself (uses the currently-open booking).
async function deleteBookingFromModal() {
    if (!editingBookingId) return;
    const id = editingBookingId;
    const householdId = bookingHouseholdId;
    if (!confirm('Remove this scheduled event? This cannot be undone.')) return;

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    // 1. Fetch booking to check for linked invoices and Google Calendar event IDs
    const { data: bk } = await client
        .from('bookings')
        .select('invoice_id, google_event_id, assigned_staff_id')
        .eq('id', id)
        .single();

    const linkedInvoiceId = bk?.invoice_id || null;

    // 2. Remove from Google Calendar if synced
    if (bk?.google_event_id && bk?.assigned_staff_id) {
        fetch('/api/sync-to-google', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bookingId: id })
        }).catch(err => console.warn('Google Calendar delete background sync failed:', err));
    }

    // 3. Remove linked booking_resources first (to prevent foreign key errors)
    await client.from('booking_resources').delete().eq('booking_id', id);

    // 4. Delete booking row
    const { error } = await client.from('bookings').delete().eq('id', id);
    if (error) {
        alert('Error deleting event: ' + error.message);
        return;
    }

    // 5. Recalculate invoice totals if attached
    if (linkedInvoiceId) await syncInvoiceTotals(client, linkedInvoiceId);

    closeBookingModal();
    if (householdId && typeof openFullWidthProfile === 'function') {
        openFullWidthProfile('household', householdId);
    }
    if (typeof renderActivities === 'function') await renderActivities();
    if (typeof renderActivitiesCalendar === 'function') await renderActivitiesCalendar();
    if (typeof renderCalendar === 'function') await renderCalendar();
}
let editingInvoiceId = null;
let invoiceHouseholdId = null;
let pendingLinkBookingId = null; // booking to auto-link once a brand-new invoice is saved

async function openInvoiceModal(householdId, invoiceId = null, linkBookingId = null) {
    editingInvoiceId = invoiceId;
    invoiceHouseholdId = householdId;
    // Only relevant when creating a fresh invoice from an appointment's "+ Create New Invoice" button.
    pendingLinkBookingId = invoiceId ? null : linkBookingId;

    const titleEl = document.getElementById('invoice-modal-title');
    const descInput = document.getElementById('inv-description');
    const bookingSel = document.getElementById('inv-booking-id');
    const amountInput = document.getElementById('inv-amount');
    const dueDateInput = document.getElementById('inv-due-date');
    const statusSel = document.getElementById('inv-status');
    const notesInput = document.getElementById('inv-notes');
    const petNamesInput = document.getElementById('inv-pet-names');
    const serviceStartInput = document.getElementById('inv-service-start');
    const serviceEndInput = document.getElementById('inv-service-end');

    if (titleEl) titleEl.textContent = invoiceId ? 'Edit Invoice' : 'Create Invoice';
    document.getElementById('inv-delete-btn')?.classList.toggle('hidden', !invoiceId);

    // Reset fields
    if (descInput) descInput.value = '';
    if (amountInput) amountInput.value = '';
    if (dueDateInput) dueDateInput.value = '';
    if (statusSel) statusSel.value = 'unpaid';
    if (notesInput) notesInput.value = '';
    if (petNamesInput) petNamesInput.value = '';
    if (serviceStartInput) serviceStartInput.value = '';
    if (serviceEndInput) serviceEndInput.value = '';

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    // Pull the source appointment's details through into the new invoice immediately,
    // rather than leaving the form blank until after it's linked on save.
    if (pendingLinkBookingId) {
        const { data: sourceBk } = await client.from('bookings')
            .select('service_name, amount, check_in, check_out, pets(name)')
            .eq('id', pendingLinkBookingId).single();
        if (sourceBk) {
            if (amountInput) amountInput.value = sourceBk.amount != null ? sourceBk.amount : '';
            if (dueDateInput) dueDateInput.value = sourceBk.check_in ? sourceBk.check_in.slice(0, 10) : '';
            if (descInput) descInput.value = sourceBk.service_name || '';
            if (petNamesInput) petNamesInput.value = sourceBk.pets?.name || '';
            if (serviceStartInput) serviceStartInput.value = sourceBk.check_in ? sourceBk.check_in.slice(0, 10) : '';
            if (serviceEndInput) serviceEndInput.value = sourceBk.check_out ? sourceBk.check_out.slice(0, 10) : '';
        }
    }

    // Load this household's events for the optional link dropdown
    const { data: bookings } = await client.from('bookings').select('id, service_name, check_in, check_out, amount, pet_id').eq('household_id', householdId).order('check_in', { ascending: false });
    const { data: householdPets } = await client.from('pets').select('id, name').eq('household_id', householdId);
    const petNameById = {};
    (householdPets || []).forEach(p => { petNameById[p.id] = p.name; });

    if (bookingSel) {
        const options = (bookings || []).map(bk => {
            const inDate = bk.check_in ? bk.check_in.slice(0, 10) : '';
            const outDate = bk.check_out ? bk.check_out.slice(0, 10) : '';
            const when = outDate && outDate !== inDate ? `${inDate} → ${outDate}` : inDate;
            return `<option value="${bk.id}" data-start="${inDate}" data-end="${outDate || inDate}" data-pet="${petNameById[bk.pet_id] || ''}">${bk.service_name || 'Event'} · ${when}</option>`;
        }).join('');
        bookingSel.innerHTML = `<option value="">None</option>${options}`;
        bookingSel.onchange = function () {
            const opt = this.selectedOptions[0];
            if (!opt || !opt.value) return;
            if (serviceStartInput && !serviceStartInput.value) serviceStartInput.value = opt.dataset.start || '';
            if (serviceEndInput && !serviceEndInput.value) serviceEndInput.value = opt.dataset.end || '';
            if (petNamesInput && !petNamesInput.value) petNamesInput.value = opt.dataset.pet || '';
        };
    }

    let existingInvoice = null;
    if (invoiceId) {
        const { data: inv } = await client.from('invoices').select('*').eq('id', invoiceId).single();
        existingInvoice = inv;
    }

    if (existingInvoice) {
        if (descInput) descInput.value = existingInvoice.description || '';
        if (bookingSel) bookingSel.value = existingInvoice.booking_id || '';
        if (amountInput) amountInput.value = existingInvoice.amount != null ? existingInvoice.amount : '';
        if (dueDateInput) dueDateInput.value = existingInvoice.due_date || '';
        if (statusSel) statusSel.value = existingInvoice.status || 'unpaid';
        if (notesInput) notesInput.value = existingInvoice.notes || '';
        if (petNamesInput) petNamesInput.value = existingInvoice.pet_names || '';
        if (serviceStartInput) serviceStartInput.value = existingInvoice.service_start_date || '';
        if (serviceEndInput) serviceEndInput.value = existingInvoice.service_end_date || '';
    }

    const linkedApptsSection = document.getElementById('inv-linked-appts-section');
    if (linkedApptsSection) linkedApptsSection.classList.toggle('hidden', !invoiceId);
    if (invoiceId) {
        await renderLinkedAppointments(invoiceId);
        document.getElementById('inv-appt-search').value = '';
        await searchAppointmentsForInvoice('');
    }

    const modal = document.getElementById('invoice-modal');
    if (modal) {
        modal.classList.remove('hidden');
        refreshIcons();
    }
}

// Recalculates an invoice's amount + description from its currently-linked bookings.
// Used anywhere a linked booking is edited, added, removed, or deleted outside of the
// invoice modal itself (renderLinkedAppointments does the same thing, but only runs
// while that modal is open).
async function syncInvoiceTotals(client, invoiceId) {
    if (!client || !invoiceId) return;
    const { data: linked } = await client.from('bookings').select('service_name, amount').eq('invoice_id', invoiceId);
    const total = (linked || []).reduce((sum, bk) => sum + Number(bk.amount || 0), 0);
    const titles = Array.from(new Set((linked || []).map(bk => bk.service_name).filter(Boolean)));
    await client.from('invoices').update({
        amount: total,
        description: titles.length ? titles.join(' & ') : 'Invoice'
    }).eq('id', invoiceId);
}

async function renderLinkedAppointments(invoiceId) {
    const el = document.getElementById('inv-linked-appts-list');
    const amountInput = document.getElementById('inv-amount');
    if (!el) return;

    const client = getSupabase();
    if (!client) return;

    // Pull linked appointments with service names, dates, amounts, and pet details
    const { data: linked } = await client
        .from('bookings')
        .select('id, service_name, check_in, check_out, amount, pets(name)')
        .eq('invoice_id', invoiceId)
        .order('check_in');

    let calculatedTotal = 0;
    const appointmentTitles = [];

    if (linked && linked.length) {
        el.innerHTML = linked.map(bk => {
            const inDate = bk.check_in ? bk.check_in.slice(0, 10) : '';
            const outDate = bk.check_out ? bk.check_out.slice(0, 10) : '';
            const when = outDate && outDate !== inDate ? `${inDate} → ${outDate}` : inDate;
            const petName = bk.pets?.name ? ` (${bk.pets.name})` : '';
            const itemAmount = Number(bk.amount || 0);
            
            calculatedTotal += itemAmount;
            if (bk.service_name) {
                appointmentTitles.push(bk.service_name);
            }

            return `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:0.25rem; background:var(--bg-hover,#f9fafb); font-size:0.82rem; margin-bottom:0.35rem;">
                    <span><strong>${bk.service_name || 'Appointment'}</strong>${petName} · ${when} · $${itemAmount.toFixed(2)}</span>
                    <button class="btn-icon" onclick="removeAppointmentFromInvoice('${bk.id}', '${invoiceId}')" title="Unlink" style="background:none; border:none; cursor:pointer;">
                        <i data-lucide="x" style="width:13px;height:13px;"></i>
                    </button>
                </div>
            `;
        }).join('');

        // Generate combined description from appointment titles
        const dynamicDescription = appointmentTitles.length 
            ? Array.from(new Set(appointmentTitles)).join(' & ') 
            : 'Invoice';

        // Auto-update total amount and description in Supabase
        if (amountInput) {
            amountInput.value = calculatedTotal.toFixed(2);
        }

        await client.from('invoices').update({
            amount: calculatedTotal,
            description: dynamicDescription
        }).eq('id', invoiceId);

    } else {
        el.innerHTML = '<p style="font-size:0.82rem; color:var(--text-muted);">No appointments linked to this invoice.</p>';
    }

    refreshIcons();
}

async function searchAppointmentsForInvoice(query) {
    const container = document.getElementById('inv-appt-search-results');
    if (!container) return;
    const q = query.trim();

    const client = getSupabase();
    if (!client) return;

    let dbQuery = client.from('bookings').select('id, service_name, check_in, check_out, invoice_id')
        .eq('household_id', invoiceHouseholdId)
        .neq('invoice_id', editingInvoiceId || '00000000-0000-0000-0000-000000000000')
        .order('check_in', { ascending: false })
        .limit(20);
    if (q) dbQuery = dbQuery.ilike('service_name', `%${q}%`);

    const { data: matches } = await dbQuery;

    // Also include appointments with no invoice at all (the .neq above only excludes rows already on THIS invoice)
    const filtered = (matches || []).filter(bk => bk.invoice_id !== editingInvoiceId);

    container.innerHTML = filtered.length ? filtered.map(bk => {
        const inDate = bk.check_in ? bk.check_in.slice(0, 10) : '';
        return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:0.25rem; background:var(--bg-card); font-size:0.82rem;">
                <span>${bk.service_name || 'Event'} · ${inDate}${bk.invoice_id ? ' <span style="color:#dc2626;">(already on another invoice)</span>' : ''}</span>
                <button class="btn btn-primary" style="font-size:0.72rem; padding:0.2rem 0.45rem;" onclick="addAppointmentToInvoice('${bk.id}', '${editingInvoiceId}')">Add</button>
            </div>
        `;
    }).join('') : '<div style="font-size:0.8rem; color:var(--text-muted);">No appointments found for this household.</div>';
}

async function addAppointmentToInvoice(bookingId, invoiceId) {
    const client = getSupabase();
    if (!client) return;
    // Reassigning here is intentional: each appointment can only be on one invoice at a time.
    await client.from('bookings').update({ invoice_id: invoiceId }).eq('id', bookingId);
    document.getElementById('inv-appt-search').value = '';
    document.getElementById('inv-appt-search-results').innerHTML = '';
    renderLinkedAppointments(invoiceId);
}

async function removeAppointmentFromInvoice(bookingId, invoiceId) {
    const client = getSupabase();
    if (!client) return;
    await client.from('bookings').update({ invoice_id: null }).eq('id', bookingId);
    renderLinkedAppointments(invoiceId);
}

function closeInvoiceModal() {
    const modal = document.getElementById('invoice-modal');
    if (modal) modal.classList.add('hidden');
    
    // Clear global state
    editingInvoiceId = null;
    invoiceHouseholdId = null;
    pendingLinkBookingId = null;
}

async function saveInvoice() {
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const amountInput = document.getElementById('inv-amount');
    const amountRaw = amountInput ? amountInput.value : '0';
    const dueDate = document.getElementById('inv-due-date')?.value || new Date().toISOString().slice(0, 10);
    const status = document.getElementById('inv-status')?.value || 'unpaid';
    const notes = document.getElementById('inv-notes')?.value.trim() || '';

    const amount = parseFloat(amountRaw);
    if (isNaN(amount) || amount < 0) return alert('Please enter a valid invoice total.');

    // Fetch titles of currently linked appointments to form description
    let dynamicDescription = 'Invoice';
    if (editingInvoiceId) {
        const { data: linkedAppts } = await client
            .from('bookings')
            .select('service_name')
            .eq('invoice_id', editingInvoiceId);
            
        if (linkedAppts && linkedAppts.length) {
            const names = linkedAppts.map(a => a.service_name).filter(Boolean);
            if (names.length) {
                dynamicDescription = Array.from(new Set(names)).join(' & ');
            }
        }
    }

    const payload = {
        household_id: invoiceHouseholdId,
        description: dynamicDescription,
        amount: amount,
        due_date: dueDate,
        status: status,
        notes: notes,
        business_id: currentBusinessId
    };

    let response;
    if (editingInvoiceId) {
        response = await client.from('invoices').update(payload).eq('id', editingInvoiceId);
    } else {
        response = await client.from('invoices').insert([{ ...payload, business_id: currentBusinessId }]).select();
    }

    if (response.error) {
        alert('Failed to save invoice: ' + response.error.message);
        console.error('Supabase invoice error:', response.error);
    } else {
        // If this invoice was created via "+ Create New Invoice" from an appointment,
        // link that appointment now and let the total/description resync from it
        // (rather than trusting the pre-filled values, in case anything changed in the form).
        if (!editingInvoiceId && pendingLinkBookingId && response.data && response.data.length) {
            const newInvoiceId = response.data[0].id;
            await client.from('bookings').update({ invoice_id: newInvoiceId }).eq('id', pendingLinkBookingId);
            await syncInvoiceTotals(client, newInvoiceId);
        }
        pendingLinkBookingId = null;

        // Only notify when this created a NEW invoice — an edit to an existing
        // one already had its "invoice created" moment, and re-sending here
        // would just be noise. Auto-generated invoices (linked at booking
        // confirmation) already get covered by the booking-confirmed email
        // instead of a separate invoice-created one, to avoid two emails
        // landing back to back for the same thing.
        if (!editingInvoiceId && response.data && response.data.length) {
            notifyEmail('invoice-created', { invoiceId: response.data[0].id });
        }

        const refreshId = invoiceHouseholdId;
        closeInvoiceModal();
        openFullWidthProfile('household', refreshId);
    }
}

async function deleteInvoice(id, householdId) {
    if (!confirm('Remove this invoice?')) return;
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    // Unlink any appointments pointing at this invoice first, so they don't get
    // orphaned (or blocked by a foreign key) when the invoice row disappears.
    await client.from('bookings').update({ invoice_id: null }).eq('invoice_id', id);

    const { error } = await client.from('invoices').delete().eq('id', id);
    if (error) {
        alert('Error deleting invoice: ' + error.message);
    } else {
        openFullWidthProfile('household', householdId);
    }
}

// Delete button inside the invoice edit modal itself (uses the currently-open invoice).
async function deleteInvoiceFromModal() {
    if (!editingInvoiceId) return;
    const invoiceId = editingInvoiceId;
    const householdId = invoiceHouseholdId;

    if (!confirm('Are you sure you want to permanently delete this invoice? Linked appointments will remain but become unbilled.')) return;

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    // 1. Unlink any bookings associated with this invoice
    await client.from('bookings').update({ invoice_id: null }).eq('invoice_id', invoiceId);

    // 2. Delete invoice row
    const { error } = await client.from('invoices').delete().eq('id', invoiceId);
    if (error) {
        alert('Error deleting invoice: ' + error.message);
        return;
    }

    closeInvoiceModal();

    if (householdId && typeof openFullWidthProfile === 'function') {
        openFullWidthProfile('household', householdId);
    }
    if (typeof renderInvoicesList === 'function') await renderInvoicesList();
    if (typeof renderActivities === 'function') await renderActivities();
}

function renderHouseholdInvoiceStatusTag(invoiceId, currentStatus, householdId) {
    const options = ['unpaid', 'paid', 'void'];
    return `
        <select onclick="event.stopPropagation();" onchange="event.stopPropagation(); setHouseholdInvoiceStatus('${invoiceId}', this.value, '${householdId}')" style="font-size:0.72rem; padding:0.2rem 0.5rem; border-radius:9999px; border:1px solid var(--border); background:var(--bg-card); cursor:pointer; color:${activityStatusColor(currentStatus)}; text-transform:capitalize;">
            ${options.map(o => `<option value="${o}" ${o === currentStatus ? 'selected' : ''}>${o}</option>`).join('')}
        </select>
    `;
}

async function setHouseholdInvoiceStatus(invoiceId, newStatus, householdId) {
    const client = getSupabase();
    if (!client) return;
    await client.from('invoices').update({ status: newStatus }).eq('id', invoiceId);
    if (newStatus === 'paid') showReceipt(invoiceId);
    openFullWidthProfile('household', householdId);
}

/* Shared payment-method picker — used everywhere an invoice gets marked
   paid, instead of a plain prompt(). Options are built from whichever
   payment methods the business has actually configured in Payment
   Settings, plus generic fallbacks that are always offered. Returns a
   Promise resolving to the chosen method, or null if skipped — marking the
   invoice paid still proceeds either way, this only affects whether a
   method gets recorded. */
let _paymentMethodResolve = null;

async function promptForPaymentMethod() {
    const settings = typeof getBusinessSettings === 'function' ? await getBusinessSettings() : null;
    const options = [];
    if (settings?.venmo_handle) options.push('Venmo');
    if (settings?.zelle_info) options.push('Zelle');
    if (settings?.cash_note) options.push('Cash');
    if (settings?.square_link) options.push('Square');
    ['Card', 'Check', 'Other'].forEach(o => { if (!options.includes(o)) options.push(o); });

    const sel = document.getElementById('mark-paid-method-select');
    if (sel) sel.innerHTML = options.map(o => `<option value="${o}">${o}</option>`).join('');
    document.getElementById('mark-paid-modal')?.classList.remove('hidden');

    return new Promise(resolve => { _paymentMethodResolve = resolve; });
}

function confirmPaymentMethod() {
    const val = document.getElementById('mark-paid-method-select')?.value || null;
    document.getElementById('mark-paid-modal')?.classList.add('hidden');
    if (_paymentMethodResolve) { _paymentMethodResolve(val); _paymentMethodResolve = null; }
}

function cancelPaymentMethod() {
    document.getElementById('mark-paid-modal')?.classList.add('hidden');
    if (_paymentMethodResolve) { _paymentMethodResolve(null); _paymentMethodResolve = null; }
}

async function markInvoicePaid(id, householdId) {
    const client = getSupabase();
    if (!client) return;
    const paymentMethod = await promptForPaymentMethod();
    await client.from('invoices').update({ status: 'paid', paid_date: new Date().toISOString().slice(0, 10), payment_method: paymentMethod }).eq('id', id);
    notifyEmail('payment-received', { invoiceId: id });
    if (typeof showReceipt === 'function') showReceipt(id);
    openFullWidthProfile('household', householdId);
}

/* ==========================================================================
   STAFF MANAGEMENT CONTROLLER
   ========================================================================== */

function initStaffView() {
    if (typeof populateStaffSelects === 'function') {
        populateStaffSelects();
    }
    if (typeof switchStaffTab === 'function') {
        switchStaffTab('roster');
    }
}

async function populateStaffSelects() {
    const client = getSupabase();
    if (!client) return;

    // Fetch real team members from Supabase
    const { data: staff, error } = await client
        .from('staff')
        .select('*')
        .order('name', { ascending: true });

    if (error || !staff || staff.length === 0) return;

    const opts = staff
        .map(s => `<option value="${s.id}">${s.name} · ${s.role}</option>`)
        .join('');

    // Update target modal dropdowns
    const selectIds = ['sav-who', 'asgn-staff', 'stsk-who'];
    selectIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = opts;
    });

    // Update staff task filter menu
    const filterSel = document.getElementById('staff-task-filter');
    if (filterSel) {
        filterSel.innerHTML = '<option value="all">All staff</option>' + opts;
    }

    const actFilterSel = document.getElementById('act-staff-filter');
    if (actFilterSel) {
        actFilterSel.innerHTML = '<option value="all">All Team Members</option>' + opts;
    }
}

async function renderStaffRoster() {
    const el = document.getElementById('staff-roster-list');
    if (!el) return;

    const client = getSupabase();
    if (!client) {
        el.innerHTML = '<div class="biz-empty" style="color:var(--danger-text);">Supabase Client SDK not loaded.</div>';
        return;
    }
   
    // Fetch live rows from Supabase
    const { data: staff, error } = await client
        .from('staff')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Supabase fetch error:', error.message);
        el.innerHTML = `<div class="biz-empty" style="color:var(--danger-text);">Error: ${error.message}</div>`;
        return;
    }

    if (!staff || staff.length === 0) {
        el.innerHTML = '<div class="biz-empty">No staff members in Supabase database yet.</div>';
        return;
    }

    // Which staff already have Google Calendar connected, so the button can
    // reflect actual state instead of always just saying "Connect".
    const { data: connectedTokens } = await client
        .from('staff_oauth_tokens')
        .select('staff_id')
        .eq('provider', 'google');
    const connectedStaffIds = new Set((connectedTokens || []).map(t => t.staff_id));

    // Render cards: clicking opens the full staff profile, matching household/person/pet/vet
    el.innerHTML = staff.map(s => `
        <div class="staff-card">
            <div class="staff-avatar">${s.initials || s.name.slice(0, 2).toUpperCase()}</div>
            <div class="staff-info clickable-profile-zone"
                onclick="switchView('crm-view'); openFullWidthProfile('staff', '${s.id}')"
                title="Click to open ${s.name}"
                style="cursor:pointer;">
                <h4 style="margin:0;">${s.name}</h4>
                <p>${s.role || ''} ${s.contact ? '· ' + s.contact : ''}</p>
                ${s.notes ? `<p style="font-size:0.78rem;color:var(--text-muted);">${s.notes}</p>` : ''}
            </div>
            <div class="staff-actions">
                ${connectedStaffIds.has(s.id)
                    ? `<span style="font-size:0.75rem; color:var(--success-text,#065f46); background:var(--success,#d1fae5); padding:0.25rem 0.6rem; border-radius:999px; font-weight:600; white-space:nowrap;">✓ Calendar Synced</span>`
                    : `<button class="btn" style="font-size:0.78rem; padding:0.35rem 0.7rem; white-space:nowrap;" onclick="event.stopPropagation(); connectGoogleCalendar('${s.id}')"><i data-lucide="calendar-plus" style="width:14px;height:14px;"></i> Connect Calendar</button>`
                }
                <button class="btn-icon" style="background:none; border:none; cursor:pointer; color:var(--danger-text);" onclick="event.stopPropagation(); deleteStaff('${s.id}')" title="Remove"><i data-lucide="trash-2" style="width:16px;height:16px;"></i></button>
            </div>
        </div>
    `).join('');
    refreshIcons();
}

function switchStaffTab(tab) {
    document.querySelectorAll('[id^="stftab-"]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('[id^="stfsec-"]').forEach(s => s.classList.remove('active'));
    
    const targetTab = document.getElementById('stftab-' + tab);
    const targetSec = document.getElementById('stfsec-' + tab);
    
    if (targetTab) targetTab.classList.add('active');
    if (targetSec) targetSec.classList.add('active');
    
    if (tab === 'roster' && typeof renderStaffRoster === 'function') renderStaffRoster();
    if (tab === 'tasks' && typeof renderStaffTasks === 'function') renderStaffTasks();
}

async function openStaffFullView(staffId) {
    const client = getSupabase();
    if (!client) return;

    const { data: staff } = await client.from('staff').select('*').eq('id', staffId).single();
    if (!staff) return;

    const { data: tasks } = await client.from('staff_tasks').select('*').eq('staff_id', staffId);

    const modal = document.getElementById('fullscreen-modal');
    const titleEl = document.getElementById('fs-title');
    const bodyEl = document.getElementById('fs-details-payload');

    if (titleEl) titleEl.textContent = `👤 Staff Profile: ${staff.name}`;

    if (bodyEl) {
        bodyEl.innerHTML = `
            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:1.5rem; padding:1rem 0;">
                <div class="stat-card">
                    <h3>Role & Contact</h3>
                    <p><strong>Role:</strong> ${staff.role}</p>
                    <p><strong>Contact:</strong> ${staff.contact || 'N/A'}</p>
                    <p><strong>Notes:</strong> ${staff.notes || 'None'}</p>
                </div>

                <div class="stat-card">
                    <h3>Assigned Tasks</h3>
                    ${tasks && tasks.length ? tasks.map(t => `
                        <div style="margin-top:0.5rem; padding-top:0.5rem; border-top:1px solid var(--border);">
                            <strong>${t.text || t.task}</strong>
                            <div style="font-size:0.82rem; color:var(--text-muted);">Due: ${t.due || t.due_date || 'Today'}</div>
                        </div>
                    `).join('') : '<p style="color:var(--text-muted);">No assigned tasks.</p>'}
                </div>
            </div>
        `;
    }

    if (modal) modal.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
}

async function openStaffModal(id) {
    editingStaffId = id;
    const titleEl = document.getElementById('staff-modal-title');
    const nameInput = document.getElementById('stf-name');
    const roleSelect = document.getElementById('stf-role');
    const contactInput = document.getElementById('stf-contact');
    const notesInput = document.getElementById('stf-notes');

    let currentStaff = null;

    if (id) {
        if (titleEl) titleEl.textContent = 'Edit Staff Member';
        
        // Fetch existing staff details from Supabase by ID
        const client = getSupabase();
        if (client) {
            const { data: s, error } = await client
                .from('staff')
                .select('*')
                .eq('id', id)
                .single();

            if (!error && s) {
                currentStaff = s;
                if (nameInput) nameInput.value = s.name || '';
                if (roleSelect) roleSelect.value = s.role || 'Trainer';
                if (contactInput) contactInput.value = s.contact || '';
                if (notesInput) notesInput.value = s.notes || '';
            }
        }
    } else {
        if (titleEl) titleEl.textContent = 'Add Staff Member';
        if (nameInput) nameInput.value = '';
        if (roleSelect) roleSelect.value = 'Trainer';
        if (contactInput) contactInput.value = '';
        if (notesInput) notesInput.value = '';
    }

    // Render qualification checkboxes and daily capacity inputs
    if (typeof renderStaffQualEditor === 'function') {
        renderStaffQualEditor(currentStaff);
    }
    
    const modal = document.getElementById('staff-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeStaffModal() {
    const modal = document.getElementById('staff-modal');
    if (modal) modal.classList.add('hidden');
}

async function saveStaffMember() {
    const nameInput = document.getElementById('stf-name');
    const roleSelect = document.getElementById('stf-role');
    const contactInput = document.getElementById('stf-contact');
    const notesInput = document.getElementById('stf-notes');

    const name = nameInput ? nameInput.value.trim() : '';
    const role = roleSelect ? roleSelect.value : 'Trainer';
    const contact = contactInput ? contactInput.value.trim() : '';
    const notes = notesInput ? notesInput.value.trim() : '';

    if (!name) return alert('Please enter a name.');

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

    const payload = {
        name: name,
        role: role,
        contact: contact,
        notes: notes,
        initials: initials
    };

    let response;

    if (editingStaffId) {
        response = await client
            .from('staff')
            .update(payload)
            .eq('id', editingStaffId);
    } else {
        response = await client
            .from('staff')
            .insert([{ ...payload, business_id: currentBusinessId }]);
    }

    if (response.error) {
        alert('Error saving to Supabase: ' + response.error.message);
        console.error('Supabase save error:', response.error);
    } else {
        // Collect local qualification state mapping
        if (typeof serviceTypes !== 'undefined' && typeof staffQualifications !== 'undefined') {
            const savedId = editingStaffId || (response.data && response.data[0] ? response.data[0].id : null);
            if (savedId) {
                staffQualifications[savedId] = serviceTypes
                    .filter(svc => document.getElementById(`qual-chk-${svc.id}`)?.checked)
                    .map(svc => ({
                        serviceId: svc.id,
                        dailyMax: parseInt(document.getElementById(`qual-cap-${svc.id}`)?.value) || 1
                    }));
            }
        }

        editingStaffId = null;
        closeStaffModal();
        if (typeof renderAllDashboards === 'function') await renderAllDashboards();
    }
}

async function deleteStaff(id) {
    if (!confirm('Remove this staff member from Supabase?')) return;

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');
   
    const { error } = await client
        .from('staff')
        .delete()
        .eq('id', id);

    if (error) {
        alert('Error deleting row from Supabase: ' + error.message);
        console.error('Supabase delete error:', error);
    } else {
        if (typeof renderAllDashboards === 'function') await renderAllDashboards();
    }
}

/* ==========================================================================
   STAFF AVAILABILITY MODAL HANDLER
   ========================================================================== */

let editingStaffAvailId = null;
let returnToStaffProfileFromAvail = null;

async function openStaffAvailModal(id, presetStaffId) {
    editingStaffAvailId = id;
    returnToStaffProfileFromAvail = presetStaffId || null;

    if (typeof populateStaffSelects === 'function') {
        await populateStaffSelects();
    }

    const titleEl = document.getElementById('staff-avail-modal-title');
    if (titleEl) {
        titleEl.textContent = id ? 'Edit Time Off' : 'Add Time Off';
    }

    const whoSel = document.getElementById('sav-who');
    const typeSel = document.getElementById('sav-type');
    const startInput = document.getElementById('sav-start');
    const endInput = document.getElementById('sav-end');
    const notesInput = document.getElementById('sav-notes');

    if (id) {
        const client = getSupabase();
        const { data: a } = client ? await client.from('staff_availability').select('*').eq('id', id).single() : { data: null };
        if (a) {
            if (whoSel) whoSel.value = a.staff_id || '';
            if (typeSel) typeSel.value = a.reason || 'vacation';
            if (startInput) startInput.value = a.start_date || '';
            if (endInput) endInput.value = a.end_date || '';
            if (notesInput) notesInput.value = a.notes || '';
        }
    } else {
        if (whoSel && presetStaffId) whoSel.value = presetStaffId;
        if (startInput) startInput.value = '';
        if (endInput) endInput.value = '';
        if (notesInput) notesInput.value = '';
    }

    const modal = document.getElementById('staff-avail-modal');
    if (modal) {
        modal.classList.remove('hidden');
    }
}

async function saveStaffAvail() {
    const staffId = document.getElementById('sav-who')?.value;
    const reason = document.getElementById('sav-type')?.value || 'vacation';
    const start = document.getElementById('sav-start')?.value;
    const end = document.getElementById('sav-end')?.value || start;
    const notes = document.getElementById('sav-notes')?.value.trim() || '';

    if (!staffId || !start) return alert('Please select a staff member and start date.');

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const payload = { staff_id: staffId, reason, start_date: start, end_date: end, notes };
    let response;
    if (editingStaffAvailId) {
        response = await client.from('staff_availability').update(payload).eq('id', editingStaffAvailId);
    } else {
        response = await client.from('staff_availability').insert([{ ...payload, business_id: currentBusinessId }]);
    }

    if (response.error) {
        alert('Failed to save time off: ' + response.error.message);
        return;
    }

    editingStaffAvailId = null;
    closeStaffAvailModal();
    if (returnToStaffProfileFromAvail) {
        const sid = returnToStaffProfileFromAvail;
        returnToStaffProfileFromAvail = null;
        openFullWidthProfile('staff', sid);
    }
}

async function deleteStaffTimeOff(id, staffId) {
    const client = getSupabase();
    if (!client) return;
    await client.from('staff_availability').delete().eq('id', id);
    openFullWidthProfile('staff', staffId);
}

function closeStaffAvailModal() {
    returnToStaffProfileFromAvail = null;
    const modal = document.getElementById('staff-avail-modal');
    if (modal) modal.classList.add('hidden');

    // Reset inputs
    const startInput = document.getElementById('sav-start');
    const endInput = document.getElementById('sav-end');
    const notesInput = document.getElementById('sav-notes');
    if (startInput) startInput.value = '';
    if (endInput) endInput.value = '';
    if (notesInput) notesInput.value = '';
}

/* ==========================================================================
   CROSS-ENTITY RELATIONSHIP MODAL CONTROLLER
   ========================================================================== */

async function openRelationshipModal() {
    const client = getSupabase();
    if (!client) return;

    const { data: households } = await client
        .from('households')
        .select('id, name')
        .order('name');

    const selectA = document.getElementById('modal-entity-a');
    if (selectA && households) {
        selectA.innerHTML = households.map(h => `<option value="${h.id}">${h.name}</option>`).join('');
    }

    await populateTargetDropdown();
    const modal = document.getElementById('relationship-modal');
    if (modal) modal.classList.remove('hidden');
}

async function populateTargetDropdown() {
    const client = getSupabase();
    if (!client) return;

    const typeEl = document.getElementById('modal-relation-type');
    const selectB = document.getElementById('modal-entity-b');
    if (!typeEl || !selectB) return;

    const type = typeEl.value;

    if (type === 'vet') {
        const { data: vets } = await client.from('vets').select('id, name, clinic').order('name');
        selectB.innerHTML = (vets || []).map(v => `<option value="${v.id}">${v.name} (${v.clinic || 'Vet'})</option>`).join('');
    } else {
        const { data: households } = await client.from('households').select('id, name').order('name');
        selectB.innerHTML = (households || []).map(h => `<option value="${h.id}">${h.name}</option>`).join('');
    }
}

function closeRelationshipModal() {
    const modal = document.getElementById('relationship-modal');
    if (modal) modal.classList.add('hidden');
}

function toggleRelationshipFields() {
    populateTargetDropdown();
}

function saveNewRelationship(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (typeof crossRelationships !== 'undefined') {
        crossRelationships.push({
            entityId: document.getElementById('modal-entity-a')?.value,
            targetId: document.getElementById('modal-entity-b')?.value,
            type: document.getElementById('modal-relation-type')?.value,
            note: document.getElementById('modal-relation-note')?.value || 'Linked'
        });
    }
    closeRelationshipModal();
    if (typeof renderAllDashboards === 'function') renderAllDashboards();
}


/* ==========================================================================
   PET ASSIGNMENT MODAL CONTROLLER
   ========================================================================== */

async function renderStaffAssignments() {
    const el = document.getElementById('staff-assignments-list');
    if (!el) return;

    if (typeof populateStaffSelects === 'function') populateStaffSelects();

    const client = getSupabase();
    if (!client) return;

    const { data: assignments } = await client.from('staff_assignments').select('*, staff(name, role), pets(name, species)').order('created_at');

    if (!assignments || !assignments.length) {
        el.innerHTML = '<div class="biz-empty">No pet assignments yet.</div>';
        return;
    }

    const byStaff = {};
    assignments.forEach(a => {
        const key = a.staff?.name || 'Unassigned';
        if (!byStaff[key]) byStaff[key] = { role: a.staff?.role || '', items: [] };
        byStaff[key].items.push(a);
    });

    let html = '';
    Object.keys(byStaff).forEach(staffName => {
        const group = byStaff[staffName];
        html += `<div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-muted);font-weight:700;margin:0.75rem 0 0.35rem;">${staffName}${group.role ? ' · ' + group.role : ''}</div>`;
        group.items.forEach(a => {
            html += `
                <div class="assignment-item" style="display:flex;align-items:center;justify-content:space-between;padding:0.5rem;border-bottom:1px solid var(--border);">
                    <span><i data-lucide="${a.pets?.species === 'cat' ? 'cat' : 'dog'}" style="width:12px;height:12px;"></i> <strong>${a.pets?.name || 'Unknown pet'}</strong>${a.role ? ' (' + a.role + ')' : ''}</span>
                    <button class="btn" style="font-size:0.75rem;padding:0.25rem 0.55rem;color:var(--danger-text);" onclick="removeAssignment('${a.id}')">Remove</button>
                </div>`;
        });
    });
    el.innerHTML = html || '<div class="biz-empty">No assignments yet.</div>';
}

async function openAssignmentModal() {
    if (typeof populateStaffSelects === 'function') populateStaffSelects();
    const petSel = document.getElementById('asgn-pet');
    const client = getSupabase();
    if (petSel && client) {
        const { data: allPets } = await client.from('pets').select('id, name, species').order('name');
        petSel.innerHTML = (allPets || []).map(p => `<option value="${p.id}">${p.name} (${speciesLabel(p)})</option>`).join('');
    }
    const modal = document.getElementById('assignment-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeAssignmentModal() {
    const modal = document.getElementById('assignment-modal');
    if (modal) modal.classList.add('hidden');
}

async function saveAssignment() {
    const staffId = document.getElementById('asgn-staff')?.value;
    const petId = document.getElementById('asgn-pet')?.value;
    const role = document.getElementById('asgn-role')?.value || null;

    if (!staffId || !petId) return alert('Please select a staff member and pet.');

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const { data: existing } = await client.from('staff_assignments').select('id').eq('staff_id', staffId).eq('pet_id', petId).limit(1);
    if (existing && existing.length) {
        return alert('Pet is already assigned to this staff member.');
    }

    const { error } = await client.from('staff_assignments').insert([{ staff_id: staffId, pet_id: petId, role, business_id: currentBusinessId }]);
    if (error) {
        alert('Failed to save assignment: ' + error.message);
        return;
    }

    closeAssignmentModal();
    renderStaffAssignments();
}

async function removeAssignment(id) {
    const client = getSupabase();
    if (!client) return;
    await client.from('staff_assignments').delete().eq('id', id);
    renderStaffAssignments();
}


/* ==========================================================================
   STAFF TASK MODAL CONTROLLER
   ========================================================================== */

let editingStaffTaskId = null;
let editingStaffTaskPetId = null;

async function renderStaffTasks() {
    const el = document.getElementById('staff-tasks-list');
    if (!el) return;

    const filterStaff = document.getElementById('staff-task-filter')?.value || 'all';
    const filterStatus = document.getElementById('staff-task-status-filter')?.value || 'all';

    const client = getSupabase();
    if (!client) return;

    let query = client.from('staff_tasks').select('*, staff(name), pets(name)').order('due_date', { ascending: true });
    if (filterStaff !== 'all') query = query.eq('staff_id', filterStaff);
    if (filterStatus === 'pending') query = query.eq('is_done', false);
    if (filterStatus === 'done') query = query.eq('is_done', true);

    const { data: tasks } = await query;

    if (!tasks || !tasks.length) {
        el.innerHTML = '<div class="biz-empty">No tasks match this filter.</div>';
        return;
    }

    el.innerHTML = tasks.map(t => `
        <div class="staff-task-item ${t.is_done ? 'done' : ''}" style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem;border-bottom:1px solid var(--border);">
            <div>
                <input type="checkbox" ${t.is_done ? 'checked' : ''} onchange="toggleStaffTask('${t.id}', ${!t.is_done})">
                <strong style="${t.is_done ? 'text-decoration:line-through;color:var(--text-muted);' : ''}">${t.task_text}</strong>
                ${t.visible_to_customer ? '<i data-lucide="eye" style="width:12px;height:12px;color:var(--primary); margin-left:0.3rem;" title="Visible to customer"></i>' : ''}
                <span style="font-size:0.78rem;color:var(--text-muted);margin-left:0.5rem;"><i data-lucide="user" style="width:11px;height:11px;"></i> ${t.staff?.name || 'Unassigned'} · Due ${t.due_date || 'no date'}${t.pets?.name ? ' · <i data-lucide="paw-print" style="width:11px;height:11px;"></i> ' + t.pets.name : ''}</span>
            </div>
            <div>
                <button class="btn-icon" style="background:none;border:none;cursor:pointer;padding:0.25rem;" onclick="openStaffTaskModal('${t.id}')" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px;"></i></button>
                <button class="btn-icon" style="background:none;border:none;cursor:pointer;padding:0.25rem;color:var(--danger-text);" onclick="deleteStaffTask('${t.id}')" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
            </div>
        </div>
    `).join('');
    refreshIcons();
}

async function openStaffTaskModalFor(staffId) {
    await openStaffTaskModal(null);
    const whoSel = document.getElementById('stsk-who');
    if (whoSel) whoSel.value = staffId;
    returnToStaffProfile = staffId;
}

async function toggleStaffTaskOnProfile(id, newValue, staffId) {
    const client = getSupabase();
    if (!client) return;
    await client.from('staff_tasks').update({ is_done: newValue }).eq('id', id);
    openFullWidthProfile('staff', staffId);
}

async function deleteStaffTaskOnProfile(id, staffId) {
    const client = getSupabase();
    if (!client) return;
    await client.from('staff_tasks').delete().eq('id', id);
    openFullWidthProfile('staff', staffId);
}

/* Opening/editing a task from a pet's profile — mirrors the staff-profile flow above,
   but returns to the pet profile afterward and pre-links the task to that pet. */
let returnToPetProfile = null;

async function openStaffTaskModalForPet(petId, petName) {
    await openStaffTaskModal(null);
    selectPetForTask(petId, petName);
    returnToPetProfile = petId;
}

async function openStaffTaskModalFromPet(taskId, petId) {
    await openStaffTaskModal(taskId);
    returnToPetProfile = petId;
}

async function toggleStaffTaskOnPetProfile(id, newValue, petId) {
    const client = getSupabase();
    if (!client) return;
    await client.from('staff_tasks').update({ is_done: newValue }).eq('id', id);
    openFullWidthProfile('pet', petId);
}

async function deleteStaffTaskOnPetProfile(id, petId) {
    const client = getSupabase();
    if (!client) return;
    await client.from('staff_tasks').delete().eq('id', id);
    openFullWidthProfile('pet', petId);
}

let returnToStaffProfile = null;

async function openStaffTaskModal(id) {
    editingStaffTaskId = id;
    editingStaffTaskPetId = null;
    if (typeof populateStaffSelects === 'function') await populateStaffSelects();

    const titleEl = document.getElementById('staff-task-modal-title');
    if (titleEl) titleEl.textContent = id ? 'Edit Task' : 'Add Task';

    const whoSel = document.getElementById('stsk-who');
    const textInput = document.getElementById('stsk-text');
    const dueInput = document.getElementById('stsk-due');
    const prioritySel = document.getElementById('stsk-priority');
    const petSearchInput = document.getElementById('stsk-pet-search');

    if (petSearchInput) petSearchInput.value = '';
    document.getElementById('stsk-pet-search-results').innerHTML = '';
    document.getElementById('stsk-pet-selected')?.classList.add('hidden');
    const visibleChk = document.getElementById('stsk-visible-customer');

    if (id) {
        const client = getSupabase();
        const { data: t } = client ? await client.from('staff_tasks').select('*, pets(name)').eq('id', id).single() : { data: null };
        if (t) {
            if (whoSel) whoSel.value = t.staff_id || '';
            if (textInput) textInput.value = t.task_text || '';
            if (dueInput) dueInput.value = t.due_date || '';
            if (prioritySel) prioritySel.value = t.priority || 'normal';
            if (visibleChk) visibleChk.checked = !!t.visible_to_customer;
            if (t.pet_id) selectPetForTask(t.pet_id, t.pets?.name || 'Pet');
        }
    } else {
        if (textInput) textInput.value = '';
        if (dueInput) dueInput.value = '';
        if (prioritySel) prioritySel.value = 'normal';
        if (visibleChk) visibleChk.checked = false;
    }

    const modal = document.getElementById('staff-task-modal');
    if (modal) modal.classList.remove('hidden');
}

/* Task-to-pet linking — a task can optionally reference a specific pet (unlike resources, which
   are event-level and never pet-specific). Search is global since staff tasks aren't scoped to
   a single household. */
async function searchPetsForTask(query) {
    const container = document.getElementById('stsk-pet-search-results');
    if (!container) return;

    const client = getSupabase();
    if (!client) return;

    const q = (query || '').trim();
    let dbQuery = client.from('pets').select('id, name, species, households(name)').order('name').limit(15);
    if (q) dbQuery = dbQuery.or(`name.ilike.%${q}%,species.ilike.%${q}%`);
    const { data: pets } = await dbQuery;

    container.innerHTML = (pets && pets.length) ? pets.map(p => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.35rem 0.5rem; border:1px solid var(--border); border-radius:0.25rem; background:var(--bg-card); font-size:0.82rem; cursor:pointer;" onclick="selectPetForTask('${p.id}', '${p.name.replace(/'/g, "\\'")}')">
            <span><strong>${p.name}</strong> (${p.species}) ${p.households?.name ? '· ' + p.households.name : ''}</span>
            <button type="button" class="btn btn-primary" style="font-size:0.7rem; padding:0.15rem 0.45rem;">Select</button>
        </div>
    `).join('') : '<div style="font-size:0.8rem; color:var(--text-muted); padding:0.3rem;">No matching pets found.</div>';
}

function selectPetForTask(petId, petName) {
    editingStaffTaskPetId = petId;
    const selected = document.getElementById('stsk-pet-selected');
    const label = document.getElementById('stsk-pet-selected-label');
    if (label) label.textContent = petName;
    if (selected) selected.classList.remove('hidden');

    const searchInput = document.getElementById('stsk-pet-search');
    if (searchInput) searchInput.value = '';
    document.getElementById('stsk-pet-search-results').innerHTML = '';
}

function clearTaskPetSelection() {
    editingStaffTaskPetId = null;
    document.getElementById('stsk-pet-selected')?.classList.add('hidden');
}

function closeStaffTaskModal() {
    returnToStaffProfile = null;
    returnToPetProfile = null;
    editingStaffTaskPetId = null;
    const modal = document.getElementById('staff-task-modal');
    if (modal) modal.classList.add('hidden');
}

async function saveStaffTask() {
    const staffId = document.getElementById('stsk-who')?.value || null;
    const text = document.getElementById('stsk-text')?.value.trim();
    const due = document.getElementById('stsk-due')?.value || null;
    const priority = document.getElementById('stsk-priority')?.value || 'normal';
    const visibleToCustomer = document.getElementById('stsk-visible-customer')?.checked || false;

    if (!text) return alert('Please enter a task description.');

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const payload = { staff_id: staffId, task_text: text, due_date: due, priority, pet_id: editingStaffTaskPetId, visible_to_customer: visibleToCustomer };
    let response;
    if (editingStaffTaskId) {
        response = await client.from('staff_tasks').update(payload).eq('id', editingStaffTaskId);
    } else {
        response = await client.from('staff_tasks').insert([{ ...payload, is_done: false, business_id: currentBusinessId }]);
    }

    if (response.error) {
        alert('Failed to save task: ' + response.error.message);
        return;
    }

    editingStaffTaskId = null;
    editingStaffTaskPetId = null;
    // Capture these before closeStaffTaskModal() clears them
    const returnStaffId = returnToStaffProfile;
    const returnPetId = returnToPetProfile;
    closeStaffTaskModal();
    if (returnStaffId) {
        openFullWidthProfile('staff', returnStaffId);
    } else if (returnPetId) {
        openFullWidthProfile('pet', returnPetId);
    } else {
        renderStaffTasks();
    }
}

async function toggleStaffTask(id, newValue) {
    const client = getSupabase();
    if (!client) return;
    await client.from('staff_tasks').update({ is_done: newValue }).eq('id', id);
    renderStaffTasks();
}

async function deleteStaffTask(id) {
    const client = getSupabase();
    if (!client) return;
    await client.from('staff_tasks').delete().eq('id', id);
    renderStaffTasks();
}

/* ==========================================================================
   RESOURCE GRID & CALENDAR SUB-TAB CONTROLLER
   ========================================================================== */

let calWeekOffset = 0;
let pendingCalendarDate = null;

function shiftCalWeek(delta) {
    calWeekOffset += delta;
    renderCalendar();
}

function resetCalWeek() {
    calWeekOffset = 0;
    renderCalendar();
}

function getCalWeekDates() {
    const today = new Date();
    const sunday = new Date(today);
    sunday.setDate(today.getDate() - today.getDay() + calWeekOffset * 7);
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(sunday);
        d.setDate(sunday.getDate() + i);
        dates.push(d);
    }
    return dates;
}

async function renderCalendar() {
    const thead = document.getElementById('cal-thead');
    const tbody = document.getElementById('calendar-body-target');
    const weekLabel = document.getElementById('cal-week-label');
    if (!thead || !tbody) return;

    const client = getSupabase();
    if (!client) return;

    const dates = getCalWeekDates();
    const fmt = d => d.toISOString().slice(0, 10);
    const start = fmt(dates[0]);
    const end = fmt(dates[6]);

    if (weekLabel) weekLabel.textContent = `${start} — ${end}`;

    const { data: rawBookings } = await client.from('bookings').select('*, pets(name), households(name)')
        .neq('status', 'cancelled')
        .lte('check_in', end + 'T23:59:59').gte('check_out', start + 'T00:00:00');
    const bookings = await attachResourceNames(client, rawBookings || []);

    thead.innerHTML = `<tr>${dates.map(d => `<th>${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</th>`).join('')}</tr>`;

    const byDay = {};
    dates.forEach(d => { byDay[fmt(d)] = []; });
    (bookings || []).forEach(bk => {
        const bkStart = (bk.check_in || '').slice(0, 10);
        const bkEnd = (bk.check_out || bk.check_in || '').slice(0, 10);
        Object.keys(byDay).forEach(key => {
            if (key >= bkStart && key <= bkEnd) byDay[key].push(bk);
        });
    });

    const dayStatus = await computeCalendarDayStatuses(dates);
    const statusBg = { closed: '#e5e7eb', 'staff-full': '#fecaca', 'resource-full': '#fef08a' };
    const todayKey = fmt(new Date());

    tbody.innerHTML = `<tr>${dates.map(d => {
        const key = fmt(d);
        const dayBookings = byDay[key].slice().sort((a, b) => (a.check_in || '').localeCompare(b.check_in || ''));
        const s = dayStatus[key];
        const bg = s?.level ? statusBg[s.level] : '';
        const title = s?.level === 'closed' ? 'Business closed' : s?.level === 'staff-full' ? 'All staff booked' : s?.level === 'resource-full' ? `Closed to: ${s.fullTypes.join(', ')}` : '';
        const todayOutline = key === todayKey ? 'box-shadow: inset 0 0 0 2px #2563eb;' : '';
        
        return `
            <td style="vertical-align:top; padding:0.5rem; border:1px solid var(--border); min-width:140px; ${bg ? 'background:' + bg + ';' : ''} ${todayOutline}" title="${key === todayKey ? 'Today. ' : ''}${title}">
                ${dayBookings.map(bk => {
                    const icon = (bk.service_name || '').toLowerCase().includes('train') ? 'dumbbell' : 'bed-double';
                    const petName = bk.pets?.name || 'Pet';
                    
                    return `
                        <div style="padding:0.35rem 0.45rem; margin-bottom:0.3rem; border-radius:0.25rem; background:var(--bg-hover,#f1f5f9); font-size:0.75rem; cursor:pointer; border:1px solid var(--border);" onclick="openBookingModal('${bk.household_id}', '${bk.id}')">
                            <div style="display:flex; align-items:center; gap:0.35rem; font-weight:600;">
                                <i data-lucide="${icon}" style="width:13px; height:13px; color:var(--primary,#2563eb);"></i>
                                <span>${petName}</span>
                            </div>
                            <div style="font-size:0.7rem; color:var(--text-muted); margin-top:0.15rem;">
                                ${bk.resources?.name ? bk.resources.name : (bk.service_name || '')}
                            </div>
                        </div>
                    `;
                }).join('')}
                <button class="btn" style="width:100%; font-size:0.72rem; padding:0.3rem; border:1px dashed var(--border);" onclick="scheduleFromCalendar('${key}')">+ Schedule</button>
            </td>
        `;
    }).join('')}</tr>`;

    refreshIcons();
}

function scheduleFromCalendar(dateStr) {
    openQuickScheduleModal(dateStr);
    setQuickScheduleType('appointment');
}

function switchCalTab(tab) {
    document.querySelectorAll('[id^="caltab-"]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('[id^="calsec-"]').forEach(s => s.classList.remove('active'));
    
    const targetTab = document.getElementById('caltab-' + tab);
    const targetSec = document.getElementById('calsec-' + tab);
    
    if (targetTab) targetTab.classList.add('active');
    if (targetSec) targetSec.classList.add('active');
    
    if (tab === 'grid' && typeof renderCalendar === 'function') {
        renderCalendar();
    }
    if (tab === 'resources' && typeof renderResourceList === 'function') {
        renderResourceList();
    }
}

async function renderResourceList() {
    const el = document.getElementById('resource-list');
    if (!el) return;

    const client = getSupabase();
    if (!client) return;

    const { data: list } = await client.from('resources').select('*').order('type').order('name');

    if (!list || !list.length) {
        el.innerHTML = '<div class="biz-empty">No resource spaces yet.</div>';
        return;
    }

    // Group resources by "Type"
    const grouped = {};
    list.forEach(r => {
        const typeKey = r.type || 'Uncategorized';
        if (!grouped[typeKey]) grouped[typeKey] = [];
        grouped[typeKey].push(r);
    });

    let html = '';
    Object.keys(grouped).forEach(type => {
        html += `<div style="font-size:0.8rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted); margin:1.25rem 0 0.5rem 0;">${type} (${grouped[type].length})</div>`;
        
        grouped[type].forEach(r => {
            html += `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:0.65rem 0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-card); margin-bottom:0.5rem;">
                    <div style="cursor:pointer; flex:1;" onclick="openResourceModal('${r.id}')">
                        <strong style="font-size:0.9rem;">${r.name}</strong>
                        <span style="font-size:0.75rem; color:var(--text-muted); margin-left:0.5rem;">
                            ${(r.seats || 1) > 1 ? (r.seats || 1) + ' seats' : '1 seat'} · ${r.default_mode === 'time_based' ? 'Time-based' : 'All day'}
                        </span>
                        ${r.notes ? `<div style="font-size:0.75rem; color:var(--text-muted); margin-top:0.15rem;">${r.notes}</div>` : ''}
                    </div>
                    <div style="display:flex; gap:0.25rem; align-items:center;">
                        <button class="btn-icon" style="background:none; border:none; cursor:pointer; padding:0.25rem; color:var(--text-muted);" onclick="event.stopPropagation(); cloneResource('${r.id}')" title="Duplicate resource">
                            <i data-lucide="copy" style="width:14px; height:14px;"></i>
                        </button>
                        <button class="btn-icon" style="background:none; border:none; cursor:pointer; padding:0.25rem; color:var(--danger-text);" onclick="event.stopPropagation(); deleteResource('${r.id}')" title="Delete resource">
                            <i data-lucide="trash-2" style="width:14px; height:14px;"></i>
                        </button>
                    </div>
                </div>
            `;
        });
    });

    el.innerHTML = html;
    refreshIcons();
}

/** Duplicates an existing resource/kennel with a cloned name prefix */
async function cloneResource(id) {
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const { data: source } = await client.from('resources').select('*').eq('id', id).single();
    if (!source) return alert('Resource not found.');

    const userEnteredName = prompt('Enter name for cloned resource:', `${source.name} (Copy)`);
    if (!userEnteredName) return;

    // Apply zero padding to user input
    const paddedName = padSingleDigitResourceName(userEnteredName.trim());

    const payload = {
        name: paddedName,
        type: source.type,
        default_mode: source.default_mode,
        seats: source.seats,
        notes: source.notes,
        blackouts: source.blackouts || []
    };

    const { error } = await client.from('resources').insert([{ ...payload, business_id: currentBusinessId }]);
    if (error) {
        alert('Failed to clone resource: ' + error.message);
    } else {
        renderResourceList();
    }
}

let editingResourceId = null;

async function openResourceModal(id = null) {
    editingResourceId = id;
    let r = null;

    const client = getSupabase();
    if (id) {
        const { data } = client ? await client.from('resources').select('*').eq('id', id).single() : { data: null };
        r = data;
    }

    const titleEl = document.getElementById('resource-modal-title');
    if (titleEl) titleEl.textContent = r ? 'Edit Resource' : 'Add Resource';

    const nameInput = document.getElementById('rm-name');
    const typeSelect = document.getElementById('rm-type');
    const modeSelect = document.getElementById('rm-default-mode');
    const seatsInput = document.getElementById('rm-seats');
    const blackoutsArea = document.getElementById('rm-blackouts');
    const notesInput = document.getElementById('rm-notes');

    // Suggest existing resource types so people can reuse them, but the field stays free-text
    // so a brand-new type can always be added here directly.
    if (client) {
        const { data: resourceRows } = await client.from('resources').select('type');
        const types = Array.from(new Set((resourceRows || []).map(row => row.type).filter(Boolean))).sort();
        const datalist = document.getElementById('rm-type-options');
        if (datalist) datalist.innerHTML = types.map(ty => `<option value="${ty.replace(/"/g, '&quot;')}"></option>`).join('');
    }

    if (nameInput) nameInput.value = r ? r.name : '';
    if (typeSelect) typeSelect.value = r ? r.type : '';
    if (modeSelect) modeSelect.value = r?.default_mode || 'all_day';
    if (seatsInput) seatsInput.value = r?.seats !== undefined && r?.seats !== null ? r.seats : 1;
    if (blackoutsArea) blackoutsArea.value = r && r.blackouts ? r.blackouts.join('\n') : '';
    if (notesInput) notesInput.value = r ? r.notes || '' : '';

    const modal = document.getElementById('resource-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeResourceModal() {
    const modal = document.getElementById('resource-modal');
    if (modal) modal.classList.add('hidden');
}

async function saveResource(e) {
    if (e) e.preventDefault();

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const nameInput = document.getElementById('rm-name');
    const typeSelect = document.getElementById('rm-type');
    const modeSelect = document.getElementById('rm-default-mode');
    const seatsInput = document.getElementById('rm-seats');
    const blackoutsArea = document.getElementById('rm-blackouts');
    const notesInput = document.getElementById('rm-notes');

    const rawName = nameInput?.value || '';
    if (!rawName.trim()) return alert('Resource name is required.');

    const resourceType = (typeSelect?.value || '').trim();
    if (!resourceType) return alert('Resource type is required.');

    // Auto-pad single-digit numbers (e.g. Kennel 1 -> Kennel 01)
    const paddedName = typeof padSingleDigitResourceName === 'function' 
        ? padSingleDigitResourceName(rawName.trim()) 
        : rawName.trim();

    const seatsVal = parseInt(seatsInput?.value, 10);
    const parsedSeats = isNaN(seatsVal) ? 1 : seatsVal;

    const blackouts = blackoutsArea?.value 
        ? blackoutsArea.value.split('\n').map(s => s.trim()).filter(Boolean) 
        : [];

    const payload = {
        name: paddedName,
        type: resourceType,
        default_mode: modeSelect?.value || 'all_day',
        seats: parsedSeats,
        blackouts: blackouts,
        notes: notesInput?.value?.trim() || ''
    };

    let error;
    if (editingResourceId) {
        ({ error } = await client.from('resources').update(payload).eq('id', editingResourceId));
    } else {
        ({ error } = await client.from('resources').insert([{ ...payload, business_id: currentBusinessId }]));
    }

    if (error) {
        alert('Failed to save resource: ' + error.message);
    } else {
        editingResourceId = null;
        
        // Use your existing modal closing function
        if (typeof closeResourceModal === 'function') {
            closeResourceModal();
        } else {
            document.getElementById('resource-modal')?.classList.add('hidden');
        }

        if (typeof renderResourceList === 'function') {
            await renderResourceList();
        }
    }
}

async function deleteResource(id) {
    if (!confirm('Remove this resource space?')) return;

    const client = getSupabase();
    if (!client) return;
    await client.from('resources').delete().eq('id', id);

    renderResourceList();
}

/* ==========================================================================
   BUSINESS MANAGEMENT & CLOSURES CONTROLLER
   ========================================================================== */

function switchBizTab(tab) {
    document.querySelectorAll('.biz-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.biz-section').forEach(s => s.classList.remove('active'));
    
    const targetTab = document.getElementById('biztab-' + tab);
    const targetSec = document.getElementById('bizsec-' + tab);
    
    if (targetTab) targetTab.classList.add('active');
    if (targetSec) targetSec.classList.add('active');
    
    if (tab === 'dashboard' && typeof renderBizDashboard === 'function') {
        renderBizDashboard();
    }
    if (tab === 'availability' && typeof renderAvailabilityList === 'function') {
        renderAvailabilityList();
        if (typeof loadBusinessHours === 'function') loadBusinessHours();
    }
    if (tab === 'invoices' && typeof renderInvoicesList === 'function') {
        renderInvoicesList();
    }
    if (tab === 'business-settings') {
        if (typeof loadPublicBookingSettings === 'function') loadPublicBookingSettings();
        if (typeof loadBusinessPaymentSettings === 'function') loadBusinessPaymentSettings();
        if (typeof loadEmailSettings === 'function') loadEmailSettings();
    }
}

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function loadBusinessHours() {
    const client = getSupabase();
    if (!client) return;

    const { data: hours } = await client.from('business_hours').select('*').eq('business_id', currentBusinessId);
    const byDay = {};
    (hours || []).forEach(h => { byDay[h.day_of_week] = h; });

    const container = document.getElementById('hours-rows');
    if (!container) return;

    container.innerHTML = DAYS_OF_WEEK.map((dayName, i) => {
        const h = byDay[i];
        const isClosed = h ? h.is_closed : (i === 0); // default: closed Sundays, open other days, for a brand-new business with no rows yet
        const openVal = h?.open_time ? h.open_time.slice(0, 5) : '09:00';
        const closeVal = h?.close_time ? h.close_time.slice(0, 5) : '17:00';
        return `
            <div style="display:flex; align-items:center; gap:0.75rem;">
                <span style="width:90px; font-size:0.85rem; font-weight:600;">${dayName}</span>
                <label style="display:flex; align-items:center; gap:0.35rem; font-size:0.8rem; font-weight:400; width:80px;">
                    <input type="checkbox" class="hours-closed-chk" data-day="${i}" ${isClosed ? 'checked' : ''} onchange="toggleHoursRowClosed(${i})"> Closed
                </label>
                <input type="time" class="hours-open" data-day="${i}" value="${openVal}" ${isClosed ? 'disabled' : ''} style="padding:0.4rem; border:1px solid var(--border); border-radius:0.25rem;">
                <span style="color:var(--text-muted); font-size:0.8rem;">to</span>
                <input type="time" class="hours-close" data-day="${i}" value="${closeVal}" ${isClosed ? 'disabled' : ''} style="padding:0.4rem; border:1px solid var(--border); border-radius:0.25rem;">
            </div>
        `;
    }).join('');
}

function toggleHoursRowClosed(day) {
    const closed = document.querySelector(`.hours-closed-chk[data-day="${day}"]`)?.checked;
    document.querySelectorAll(`.hours-open[data-day="${day}"], .hours-close[data-day="${day}"]`).forEach(el => {
        el.disabled = closed;
    });
}

async function saveBusinessHours() {
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const rows = DAYS_OF_WEEK.map((_, i) => ({
        business_id: currentBusinessId,
        day_of_week: i,
        is_closed: document.querySelector(`.hours-closed-chk[data-day="${i}"]`)?.checked || false,
        open_time: document.querySelector(`.hours-open[data-day="${i}"]`)?.value || null,
        close_time: document.querySelector(`.hours-close[data-day="${i}"]`)?.value || null,
    }));

    const { error } = await client.from('business_hours').upsert(rows, { onConflict: 'business_id,day_of_week' });
    if (error) return alert('Failed to save: ' + error.message);
    alert('Hours saved.');
}

function bizDateRange() {
    const preset = document.getElementById('biz-date-preset')?.value || 'mtd';
    const today = new Date();
    let from, to;
    to = today.toISOString().slice(0, 10);

    if (preset === 'custom') {
        from = document.getElementById('biz-date-from')?.value || '';
        to = document.getElementById('biz-date-to')?.value || to;
    } else if (preset === 'last30') {
        const d = new Date(today); d.setDate(d.getDate() - 30);
        from = d.toISOString().slice(0, 10);
    } else if (preset === 'last90') {
        const d = new Date(today); d.setDate(d.getDate() - 90);
        from = d.toISOString().slice(0, 10);
    } else if (preset === 'ytd') {
        from = `${today.getFullYear()}-01-01`;
    } else {
        from = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    }
    return { from, to };
}

async function renderBizDashboard() {
    const client = getSupabase();
    if (!client) return;

    const { from, to } = bizDateRange();
    const labelEl = document.getElementById('biz-date-range-label');
    if (labelEl) labelEl.textContent = from ? `${from} to ${to}` : '';

    const { data: invoices } = await client.from('invoices').select('*').gte('created_at', from ? from + 'T00:00:00' : '1970-01-01').lte('created_at', to + 'T23:59:59');
    const { data: bookings } = await client.from('bookings').select('*, staff:assigned_staff_id(name)').gte('check_in', from ? from + 'T00:00:00' : '1970-01-01').lte('check_in', to + 'T23:59:59');

    const paidInvoices = (invoices || []).filter(i => i.status === 'paid');
    const grossRevenue = paidInvoices.reduce((sum, i) => sum + Number(i.amount || 0), 0);

    const householdsWithInvoice = new Set((invoices || []).map(i => i.household_id).filter(Boolean));
    const ltv = householdsWithInvoice.size ? grossRevenue / householdsWithInvoice.size : 0;

    const bookingCountByHousehold = {};
    (bookings || []).forEach(bk => {
        if (!bk.household_id) return;
        bookingCountByHousehold[bk.household_id] = (bookingCountByHousehold[bk.household_id] || 0) + 1;
    });
    const totalHouseholds = Object.keys(bookingCountByHousehold).length;
    const returningHouseholds = Object.values(bookingCountByHousehold).filter(c => c >= 2).length;
    const retention = totalHouseholds ? (returningHouseholds / totalHouseholds) * 100 : 0;

    const revenueByStaff = {};
    (bookings || []).forEach(bk => {
        const name = bk.staff?.name || 'Unassigned';
        revenueByStaff[name] = (revenueByStaff[name] || 0) + Number(bk.amount || 0);
    });
    const topStaffEntry = Object.entries(revenueByStaff).sort((a, b) => b[1] - a[1])[0];

    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    setText('biz-stat-revenue', `$${grossRevenue.toFixed(2)}`);
    setText('biz-stat-ltv', `$${ltv.toFixed(2)}`);
    setText('biz-stat-retention', `${retention.toFixed(0)}%`);
    setText('biz-stat-packages', String((bookings || []).length));
    setText('biz-stat-staff-rev', topStaffEntry ? `${topStaffEntry[0]}: $${topStaffEntry[1].toFixed(2)}` : '—');
    setText('biz-stat-staff-ret', '—');

    window.__bizDashboardCache = { invoices: invoices || [], bookings: bookings || [], revenueByStaff };
}

function openBizDetail(kind) {
    const panel = document.getElementById('biz-detail-panel');
    const title = document.getElementById('biz-detail-title');
    const body = document.getElementById('biz-detail-body');
    if (!panel || !body) return;

    const cache = window.__bizDashboardCache || { invoices: [], bookings: [], revenueByStaff: {} };
    let html = '';
    let heading = 'Detail';

    if (kind === 'revenue') {
        heading = 'Paid Invoices';
        const paid = cache.invoices.filter(i => i.status === 'paid');
        html = paid.length ? paid.map(i => `
            <div style="display:flex; justify-content:space-between; padding:0.5rem; border-bottom:1px solid var(--border);">
                <span>${i.description || 'Invoice'}</span><span>$${Number(i.amount || 0).toFixed(2)} · ${i.due_date || ''}</span>
            </div>`).join('') : '<div class="biz-empty">No paid invoices in this range.</div>';
    } else if (kind === 'ltv' || kind === 'retention') {
        heading = kind === 'ltv' ? 'Revenue by Household' : 'Bookings by Household';
        const byHousehold = {};
        (kind === 'ltv' ? cache.invoices : cache.bookings).forEach(item => {
            const hid = item.household_id;
            if (!hid) return;
            byHousehold[hid] = (byHousehold[hid] || 0) + (kind === 'ltv' ? Number(item.amount || 0) : 1);
        });
        const entries = Object.entries(byHousehold);
        html = entries.length ? entries.map(([hid, val]) => `
            <div style="display:flex; justify-content:space-between; padding:0.5rem; border-bottom:1px solid var(--border); cursor:pointer;" onclick="switchView('crm-view'); openFullWidthProfile('household', '${hid}')">
                <span>Household ${hid.slice(0, 8)}…</span><span>${kind === 'ltv' ? '$' + val.toFixed(2) : val + ' booking(s)'}</span>
            </div>`).join('') : '<div class="biz-empty">No data in this range.</div>';
    } else if (kind === 'staff-revenue' || kind === 'staff-retention') {
        heading = 'Revenue by Staff';
        const entries = Object.entries(cache.revenueByStaff).sort((a, b) => b[1] - a[1]);
        html = entries.length ? entries.map(([name, val]) => `
            <div style="display:flex; justify-content:space-between; padding:0.5rem; border-bottom:1px solid var(--border);">
                <span>${name}</span><span>$${val.toFixed(2)}</span>
            </div>`).join('') : '<div class="biz-empty">No staff-linked bookings in this range.</div>';
    } else if (kind === 'packages') {
        heading = 'Scheduled Events';
        html = cache.bookings.length ? cache.bookings.map(bk => `
            <div style="display:flex; justify-content:space-between; padding:0.5rem; border-bottom:1px solid var(--border);">
                <span>${bk.service_name || 'Event'}</span><span>${(bk.check_in || '').slice(0, 10)} · ${bk.status || 'pending'}</span>
            </div>`).join('') : '<div class="biz-empty">No events in this range.</div>';
    }

    if (title) title.textContent = heading;
    body.innerHTML = html;
    panel.classList.remove('hidden');
}

function closeBizDetail() {
    const panel = document.getElementById('biz-detail-panel');
    if (panel) panel.classList.add('hidden');
}

function onBizPresetChange() {
    const presetSelect = document.getElementById('biz-date-preset');
    if (!presetSelect) return;

    if (typeof bizDatePreset !== 'undefined') {
        bizDatePreset = presetSelect.value;
    }

    const customDiv = document.getElementById('biz-custom-dates');
    if (customDiv) {
        customDiv.style.display = (presetSelect.value === 'custom') ? 'flex' : 'none';
    }

    if (typeof renderBizDashboard === 'function') {
        renderBizDashboard();
    }
}

let editingClosureId = null;

async function renderInvoicesList() {
    const el = document.getElementById('biz-invoices-list');
    if (!el) return;

    const client = getSupabase();
    if (!client) return;

    const statusFilter = document.getElementById('biz-invoice-status-filter')?.value || 'all';
    const query = document.getElementById('biz-invoice-search')?.value.trim().toLowerCase() || '';

    let dbQuery = client.from('invoices').select('*, households(name)').order('due_date', { ascending: true });
    if (statusFilter !== 'all') dbQuery = dbQuery.eq('status', statusFilter);

    const { data: invoices } = await dbQuery;
    let list = invoices || [];
    if (query) {
        list = list.filter(i =>
            (i.description || '').toLowerCase().includes(query) ||
            (i.households?.name || '').toLowerCase().includes(query)
        );
    }

    if (!list.length) {
        el.innerHTML = '<div class="biz-empty">No invoices match this filter.</div>';
        return;
    }

    el.innerHTML = list.map(i => {
        return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-card);">
                <div style="cursor:pointer;" onclick="switchView('crm-view'); openFullWidthProfile('household', '${i.household_id}')">
                    <strong>${i.description || 'Invoice'}</strong>
                    <span style="margin-left:0.4rem;">${renderStatusTag('invoice', i.id, i.status || 'unpaid', 'setBizInvoiceStatus')}</span>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.2rem;">${i.households?.name || 'Unknown household'} ${i.due_date ? '· Due ' + i.due_date : ''}</div>
                </div>
                <div style="display:flex; align-items:center; gap:0.6rem;">
                    <button class="btn-icon" style="background:none; border:none; cursor:pointer;" onclick="event.stopPropagation(); ${i.status === 'paid' ? `showReceipt('${i.id}')` : `showPaymentNotice('${i.id}')`}" title="${i.status === 'paid' ? 'View receipt' : 'View payment notice'}"><i data-lucide="file-text" style="width:15px;height:15px;"></i></button>
                    <div style="font-weight:600;">$${Number(i.amount || 0).toFixed(2)}</div>
                </div>
            </div>
        `;
    }).join('');
    refreshIcons();
}

async function setBizInvoiceStatus(kind, id, newStatus) {
    const client = getSupabase();
    if (!client) return;
    const payload = { status: newStatus };
    if (newStatus === 'paid') {
        payload.paid_date = new Date().toISOString().slice(0, 10);
        payload.payment_method = await promptForPaymentMethod();
    }
    await client.from('invoices').update(payload).eq('id', id);
    if (newStatus === 'paid') {
        showReceipt(id);
        notifyEmail('payment-received', { invoiceId: id });
    }
    renderInvoicesList();
}

async function renderAvailabilityList() {
    const el = document.getElementById('availability-list');
    if (!el) return;

    const client = getSupabase();
    if (!client) return;

    const { data: closures } = await client.from('business_closures').select('*').order('start_date');

    if (!closures || !closures.length) {
        el.innerHTML = '<div class="biz-empty">No business closures scheduled.</div>';
        return;
    }

    el.innerHTML = closures.map(c => {
        const span = !c.end_date || c.end_date === c.start_date ? c.start_date : `${c.start_date} → ${c.end_date}`;
        return `
            <div class="closure-item type-${c.closure_type}" style="display:flex;align-items:center;justify-content:space-between;padding:0.75rem;border:1px solid var(--border);border-radius:0.375rem;">
                <div class="closure-info">
                    <h4 style="margin:0;">${c.label || 'Closure'}</h4>
                    <p style="margin:0;font-size:0.8rem;color:var(--text-muted);">${span} ${c.notes ? '· ' + c.notes : ''}</p>
                </div>
                <div style="display:flex;gap:0.4rem;align-items:center;">
                    <span class="closure-type-pill ${c.closure_type}" style="font-size:0.72rem;padding:0.15rem 0.5rem;border-radius:9999px;font-weight:600;">${c.closure_type === 'closure' ? 'Closed' : c.closure_type === 'reduced' ? 'Reduced' : 'Holiday'}</span>
                    <button class="btn-icon" style="background:none;border:none;cursor:pointer;padding:0.25rem;" onclick="openAvailabilityModal('${c.id}')" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px;"></i></button>
                    <button class="btn-icon" style="background:none;border:none;cursor:pointer;padding:0.25rem;color:var(--danger-text);" onclick="deleteClosure('${c.id}')" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
                </div>
            </div>`;
    }).join('');
}

async function openAvailabilityModal(id) {
    editingClosureId = id;
    let c = null;
    if (id) {
        const client = getSupabase();
        const { data } = client ? await client.from('business_closures').select('*').eq('id', id).single() : { data: null };
        c = data;
    }

    const titleEl = document.getElementById('avail-modal-title');
    if (titleEl) titleEl.textContent = c ? 'Edit Closure' : 'Add Closure';

    const labelInput = document.getElementById('av-label');
    const typeSelect = document.getElementById('av-type');
    const startInput = document.getElementById('av-start');
    const endInput = document.getElementById('av-end');
    const notesInput = document.getElementById('av-notes');

    if (labelInput) labelInput.value = c ? c.label || '' : '';
    if (typeSelect) typeSelect.value = c ? c.closure_type : 'closure';
    if (startInput) startInput.value = c ? c.start_date || '' : '';
    if (endInput) endInput.value = c ? c.end_date || '' : '';
    if (notesInput) notesInput.value = c ? c.notes || '' : '';

    const modal = document.getElementById('availability-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeAvailabilityModal() {
    const modal = document.getElementById('availability-modal');
    if (modal) modal.classList.add('hidden');
}

async function saveAvailability() {
    const label = document.getElementById('av-label')?.value.trim();
    const start = document.getElementById('av-start')?.value;
    const end = document.getElementById('av-end')?.value || start;
    const type = document.getElementById('av-type')?.value || 'closure';
    const notes = document.getElementById('av-notes')?.value.trim() || '';

    if (!label || !start) return alert('Please enter a label and start date.');

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const payload = { label, closure_type: type, start_date: start, end_date: end, notes };
    let response;
    if (editingClosureId) {
        response = await client.from('business_closures').update(payload).eq('id', editingClosureId);
    } else {
        response = await client.from('business_closures').insert([{ ...payload, business_id: currentBusinessId }]);
    }

    if (response.error) {
        alert('Failed to save closure: ' + response.error.message);
        return;
    }

    editingClosureId = null;
    closeAvailabilityModal();
    renderAvailabilityList();
}

async function deleteClosure(id) {
    if (!confirm('Remove this business closure date?')) return;

    const client = getSupabase();
    if (!client) return;
    await client.from('business_closures').delete().eq('id', id);
    renderAvailabilityList();
}

/* ==========================================================================
   HOUSEHOLD / CLIENT CRUD CONTROLLER (SUPABASE)
   ========================================================================== */

let editingHouseholdId = null;
let householdModalContext = 'household'; // 'household' | 'person' — controls whether the shared modal shows contact fields + household search

async function openHouseholdFullView(id) {
    const client = getSupabase();
    if (!client) return;

    const { data: hh } = await client
        .from('households')
        .select('*, people(*), pets(*)')
        .eq('id', id)
        .single();

    if (!hh) return;

    const { data: bookings } = await client
        .from('bookings')
        .select('*')
        .eq('household_id', id);

    const modal = document.getElementById('fullscreen-modal');
    const titleEl = document.getElementById('fs-title');
    const bodyEl = document.getElementById('fs-details-payload');

    if (titleEl) titleEl.textContent = `<i data-lucide="house"></i> ${hh.name}`;

    if (bodyEl) {
        bodyEl.innerHTML = `
            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:1.5rem; padding:1rem 0;">
                <div class="stat-card">
                    <h3><i data-lucide="users"></i> Household Members</h3>
                    ${hh.people && hh.people.length ? hh.people.map(p => `
                        <div style="margin-top:0.5rem; padding-top:0.5rem; border-top:1px solid var(--border);">
                            <strong>${p.name}</strong> (${p.role || 'Member'})
                            <div style="font-size:0.85rem; color:var(--text-muted);">${p.contact || 'No contact provided'}</div>
                        </div>
                    `).join('') : '<p style="color:var(--text-muted);">No members recorded.</p>'}
                </div>

                <div class="stat-card">
                    <h3><i data-lucide="dog"></i> Pets</h3>
                    ${hh.pets && hh.pets.length ? hh.pets.map(p => `
                        <div style="margin-top:0.5rem; padding-top:0.5rem; border-top:1px solid var(--border);">
                            <strong>${p.name}</strong> (${p.species})
                            <div style="font-size:0.85rem; color:var(--text-muted);">Vaccines: ${p.vaccine_status || 'Current'}</div>
                        </div>
                    `).join('') : '<p style="color:var(--text-muted);">No pets attached.</p>'}
                </div>

                <div class="stat-card">
                    <h3><i data-lucide="calendar"></i> Scheduled Events</h3>
                    ${bookings && bookings.length ? bookings.map(b => `
                        <div style="margin-top:0.5rem; padding-top:0.5rem; border-top:1px solid var(--border);">
                            <strong>${b.service_type || 'Booking'}</strong>
                            <div style="font-size:0.85rem; color:var(--text-muted);">${b.start_date} → ${b.end_date}</div>
                        </div>
                    `).join('') : '<p style="color:var(--text-muted);">No upcoming events.</p>'}
                </div>

                <div class="stat-card alert">
                    <h3><i data-lucide="credit-card"></i> Open Invoices</h3>
                    <p style="font-size:0.9rem; color:var(--text-muted); margin-top:0.5rem;">No active balance or unpaid invoices on file.</p>
                </div>
            </div>
        `;
    }

    if (modal) modal.classList.remove('hidden');
    refreshIcons();
}

function closeFullscreenProfile() {
    const modal = document.getElementById('fullscreen-modal');
    if (modal) modal.classList.add('hidden');
}

function openHouseholdModal(id = null) {
    editingHouseholdId = id;
    activeLinkingHouseholdId = null;

    const titleEl = document.getElementById('household-modal-title');
    const nameInput = document.getElementById('hh-name');
    const contactNameInput = document.getElementById('hh-contact-name');
    const contactInfoInput = document.getElementById('hh-contact-info');
    const addressInput = document.getElementById('hh-address');
    const noteInput = document.getElementById('hh-notes');
    const hiddenIdInput = document.getElementById('selected-household-id');
    const dropdown = document.getElementById('hh-search-dropdown');

    householdModalContext = 'household';

    // Clear any leftover "attach person to household X" state from a
    // previous Link Member flow, so this always creates/edits a standalone household.
    if (hiddenIdInput) hiddenIdInput.value = '';

    // No contact fields or household search when creating/editing a standalone
    // household — only name, address, and notes are relevant here.
    if (contactNameInput && contactNameInput.parentElement) contactNameInput.parentElement.style.display = 'none';
    if (contactInfoInput && contactInfoInput.parentElement) contactInfoInput.parentElement.style.display = 'none';
    if (dropdown) {
        dropdown.classList.add('hidden');
        dropdown.innerHTML = '';
    }

    if (titleEl) titleEl.textContent = id ? 'Edit Household' : 'Add Household';

    // Make sure Household Name label and unlock state are active
    if (nameInput) {
        nameInput.readOnly = false;
        nameInput.style.backgroundColor = 'var(--bg-card)';
        if (nameInput.parentElement && nameInput.parentElement.querySelector('label')) {
            nameInput.parentElement.querySelector('label').textContent = 'Household Name *';
        }
    }

    // Re-enable Address field for Household creation
    if (addressInput && addressInput.parentElement) {
        addressInput.parentElement.style.display = 'block';
    }

    if (!id) {
        if (nameInput) nameInput.value = '';
        if (contactNameInput) contactNameInput.value = '';
        if (contactInfoInput) contactInfoInput.value = '';
        if (addressInput) addressInput.value = '';
        if (noteInput) noteInput.value = '';
    }

    const modal = document.getElementById('household-modal');
    if (modal) {
        modal.classList.remove('hidden');
        refreshIcons();
    }
}

function closeHouseholdModal() {
    editingHouseholdId = null;
    activeLinkingHouseholdId = null;

    const nameInput = document.getElementById('hh-name');
    if (nameInput) {
        nameInput.readOnly = false;
        nameInput.style.backgroundColor = 'var(--bg-card)';
    }

    // Re-enable address input display for full household creation
    const addressInput = document.getElementById('hh-address');
    if (addressInput && addressInput.parentElement) {
        addressInput.parentElement.style.display = 'block';
    }

    const modal = document.getElementById('household-modal');
    if (modal) modal.classList.add('hidden');
}

async function saveHousehold() {
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const hiddenIdInput = document.getElementById('selected-household-id');
    const targetHouseholdId = activeLinkingHouseholdId || (hiddenIdInput ? hiddenIdInput.value : null);

    const contactNameInput = document.getElementById('hh-contact-name');
    const contactInfoInput = document.getElementById('hh-contact-info');
    const noteInput = document.getElementById('hh-notes');

    const personName = contactNameInput && contactNameInput.value.trim() 
        ? contactNameInput.value.trim() 
        : (document.getElementById('hh-name') ? document.getElementById('hh-name').value.trim() : '');
    const contactInfo = contactInfoInput ? contactInfoInput.value.trim() : '';
    const role = noteInput ? noteInput.value.trim() : 'Member';

    // Flow: Creating/Attaching Person to a selected Household
    if (targetHouseholdId) {
        if (!personName) return alert('Please enter the person’s name.');

        const nameParts = personName.split(' ');
        const isEmail = contactInfo.includes('@');

        const { error } = await client.from('people').insert([{
            household_id: targetHouseholdId,
            name: personName,
            contact: contactInfo,
            first_name: nameParts[0] || personName,
            last_name: nameParts.slice(1).join(' ') || null,
            email: isEmail ? contactInfo : null,
            phone: !isEmail ? contactInfo : null,
            role: role,
            category: pendingPersonCategory || 'member',
            business_id: currentBusinessId
        }]);
        pendingPersonCategory = null;

        if (error) {
            alert('Error adding person: ' + error.message);
        } else {
            closeHouseholdModal();
            openFullWidthProfile('household', targetHouseholdId);
        }
        return;
    }

    // Flow: Standalone Household Creation
    const hhName = document.getElementById('hh-name')?.value.trim() || '';
    const address = document.getElementById('hh-address')?.value.trim() || '';

    if (!hhName) return alert('Please select or enter a Household name.');

    let newHouseholdId = editingHouseholdId;
    if (editingHouseholdId) {
        await client.from('households').update({ name: hhName, address, note: role }).eq('id', editingHouseholdId);
    } else {
        const { data: inserted, error } = await client.from('households').insert([{ name: hhName, address, note: role, business_id: currentBusinessId }]).select();
        if (error) {
            alert('Error creating household: ' + error.message);
            return;
        }
        newHouseholdId = inserted && inserted[0] ? inserted[0].id : null;
    }

    // If this household was created via a person's/pet's "Link Household → + Create New"
    // flow, link that person/pet to it now instead of leaving it unattached.
    if (returnToProfile && newHouseholdId && (returnToProfile.type === 'person' || returnToProfile.type === 'pet')) {
        const table = returnToProfile.type === 'person' ? 'people' : 'pets';
        await client.from(table).update({ household_id: newHouseholdId }).eq('id', returnToProfile.id);
    }

    closeHouseholdModal();
    if (returnToProfile) {
        const rt = returnToProfile;
        returnToProfile = null;
        openFullWidthProfile(rt.type, rt.id);
    } else {
        renderAllDashboards();
    }
}

async function deleteHousehold(id) {
    if (!confirm('Are you sure? This will delete the household and all linked pets and contacts.')) return;

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const { error } = await client
        .from('households')
        .delete()
        .eq('id', id);

    if (error) {
        alert('Error deleting household: ' + error.message);
    } else {
        if (typeof renderAllDashboards === 'function') renderAllDashboards();
    }
}

/* ==========================================================================
   PET CRUD CONTROLLER (SUPABASE)
   ========================================================================== */

let editingPetId = null;

async function openPetModal(id = null) {
    editingPetId = id;
    await populateHouseholdSelects();

    const titleEl = document.getElementById('pet-modal-title');
    const householdSel = document.getElementById('pet-household-id');
    const nameInput = document.getElementById('pet-name');
    const speciesSel = document.getElementById('pet-species');
    const vaccineSel = document.getElementById('pet-vaccine-status');
    const vaccineExpInput = document.getElementById('pet-vaccine-expiry');
    const allergiesInput = document.getElementById('pet-allergies');
    const foodInput = document.getElementById('pet-food');
    const detailsInput = document.getElementById('pet-details');

    if (id) {
        if (titleEl) titleEl.textContent = 'Edit Pet';

        const client = getSupabase();
        if (client) {
            const { data: pet, error } = await client
                .from('pets')
                .select('*')
                .eq('id', id)
                .single();

            if (!error && pet) {
                if (householdSel) householdSel.value = pet.household_id || '';
                if (nameInput) nameInput.value = pet.name || '';
                if (speciesSel) speciesSel.value = pet.species || 'dog';
                if (vaccineSel) vaccineSel.value = pet.vaccine_status || 'current';
                if (vaccineExpInput) vaccineExpInput.value = pet.vaccine_expiry || '';
                if (allergiesInput) allergiesInput.value = pet.allergies || '';
                if (foodInput) foodInput.value = pet.food || '';
                if (detailsInput) detailsInput.value = pet.details || '';
            }
        }
    } else {
        if (titleEl) titleEl.textContent = 'Add Pet';
        if (nameInput) nameInput.value = '';
        if (speciesSel) speciesSel.value = 'dog';
        if (vaccineSel) vaccineSel.value = 'current';
        if (vaccineExpInput) vaccineExpInput.value = '';
        if (allergiesInput) allergiesInput.value = '';
        if (foodInput) foodInput.value = '';
        if (detailsInput) detailsInput.value = '';
    }

    const modal = document.getElementById('pet-modal');
    if (modal) modal.classList.remove('hidden');
}

function closePetModal() {
    editingPetId = null;
    const modal = document.getElementById('pet-modal');
    if (modal) modal.classList.add('hidden');
}

async function savePet() {
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const householdSel = document.getElementById('pet-household-id');
    const nameInput = document.getElementById('pet-name');
    const speciesSel = document.getElementById('pet-species');
    const vaccineSel = document.getElementById('pet-vaccine-status');
    const vaccineExpInput = document.getElementById('pet-vaccine-expiry');
    const allergiesInput = document.getElementById('pet-allergies');
    const foodInput = document.getElementById('pet-food');
    const detailsInput = document.getElementById('pet-details');

    const householdId = householdSel ? householdSel.value : null;
    const name = nameInput ? nameInput.value.trim() : '';
    const species = speciesSel ? speciesSel.value : 'dog';
    const vaccineStatus = vaccineSel ? vaccineSel.value : 'current';
    const vaccineExpiry = (vaccineExpInput && vaccineExpInput.value) ? vaccineExpInput.value : null;
    const allergies = allergiesInput ? allergiesInput.value.trim() : 'None';
    const food = foodInput ? foodInput.value.trim() : '';
    const details = detailsInput ? detailsInput.value.trim() : '';

    if (!name) return alert('Please enter a pet name.');
    if (!householdId) return alert('Please select a household.');

    const payload = {
        household_id: householdId,
        name: name,
        species: species,
        vaccine_status: vaccineStatus,
        vaccine_expiry: vaccineExpiry,
        allergies: allergies,
        food: food,
        details: details
    };

    let response;
    if (editingPetId) {
        response = await client.from('pets').update(payload).eq('id', editingPetId);
    } else {
        response = await client.from('pets').insert([{ ...payload, business_id: currentBusinessId }]);
    }

    if (response.error) {
        alert('Failed to save pet: ' + response.error.message);
    } else {
        closePetModal();
        if (returnToProfile) {
            const rt = returnToProfile;
            returnToProfile = null;
            openFullWidthProfile(rt.type, rt.id);
        } else if (typeof renderAllDashboards === 'function') {
            await renderAllDashboards();
        }
    }
}

async function deletePet(id) {
    if (!confirm('Remove this pet profile?')) return;

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const { error } = await client
        .from('pets')
        .delete()
        .eq('id', id);

    if (error) {
        alert('Error deleting pet: ' + error.message);
    } else {
        if (typeof renderAllDashboards === 'function') renderAllDashboards();
    }
}

async function deletePerson(id) {
    if (!confirm('Remove this contact?')) return;

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const { error } = await client
        .from('people')
        .delete()
        .eq('id', id);

    if (error) {
        alert('Error deleting contact: ' + error.message);
    } else {
        if (typeof renderAllDashboards === 'function') renderAllDashboards();
    }
}

/* ==========================================================================
   VET & COI CONTROLLER (SUPABASE)
   ========================================================================== */

let editingVetId = null;

async function openVetModal(id = null) {
    editingVetId = id;
    const titleEl = document.getElementById('vet-modal-title');
    const nameInput = document.getElementById('vt-name');
    const clinicInput = document.getElementById('vt-clinic');
    const phoneInput = document.getElementById('vt-phone');
    const statusSel = document.getElementById('vt-status');
    const notesInput = document.getElementById('vt-notes');

    if (id) {
        if (titleEl) titleEl.textContent = 'Edit Vet Record';
        const client = getSupabase();
        if (client) {
            const { data: v, error } = await client
                .from('vets')
                .select('*')
                .eq('id', id)
                .single();

            if (!error && v) {
                if (nameInput) nameInput.value = v.name || '';
                if (clinicInput) clinicInput.value = v.clinic || '';
                if (phoneInput) phoneInput.value = v.phone || '';
                if (statusSel) statusSel.value = v.status || 'active';
                if (notesInput) notesInput.value = v.notes || '';
            }
        }
    } else {
        if (titleEl) titleEl.textContent = 'Add Vet / COI Entry';
        if (nameInput) nameInput.value = '';
        if (clinicInput) clinicInput.value = '';
        if (phoneInput) phoneInput.value = '';
        if (statusSel) statusSel.value = 'active';
        if (notesInput) notesInput.value = '';
    }

    const modal = document.getElementById('vet-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeVetModal() {
    editingVetId = null;
    const modal = document.getElementById('vet-modal');
    if (modal) modal.classList.add('hidden');
}

async function saveVet() {
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const name = document.getElementById('vt-name')?.value.trim();
    const clinic = document.getElementById('vt-clinic')?.value.trim();
    const phone = document.getElementById('vt-phone')?.value.trim();
    const status = document.getElementById('vt-status')?.value || 'active';
    const notes = document.getElementById('vt-notes')?.value.trim();

    if (!name) return alert('Please enter a doctor/vet name.');

    const payload = {
        name: name,
        clinic: clinic,
        phone: phone,
        status: status,
        notes: notes
    };

    let response;
    if (editingVetId) {
        response = await client.from('vets').update(payload).eq('id', editingVetId);
    } else {
        response = await client.from('vets').insert([{ ...payload, business_id: currentBusinessId }]).select();
    }

    if (response.error) {
        alert('Failed to save vet: ' + response.error.message);
        console.error('Supabase vet error:', response.error);
    } else {
        // If this vet was created via a pet's "Link Vet → + Create New" flow,
        // link it to that pet's regular/emergency slot now instead of leaving it unattached.
        if (pendingPetVetLink && response.data && response.data[0]) {
            await client.from('pets').update({ [pendingPetVetLink.column]: response.data[0].id }).eq('id', pendingPetVetLink.petId);
        }
        pendingPetVetLink = null;

        closeVetModal();
        if (returnToProfile) {
            const rt = returnToProfile;
            returnToProfile = null;
            openFullWidthProfile(rt.type, rt.id);
        } else if (typeof renderAllDashboards === 'function') {
            await renderAllDashboards();
        }
    }
}

async function deleteVet(id) {
    if (!confirm('Remove this vet record?')) return;

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const { error } = await client
        .from('vets')
        .delete()
        .eq('id', id);

    if (error) {
        alert('Error deleting vet: ' + error.message);
    } else {
        if (typeof renderAllDashboards === 'function') renderAllDashboards();
    }
}

/* ==========================================================================
   HOUSEHOLD DROPDOWN LOADER FOR PET MODAL
   ========================================================================== */

async function populateHouseholdSelects() {
    const client = getSupabase();
    if (!client) return;

    const selectEl = document.getElementById('pet-household-id');
    if (!selectEl) return;

    const { data: households, error } = await client
        .from('households')
        .select('id, name')
        .order('name', { ascending: true });

    if (error) {
        console.error('Error loading households for dropdown:', error);
        selectEl.innerHTML = '<option value="">Failed to load households</option>';
        return;
    }

    if (!households || households.length === 0) {
        selectEl.innerHTML = '<option value="">No households found (Add one first)</option>';
        return;
    }

    selectEl.innerHTML = households
        .map(h => `<option value="${h.id}">${h.name}</option>`)
        .join('');
}

/* ==========================================================================
   CRM DIRECTORY RENDERER (SUPABASE + LUCIDE ICONS)
   ========================================================================== */

async function renderAllDashboards() {
    const container = document.getElementById('crm-list-container');
    if (!container) return;

    try { localStorage.removeItem('barkboard-last-profile'); } catch (e) { /* storage unavailable, ignore */ }

    const client = getSupabase();
    if (!client) return;

    const query = document.getElementById('crm-search')?.value.trim().toLowerCase() || '';
    const filter = typeof currentEntityFilter !== 'undefined' ? currentEntityFilter : 'all';

    let html = '';

    // 1. HOUSEHOLDS
    if (filter === 'all' || filter === 'household') {
        const { data: households } = await client.from('households').select('*, people(*), pets(*)').order('name');

        if (households) {
            households.forEach(hh => {
                const primary = hh.people?.find(p => p.role === 'Primary') || hh.people?.[0];
                if (!query || hh.name?.toLowerCase().includes(query) || personDisplayName(primary || {}).toLowerCase().includes(query)) {
                    html += `
                        <div class="crm-card" onclick="openFullWidthProfile('household', '${hh.id}')" style="cursor:pointer;">
                            <div class="crm-card-content">
                                <h3 style="margin:0; display:flex; align-items:center; gap:0.5rem; font-size:1.1rem;">
                                    <i data-lucide="home"></i> ${hh.name}
                                </h3>
                                ${primary ? `<p style="margin:0; font-size:0.85rem; color:var(--text-muted); display:flex; align-items:center; gap:0.35rem;"><i data-lucide="user" style="width:14px;height:14px;"></i> Primary: ${personDisplayName(primary)} ${personDisplayContact(primary) ? '· ' + personDisplayContact(primary) : ''}</p>` : ''}
                            </div>
                            <button class="delete-action-btn" onclick="event.stopPropagation(); deleteHousehold('${hh.id}')" title="Delete Household">
                                <i data-lucide="trash-2"></i>
                            </button>
                        </div>`;
                }
            });
        }
    }

    // 2. PEOPLE
    if (filter === 'all' || filter === 'people') {
        const { data: people } = await client.from('people').select('*, households(name)').order('name');

        if (people) {
            people.forEach(p => {
                if (!query || personDisplayName(p).toLowerCase().includes(query) || personDisplayContact(p).toLowerCase().includes(query)) {
                    html += `
                        <div class="crm-card" onclick="openFullWidthProfile('person', '${p.id}')" style="cursor:pointer;">
                            <div class="crm-card-content">
                                <h3 style="margin:0; display:flex; align-items:center; gap:0.5rem; font-size:1.1rem;">
                                    <i data-lucide="user"></i> ${personDisplayName(p)}
                                </h3>
                                <p style="margin:0; font-size:0.85rem; color:var(--text-muted);">${p.role || 'Contact'} ${personDisplayContact(p) ? '· ' + personDisplayContact(p) : ''} ${p.households?.name ? '· Household: ' + p.households.name : ''}</p>
                            </div>
                            <button class="delete-action-btn" onclick="event.stopPropagation(); deletePerson('${p.id}')" title="Delete Contact">
                                <i data-lucide="trash-2"></i>
                            </button>
                        </div>`;
                }
            });
        }
    }

    // 3. PETS
    if (filter === 'all' || filter === 'pets') {
        const { data: pets } = await client.from('pets').select('*, households(name)').order('name');

        if (pets) {
            pets.forEach(p => {
                if (!query || p.name?.toLowerCase().includes(query)) {
                    const speciesIcon = p.species === 'cat' ? 'cat' : p.species === 'other' ? 'rabbit' : 'dog';
                    html += `
                        <div class="crm-card" onclick="openFullWidthProfile('pet', '${p.id}')" style="cursor:pointer;">
                            <div class="crm-card-content">
                                <h3 style="margin:0; display:flex; align-items:center; gap:0.5rem; font-size:1.1rem;">
                                    <i data-lucide="${speciesIcon}"></i> ${p.name}
                                </h3>
                                <p style="margin:0; font-size:0.85rem; color:var(--text-muted);">${speciesLabel(p)} ${p.households?.name ? '· Household: ' + p.households.name : ''} · Vaccines: ${p.vaccine_status || 'Current'}</p>
                            </div>
                            <button class="delete-action-btn" onclick="event.stopPropagation(); deletePet('${p.id}')" title="Delete Pet">
                                <i data-lucide="trash-2"></i>
                            </button>
                        </div>`;
                }
            });
        }
    }

    // 4. VETS
    if (filter === 'all' || filter === 'vets') {
        const { data: vets } = await client.from('vets').select('*').order('name');

        if (vets) {
            vets.forEach(v => {
                if (!query || v.name?.toLowerCase().includes(query) || v.clinic?.toLowerCase().includes(query)) {
                    html += `
                        <div class="crm-card" onclick="openFullWidthProfile('vet', '${v.id}')" style="cursor:pointer;">
                            <div class="crm-card-content">
                                <h3 style="margin:0; display:flex; align-items:center; gap:0.5rem; font-size:1.1rem;">
                                    <i data-lucide="stethoscope"></i> ${v.name}
                                </h3>
                                <p style="margin:0; font-size:0.85rem; color:var(--text-muted);">${v.clinic || 'Clinic'} ${v.phone ? '· ' + v.phone : ''} · Status: ${v.status || 'Active'}</p>
                            </div>
                            <button class="delete-action-btn" onclick="event.stopPropagation(); deleteVet('${v.id}')" title="Delete Vet">
                                <i data-lucide="trash-2"></i>
                            </button>
                        </div>`;
                }
            });
        }
    }

    // 5. STAFF
    if (filter === 'all' || filter === 'staff') {
        const { data: staffList } = await client.from('staff').select('*').order('name');

        if (staffList) {
            staffList.forEach(s => {
                if (!query || s.name?.toLowerCase().includes(query) || s.role?.toLowerCase().includes(query)) {
                    html += `
                        <div class="crm-card" onclick="openFullWidthProfile('staff', '${s.id}')" style="cursor:pointer;">
                            <div class="crm-card-content">
                                <h3 style="margin:0; display:flex; align-items:center; gap:0.5rem; font-size:1.1rem;">
                                    <i data-lucide="briefcase"></i> ${s.name}
                                </h3>
                                <p style="margin:0; font-size:0.85rem; color:var(--text-muted);">${s.role || 'Staff'} ${s.contact ? '· ' + s.contact : ''}</p>
                            </div>
                            <button class="delete-action-btn" onclick="event.stopPropagation(); deleteStaff('${s.id}')" title="Delete Staff">
                                <i data-lucide="trash-2"></i>
                            </button>
                        </div>`;
                }
            });
        }
    }

    container.innerHTML = html || '<div class="biz-empty">No entries found matching criteria.</div>';
    refreshIcons();
}

/* ==========================================================================
   INLINE FULL-WIDTH ENTITY VIEW (DIRECTLY BELOW FILTER BAR)
   ========================================================================== */

async function fetchVetsForPets(client, pets) {
    const ids = Array.from(new Set(
        (pets || []).flatMap(p => [p.vet_id, p.emergency_vet_id]).filter(Boolean)
    ));
    if (!ids.length) return {};
    const { data: vets } = await client.from('vets').select('*').in('id', ids);
    const map = {};
    (vets || []).forEach(v => { map[v.id] = v; });
    return map;
}

async function openFullWidthProfile(type, id) {
    const container = document.getElementById('crm-list-container');
    if (!container) return;

    try { localStorage.setItem('barkboard-last-profile', JSON.stringify({ type, id })); } catch (e) { /* storage unavailable, ignore */ }

    const client = getSupabase();
    if (!client) return;

    let payload = null;

    if (type === 'household') {
        const { data } = await client.from('households').select('*, people(*), pets(*), bookings(*), invoices(*)').eq('id', id).single();
        if (data && data.bookings) { data.bookings = await attachResourceNames(client, data.bookings); data.bookings = await attachInvoiceStatuses(client, data.bookings); }
        payload = data;
        if (payload) {
            payload.vetsById = await fetchVetsForPets(client, payload.pets || []);
        }
    } else if (type === 'person') {
        const { data } = await client.from('people').select('*, households(*, people(*), pets(*))').eq('id', id).single();
        payload = data;
        if (payload && payload.households) {
            payload.households.vetsById = await fetchVetsForPets(client, payload.households.pets || []);
        }
    } else if (type === 'pet') {
        const { data } = await client.from('pets').select('*, households(*, people(*), pets(*))').eq('id', id).single();
        payload = data;
        if (payload) {
            const vetsById = await fetchVetsForPets(client, [payload]);
            payload.vet = payload.vet_id ? vetsById[payload.vet_id] : null;
            payload.emergencyVet = payload.emergency_vet_id ? vetsById[payload.emergency_vet_id] : null;
        }
        if (payload && payload.households) {
            payload.households.vetsById = await fetchVetsForPets(client, payload.households.pets || []);
        }
        if (payload) {
            const { data: bookings } = await client.from('bookings').select('*').eq('pet_id', id);
            payload.bookings = await attachResourceNames(client, bookings || []); payload.bookings = await attachInvoiceStatuses(client, payload.bookings);
            const { data: staffAssignments } = await client.from('staff_assignments').select('*, staff(name, role)').eq('pet_id', id);
            payload.assignedStaff = staffAssignments || [];
            const { data: tasks } = await client.from('staff_tasks').select('*, staff(name)').eq('pet_id', id).order('due_date');
            payload.tasks = tasks || [];
        }
    } else if (type === 'vet') {
        const { data } = await client.from('vets').select('*').eq('id', id).single();
        payload = data;
        if (payload) {
            const { data: clientPets } = await client.from('pets').select('*, households(name, people(*))').or(`vet_id.eq.${id},emergency_vet_id.eq.${id}`);
            payload.clientPets = clientPets || [];
            window.__vetClientPetsCache = window.__vetClientPetsCache || {};
            window.__vetClientPetsCache[id] = payload.clientPets;
        }
    } else if (type === 'staff') {
        const { data } = await client.from('staff').select('*').eq('id', id).single();
        payload = data;
        if (payload) {
            const { data: assignments } = await client.from('staff_assignments').select('*, pets(name, species, household_id, households(name))').eq('staff_id', id);
            payload.assignments = assignments || [];
            const { data: events } = await client.from('bookings').select('*, pets(name), households(name)').eq('assigned_staff_id', id).order('check_in');
            payload.bookings = await attachResourceNames(client, events || []); payload.bookings = await attachInvoiceStatuses(client, payload.bookings);
            const { data: tasks } = await client.from('staff_tasks').select('*').eq('staff_id', id).order('due_date');
            payload.tasks = tasks || [];
            const { data: timeOff } = await client.from('staff_availability').select('*').eq('staff_id', id).order('start_date');
            payload.timeOff = timeOff || [];
        }
    }

    if (!payload) return;

    const iconName = type === 'household' ? 'home' : type === 'person' ? 'user' : type === 'pet' ? 'dog' : type === 'staff' ? 'briefcase' : 'stethoscope';

    container.innerHTML = `
        <div class="full-width-profile-view" style="width:100%; background:var(--bg-card, #ffffff); border:1px solid var(--border); border-radius:0.5rem; padding:1.5rem; margin-top:0.5rem;">
            
            <!-- HEADER BAR -->
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border); padding-bottom:1rem; margin-bottom:1.5rem;">
                <div style="display:flex; align-items:center; gap:0.6rem;">
                    <i data-lucide="${iconName}" style="width:24px; height:24px;"></i>
                    <h2 style="margin:0; font-size:1.4rem;">${payload.name || 'Details'}</h2>
                    ${type === 'household' && payload.needs_review ? `
                        <span style="display:flex; align-items:center; gap:0.35rem; background:#fef3c7; color:#92400e; font-size:0.75rem; font-weight:700; padding:0.25rem 0.6rem; border-radius:999px;">
                            <i data-lucide="alert-triangle" style="width:12px;height:12px;"></i> Needs Review — new portal signup
                            <button onclick="markHouseholdReviewed('${id}')" style="background:none; border:none; cursor:pointer; color:#92400e; font-weight:700; text-decoration:underline; padding:0; margin-left:0.3rem; font-size:0.75rem;">Mark Reviewed</button>
                        </span>
                    ` : ''}
                </div>
                <div style="display:flex; align-items:center; gap:1rem;">
                    <span id="auto-save-status" style="font-size:0.8rem; color:var(--text-muted);">All changes saved</span>
                    <button class="btn-icon" onclick="renderAllDashboards()" style="background:none; border:none; cursor:pointer;" title="Close">
                        <i data-lucide="x" style="width:20px; height:20px;"></i>
                    </button>
                </div>
            </div>

            ${renderDetailsStrip(type, id, payload)}

            <!-- CONTENT SECTIONS -->
            ${renderEntitySections(type, payload, id)}
        </div>
    `;

    refreshIcons();
}

/* Fires an email notification via /api/send-notification — fire-and-forget,
   never awaited by the caller and never blocks/breaks the UI action that
   triggered it (confirming a booking, marking an invoice paid, etc. already
   succeeded in the database by the time this is called; the email is a
   bonus on top, not a dependency). Silently no-ops if SMTP isn't configured
   for this business — that's handled server-side, not here. */
function notifyEmail(type, extra) {
    fetch('/api/send-notification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId: currentBusinessId, type, ...extra })
    }).catch(err => console.error('[notifyEmail] Failed to reach send-notification:', err));
}

function detailField(label, value) {
    return `<div><span style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.03em;">${label}</span><div style="font-size:0.9rem; margin-top:0.1rem;">${value || '—'}</div></div>`;
}

// --- Add to Calendar (.ics download) — mirrors the same simple generator
// used in portal.html. Duplicated rather than shared since the staff app
// and portal are separate standalone pages with no common included script.
function toICSDateTime(isoLike) {
    return (isoLike || '').replace(/[-:]/g, '').slice(0, 15);
}

function downloadICSEvent({ uid, summary, description, location, start, end }) {
    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const esc = (s) => (s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
    const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//BarkBoard//Booking//EN',
        'BEGIN:VEVENT',
        `UID:${uid}@barkboard`,
        `DTSTAMP:${now}`,
        `DTSTART:${toICSDateTime(start)}`,
        `DTEND:${toICSDateTime(end)}`,
        `SUMMARY:${esc(summary)}`,
        description ? `DESCRIPTION:${esc(description)}` : '',
        location ? `LOCATION:${esc(location)}` : '',
        'END:VEVENT',
        'END:VCALENDAR'
    ].filter(Boolean).join('\r\n');

    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(summary || 'appointment').replace(/[^a-z0-9]/gi, '-')}.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function downloadBookingICS() {
    if (!editingBookingId) return;
    const client = getSupabase();
    if (!client) return;
    const { data: b } = await client.from('bookings').select('*, pets(name)').eq('id', editingBookingId).single();
    if (!b) return;
    downloadICSEvent({
        uid: b.id,
        summary: `${b.pets?.name || 'Pet'} — ${b.service_name || 'Appointment'}`,
        description: b.notes || '',
        start: b.check_in,
        end: b.check_out || b.check_in
    });
}

async function markHouseholdReviewed(householdId) {
    const client = getSupabase();
    if (!client) return;
    const { error } = await client.from('households').update({ needs_review: false }).eq('id', householdId);
    if (error) return alert('Failed to update: ' + error.message);
    openFullWidthProfile('household', householdId);
}

function renderDetailsStrip(type, id, data) {
    const key = `${type}-${id}`;
    let viewFields = '';
    let editFields = '';

    if (type === 'household') {
        viewFields = detailField('Address', data.address) + detailField('Notes', data.note);
        editFields = `
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Household Name</label><input type="text" value="${data.name || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('households', '${id}', 'name', this.value)"></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Address</label><input type="text" value="${data.address || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('households', '${id}', 'address', this.value)"></div>
            <div style="flex:1; min-width:200px;"><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Notes</label><textarea class="biz-select" style="padding:0.4rem; width:100%;" rows="1" onchange="autoSaveField('households', '${id}', 'note', this.value)">${data.note || ''}</textarea></div>
        `;
    } else if (type === 'person') {
        viewFields = detailField('Role', data.role || 'Member') + detailField('Category', (data.category || 'member') === 'other' ? 'Other Contact' : 'Household Member')
            + detailField('Email', data.email ? (data.preferred_contact === 'email' ? '★ ' : '') + data.email : null)
            + detailField('Phone', data.phone ? (data.preferred_contact === 'phone' ? '★ ' : '') + data.phone : null)
            + detailField('Notes', data.notes);
        editFields = `
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">First Name</label><input id="person-first-name" type="text" value="${data.first_name || ''}" class="biz-select" style="padding:0.4rem;" onchange="savePersonNameField('${id}', 'first_name', this.value)"></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Last Name</label><input id="person-last-name" type="text" value="${data.last_name || ''}" class="biz-select" style="padding:0.4rem;" onchange="savePersonNameField('${id}', 'last_name', this.value)"></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Role</label><select class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('people', '${id}', 'role', this.value)">${['Primary', 'Backup', 'Member', 'Emergency Contact', 'Relative', 'Other'].map(r => `<option value="${r}" ${data.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Category</label><select class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('people', '${id}', 'category', this.value)"><option value="member" ${(data.category || 'member') === 'member' ? 'selected' : ''}>Household Member</option><option value="other" ${data.category === 'other' ? 'selected' : ''}>Other Contact</option></select></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Email</label><div style="display:flex; gap:0.3rem;"><input type="email" value="${data.email || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('people', '${id}', 'email', this.value)"><button onclick="setPreferredContact('${id}', 'email', ${data.preferred_contact === 'email' ? 'true' : 'false'})" style="background:none; border:none; cursor:pointer; color:${data.preferred_contact === 'email' ? '#eab308' : 'var(--text-muted)'};">★</button></div></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Phone</label><div style="display:flex; gap:0.3rem;"><input type="tel" value="${data.phone || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('people', '${id}', 'phone', this.value)"><button onclick="setPreferredContact('${id}', 'phone', ${data.preferred_contact === 'phone' ? 'true' : 'false'})" style="background:none; border:none; cursor:pointer; color:${data.preferred_contact === 'phone' ? '#eab308' : 'var(--text-muted)'};">★</button></div></div>
            <div style="flex:1; min-width:200px;"><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Notes</label><textarea class="biz-select" style="padding:0.4rem; width:100%;" rows="1" onchange="autoSaveField('people', '${id}', 'notes', this.value)">${data.notes || ''}</textarea></div>
        `;
    } else if (type === 'pet') {
        viewFields = detailField('Species', speciesLabel(data)) + detailField('Vaccine Status', data.vaccine_status) + detailField('Allergies', data.allergies) + detailField('Diet & Food', data.food) + detailField('Behavioral Details', data.details);
        editFields = `
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Pet Name</label><input type="text" value="${data.name || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('pets', '${id}', 'name', this.value)"></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Species</label><select class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('pets', '${id}', 'species', this.value); document.getElementById('pet-species-other-${id}').style.display = this.value === 'other' ? 'block' : 'none';"><option value="dog" ${data.species === 'dog' ? 'selected' : ''}>Dog</option><option value="cat" ${data.species === 'cat' ? 'selected' : ''}>Cat</option><option value="other" ${data.species === 'other' ? 'selected' : ''}>Other</option></select></div>
            <div id="pet-species-other-${id}" style="display:${data.species === 'other' ? 'block' : 'none'};"><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Specify Species</label><input type="text" value="${data.species_other || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('pets', '${id}', 'species_other', this.value)"></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Vaccine Status</label><select class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('pets', '${id}', 'vaccine_status', this.value)"><option value="current" ${data.vaccine_status === 'current' ? 'selected' : ''}>Current</option><option value="pending" ${data.vaccine_status === 'pending' ? 'selected' : ''}>Pending</option><option value="expired" ${data.vaccine_status === 'expired' ? 'selected' : ''}>Expired</option></select></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Allergies</label><input type="text" value="${data.allergies || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('pets', '${id}', 'allergies', this.value)"></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Diet & Food</label><input type="text" value="${data.food || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('pets', '${id}', 'food', this.value)"></div>
            <div style="flex:1; min-width:200px;"><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Behavioral Details</label><textarea class="biz-select" style="padding:0.4rem; width:100%;" rows="1" onchange="autoSaveField('pets', '${id}', 'details', this.value)">${data.details || ''}</textarea></div>
        `;
    } else if (type === 'vet') {
        viewFields = detailField('Clinic', data.clinic) + detailField('Phone', data.phone) + detailField('Email', data.email) + detailField('Hours', data.hours) + detailField('Notes', data.notes);
        editFields = `
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Doctor / Vet Name</label><input type="text" value="${data.name || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('vets', '${id}', 'name', this.value)"></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Clinic</label><input type="text" value="${data.clinic || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('vets', '${id}', 'clinic', this.value)"></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Phone</label><input type="tel" value="${data.phone || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('vets', '${id}', 'phone', this.value)"></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Email</label><input type="email" value="${data.email || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('vets', '${id}', 'email', this.value)"></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Hours</label><input type="text" value="${data.hours || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('vets', '${id}', 'hours', this.value)"></div>
            <div style="flex:1; min-width:200px;"><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Notes</label><textarea class="biz-select" style="padding:0.4rem; width:100%;" rows="1" onchange="autoSaveField('vets', '${id}', 'notes', this.value)">${data.notes || ''}</textarea></div>
        `;
    } else if (type === 'staff') {
        viewFields = detailField('Role', data.role) + detailField('Qualifications', data.qualifications) + detailField('Contact', data.contact) + detailField('Notes', data.notes);
        editFields = `
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Name</label><input type="text" value="${data.name || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('staff', '${id}', 'name', this.value)"></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Role</label><input type="text" value="${data.role || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('staff', '${id}', 'role', this.value)"></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Qualifications</label><input type="text" value="${data.qualifications || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('staff', '${id}', 'qualifications', this.value)"></div>
            <div><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Contact</label><input type="text" value="${data.contact || ''}" class="biz-select" style="padding:0.4rem;" onchange="autoSaveField('staff', '${id}', 'contact', this.value)"></div>
            <div style="flex:1; min-width:200px;"><label style="display:block; font-size:0.75rem; font-weight:600; margin-bottom:0.2rem;">Notes</label><textarea class="biz-select" style="padding:0.4rem; width:100%;" rows="1" onchange="autoSaveField('staff', '${id}', 'notes', this.value)">${data.notes || ''}</textarea></div>
        `;
        // Filled in asynchronously right after render (see call below) — connection
        // status requires a DB read, and this function itself is synchronous.
        setTimeout(() => updateStaffCalendarButton(id), 0);
    }

    const calendarButtonSlot = type === 'staff' ? `<span id="staff-cal-btn-${id}"></span>` : '';

    return `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; padding-bottom:1.25rem; margin-bottom:1.5rem; border-bottom:1px solid var(--border);">
            <div id="details-view-${key}" style="display:flex; flex-wrap:wrap; gap:1.5rem; flex:1;">${viewFields}</div>
            <div id="details-edit-${key}" class="hidden" style="display:flex; flex-wrap:wrap; gap:1rem; flex:1;">${editFields}</div>
            ${calendarButtonSlot}
            <button class="btn-icon" onclick="toggleDetailsEdit('${key}')" title="Edit" style="background:none; border:none; cursor:pointer; flex-shrink:0;"><i data-lucide="pencil" style="width:16px;height:16px;"></i></button>
        </div>
    `;
}

/* ==========================================================================
   UNIFIED RELATIONAL ENTITY SECTIONS (SEARCH-FIRST LINKING FOR ALL TYPES)
   ========================================================================== */

function renderEntitySections(type, data, id) {
    if (type === 'household') {
        return `
            <div style="display:grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap:1.5rem; align-items:start;">
                <div style="display:flex; flex-direction:column; gap:1.5rem;">
                <!-- Household Members -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                        <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;">
                            <i data-lucide="users"></i> Household Members
                        </h3>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="toggleInlineSearchPanel('person', '${id}', 'household')">
                            <i data-lucide="search" style="width:14px;height:14px;"></i> Link Member
                        </button>
                    </div>

                    <div id="search-panel-person-${id}" class="inline-search-panel hidden" style="margin-bottom:1rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover,#f9fafb);">
                        <input type="text" placeholder="Type member name..." class="biz-select" style="width:100%; padding:0.4rem;" onkeyup="executeLiveSearch('person', '${id}', this.value, 'household')">
                        <div id="search-results-person-${id}" style="margin-top:0.5rem; display:flex; flex-direction:column; gap:0.35rem;"></div>
                    </div>

                    ${(data.people || []).filter(p => (p.category || 'member') !== 'other').length ? (data.people || []).filter(p => (p.category || 'member') !== 'other').map(p => renderPersonRow(p, 'household', id)).join('') : '<p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.5rem;">No members attached.</p>'}
                    <button class="btn" style="width:100%; font-size:0.78rem; padding:0.35rem; margin-top:0.75rem; border:1px dashed var(--border);" onclick="toggleInlineSearchPanel('person', '${id}', 'household')">+ Add Member</button>
                </div>

                <!-- Pets -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                        <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;">
                            <i data-lucide="dog"></i> Pets
                        </h3>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="toggleInlineSearchPanel('pet', '${id}', 'household')">
                            <i data-lucide="search" style="width:14px;height:14px;"></i> Link Pet
                        </button>
                    </div>

                    <div id="search-panel-pet-${id}" class="inline-search-panel hidden" style="margin-bottom:1rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover,#f9fafb);">
                        <input type="text" placeholder="Type pet name..." class="biz-select" style="width:100%; padding:0.4rem;" onkeyup="executeLiveSearch('pet', '${id}', this.value, 'household')">
                        <div id="search-results-pet-${id}" style="margin-top:0.5rem; display:flex; flex-direction:column; gap:0.35rem;"></div>
                    </div>

                    ${data.pets && data.pets.length ? data.pets.map(p => renderPetRow(p, { vetsById: data.vetsById || {}, refreshType: 'household', refreshId: id })).join('') : '<p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.5rem;">No pets attached.</p>'}
                    <button class="btn" style="width:100%; font-size:0.78rem; padding:0.35rem; margin-top:0.75rem; border:1px dashed var(--border);" onclick="toggleInlineSearchPanel('pet', '${id}', 'household')">+ Add Pet</button>
                </div>

                <!-- Other Contacts -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
                        <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;">
                            <i data-lucide="user-round"></i> Other Contacts
                        </h3>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="toggleInlineSearchPanel('person-other', '${id}', 'household')">
                            <i data-lucide="search" style="width:14px;height:14px;"></i> Add Contact
                        </button>
                    </div>
                    <p style="font-size:0.75rem; color:var(--text-muted); margin:0 0 0.75rem;">Emergency contacts, relatives, and other relationships.</p>

                    <div id="search-panel-person-other-${id}" class="inline-search-panel hidden" style="margin-bottom:1rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover,#f9fafb);">
                        <input type="text" placeholder="Type contact name..." class="biz-select" style="width:100%; padding:0.4rem;" onkeyup="executeLiveSearch('person-other', '${id}', this.value, 'household')">
                        <div id="search-results-person-other-${id}" style="margin-top:0.5rem; display:flex; flex-direction:column; gap:0.35rem;"></div>
                    </div>

                    ${(data.people || []).filter(p => p.category === 'other').length ? (data.people || []).filter(p => p.category === 'other').map(p => renderPersonRow(p, 'household', id)).join('') : '<p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.5rem;">No other contacts.</p>'}
                </div>

                </div>

                <div style="display:flex; flex-direction:column; gap:1.5rem;">
                ${renderEventsCard(data.bookings, id, { pets: data.pets || [], showPetName: true })}

                <!-- Invoices -->
                <div class="stat-card alert" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                        <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="credit-card"></i> Invoices</h3>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="openInvoiceModal('${id}')">+ Create Invoice</button>
                    </div>
                    ${data.invoices && data.invoices.length ? data.invoices
                        .slice()
                        .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''))
                        .map(inv => {
                            return `
                                <div style="margin-top:0.75rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb);">
                                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:0.5rem;">
                                        <div>
                                            <strong>${inv.description || 'Invoice'}</strong>
                                            <span style="margin-left:0.4rem;">${renderHouseholdInvoiceStatusTag(inv.id, inv.status || 'unpaid', id)}</span>
                                            <div style="font-size:0.82rem; color:var(--text-muted); margin-top:0.2rem;">$${Number(inv.amount || 0).toFixed(2)}${inv.due_date ? ' · Due ' + inv.due_date : ''}</div>
                                            ${inv.notes ? `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.25rem;">${inv.notes}</div>` : ''}
                                        </div>
                                        <div style="display:flex; gap:0.35rem;">
                                            <button class="btn-icon" onclick="${inv.status === 'paid' ? `showReceipt('${inv.id}')` : `showPaymentNotice('${inv.id}')`}" title="${inv.status === 'paid' ? 'View receipt' : 'View payment notice'}" style="background:none; border:none; cursor:pointer;">
                                                <i data-lucide="printer" style="width:14px;height:14px;"></i>
                                            </button>
                                            ${inv.status !== 'paid' ? `
                                                <button class="btn-icon" onclick="markInvoicePaid('${inv.id}', '${id}')" title="Mark as paid" style="background:none; border:none; cursor:pointer;">
                                                    <i data-lucide="check" style="width:14px;height:14px;"></i>
                                                </button>
                                            ` : ''}
                                            <button class="btn-icon" onclick="openInvoiceModal('${id}', '${inv.id}')" title="Edit invoice" style="background:none; border:none; cursor:pointer;">
                                                <i data-lucide="pencil" style="width:14px;height:14px;"></i>
                                            </button>
                                            <button class="btn-icon" onclick="deleteInvoice('${inv.id}', '${id}')" title="Remove invoice" style="background:none; border:none; cursor:pointer;">
                                                <i data-lucide="x" style="width:14px;height:14px;"></i>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join('') : '<p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.5rem;">No unpaid balances on file.</p>'}
                </div>
                </div>

            </div>
        `;
    } else if (type === 'person') {
        return `
            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap:1.5rem;">
                <!-- Linked Household -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <h3 style="margin:0 0 0.75rem 0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="home"></i> Household</h3>

                    ${data.households ? `
                        <div style="padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb);">
                            <div style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;" onclick="openFullWidthProfile('household', '${data.households.id}')">
                                <strong>${data.households.name}</strong>
                                <button class="btn-icon" onclick="event.stopPropagation(); removePersonFromHousehold('${id}', 'person', '${id}')" title="Unlink household" style="background:none; border:none; cursor:pointer;">
                                    <i data-lucide="x" style="width:14px;height:14px;"></i>
                                </button>
                            </div>
                        </div>
                        <div style="margin-top:0.75rem; display:flex; flex-direction:column; gap:0.5rem;">
                            <div>
                                <div style="font-size:0.75rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; margin-bottom:0.35rem;">Members</div>
                                ${data.households.people && data.households.people.length ? data.households.people.map(p => renderPersonRow(p, 'person', id)).join('') : '<p style="font-size:0.82rem; color:var(--text-muted);">No other members.</p>'}
                            </div>
                            <div>
                                <div style="font-size:0.75rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; margin-bottom:0.35rem;">Pets</div>
                                ${data.households.pets && data.households.pets.length ? data.households.pets.map(p => renderPetRow(p, { vetsById: data.households.vetsById || {}, refreshType: 'person', refreshId: id })).join('') : '<p style="font-size:0.82rem; color:var(--text-muted);">No pets on file.</p>'}
                            </div>
                        </div>
                    ` : `
                        <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.75rem;">Unassigned to any household.</p>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="toggleInlineSearchPanel('household', '${id}', 'person')">
                            <i data-lucide="search" style="width:14px;height:14px;"></i> Link Household
                        </button>
                        <div id="search-panel-household-${id}" class="inline-search-panel hidden" style="margin-top:0.75rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover,#f9fafb);">
                            <input type="text" placeholder="Type household name..." class="biz-select" style="width:100%; padding:0.4rem;" onkeyup="executeLiveSearch('household', '${id}', this.value, 'person')">
                            <div id="search-results-household-${id}" style="margin-top:0.5rem; display:flex; flex-direction:column; gap:0.35rem;"></div>
                        </div>
                    `}
                </div>
            </div>
        `;
    } else if (type === 'pet') {
        return `
            <div style="display:grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap:1.5rem; align-items:start;">
                <div style="display:flex; flex-direction:column; gap:1.5rem;">
                <!-- Linked Household -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <h3 style="margin:0 0 0.75rem 0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="home"></i> Household</h3>

                    ${data.households ? `
                        <div style="padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb);">
                            <div style="display:flex; justify-content:space-between; align-items:center; cursor:pointer;" onclick="openFullWidthProfile('household', '${data.households.id}')">
                                <strong>${data.households.name}</strong>
                                <button class="btn-icon" onclick="event.stopPropagation(); removePetFromHousehold('${id}', 'pet', '${id}')" title="Unlink household" style="background:none; border:none; cursor:pointer;">
                                    <i data-lucide="x" style="width:14px;height:14px;"></i>
                                </button>
                            </div>
                        </div>
                        <div style="margin-top:0.75rem; display:flex; flex-direction:column; gap:0.5rem;">
                            <div>
                                <div style="font-size:0.75rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; margin-bottom:0.35rem;">Members</div>
                                ${data.households.people && data.households.people.length ? data.households.people.map(p => renderPersonRow(p, 'pet', id)).join('') : '<p style="font-size:0.82rem; color:var(--text-muted);">No members on file.</p>'}
                            </div>
                            <div>
                                <div style="font-size:0.75rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; margin-bottom:0.35rem;">Pets</div>
                                ${data.households.pets && data.households.pets.length ? data.households.pets.map(p => renderPetRow(p, { vetsById: data.households.vetsById || {}, currentPetId: id, refreshType: 'pet', refreshId: id })).join('') : '<p style="font-size:0.82rem; color:var(--text-muted);">No other pets.</p>'}
                            </div>
                        </div>
                    ` : `
                        <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:0.75rem;">Unassigned to any household.</p>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="toggleInlineSearchPanel('household', '${id}', 'pet')">
                            <i data-lucide="search" style="width:14px;height:14px;"></i> Link Household
                        </button>
                        <div id="search-panel-household-${id}" class="inline-search-panel hidden" style="margin-top:0.75rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover,#f9fafb);">
                            <input type="text" placeholder="Type household name..." class="biz-select" style="width:100%; padding:0.4rem;" onkeyup="executeLiveSearch('household', '${id}', this.value, 'pet')">
                            <div id="search-results-household-${id}" style="margin-top:0.5rem; display:flex; flex-direction:column; gap:0.35rem;"></div>
                        </div>
                        <div style="margin-top:1rem; padding-top:0.75rem; border-top:1px solid var(--border);">
                            <div style="font-size:0.75rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; margin-bottom:0.35rem;">Vets</div>
                            ${renderPetRow(data, { vetsById: { ...(data.vet ? { [data.vet.id]: data.vet } : {}), ...(data.emergencyVet ? { [data.emergencyVet.id]: data.emergencyVet } : {}) }, currentPetId: id, refreshType: 'pet', refreshId: id })}
                        </div>
                    `}
                </div>

                <!-- Assigned Staff -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <h3 style="margin:0 0 0.75rem 0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="user-cog"></i> Assigned Staff</h3>
                    ${data.assignedStaff && data.assignedStaff.length ? data.assignedStaff.map(a => `
                        <div style="padding:0.6rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb); margin-bottom:0.4rem; cursor:pointer;" onclick="switchView('crm-view'); openFullWidthProfile('staff', '${a.staff_id}')">
                            <strong>${a.staff?.name || 'Staff'}</strong> <span style="color:var(--text-muted); font-size:0.8rem;">${a.staff?.role || ''}</span>
                        </div>
                    `).join('') : '<p style="font-size:0.85rem; color:var(--text-muted);">No staff assigned.</p>'}
                </div>
                </div>

                <div style="display:flex; flex-direction:column; gap:1.5rem;">
                ${renderEventsCard(data.bookings, data.households?.id || data.household_id, { showPetName: false })}

                <!-- Tasks linked to this pet -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                        <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="list-checks"></i> Tasks</h3>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="openStaffTaskModalForPet('${id}', '${(data.name || 'Pet').replace(/'/g, "\\'")}')">+ Add Task</button>
                    </div>
                    ${data.tasks && data.tasks.length ? data.tasks.map(t => `
                        <div style="display:flex; align-items:center; justify-content:space-between; padding:0.5rem 0.6rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb); margin-bottom:0.4rem;">
                            <div>
                                <input type="checkbox" ${t.is_done ? 'checked' : ''} onchange="toggleStaffTaskOnPetProfile('${t.id}', ${!t.is_done}, '${id}')">
                                <span style="${t.is_done ? 'text-decoration:line-through;color:var(--text-muted);' : ''}">${t.task_text}</span>
                                ${t.visible_to_customer ? '<i data-lucide="eye" style="width:12px;height:12px;color:var(--primary); margin-left:0.3rem;" title="Visible to customer"></i>' : ''}
                                <span style="font-size:0.78rem; color:var(--text-muted); margin-left:0.4rem;">${t.staff?.name ? '· ' + t.staff.name : ''} ${t.due_date ? '· Due ' + t.due_date : ''}</span>
                            </div>
                            <div>
                                <button class="btn-icon" style="background:none;border:none;cursor:pointer;padding:0.25rem;" onclick="openStaffTaskModalFromPet('${t.id}', '${id}')" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px;"></i></button>
                                <button class="btn-icon" style="background:none;border:none;cursor:pointer;padding:0.25rem;color:var(--danger-text);" onclick="deleteStaffTaskOnPetProfile('${t.id}', '${id}')" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
                            </div>
                        </div>
                    `).join('') : '<p style="font-size:0.85rem; color:var(--text-muted);">No tasks for this pet yet.</p>'}
                </div>

                <!-- Assessments (placeholder — feature not built yet) -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <h3 style="margin:0 0 0.5rem 0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="clipboard-check"></i> Assessments</h3>
                    <p style="font-size:0.85rem; color:var(--text-muted);">Behavior and training assessments will live here. Coming soon.</p>
                </div>

                <!-- History (placeholder) -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <h3 style="margin:0 0 0.5rem 0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="clipboard-list"></i> History</h3>
                    <p style="font-size:0.85rem; color:var(--text-muted);">Progress reports and visit notes will live here. Coming soon.</p>
                </div>
                </div>
            </div>
        `;
    } else if (type === 'vet') {
        return `
            <div style="display:flex; flex-direction:column; gap:1.5rem;">
                <!-- Vet Client Pets -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <h3 style="margin:0 0 0.5rem 0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="building"></i> Client Pets</h3>
                    <p style="font-size:0.75rem; color:var(--text-muted); margin:0 0 0.75rem;">Pets that use this vet as their regular or emergency vet.</p>

                    <input type="text" placeholder="Search or filter clients (pet, species, household, owner)..." class="biz-select" style="width:100%; padding:0.4rem; margin-bottom:0.5rem;" onkeyup="executeVetPetSearch('${id}', this.value); filterVetClientGroups('${id}', this.value);">
                    <div id="vet-pet-search-results-${id}" style="display:flex; flex-direction:column; gap:0.35rem; margin-bottom:0.75rem;"></div>

                    <div id="vet-client-groups-${id}">${renderVetClientGroups(data.clientPets || [], id)}</div>
                </div>
            </div>
        `;
    } else if (type === 'staff') {
        return `
            <div style="display:grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); gap:1.5rem; align-items:start;">
                <div style="display:flex; flex-direction:column; gap:1.5rem;">
                <!-- Assigned Pets -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                        <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="paw-print"></i> Assigned Pets</h3>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="toggleInlineSearchPanel('staff-pet', '${id}', 'staff')">
                            <i data-lucide="search" style="width:14px;height:14px;"></i> Assign Pet
                        </button>
                    </div>
                    <div id="search-panel-staff-pet-${id}" class="inline-search-panel hidden" style="margin-bottom:1rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover,#f9fafb);">
                        <input type="text" placeholder="Type pet name..." class="biz-select" style="width:100%; padding:0.4rem;" onkeyup="executeLiveSearch('staff-pet', '${id}', this.value, 'staff')">
                        <div id="search-results-staff-pet-${id}" style="margin-top:0.5rem; display:flex; flex-direction:column; gap:0.35rem;"></div>
                    </div>
                    ${data.assignments && data.assignments.length ? data.assignments.map(a => `
                        <div style="margin-top:0.75rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb); cursor:pointer;" onclick="openFullWidthProfile('pet', '${a.pets?.id || a.pet_id}')">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <strong><i data-lucide="${a.pets?.species === 'cat' ? 'cat' : a.pets?.species === 'other' ? 'rabbit' : 'dog'}" style="width:15px;height:15px;"></i> ${a.pets?.name || 'Pet'}</strong>
                                <button class="btn-icon" onclick="event.stopPropagation(); removeAssignment('${a.id}')" title="Unassign" style="background:none; border:none; cursor:pointer;"><i data-lucide="x" style="width:14px;height:14px;"></i></button>
                            </div>
                            ${a.pets?.households?.name ? `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.15rem;">${a.pets.households.name}</div>` : ''}
                        </div>
                    `).join('') : '<p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.5rem;">No pets assigned.</p>'}
                </div>

                <!-- Time Off -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                        <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="calendar-off"></i> Time Off</h3>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="openStaffAvailModal(null, '${id}')">+ Add Time Off</button>
                    </div>
                    ${data.timeOff && data.timeOff.length ? data.timeOff.map(t => `
                        <div style="margin-top:0.6rem; padding:0.6rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb); display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <strong>${t.reason || 'Time Off'}</strong>
                                <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.1rem;">${t.start_date}${t.end_date && t.end_date !== t.start_date ? ' → ' + t.end_date : ''}</div>
                                ${t.notes ? `<div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.1rem;">${t.notes}</div>` : ''}
                            </div>
                            <button class="btn-icon" onclick="deleteStaffTimeOff('${t.id}', '${id}')" title="Remove" style="background:none; border:none; cursor:pointer; color:var(--danger-text);"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
                        </div>
                    `).join('') : '<p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.5rem;">No time off scheduled.</p>'}
                </div>
                </div>

                <div style="display:flex; flex-direction:column; gap:1.5rem;">
                ${renderEventsCard(data.bookings, null, { showPetName: true })}

                <!-- Tasks -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                        <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="list-checks"></i> Tasks</h3>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="openStaffTaskModalFor('${id}')">+ Add Task</button>
                    </div>
                    ${data.tasks && data.tasks.length ? data.tasks.map(t => `
                        <div style="margin-top:0.75rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb); display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <input type="checkbox" ${t.is_done ? 'checked' : ''} onchange="toggleStaffTaskOnProfile('${t.id}', ${!t.is_done}, '${id}')">
                                <span style="${t.is_done ? 'text-decoration:line-through;color:var(--text-muted);' : ''}">${t.task_text}</span>
                                <div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.15rem; margin-left:1.5rem;">Due ${t.due_date || 'no date'}</div>
                            </div>
                            <button class="btn-icon" onclick="deleteStaffTaskOnProfile('${t.id}', '${id}')" title="Delete" style="background:none; border:none; cursor:pointer; color:var(--danger-text);"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
                        </div>
                    `).join('') : '<p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.5rem;">No tasks assigned.</p>'}
                </div>
                </div>
            </div>
        `;
    }
}

/**
 * Direct Auto-Save Field Updater for Supabase
 */
async function autoSaveField(table, id, field, value) {
    const statusEl = document.getElementById('auto-save-status');
    if (statusEl) statusEl.textContent = 'Saving changes…';

    const client = getSupabase();
    if (!client) return;

    const payload = {};
    payload[field] = value.trim();

    const { error } = await client.from(table).update(payload).eq('id', id);

    if (error) {
        if (statusEl) statusEl.textContent = '⚠️ Save failed: ' + error.message;
    } else {
        if (statusEl) statusEl.textContent = '✓ Saved to database';
        const typeMap = { households: 'household', people: 'person', pets: 'pet', vets: 'vet' };
        const profileType = typeMap[table];
        if (profileType) {
            openFullWidthProfile(profileType, id);
        } else if (typeof renderAllDashboards === 'function') {
            renderAllDashboards();
        }
    }
}

async function setPreferredContact(personId, method, isCurrentlyActive) {
    const client = getSupabase();
    if (!client) return;
    const newValue = isCurrentlyActive ? null : method; // clicking the active star again clears it
    await client.from('people').update({ preferred_contact: newValue }).eq('id', personId);
    openFullWidthProfile('person', personId);
}

async function savePersonNameField(id, field, value) {
    const statusEl = document.getElementById('auto-save-status');
    if (statusEl) statusEl.textContent = 'Saving changes…';

    const client = getSupabase();
    if (!client) return;

    const trimmed = value.trim();
    const otherField = field === 'first_name' ? 'last_name' : 'first_name';
    const otherInput = document.getElementById(field === 'first_name' ? 'person-last-name' : 'person-first-name');
    const otherValue = otherInput ? otherInput.value.trim() : '';

    const payload = { [field]: trimmed };
    payload.name = field === 'first_name'
        ? `${trimmed} ${otherValue}`.trim()
        : `${otherValue} ${trimmed}`.trim();

    const { error } = await client.from('people').update(payload).eq('id', id);

    if (error) {
        if (statusEl) statusEl.textContent = '⚠️ Save failed: ' + error.message;
    } else {
        if (statusEl) statusEl.textContent = '✓ Saved to database';
        if (typeof renderAllDashboards === 'function') {
            renderAllDashboards();
        }
    }
}

function toggleDetailsEdit(key) {
    const viewEl = document.getElementById(`details-view-${key}`);
    const editEl = document.getElementById(`details-edit-${key}`);
    if (viewEl) viewEl.classList.toggle('hidden');
    if (editEl) editEl.classList.toggle('hidden');
}

function speciesLabel(p) {
    return p.species === 'other' && p.species_other ? p.species_other : p.species;
}

function personDisplayName(p) {
    const combined = `${p.first_name || ''} ${p.last_name || ''}`.trim();
    return combined || p.name || '';
}

function personDisplayContact(p) {
    const email = p.email ? (p.preferred_contact === 'email' ? '★ ' + p.email : p.email) : null;
    const phone = p.phone ? (p.preferred_contact === 'phone' ? '★ ' + p.phone : p.phone) : null;
    return [email, phone].filter(Boolean).join(' · ') || p.contact || '';
}

function renderPetRow(p, opts) {
    const { vetsById = {}, currentPetId = null, refreshType = 'household', refreshId } = opts;
    const isCurrent = currentPetId && p.id === currentPetId;
    const regular = p.vet_id ? vetsById[p.vet_id] : null;
    const emergency = p.emergency_vet_id ? vetsById[p.emergency_vet_id] : null;

    const vetLine = (label, vet, column) => `
        <div style="margin-top:0.3rem; padding-left:1.35rem; display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:0.78rem; color:var(--text-muted); ${vet ? 'cursor:pointer;' : ''}" ${vet ? `onclick="event.stopPropagation(); openFullWidthProfile('vet', '${vet.id}')"` : ''}>
                <i data-lucide="stethoscope" style="width:11px;height:11px;"></i> ${label}: ${vet ? vet.name : 'None linked'}${vet && (vet.phone || vet.email) ? ' — ' + [vet.phone, vet.email].filter(Boolean).join(' · ') : ''}
            </span>
            ${isCurrent ? `
                <span style="display:flex; gap:0.3rem;">
                    ${vet ? `<button class="btn-icon" onclick="event.stopPropagation(); unlinkPetVet('${p.id}', '${column}')" title="Unlink" style="background:none; border:none; cursor:pointer;"><i data-lucide="x" style="width:11px;height:11px;"></i></button>`
                          : `<button class="btn-icon" onclick="event.stopPropagation(); toggleInlineSearchPanel('${column === 'vet_id' ? 'vet-regular' : 'vet-emergency'}', '${p.id}', 'pet')" title="Link" style="background:none; border:none; cursor:pointer;"><i data-lucide="search" style="width:11px;height:11px;"></i></button>`}
                </span>
            ` : ''}
        </div>
        ${isCurrent ? `
            <div id="search-panel-${column === 'vet_id' ? 'vet-regular' : 'vet-emergency'}-${p.id}" class="inline-search-panel hidden" style="margin:0.35rem 0 0 1.35rem; padding:0.6rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-card);">
                <input type="text" placeholder="Type doctor or clinic..." class="biz-select" style="width:100%; padding:0.35rem; font-size:0.8rem;" onclick="event.stopPropagation();" onkeyup="event.stopPropagation(); executeLiveSearch('${column === 'vet_id' ? 'vet-regular' : 'vet-emergency'}', '${p.id}', this.value, 'pet')">
                <div id="search-results-${column === 'vet_id' ? 'vet-regular' : 'vet-emergency'}-${p.id}" style="margin-top:0.4rem; display:flex; flex-direction:column; gap:0.3rem;"></div>
            </div>
        ` : ''}
    `;

    return `
        <div style="margin-top:0.75rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb); ${isCurrent ? '' : 'cursor:pointer;'}" ${isCurrent ? '' : `onclick="openFullWidthProfile('pet', '${p.id}')"`}>
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <strong><i data-lucide="${p.species === 'cat' ? 'cat' : p.species === 'other' ? 'rabbit' : 'dog'}" style="width:16px;height:16px;"></i> ${p.name}</strong>
                <div style="display:flex; align-items:center; gap:0.5rem;">
                    <span style="font-size:0.75rem; color:var(--text-muted);">${speciesLabel(p)}</span>
                    ${!isCurrent ? `<button class="btn-icon" onclick="event.stopPropagation(); removePetFromHousehold('${p.id}', '${refreshType}', '${refreshId}')" title="Remove from household" style="background:none; border:none; cursor:pointer;"><i data-lucide="x" style="width:14px;height:14px;"></i></button>` : ''}
                </div>
            </div>
            ${vetLine('Regular', regular, 'vet_id')}
            ${vetLine('Emergency', emergency, 'emergency_vet_id')}
        </div>
    `;
}

function renderVetClientGroups(clientPets, vetId) {
    if (!clientPets.length) return '<p style="font-size:0.85rem; color:var(--text-muted);">No pets are currently linked to this vet.</p>';

    const groups = {}; // householdKey -> { name, people, pets: [] }
    clientPets.forEach(p => {
        const key = p.households?.name || p.household_id || 'unassigned';
        if (!groups[key]) groups[key] = { name: p.households?.name || 'No household', people: p.households?.people || [], pets: [] };
        groups[key].pets.push(p);
    });

    return Object.values(groups).map(g => `
        <div style="margin-top:0.5rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb); display:grid; grid-template-columns: 1fr 1fr 1fr; gap:1rem;">
            <div>
                <div style="font-size:0.7rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; margin-bottom:0.35rem;">Household</div>
                <strong style="font-size:0.85rem; cursor:pointer;" onclick="openFullWidthProfile('household', '${g.pets[0]?.household_id || ''}')"><i data-lucide="home" style="width:13px;height:13px;"></i> ${g.name}</strong>
            </div>
            <div>
                <div style="font-size:0.7rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; margin-bottom:0.35rem;">Pets</div>
                ${g.pets.map(p => `
                    <div style="display:flex; align-items:center; gap:0.5rem; margin-top:0.25rem; cursor:pointer;" onclick="openFullWidthProfile('pet', '${p.id}')">
                        <span style="font-size:0.85rem;"><i data-lucide="${p.species === 'cat' ? 'cat' : p.species === 'other' ? 'rabbit' : 'dog'}" style="width:13px;height:13px;"></i> ${p.name} (${speciesLabel(p)})</span>
                        <span style="font-size:0.72rem; padding:0.1rem 0.45rem; border-radius:9999px; border:1px solid var(--border); color:var(--text-muted);">${p.vet_id === vetId ? 'Regular' : 'Emergency'}</span>
                    </div>
                `).join('')}
            </div>
            <div>
                <div style="font-size:0.7rem; font-weight:600; color:var(--text-muted); text-transform:uppercase; margin-bottom:0.35rem;">People</div>
                ${g.people.length ? g.people.map(person => `
                    <div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.3rem;">
                        <i data-lucide="user" style="width:11px;height:11px;"></i> ${personDisplayName(person)}${personDisplayContact(person) ? ' — ' + personDisplayContact(person) : ''}
                    </div>
                `).join('') : '<span style="font-size:0.78rem; color:var(--text-muted);">—</span>'}
            </div>
        </div>
    `).join('');
}

function filterVetClientGroups(vetId, query) {
    const container = document.getElementById(`vet-client-groups-${vetId}`);
    if (!container) return;
    const all = (window.__vetClientPetsCache && window.__vetClientPetsCache[vetId]) || [];
    const q = query.trim().toLowerCase();

    const filtered = !q ? all : all.filter(p => {
        const memberMatch = (p.households?.people || []).some(person =>
            personDisplayName(person).toLowerCase().includes(q) || (personDisplayContact(person) || '').toLowerCase().includes(q)
        );
        return (p.name || '').toLowerCase().includes(q)
            || (speciesLabel(p) || '').toLowerCase().includes(q)
            || (p.households?.name || '').toLowerCase().includes(q)
            || memberMatch;
    });

    container.innerHTML = renderVetClientGroups(filtered, vetId);
    refreshIcons();
}

async function executeVetPetSearch(vetId, query) {
    const container = document.getElementById(`vet-pet-search-results-${vetId}`);
    if (!container) return;
    const q = query.trim().toLowerCase();
    if (!q) { container.innerHTML = ''; return; }

    const client = getSupabase();
    if (!client) return;

    const { data: allPets } = await client.from('pets').select('*, households(name, people(*))').limit(200);

    const pets = (allPets || []).filter(p => {
        const memberMatch = (p.households?.people || []).some(person =>
            personDisplayName(person).toLowerCase().includes(q) || (personDisplayContact(person) || '').toLowerCase().includes(q)
        );
        return (p.name || '').toLowerCase().includes(q)
            || (speciesLabel(p) || '').toLowerCase().includes(q)
            || (p.households?.name || '').toLowerCase().includes(q)
            || memberMatch;
    }).slice(0, 8);

    container.innerHTML = pets.length ? pets.map(p => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:0.25rem; background:var(--bg-card); font-size:0.82rem;">
            <span><strong>${p.name}</strong> ${p.households?.name ? '(' + p.households.name + ')' : ''}</span>
            <span style="display:flex; gap:0.3rem;">
                <button class="btn btn-primary" style="font-size:0.7rem; padding:0.2rem 0.4rem;" onclick="linkPetToVet('${p.id}', '${vetId}', 'vet_id')">Set Regular</button>
                <button class="btn" style="font-size:0.7rem; padding:0.2rem 0.4rem;" onclick="linkPetToVet('${p.id}', '${vetId}', 'emergency_vet_id')">Set Emergency</button>
            </span>
        </div>
    `).join('') : '<div style="font-size:0.8rem; color:var(--text-muted); padding:0.25rem 0;">No matching pets found.</div>';
}

async function linkPetToVet(petId, vetId, column) {
    const client = getSupabase();
    if (!client) return;
    await client.from('pets').update({ [column]: vetId }).eq('id', petId);
    openFullWidthProfile('vet', vetId);
}

async function setBookingStatusInProfile(kind, id, newStatus) {
    const client = getSupabase();
    if (!client) return;

    if (kind === 'appointment') {
        await client.from('bookings').update({ status: newStatus }).eq('id', id);
        if (newStatus === 'confirmed' || newStatus === 'cancelled') {
            notifyEmail(newStatus === 'confirmed' ? 'booking-confirmed' : 'booking-declined', { bookingId: id });
        }
    } else if (kind === 'invoice') {
        const payload = { status: newStatus };
        if (newStatus === 'paid') {
            payload.paid_date = new Date().toISOString().slice(0, 10);
            payload.payment_method = await promptForPaymentMethod();
        }
        await client.from('invoices').update(payload).eq('id', id);
        if (newStatus === 'paid') {
            showReceipt(id);
            notifyEmail('payment-received', { invoiceId: id });
        }
    }

    try {
        const last = JSON.parse(localStorage.getItem('barkboard-last-profile') || 'null');
        if (last && last.type && last.id) {
            openFullWidthProfile(last.type, last.id);
            return;
        }
    } catch (e) { /* storage unavailable, ignore */ }
    if (typeof renderAllDashboards === 'function') renderAllDashboards();
}

async function setStaffFeedAppointmentStatus(kind, id, newStatus) {
    const client = getSupabase();
    if (!client) return;
    await client.from('bookings').update({ status: newStatus }).eq('id', id);
    if (newStatus === 'confirmed' || newStatus === 'cancelled') {
        notifyEmail(newStatus === 'confirmed' ? 'booking-confirmed' : 'booking-declined', { bookingId: id });
    }
    renderStaffGuests();
    if (typeof renderTodaysOverview === 'function') renderTodaysOverview();
}

async function setStaffFeedInvoiceStatus(kind, id, newStatus) {
    const client = getSupabase();
    if (!client) return;
    const payload = { status: newStatus };
    if (newStatus === 'paid') {
        payload.paid_date = new Date().toISOString().slice(0, 10);
        payload.payment_method = await promptForPaymentMethod();
    }
    await client.from('invoices').update(payload).eq('id', id);
    if (newStatus === 'paid') {
        showReceipt(id);
        notifyEmail('payment-received', { invoiceId: id });
    }
    renderStaffGuests();
    if (typeof renderTodaysOverview === 'function') renderTodaysOverview();
}

function renderEventsCard(bookings, householdId, opts) {
    const { pets = [], showPetName = true } = opts || {};
    const addButton = householdId
        ? `<button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="openBookingModal('${householdId}')">+ Add Event</button>`
        : '';
    const list = bookings && bookings.length ? bookings
        .slice()
        .sort((a, b) => (a.check_in || '').localeCompare(b.check_in || ''))
        .map(bk => {
            const petName = showPetName ? (pets.find(p => p.id === bk.pet_id)?.name || 'No pet linked') : null;
            const inDate = bk.check_in ? bk.check_in.slice(0, 10) : '';
            const inTime = bk.check_in ? bk.check_in.slice(11, 16) : '';
            const outDate = bk.check_out ? bk.check_out.slice(0, 10) : '';
            const isStay = outDate && outDate !== inDate;
            const when = isStay ? `${inDate} → ${outDate}` : `${inDate}${inTime ? ' at ' + inTime : ''}`;
            return `
                <div style="margin-top:0.75rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb); max-width:100%; overflow:hidden;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:0.5rem;">
                        <div style="flex:1; min-width:0; overflow-wrap:break-word; word-break:break-word;">
                            <strong style="overflow-wrap:break-word; word-break:break-word;">${bk.service_name || (isStay ? 'Stay' : 'Appointment')}</strong>
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.3rem; gap:0.5rem; flex-wrap:wrap;">
                                <span style="font-size:0.82rem; color:var(--text-muted);">${when}</span>
                                <span onclick="event.stopPropagation();" style="display:inline-block;">${renderStatusTag('appointment', bk.id, bk.status || 'pending', 'setBookingStatusInProfile')}</span>
                            </div>
                            ${bk.amount || bk.invoice_id ? `
                                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.25rem; gap:0.5rem; flex-wrap:wrap;">
                                    <span style="font-size:0.82rem; color:var(--text-muted);">${bk.amount ? '$' + Number(bk.amount).toFixed(2) : ''}</span>
                                    ${bk.invoice_id ? `<span onclick="event.stopPropagation();" style="display:inline-block;">${renderStatusTag('invoice', bk.invoice_id, bk.invoiceStatus || 'unpaid', 'setBookingStatusInProfile')}</span>` : ''}
                                </div>
                            ` : ''}
                            ${petName ? `<div style="font-size:0.82rem; color:var(--text-muted); margin-top:0.3rem; overflow-wrap:break-word; word-break:break-word;"><i data-lucide="dog" style="width:12px;height:12px;"></i> ${petName}</div>` : ''}
                            ${(bk.resourceAssignments || []).map(r => `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.1rem; overflow-wrap:break-word; word-break:break-word;"><i data-lucide="bed-double" style="width:12px;height:12px;"></i> ${r.name}${r.allDay ? ' (all day)' : (r.startTime ? ' (' + r.startTime.slice(0,5) + (r.endTime ? '–' + r.endTime.slice(0,5) : '') + ')' : ' (time-based)')}</div>`).join('')}
                            ${bk.requires_staff_time ? `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.1rem; overflow-wrap:break-word; word-break:break-word;"><i data-lucide="clock" style="width:12px;height:12px;"></i> ${bk.staff_time_minutes || '?'} min/day staff time${bk.staff_time_resource?.name ? ' · ' + bk.staff_time_resource.name : ''}</div>` : ''}
                            ${bk.notes && !bk.google_event_id ? `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.25rem; overflow-wrap:break-word; word-break:break-word;">${bk.notes}</div>` : ''}
                        </div>
                        <div style="display:flex; gap:0.35rem; flex-shrink:0;">
                            <button class="btn-icon" onclick="openBookingModal('${householdId}', '${bk.id}')" title="Edit event" style="background:none; border:none; cursor:pointer;">
                                <i data-lucide="pencil" style="width:14px;height:14px;"></i>
                            </button>
                            <button class="btn-icon" onclick="deleteBooking('${bk.id}', '${householdId}')" title="Remove event" style="background:none; border:none; cursor:pointer;">
                                <i data-lucide="x" style="width:14px;height:14px;"></i>
                            </button>
                        </div>
                    </div>
                    ${bk.google_event_id ? `<div style="font-size:0.72rem; color:var(--text-muted); margin-top:0.4rem; display:flex; align-items:center; gap:0.3rem;"><i data-lucide="calendar-sync" style="width:11px;height:11px;"></i> Synced from Google Calendar</div>` : ''}
                </div>
            `;
        }).join('') : '<p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.5rem;">No active bookings found.</p>';

    return `
        <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="calendar"></i> Scheduled Events</h3>
                ${addButton}
            </div>
            ${list}
        </div>
    `;
}

function renderPersonRow(p, refreshType, refreshId) {
    return `
        <div style="margin-top:0.75rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb); cursor:pointer;" onclick="openFullWidthProfile('person', '${p.id}')">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <strong>${personDisplayName(p)}</strong>
                <div style="display:flex; align-items:center; gap:0.5rem;">
                    <select onclick="event.stopPropagation();" onchange="event.stopPropagation(); autoSaveField('people', '${p.id}', 'role', this.value)" style="font-size:0.75rem; padding:0.15rem 0.35rem; background:var(--bg-card); border:1px solid var(--border); border-radius:9999px; cursor:pointer;">
                        <option value="Primary" ${p.role === 'Primary' ? 'selected' : ''}>Primary</option>
                        <option value="Backup" ${p.role !== 'Primary' ? 'selected' : ''}>Backup</option>
                    </select>
                    <button class="btn-icon" onclick="event.stopPropagation(); removePersonFromHousehold('${p.id}', '${refreshType}', '${refreshId}')" title="Remove from household" style="background:none; border:none; cursor:pointer;">
                        <i data-lucide="x" style="width:14px;height:14px;"></i>
                    </button>
                </div>
            </div>
            <div style="font-size:0.82rem; color:var(--text-muted); margin-top:0.25rem;"><i data-lucide="phone" style="width:12px;height:12px;"></i> ${personDisplayContact(p) || 'No contact set'}</div>
            ${p.notes ? `<div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.15rem; font-style:italic;">${p.notes}</div>` : ''}
        </div>
    `;
}

/* ==========================================================================
   UNIVERSAL INLINE LIVE SEARCH & CROSS-ENTITY LINKING
   ========================================================================== */

function toggleInlineSearchPanel(targetEntityType, sourceEntityId, sourceEntityType) {
    const panel = document.getElementById(`search-panel-${targetEntityType}-${sourceEntityId}`);
    if (panel) {
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) {
            executeLiveSearch(targetEntityType, sourceEntityId, '', sourceEntityType);
        }
    }
}

async function executeLiveSearch(targetType, sourceId, query, sourceType) {
    const container = document.getElementById(`search-results-${targetType}-${sourceId}`);
    if (!container) return;

    const client = getSupabase();
    if (!client) return;

    const tableMap = { person: 'people', 'person-other': 'people', pet: 'pets', vet: 'vets', household: 'households', 'vet-regular': 'vets', 'vet-emergency': 'vets', 'staff-pet': 'pets' };
    const labelMap = { person: 'Person', 'person-other': 'Contact', pet: 'Pet', vet: 'Vet', household: 'Household', 'vet-regular': 'Vet', 'vet-emergency': 'Vet', 'staff-pet': 'Pet' };
    const table = tableMap[targetType];

    let dbQuery = client.from(table).select('*').limit(5);
    // A person/pet can only belong to one household, so only offer unlinked ones to link
    // as a Member/Pet. Other Contacts can reuse any existing contact regardless of household.
    if (targetType === 'person' || targetType === 'pet') {
        dbQuery = dbQuery.is('household_id', null);
    }
    if (query.trim()) {
        dbQuery = dbQuery.ilike('name', `%${query.trim()}%`);
    }

    const { data: results } = await dbQuery;

    let html = '';

    if (results && results.length > 0) {
        html = results.map(r => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:0.25rem; background:var(--bg-card); font-size:0.82rem;">
                <span><strong>${r.name}</strong> ${r.clinic ? '(' + r.clinic + ')' : (r.contact || r.email || r.phone) ? '(' + (r.contact || r.email || r.phone) + ')' : ''}</span>
                <button class="btn btn-primary" style="font-size:0.72rem; padding:0.2rem 0.45rem;" onclick="linkEntities('${targetType}', '${r.id}', '${sourceId}', '${sourceType || ''}')">Link</button>
            </div>
        `).join('');
    } else {
        html = `<div style="font-size:0.8rem; color:var(--text-muted); padding:0.25rem 0;">No matching ${labelMap[targetType].toLowerCase()}s found.</div>`;
    }

    // Dynamic + Create New fallback button
    html += `
        <button class="btn" style="width:100%; font-size:0.78rem; padding:0.35rem; margin-top:0.25rem; border:1px dashed var(--border);" onclick="createNewEntityFallback('${targetType}', '${sourceId}', '${sourceType || ''}')">
            + Create New ${labelMap[targetType]}
        </button>
    `;

    container.innerHTML = html;
}

async function linkEntities(targetType, targetId, sourceId, sourceType) {
    const client = getSupabase();
    if (!client) return;

    if (targetType === 'household') {
        await client.from('people').update({ household_id: targetId }).eq('id', sourceId);
        await client.from('pets').update({ household_id: targetId }).eq('id', sourceId);
    } else if (targetType === 'vet-regular') {
        await client.from('pets').update({ vet_id: targetId }).eq('id', sourceId);
    } else if (targetType === 'vet-emergency') {
        await client.from('pets').update({ emergency_vet_id: targetId }).eq('id', sourceId);
    } else if (targetType === 'person-other') {
        await client.from('people').update({ household_id: sourceId, category: 'other' }).eq('id', targetId);
    } else if (targetType === 'staff-pet') {
        const { data: existing } = await client.from('staff_assignments').select('id').eq('staff_id', sourceId).eq('pet_id', targetId).limit(1);
        if (existing && existing.length) {
            alert('This pet is already assigned to this staff member.');
        } else {
            await client.from('staff_assignments').insert([{ staff_id: sourceId, pet_id: targetId, business_id: currentBusinessId }]);
        }
    } else {
        await client.from(targetType === 'person' ? 'people' : 'pets').update({ household_id: sourceId }).eq('id', targetId);
    }

    // Refresh whichever profile we were viewing when the link happened, instead
    // of dropping back to the list view.
    if (sourceType) {
        openFullWidthProfile(sourceType, sourceId);
    } else if (typeof renderAllDashboards === 'function') {
        renderAllDashboards();
    }
}

async function unlinkPetVet(petId, column) {
    const client = getSupabase();
    if (!client) return;
    await client.from('pets').update({ [column]: null }).eq('id', petId);
    openFullWidthProfile('pet', petId);
}

async function removePersonFromHousehold(personId, refreshType, refreshId) {
    if (!confirm('Remove this person from the household?')) return;
    const client = getSupabase();
    if (!client) return;
    await client.from('people').update({ household_id: null }).eq('id', personId);
    openFullWidthProfile(refreshType, refreshId);
}

async function removePetFromHousehold(petId, refreshType, refreshId) {
    if (!confirm('Remove this pet from the household?')) return;
    const client = getSupabase();
    if (!client) return;
    await client.from('pets').update({ household_id: null }).eq('id', petId);
    openFullWidthProfile(refreshType, refreshId);
}

let activeLinkingHouseholdId = null;

// Where to return after a "+ Create New X" flow launched from inside another
// profile's link-search panel, so saving doesn't dump the user back to the list view.
let returnToProfile = null; // { type, id } | null
let pendingPetVetLink = null; // { petId, column } | null — which pet/slot to link a newly-created vet to
let pendingPersonCategory = null; // 'other' | null — set before opening the person modal via "+ Add Contact"

function createNewEntityFallback(targetType, sourceId, sourceType) {
    returnToProfile = sourceType ? { type: sourceType, id: sourceId } : null;

    if (targetType === 'person') {
        openPersonModal(null, sourceId);
    } else if (targetType === 'person-other') {
        pendingPersonCategory = 'other';
        openPersonModal(null, sourceId);
    } else if (targetType === 'pet') {
        openPetModal();
        setTimeout(() => {
            const sel = document.getElementById('pet-household-id');
            if (sel) sel.value = sourceId;
        }, 100);
    } else if (targetType === 'vet-regular' || targetType === 'vet-emergency') {
        pendingPetVetLink = sourceType === 'pet' ? { petId: sourceId, column: targetType === 'vet-regular' ? 'vet_id' : 'emergency_vet_id' } : null;
        openVetModal();
    } else if (targetType === 'vet') {
        openVetModal();
    } else if (targetType === 'household') {
        openHouseholdModal();
    }
}

function openPersonModal(personId = null, householdId = null) {
    activeLinkingHouseholdId = householdId;
    editingHouseholdId = null;
    householdModalContext = 'person';

    const titleEl = document.getElementById('household-modal-title');
    const nameInput = document.getElementById('hh-name');
    const labelEl = document.getElementById('hh-name-label');
    const hiddenIdInput = document.getElementById('selected-household-id');
    const contactNameInput = document.getElementById('hh-contact-name');
    const contactInfoInput = document.getElementById('hh-contact-info');
    const addressInput = document.getElementById('hh-address');
    const noteInput = document.getElementById('hh-notes');
    const dropdown = document.getElementById('hh-search-dropdown');

    if (titleEl) titleEl.textContent = personId ? 'Edit Person Details' : 'Add New Person';
    if (labelEl) labelEl.textContent = 'Select Household *';

    // Adding a person needs their contact details, and the search dropdown here
    // searches households (to pick which one this person belongs to).
    if (contactNameInput && contactNameInput.parentElement) contactNameInput.parentElement.style.display = 'block';
    if (contactInfoInput && contactInfoInput.parentElement) contactInfoInput.parentElement.style.display = 'block';
    if (dropdown) {
        dropdown.classList.add('hidden');
        dropdown.innerHTML = '';
    }

    // Hide physical address input (belongs to Household level)
    if (addressInput && addressInput.parentElement) {
        addressInput.parentElement.style.display = 'none';
    }

    // Reset Person fields
    if (contactNameInput) contactNameInput.value = '';
    if (contactInfoInput) contactInfoInput.value = '';
    if (noteInput) noteInput.value = '';
    if (hiddenIdInput) hiddenIdInput.value = householdId || '';

    // If opening from inside a specific Household view, pre-fill and lock
    if (householdId) {
        const client = getSupabase();
        if (client) {
            client.from('households').select('name').eq('id', householdId).single().then(({ data }) => {
                if (data && nameInput) {
                    nameInput.value = data.name;
                    nameInput.readOnly = true;
                    nameInput.style.backgroundColor = 'var(--bg-hover, #f1f5f9)';
                }
            });
        }
    } else {
        if (nameInput) {
            nameInput.value = '';
            nameInput.readOnly = false;
            nameInput.placeholder = 'Type to search existing households...';
            nameInput.style.backgroundColor = 'var(--bg-card)';
        }
    }

    const modal = document.getElementById('household-modal');
    if (modal) {
        modal.classList.remove('hidden');
        refreshIcons();
    }
}

async function searchHouseholdDropdown(query) {
    const dropdown = document.getElementById('hh-search-dropdown');
    if (!dropdown || activeLinkingHouseholdId || householdModalContext !== 'person') return; // Skip if locked to household, or not in Add Person mode

    const client = getSupabase();
    if (!client) return;

    let dbQuery = client.from('households').select('id, name').order('name').limit(5);
    if (query.trim()) {
        dbQuery = dbQuery.ilike('name', `%${query.trim()}%`);
    }

    const { data: households } = await dbQuery;

    if (households && households.length > 0) {
        dropdown.innerHTML = households.map(h => `
            <div style="padding: 0.5rem 0.75rem; cursor: pointer; border-bottom: 1px solid var(--border); font-size: 0.85rem;" 
                 onclick="selectHouseholdFromDropdown('${h.id}', '${h.name.replace(/'/g, "\\'")}')"
                 onmouseover="this.style.background='var(--bg-hover)'" 
                 onmouseout="this.style.background='transparent'">
                 <i data-lucide="home" style="width:14px; height:14px; color:var(--text-muted);"></i>
                 <strong>${h.name}</strong>
            </div>
        `).join('');
        dropdown.classList.remove('hidden');
    } else {
        dropdown.innerHTML = `<div style="padding: 0.5rem 0.75rem; font-size: 0.8rem; color: var(--text-muted);">No existing households found.</div>`;
        dropdown.classList.remove('hidden');
    }
}

function selectHouseholdFromDropdown(id, name) {
    const nameInput = document.getElementById('hh-name');
    const hiddenIdInput = document.getElementById('selected-household-id');
    const dropdown = document.getElementById('hh-search-dropdown');

    if (nameInput) nameInput.value = name;
    if (hiddenIdInput) hiddenIdInput.value = id;
    activeLinkingHouseholdId = id;

    if (dropdown) dropdown.classList.add('hidden');
}

/* ==========================================================================
   MOBILE NAVIGATION & PORTAL CONTROLLERS
   ========================================================================== */

function closeMobileNav() {
    const drawer = document.getElementById('mobile-nav-drawer');
    if (drawer) drawer.classList.remove('open');
}

function mobileNav(viewId) {
    if (typeof switchView === 'function') {
        switchView(viewId);
    } else {
        document.querySelectorAll('.view-panel').forEach(p => p.classList.add('hidden'));
        const target = document.getElementById(viewId);
        if (target) target.classList.remove('hidden');
    }

    closeMobileNav();
    refreshIcons();
}

function mobileOwnerNav(tabName) {
    mobileNav('owner-portal-view');

    if (typeof switchOwnerTab === 'function') {
        switchOwnerTab(tabName);
    } else {
        document.querySelectorAll('.owner-tab-sec').forEach(sec => sec.classList.add('hidden'));
        const targetSec = document.getElementById('owner-sec-' + tabName);
        if (targetSec) targetSec.classList.remove('hidden');
    }

    closeMobileNav();
    refreshIcons();
}

function setPortalRole(role) {
    const adminLinks = document.getElementById('mobile-admin-links');
    const ownerLinks = document.getElementById('mobile-owner-links');

    if (role === 'owner') {
        if (adminLinks) adminLinks.classList.add('hidden');
        if (ownerLinks) ownerLinks.classList.remove('hidden');
    } else {
        if (adminLinks) adminLinks.classList.remove('hidden');
        if (ownerLinks) ownerLinks.classList.add('hidden');
    }

    refreshIcons();
}

/* ==========================================================================
   HELPER & FETCH FUNCTIONS FOR ACTIVITIES & FEED
   ========================================================================== */

const ACTIVITY_STATUS_OPTIONS = {
    appointment: ['pending', 'confirmed', 'completed', 'cancelled', 'no-show'],
    task: ['pending', 'completed'],
    invoice: ['unpaid', 'paid', 'void']
};

function activityStatusColor(status) {
    if (status === 'completed' || status === 'paid' || status === 'void') return 'var(--text-muted)';
    if (status === 'cancelled' || status === 'no-show' || status === 'unpaid') return '#dc2626';
    if (status === 'confirmed') return '#16a34a';
    return 'var(--primary, #2563eb)';
}

function renderStatusTag(kind, id, currentStatus, onChangeFn) {
    const options = ACTIVITY_STATUS_OPTIONS[kind] || ['pending'];
    return `
        <select onclick="event.stopPropagation();" onchange="event.stopPropagation(); ${onChangeFn}('${kind}', '${id}', this.value)" style="font-size:0.72rem; padding:0.2rem 0.5rem; border-radius:9999px; border:1px solid var(--border); background:var(--bg-card); cursor:pointer; color:${activityStatusColor(currentStatus)}; text-transform:capitalize;">
            ${options.map(o => `<option value="${o}" ${o === currentStatus ? 'selected' : ''}>${o}</option>`).join('')}
        </select>
    `;
}

async function fetchActivityItems() {
    const client = getSupabase();
    if (!client) return [];

    const items = [];

    // Fetch Appointments (Bookings)
    const { data: rawBookings } = await client.from('bookings').select('*, pets(name), households(name), staff:assigned_staff_id(name)');
    const bookings = await attachResourceNames(client, rawBookings || []);

    const invoiceIds = (bookings || []).map(bk => bk.invoice_id).filter(Boolean);
    const { data: linkedInvoices } = invoiceIds.length
        ? await client.from('invoices').select('id, status').in('id', invoiceIds)
        : { data: [] };
    const invoiceStatusById = {};
    (linkedInvoices || []).forEach(inv => { invoiceStatusById[inv.id] = inv.status; });

    (bookings || []).forEach(bk => {
        items.push({
            kind: 'appointment',
            id: bk.id,
            title: bk.service_name || 'Appointment',
            subtitle: [bk.pets?.name, bk.households?.name, bk.resources?.name].filter(Boolean).join(' · '),
            date: (bk.check_in || '').slice(0, 10),
            endDate: (bk.check_out || bk.check_in || '').slice(0, 10),
            status: bk.status || 'pending',
            staffName: bk.staff?.name || '',
            staffId: bk.assigned_staff_id || '',
            householdId: bk.household_id,
            resourceAssignments: bk.resourceAssignments || [],
            resources: bk.resources || null,
            invoiceId: bk.invoice_id || null,
            invoiceStatus: bk.invoice_id ? (invoiceStatusById[bk.invoice_id] || null) : null
        });
    });

    // Fetch Staff Tasks
    const { data: tasks } = await client.from('staff_tasks').select('*, staff(name)');
    (tasks || []).forEach(t => {
        items.push({
            kind: 'task',
            id: t.id,
            title: t.task_text,
            subtitle: t.priority ? `Priority: ${t.priority}` : '',
            date: t.due_date || '',
            status: t.is_done ? 'completed' : 'pending',
            staffName: t.staff?.name || '',
            staffId: t.staff_id || ''
        });
    });

    // Fetch Invoices
    const { data: invoices } = await client
        .from('invoices')
        .select('*, households(name)')
        .eq('status', 'unpaid'); // Excludes paid and void invoices from activities feed & calendar
    
    (invoices || []).forEach(inv => {
        items.push({
            kind: 'invoice',
            id: inv.id,
            title: inv.description || 'Invoice',
            subtitle: `${inv.households?.name || 'Unassigned'} · $${Number(inv.amount || 0).toFixed(2)}`,
            date: inv.due_date || '',
            status: inv.status || 'unpaid',
            staffName: '',
            staffId: '',
            householdId: inv.household_id,
            householdName: inv.households?.name || 'Unassigned Household'
        });
    });

    return items;
}

/* ==========================================================================
   ACTIVITIES VIEW (DYNAMIC GROUPING, RESOURCES & EXPANDED FILTERS)
   ========================================================================== */
const ACT_GROUP_BY_KEY = 'barkboard-act-group-by';
const ACT_VIEW_MODE_KEY = 'barkboard-act-view-mode';        // 'list' | 'calendar'
const ACT_CAL_MODE_KEY = 'barkboard-act-cal-mode';

let actWeekOffset = 0;
let actCalendarMode = localStorage.getItem(ACT_CAL_MODE_KEY) || 'month';

function quickScheduleOnDate(dateStr) {
    pendingCalendarDate = dateStr;
    
    // Open quick schedule modal if available, otherwise open main booking modal
    if (typeof openQuickScheduleModal === 'function') {
        openQuickScheduleModal(dateStr);
    } else if (typeof openBookingModal === 'function') {
        openBookingModal(null);
    }
}

async function initActivitiesView() {
    // 1. Restore saved Group By selection
    const savedGroup = localStorage.getItem(ACT_GROUP_BY_KEY);
    const groupSelect = document.getElementById('act-group-by');
    if (savedGroup && groupSelect) groupSelect.value = savedGroup;

    // 2. Reset filters to defaults
    const categorySelect = document.getElementById('act-category-filter');
    const staffSelect = document.getElementById('act-staff-filter');
    const resourceSelect = document.getElementById('act-resource-filter');
    const householdSelect = document.getElementById('act-household-filter');
    const statusSelect = document.getElementById('act-status-filter');
    const dateFromInput = document.getElementById('act-date-from');
    const dateToInput = document.getElementById('act-date-to');
    const searchInput = document.getElementById('act-search');

    if (categorySelect) categorySelect.value = 'all';
    if (staffSelect) staffSelect.value = 'all';
    if (resourceSelect) resourceSelect.value = 'all';
    if (householdSelect) householdSelect.value = 'all';
    if (statusSelect) statusSelect.value = 'all';
    if (dateFromInput) dateFromInput.value = '';
    if (dateToInput) dateToInput.value = '';
    if (searchInput) searchInput.value = '';

    if (typeof populateStaffSelects === 'function') await populateStaffSelects();
    await populateHouseholdActivityFilter();
    await populateResourceActivityFilter();

    // 3. Restore List vs. Calendar view preference (Defaults to 'calendar')
    const savedViewMode = localStorage.getItem(ACT_VIEW_MODE_KEY) || 'calendar';
    switchActivitiesView(savedViewMode);
}

async function populateHouseholdActivityFilter() {
    const sel = document.getElementById('act-household-filter');
    if (!sel) return;

    const client = getSupabase();
    if (!client) return;

    const { data: households } = await client.from('households').select('id, name').order('name');
    if (households && households.length) {
        sel.innerHTML = '<option value="all">All Households</option>' + 
            households.map(h => `<option value="${h.id}">${h.name}</option>`).join('');
    }
}

async function populateResourceActivityFilter() {
    const sel = document.getElementById('act-resource-filter');
    if (!sel) return;

    const client = getSupabase();
    if (!client) return;

    const { data: resources } = await client.from('resources').select('id, name, type').order('name');
    if (resources && resources.length) {
        sel.innerHTML = '<option value="all">All Resources</option>' + 
            resources.map(r => `<option value="${r.id}">${r.name} (${r.type || 'Resource'})</option>`).join('');
    }
}

function switchActivitiesView(mode) {
    const isList = mode === 'list';
    
    // Save selection
    try { localStorage.setItem(ACT_VIEW_MODE_KEY, mode); } catch (e) {}

    // Toggle active tab buttons
    document.getElementById('acttab-list')?.classList.toggle('active', isList);
    document.getElementById('acttab-calendar')?.classList.toggle('active', !isList);
    
    // Toggle view containers
    document.getElementById('activities-list-view')?.classList.toggle('hidden', !isList);
    document.getElementById('activities-calendar-view')?.classList.toggle('hidden', isList);
    
    // Show/hide Group By dropdown
    const groupByContainer = document.getElementById('act-group-by-container');
    if (groupByContainer) groupByContainer.style.display = isList ? 'block' : 'none';

    if (!isList) {
        document.querySelectorAll('#actview-day, #actview-week, #actview-month').forEach(b => b.classList.remove('today'));
        document.getElementById('actview-' + actCalendarMode)?.classList.add('today');
        renderActivitiesCalendar();
    } else {
        renderActivities();
    }
}

function activitiesFilters() {
    const groupByVal = document.getElementById('act-group-by')?.value || 'date';

    // Store the Group By selection in localStorage
    try {
        localStorage.setItem(ACT_GROUP_BY_KEY, groupByVal);
    } catch (e) { /* storage unavailable, ignore */ }

    return {
        groupBy: groupByVal,
        category: document.getElementById('act-category-filter')?.value || 'all',
        staff: document.getElementById('act-staff-filter')?.value || 'all',
        resource: document.getElementById('act-resource-filter')?.value || 'all',
        household: document.getElementById('act-household-filter')?.value || 'all',
        status: document.getElementById('act-status-filter')?.value || 'all',
        from: document.getElementById('act-date-from')?.value || '',
        to: document.getElementById('act-date-to')?.value || '',
        query: (document.getElementById('act-search')?.value || '').trim().toLowerCase()
    };
}

function filterActivityItems(items, f) {
    return items.filter(it => {
        if (f.category !== 'all' && it.kind !== f.category) return false;
        if (f.staff !== 'all' && it.staffId !== f.staff) return false;
        if (f.household !== 'all' && it.householdId !== f.household) return false;
        if (f.status !== 'all' && it.status !== f.status) return false;
        if (f.from && it.date && it.date < f.from) return false;
        if (f.to && it.date && it.date > f.to) return false;
        if (f.query && !(it.title.toLowerCase().includes(f.query) || (it.subtitle || '').toLowerCase().includes(f.query))) return false;
        
        // Filter by Resource ID
        if (f.resource !== 'all') {
            if (!it.resourceIds || !it.resourceIds.includes(f.resource)) return false;
        }

        return true;
    });
}

function openActivityItem(kind, id, householdId) {
    if (kind === 'appointment') {
        // Open event edit modal
        if (typeof openBookingModal === 'function') {
            openBookingModal(householdId || null, id);
        }
    } else if (kind === 'task') {
        // Open staff task modal
        if (typeof openStaffTaskModal === 'function') {
            openStaffTaskModal(id);
        }
    } else if (kind === 'invoice') {
        // Open invoice edit modal or jump to household invoices
        if (householdId && typeof openInvoiceModal === 'function') {
            openInvoiceModal(householdId, id);
        } else if (typeof switchView === 'function') {
            switchView('biz-view');
            if (typeof switchBizTab === 'function') {
                switchBizTab('invoices');
            }
        }
    }
}

async function renderActivities() {
    
    // If user is currently on Calendar tab, route to calendar renderer instead
    const calendarView = document.getElementById('activities-calendar-view');
    if (calendarView && !calendarView.classList.contains('hidden')) {
        renderActivitiesCalendar();
        return;
    }
    
    const el = document.getElementById('activities-list');
    if (!el) return;

    const f = activitiesFilters();
    let items = await fetchActivityItems();

    // Map resources onto items
    items.forEach(it => {
        const assigned = it.resourceAssignments || [];
        if (assigned.length) {
            it.resourceNames = assigned.map(r => r.name).join(', ');
            it.resourceIds = assigned.map(r => r.resourceId).filter(Boolean);
        } else if (it.resources?.name) {
            it.resourceNames = it.resources.name;
            it.resourceIds = [it.resources.id].filter(Boolean);
        } else {
            it.resourceNames = 'No Resource Assigned';
            it.resourceIds = [];
        }
    });

    items = filterActivityItems(items, f);

    if (!items.length) {
        el.innerHTML = '<div class="biz-empty">No activities match this filter.</div>';
        return;
    }

    // Attach Household names
    const client = getSupabase();
    if (client) {
        const hIds = Array.from(new Set(items.map(i => i.householdId).filter(Boolean)));
        if (hIds.length) {
            const { data: hhList } = await client.from('households').select('id, name').in('id', hIds);
            const hhMap = {};
            (hhList || []).forEach(h => { hhMap[h.id] = h.name; });
            items.forEach(it => { it.householdName = it.householdId ? (hhMap[it.householdId] || 'Unassigned') : 'No Household'; });
        }
    }

    const kindIcon = { appointment: 'calendar', task: 'list-checks', invoice: 'receipt' };

    const renderItemRow = (it) => `
        <div class="activity-row-item" 
             style="display:flex; justify-content:space-between; align-items:center; padding:0.75rem 1rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-card, #ffffff); cursor:pointer; margin-bottom:0.5rem; transition: background-color 0.15s ease;"
             onmouseover="this.style.backgroundColor='var(--bg-hover, #f8fafc)'"
             onmouseout="this.style.backgroundColor='var(--bg-card, #ffffff)'"
             onclick="openActivityItem('${it.kind}', '${it.id}', '${it.householdId || ''}')">
            
            <div style="display:flex; align-items:center; gap:0.75rem;">
                <i data-lucide="${kindIcon[it.kind]}" style="width:18px; height:18px; color:var(--primary, #2563eb);"></i>
                <div>
                    <strong style="font-size:0.95rem; color:var(--text-main, #0f172a);">${it.title}</strong>
                    <div style="font-size:0.8rem; color:var(--text-muted, #64748b); margin-top:0.2rem; display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">
                        ${it.subtitle ? `<span>${it.subtitle}</span> · ` : ''}
                        ${it.resourceNames && it.resourceNames !== 'No Resource Assigned' ? `<span style="display:inline-flex; align-items:center; gap:0.25rem;"><i data-lucide="bed-double" style="width:12px;height:12px;"></i> ${it.resourceNames}</span> · ` : ''}
                        ${it.householdName ? `<span style="display:inline-flex; align-items:center; gap:0.25rem;"><i data-lucide="home" style="width:12px;height:12px;"></i> ${it.householdName}</span> · ` : ''}
                        ${it.staffName ? `<span style="display:inline-flex; align-items:center; gap:0.25rem;"><i data-lucide="user" style="width:12px;height:12px;"></i> ${it.staffName}</span> · ` : ''}
                        ${it.date ? `<span style="display:inline-flex; align-items:center; gap:0.25rem;"><i data-lucide="calendar" style="width:12px;height:12px;"></i> ${it.date}</span>` : ''}
                    </div>
                </div>
            </div>

            <!-- Actions & Status Dropdowns (stopPropagation keeps card click from firing when changing status) -->
            <div style="display:flex; align-items:center; gap:0.5rem;" onclick="event.stopPropagation();">
                ${it.kind === 'invoice' ? `<button class="btn-icon" onclick="event.stopPropagation(); ${it.status === 'paid' ? `showReceipt('${it.id}')` : `showPaymentNotice('${it.id}')`}" title="${it.status === 'paid' ? 'View receipt' : 'View payment notice'}" style="background:none; border:none; cursor:pointer;"><i data-lucide="printer" style="width:15px;height:15px;"></i></button>` : ''}
                ${it.kind === 'appointment' && it.invoiceId ? `<span onclick="event.stopPropagation();">${renderStatusTag('invoice', it.invoiceId, it.invoiceStatus || 'unpaid', 'setAppointmentInvoiceStatus')}</span>` : ''}
                ${renderStatusTag(it.kind, it.id, it.status, 'setActivityStatus')}
            </div>
        </div>
    `;

    // Ungrouped View
    if (f.groupBy === 'none') {
        items.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        el.innerHTML = items.map(renderItemRow).join('');
        refreshIcons();
        return;
    }

    // Grouped View
    const groups = {};
    items.forEach(it => {
        let key = 'Other';
        if (f.groupBy === 'date') key = it.date || 'No Date';
        else if (f.groupBy === 'kind') key = it.kind === 'appointment' ? 'Appointments' : it.kind === 'task' ? 'Tasks' : 'Invoices';
        else if (f.groupBy === 'staff') key = it.staffName || 'Unassigned Staff';
        else if (f.groupBy === 'resource') key = it.resourceNames || 'No Resource Assigned';
        else if (f.groupBy === 'status') key = it.status ? it.status.toUpperCase() : 'PENDING';
        else if (f.groupBy === 'household') key = it.householdName || 'No Household';

        if (!groups[key]) groups[key] = [];
        groups[key].push(it);
    });

    let html = '';
    Object.keys(groups).forEach(groupName => {
        const groupItems = groups[groupName];
        html += `
            <div class="activity-group-block" style="border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card); padding:1rem; margin-bottom:1rem;">
                <div style="font-size:0.85rem; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--primary); margin-bottom:0.75rem; border-bottom:1px solid var(--border); padding-bottom:0.4rem; display:flex; justify-content:space-between; align-items:center;">
                    <span>${groupName}</span>
                    <span style="font-size:0.75rem; color:var(--text-muted); font-weight:500;">${groupItems.length} item(s)</span>
                </div>
                <div style="display:flex; flex-direction:column;">
                    ${groupItems.map(renderItemRow).join('')}
                </div>
            </div>
        `;
    });

    el.innerHTML = html;
    refreshIcons();
}

/* ==========================================================================
   ACTIVITIES CALENDAR RENDERER & PERIOD HELPERS
   ========================================================================== */

function setActCalendarMode(mode) {
    actCalendarMode = mode;
    actWeekOffset = 0;

    // Save calendar view selection ('day', 'week', 'month')
    try { localStorage.setItem(ACT_CAL_MODE_KEY, mode); } catch (e) {}

    document.querySelectorAll('#actview-day, #actview-week, #actview-month').forEach(b => b.classList.remove('today'));
    document.getElementById('actview-' + mode)?.classList.add('today');
    renderActivitiesCalendar();
}

function shiftActPeriod(delta) {
    actWeekOffset += delta;
    renderActivitiesCalendar();
}

function resetActPeriod() {
    actWeekOffset = 0;
    renderActivitiesCalendar();
}

function getActPeriodDates() {
    const today = new Date();
    const fmt = d => d.toISOString().slice(0, 10);

    if (actCalendarMode === 'day') {
        const d = new Date(today);
        d.setDate(d.getDate() + actWeekOffset);
        return { dates: [d], label: fmt(d) };
    }

    if (actCalendarMode === 'month') {
        const first = new Date(today.getFullYear(), today.getMonth() + actWeekOffset, 1);
        const startDay = new Date(first);
        startDay.setDate(startDay.getDate() - startDay.getDay());
        const dates = [];
        for (let i = 0; i < 42; i++) {
            const d = new Date(startDay);
            d.setDate(startDay.getDate() + i);
            dates.push(d);
        }
        const label = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        return { dates, label, monthAnchor: first.getMonth() };
    }

    // Default: 'week'
    const sunday = new Date(today);
    sunday.setDate(today.getDate() - today.getDay() + actWeekOffset * 7);
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(sunday);
        d.setDate(sunday.getDate() + i);
        dates.push(d);
    }
    return { dates, label: `${fmt(dates[0])} — ${fmt(dates[6])}` };
}

async function computeCalendarDayStatuses(dates) {
    const client = getSupabase();
    if (!client || !dates || !dates.length) return {};

    const fmt = d => d.toISOString().slice(0, 10);
    const rangeStart = fmt(dates[0]);
    const rangeEnd = fmt(dates[dates.length - 1]);

    const [{ data: resources }, { data: staffList }, { data: closures }, { data: bookings }, { data: resourceUsage }] = await Promise.all([
        client.from('resources').select('id, type, seats'),
        client.from('staff').select('id'),
        client.from('business_closures').select('start_date, end_date'),
        client.from('bookings').select('id, check_in, check_out, assigned_staff_id, requires_staff_time, status')
            .neq('status', 'cancelled')
            .lte('check_in', rangeEnd + 'T23:59:59')
            .gte('check_out', rangeStart + 'T00:00:00'),
        client.from('booking_resources').select('resource_id, bookings!inner(id, check_in, check_out, status)')
            .neq('bookings.status', 'cancelled')
            .lte('bookings.check_in', rangeEnd + 'T23:59:59')
            .gte('bookings.check_out', rangeStart + 'T00:00:00')
    ]);

    const resourceTypeCapacity = {};
    const resourceTypeById = {};
    (resources || []).forEach(r => {
        resourceTypeById[r.id] = r.type;
        resourceTypeCapacity[r.type] = (resourceTypeCapacity[r.type] || 0) + (r.seats || 1);
    });
    const totalStaff = (staffList || []).length;

    const result = {};
    dates.forEach(d => {
        const key = fmt(d);

        // 1. Business Closed check
        const closed = (closures || []).some(c => key >= c.start_date && key <= (c.end_date || c.start_date));

        // 2. Staff Fully Booked check
        const dayBookings = (bookings || []).filter(bk => {
            const start = (bk.check_in || '').slice(0, 10);
            const end = (bk.check_out || bk.check_in || '').slice(0, 10);
            // Check-out date is freed up for same-day check-ins unless check_in === check_out
            return key >= start && (start === end ? key <= end : key < end);
        });

        const staffBusy = new Set(dayBookings.filter(bk => bk.requires_staff_time && bk.assigned_staff_id).map(bk => bk.assigned_staff_id));
        const staffFull = totalStaff > 0 && staffBusy.size >= totalStaff;

        // 3. Resource Seat Full check (Check-out date frees up the seat)
        const dayResourceUsage = (resourceUsage || []).filter(row => {
            const bk = row.bookings;
            if (!bk) return false;
            const start = (bk.check_in || '').slice(0, 10);
            const end = (bk.check_out || bk.check_in || '').slice(0, 10);
            // Seat is occupied from check-in up until (but NOT including) check-out date
            return key >= start && (start === end ? key <= end : key < end);
        });

        const usedByType = {};
        dayResourceUsage.forEach(row => {
            const type = resourceTypeById[row.resource_id];
            if (!type) return;
            usedByType[type] = (usedByType[type] || 0) + 1;
        });
        const fullTypes = Object.keys(resourceTypeCapacity).filter(type => usedByType[type] >= resourceTypeCapacity[type]);

        let level = null;
        if (closed) level = 'closed';
        else if (staffFull) level = 'staff-full';
        else if (fullTypes.length) level = 'resource-full';

        result[key] = { level, fullTypes };
    });

    return result;
}

function getServiceIcons(item) {
    if (item.kind === 'task') {
        return ['check-square'];
    }

    const text = (item.title || item.subtitle || '').toLowerCase();
    const resType = (item.resourceNames || '').toLowerCase();
    const icons = [];

    const isBoarding = text.includes('board') || text.includes('stay') || resType.includes('suite') || resType.includes('run') || resType.includes('kennel');
    const isTraining = text.includes('train') || text.includes('agility') || text.includes('class');
    const isGrooming = text.includes('groom') || text.includes('bath') || text.includes('wash');
    const isDaycare = text.includes('daycare') || text.includes('play');

    if (isBoarding) icons.push('bed-double');
    if (isTraining) icons.push('dumbbell');
    if (isGrooming) icons.push('scissors');
    if (isDaycare) icons.push('sun');

    // Fallback if no specific service category matched
    if (!icons.length) icons.push('calendar');

    // Prepend dollar-sign for invoices
    if (item.kind === 'invoice') {
        return ['dollar-sign', ...icons];
    }

    return icons;
}

async function renderActivitiesCalendar() {
    const thead = document.getElementById('act-cal-thead');
    const tbody = document.getElementById('act-cal-body');
    const weekLabel = document.getElementById('act-week-label');
    if (!thead || !tbody) return;

    const { dates, label, monthAnchor } = getActPeriodDates();
    const fmt = d => d.toISOString().slice(0, 10);
    if (weekLabel) weekLabel.textContent = label;

    // 1. Fetch raw items
    let items = await fetchActivityItems();

    // 2. Map resource IDs and names onto items for resource-based filtering
    items.forEach(it => {
        const assigned = it.resourceAssignments || [];
        if (assigned.length) {
            it.resourceNames = assigned.map(r => r.name).join(', ');
            it.resourceIds = assigned.map(r => r.resourceId).filter(Boolean);
        } else if (it.resources?.name) {
            it.resourceNames = it.resources.name;
            it.resourceIds = [it.resources.id].filter(Boolean);
        } else {
            it.resourceNames = 'No Resource Assigned';
            it.resourceIds = [];
        }
    });

    // 3. Get active filter state and apply to items
    const f = activitiesFilters();
    items = filterActivityItems(items, f);

    // 4. Bucket filtered items into the calendar dates
    const byDay = {};
    dates.forEach(d => { byDay[fmt(d)] = []; });
    items.forEach(it => {
        const start = it.date;
        const end = it.endDate || it.date;
        Object.keys(byDay).forEach(key => {
            if (key >= start && key <= end) byDay[key].push(it);
        });
    });

    const dayStatus = typeof computeCalendarDayStatuses === 'function' 
        ? await computeCalendarDayStatuses(dates) 
        : {};

    const statusBg = { closed: '#e5e7eb', 'staff-full': '#fecaca', 'resource-full': '#fef08a' };
    const isDayMode = actCalendarMode === 'day';

    const renderCellItems = (key, compact) => (byDay[key] || []).map(it => {
        const icons = getServiceIcons(it);
        
        let displayLabel = it.title || 'Event';
        if (it.kind === 'invoice') {
            displayLabel = it.householdName || (it.subtitle ? it.subtitle.split('·')[0].trim() : 'Unpaid Invoice');
        } else if (it.kind === 'task') {
            displayLabel = it.title;
        } else if (it.subtitle) {
            displayLabel = it.subtitle.split('·')[0].trim();
        }

        const iconHtml = icons
            .map(icon => `<i data-lucide="${icon}" style="width:13px; height:13px; color:var(--primary,#2563eb); flex-shrink:0;"></i>`)
            .join('');

        return `
            <div style="padding:${compact ? '0.2rem 0.3rem' : '0.35rem 0.45rem'}; margin-bottom:0.25rem; border-radius:0.25rem; background:var(--bg-hover,#f1f5f9); font-size:${compact ? '0.68rem' : '0.75rem'}; cursor:pointer; border:1px solid var(--border);" onclick="event.stopPropagation(); openActivityItem('${it.kind}', '${it.id}', '${it.householdId || ''}')">
                <div style="display:flex; align-items:center; gap:0.35rem; font-weight:600; color:var(--text-main,#0f172a);">
                    <span style="display:inline-flex; gap:0.15rem; align-items:center;">${iconHtml}</span>
                    <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${displayLabel}</span>
                </div>
                ${!compact ? `
                    <div style="font-size:0.7rem; color:var(--text-muted); margin-top:0.15rem; display:flex; align-items:center; gap:0.25rem; flex-wrap:wrap;">
                        ${it.kind === 'task' ? `<span>${it.staffName ? '👤 ' + it.staffName : 'Task'}</span>` : ''}
                        ${it.resourceNames && it.resourceNames !== 'No Resource Assigned' ? `<span>${it.resourceNames}</span>` : ''}
                        ${it.kind === 'appointment' && it.invoiceId ? `<span onclick="event.stopPropagation();" style="margin-left:auto;">${renderStatusTag('invoice', it.invoiceId, it.invoiceStatus || 'unpaid', 'setAppointmentInvoiceStatus')}</span>` : ''}
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');

    const todayKey = fmt(new Date());

    const cellStyle = (key, extra) => {
        const s = dayStatus[key];
        const bg = s ? statusBg[s.level] : '';
        const statusLabel = s ? (s.level === 'closed' ? 'Business closed' : s.level === 'staff-full' ? 'All staff booked' : `Closed to: ${s.fullTypes.join(', ')}`) : '';
        const todayOutline = key === todayKey ? 'box-shadow: inset 0 0 0 2px #2563eb;' : '';
        return `style="cursor:pointer; ${bg ? 'background:' + bg + ';' : ''} ${todayOutline} ${extra || ''}" title="${key === todayKey ? 'Today. ' : ''}${statusLabel}"`;
    };

    if (actCalendarMode === 'day') {
        thead.innerHTML = `<tr><th>${dates[0].toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</th></tr>`;
        const key = fmt(dates[0]);
        tbody.innerHTML = `<tr><td ${cellStyle(key, 'min-height:300px;')} onclick="quickScheduleOnDate('${key}')">${renderCellItems(key, false) || '<span style="color:var(--text-muted); font-size:0.85rem;">Click to schedule something on this day.</span>'}</td></tr>`;
    } else if (actCalendarMode === 'month') {
        thead.innerHTML = `<tr>${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<th>${d}</th>`).join('')}</tr>`;
        let rows = '';
        for (let w = 0; w < 6; w++) {
            rows += '<tr>';
            for (let d = 0; d < 7; d++) {
                const date = dates[w * 7 + d];
                const key = fmt(date);
                const inMonth = date.getMonth() === monthAnchor;
                rows += `<td ${cellStyle(key, `opacity:${inMonth ? '1' : '0.4'};`)} onclick="quickScheduleOnDate('${key}')">
                    <div style="font-size:0.78rem; font-weight:600; margin-bottom:0.2rem;">${date.getDate()}</div>
                    ${renderCellItems(key, true)}
                </td>`;
            }
            rows += '</tr>';
        }
        tbody.innerHTML = rows;
    } else {
        thead.innerHTML = `<tr>${dates.map(d => `<th>${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</th>`).join('')}</tr>`;
        tbody.innerHTML = `<tr>${dates.map(d => {
            const key = fmt(d);
            return `<td ${cellStyle(key)} onclick="quickScheduleOnDate('${key}')">${renderCellItems(key, false)}</td>`;
        }).join('')}</tr>`;
    }

    refreshIcons();
}

/* ==========================================================================
   TEMPLATES VIEW (appointment types, task templates, assessment templates)
   ========================================================================== */

function switchTemplatesTab(tab) {
    document.querySelectorAll('[id^="tmpltab-"]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('[id^="tmplsec-"]').forEach(s => s.classList.remove('active'));

    const targetTab = document.getElementById('tmpltab-' + tab);
    const targetSec = document.getElementById('tmplsec-' + tab);
    if (targetTab) targetTab.classList.add('active');
    if (targetSec) targetSec.classList.add('active');

    if (tab === 'appt') renderApptTypeList();
    if (tab === 'task') renderTaskTemplateList();
    if (tab === 'assess') renderAssessmentTemplateList();
    if (tab === 'resources' && typeof renderResourceList === 'function') renderResourceList();
    if (tab === 'notices' && typeof loadEmailTemplates === 'function') loadEmailTemplates();
}

// ---- Appointment Type Templates ----

let editingApptTypeId = null;
let apptTypeGroupBy = 'species';

function switchApptTypeGrouping(mode) {
    apptTypeGroupBy = mode;
    document.querySelectorAll('[id^="apptgrouptab-"]').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`apptgrouptab-${mode}`)?.classList.add('active');
    renderApptTypeList();
}

async function renderApptTypeList() {
    const el = document.getElementById('appt-type-list');
    if (!el) return;
    const client = getSupabase();
    if (!client) return;

    const { data: list } = await client.from('appointment_type_templates').select('*').order('name');
    if (!list || !list.length) {
        el.innerHTML = '<div class="biz-empty">No services yet.</div>';
        return;
    }

    const itemHtml = (t) => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-card); cursor:pointer;" onclick="openApptTypeModal('${t.id}')">
            <div>
                <strong>${t.name}</strong>
                <span style="font-size:0.78rem; color:var(--text-muted); margin-left:0.5rem;">${t.default_price != null ? '$' + Number(t.default_price).toFixed(2) + (t.pricing_unit === 'per_day' ? '/day' : ' flat') : ''} ${t.default_duration_minutes ? '· ' + t.default_duration_minutes + ' min' : ''} ${t.resource_type ? '· Resource: ' + t.resource_type : ''} ${t.requires_staff_time ? '· Staff time: ' + (t.staff_time_minutes || '?') + ' min/day' + (t.staff_time_resource_type ? ' (' + t.staff_time_resource_type + ')' : '') : ''} ${Array.isArray(t.category) && t.category.length ? '· ' + t.category.map(c => c[0].toUpperCase() + c.slice(1)).join(' + ') : ''}</span>
                ${t.notes ? `<div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.2rem;">${t.notes}</div>` : ''}
            </div>
            <div style="display:flex; gap:0.4rem;">
                <button class="btn-icon" style="background:none;border:none;cursor:pointer;color:var(--danger-text);" onclick="event.stopPropagation(); deleteApptType('${t.id}')" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
            </div>
        </div>
    `;

    let groups;
    if (apptTypeGroupBy === 'none') {
        groups = [{ label: null, items: list }];
    } else if (apptTypeGroupBy === 'rate') {
        groups = [
            { label: 'Flat Rate', items: list.filter(t => t.pricing_unit !== 'per_day') },
            { label: 'Per-Day Rate', items: list.filter(t => t.pricing_unit === 'per_day') },
        ].filter(g => g.items.length);
    } else if (apptTypeGroupBy === 'resource') {
        const byResource = {};
        list.forEach(t => {
            const key = t.resource_type || 'No Resource Required';
            if (!byResource[key]) byResource[key] = [];
            byResource[key].push(t);
        });
        groups = Object.keys(byResource).sort((a, b) => a === 'No Resource Required' ? 1 : b === 'No Resource Required' ? -1 : a.localeCompare(b))
            .map(key => ({ label: key, items: byResource[key] }));
    } else if (apptTypeGroupBy === 'category') {
        // Same multi-group logic as species — a combo package tagged with more
        // than one category (e.g. "Board and Train" = Boarding + Training)
        // appears under each one, rather than needing its own combo bucket.
        const categoryLabels = { boarding: 'Boarding', daycare: 'Daycare', grooming: 'Grooming', training: 'Training' };
        groups = Object.keys(categoryLabels)
            .map(key => ({ label: categoryLabels[key], items: list.filter(t => Array.isArray(t.category) && t.category.includes(key)) }))
            .filter(g => g.items.length);
        const uncategorized = list.filter(t => !Array.isArray(t.category) || !t.category.length);
        if (uncategorized.length) groups.push({ label: 'Uncategorized', items: uncategorized });
    } else {
        // species (default) — a service restricted to more than one species
        // (e.g. Dog + Cat) appears in each matching group, since "show me
        // what's available for dogs" naturally includes anything dogs qualify for.
        groups = [
            { label: 'All Species', items: list.filter(t => !Array.isArray(t.species) || !t.species.length) },
            { label: 'Dogs', items: list.filter(t => Array.isArray(t.species) && t.species.includes('dog')) },
            { label: 'Cats', items: list.filter(t => Array.isArray(t.species) && t.species.includes('cat')) },
            { label: 'Other', items: list.filter(t => Array.isArray(t.species) && t.species.includes('other')) },
        ].filter(g => g.items.length);
    }

    el.innerHTML = groups.map(g => `
        <div>
            ${g.label ? `<h4 style="margin:0 0 0.5rem; font-size:0.8rem; font-weight:700; text-transform:uppercase; letter-spacing:0.03em; color:var(--text-muted);">${g.label}</h4>` : ''}
            <div style="display:flex; flex-direction:column; gap:0.6rem;">
                ${g.items.map(itemHtml).join('')}
            </div>
        </div>
    `).join('');
    refreshIcons();
}

async function openApptTypeModal(id) {
    editingApptTypeId = id;
    const titleEl = document.getElementById('appt-type-modal-title');
    if (titleEl) titleEl.textContent = id ? 'Edit Service' : 'Add Service';

    const nameInput = document.getElementById('att-name');
    const priceInput = document.getElementById('att-price');
    const durationInput = document.getElementById('att-duration');
    const resourceTypeSel = document.getElementById('att-resource-type');
    const requiresStaffTimeChk = document.getElementById('att-requires-staff-time');
    const staffTimeFields = document.getElementById('att-staff-time-fields');
    const staffTimeMinutesInput = document.getElementById('att-staff-time-minutes');
    const staffTimeResourceTypeSel = document.getElementById('att-staff-time-resource-type');
    const notesInput = document.getElementById('att-notes');
    const pricingFlatRadio = document.getElementById('att-pricing-flat');
    const pricingPerDayRadio = document.getElementById('att-pricing-per-day');

    let t = null;
    const client = getSupabase();
    if (id) {
        const { data } = client ? await client.from('appointment_type_templates').select('*').eq('id', id).single() : { data: null };
        t = data;
    }

    // Pull real resource types from the resources table into the shared datalist, so both
    // fields can suggest existing types while still letting the user type a brand-new custom one.
    if (client) {
        const { data: resourceRows } = await client.from('resources').select('type');
        const types = Array.from(new Set((resourceRows || []).map(r => r.type).filter(Boolean))).sort();
        if (t?.resource_type && !types.includes(t.resource_type)) types.push(t.resource_type);
        if (t?.staff_time_resource_type && !types.includes(t.staff_time_resource_type)) types.push(t.staff_time_resource_type);

        const datalist = document.getElementById('att-resource-type-options');
        if (datalist) datalist.innerHTML = types.map(ty => `<option value="${ty.replace(/"/g, '&quot;')}"></option>`).join('');
    }

    if (nameInput) nameInput.value = t?.name || '';
    if (priceInput) priceInput.value = t?.default_price != null ? t.default_price : '';
    if (pricingFlatRadio) pricingFlatRadio.checked = (t?.pricing_unit || 'flat') !== 'per_day';
    if (pricingPerDayRadio) pricingPerDayRadio.checked = t?.pricing_unit === 'per_day';
    if (durationInput) durationInput.value = t?.default_duration_minutes || '';
    if (resourceTypeSel) resourceTypeSel.value = t?.resource_type || '';
    if (requiresStaffTimeChk) requiresStaffTimeChk.checked = !!t?.requires_staff_time;
    if (staffTimeFields) staffTimeFields.style.display = t?.requires_staff_time ? 'flex' : 'none';
    if (staffTimeMinutesInput) staffTimeMinutesInput.value = t?.staff_time_minutes || '';
    if (staffTimeResourceTypeSel) staffTimeResourceTypeSel.value = t?.staff_time_resource_type || '';
    if (notesInput) notesInput.value = t?.notes || '';
    document.querySelectorAll('.att-species-chk').forEach(chk => {
        chk.checked = Array.isArray(t?.species) && t.species.includes(chk.value);
    });
    document.querySelectorAll('.att-category-chk').forEach(chk => {
        chk.checked = Array.isArray(t?.category) && t.category.includes(chk.value);
    });
    if (document.getElementById('att-prompt-times')) document.getElementById('att-prompt-times').checked = !!t?.prompt_dropoff_pickup_time;

    // Render notice checkboxes from the business's active templates, checked
    // against whichever ones are already applied to this service (junction
    // table — empty/none if this is a new service).
    if (client) {
        const { data: allTemplates } = await client.from('email_templates').select('id, name, category').eq('business_id', currentBusinessId).eq('is_active', true).order('sort_order');
        let appliedIds = new Set();
        if (id) {
            const { data: applied } = await client.from('appointment_template_notices').select('email_template_id').eq('appointment_type_template_id', id);
            appliedIds = new Set((applied || []).map(a => a.email_template_id));
        }
        const renderChecks = (elId, category) => {
            const el = document.getElementById(elId);
            if (!el) return;
            const list = (allTemplates || []).filter(tpl => tpl.category === category);
            el.innerHTML = list.length
                ? list.map(tpl => `<label style="display:flex; align-items:center; gap:0.4rem; font-weight:400; font-size:0.85rem;"><input type="checkbox" class="att-notice-chk" data-template-id="${tpl.id}" ${appliedIds.has(tpl.id) ? 'checked' : ''}> ${tpl.name}</label>`).join('')
                : `<p style="font-size:0.8rem; color:var(--text-muted); margin:0;">No ${category} notices set up yet — add some under Business Settings → Notice Templates.</p>`;
        };
        renderChecks('att-scheduling-notices', 'scheduling');
        renderChecks('att-invoice-notices', 'invoice');
    }

    document.getElementById('appt-type-modal')?.classList.remove('hidden');
}

function closeApptTypeModal() {
    document.getElementById('appt-type-modal')?.classList.add('hidden');
}

async function saveApptType() {
    const name = document.getElementById('att-name')?.value.trim();
    if (!name) return alert('Please enter a name.');

    const price = document.getElementById('att-price')?.value;
    const pricingUnit = document.getElementById('att-pricing-per-day')?.checked ? 'per_day' : 'flat';
    const duration = document.getElementById('att-duration')?.value;
    const resourceType = document.getElementById('att-resource-type')?.value.trim() || null;
    const requiresStaffTime = document.getElementById('att-requires-staff-time')?.checked || false;
    const staffTimeMinutes = document.getElementById('att-staff-time-minutes')?.value;
    const staffTimeResourceType = document.getElementById('att-staff-time-resource-type')?.value.trim() || null;
    const notes = document.getElementById('att-notes')?.value.trim() || '';
    const species = Array.from(document.querySelectorAll('.att-species-chk:checked')).map(chk => chk.value);
    const category = Array.from(document.querySelectorAll('.att-category-chk:checked')).map(chk => chk.value);
    const promptTimes = document.getElementById('att-prompt-times')?.checked || false;

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const payload = {
        name,
        default_price: price ? parseFloat(price) : null,
        pricing_unit: pricingUnit,
        default_duration_minutes: duration ? parseInt(duration, 10) : null,
        resource_type: resourceType,
        requires_staff_time: requiresStaffTime,
        staff_time_minutes: requiresStaffTime && staffTimeMinutes ? parseInt(staffTimeMinutes, 10) : null,
        staff_time_resource_type: requiresStaffTime ? staffTimeResourceType : null,
        notes,
        species: species.length ? species : null,
        category: category.length ? category : null,
        prompt_dropoff_pickup_time: promptTimes
    };

    let response;
    if (editingApptTypeId) {
        response = await client.from('appointment_type_templates').update(payload).eq('id', editingApptTypeId).select();
    } else {
        response = await client.from('appointment_type_templates').insert([{ ...payload, business_id: currentBusinessId }]).select();
    }

    if (response.error) return alert('Failed to save: ' + response.error.message);
    // RLS blocking an update matches zero rows and returns success with no
    // error — a silent no-op that looks identical to "it worked" unless we
    // explicitly check the affected row count came back non-empty.
    if (editingApptTypeId && (!response.data || !response.data.length)) {
        return alert('Nothing was saved — this usually means your session has expired or changed. Please refresh the page and sign in again, then retry.');
    }

    // Re-sync which notice templates are applied to this service — simplest
    // correct approach is delete-then-reinsert rather than diffing, since
    // this is a small checkbox list, not a large dataset.
    const savedId = editingApptTypeId || response.data?.[0]?.id;
    if (savedId) {
        const checkedTemplateIds = Array.from(document.querySelectorAll('.att-notice-chk:checked')).map(chk => chk.dataset.templateId);
        await client.from('appointment_template_notices').delete().eq('appointment_type_template_id', savedId);
        if (checkedTemplateIds.length) {
            await client.from('appointment_template_notices').insert(
                checkedTemplateIds.map(templateId => ({ appointment_type_template_id: savedId, email_template_id: templateId, business_id: currentBusinessId }))
            );
        }
    }

    editingApptTypeId = null;
    closeApptTypeModal();
    renderApptTypeList();
}

async function deleteApptType(id) {
    if (!confirm('Remove this service?')) return;
    const client = getSupabase();
    if (!client) return;
    const { data, error } = await client.from('appointment_type_templates').delete().eq('id', id).select();
    if (error) return alert('Failed to delete: ' + error.message);
    if (!data || !data.length) {
        alert('Nothing was deleted — this usually means your session has expired or changed. Please refresh the page and sign in again, then retry.');
        return;
    }
    renderApptTypeList();
}

// ---- Task Templates ----

let editingTaskTemplateId = null;

async function renderTaskTemplateList() {
    const el = document.getElementById('task-template-list');
    if (!el) return;
    const client = getSupabase();
    if (!client) return;

    const { data: list } = await client.from('task_templates').select('*').order('name');
    if (!list || !list.length) {
        el.innerHTML = '<div class="biz-empty">No task templates yet.</div>';
        return;
    }

    el.innerHTML = list.map(t => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-card); cursor:pointer;" onclick="openTaskTemplateModal('${t.id}')">
            <div>
                <strong>${t.name}</strong>
                <span style="font-size:0.78rem; color:var(--text-muted); margin-left:0.5rem; text-transform:capitalize;">${t.default_priority || 'normal'} priority</span>
                ${t.description ? `<div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.2rem;">${t.description}</div>` : ''}
            </div>
            <div style="display:flex; gap:0.4rem;">
                <button class="btn-icon" style="background:none;border:none;cursor:pointer;color:var(--danger-text);" onclick="event.stopPropagation(); deleteTaskTemplate('${t.id}')" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
            </div>
        </div>
    `).join('');
    refreshIcons();
}

async function openTaskTemplateModal(id) {
    editingTaskTemplateId = id;
    const titleEl = document.getElementById('task-template-modal-title');
    if (titleEl) titleEl.textContent = id ? 'Edit Task Template' : 'Add Task Template';

    const nameInput = document.getElementById('ttm-name');
    const descInput = document.getElementById('ttm-description');
    const prioritySel = document.getElementById('ttm-priority');

    let t = null;
    if (id) {
        const client = getSupabase();
        const { data } = client ? await client.from('task_templates').select('*').eq('id', id).single() : { data: null };
        t = data;
    }

    if (nameInput) nameInput.value = t?.name || '';
    if (descInput) descInput.value = t?.description || '';
    if (prioritySel) prioritySel.value = t?.default_priority || 'normal';

    document.getElementById('task-template-modal')?.classList.remove('hidden');
}

function closeTaskTemplateModal() {
    document.getElementById('task-template-modal')?.classList.add('hidden');
}

async function saveTaskTemplate() {
    const name = document.getElementById('ttm-name')?.value.trim();
    if (!name) return alert('Please enter a name.');

    const description = document.getElementById('ttm-description')?.value.trim() || '';
    const priority = document.getElementById('ttm-priority')?.value || 'normal';

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const payload = { name, description, default_priority: priority };
    let response;
    if (editingTaskTemplateId) {
        response = await client.from('task_templates').update(payload).eq('id', editingTaskTemplateId);
    } else {
        response = await client.from('task_templates').insert([{ ...payload, business_id: currentBusinessId }]);
    }

    if (response.error) return alert('Failed to save: ' + response.error.message);

    editingTaskTemplateId = null;
    closeTaskTemplateModal();
    renderTaskTemplateList();
}

async function deleteTaskTemplate(id) {
    if (!confirm('Remove this task template?')) return;
    const client = getSupabase();
    if (!client) return;
    await client.from('task_templates').delete().eq('id', id);
    renderTaskTemplateList();
}

// ---- Assessment Templates ----

let editingAssessmentTemplateId = null;

async function renderAssessmentTemplateList() {
    const el = document.getElementById('assessment-template-list');
    if (!el) return;
    const client = getSupabase();
    if (!client) return;

    const { data: list } = await client.from('assessment_templates').select('*').order('name');
    if (!list || !list.length) {
        el.innerHTML = '<div class="biz-empty">No assessment templates yet.</div>';
        return;
    }

    el.innerHTML = list.map(t => `
        <div style="padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-card); cursor:pointer;" onclick="openAssessmentTemplateModal('${t.id}')">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <strong>${t.name}</strong>
                <div style="display:flex; gap:0.4rem;">
                    <button class="btn-icon" style="background:none;border:none;cursor:pointer;color:var(--danger-text);" onclick="event.stopPropagation(); deleteAssessmentTemplate('${t.id}')" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
                </div>
            </div>
            ${t.criteria && t.criteria.length ? `<ul style="margin:0.4rem 0 0; padding-left:1.2rem; font-size:0.82rem; color:var(--text-muted);">${t.criteria.map(c => `<li>${c}</li>`).join('')}</ul>` : ''}
            ${t.notes ? `<div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.3rem;">${t.notes}</div>` : ''}
        </div>
    `).join('');
    refreshIcons();
}

async function openAssessmentTemplateModal(id) {
    editingAssessmentTemplateId = id;
    const titleEl = document.getElementById('assessment-template-modal-title');
    if (titleEl) titleEl.textContent = id ? 'Edit Assessment Template' : 'Add Assessment Template';

    const nameInput = document.getElementById('atm-name');
    const criteriaInput = document.getElementById('atm-criteria');
    const notesInput = document.getElementById('atm-notes');

    let t = null;
    if (id) {
        const client = getSupabase();
        const { data } = client ? await client.from('assessment_templates').select('*').eq('id', id).single() : { data: null };
        t = data;
    }

    if (nameInput) nameInput.value = t?.name || '';
    if (criteriaInput) criteriaInput.value = t?.criteria ? t.criteria.join('\n') : '';
    if (notesInput) notesInput.value = t?.notes || '';

    document.getElementById('assessment-template-modal')?.classList.remove('hidden');
}

function closeAssessmentTemplateModal() {
    document.getElementById('assessment-template-modal')?.classList.add('hidden');
}

async function saveAssessmentTemplate() {
    const name = document.getElementById('atm-name')?.value.trim();
    if (!name) return alert('Please enter a name.');

    const criteriaText = document.getElementById('atm-criteria')?.value || '';
    const criteria = criteriaText.split('\n').map(s => s.trim()).filter(Boolean);
    const notes = document.getElementById('atm-notes')?.value.trim() || '';

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const payload = { name, criteria, notes };
    let response;
    if (editingAssessmentTemplateId) {
        response = await client.from('assessment_templates').update(payload).eq('id', editingAssessmentTemplateId);
    } else {
        response = await client.from('assessment_templates').insert([{ ...payload, business_id: currentBusinessId }]);
    }

    if (response.error) return alert('Failed to save: ' + response.error.message);

    editingAssessmentTemplateId = null;
    closeAssessmentTemplateModal();
    renderAssessmentTemplateList();
}

async function deleteAssessmentTemplate(id) {
    if (!confirm('Remove this assessment template?')) return;
    const client = getSupabase();
    if (!client) return;
    await client.from('assessment_templates').delete().eq('id', id);
    renderAssessmentTemplateList();
}

/* ==========================================================================
   BUSINESS PAYMENT SETTINGS + PAYMENT NOTICE / RECEIPT GENERATION
   ========================================================================== */

/* Shared "Saved ✓" flash used by the auto-save fields in Business Settings —
   replaces a blocking alert() with a quiet inline confirmation next to the
   section that was just saved. */
/* ==========================================================================
   NOTICE TEMPLATES (editable, timed email notices)
   ========================================================================== */

let editingEmailTemplateId = null;

async function loadEmailTemplates() {
    const client = getSupabase();
    if (!client) return;
    const { data } = await client.from('email_templates').select('*').eq('business_id', currentBusinessId).order('sort_order').order('created_at');
    const templates = data || [];
    renderEmailTemplateGroup('scheduling-templates-list', templates.filter(t => t.category === 'scheduling'));
    renderEmailTemplateGroup('invoice-templates-list', templates.filter(t => t.category === 'invoice'));
}

const NOTICE_EVENT_LABELS = {
    booking_confirmed: 'Booking Confirmed',
    booking_declined: 'Booking Declined',
    invoice_created: 'Invoice Created',
    payment_received: 'Payment Received'
};

function timingLabel(t) {
    if (t.trigger_type === 'immediate') {
        return `Immediately — on ${NOTICE_EVENT_LABELS[t.immediate_event] || t.immediate_event}`;
    }
    return `${t.offset_days} day${t.offset_days === 1 ? '' : 's'} ${t.trigger_type} the date`;
}

function renderEmailTemplateGroup(elId, templates) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!templates.length) {
        el.innerHTML = '<p style="font-size:0.85rem; color:var(--text-muted);">No templates yet.</p>';
        return;
    }
    el.innerHTML = templates.map(t => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.65rem 0.85rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-card); ${t.is_active ? '' : 'opacity:0.55;'}">
            <div>
                <strong>${t.name}</strong>
                <span style="font-size:0.78rem; color:var(--text-muted); margin-left:0.5rem;">${timingLabel(t)}</span>
                ${!t.is_active ? '<span style="font-size:0.7rem; color:var(--text-muted); margin-left:0.5rem;">(inactive)</span>' : ''}
            </div>
            <div style="display:flex; gap:0.35rem;">
                <button class="btn-icon" style="background:none;border:none;cursor:pointer;" onclick="openEmailTemplateModal('${t.id}')" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px;"></i></button>
                <button class="btn-icon" style="background:none;border:none;cursor:pointer;color:var(--danger-text);" onclick="deleteEmailTemplate('${t.id}')" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
            </div>
        </div>
    `).join('');
    refreshIcons();
}

const MERGE_TAGS = [
    ['{{business_name}}', 'Business Name'],
    ['{{owner_name}}', "Owner's Name"],
    ['{{pet_name}}', "Pet's Name"],
    ['{{service_name}}', 'Service Name'],
    ['{{date}}', 'Appointment Date'],
    ['{{amount}}', 'Amount'],
    ['{{due_date}}', 'Due Date'],
    ['{{payment_options}}', 'Ways to Pay']
];

function populateMergeTagPicker() {
    const sel = document.getElementById('et-merge-tag-picker');
    if (!sel) return;
    sel.innerHTML = MERGE_TAGS.map(([tag, label]) => `<option value="${tag}">${label}</option>`).join('');
}

function insertMergeTag() {
    const sel = document.getElementById('et-merge-tag-picker');
    const textarea = document.getElementById('et-body');
    if (!sel || !textarea) return;
    const tag = sel.value;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    textarea.value = textarea.value.slice(0, start) + tag + textarea.value.slice(end);
    const newPos = start + tag.length;
    textarea.focus();
    textarea.setSelectionRange(newPos, newPos);
}

function updateTemplateTriggerOptions() {
    const category = document.getElementById('et-category')?.value;
    const trigger = document.getElementById('et-trigger')?.value;
    document.getElementById('et-offset-group')?.classList.toggle('hidden', trigger === 'immediate');
    document.getElementById('et-immediate-event-group')?.classList.toggle('hidden', trigger !== 'immediate');
    // "Attach invoice/receipt" only makes sense for invoice notices — a
    // scheduling notice (confirmation, reminder) has no invoice to attach.
    document.getElementById('et-attach-group')?.classList.toggle('hidden', category !== 'invoice');

    const eventSelect = document.getElementById('et-immediate-event');
    if (!eventSelect) return;
    const prev = eventSelect.value;
    const options = category === 'scheduling'
        ? [['booking_confirmed', 'Booking Confirmed'], ['booking_declined', 'Booking Declined']]
        : [['invoice_created', 'Invoice Created'], ['payment_received', 'Payment Received']];
    eventSelect.innerHTML = options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    if (options.some(([v]) => v === prev)) eventSelect.value = prev;
}

async function openEmailTemplateModal(id) {
    editingEmailTemplateId = id;
    document.getElementById('et-modal-title').textContent = id ? 'Edit Notice Template' : 'Add Notice Template';
    populateMergeTagPicker();

    if (id) {
        const client = getSupabase();
        const { data: t } = client ? await client.from('email_templates').select('*').eq('id', id).single() : { data: null };
        if (t) {
            document.getElementById('et-category').value = t.category;
            document.getElementById('et-name').value = t.name;
            document.getElementById('et-trigger').value = t.trigger_type;
            updateTemplateTriggerOptions();
            if (t.trigger_type === 'immediate') document.getElementById('et-immediate-event').value = t.immediate_event || '';
            document.getElementById('et-offset-days').value = t.offset_days || '';
            document.getElementById('et-subject').value = t.subject;
            document.getElementById('et-body').value = t.body;
            document.getElementById('et-active').checked = t.is_active;
            document.getElementById('et-attach-invoice').checked = !!t.attach_invoice;
        }
    } else {
        document.getElementById('et-category').value = 'scheduling';
        document.getElementById('et-name').value = '';
        document.getElementById('et-trigger').value = 'immediate';
        updateTemplateTriggerOptions();
        document.getElementById('et-offset-days').value = '';
        document.getElementById('et-subject').value = '';
        document.getElementById('et-body').value = '';
        document.getElementById('et-active').checked = true;
        document.getElementById('et-attach-invoice').checked = false;
    }

    document.getElementById('email-template-modal')?.classList.remove('hidden');
}

function closeEmailTemplateModal() {
    document.getElementById('email-template-modal')?.classList.add('hidden');
}

async function saveEmailTemplate() {
    const category = document.getElementById('et-category').value;
    const name = document.getElementById('et-name').value.trim();
    const triggerType = document.getElementById('et-trigger').value;
    const subject = document.getElementById('et-subject').value.trim();
    const body = document.getElementById('et-body').value.trim();
    const isActive = document.getElementById('et-active').checked;
    const attachInvoice = category === 'invoice' && document.getElementById('et-attach-invoice').checked;

    if (!name) return alert('Please name this template.');
    if (!subject || !body) return alert('Please fill in both the subject and body.');

    const payload = {
        business_id: currentBusinessId,
        category,
        name,
        trigger_type: triggerType,
        immediate_event: triggerType === 'immediate' ? document.getElementById('et-immediate-event').value : null,
        offset_days: triggerType !== 'immediate' ? (parseInt(document.getElementById('et-offset-days').value, 10) || null) : null,
        subject,
        body,
        is_active: isActive,
        attach_invoice: attachInvoice
    };

    if (triggerType !== 'immediate' && !payload.offset_days) {
        return alert('Please enter how many days before/after.');
    }

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const response = editingEmailTemplateId
        ? await client.from('email_templates').update(payload).eq('id', editingEmailTemplateId)
        : await client.from('email_templates').insert([payload]);

    if (response.error) return alert('Failed to save: ' + response.error.message);

    closeEmailTemplateModal();
    loadEmailTemplates();
}

async function deleteEmailTemplate(id) {
    if (!confirm('Delete this notice template? It will also be removed from any services it\'s applied to.')) return;
    const client = getSupabase();
    if (!client) return;
    const { error } = await client.from('email_templates').delete().eq('id', id);
    if (error) return alert('Failed to delete: ' + error.message);
    loadEmailTemplates();
}

function flashSaveIndicator(elId) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.classList.remove('hidden');
    clearTimeout(el._hideTimeout);
    el._hideTimeout = setTimeout(() => el.classList.add('hidden'), 1800);
}

function updateLogoPreview() {
    const url = document.getElementById('pb-logo-url')?.value.trim();
    const wrap = document.getElementById('pb-logo-preview-wrap');
    const img = document.getElementById('pb-logo-preview');
    if (!wrap || !img) return;
    if (url) {
        img.src = url;
        wrap.classList.remove('hidden');
    } else {
        wrap.classList.add('hidden');
    }
}

function updateOnboardingLogoPreview() {
    const url = document.getElementById('ob-logo-url')?.value.trim();
    const wrap = document.getElementById('ob-logo-preview-wrap');
    const img = document.getElementById('ob-logo-preview');
    if (!wrap || !img) return;
    if (url) {
        img.src = url;
        wrap.classList.remove('hidden');
    } else {
        wrap.classList.add('hidden');
    }
}

async function uploadLogoToStorage(fileInputId, urlFieldId, statusElId) {
    const fileInput = document.getElementById(fileInputId);
    const file = fileInput?.files?.[0];
    if (!file) return;

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const ext = file.name.split('.').pop();
    const path = `${currentBusinessId}/logo-${Date.now()}.${ext}`;

    const { error: uploadError } = await client.storage.from('business-logos').upload(path, file, { upsert: true });
    if (uploadError) {
        alert('Failed to upload logo: ' + uploadError.message);
        return;
    }

    const { data } = client.storage.from('business-logos').getPublicUrl(path);
    const logoUrlInput = document.getElementById(urlFieldId);
    if (logoUrlInput) logoUrlInput.value = data.publicUrl;
    fileInput.value = '';
    flashSaveIndicator(statusElId);
}

async function uploadBusinessLogo() {
    await uploadLogoToStorage('pb-logo-file', 'pb-logo-url', 'pb-logo-upload-status');
    updateLogoPreview();
    await savePublicBookingSettings();
}

async function uploadOnboardingLogo() {
    await uploadLogoToStorage('ob-logo-file', 'ob-logo-url', 'ob-logo-upload-status');
    updateOnboardingLogoPreview();
}

async function getBusinessSettings() {
    const client = getSupabase();
    if (!client) return null;
    const { data } = await client.from('business_settings').select('*').limit(1).single();
    return data;
}

async function loadBusinessPaymentSettings() {
    const s = await getBusinessSettings();
    if (!s) return;
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    setVal('pay-venmo', s.venmo_handle);
    setVal('pay-zelle', s.zelle_info);
    setVal('pay-cash', s.cash_note);
    setVal('pay-square', s.square_link);
}

async function saveBusinessPaymentSettings() {
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    // business_name/logo_url live in business_settings for historical reasons
    // (receipts read from here), but are now edited once, in the Business
    // Information section above, and just kept in sync here rather than
    // duplicated as their own fields.
    const payload = {
        business_name: document.getElementById('pb-business-name')?.value.trim() || '',
        logo_url: document.getElementById('pb-logo-url')?.value.trim() || '',
        venmo_handle: document.getElementById('pay-venmo')?.value.trim() || '',
        zelle_info: document.getElementById('pay-zelle')?.value.trim() || '',
        cash_note: document.getElementById('pay-cash')?.value.trim() || '',
        square_link: document.getElementById('pay-square')?.value.trim() || ''
    };

    const existing = await getBusinessSettings();
    let response;
    if (existing) {
        response = await client.from('business_settings').update(payload).eq('id', existing.id);
    } else {
        response = await client.from('business_settings').insert([{ ...payload, business_id: currentBusinessId }]);
    }

    if (response.error) return alert('Failed to save: ' + response.error.message);
    flashSaveIndicator('payments-saved');
}

/* ==========================================================================
   PUBLIC BOOKING PAGE SETTINGS
   ========================================================================== */

async function loadPublicBookingSettings() {
    const client = getSupabase();
    if (!client) return;

    const { data: business, error } = await client.from('businesses')
        .select('name, slug, public_booking_enabled, logo_url, accent_color, welcome_message, notification_email, contact_phone, contact_email, address, timezone')
        .eq('id', currentBusinessId)
        .single();

    if (error || !business) {
        console.error('Failed to load public booking settings:', error);
        return;
    }

    document.getElementById('pb-business-name').value = business.name || '';
    document.getElementById('pb-notify-email').value = business.notification_email || '';
    document.getElementById('pb-contact-phone').value = business.contact_phone || '';
    document.getElementById('pb-contact-email').value = business.contact_email || '';
    document.getElementById('pb-address').value = business.address || '';
    const tzSelect = document.getElementById('staff-timezone');
    if (tzSelect) tzSelect.value = business.timezone || 'America/New_York';
    const enabledChk = document.getElementById('pb-enabled');
    if (enabledChk) enabledChk.checked = !!business.public_booking_enabled;
    document.getElementById('pb-welcome').value = business.welcome_message || '';
    document.getElementById('pb-logo-url').value = business.logo_url || '';
    updateLogoPreview();
    document.getElementById('pb-accent-color').value = business.accent_color || '#4f46e5';
    document.getElementById('pb-slug').value = business.slug || '';
    document.getElementById('pb-slug-prefix').textContent = `${window.location.origin}/book.html?biz=`;

    const linkBox = document.getElementById('pb-link-box');
    const linkInput = document.getElementById('pb-link');
    if (business.public_booking_enabled && business.slug) {
        const link = `${window.location.origin}/book.html?biz=${encodeURIComponent(business.slug)}`;
        linkInput.value = link;
        linkBox.classList.remove('hidden');
    } else {
        linkBox.classList.add('hidden');
    }
}

/* Converts free-typed text into a URL-safe slug: lowercase, spaces/underscores
   become hyphens, anything else not a letter/number/hyphen is stripped, and
   repeated or edge hyphens are collapsed/trimmed. */
function slugify(text) {
    return (text || '')
        .toLowerCase()
        .trim()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

/* Live-updates the link box as the person types a slug, so they can see
   exactly what their link will look like before saving. */
function previewPublicBookingSlug() {
    const raw = document.getElementById('pb-slug')?.value || '';
    const linkInput = document.getElementById('pb-link');
    const linkBox = document.getElementById('pb-link-box');
    const enabled = document.getElementById('pb-enabled')?.checked;
    const slug = slugify(raw);
    if (enabled && slug) {
        linkInput.value = `${window.location.origin}/book.html?biz=${encodeURIComponent(slug)}`;
        linkBox.classList.remove('hidden');
    } else {
        linkBox.classList.add('hidden');
    }
}

async function savePublicBookingSettings() {
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const slug = slugify(document.getElementById('pb-slug')?.value || '');
    const enabled = document.getElementById('pb-enabled')?.checked || false;
    const businessName = document.getElementById('pb-business-name')?.value.trim() || '';

    if (enabled && !slug) {
        return alert('Please enter a booking page URL before enabling the public booking page.');
    }
    if (!businessName) {
        return alert('Please enter a business name.');
    }

    const payload = {
        name: businessName,
        public_booking_enabled: enabled,
        welcome_message: document.getElementById('pb-welcome')?.value.trim() || null,
        logo_url: document.getElementById('pb-logo-url')?.value.trim() || null,
        accent_color: document.getElementById('pb-accent-color')?.value || '#4f46e5',
        notification_email: document.getElementById('pb-notify-email')?.value.trim() || null,
        contact_phone: document.getElementById('pb-contact-phone')?.value.trim() || null,
        contact_email: document.getElementById('pb-contact-email')?.value.trim() || null,
        address: document.getElementById('pb-address')?.value.trim() || null,
        timezone: document.getElementById('staff-timezone')?.value || 'America/New_York'
    };
    // slug is NOT NULL in the schema — only include it in the update if there's
    // actually a value, so an empty field never tries to null it out (which
    // would fail the constraint) and instead just leaves the existing slug alone.
    if (slug) payload.slug = slug;

    const { error } = await client.from('businesses').update(payload).eq('id', currentBusinessId);
    if (error) {
        // Postgres unique_violation — someone (or you, previously) already has this slug
        if (error.code === '23505') {
            return alert(`"${slug}" is already taken. Please choose a different booking page URL.`);
        }
        return alert('Failed to save: ' + error.message);
    }

    // Reflect the slugified version back into the field so what's shown matches what saved
    document.getElementById('pb-slug').value = slug;

    // This one save covers both the Business Information and Scheduling
    // Settings sections (same `businesses` row) — flash whichever section's
    // indicator is present, since either one could be what triggered the save.
    flashSaveIndicator('biz-info-saved');
    flashSaveIndicator('scheduling-saved');
    loadPublicBookingSettings(); // refresh the link box now that enabled/slug state may have changed
}

function copyPublicBookingLink() {
    const linkInput = document.getElementById('pb-link');
    if (!linkInput || !linkInput.value) return;
    linkInput.select();
    navigator.clipboard?.writeText(linkInput.value).then(() => {
        alert('Link copied to clipboard.');
    }).catch(() => {
        // Fallback for browsers without Clipboard API permission
        document.execCommand('copy');
    });
}

/* ==========================================================================
   EMAIL (SMTP) SETTINGS — per-business credentials for booking-request
   notifications, sent by the create-public-booking Edge Function.
   ========================================================================== */

async function loadEmailSettings() {
    const client = getSupabase();
    if (!client) return;

    const { data, error } = await client.from('business_email_settings')
        .select('smtp_host, smtp_port, smtp_username, from_email, from_name')
        .eq('business_id', currentBusinessId)
        .maybeSingle();

    if (error) {
        console.error('Failed to load email settings:', error);
        return;
    }

    document.getElementById('em-host').value = data?.smtp_host || '';
    document.getElementById('em-port').value = data?.smtp_port || 587;
    document.getElementById('em-username').value = data?.smtp_username || '';
    document.getElementById('em-from-email').value = data?.from_email || '';
    document.getElementById('em-from-name').value = data?.from_name || '';
    // Password is intentionally never loaded back into the field — the
    // placeholder text ("Leave blank to keep current password") is the only
    // indication one is or isn't already saved.
    document.getElementById('em-password').value = '';
}

async function saveEmailSettings() {
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const host = document.getElementById('em-host')?.value.trim() || '';
    const port = parseInt(document.getElementById('em-port')?.value, 10) || 587;
    const username = document.getElementById('em-username')?.value.trim() || '';
    const fromEmail = document.getElementById('em-from-email')?.value.trim() || '';
    const fromName = document.getElementById('em-from-name')?.value.trim() || '';
    const password = document.getElementById('em-password')?.value; // not trimmed — passwords can legitimately have meaningful whitespace

    const payload = {
        business_id: currentBusinessId,
        smtp_host: host || null,
        smtp_port: port,
        smtp_username: username || null,
        from_email: fromEmail || null,
        from_name: fromName || null,
        updated_at: new Date().toISOString()
    };
    // Only touch the password column if they actually typed something —
    // leaving the field blank means "keep whatever's already saved", not
    // "clear it out".
    if (password) payload.smtp_password = password;

    const { error } = await client.from('business_email_settings')
        .upsert(payload, { onConflict: 'business_id' });

    if (error) return alert('Failed to save: ' + error.message);

    document.getElementById('em-password').value = '';
    flashSaveIndicator('email-settings-saved');
}

function closeDocumentOverlay() {
    const el = document.getElementById('doc-overlay');
    if (el) el.remove();
}

function renderDocumentOverlay(html) {
    closeDocumentOverlay();
    const overlay = document.createElement('div');
    overlay.id = 'doc-overlay';
    overlay.className = 'doc-overlay-backdrop';
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:9999; display:flex; align-items:center; justify-content:center; padding:1rem;';
    overlay.innerHTML = `
        <div class="doc-overlay-card" style="background:#fff; border-radius:0.5rem; max-width:480px; width:100%; padding:1.5rem; position:relative;">
            <button class="no-print" onclick="closeDocumentOverlay()" style="position:absolute; top:0.75rem; right:0.75rem; background:none; border:none; cursor:pointer;"><i data-lucide="x" style="width:18px;height:18px;"></i></button>
            ${html}
            <div class="no-print" style="margin-top:1.25rem; display:flex; gap:0.5rem;">
                <button class="btn" onclick="closeDocumentOverlay()">Close</button>
                <button class="btn-primary" onclick="window.print()">Print</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    refreshIcons();
}

/* Shared "letterhead" block — logo + business name + contact info as one
   cohesive header, instead of separate stacked lines. Used by both the
   payment notice (unpaid invoice) and receipt (paid invoice) documents. */
function businessHeaderHtml(settings, biz) {
    const contactLine = [biz?.contact_phone, biz?.contact_email, biz?.address].filter(Boolean).join(' · ');
    return `
        <div style="display:flex; align-items:center; gap:0.85rem; margin-bottom:1.25rem; padding-bottom:1rem; border-bottom:1px solid var(--border);">
            ${settings?.logo_url ? `<img src="${settings.logo_url}" style="max-height:52px; max-width:90px; object-fit:contain; flex-shrink:0;">` : ''}
            <div>
                <div style="font-weight:700; font-size:1.1rem;">${settings?.business_name || 'Your Business'}</div>
                ${contactLine ? `<div style="color:var(--text-muted); font-size:0.78rem; margin-top:0.15rem;">${contactLine}</div>` : ''}
            </div>
        </div>
    `;
}

async function showPaymentNotice(invoiceId) {
    const client = getSupabase();
    if (!client) return;

    const { data: inv } = await client.from('invoices').select('*, households(name)').eq('id', invoiceId).single();
    if (!inv) return;
    const settings = await getBusinessSettings();
    const { data: biz } = await client.from('businesses').select('contact_phone, contact_email, address').eq('id', currentBusinessId).single();

    const paymentOptions = [];
    if (settings?.venmo_handle) paymentOptions.push(`<li><strong>Venmo:</strong> ${settings.venmo_handle}</li>`);
    if (settings?.zelle_info) paymentOptions.push(`<li><strong>Zelle:</strong> ${settings.zelle_info}</li>`);
    if (settings?.cash_note) paymentOptions.push(`<li><strong>Cash:</strong> ${settings.cash_note}</li>`);
    if (settings?.square_link) paymentOptions.push(`<li><strong>Square:</strong> <a href="${settings.square_link}" target="_blank">${settings.square_link}</a></li>`);

    const serviceWhen = inv.service_start_date ? (inv.service_end_date && inv.service_end_date !== inv.service_start_date ? `${inv.service_start_date} → ${inv.service_end_date}` : inv.service_start_date) : null;

    renderDocumentOverlay(`
        ${businessHeaderHtml(settings, biz)}
        <p style="color:var(--text-muted); margin:0 0 1rem;">Amount Due</p>
        <div style="font-size:2rem; font-weight:700; margin-bottom:1rem;">$${Number(inv.amount || 0).toFixed(2)}</div>
        <p><strong>${inv.description || 'Invoice'}</strong></p>
        <p style="color:var(--text-muted);">${inv.households?.name || ''} ${inv.due_date ? '· Due ' + inv.due_date : ''}</p>
        ${inv.pet_names ? `<p style="color:var(--text-muted); font-size:0.9rem; margin-top:0.3rem;"><strong>Pet(s):</strong> ${inv.pet_names}</p>` : ''}
        ${serviceWhen ? `<p style="color:var(--text-muted); font-size:0.9rem; margin-top:0.1rem;"><strong>Service Date(s):</strong> ${serviceWhen}</p>` : ''}
        <h4 style="margin:1rem 0 0.5rem;">Ways to Pay</h4>
        <ul style="margin:0; padding-left:1.2rem;">${paymentOptions.join('') || '<li>No payment methods configured yet.</li>'}</ul>
    `);
}

async function showReceipt(invoiceId) {
    const client = getSupabase();
    if (!client) return;

    const { data: inv } = await client.from('invoices').select('*, households(name)').eq('id', invoiceId).single();
    if (!inv) return;
    const settings = await getBusinessSettings();
    const { data: biz } = await client.from('businesses').select('contact_phone, contact_email, address').eq('id', currentBusinessId).single();

    const serviceWhen = inv.service_start_date ? (inv.service_end_date && inv.service_end_date !== inv.service_start_date ? `${inv.service_start_date} → ${inv.service_end_date}` : inv.service_start_date) : null;

    renderDocumentOverlay(`
        ${businessHeaderHtml(settings, biz)}
        <div style="display:inline-block; background:#16a34a; color:#fff; font-weight:800; font-size:0.85rem; letter-spacing:0.06em; padding:0.3rem 0.9rem; border-radius:999px; margin-bottom:1rem;">PAID</div>
        <div style="font-size:2rem; font-weight:700; margin-bottom:1rem;">$${Number(inv.amount || 0).toFixed(2)}</div>
        <p><strong>${inv.description || 'Invoice'}</strong></p>
        <p style="color:var(--text-muted);">${inv.households?.name || ''}</p>
        ${inv.pet_names ? `<p style="color:var(--text-muted); font-size:0.9rem; margin-top:0.3rem;"><strong>Pet(s):</strong> ${inv.pet_names}</p>` : ''}
        ${serviceWhen ? `<p style="color:var(--text-muted); font-size:0.9rem; margin-top:0.1rem;"><strong>Service Date(s):</strong> ${serviceWhen}</p>` : ''}
        ${inv.paid_date ? `<p style="color:var(--text-muted); font-size:0.9rem; margin-top:0.1rem;"><strong>Paid Date:</strong> ${inv.paid_date}</p>` : ''}
        ${inv.payment_method ? `<p style="color:var(--text-muted); font-size:0.9rem; margin-top:0.1rem;"><strong>Payment Method:</strong> ${inv.payment_method}</p>` : ''}
        <p style="color:var(--text-muted); font-size:0.85rem; margin-top:1rem;">Paid in full. Thank you!</p>
    `);
}

/* ==========================================================================
   FINANCIAL REPORTING EXPORTS (CSV)
   ========================================================================== */

function downloadCSV(filename, headers, rows) {
    const escapeCell = (val) => {
        const s = val == null ? '' : String(val);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [headers.map(escapeCell).join(',')];
    rows.forEach(row => lines.push(row.map(escapeCell).join(',')));
    const csv = lines.join('\r\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function exportInvoicesCSV() {
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const statusFilter = document.getElementById('biz-invoice-status-filter')?.value || 'all';
    const query = document.getElementById('biz-invoice-search')?.value.trim().toLowerCase() || '';

    let dbQuery = client.from('invoices').select('*, households(name)').order('due_date', { ascending: true });
    if (statusFilter !== 'all') dbQuery = dbQuery.eq('status', statusFilter);

    const { data: invoices } = await dbQuery;
    let list = invoices || [];
    if (query) {
        list = list.filter(i =>
            (i.description || '').toLowerCase().includes(query) ||
            (i.households?.name || '').toLowerCase().includes(query)
        );
    }

    if (!list.length) return alert('No invoices to export for the current filter.');

    const rows = list.map(i => [
        i.due_date || '',
        i.households?.name || '',
        i.description || '',
        Number(i.amount || 0).toFixed(2),
        i.status || 'unpaid'
    ]);

    const totalAmount = list.reduce((sum, i) => sum + Number(i.amount || 0), 0);
    rows.push(['', '', 'TOTAL', totalAmount.toFixed(2), '']);

    downloadCSV(`invoices-${statusFilter}-${new Date().toISOString().slice(0, 10)}.csv`,
        ['Due Date', 'Household', 'Description', 'Amount', 'Status'], rows);
}

async function exportFinancialSummaryCSV() {
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const { from, to } = bizDateRange();

    const { data: invoices } = await client.from('invoices').select('*, households(name)')
        .gte('due_date', from || '1970-01-01').lte('due_date', to);
    const { data: bookings } = await client.from('bookings').select('*, staff:assigned_staff_id(name), households(name)')
        .gte('check_in', from ? from + 'T00:00:00' : '1970-01-01').lte('check_in', to + 'T23:59:59');

    const invoiceRows = (invoices || []).map(i => [
        'Invoice', i.due_date || '', i.households?.name || '', i.description || '', Number(i.amount || 0).toFixed(2), i.status || 'unpaid'
    ]);
    const bookingRows = (bookings || []).map(bk => [
        'Appointment', (bk.check_in || '').slice(0, 10), bk.households?.name || '', bk.service_name || '', Number(bk.amount || 0).toFixed(2), bk.status || 'pending'
    ]);

    const grossRevenue = (invoices || []).filter(i => i.status === 'paid').reduce((sum, i) => sum + Number(i.amount || 0), 0);
    const totalBookingRevenue = (bookings || []).reduce((sum, bk) => sum + Number(bk.amount || 0), 0);

    const rows = [
        ['Summary', '', '', `Range: ${from} to ${to}`, '', ''],
        ['Summary', '', '', 'Gross Revenue (Paid Invoices)', grossRevenue.toFixed(2), ''],
        ['Summary', '', '', 'Total Booked Value (All Appointments)', totalBookingRevenue.toFixed(2), ''],
        ['Summary', '', '', 'Invoice Count', String((invoices || []).length), ''],
        ['Summary', '', '', 'Appointment Count', String((bookings || []).length), ''],
        ...invoiceRows,
        ...bookingRows
    ];

    downloadCSV(`financial-summary-${from}-to-${to}.csv`,
        ['Type', 'Date', 'Household', 'Description', 'Amount', 'Status'], rows);
}

//=======================================
// GOOGLE CALENDAR CONNECTION AUTH FLOW
//=======================================

async function updateStaffCalendarButton(staffId) {
    const slot = document.getElementById(`staff-cal-btn-${staffId}`);
    if (!slot) return; // profile navigated away before this resolved

    const client = getSupabase();
    if (!client) return;

    const { data: token } = await client
        .from('staff_oauth_tokens')
        .select('id')
        .eq('staff_id', staffId)
        .eq('provider', 'google')
        .maybeSingle();

    slot.innerHTML = token
        ? `<span style="font-size:0.78rem; color:var(--success-text,#065f46); background:var(--success,#d1fae5); padding:0.3rem 0.7rem; border-radius:999px; font-weight:600; white-space:nowrap;">✓ Calendar Synced</span>`
        : `<button class="btn" style="font-size:0.78rem; padding:0.4rem 0.75rem; white-space:nowrap;" onclick="connectGoogleCalendar('${staffId}')"><i data-lucide="calendar-plus" style="width:14px;height:14px;"></i> Connect Calendar</button>`;
    refreshIcons();
}

function connectGoogleCalendar(staffId) {
  if (!staffId) return alert('Select a staff member or business account first.');

  const clientId = '98334060087-joojoek72rhn66lqn7d94lod0s9e7g03.apps.googleusercontent.com';
  const redirectUri = encodeURIComponent('https://barkboard-three.vercel.app/api/auth/google/callback');
  const scope = encodeURIComponent('https://www.googleapis.com/auth/calendar');
  
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scope}&access_type=offline&prompt=consent&state=${staffId}`;

  window.open(authUrl, 'ConnectGoogleCalendar', 'width=600,height=700');
  _connectingStaffId = staffId;
}

let _connectingStaffId = null;

// Listen for completion postMessage from popup window
window.addEventListener('message', (event) => {
  if (event.data?.type === 'GOOGLE_OAUTH_SUCCESS') {
    alert('Google Calendar synced successfully!');
    if (typeof renderStaffRoster === 'function') renderStaffRoster();
    if (_connectingStaffId) updateStaffCalendarButton(_connectingStaffId);
  }
});

// Add this helper function at the bottom of app.js:
async function pushBookingToGoogleCalendar(bookingId) {
  try {
    await fetch('/api/sync-to-google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingId })
    });
  } catch (err) {
    console.warn('Google Calendar sync background trigger failed:', err);
  }
}
