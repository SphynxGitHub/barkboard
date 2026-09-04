// Credentials
const SUPABASE_URL = 'https://qhfdtnylbpbooicsbhct.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFoZmR0bnlsYnBib29pY3NiaGN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0NTI5NDMsImV4cCI6MjEwNDAyODk0M30.SnLDb2BP0WVI2HCyuDLxt5qdnGBzRmd6cjgHDCpQKRo';

// PostgREST nested embeds (e.g. bookings(*, resources(name))) have repeatedly
// broken silently in this project when a referenced FK constraint was recently
// altered — the whole query returns empty instead of erroring loudly. This
// attaches resource names manually via a separate lookup instead, so a stale
// embed cache can never take down an entire page's data.
async function attachResourceNames(client, bookings) {
    if (!bookings || !bookings.length) return bookings || [];
    const { data: allResources } = await client.from('resources').select('id, name');
    const map = {};
    (allResources || []).forEach(r => { map[r.id] = r; });
    bookings.forEach(bk => {
        bk.resources = bk.space_id ? (map[bk.space_id] || null) : null;
        bk.staff_time_resource = bk.staff_time_resource_id ? (map[bk.staff_time_resource_id] || null) : null;
    });
    return bookings;
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
        window.supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
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
   APP CONTROLLER: Event Handlers & View Management
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    refreshIcons();

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
});

async function renderTodaysOverview() {
    const client = getSupabase();
    if (!client) return;

    const today = new Date().toISOString().slice(0, 10);
    const todayStart = today + 'T00:00:00';
    const todayEnd = today + 'T23:59:59';

    const [{ data: resources }, { data: todaysBookings }, { data: pendingInvoices }, { data: openTasks }] = await Promise.all([
        client.from('resources').select('id'),
        client.from('bookings').select('space_id, requires_staff_time, status')
            .neq('status', 'cancelled')
            .lte('check_in', todayEnd).gte('check_out', todayStart),
        client.from('invoices').select('id').eq('status', 'unpaid'),
        client.from('staff_tasks').select('id').eq('is_done', false)
    ]);

    const totalResources = (resources || []).length;
    const occupiedResources = new Set((todaysBookings || []).filter(bk => bk.space_id).map(bk => bk.space_id)).size;
    const trainingSessions = (todaysBookings || []).filter(bk => bk.requires_staff_time).length;

    const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    setText('stat-kennels', `${occupiedResources} / ${totalResources}`);
    setText('stat-training', String(trainingSessions));
    setText('stat-invoices', String((pendingInvoices || []).length));
    setText('stat-tasks', String((openTasks || []).length));
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
    const { error } = await client.from('staff_tasks').insert([{ task_text: text, due_date: today, priority: 'normal', is_done: false }]);

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
    if (viewId === 'calendar-view' && typeof renderCalendar === 'function') {
        renderCalendar();
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

async function openBookingModal(householdId, bookingId = null) {
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
    const resourceField = document.getElementById('bk-resource-field');
    const resourceSel = document.getElementById('bk-resource-id');
    const staffTimeField = document.getElementById('bk-staff-time-field');
    const staffTimeMinutesInput = document.getElementById('bk-staff-time-minutes');
    const staffTimeResourceField = document.getElementById('bk-staff-time-resource-field');
    const staffTimeResourceSel = document.getElementById('bk-staff-time-resource-id');

    if (titleEl) titleEl.textContent = bookingId ? 'Edit Event' : 'Add Event';

    // Reset fields
    if (typeSel) typeSel.value = 'appointment';
    if (serviceInput) serviceInput.value = '';
    if (startDateInput) startDateInput.value = '';
    if (startTimeInput) startTimeInput.value = '';
    if (endDateInput) endDateInput.value = '';
    if (document.getElementById('bk-end-time')) document.getElementById('bk-end-time').value = '';
    if (amountInput) amountInput.value = '';
    if (statusSel) statusSel.value = 'pending';
    if (notesInput) notesInput.value = '';
    if (resourceField) resourceField.classList.add('hidden');
    if (resourceSel) resourceSel.innerHTML = '<option value="">Unassigned</option>';
    if (staffTimeField) staffTimeField.classList.add('hidden');
    if (staffTimeMinutesInput) staffTimeMinutesInput.value = '';
    if (staffTimeResourceField) staffTimeResourceField.classList.add('hidden');
    if (staffTimeResourceSel) staffTimeResourceSel.innerHTML = '<option value="">Unassigned</option>';
    document.getElementById('bk-invoice-section')?.classList.add('hidden');
    currentBookingResourceType = null;
    currentStaffTimeResourceType = null;
    document.getElementById('bk-service-type-results')?.classList.add('hidden');
    if (!bookingId && pendingCalendarDate && startDateInput) {
        startDateInput.value = pendingCalendarDate;
    }
    pendingCalendarDate = null;
    toggleBookingTypeFields();

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    // Load this household's pets as checkboxes
    const { data: pets } = await client.from('pets').select('id, name, species').eq('household_id', householdId).order('name');

    // Load staff for optional assignment
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
        if (bk?.pet_id) selectedPetIds = [bk.pet_id];
    }

    if (petBox) {
        petBox.innerHTML = (pets && pets.length)
            ? pets.map(p => `
                <label style="display:flex; align-items:center; gap:0.4rem; font-size:0.85rem;">
                    <input type="checkbox" class="bk-pet-checkbox" value="${p.id}" ${selectedPetIds.includes(p.id) ? 'checked' : ''}>
                    ${p.name} (${p.species})
                </label>
            `).join('')
            : '<span style="font-size:0.8rem; color:var(--text-muted);">No pets on file for this household yet.</span>';
    }

    if (existingBooking) {
        const checkInDate = existingBooking.check_in ? existingBooking.check_in.slice(0, 10) : '';
        const checkInTime = existingBooking.check_in ? existingBooking.check_in.slice(11, 16) : '';
        const checkOutDate = existingBooking.check_out ? existingBooking.check_out.slice(0, 10) : '';
        const checkOutTime = existingBooking.check_out ? existingBooking.check_out.slice(11, 16) : '';
        const isStay = checkOutDate && checkOutDate !== checkInDate;
        const endTimeInput = document.getElementById('bk-end-time');

        if (typeSel) typeSel.value = isStay ? 'stay' : 'appointment';
        if (serviceInput) serviceInput.value = existingBooking.service_name || '';
        if (startDateInput) startDateInput.value = checkInDate;
        if (startTimeInput) startTimeInput.value = checkInTime;
        if (isStay && endDateInput) endDateInput.value = checkOutDate;
        if (isStay && endTimeInput) endTimeInput.value = checkOutTime;
        if (amountInput) amountInput.value = existingBooking.amount != null ? existingBooking.amount : '';
        if (statusSel) statusSel.value = existingBooking.status || 'pending';
        if (staffSel) staffSel.value = existingBooking.assigned_staff_id || '';
        if (notesInput) notesInput.value = existingBooking.notes || '';
        toggleBookingTypeFields();

        // Restore resource / staff-time fields by looking up the matching template
        const { data: matchedTemplate } = await client.from('appointment_type_templates').select('*').eq('name', existingBooking.service_name || '').maybeSingle();
        let resourceType = matchedTemplate?.resource_type || null;
        if (!resourceType && existingBooking.space_id) {
            const { data: existingResource } = await client.from('resources').select('type').eq('id', existingBooking.space_id).maybeSingle();
            resourceType = existingResource?.type || null;
        }
        currentBookingResourceType = resourceType;
        if (resourceType) {
            if (resourceField) resourceField.classList.remove('hidden');
            await populateResourceSelect('bk-resource-id', resourceType, existingBooking.space_id);
        }

        const needsStaffTime = existingBooking.requires_staff_time || matchedTemplate?.requires_staff_time || false;
        currentStaffTimeResourceType = needsStaffTime ? (matchedTemplate?.staff_time_resource_type || null) : null;
        if (!currentStaffTimeResourceType && existingBooking.staff_time_resource_id) {
            const { data: existingStaffResource } = await client.from('resources').select('type').eq('id', existingBooking.staff_time_resource_id).maybeSingle();
            currentStaffTimeResourceType = existingStaffResource?.type || null;
        }
        if (needsStaffTime || existingBooking.staff_time_resource_id) {
            if (staffTimeField) staffTimeField.classList.remove('hidden');
            if (staffTimeMinutesInput) staffTimeMinutesInput.value = existingBooking.staff_time_minutes || matchedTemplate?.staff_time_minutes || '';
            if (currentStaffTimeResourceType) {
                if (staffTimeResourceField) staffTimeResourceField.classList.remove('hidden');
                await populateResourceSelect('bk-staff-time-resource-id', currentStaffTimeResourceType, existingBooking.staff_time_resource_id);
            }
        }

        // Show the linked invoice (if any) with a jump-to-edit button, or a quick way to create one.
        const invoiceSection = document.getElementById('bk-invoice-section');
        const invoiceInfo = document.getElementById('bk-invoice-info');
        if (invoiceSection && invoiceInfo) {
            invoiceSection.classList.remove('hidden');
            if (existingBooking.invoice_id) {
                const { data: linkedInv } = await client.from('invoices').select('*').eq('id', existingBooking.invoice_id).single();
                invoiceInfo.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center; padding:0.5rem 0.65rem; border:1px solid var(--border); border-radius:0.25rem; background:var(--bg-hover,#f9fafb); font-size:0.85rem;">
                        <span>${linkedInv?.description || 'Invoice'} · $${Number(linkedInv?.amount || 0).toFixed(2)} · <span style="text-transform:capitalize;">${linkedInv?.status || 'unpaid'}</span></span>
                        <button class="btn" style="font-size:0.75rem; padding:0.25rem 0.5rem;" onclick="closeBookingModal(); openInvoiceModal('${bookingHouseholdId}', '${existingBooking.invoice_id}')">View / Edit</button>
                    </div>
                `;
            } else {
                invoiceInfo.innerHTML = `
                    <input type="text" id="bk-invoice-link-search" placeholder="Type to filter this household's invoices..." style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:0.25rem;" onkeyup="searchInvoicesForBooking(this.value, '${existingBooking.id}')">
                    <div id="bk-invoice-link-results" style="margin-top:0.4rem; display:flex; flex-direction:column; gap:0.3rem; max-height:180px; overflow-y:auto;"></div>
                    <button class="btn" style="font-size:0.8rem; padding:0.35rem 0.7rem; margin-top:0.5rem;" onclick="closeBookingModal(); openInvoiceModal('${bookingHouseholdId}')">+ Create New Invoice</button>
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

async function searchServiceTypeForBooking(query) {
    const container = document.getElementById('bk-service-type-results');
    if (!container) return;
    const q = query.trim();

    const client = getSupabase();
    if (!client) return;

    let dbQuery = client.from('appointment_type_templates').select('*').order('name').limit(8);
    if (q) dbQuery = dbQuery.ilike('name', `%${q}%`);
    const { data: matches } = await dbQuery;

    const rows = (matches || []).map(t => `
        <div style="padding:0.5rem 0.65rem; cursor:pointer; font-size:0.85rem; border-bottom:1px solid var(--border);" onmousedown='selectServiceTypeTemplate(${JSON.stringify(t.name)}, ${JSON.stringify(t.resource_type || null)}, ${t.default_price != null ? t.default_price : 'null'}, ${!!t.requires_staff_time}, ${t.staff_time_minutes || 'null'}, ${JSON.stringify(t.staff_time_resource_type || null)})'>
            <strong>${t.name}</strong>
            <span style="color:var(--text-muted); font-size:0.78rem;">${t.default_price != null ? ' · $' + Number(t.default_price).toFixed(2) : ''}${t.resource_type ? ' · needs ' + t.resource_type : ''}${t.requires_staff_time ? ' · staff time' : ''}</span>
        </div>
    `).join('');

    const customRow = q ? `<div style="padding:0.5rem 0.65rem; cursor:pointer; font-size:0.85rem; color:var(--text-muted);" onmousedown='selectServiceTypeTemplate(${JSON.stringify(q)}, null, null, false, null, null)'>Use custom: "${q}"</div>` : '';

    container.innerHTML = rows + customRow || '<div style="padding:0.5rem 0.65rem; font-size:0.82rem; color:var(--text-muted);">No matching appointment types — start typing to enter a custom one.</div>';
    container.classList.remove('hidden');
}

let currentBookingResourceType = null;
let currentStaffTimeResourceType = null;

function selectServiceTypeTemplate(name, resourceType, price, requiresStaffTime, staffTimeMinutes, staffTimeResourceType) {
    const serviceInput = document.getElementById('bk-service-type');
    const amountInput = document.getElementById('bk-amount');
    if (serviceInput) serviceInput.value = name;
    if (amountInput && price != null && !amountInput.value) amountInput.value = price;
    document.getElementById('bk-service-type-results')?.classList.add('hidden');

    currentBookingResourceType = resourceType;
    const resourceField = document.getElementById('bk-resource-field');
    if (resourceField) resourceField.classList.toggle('hidden', !resourceType);
    if (resourceType) populateResourceSelect('bk-resource-id', resourceType, null);

    const staffTimeField = document.getElementById('bk-staff-time-field');
    const staffTimeResourceField = document.getElementById('bk-staff-time-resource-field');
    const staffTimeMinutesInput = document.getElementById('bk-staff-time-minutes');
    currentStaffTimeResourceType = requiresStaffTime ? staffTimeResourceType : null;

    if (staffTimeField) staffTimeField.classList.toggle('hidden', !requiresStaffTime);
    if (staffTimeMinutesInput && requiresStaffTime) staffTimeMinutesInput.value = staffTimeMinutes || '';
    if (staffTimeResourceField) staffTimeResourceField.classList.toggle('hidden', !currentStaffTimeResourceType);
    if (currentStaffTimeResourceType) populateResourceSelect('bk-staff-time-resource-id', currentStaffTimeResourceType, null);
}

// Resources of a given type are treated as interchangeable: this shows only
// the ones actually free for the currently entered dates, so picking "the
// next available one" is automatic rather than something staff have to check by hand.
// A resource counts as "used" if it's assigned as either the main resource OR the
// staff-time resource on any other (non-cancelled) booking that overlaps the same window.
async function populateResourceSelect(selectId, resourceType, preserveSelectedId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;

    if (!resourceType) {
        sel.innerHTML = '<option value="">Unassigned</option>';
        return;
    }

    const client = getSupabase();
    if (!client) return;

    const { data: allOfType } = await client.from('resources').select('*').eq('type', resourceType).order('name');
    if (!allOfType || !allOfType.length) {
        sel.innerHTML = '<option value="">No resources of this type set up yet</option>';
        return;
    }

    const type = document.getElementById('bk-type')?.value || 'appointment';
    const startDate = document.getElementById('bk-start-date')?.value;
    const startTime = document.getElementById('bk-start-time')?.value || '00:00';
    const endDate = document.getElementById('bk-end-date')?.value || startDate;

    if (!startDate) {
        sel.innerHTML = '<option value="">Select a date to check availability</option>' + allOfType.map(r => `<option value="${r.id}">${r.name}</option>`).join('');
        return;
    }

    const rangeStart = type === 'stay' ? `${startDate}T00:00:00` : `${startDate}T${startTime}:00`;
    const rangeEnd = type === 'stay' ? `${endDate}T23:59:59` : `${startDate}T23:59:59`;

    let bookedQuery = client.from('bookings').select('space_id, staff_time_resource_id')
        .neq('status', 'cancelled')
        .lte('check_in', rangeEnd).gte('check_out', rangeStart);
    if (editingBookingId) bookedQuery = bookedQuery.neq('id', editingBookingId);

    const { data: bookedRows } = await bookedQuery;
    const bookedIds = new Set();
    (bookedRows || []).forEach(r => {
        if (r.space_id) bookedIds.add(r.space_id);
        if (r.staff_time_resource_id) bookedIds.add(r.staff_time_resource_id);
    });

    const available = allOfType.filter(r => !bookedIds.has(r.id) || r.id === preserveSelectedId);

    if (!available.length) {
        sel.innerHTML = `<option value="">Fully booked — no ${resourceType} available these dates</option>`;
        return;
    }

    sel.innerHTML = available.map((r, i) => `<option value="${r.id}" ${r.id === preserveSelectedId || (!preserveSelectedId && i === 0) ? 'selected' : ''}>${r.name}</option>`).join('');
}

function refreshAllResourceAvailability() {
    if (currentBookingResourceType) populateResourceSelect('bk-resource-id', currentBookingResourceType, document.getElementById('bk-resource-id')?.value || null);
    if (currentStaffTimeResourceType) populateResourceSelect('bk-staff-time-resource-id', currentStaffTimeResourceType, document.getElementById('bk-staff-time-resource-id')?.value || null);
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

async function saveBooking() {
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const type = document.getElementById('bk-type')?.value || 'appointment';
    const serviceName = document.getElementById('bk-service-type')?.value.trim() || '';
    const startDate = document.getElementById('bk-start-date')?.value || '';
    const startTime = document.getElementById('bk-start-time')?.value || '00:00';
    const endDate = document.getElementById('bk-end-date')?.value || '';
    const amountRaw = document.getElementById('bk-amount')?.value;
    const status = document.getElementById('bk-status')?.value || 'pending';
    const staffId = document.getElementById('bk-staff-id')?.value || null;
    const resourceId = document.getElementById('bk-resource-id')?.value || null;
    const requiresStaffTime = !document.getElementById('bk-staff-time-field')?.classList.contains('hidden');
    const staffTimeMinutes = document.getElementById('bk-staff-time-minutes')?.value;
    const staffTimeResourceId = document.getElementById('bk-staff-time-resource-id')?.value || null;
    const endTime = document.getElementById('bk-end-time')?.value || startTime;
    const notes = document.getElementById('bk-notes')?.value.trim() || '';
    const petIds = Array.from(document.querySelectorAll('.bk-pet-checkbox:checked')).map(cb => cb.value);
    const petNames = Array.from(document.querySelectorAll('.bk-pet-checkbox:checked')).map(cb => cb.parentElement?.textContent.trim() || '').filter(Boolean);

    if (!startDate) return alert('Please choose a date.');
    if (type === 'stay' && !endDate) return alert('Please choose an end date for a multi-day stay.');
    if (petIds.length === 0) return alert('Please select at least one pet.');
    if (currentBookingResourceType && !resourceId) {
        return alert(`No ${currentBookingResourceType} is available for these dates. Try different dates or choose a different service type.`);
    }
    if (currentStaffTimeResourceType && !staffTimeResourceId) {
        return alert(`No ${currentStaffTimeResourceType} is available for the staff time on these dates. Try different dates or choose a different service type.`);
    }

    const amount = amountRaw ? parseFloat(amountRaw) : 0;

    // check_in/check_out are timestamps: a single appointment has check_in === check_out,
    // a multi-day stay uses the actual drop-off and pick-up times entered.
    const checkIn = type === 'stay' ? `${startDate}T${startTime}:00` : `${startDate}T${startTime}:00`;
    const checkOut = type === 'stay' ? `${endDate}T${endTime}:00` : checkIn;

    const basePayload = {
        household_id: bookingHouseholdId,
        service_name: serviceName,
        check_in: checkIn,
        check_out: checkOut,
        amount: amount,
        status: status,
        assigned_staff_id: staffId || null,
        space_id: resourceId || null,
        requires_staff_time: requiresStaffTime,
        staff_time_minutes: requiresStaffTime && staffTimeMinutes ? parseInt(staffTimeMinutes, 10) : null,
        staff_time_resource_id: staffTimeResourceId || null,
        notes: notes
    };

    // The bookings table has one pet_id per row, so linking multiple pets means
    // one row per pet. When editing, the edited row becomes the first selected
    // pet, and any additional newly-checked pets get their own new rows.
    let response;
    let firstNewBookingId = null;
    if (editingBookingId) {
        const [firstPetId, ...extraPetIds] = petIds;
        response = await client.from('bookings').update({ ...basePayload, pet_id: firstPetId }).eq('id', editingBookingId);
        if (!response.error && extraPetIds.length) {
            const extraRows = extraPetIds.map(pid => ({ ...basePayload, pet_id: pid }));
            const extraResponse = await client.from('bookings').insert(extraRows);
            if (extraResponse.error) response = extraResponse;
        }
    } else {
        const rows = petIds.map(pid => ({ ...basePayload, pet_id: pid }));
        response = await client.from('bookings').insert(rows).select();
        if (!response.error && response.data && response.data[0]) {
            firstNewBookingId = response.data[0].id;
        }
    }

    if (response.error) {
        alert('Failed to save event: ' + response.error.message);
        console.error('Supabase booking error:', response.error);
    } else {
        // If this is a brand-new priced event, automatically create the matching invoice.
        if (firstNewBookingId && amount > 0) {
            const when = type === 'stay' ? `${startDate} → ${endDate}` : startDate;
            await client.from('invoices').insert([{
                household_id: bookingHouseholdId,
                booking_id: firstNewBookingId,
                description: `${serviceName || 'Event'} — ${when}`,
                amount: amount,
                status: 'unpaid',
                due_date: startDate,
                service_start_date: startDate,
                service_end_date: type === 'stay' ? endDate : startDate,
                pet_names: petNames.join(', ')
            }]);
        }

        const refreshId = bookingHouseholdId;
        closeBookingModal();
        openFullWidthProfile('household', refreshId);
    }
}

async function deleteBooking(id, householdId) {
    if (!confirm('Remove this scheduled event?')) return;
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const { error } = await client.from('bookings').delete().eq('id', id);
    if (error) {
        alert('Error deleting event: ' + error.message);
    } else {
        openFullWidthProfile('household', householdId);
    }
}

let editingInvoiceId = null;
let invoiceHouseholdId = null;

async function openInvoiceModal(householdId, invoiceId = null) {
    editingInvoiceId = invoiceId;
    invoiceHouseholdId = householdId;

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

async function renderLinkedAppointments(invoiceId) {
    const el = document.getElementById('inv-linked-appts-list');
    if (!el) return;

    const client = getSupabase();
    if (!client) return;

    const { data: linked } = await client.from('bookings').select('id, service_name, check_in, check_out, amount').eq('invoice_id', invoiceId).order('check_in');

    el.innerHTML = (linked && linked.length) ? linked.map(bk => {
        const inDate = bk.check_in ? bk.check_in.slice(0, 10) : '';
        const outDate = bk.check_out ? bk.check_out.slice(0, 10) : '';
        const when = outDate && outDate !== inDate ? `${inDate} → ${outDate}` : inDate;
        return `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:0.25rem; background:var(--bg-hover,#f9fafb); font-size:0.82rem;">
                <span>${bk.service_name || 'Event'} · ${when}${bk.amount ? ' · $' + Number(bk.amount).toFixed(2) : ''}</span>
                <button class="btn-icon" onclick="removeAppointmentFromInvoice('${bk.id}', '${invoiceId}')" title="Unlink" style="background:none; border:none; cursor:pointer;"><i data-lucide="x" style="width:13px;height:13px;"></i></button>
            </div>
        `;
    }).join('') : '<p style="font-size:0.82rem; color:var(--text-muted);">No appointments linked yet.</p>';
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
    editingInvoiceId = null;
    invoiceHouseholdId = null;
    const modal = document.getElementById('invoice-modal');
    if (modal) modal.classList.add('hidden');
}

async function saveInvoice() {
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const description = document.getElementById('inv-description')?.value.trim() || '';
    const bookingId = document.getElementById('inv-booking-id')?.value || null;
    const amountRaw = document.getElementById('inv-amount')?.value;
    const dueDate = document.getElementById('inv-due-date')?.value || null;
    const status = document.getElementById('inv-status')?.value || 'unpaid';
    const notes = document.getElementById('inv-notes')?.value.trim() || '';
    const petNames = document.getElementById('inv-pet-names')?.value.trim() || '';
    const serviceStart = document.getElementById('inv-service-start')?.value || null;
    const serviceEnd = document.getElementById('inv-service-end')?.value || null;

    if (!description) return alert('Please enter a description.');
    const amount = parseFloat(amountRaw);
    if (isNaN(amount) || amount < 0) return alert('Please enter a valid amount.');

    const payload = {
        household_id: invoiceHouseholdId,
        description: description,
        amount: amount,
        due_date: dueDate,
        status: status,
        notes: notes,
        pet_names: petNames,
        service_start_date: serviceStart,
        service_end_date: serviceEnd
    };

    let response;
    let savedInvoiceId = editingInvoiceId;
    if (editingInvoiceId) {
        response = await client.from('invoices').update(payload).eq('id', editingInvoiceId);
    } else {
        response = await client.from('invoices').insert([payload]).select();
        if (!response.error && response.data && response.data[0]) {
            savedInvoiceId = response.data[0].id;
        }
    }

    // The convenience "Linked Event" picker attaches that one appointment now;
    // more can be added afterward via the Linked Appointments manager when editing.
    if (!response.error && bookingId && savedInvoiceId) {
        await client.from('bookings').update({ invoice_id: savedInvoiceId }).eq('id', bookingId);
    }

    if (response.error) {
        alert('Failed to save invoice: ' + response.error.message);
        console.error('Supabase invoice error:', response.error);
    } else {
        const refreshId = invoiceHouseholdId;
        closeInvoiceModal();
        openFullWidthProfile('household', refreshId);
    }
}

async function deleteInvoice(id, householdId) {
    if (!confirm('Remove this invoice?')) return;
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const { error } = await client.from('invoices').delete().eq('id', id);
    if (error) {
        alert('Error deleting invoice: ' + error.message);
    } else {
        openFullWidthProfile('household', householdId);
    }
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

async function markInvoicePaid(id, householdId) {
    const client = getSupabase();
    if (!client) return;
    await client.from('invoices').update({ status: 'paid' }).eq('id', id);
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
            .insert([payload]);
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
        response = await client.from('staff_availability').insert([payload]);
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

    const { error } = await client.from('staff_assignments').insert([{ staff_id: staffId, pet_id: petId, role }]);
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

async function renderStaffTasks() {
    const el = document.getElementById('staff-tasks-list');
    if (!el) return;

    const filterStaff = document.getElementById('staff-task-filter')?.value || 'all';
    const filterStatus = document.getElementById('staff-task-status-filter')?.value || 'all';

    const client = getSupabase();
    if (!client) return;

    let query = client.from('staff_tasks').select('*, staff(name)').order('due_date', { ascending: true });
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
                <span style="font-size:0.78rem;color:var(--text-muted);margin-left:0.5rem;"><i data-lucide="user" style="width:11px;height:11px;"></i> ${t.staff?.name || 'Unassigned'} · Due ${t.due_date || 'no date'}</span>
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

let returnToStaffProfile = null;

async function openStaffTaskModal(id) {
    editingStaffTaskId = id;
    if (typeof populateStaffSelects === 'function') await populateStaffSelects();

    const titleEl = document.getElementById('staff-task-modal-title');
    if (titleEl) titleEl.textContent = id ? 'Edit Task' : 'Add Task';

    const whoSel = document.getElementById('stsk-who');
    const textInput = document.getElementById('stsk-text');
    const dueInput = document.getElementById('stsk-due');
    const prioritySel = document.getElementById('stsk-priority');

    if (id) {
        const client = getSupabase();
        const { data: t } = client ? await client.from('staff_tasks').select('*').eq('id', id).single() : { data: null };
        if (t) {
            if (whoSel) whoSel.value = t.staff_id || '';
            if (textInput) textInput.value = t.task_text || '';
            if (dueInput) dueInput.value = t.due_date || '';
            if (prioritySel) prioritySel.value = t.priority || 'normal';
        }
    } else {
        if (textInput) textInput.value = '';
        if (dueInput) dueInput.value = '';
        if (prioritySel) prioritySel.value = 'normal';
    }

    const modal = document.getElementById('staff-task-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeStaffTaskModal() {
    returnToStaffProfile = null;
    const modal = document.getElementById('staff-task-modal');
    if (modal) modal.classList.add('hidden');
}

async function saveStaffTask() {
    const staffId = document.getElementById('stsk-who')?.value || null;
    const text = document.getElementById('stsk-text')?.value.trim();
    const due = document.getElementById('stsk-due')?.value || null;
    const priority = document.getElementById('stsk-priority')?.value || 'normal';

    if (!text) return alert('Please enter a task description.');

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const payload = { staff_id: staffId, task_text: text, due_date: due, priority };
    let response;
    if (editingStaffTaskId) {
        response = await client.from('staff_tasks').update(payload).eq('id', editingStaffTaskId);
    } else {
        response = await client.from('staff_tasks').insert([{ ...payload, is_done: false }]);
    }

    if (response.error) {
        alert('Failed to save task: ' + response.error.message);
        return;
    }

    editingStaffTaskId = null;
    closeStaffTaskModal();
    if (returnToStaffProfile) {
        const sid = returnToStaffProfile;
        returnToStaffProfile = null;
        openFullWidthProfile('staff', sid);
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
                ${dayBookings.map(bk => `
                    <div style="padding:0.4rem; margin-bottom:0.3rem; border-radius:0.25rem; background:var(--bg-hover,#f1f5f9); font-size:0.75rem; cursor:pointer;" onclick="openBookingModal('${bk.household_id}', '${bk.id}')">
                        <strong>${bk.check_in ? bk.check_in.slice(11, 16) : ''}</strong> ${bk.service_name || 'Event'}<br>
                        <span style="color:var(--text-muted);">${bk.pets?.name || ''}${bk.pets?.name && bk.households?.name ? ' · ' : ''}${bk.households?.name || ''}${bk.resources?.name ? ' · ' + bk.resources.name : ''}</span>
                    </div>
                `).join('')}
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

let editingResourceId = null;

async function renderResourceList() {
    const el = document.getElementById('resource-list');
    if (!el) return;

    const client = getSupabase();
    if (!client) return;

    const { data: list } = await client.from('resources').select('*').order('name');

    if (!list || !list.length) {
        el.innerHTML = '<div class="biz-empty">No resource spaces yet.</div>';
        return;
    }

    el.innerHTML = list.map(r => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-card);">
            <div>
                <strong>${r.name}</strong>
                <span style="font-size:0.78rem; color:var(--text-muted); margin-left:0.5rem;">${r.type || ''}</span>
                ${r.blackouts && r.blackouts.length ? `<div style="font-size:0.75rem; color:var(--text-muted); margin-top:0.2rem;">Blackouts: ${r.blackouts.join(', ')}</div>` : ''}
                ${r.notes ? `<div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.2rem;">${r.notes}</div>` : ''}
            </div>
            <div style="display:flex; gap:0.4rem;">
                <button class="btn-icon" style="background:none;border:none;cursor:pointer;padding:0.25rem;" onclick="openResourceModal('${r.id}')" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px;"></i></button>
                <button class="btn-icon" style="background:none;border:none;cursor:pointer;padding:0.25rem;color:var(--danger-text);" onclick="deleteResource('${r.id}')" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
            </div>
        </div>
    `).join('');
}

async function openResourceModal(id) {
    editingResourceId = id;
    let r = null;
    if (id) {
        const client = getSupabase();
        const { data } = client ? await client.from('resources').select('*').eq('id', id).single() : { data: null };
        r = data;
    }

    const titleEl = document.getElementById('resource-modal-title');
    if (titleEl) titleEl.textContent = r ? 'Edit Resource' : 'Add Resource';

    const nameInput = document.getElementById('rm-name');
    const typeSelect = document.getElementById('rm-type');
    const blackoutsArea = document.getElementById('rm-blackouts');
    const notesInput = document.getElementById('rm-notes');

    if (nameInput) nameInput.value = r ? r.name : '';
    if (typeSelect) typeSelect.value = r ? r.type : 'Dog Suite';
    if (blackoutsArea) blackoutsArea.value = r && r.blackouts ? r.blackouts.join('\n') : '';
    if (notesInput) notesInput.value = r ? r.notes || '' : '';

    const modal = document.getElementById('resource-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeResourceModal() {
    const modal = document.getElementById('resource-modal');
    if (modal) modal.classList.add('hidden');
}

async function saveResource() {
    const name = document.getElementById('rm-name')?.value.trim();
    if (!name) return alert('Please enter a resource name.');

    const type = document.getElementById('rm-type')?.value || 'Dog Suite';
    const notes = document.getElementById('rm-notes')?.value.trim() || '';
    const blackoutsText = document.getElementById('rm-blackouts')?.value || '';
    const blackouts = blackoutsText.split('\n').map(s => s.trim()).filter(Boolean);

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const payload = { name, type, notes, blackouts };
    let response;
    if (editingResourceId) {
        response = await client.from('resources').update(payload).eq('id', editingResourceId);
    } else {
        response = await client.from('resources').insert([payload]);
    }

    if (response.error) {
        alert('Failed to save resource: ' + response.error.message);
        return;
    }

    editingResourceId = null;
    closeResourceModal();
    renderResourceList();
    if (typeof renderCalendar === 'function') renderCalendar();
}

async function deleteResource(id) {
    if (!confirm('Remove this resource space?')) return;

    const client = getSupabase();
    if (!client) return;
    await client.from('resources').delete().eq('id', id);

    renderResourceList();
    if (typeof renderCalendar === 'function') renderCalendar();
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
    }
    if (tab === 'invoices' && typeof renderInvoicesList === 'function') {
        renderInvoicesList();
    }
    if (tab === 'payments' && typeof loadBusinessPaymentSettings === 'function') {
        loadBusinessPaymentSettings();
    }
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
    await client.from('invoices').update({ status: newStatus }).eq('id', id);
    if (newStatus === 'paid') showReceipt(id);
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
        response = await client.from('business_closures').insert([payload]);
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
            category: pendingPersonCategory || 'member'
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
        const { data: inserted, error } = await client.from('households').insert([{ name: hhName, address, note: role }]).select();
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
        response = await client.from('pets').insert([payload]);
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
        response = await client.from('vets').insert([payload]).select();
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

function detailField(label, value) {
    return `<div><span style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.03em;">${label}</span><div style="font-size:0.9rem; margin-top:0.1rem;">${value || '—'}</div></div>`;
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
    }

    return `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; padding-bottom:1.25rem; margin-bottom:1.5rem; border-bottom:1px solid var(--border);">
            <div id="details-view-${key}" style="display:flex; flex-wrap:wrap; gap:1.5rem; flex:1;">${viewFields}</div>
            <div id="details-edit-${key}" class="hidden" style="display:flex; flex-wrap:wrap; gap:1rem; flex:1;">${editFields}</div>
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
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1.5rem; align-items:start;">
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
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1.5rem; align-items:start;">
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

                <!-- History (placeholder) -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <h3 style="margin:0 0 0.5rem 0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="clipboard-list"></i> History</h3>
                    <p style="font-size:0.85rem; color:var(--text-muted);">Progress reports, training assessments, and visit notes will live here. Coming soon.</p>
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
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1.5rem; align-items:start;">
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
    } else if (kind === 'invoice') {
        await client.from('invoices').update({ status: newStatus }).eq('id', id);
        if (newStatus === 'paid') showReceipt(id);
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
    renderStaffGuests();
    if (typeof renderTodaysOverview === 'function') renderTodaysOverview();
}

async function setStaffFeedInvoiceStatus(kind, id, newStatus) {
    const client = getSupabase();
    if (!client) return;
    await client.from('invoices').update({ status: newStatus }).eq('id', id);
    if (newStatus === 'paid') showReceipt(id);
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
                <div style="margin-top:0.75rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb);">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:0.5rem;">
                        <div>
                            <strong>${bk.service_name || (isStay ? 'Stay' : 'Appointment')}</strong>
                            <span onclick="event.stopPropagation();" style="margin-left:0.4rem; display:inline-block;">${renderStatusTag('appointment', bk.id, bk.status || 'pending', 'setBookingStatusInProfile')}</span>
                            ${bk.invoice_id ? `<span onclick="event.stopPropagation();" style="margin-left:0.3rem; display:inline-block;">${renderStatusTag('invoice', bk.invoice_id, bk.invoiceStatus || 'unpaid', 'setBookingStatusInProfile')}</span>` : ''}
                            <div style="font-size:0.82rem; color:var(--text-muted); margin-top:0.2rem;">${when}</div>
                            ${petName ? `<div style="font-size:0.82rem; color:var(--text-muted); margin-top:0.1rem;"><i data-lucide="dog" style="width:12px;height:12px;"></i> ${petName}</div>` : ''}
                            ${bk.resources?.name ? `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.1rem;"><i data-lucide="bed-double" style="width:12px;height:12px;"></i> ${bk.resources.name}</div>` : ''}
                            ${bk.requires_staff_time ? `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.1rem;"><i data-lucide="clock" style="width:12px;height:12px;"></i> ${bk.staff_time_minutes || '?'} min/day staff time${bk.staff_time_resource?.name ? ' · ' + bk.staff_time_resource.name : ''}</div>` : ''}
                            ${bk.amount ? `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.15rem;">$${Number(bk.amount).toFixed(2)}</div>` : ''}
                            ${bk.notes ? `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.25rem;">${bk.notes}</div>` : ''}
                        </div>
                        <div style="display:flex; gap:0.35rem;">
                            <button class="btn-icon" onclick="openBookingModal('${householdId}', '${bk.id}')" title="Edit event" style="background:none; border:none; cursor:pointer;">
                                <i data-lucide="pencil" style="width:14px;height:14px;"></i>
                            </button>
                            <button class="btn-icon" onclick="deleteBooking('${bk.id}', '${householdId}')" title="Remove event" style="background:none; border:none; cursor:pointer;">
                                <i data-lucide="x" style="width:14px;height:14px;"></i>
                            </button>
                        </div>
                    </div>
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
            await client.from('staff_assignments').insert([{ staff_id: sourceId, pet_id: targetId }]);
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
                🏡 <strong>${h.name}</strong>
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
   ACTIVITIES VIEW (merged appointments + tasks + invoice due dates)
   ========================================================================== */

let actWeekOffset = 0;

async function initActivitiesView() {
    if (typeof populateStaffSelects === 'function') await populateStaffSelects();
    renderActivities();
}

function switchActivitiesView(mode) {
    document.getElementById('acttab-list')?.classList.toggle('active', mode === 'list');
    document.getElementById('acttab-calendar')?.classList.toggle('active', mode === 'calendar');
    document.getElementById('activities-list-view')?.classList.toggle('hidden', mode !== 'list');
    document.getElementById('activities-calendar-view')?.classList.toggle('hidden', mode !== 'calendar');
    if (mode === 'calendar') {
        document.querySelectorAll('#actview-day, #actview-week, #actview-month').forEach(b => b.classList.remove('today'));
        document.getElementById('actview-' + actCalendarMode)?.classList.add('today');
        renderActivitiesCalendar();
    }
    else renderActivities();
}

function activitiesFilters() {
    return {
        category: document.getElementById('act-category-filter')?.value || 'all',
        staff: document.getElementById('act-staff-filter')?.value || 'all',
        status: document.getElementById('act-status-filter')?.value || 'all',
        from: document.getElementById('act-date-from')?.value || '',
        to: document.getElementById('act-date-to')?.value || '',
        query: (document.getElementById('act-search')?.value || '').trim().toLowerCase()
    };
}

async function fetchActivityItems() {
    const client = getSupabase();
    if (!client) return [];

    const items = [];

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
            invoiceId: bk.invoice_id || null,
            invoiceStatus: bk.invoice_id ? (invoiceStatusById[bk.invoice_id] || null) : null
        });
    });

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

    const { data: invoices } = await client.from('invoices').select('*, households(name)').neq('status', 'paid');
    (invoices || []).forEach(inv => {
        items.push({
            kind: 'invoice',
            id: inv.id,
            title: `Invoice due: ${inv.description || 'Invoice'}`,
            subtitle: `${inv.households?.name || ''} · $${Number(inv.amount || 0).toFixed(2)}`,
            date: inv.due_date || '',
            status: inv.status || 'pending',
            staffName: '',
            staffId: '',
            householdId: inv.household_id
        });
    });

    return items;
}

function filterActivityItems(items, f) {
    return items.filter(it => {
        if (f.category !== 'all' && it.kind !== f.category) return false;
        if (f.staff !== 'all' && it.staffId !== f.staff) return false;
        if (f.status !== 'all' && it.status !== f.status) return false;
        if (f.from && it.date && it.date < f.from) return false;
        if (f.to && it.date && it.date > f.to) return false;
        if (f.query && !(it.title.toLowerCase().includes(f.query) || it.subtitle.toLowerCase().includes(f.query))) return false;
        return true;
    });
}

const ACTIVITY_STATUS_OPTIONS = {
    appointment: ['pending', 'confirmed', 'completed', 'cancelled', 'no-show'],
    task: ['pending', 'completed'],
    invoice: ['unpaid', 'paid', 'void']
};

function renderStatusTag(kind, id, currentStatus, onChangeFn) {
    const options = ACTIVITY_STATUS_OPTIONS[kind] || ['pending'];
    return `
        <select onclick="event.stopPropagation();" onchange="event.stopPropagation(); ${onChangeFn}('${kind}', '${id}', this.value)" style="font-size:0.72rem; padding:0.2rem 0.5rem; border-radius:9999px; border:1px solid var(--border); background:var(--bg-card); cursor:pointer; color:${activityStatusColor(currentStatus)}; text-transform:capitalize;">
            ${options.map(o => `<option value="${o}" ${o === currentStatus ? 'selected' : ''}>${o}</option>`).join('')}
        </select>
    `;
}

async function setActivityStatus(kind, id, newStatus) {
    const client = getSupabase();
    if (!client) return;

    if (kind === 'appointment') {
        await client.from('bookings').update({ status: newStatus }).eq('id', id);
    } else if (kind === 'task') {
        await client.from('staff_tasks').update({ is_done: newStatus === 'completed' }).eq('id', id);
    } else if (kind === 'invoice') {
        await client.from('invoices').update({ status: newStatus }).eq('id', id);
        if (newStatus === 'paid') showReceipt(id);
    }

    if (document.getElementById('activities-calendar-view')?.classList.contains('hidden')) {
        renderActivities();
    } else {
        renderActivitiesCalendar();
    }
}

function activityStatusColor(status) {
    if (status === 'completed' || status === 'paid' || status === 'void') return 'var(--text-muted)';
    if (status === 'cancelled' || status === 'no-show' || status === 'unpaid') return '#dc2626';
    if (status === 'confirmed') return '#16a34a';
    return 'var(--accent, #2563eb)';
}

function openActivityItem(kind, id, householdId) {
    if (kind === 'appointment') {
        openBookingModal(householdId, id);
    } else if (kind === 'task') {
        openStaffTaskModal(id);
    } else if (kind === 'invoice') {
        switchView('crm-view');
        openFullWidthProfile('household', householdId);
    }
}

async function setAppointmentInvoiceStatus(kind, invoiceId, newStatus) {
    const client = getSupabase();
    if (!client) return;
    await client.from('invoices').update({ status: newStatus }).eq('id', invoiceId);
    if (newStatus === 'paid') showReceipt(invoiceId);

    if (document.getElementById('activities-calendar-view')?.classList.contains('hidden')) {
        renderActivities();
    } else {
        renderActivitiesCalendar();
    }
}

async function renderActivities() {
    const el = document.getElementById('activities-list');
    if (!el) return;

    const f = activitiesFilters();
    let items = await fetchActivityItems();
    items = filterActivityItems(items, f);
    items.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    if (!items.length) {
        el.innerHTML = '<div class="biz-empty">No activities match this filter.</div>';
        return;
    }

    const kindIcon = { appointment: 'calendar', task: 'list-checks', invoice: 'receipt' };

    el.innerHTML = items.map(it => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-card); cursor:pointer;" onclick="openActivityItem('${it.kind}', '${it.id}', '${it.householdId || ''}')">
            <div style="display:flex; align-items:center; gap:0.6rem;">
                <i data-lucide="${kindIcon[it.kind]}" style="width:16px;height:16px; color:var(--text-muted);"></i>
                <div>
                    <strong>${it.title}</strong>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.15rem;">${it.subtitle}${it.staffName ? ' · ' + it.staffName : ''} ${it.date ? '· ' + it.date : ''}</div>
                </div>
            </div>
            <div style="display:flex; align-items:center; gap:0.5rem;">
                ${it.kind === 'invoice' ? `<button class="btn-icon" onclick="event.stopPropagation(); ${it.status === 'paid' ? `showReceipt('${it.id}')` : `showPaymentNotice('${it.id}')`}" title="${it.status === 'paid' ? 'View receipt' : 'View payment notice'}" style="background:none; border:none; cursor:pointer;"><i data-lucide="printer" style="width:15px;height:15px;"></i></button>` : ''}
                ${it.kind === 'appointment' && it.invoiceId ? `<span onclick="event.stopPropagation();">${renderStatusTag('invoice', it.invoiceId, it.invoiceStatus || 'unpaid', 'setAppointmentInvoiceStatus')}</span>` : ''}
                ${renderStatusTag(it.kind, it.id, it.status, 'setActivityStatus')}
            </div>
        </div>
    `).join('');
    refreshIcons();
}

let actCalendarMode = 'week'; // 'day' | 'week' | 'month'

function setActCalendarMode(mode) {
    actCalendarMode = mode;
    actWeekOffset = 0;
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

    // week
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
    if (!client) return {};

    const fmt = d => d.toISOString().slice(0, 10);
    const rangeStart = fmt(dates[0]);
    const rangeEnd = fmt(dates[dates.length - 1]);

    const [{ data: resources }, { data: staffList }, { data: closures }, { data: bookings }] = await Promise.all([
        client.from('resources').select('id, type'),
        client.from('staff').select('id'),
        client.from('business_closures').select('start_date, end_date'),
        client.from('bookings').select('check_in, check_out, assigned_staff_id, space_id, requires_staff_time, staff_time_resource_id, status')
            .neq('status', 'cancelled')
            .lte('check_in', rangeEnd + 'T23:59:59')
            .gte('check_out', rangeStart + 'T00:00:00')
    ]);

    const resourceTypeCounts = {}; // type -> total count
    const resourceTypeById = {};
    (resources || []).forEach(r => {
        resourceTypeById[r.id] = r.type;
        resourceTypeCounts[r.type] = (resourceTypeCounts[r.type] || 0) + 1;
    });
    const totalStaff = (staffList || []).length;

    const result = {};
    dates.forEach(d => {
        const key = fmt(d);

        const closed = (closures || []).some(c => key >= c.start_date && key <= (c.end_date || c.start_date));

        const dayBookings = (bookings || []).filter(bk => {
            const start = (bk.check_in || '').slice(0, 10);
            const end = (bk.check_out || bk.check_in || '').slice(0, 10);
            return key >= start && key <= end;
        });

        // Simple boarding (no dedicated staff/trainer time) doesn't tie up a staff member's day —
        // only appointments that actually declare a staff-time requirement count toward "fully booked."
        const staffBusy = new Set(dayBookings.filter(bk => bk.requires_staff_time && bk.assigned_staff_id).map(bk => bk.assigned_staff_id));
        const staffFull = totalStaff > 0 && staffBusy.size >= totalStaff;

        const bookedByType = {};
        dayBookings.forEach(bk => {
            [bk.space_id, bk.staff_time_resource_id].filter(Boolean).forEach(resourceId => {
                const type = resourceTypeById[resourceId];
                if (!type) return;
                bookedByType[type] = (bookedByType[type] || 0) + 1;
            });
        });
        const fullTypes = Object.keys(resourceTypeCounts).filter(type => bookedByType[type] >= resourceTypeCounts[type]);

        let level = null;
        if (closed) level = 'closed';
        else if (staffFull) level = 'staff-full';
        else if (fullTypes.length) level = 'resource-full';

        result[key] = { level, fullTypes };
    });

    return result;
}

async function renderActivitiesCalendar() {
    const thead = document.getElementById('act-cal-thead');
    const tbody = document.getElementById('act-cal-body');
    const weekLabel = document.getElementById('act-week-label');
    if (!thead || !tbody) return;

    const { dates, label, monthAnchor } = getActPeriodDates();
    const fmt = d => d.toISOString().slice(0, 10);
    if (weekLabel) weekLabel.textContent = label;

    const f = activitiesFilters();
    let items = await fetchActivityItems();
    items = filterActivityItems(items, f);

    // Bucket items by day, spanning multi-day appointments across every day they cover.
    const byDay = {};
    dates.forEach(d => { byDay[fmt(d)] = []; });
    items.forEach(it => {
        const start = it.date;
        const end = it.endDate || it.date;
        Object.keys(byDay).forEach(key => {
            if (key >= start && key <= end) byDay[key].push(it);
        });
    });

    const dayStatus = await computeCalendarDayStatuses(dates);

    const kindIcon = { appointment: 'calendar', task: 'list-checks', invoice: 'receipt' };
    const statusBg = { closed: '#e5e7eb', 'staff-full': '#fecaca', 'resource-full': '#fef08a' };

    const isDayMode = actCalendarMode === 'day';

    const renderCellItems = (key, compact) => (byDay[key] || []).map(it => `
        <div style="padding:${compact ? '0.2rem 0.3rem' : '0.4rem'}; margin-bottom:0.25rem; border-radius:0.25rem; background:var(--bg-hover,#f1f5f9); font-size:${compact ? '0.68rem' : '0.75rem'}; cursor:pointer;" onclick="event.stopPropagation(); openActivityItem('${it.kind}', '${it.id}', '${it.householdId || ''}')">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:0.3rem;">
                <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"><i data-lucide="${kindIcon[it.kind]}" style="width:11px;height:11px;"></i> ${it.title}</span>
            </div>
            ${!compact ? `<div style="color:var(--text-muted); margin-top:0.1rem;">${it.subtitle}</div><div style="display:flex; align-items:center; gap:0.4rem; margin-top:0.2rem; flex-wrap:wrap;">${it.kind === 'invoice' ? `<button class="btn-icon" onclick="event.stopPropagation(); ${it.status === 'paid' ? `showReceipt('${it.id}')` : `showPaymentNotice('${it.id}')`}" title="Print" style="background:none; border:none; cursor:pointer;"><i data-lucide="printer" style="width:12px;height:12px;"></i></button>` : ''}${isDayMode && it.kind === 'appointment' && it.invoiceId ? `<span onclick="event.stopPropagation();">${renderStatusTag('invoice', it.invoiceId, it.invoiceStatus || 'unpaid', 'setAppointmentInvoiceStatus')}</span>` : ''}${renderStatusTag(it.kind, it.id, it.status, 'setActivityStatus')}</div>` : ''}
        </div>
    `).join('');

    const todayKey = fmt(new Date());

    const cellStyle = (key, extra) => {
        const s = dayStatus[key];
        const bg = s ? statusBg[s.level] : '';
        const label = s ? (s.level === 'closed' ? 'Business closed' : s.level === 'staff-full' ? 'All staff booked' : `Closed to: ${s.fullTypes.join(', ')}`) : '';
        const todayOutline = key === todayKey ? 'box-shadow: inset 0 0 0 2px #2563eb;' : '';
        return `style="cursor:pointer; ${bg ? 'background:' + bg + ';' : ''} ${todayOutline} ${extra || ''}" title="${key === todayKey ? 'Today. ' : ''}${label}"`;
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

let quickScheduleDate = null;

function openQuickScheduleModal(presetDate) {
    quickScheduleDate = presetDate || null;
    document.getElementById('qs-household-search').value = '';
    document.getElementById('qs-household-results').innerHTML = '';
    setQuickScheduleType(null);
    document.getElementById('quick-schedule-modal')?.classList.remove('hidden');
    refreshIcons();
}

function closeQuickScheduleModal() {
    document.getElementById('quick-schedule-modal')?.classList.add('hidden');
    quickScheduleDate = null;
}

function setQuickScheduleType(type) {
    document.getElementById('qs-type-appointment')?.classList.toggle('today', type === 'appointment');
    document.getElementById('qs-type-task')?.classList.toggle('today', type === 'task');
    document.getElementById('qs-appointment-section')?.classList.toggle('hidden', type !== 'appointment');
    document.getElementById('qs-task-section')?.classList.toggle('hidden', type !== 'task');
    if (type === 'appointment') document.getElementById('qs-household-search')?.focus();
}

async function searchHouseholdForSchedule(query) {
    const container = document.getElementById('qs-household-results');
    if (!container) return;
    const q = query.trim();
    if (!q) { container.innerHTML = ''; return; }

    const client = getSupabase();
    if (!client) return;

    const { data: matches } = await client.from('households').select('id, name').ilike('name', `%${q}%`).limit(8);

    container.innerHTML = (matches && matches.length) ? matches.map(m => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.5rem 0.6rem; border:1px solid var(--border); border-radius:0.25rem; background:var(--bg-card); cursor:pointer;" onclick="selectHouseholdForSchedule('${m.id}')">
            <span><i data-lucide="home" style="width:13px;height:13px;"></i> ${m.name}</span>
            <span style="font-size:0.75rem; color:var(--primary, #2563eb);">Select</span>
        </div>
    `).join('') : '<div style="font-size:0.8rem; color:var(--text-muted);">No matching households.</div>';
    refreshIcons();
}

function selectHouseholdForSchedule(householdId) {
    if (quickScheduleDate) pendingCalendarDate = quickScheduleDate;
    closeQuickScheduleModal();
    openBookingModal(householdId);
}

function proceedQuickScheduleTask() {
    const dateStr = quickScheduleDate;
    closeQuickScheduleModal();
    openStaffTaskModal(null);
    if (dateStr) {
        setTimeout(() => { const el = document.getElementById('stsk-due'); if (el) el.value = dateStr; }, 0);
    }
}

function quickScheduleOnDate(dateStr) {
    openQuickScheduleModal(dateStr);
}

function quickNewAppointment() {
    openQuickScheduleModal(null);
    setQuickScheduleType('appointment');
}

function quickNewTask() {
    openStaffTaskModal(null);
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
}

// ---- Appointment Type Templates ----

let editingApptTypeId = null;

async function renderApptTypeList() {
    const el = document.getElementById('appt-type-list');
    if (!el) return;
    const client = getSupabase();
    if (!client) return;

    const { data: list } = await client.from('appointment_type_templates').select('*').order('name');
    if (!list || !list.length) {
        el.innerHTML = '<div class="biz-empty">No appointment types yet.</div>';
        return;
    }

    el.innerHTML = list.map(t => `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-card);">
            <div>
                <strong>${t.name}</strong>
                <span style="font-size:0.78rem; color:var(--text-muted); margin-left:0.5rem;">${t.default_price != null ? '$' + Number(t.default_price).toFixed(2) : ''} ${t.default_duration_minutes ? '· ' + t.default_duration_minutes + ' min' : ''} ${t.resource_type ? '· Resource: ' + t.resource_type : ''} ${t.requires_staff_time ? '· Staff time: ' + (t.staff_time_minutes || '?') + ' min/day' + (t.staff_time_resource_type ? ' (' + t.staff_time_resource_type + ')' : '') : ''}</span>
                ${t.notes ? `<div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.2rem;">${t.notes}</div>` : ''}
            </div>
            <div style="display:flex; gap:0.4rem;">
                <button class="btn-icon" style="background:none;border:none;cursor:pointer;" onclick="openApptTypeModal('${t.id}')" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px;"></i></button>
                <button class="btn-icon" style="background:none;border:none;cursor:pointer;color:var(--danger-text);" onclick="deleteApptType('${t.id}')" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
            </div>
        </div>
    `).join('');
    refreshIcons();
}

async function openApptTypeModal(id) {
    editingApptTypeId = id;
    const titleEl = document.getElementById('appt-type-modal-title');
    if (titleEl) titleEl.textContent = id ? 'Edit Appointment Type' : 'Add Appointment Type';

    const nameInput = document.getElementById('att-name');
    const priceInput = document.getElementById('att-price');
    const durationInput = document.getElementById('att-duration');
    const resourceTypeSel = document.getElementById('att-resource-type');
    const requiresStaffTimeChk = document.getElementById('att-requires-staff-time');
    const staffTimeFields = document.getElementById('att-staff-time-fields');
    const staffTimeMinutesInput = document.getElementById('att-staff-time-minutes');
    const staffTimeResourceTypeSel = document.getElementById('att-staff-time-resource-type');
    const notesInput = document.getElementById('att-notes');

    let t = null;
    if (id) {
        const client = getSupabase();
        const { data } = client ? await client.from('appointment_type_templates').select('*').eq('id', id).single() : { data: null };
        t = data;
    }

    if (nameInput) nameInput.value = t?.name || '';
    if (priceInput) priceInput.value = t?.default_price != null ? t.default_price : '';
    if (durationInput) durationInput.value = t?.default_duration_minutes || '';
    if (resourceTypeSel) resourceTypeSel.value = t?.resource_type || '';
    if (requiresStaffTimeChk) requiresStaffTimeChk.checked = !!t?.requires_staff_time;
    if (staffTimeFields) staffTimeFields.style.display = t?.requires_staff_time ? 'flex' : 'none';
    if (staffTimeMinutesInput) staffTimeMinutesInput.value = t?.staff_time_minutes || '';
    if (staffTimeResourceTypeSel) staffTimeResourceTypeSel.value = t?.staff_time_resource_type || '';
    if (notesInput) notesInput.value = t?.notes || '';

    document.getElementById('appt-type-modal')?.classList.remove('hidden');
}

function closeApptTypeModal() {
    document.getElementById('appt-type-modal')?.classList.add('hidden');
}

async function saveApptType() {
    const name = document.getElementById('att-name')?.value.trim();
    if (!name) return alert('Please enter a name.');

    const price = document.getElementById('att-price')?.value;
    const duration = document.getElementById('att-duration')?.value;
    const resourceType = document.getElementById('att-resource-type')?.value || null;
    const requiresStaffTime = document.getElementById('att-requires-staff-time')?.checked || false;
    const staffTimeMinutes = document.getElementById('att-staff-time-minutes')?.value;
    const staffTimeResourceType = document.getElementById('att-staff-time-resource-type')?.value || null;
    const notes = document.getElementById('att-notes')?.value.trim() || '';

    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const payload = {
        name,
        default_price: price ? parseFloat(price) : null,
        default_duration_minutes: duration ? parseInt(duration, 10) : null,
        resource_type: resourceType,
        requires_staff_time: requiresStaffTime,
        staff_time_minutes: requiresStaffTime && staffTimeMinutes ? parseInt(staffTimeMinutes, 10) : null,
        staff_time_resource_type: requiresStaffTime ? staffTimeResourceType : null,
        notes
    };

    let response;
    if (editingApptTypeId) {
        response = await client.from('appointment_type_templates').update(payload).eq('id', editingApptTypeId);
    } else {
        response = await client.from('appointment_type_templates').insert([payload]);
    }

    if (response.error) return alert('Failed to save: ' + response.error.message);

    editingApptTypeId = null;
    closeApptTypeModal();
    renderApptTypeList();
}

async function deleteApptType(id) {
    if (!confirm('Remove this appointment type?')) return;
    const client = getSupabase();
    if (!client) return;
    await client.from('appointment_type_templates').delete().eq('id', id);
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
        <div style="display:flex; justify-content:space-between; align-items:center; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-card);">
            <div>
                <strong>${t.name}</strong>
                <span style="font-size:0.78rem; color:var(--text-muted); margin-left:0.5rem; text-transform:capitalize;">${t.default_priority || 'normal'} priority</span>
                ${t.description ? `<div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.2rem;">${t.description}</div>` : ''}
            </div>
            <div style="display:flex; gap:0.4rem;">
                <button class="btn-icon" style="background:none;border:none;cursor:pointer;" onclick="openTaskTemplateModal('${t.id}')" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px;"></i></button>
                <button class="btn-icon" style="background:none;border:none;cursor:pointer;color:var(--danger-text);" onclick="deleteTaskTemplate('${t.id}')" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
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
        response = await client.from('task_templates').insert([payload]);
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
        <div style="padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-card);">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <strong>${t.name}</strong>
                <div style="display:flex; gap:0.4rem;">
                    <button class="btn-icon" style="background:none;border:none;cursor:pointer;" onclick="openAssessmentTemplateModal('${t.id}')" title="Edit"><i data-lucide="pencil" style="width:14px;height:14px;"></i></button>
                    <button class="btn-icon" style="background:none;border:none;cursor:pointer;color:var(--danger-text);" onclick="deleteAssessmentTemplate('${t.id}')" title="Delete"><i data-lucide="trash-2" style="width:14px;height:14px;"></i></button>
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
        response = await client.from('assessment_templates').insert([payload]);
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
    setVal('pay-business-name', s.business_name);
    setVal('pay-venmo', s.venmo_handle);
    setVal('pay-zelle', s.zelle_info);
    setVal('pay-cash', s.cash_note);
    setVal('pay-square', s.square_link);
    setVal('pay-logo-url', s.logo_url);
    const preview = document.getElementById('pay-logo-preview');
    if (preview && s.logo_url) { preview.src = s.logo_url; preview.style.display = 'block'; }
}

async function saveBusinessPaymentSettings() {
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const payload = {
        business_name: document.getElementById('pay-business-name')?.value.trim() || '',
        venmo_handle: document.getElementById('pay-venmo')?.value.trim() || '',
        zelle_info: document.getElementById('pay-zelle')?.value.trim() || '',
        cash_note: document.getElementById('pay-cash')?.value.trim() || '',
        square_link: document.getElementById('pay-square')?.value.trim() || '',
        logo_url: document.getElementById('pay-logo-url')?.value.trim() || ''
    };

    const existing = await getBusinessSettings();
    let response;
    if (existing) {
        response = await client.from('business_settings').update(payload).eq('id', existing.id);
    } else {
        response = await client.from('business_settings').insert([payload]);
    }

    if (response.error) return alert('Failed to save: ' + response.error.message);
    alert('Payment settings saved.');
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

async function showPaymentNotice(invoiceId) {
    const client = getSupabase();
    if (!client) return;

    const { data: inv } = await client.from('invoices').select('*, households(name)').eq('id', invoiceId).single();
    if (!inv) return;
    const settings = await getBusinessSettings();

    const paymentOptions = [];
    if (settings?.venmo_handle) paymentOptions.push(`<li><strong>Venmo:</strong> ${settings.venmo_handle}</li>`);
    if (settings?.zelle_info) paymentOptions.push(`<li><strong>Zelle:</strong> ${settings.zelle_info}</li>`);
    if (settings?.cash_note) paymentOptions.push(`<li><strong>Cash:</strong> ${settings.cash_note}</li>`);
    if (settings?.square_link) paymentOptions.push(`<li><strong>Square:</strong> <a href="${settings.square_link}" target="_blank">${settings.square_link}</a></li>`);

    const serviceWhen = inv.service_start_date ? (inv.service_end_date && inv.service_end_date !== inv.service_start_date ? `${inv.service_start_date} → ${inv.service_end_date}` : inv.service_start_date) : null;

    renderDocumentOverlay(`
        ${settings?.logo_url ? `<img src="${settings.logo_url}" style="max-height:60px; margin-bottom:0.75rem;">` : ''}
        <h2 style="margin:0 0 0.25rem;">${settings?.business_name || 'Payment Notice'}</h2>
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

    const serviceWhen = inv.service_start_date ? (inv.service_end_date && inv.service_end_date !== inv.service_start_date ? `${inv.service_start_date} → ${inv.service_end_date}` : inv.service_start_date) : null;

    renderDocumentOverlay(`
        ${settings?.logo_url ? `<img src="${settings.logo_url}" style="max-height:60px; margin-bottom:0.75rem;">` : ''}
        <h2 style="margin:0 0 0.25rem;">${settings?.business_name || 'Receipt'}</h2>
        <p style="color:var(--text-muted); margin:0 0 1rem;">Payment Received</p>
        <div style="font-size:2rem; font-weight:700; margin-bottom:1rem;">$${Number(inv.amount || 0).toFixed(2)}</div>
        <p><strong>${inv.description || 'Invoice'}</strong></p>
        <p style="color:var(--text-muted);">${inv.households?.name || ''}</p>
        ${inv.pet_names ? `<p style="color:var(--text-muted); font-size:0.9rem; margin-top:0.3rem;"><strong>Pet(s):</strong> ${inv.pet_names}</p>` : ''}
        ${serviceWhen ? `<p style="color:var(--text-muted); font-size:0.9rem; margin-top:0.1rem;"><strong>Service Date(s):</strong> ${serviceWhen}</p>` : ''}
        <p style="color:var(--text-muted); font-size:0.85rem; margin-top:1rem;">Paid in full. Thank you!</p>
        <p style="color:var(--text-muted); font-size:0.78rem; margin-top:0.75rem; font-style:italic;">Note: email delivery isn't set up yet — this receipt is view/print only for now.</p>
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
