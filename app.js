// Credentials
const SUPABASE_URL = 'https://qhfdtnylbpbooicsbhct.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFoZmR0bnlsYnBib29pY3NiaGN0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0NTI5NDMsImV4cCI6MjEwNDAyODk0M30.SnLDb2BP0WVI2HCyuDLxt5qdnGBzRmd6cjgHDCpQKRo';

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
    if (typeof renderAllDashboards === 'function') {
        renderAllDashboards();
    }
});

function switchView(viewId) {
    document.querySelectorAll('.view-panel').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('#admin-nav .nav-btn').forEach(b => b.classList.remove('active'));
    
    const targetView = document.getElementById(viewId);
    if (targetView) targetView.classList.remove('hidden');

    const activeBtn = Array.from(document.querySelectorAll('#admin-nav .nav-btn'))
        .find(b => b.getAttribute('onclick') && b.getAttribute('onclick').includes(viewId));
    if (activeBtn) activeBtn.classList.add('active');

    // Hooks for view-specific initializations
    if (viewId === 'staff-mgmt-view') {
        initStaffView();
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

function openBookingModal(householdId) {
    alert('Opening booking/visit creator for Household: ' + householdId);
}

function openInvoiceModal(householdId) {
    alert('Opening invoice creator for Household: ' + householdId);
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

    // Render cards with clickable names that trigger openStaffModal
    el.innerHTML = staff.map(s => `
        <div class="staff-card">
            <div class="staff-avatar">${s.initials || s.name.slice(0, 2).toUpperCase()}</div>
            <div class="staff-info">
                <h4 class="clickable-profile-zone" 
                    onclick="openStaffModal('${s.id}')" 
                    title="Click to edit ${s.name}" 
                    style="cursor:pointer; display:inline-block;">
                    ${s.name}
                </h4>
                <p>${s.role} ${s.contact ? '· ' + s.contact : ''}</p>
                ${s.notes ? `<p style="font-size:0.78rem;color:var(--text-muted);">${s.notes}</p>` : ''}
            </div>
            <div class="staff-actions">
                <button class="btn" onclick="openStaffModal('${s.id}')">Edit</button>
                <button class="btn" style="color:var(--danger-text);" onclick="deleteStaff('${s.id}')">Remove</button>
            </div>
        </div>
    `).join('');
}

function switchStaffTab(tab) {
    document.querySelectorAll('[id^="stftab-"]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('[id^="stfsec-"]').forEach(s => s.classList.remove('active'));
    
    const targetTab = document.getElementById('stftab-' + tab);
    const targetSec = document.getElementById('stfsec-' + tab);
    
    if (targetTab) targetTab.classList.add('active');
    if (targetSec) targetSec.classList.add('active');
    
    if (tab === 'roster' && typeof renderStaffRoster === 'function') renderStaffRoster();
    if (tab === 'availability' && typeof renderStaffAvailability === 'function') renderStaffAvailability();
    if (tab === 'assignments' && typeof renderStaffAssignments === 'function') renderStaffAssignments();
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
        await renderStaffRoster();
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
        await renderStaffRoster();
    }
}

/* ==========================================================================
   STAFF AVAILABILITY MODAL HANDLER
   ========================================================================== */

function openStaffAvailModal(id) {
    if (typeof editingStaffAvailId !== 'undefined') {
        editingStaffAvailId = id;
    }

    if (typeof populateStaffSelects === 'function') {
        populateStaffSelects();
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

    if (id && typeof staffAvailability !== 'undefined') {
        const a = staffAvailability.find(x => x.id === id);
        if (a) {
            if (whoSel) whoSel.value = a.staffId || a.staff_id || '';
            if (typeSel) typeSel.value = a.type || 'vacation';
            if (startInput) startInput.value = a.start || a.start_date || '';
            if (endInput) endInput.value = a.end || a.end_date || '';
            if (notesInput) notesInput.value = a.notes || '';
        }
    } else {
        if (startInput) startInput.value = '';
        if (endInput) endInput.value = '';
        if (notesInput) notesInput.value = '';
    }

    const modal = document.getElementById('staff-avail-modal');
    if (modal) {
        modal.classList.remove('hidden');
    }
}

function closeStaffAvailModal() {
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

async function saveStaffAvail() {
    const staffId = document.getElementById('sav-who')?.value;
    const type = document.getElementById('sav-type')?.value || 'vacation';
    const start = document.getElementById('sav-start')?.value;
    const end = document.getElementById('sav-end')?.value || start;
    const notes = document.getElementById('sav-notes')?.value.trim() || '';

    if (!staffId || !start) {
        return alert('Please select a staff member and start date.');
    }

    closeStaffAvailModal();
    if (typeof renderStaffAvailability === 'function') {
        renderStaffAvailability();
    }
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

function renderStaffAssignments() {
    const el = document.getElementById('staff-assignments-list');
    if (!el) return;

    if (typeof populateStaffSelects === 'function') populateStaffSelects();
    if (typeof petAssignments === 'undefined' || !petAssignments.length) {
        el.innerHTML = '<div class="biz-empty">No pet assignments yet.</div>';
        return;
    }

    let html = '';
    if (typeof staffMembers !== 'undefined') {
        staffMembers.forEach(s => {
            const aPets = typeof getStaffPets === 'function' ? getStaffPets(s.id) : [];
            if (!aPets.length) return;
            html += `<div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-muted);font-weight:700;margin:0.75rem 0 0.35rem;">${s.name} · ${s.role}</div>`;
            aPets.forEach(p => {
                html += `
                    <div class="assignment-item" style="display:flex;align-items:center;justify-content:space-between;padding:0.5rem;border-bottom:1px solid var(--border);">
                        <span>${p.species === 'dog' ? '🐕' : '🐈'} <strong>${p.name}</strong> (${p.role})</span>
                        <button class="btn" style="font-size:0.75rem;padding:0.25rem 0.55rem;color:var(--danger-text);" onclick="removeAssignment('${p.assignId}')">Remove</button>
                    </div>`;
            });
        });
    }
    el.innerHTML = html || '<div class="biz-empty">No assignments yet.</div>';
}

function openAssignmentModal() {
    if (typeof populateStaffSelects === 'function') populateStaffSelects();
    const petSel = document.getElementById('asgn-pet');
    if (petSel && typeof pets !== 'undefined') {
        petSel.innerHTML = pets.map(p => `<option value="${p.id}">${p.name} (${p.species})</option>`).join('');
    }
    const modal = document.getElementById('assignment-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeAssignmentModal() {
    const modal = document.getElementById('assignment-modal');
    if (modal) modal.classList.add('hidden');
}

function saveAssignment() {
    const staffId = document.getElementById('asgn-staff')?.value;
    const petId = document.getElementById('asgn-pet')?.value;
    const role = document.getElementById('asgn-role')?.value;

    if (!staffId || !petId) return alert('Please select a staff member and pet.');

    if (typeof petAssignments !== 'undefined') {
        if (petAssignments.some(a => a.staffId === staffId && a.petId === petId)) {
            return alert('Pet is already assigned to this staff member.');
        }
        const nextId = typeof nextAssignId !== 'undefined' ? nextAssignId++ : Date.now();
        petAssignments.push({ id: 'pa' + nextId, staffId, petId, role });
    }

    closeAssignmentModal();
    renderStaffAssignments();
}

function removeAssignment(id) {
    if (typeof petAssignments !== 'undefined') {
        petAssignments = petAssignments.filter(x => x.id !== id);
    }
    renderStaffAssignments();
}


/* ==========================================================================
   STAFF TASK MODAL CONTROLLER
   ========================================================================== */

let editingStaffTaskId = null;

function renderStaffTasks() {
    const el = document.getElementById('staff-tasks-list');
    if (!el) return;

    const filterStaff = document.getElementById('staff-task-filter')?.value || 'all';
    const filterStatus = document.getElementById('staff-task-status-filter')?.value || 'all';

    if (typeof staffTasks === 'undefined') return;

    let tasks = [...staffTasks];
    if (filterStaff !== 'all') tasks = tasks.filter(t => t.staffId === filterStaff);
    if (filterStatus === 'pending') tasks = tasks.filter(t => !t.done);
    if (filterStatus === 'done') tasks = tasks.filter(t => t.done);

    if (!tasks.length) {
        el.innerHTML = '<div class="biz-empty">No tasks match this filter.</div>';
        return;
    }

    el.innerHTML = tasks.map(t => {
        const s = typeof staffMembers !== 'undefined' ? staffMembers.find(x => x.id === t.staffId) : null;
        return `
            <div class="staff-task-item ${t.done ? 'done' : ''}" style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem;border-bottom:1px solid var(--border);">
                <div>
                    <input type="checkbox" ${t.done ? 'checked' : ''} onchange="toggleStaffTask('${t.id}')">
                    <strong style="${t.done ? 'text-decoration:line-through;color:var(--text-muted);' : ''}">${t.text}</strong>
                    <span style="font-size:0.78rem;color:var(--text-muted);margin-left:0.5rem;">👤 ${s ? s.name : 'Unassigned'} · Due ${t.due}</span>
                </div>
                <div>
                    <button class="btn" style="font-size:0.72rem;padding:0.25rem 0.5rem;" onclick="openStaffTaskModal('${t.id}')">Edit</button>
                    <button class="btn" style="font-size:0.72rem;padding:0.25rem 0.5rem;color:var(--danger-text);" onclick="deleteStaffTask('${t.id}')">✕</button>
                </div>
            </div>
        `;
    }).join('');
}

function openStaffTaskModal(id) {
    editingStaffTaskId = id;
    if (typeof populateStaffSelects === 'function') populateStaffSelects();

    const titleEl = document.getElementById('staff-task-modal-title');
    if (titleEl) titleEl.textContent = id ? 'Edit Task' : 'Add Task';

    const whoSel = document.getElementById('stsk-who');
    const textInput = document.getElementById('stsk-text');
    const dueInput = document.getElementById('stsk-due');
    const prioritySel = document.getElementById('stsk-priority');

    if (id && typeof staffTasks !== 'undefined') {
        const t = staffTasks.find(x => x.id === id);
        if (t) {
            if (whoSel) whoSel.value = t.staffId;
            if (textInput) textInput.value = t.text;
            if (dueInput) dueInput.value = t.due;
            if (prioritySel) prioritySel.value = t.priority;
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
    const modal = document.getElementById('staff-task-modal');
    if (modal) modal.classList.add('hidden');
}

function saveStaffTask() {
    const staffId = document.getElementById('stsk-who')?.value;
    const text = document.getElementById('stsk-text')?.value.trim();
    const due = document.getElementById('stsk-due')?.value;
    const priority = document.getElementById('stsk-priority')?.value || 'normal';

    if (!text || !due) return alert('Please enter task description and due date.');

    if (typeof staffTasks !== 'undefined') {
        if (editingStaffTaskId) {
            const t = staffTasks.find(x => x.id === editingStaffTaskId);
            if (t) Object.assign(t, { staffId, text, due, priority });
        } else {
            const nextId = typeof nextStaffTaskId !== 'undefined' ? nextStaffTaskId++ : Date.now();
            staffTasks.push({ id: 'stsk' + nextId, staffId, text, due, priority, done: false });
        }
    }

    editingStaffTaskId = null;
    closeStaffTaskModal();
    renderStaffTasks();
}

function toggleStaffTask(id) {
    if (typeof staffTasks !== 'undefined') {
        const t = staffTasks.find(x => x.id === id);
        if (t) t.done = !t.done;
    }
    renderStaffTasks();
}

function deleteStaffTask(id) {
    if (typeof staffTasks !== 'undefined') {
        staffTasks = staffTasks.filter(x => x.id !== id);
    }
    renderStaffTasks();
}

/* ==========================================================================
   RESOURCE GRID & CALENDAR SUB-TAB CONTROLLER
   ========================================================================== */

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

function openResourceModal(id) {
    editingResourceId = id;
    const r = (id && typeof managedResources !== 'undefined') 
        ? managedResources.find(x => x.id === id) 
        : null;

    const titleEl = document.getElementById('resource-modal-title');
    if (titleEl) titleEl.textContent = r ? 'Edit Resource' : 'Add Resource';

    const nameInput = document.getElementById('rm-name');
    const typeSelect = document.getElementById('rm-type');
    const blackoutsArea = document.getElementById('rm-blackouts');
    const notesInput = document.getElementById('rm-notes');

    if (nameInput) nameInput.value = r ? r.name : '';
    if (typeSelect) typeSelect.value = r ? r.type : 'Dog Suite';
    if (blackoutsArea) blackoutsArea.value = r && r.blackouts ? r.blackouts.join('\n') : '';
    if (notesInput) notesInput.value = r ? r.notes : '';

    const modal = document.getElementById('resource-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeResourceModal() {
    const modal = document.getElementById('resource-modal');
    if (modal) modal.classList.add('hidden');
}

function saveResource() {
    const name = document.getElementById('rm-name')?.value.trim();
    if (!name) return alert('Please enter a resource name.');

    const type = document.getElementById('rm-type')?.value || 'Dog Suite';
    const notes = document.getElementById('rm-notes')?.value.trim() || '';
    const blackoutsText = document.getElementById('rm-blackouts')?.value || '';
    const blackouts = blackoutsText.split('\n').map(s => s.trim()).filter(Boolean);

    const data = { name, type, notes, blackouts };

    if (typeof managedResources !== 'undefined') {
        if (editingResourceId) {
            const r = managedResources.find(x => x.id === editingResourceId);
            if (r) Object.assign(r, data);
            if (typeof resources !== 'undefined') {
                const cr = resources.find(x => x.id === editingResourceId);
                if (cr) { cr.name = data.name; cr.type = data.type; }
            }
        } else {
            const nextId = typeof nextResourceId !== 'undefined' ? nextResourceId++ : Date.now();
            const newId = 'r' + nextId;
            managedResources.push({ id: newId, ...data });
            if (typeof resources !== 'undefined') {
                resources.push({ id: newId, name: data.name, type: data.type });
            }
        }
    }

    editingResourceId = null;
    closeResourceModal();
    
    if (typeof renderResourceList === 'function') renderResourceList();
    if (typeof renderCalendar === 'function') renderCalendar();
}

function deleteResource(id) {
    if (!confirm('Remove this resource space?')) return;

    if (typeof managedResources !== 'undefined') {
        managedResources = managedResources.filter(x => x.id !== id);
    }
    if (typeof resources !== 'undefined') {
        resources = resources.filter(x => x.id !== id);
    }

    if (typeof renderResourceList === 'function') renderResourceList();
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

function renderAvailabilityList() {
    const el = document.getElementById('availability-list');
    if (!el) return;

    if (typeof businessClosures === 'undefined' || !businessClosures.length) {
        el.innerHTML = '<div class="biz-empty">No business closures scheduled.</div>';
        return;
    }

    const sorted = [...businessClosures].sort((a, b) => a.start.localeCompare(b.start));
    
    el.innerHTML = sorted.map(c => {
        const span = c.start === c.end ? c.start : `${c.start} → ${c.end}`;
        return `
            <div class="closure-item type-${c.type}" style="display:flex;align-items:center;justify-content:space-between;padding:0.75rem;border:1px solid var(--border);border-radius:0.375rem;">
                <div class="closure-info">
                    <h4 style="margin:0;">${c.label}</h4>
                    <p style="margin:0;font-size:0.8rem;color:var(--text-muted);">${span} ${c.notes ? '· ' + c.notes : ''}</p>
                </div>
                <div style="display:flex;gap:0.4rem;align-items:center;">
                    <span class="closure-type-pill ${c.type}" style="font-size:0.72rem;padding:0.15rem 0.5rem;border-radius:9999px;font-weight:600;">${c.type === 'closure' ? 'Closed' : c.type === 'reduced' ? 'Reduced' : 'Holiday'}</span>
                    <button class="btn" style="font-size:0.78rem;padding:0.3rem 0.65rem;" onclick="openAvailabilityModal('${c.id}')">Edit</button>
                    <button class="btn" style="font-size:0.78rem;padding:0.3rem 0.65rem;color:var(--danger-text);" onclick="deleteClosure('${c.id}')">Remove</button>
                </div>
            </div>`;
    }).join('');
}

function openAvailabilityModal(id) {
    editingClosureId = id;
    const c = (id && typeof businessClosures !== 'undefined') 
        ? businessClosures.find(x => x.id === id) 
        : null;

    const titleEl = document.getElementById('avail-modal-title');
    if (titleEl) titleEl.textContent = c ? 'Edit Closure' : 'Add Closure';

    const labelInput = document.getElementById('av-label');
    const typeSelect = document.getElementById('av-type');
    const startInput = document.getElementById('av-start');
    const endInput = document.getElementById('av-end');
    const notesInput = document.getElementById('av-notes');

    if (labelInput) labelInput.value = c ? c.label : '';
    if (typeSelect) typeSelect.value = c ? c.type : 'closure';
    if (startInput) startInput.value = c ? c.start : '';
    if (endInput) endInput.value = c ? c.end : '';
    if (notesInput) notesInput.value = c ? c.notes : '';

    const modal = document.getElementById('availability-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeAvailabilityModal() {
    const modal = document.getElementById('availability-modal');
    if (modal) modal.classList.add('hidden');
}

function saveAvailability() {
    const label = document.getElementById('av-label')?.value.trim();
    const start = document.getElementById('av-start')?.value;
    const end = document.getElementById('av-end')?.value || start;
    const type = document.getElementById('av-type')?.value || 'closure';
    const notes = document.getElementById('av-notes')?.value.trim() || '';

    if (!label || !start) return alert('Please enter a label and start date.');

    const data = { label, type, start, end, notes };

    if (typeof businessClosures !== 'undefined') {
        if (editingClosureId) {
            const c = businessClosures.find(x => x.id === editingClosureId);
            if (c) Object.assign(c, data);
        } else {
            const nextId = typeof nextClosureId !== 'undefined' ? nextClosureId++ : Date.now();
            businessClosures.push({ id: 'cl' + nextId, ...data });
        }
    }

    editingClosureId = null;
    closeAvailabilityModal();
    renderAvailabilityList();
}

function deleteClosure(id) {
    if (!confirm('Remove this business closure date?')) return;

    if (typeof businessClosures !== 'undefined') {
        businessClosures = businessClosures.filter(x => x.id !== id);
    }
    renderAvailabilityList();
}

/* ==========================================================================
   HOUSEHOLD / CLIENT CRUD CONTROLLER (SUPABASE)
   ========================================================================== */

let editingHouseholdId = null;

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

async function openHouseholdModal(id = null) {
    editingHouseholdId = id;

    const titleEl = document.getElementById('household-modal-title');
    const nameInput = document.getElementById('hh-name');
    const contactNameInput = document.getElementById('hh-contact-name');
    const contactInfoInput = document.getElementById('hh-contact-info');
    const addressInput = document.getElementById('hh-address');
    const noteInput = document.getElementById('hh-notes');

    if (id) {
        if (titleEl) titleEl.textContent = 'Edit Household / Client';
        
        const client = getSupabase();
        if (client) {
            const { data: hh, error } = await client
                .from('households')
                .select('*, people(*)')
                .eq('id', id)
                .single();

            if (!error && hh) {
                const primary = hh.people?.find(p => p.role === 'Primary') || hh.people?.[0];
                if (nameInput) nameInput.value = hh.name || '';
                if (contactNameInput) contactNameInput.value = primary ? primary.name : '';
                if (contactInfoInput) contactInfoInput.value = primary ? primary.contact : '';
                if (addressInput) addressInput.value = hh.address || '';
                if (noteInput) noteInput.value = hh.note || '';
            }
        }
    } else {
        if (titleEl) titleEl.textContent = 'Add Household / Client';
        if (nameInput) nameInput.value = '';
        if (contactNameInput) contactNameInput.value = '';
        if (contactInfoInput) contactInfoInput.value = '';
        if (addressInput) addressInput.value = '';
        if (noteInput) noteInput.value = '';
    }

    const modal = document.getElementById('household-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeHouseholdModal() {
    editingHouseholdId = null;
    const modal = document.getElementById('household-modal');
    if (modal) modal.classList.add('hidden');
}

async function saveHousehold() {
    const client = getSupabase();
    if (!client) return alert('Database connection unavailable.');

    const nameInput = document.getElementById('hh-name');
    const contactNameInput = document.getElementById('hh-contact-name');
    const contactInfoInput = document.getElementById('hh-contact-info');
    const addressInput = document.getElementById('hh-address');
    const noteInput = document.getElementById('hh-notes');

    const hhName = nameInput ? nameInput.value.trim() : '';
    const contactName = contactNameInput ? contactNameInput.value.trim() : '';
    const contactInfo = contactInfoInput ? contactInfoInput.value.trim() : '';
    const address = addressInput ? addressInput.value.trim() : '';
    const note = noteInput ? noteInput.value.trim() : '';

    if (!hhName) return alert('Please enter a Household name.');

    if (editingHouseholdId) {
        const { error: hhErr } = await client
            .from('households')
            .update({ name: hhName, address: address, note: note })
            .eq('id', editingHouseholdId);

        if (hhErr) return alert('Error updating household: ' + hhErr.message);

        if (contactName) {
            const { data: existingPeople } = await client
                .from('people')
                .select('id')
                .eq('household_id', editingHouseholdId)
                .limit(1);

            if (existingPeople && existingPeople.length > 0) {
                await client
                    .from('people')
                    .update({ name: contactName, contact: contactInfo })
                    .eq('id', existingPeople[0].id);
            } else {
                await client
                    .from('people')
                    .insert([{ household_id: editingHouseholdId, name: contactName, contact: contactInfo, role: 'Primary' }]);
            }
        }
    } else {
        const { data: hhData, error: hhErr } = await client
            .from('households')
            .insert([{ name: hhName, address: address, note: note }])
            .select()
            .single();

        if (hhErr) return alert('Error creating household: ' + hhErr.message);

        if (contactName && hhData) {
            await client
                .from('people')
                .insert([{ household_id: hhData.id, name: contactName, contact: contactInfo, role: 'Primary' }]);
        }
    }

    closeHouseholdModal();
    if (typeof renderAllDashboards === 'function') renderAllDashboards();
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
        if (typeof renderAllDashboards === 'function') {
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
        response = await client.from('vets').insert([payload]);
    }

    if (response.error) {
        alert('Failed to save vet: ' + response.error.message);
        console.error('Supabase vet error:', response.error);
    } else {
        closeVetModal();
        if (typeof renderAllDashboards === 'function') {
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
                if (!query || hh.name?.toLowerCase().includes(query) || primary?.name?.toLowerCase().includes(query)) {
                    html += `
                        <div class="crm-card" onclick="openFullWidthProfile('household', '${hh.id}')" style="cursor:pointer;">
                            <div class="crm-card-content">
                                <h3 style="margin:0; display:flex; align-items:center; gap:0.5rem; font-size:1.1rem;">
                                    <i data-lucide="home"></i> ${hh.name}
                                </h3>
                                ${primary ? `<p style="margin:0; font-size:0.85rem; color:var(--text-muted); display:flex; align-items:center; gap:0.35rem;"><i data-lucide="user" style="width:14px;height:14px;"></i> Primary: ${primary.name} ${primary.contact ? '· ' + primary.contact : ''}</p>` : ''}
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
                if (!query || p.name?.toLowerCase().includes(query) || p.contact?.toLowerCase().includes(query)) {
                    html += `
                        <div class="crm-card" onclick="openFullWidthProfile('person', '${p.id}')" style="cursor:pointer;">
                            <div class="crm-card-content">
                                <h3 style="margin:0; display:flex; align-items:center; gap:0.5rem; font-size:1.1rem;">
                                    <i data-lucide="user"></i> ${p.name}
                                </h3>
                                <p style="margin:0; font-size:0.85rem; color:var(--text-muted);">${p.role || 'Contact'} ${p.contact ? '· ' + p.contact : ''} ${p.households?.name ? '· Household: ' + p.households.name : ''}</p>
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
                    const speciesIcon = p.species === 'cat' ? 'cat' : 'dog';
                    html += `
                        <div class="crm-card" onclick="openFullWidthProfile('pet', '${p.id}')" style="cursor:pointer;">
                            <div class="crm-card-content">
                                <h3 style="margin:0; display:flex; align-items:center; gap:0.5rem; font-size:1.1rem;">
                                    <i data-lucide="${speciesIcon}"></i> ${p.name}
                                </h3>
                                <p style="margin:0; font-size:0.85rem; color:var(--text-muted);">${p.species} ${p.households?.name ? '· Household: ' + p.households.name : ''} · Vaccines: ${p.vaccine_status || 'Current'}</p>
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

    container.innerHTML = html || '<div class="biz-empty">No entries found matching criteria.</div>';
    refreshIcons();
}

/* ==========================================================================
   INLINE FULL-WIDTH ENTITY VIEW (DIRECTLY BELOW FILTER BAR)
   ========================================================================== */

async function openFullWidthProfile(type, id) {
    const container = document.getElementById('crm-list-container');
    if (!container) return;

    const client = getSupabase();
    if (!client) return;

    let payload = null;

    if (type === 'household') {
        const { data } = await client.from('households').select('*, people(*), pets(*)').eq('id', id).single();
        payload = data;
    } else if (type === 'person') {
        const { data } = await client.from('people').select('*, households(*)').eq('id', id).single();
        payload = data;
    } else if (type === 'pet') {
        const { data } = await client.from('pets').select('*, households(*)').eq('id', id).single();
        payload = data;
    } else if (type === 'vet') {
        const { data } = await client.from('vets').select('*').eq('id', id).single();
        payload = data;
    }

    if (!payload) return;

    const iconName = type === 'household' ? 'home' : type === 'person' ? 'user' : type === 'pet' ? 'dog' : 'stethoscope';

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

            <!-- CONTENT SECTIONS -->
            ${renderEntitySections(type, payload, id)}
        </div>
    `;

    refreshIcons();
}

/* ==========================================================================
   UNIFIED RELATIONAL ENTITY SECTIONS (SEARCH-FIRST LINKING FOR ALL TYPES)
   ========================================================================== */

function renderEntitySections(type, data, id) {
    if (type === 'household') {
        return `
            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap:1.5rem;">
                
                <!-- Household Details -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <h3 style="margin:0 0 1rem 0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;">
                        <i data-lucide="info"></i> Household Details
                    </h3>
                    <div style="display:flex; flex-direction:column; gap:0.85rem;">
                        <div>
                            <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:0.25rem;">Household Name</label>
                            <input type="text" value="${data.name || ''}" class="biz-select" style="width:100%; padding:0.5rem;" onchange="autoSaveField('households', '${id}', 'name', this.value)">
                        </div>
                        <div>
                            <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:0.25rem;">Address</label>
                            <input type="text" value="${data.address || ''}" class="biz-select" style="width:100%; padding:0.5rem;" onchange="autoSaveField('households', '${id}', 'address', this.value)">
                        </div>
                        <div>
                            <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:0.25rem;">Notes</label>
                            <textarea class="biz-select" style="width:100%; padding:0.5rem;" rows="3" onchange="autoSaveField('households', '${id}', 'note', this.value)">${data.note || ''}</textarea>
                        </div>
                    </div>
                </div>

                <!-- Household Members -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                        <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;">
                            <i data-lucide="users"></i> Household Members
                        </h3>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="toggleInlineSearchPanel('person', '${id}')">
                            <i data-lucide="search" style="width:14px;height:14px;"></i> Link Member
                        </button>
                    </div>

                    <div id="search-panel-person-${id}" class="inline-search-panel hidden" style="margin-bottom:1rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover,#f9fafb);">
                        <input type="text" placeholder="Type member name..." class="biz-select" style="width:100%; padding:0.4rem;" onkeyup="executeLiveSearch('person', '${id}', this.value)">
                        <div id="search-results-person-${id}" style="margin-top:0.5rem; display:flex; flex-direction:column; gap:0.35rem;"></div>
                    </div>

                    ${data.people && data.people.length ? data.people.map(p => `
                        <div style="margin-top:0.75rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb); cursor:pointer;" onclick="openFullWidthProfile('person', '${p.id}')">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <strong>${p.name}</strong>
                                <span style="font-size:0.75rem; padding:0.15rem 0.5rem; background:var(--bg-card); border:1px solid var(--border); border-radius:9999px;">${p.role || 'Member'}</span>
                            </div>
                            <div style="font-size:0.82rem; color:var(--text-muted); margin-top:0.25rem;">📞 ${p.contact || 'No contact set'}</div>
                        </div>
                    `).join('') : '<p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.5rem;">No members attached.</p>'}
                </div>

                <!-- Pets -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                        <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;">
                            <i data-lucide="dog"></i> Pets
                        </h3>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="toggleInlineSearchPanel('pet', '${id}')">
                            <i data-lucide="search" style="width:14px;height:14px;"></i> Link Pet
                        </button>
                    </div>

                    <div id="search-panel-pet-${id}" class="inline-search-panel hidden" style="margin-bottom:1rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover,#f9fafb);">
                        <input type="text" placeholder="Type pet name..." class="biz-select" style="width:100%; padding:0.4rem;" onkeyup="executeLiveSearch('pet', '${id}', this.value)">
                        <div id="search-results-pet-${id}" style="margin-top:0.5rem; display:flex; flex-direction:column; gap:0.35rem;"></div>
                    </div>

                    ${data.pets && data.pets.length ? data.pets.map(p => `
                        <div style="margin-top:0.75rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb); cursor:pointer;" onclick="openFullWidthProfile('pet', '${p.id}')">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <strong><i data-lucide="${p.species === 'cat' ? 'cat' : 'dog'}" style="width:16px;height:16px;"></i> ${p.name}</strong>
                                <span style="font-size:0.75rem; color:var(--text-muted);">${p.species}</span>
                            </div>
                        </div>
                    `).join('') : '<p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.5rem;">No pets attached.</p>'}
                </div>

                <!-- Primary Vet -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                        <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;">
                            <i data-lucide="stethoscope"></i> Veterinary Clinic
                        </h3>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="toggleInlineSearchPanel('vet', '${id}')">
                            <i data-lucide="search" style="width:14px;height:14px;"></i> Link Vet
                        </button>
                    </div>

                    <div id="search-panel-vet-${id}" class="inline-search-panel hidden" style="margin-bottom:1rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover,#f9fafb);">
                        <input type="text" placeholder="Type doctor or clinic..." class="biz-select" style="width:100%; padding:0.4rem;" onkeyup="executeLiveSearch('vet', '${id}', this.value)">
                        <div id="search-results-vet-${id}" style="margin-top:0.5rem; display:flex; flex-direction:column; gap:0.35rem;"></div>
                    </div>

                    <div id="hh-vet-content">
                        <p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.5rem;">No primary vet facility linked.</p>
                    </div>
                </div>

                <!-- Scheduled Events -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                        <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="calendar"></i> Scheduled Events</h3>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="openBookingModal('${id}')">+ Add Event</button>
                    </div>
                    <p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.5rem;">No active bookings found.</p>
                </div>

                <!-- Invoices -->
                <div class="stat-card alert" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                        <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="credit-card"></i> Invoices</h3>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="openInvoiceModal('${id}')">+ Create Invoice</button>
                    </div>
                    <p style="font-size:0.85rem; color:var(--text-muted); margin-top:0.5rem;">No unpaid balances on file.</p>
                </div>

            </div>
        `;
    } else if (type === 'person') {
        return `
            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap:1.5rem;">
                <!-- Person Details -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <h3 style="margin:0 0 1rem 0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="user"></i> Contact Details</h3>
                    <div style="display:flex; flex-direction:column; gap:0.85rem;">
                        <div>
                            <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:0.25rem;">Full Name</label>
                            <input type="text" value="${data.name || ''}" class="biz-select" style="width:100%; padding:0.5rem;" onchange="autoSaveField('people', '${id}', 'name', this.value)">
                        </div>
                        <div>
                            <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:0.25rem;">Contact Info</label>
                            <input type="text" value="${data.contact || ''}" class="biz-select" style="width:100%; padding:0.5rem;" onchange="autoSaveField('people', '${id}', 'contact', this.value)">
                        </div>
                    </div>
                </div>

                <!-- Linked Household -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                        <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="home"></i> Household</h3>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="toggleInlineSearchPanel('household', '${id}')">
                            <i data-lucide="search" style="width:14px;height:14px;"></i> Link Household
                        </button>
                    </div>

                    <div id="search-panel-household-${id}" class="inline-search-panel hidden" style="margin-bottom:1rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover,#f9fafb);">
                        <input type="text" placeholder="Type household name..." class="biz-select" style="width:100%; padding:0.4rem;" onkeyup="executeLiveSearch('household', '${id}', this.value)">
                        <div id="search-results-household-${id}" style="margin-top:0.5rem; display:flex; flex-direction:column; gap:0.35rem;"></div>
                    </div>

                    ${data.households ? `
                        <div style="padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb); cursor:pointer;" onclick="openFullWidthProfile('household', '${data.households.id}')">
                            <strong>🏡 ${data.households.name}</strong>
                            <div style="font-size:0.82rem; color:var(--text-muted); margin-top:0.25rem;">Click to jump to Household view</div>
                        </div>
                    ` : '<p style="font-size:0.85rem; color:var(--text-muted);">Unassigned to any household.</p>'}
                </div>
            </div>
        `;
    } else if (type === 'pet') {
        return `
            <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap:1.5rem;">
                <!-- Pet Profile & Medical Details -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <h3 style="margin:0 0 1rem 0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="dog"></i> Pet Profile & Medical Details</h3>
                    <div style="display:flex; flex-direction:column; gap:0.85rem;">
                        <div>
                            <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:0.25rem;">Pet Name</label>
                            <input type="text" value="${data.name || ''}" class="biz-select" style="width:100%; padding:0.5rem;" onchange="autoSaveField('pets', '${id}', 'name', this.value)">
                        </div>
                        <div>
                            <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:0.25rem;">Species</label>
                            <select class="biz-select" style="width:100%; padding:0.5rem;" onchange="autoSaveField('pets', '${id}', 'species', this.value)">
                                <option value="dog" ${data.species === 'dog' ? 'selected' : ''}>Dog</option>
                                <option value="cat" ${data.species === 'cat' ? 'selected' : ''}>Cat</option>
                                <option value="other" ${data.species === 'other' ? 'selected' : ''}>Other</option>
                            </select>
                        </div>
                        <div>
                            <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:0.25rem;">Vaccine Status</label>
                            <select class="biz-select" style="width:100%; padding:0.5rem;" onchange="autoSaveField('pets', '${id}', 'vaccine_status', this.value)">
                                <option value="current" ${data.vaccine_status === 'current' ? 'selected' : ''}>Current</option>
                                <option value="pending" ${data.vaccine_status === 'pending' ? 'selected' : ''}>Pending Verification</option>
                                <option value="expired" ${data.vaccine_status === 'expired' ? 'selected' : ''}>Expired</option>
                            </select>
                        </div>
                        <div>
                            <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:0.25rem;">Allergies</label>
                            <input type="text" value="${data.allergies || ''}" placeholder="e.g. Chicken, Bee stings" class="biz-select" style="width:100%; padding:0.5rem;" onchange="autoSaveField('pets', '${id}', 'allergies', this.value)">
                        </div>
                        <div>
                            <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:0.25rem;">Diet & Food Notes</label>
                            <input type="text" value="${data.food || ''}" placeholder="e.g. 2 cups kibble morning & night" class="biz-select" style="width:100%; padding:0.5rem;" onchange="autoSaveField('pets', '${id}', 'food', this.value)">
                        </div>
                        <div>
                            <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:0.25rem;">Behavioral & General Details</label>
                            <textarea class="biz-select" style="width:100%; padding:0.5rem;" rows="3" onchange="autoSaveField('pets', '${id}', 'details', this.value)">${data.details || ''}</textarea>
                        </div>
                    </div>
                </div>

                <!-- Linked Household -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                        <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="home"></i> Household Link</h3>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="toggleInlineSearchPanel('household', '${id}')">
                            <i data-lucide="search" style="width:14px;height:14px;"></i> Link Household
                        </button>
                    </div>

                    <div id="search-panel-household-${id}" class="inline-search-panel hidden" style="margin-bottom:1rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover,#f9fafb);">
                        <input type="text" placeholder="Type household name..." class="biz-select" style="width:100%; padding:0.4rem;" onkeyup="executeLiveSearch('household', '${id}', this.value)">
                        <div id="search-results-household-${id}" style="margin-top:0.5rem; display:flex; flex-direction:column; gap:0.35rem;"></div>
                    </div>

                    ${data.households ? `
                        <div style="padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover, #f9fafb); cursor:pointer;" onclick="openFullWidthProfile('household', '${data.households.id}')">
                            <strong>🏡 ${data.households.name}</strong>
                            <div style="font-size:0.82rem; color:var(--text-muted); margin-top:0.25rem;">Click to jump to Household view</div>
                        </div>
                    ` : '<p style="font-size:0.85rem; color:var(--text-muted);">Unassigned to any household.</p>'}
                </div>
            </div>
        `;
    } else if (type === 'vet') {
        return `
            <div style="display:flex; flex-direction:column; gap:1.5rem;">
                <!-- Vet Details -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <h3 style="margin:0 0 1rem 0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="stethoscope"></i> Vet Details</h3>
                    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap:1rem;">
                        <div>
                            <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:0.25rem;">Doctor / Vet Name</label>
                            <input type="text" value="${data.name || ''}" class="biz-select" style="width:100%; padding:0.5rem;" onchange="autoSaveField('vets', '${id}', 'name', this.value)">
                        </div>
                        <div>
                            <label style="display:block; font-size:0.8rem; font-weight:600; margin-bottom:0.25rem;">Clinic Name</label>
                            <input type="text" value="${data.clinic || ''}" class="biz-select" style="width:100%; padding:0.5rem;" onchange="autoSaveField('vets', '${id}', 'clinic', this.value)">
                        </div>
                    </div>
                </div>

                <!-- Vet Client Households & Pets -->
                <div class="stat-card" style="padding:1.25rem; border:1px solid var(--border); border-radius:0.5rem; background:var(--bg-card);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; flex-wrap:wrap; gap:0.5rem;">
                        <h3 style="margin:0; font-size:1.05rem; display:flex; align-items:center; gap:0.5rem;"><i data-lucide="building"></i> Client Households & Pets</h3>
                        <button class="btn btn-primary" style="font-size:0.78rem; padding:0.3rem 0.6rem;" onclick="toggleInlineSearchPanel('household', '${id}')">
                            <i data-lucide="search" style="width:14px;height:14px;"></i> Link Client Household
                        </button>
                    </div>

                    <div id="search-panel-household-${id}" class="inline-search-panel hidden" style="margin-bottom:1rem; padding:0.75rem; border:1px solid var(--border); border-radius:0.375rem; background:var(--bg-hover,#f9fafb);">
                        <input type="text" placeholder="Search household to link..." class="biz-select" style="width:100%; padding:0.4rem;" onkeyup="executeLiveSearch('household', '${id}', this.value)">
                        <div id="search-results-household-${id}" style="margin-top:0.5rem; display:flex; flex-direction:column; gap:0.35rem;"></div>
                    </div>

                    <div id="vet-clients-grid">
                        <p style="font-size:0.85rem; color:var(--text-muted);">No client households attached to this vet facility.</p>
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
        if (typeof renderAllDashboards === 'function') {
            renderAllDashboards();
        }
    }
}

/* ==========================================================================
   UNIVERSAL INLINE LIVE SEARCH & CROSS-ENTITY LINKING
   ========================================================================== */

function toggleInlineSearchPanel(targetEntityType, sourceEntityId) {
    const panel = document.getElementById(`search-panel-${targetEntityType}-${sourceEntityId}`);
    if (panel) {
        panel.classList.toggle('hidden');
        if (!panel.classList.contains('hidden')) {
            executeLiveSearch(targetEntityType, sourceEntityId, '');
        }
    }
}

async function executeLiveSearch(targetType, sourceId, query) {
    const container = document.getElementById(`search-results-${targetType}-${sourceId}`);
    if (!container) return;

    const client = getSupabase();
    if (!client) return;

    const tableMap = { person: 'people', pet: 'pets', vet: 'vets', household: 'households' };
    const table = tableMap[targetType];

    let dbQuery = client.from(table).select('*').limit(5);
    if (query.trim()) {
        dbQuery = dbQuery.ilike('name', `%${query.trim()}%`);
    }

    const { data: results } = await dbQuery;

    let html = '';

    if (results && results.length > 0) {
        html = results.map(r => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:0.25rem; background:var(--bg-card); font-size:0.82rem;">
                <span><strong>${r.name}</strong> ${r.clinic ? '(' + r.clinic + ')' : r.contact ? '(' + r.contact + ')' : ''}</span>
                <button class="btn btn-primary" style="font-size:0.72rem; padding:0.2rem 0.45rem;" onclick="linkEntities('${targetType}', '${r.id}', '${sourceId}')">Link</button>
            </div>
        `).join('');
    } else {
        html = `<div style="font-size:0.8rem; color:var(--text-muted); padding:0.25rem 0;">No matching ${targetType}s found.</div>`;
    }

    // Dynamic + Create New fallback button
    html += `
        <button class="btn" style="width:100%; font-size:0.78rem; padding:0.35rem; margin-top:0.25rem; border:1px dashed var(--border);" onclick="createNewEntityFallback('${targetType}', '${sourceId}')">
            + Create New ${targetType.charAt(0).toUpperCase() + targetType.slice(1)}
        </button>
    `;

    container.innerHTML = html;
}

async function linkEntities(targetType, targetId, sourceId) {
    const client = getSupabase();
    if (!client) return;

    if (targetType === 'household') {
        await client.from('people').update({ household_id: targetId }).eq('id', sourceId);
        await client.from('pets').update({ household_id: targetId }).eq('id', sourceId);
    } else if (targetType === 'vet') {
        await client.from('households').update({ note: `Linked Vet ID: ${targetId}` }).eq('id', sourceId);
    } else {
        await client.from(targetType === 'person' ? 'people' : 'pets').update({ household_id: sourceId }).eq('id', targetId);
    }

    renderAllDashboards();
}

function createNewEntityFallback(targetType, sourceId) {
    if (targetType === 'person') {
        openHouseholdModal(sourceId);
    } else if (targetType === 'pet') {
        openPetModal();
        setTimeout(() => {
            const sel = document.getElementById('pet-household-id');
            if (sel) sel.value = sourceId;
        }, 100);
    } else if (targetType === 'vet') {
        openVetModal();
    } else if (targetType === 'household') {
        openHouseholdModal();
    }
}

/* ==========================================================================
   PET ASSIGNMENT MODAL CONTROLLER
   ========================================================================== */

function renderStaffAssignments() {
    const el = document.getElementById('staff-assignments-list');
    if (!el) return;

    if (typeof populateStaffSelects === 'function') populateStaffSelects();
    if (typeof petAssignments === 'undefined' || !petAssignments.length) {
        el.innerHTML = '<div class="biz-empty">No pet assignments yet.</div>';
        return;
    }

    let html = '';
    if (typeof staffMembers !== 'undefined') {
        staffMembers.forEach(s => {
            const aPets = typeof getStaffPets === 'function' ? getStaffPets(s.id) : [];
            if (!aPets.length) return;
            html += `<div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-muted);font-weight:700;margin:0.75rem 0 0.35rem;">${s.name} · ${s.role}</div>`;
            aPets.forEach(p => {
                html += `
                    <div class="assignment-item" style="display:flex;align-items:center;justify-content:space-between;padding:0.5rem;border-bottom:1px solid var(--border);">
                        <span>${p.species === 'dog' ? '🐕' : '🐈'} <strong>${p.name}</strong> (${p.role})</span>
                        <button class="btn" style="font-size:0.75rem;padding:0.25rem 0.55rem;color:var(--danger-text);" onclick="removeAssignment('${p.assignId}')">Remove</button>
                    </div>`;
            });
        });
    }
    el.innerHTML = html || '<div class="biz-empty">No assignments yet.</div>';
}

function openAssignmentModal() {
    if (typeof populateStaffSelects === 'function') populateStaffSelects();
    const petSel = document.getElementById('asgn-pet');
    if (petSel && typeof pets !== 'undefined') {
        petSel.innerHTML = pets.map(p => `<option value="${p.id}">${p.name} (${p.species})</option>`).join('');
    }
    const modal = document.getElementById('assignment-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeAssignmentModal() {
    const modal = document.getElementById('assignment-modal');
    if (modal) modal.classList.add('hidden');
}

function saveAssignment() {
    const staffId = document.getElementById('asgn-staff')?.value;
    const petId = document.getElementById('asgn-pet')?.value;
    const role = document.getElementById('asgn-role')?.value;

    if (!staffId || !petId) return alert('Please select a staff member and pet.');

    if (typeof petAssignments !== 'undefined') {
        if (petAssignments.some(a => a.staffId === staffId && a.petId === petId)) {
            return alert('Pet is already assigned to this staff member.');
        }
        const nextId = typeof nextAssignId !== 'undefined' ? nextAssignId++ : Date.now();
        petAssignments.push({ id: 'pa' + nextId, staffId, petId, role });
    }

    closeAssignmentModal();
    renderStaffAssignments();
}

function removeAssignment(id) {
    if (typeof petAssignments !== 'undefined') {
        petAssignments = petAssignments.filter(x => x.id !== id);
    }
    renderStaffAssignments();
}

/* ==========================================================================
   STAFF TASK MODAL CONTROLLER
   ========================================================================== */

let editingStaffTaskId = null;

function renderStaffTasks() {
    const el = document.getElementById('staff-tasks-list');
    if (!el) return;

    const filterStaff = document.getElementById('staff-task-filter')?.value || 'all';
    const filterStatus = document.getElementById('staff-task-status-filter')?.value || 'all';

    if (typeof staffTasks === 'undefined') return;

    let tasks = [...staffTasks];
    if (filterStaff !== 'all') tasks = tasks.filter(t => t.staffId === filterStaff);
    if (filterStatus === 'pending') tasks = tasks.filter(t => !t.done);
    if (filterStatus === 'done') tasks = tasks.filter(t => t.done);

    if (!tasks.length) {
        el.innerHTML = '<div class="biz-empty">No tasks match this filter.</div>';
        return;
    }

    el.innerHTML = tasks.map(t => {
        const s = typeof staffMembers !== 'undefined' ? staffMembers.find(x => x.id === t.staffId) : null;
        return `
            <div class="staff-task-item ${t.done ? 'done' : ''}" style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem;border-bottom:1px solid var(--border);">
                <div>
                    <input type="checkbox" ${t.done ? 'checked' : ''} onchange="toggleStaffTask('${t.id}')">
                    <strong style="${t.done ? 'text-decoration:line-through;color:var(--text-muted);' : ''}">${t.text}</strong>
                    <span style="font-size:0.78rem;color:var(--text-muted);margin-left:0.5rem;">👤 ${s ? s.name : 'Unassigned'} · Due ${t.due}</span>
                </div>
                <div>
                    <button class="btn" style="font-size:0.72rem;padding:0.25rem 0.5rem;" onclick="openStaffTaskModal('${t.id}')">Edit</button>
                    <button class="btn" style="font-size:0.72rem;padding:0.25rem 0.5rem;color:var(--danger-text);" onclick="deleteStaffTask('${t.id}')">✕</button>
                </div>
            </div>
        `;
    }).join('');
}

function openStaffTaskModal(id) {
    editingStaffTaskId = id;
    if (typeof populateStaffSelects === 'function') populateStaffSelects();

    const titleEl = document.getElementById('staff-task-modal-title');
    if (titleEl) titleEl.textContent = id ? 'Edit Task' : 'Add Task';

    const whoSel = document.getElementById('stsk-who');
    const textInput = document.getElementById('stsk-text');
    const dueInput = document.getElementById('stsk-due');
    const prioritySel = document.getElementById('stsk-priority');

    if (id && typeof staffTasks !== 'undefined') {
        const t = staffTasks.find(x => x.id === id);
        if (t) {
            if (whoSel) whoSel.value = t.staffId;
            if (textInput) textInput.value = t.text;
            if (dueInput) dueInput.value = t.due;
            if (prioritySel) prioritySel.value = t.priority;
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
    const modal = document.getElementById('staff-task-modal');
    if (modal) modal.classList.add('hidden');
}

function saveStaffTask() {
    const staffId = document.getElementById('stsk-who')?.value;
    const text = document.getElementById('stsk-text')?.value.trim();
    const due = document.getElementById('stsk-due')?.value;
    const priority = document.getElementById('stsk-priority')?.value || 'normal';

    if (!text || !due) return alert('Please enter task description and due date.');

    if (typeof staffTasks !== 'undefined') {
        if (editingStaffTaskId) {
            const t = staffTasks.find(x => x.id === editingStaffTaskId);
            if (t) Object.assign(t, { staffId, text, due, priority });
        } else {
            const nextId = typeof nextStaffTaskId !== 'undefined' ? nextStaffTaskId++ : Date.now();
            staffTasks.push({ id: 'stsk' + nextId, staffId, text, due, priority, done: false });
        }
    }

    editingStaffTaskId = null;
    closeStaffTaskModal();
    renderStaffTasks();
}

function toggleStaffTask(id) {
    if (typeof staffTasks !== 'undefined') {
        const t = staffTasks.find(x => x.id === id);
        if (t) t.done = !t.done;
    }
    renderStaffTasks();
}

function deleteStaffTask(id) {
    if (typeof staffTasks !== 'undefined') {
        staffTasks = staffTasks.filter(x => x.id !== id);
    }
    renderStaffTasks();
}

/* ==========================================================================
   RESOURCE GRID & CALENDAR SUB-TAB CONTROLLER
   ========================================================================== */

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

function openResourceModal(id) {
    editingResourceId = id;
    const r = (id && typeof managedResources !== 'undefined') 
        ? managedResources.find(x => x.id === id) 
        : null;

    const titleEl = document.getElementById('resource-modal-title');
    if (titleEl) titleEl.textContent = r ? 'Edit Resource' : 'Add Resource';

    const nameInput = document.getElementById('rm-name');
    const typeSelect = document.getElementById('rm-type');
    const blackoutsArea = document.getElementById('rm-blackouts');
    const notesInput = document.getElementById('rm-notes');

    if (nameInput) nameInput.value = r ? r.name : '';
    if (typeSelect) typeSelect.value = r ? r.type : 'Dog Suite';
    if (blackoutsArea) blackoutsArea.value = r && r.blackouts ? r.blackouts.join('\n') : '';
    if (notesInput) notesInput.value = r ? r.notes : '';

    const modal = document.getElementById('resource-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeResourceModal() {
    const modal = document.getElementById('resource-modal');
    if (modal) modal.classList.add('hidden');
}

function saveResource() {
    const name = document.getElementById('rm-name')?.value.trim();
    if (!name) return alert('Please enter a resource name.');

    const type = document.getElementById('rm-type')?.value || 'Dog Suite';
    const notes = document.getElementById('rm-notes')?.value.trim() || '';
    const blackoutsText = document.getElementById('rm-blackouts')?.value || '';
    const blackouts = blackoutsText.split('\n').map(s => s.trim()).filter(Boolean);

    const data = { name, type, notes, blackouts };

    if (typeof managedResources !== 'undefined') {
        if (editingResourceId) {
            const r = managedResources.find(x => x.id === editingResourceId);
            if (r) Object.assign(r, data);
            if (typeof resources !== 'undefined') {
                const cr = resources.find(x => x.id === editingResourceId);
                if (cr) { cr.name = data.name; cr.type = data.type; }
            }
        } else {
            const nextId = typeof nextResourceId !== 'undefined' ? nextResourceId++ : Date.now();
            const newId = 'r' + nextId;
            managedResources.push({ id: newId, ...data });
            if (typeof resources !== 'undefined') {
                resources.push({ id: newId, name: data.name, type: data.type });
            }
        }
    }

    editingResourceId = null;
    closeResourceModal();
    
    if (typeof renderResourceList === 'function') renderResourceList();
    if (typeof renderCalendar === 'function') renderCalendar();
}

function deleteResource(id) {
    if (!confirm('Remove this resource space?')) return;

    if (typeof managedResources !== 'undefined') {
        managedResources = managedResources.filter(x => x.id !== id);
    }
    if (typeof resources !== 'undefined') {
        resources = resources.filter(x => x.id !== id);
    }

    if (typeof renderResourceList === 'function') renderResourceList();
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

function renderAvailabilityList() {
    const el = document.getElementById('availability-list');
    if (!el) return;

    if (typeof businessClosures === 'undefined' || !businessClosures.length) {
        el.innerHTML = '<div class="biz-empty">No business closures scheduled.</div>';
        return;
    }

    const sorted = [...businessClosures].sort((a, b) => a.start.localeCompare(b.start));
    
    el.innerHTML = sorted.map(c => {
        const span = c.start === c.end ? c.start : `${c.start} → ${c.end}`;
        return `
            <div class="closure-item type-${c.type}" style="display:flex;align-items:center;justify-content:space-between;padding:0.75rem;border:1px solid var(--border);border-radius:0.375rem;">
                <div class="closure-info">
                    <h4 style="margin:0;">${c.label}</h4>
                    <p style="margin:0;font-size:0.8rem;color:var(--text-muted);">${span} ${c.notes ? '· ' + c.notes : ''}</p>
                </div>
                <div style="display:flex;gap:0.4rem;align-items:center;">
                    <span class="closure-type-pill ${c.type}" style="font-size:0.72rem;padding:0.15rem 0.5rem;border-radius:9999px;font-weight:600;">${c.type === 'closure' ? 'Closed' : c.type === 'reduced' ? 'Reduced' : 'Holiday'}</span>
                    <button class="btn" style="font-size:0.78rem;padding:0.3rem 0.65rem;" onclick="openAvailabilityModal('${c.id}')">Edit</button>
                    <button class="btn" style="font-size:0.78rem;padding:0.3rem 0.65rem;color:var(--danger-text);" onclick="deleteClosure('${c.id}')">Remove</button>
                </div>
            </div>`;
    }).join('');
}

function openAvailabilityModal(id) {
    editingClosureId = id;
    const c = (id && typeof businessClosures !== 'undefined') 
        ? businessClosures.find(x => x.id === id) 
        : null;

    const titleEl = document.getElementById('avail-modal-title');
    if (titleEl) titleEl.textContent = c ? 'Edit Closure' : 'Add Closure';

    const labelInput = document.getElementById('av-label');
    const typeSelect = document.getElementById('av-type');
    const startInput = document.getElementById('av-start');
    const endInput = document.getElementById('av-end');
    const notesInput = document.getElementById('av-notes');

    if (labelInput) labelInput.value = c ? c.label : '';
    if (typeSelect) typeSelect.value = c ? c.type : 'closure';
    if (startInput) startInput.value = c ? c.start : '';
    if (endInput) endInput.value = c ? c.end : '';
    if (notesInput) notesInput.value = c ? c.notes : '';

    const modal = document.getElementById('availability-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeAvailabilityModal() {
    const modal = document.getElementById('availability-modal');
    if (modal) modal.classList.add('hidden');
}

function saveAvailability() {
    const label = document.getElementById('av-label')?.value.trim();
    const start = document.getElementById('av-start')?.value;
    const end = document.getElementById('av-end')?.value || start;
    const type = document.getElementById('av-type')?.value || 'closure';
    const notes = document.getElementById('av-notes')?.value.trim() || '';

    if (!label || !start) return alert('Please enter a label and start date.');

    const data = { label, type, start, end, notes };

    if (typeof businessClosures !== 'undefined') {
        if (editingClosureId) {
            const c = businessClosures.find(x => x.id === editingClosureId);
            if (c) Object.assign(c, data);
        } else {
            const nextId = typeof nextClosureId !== 'undefined' ? nextClosureId++ : Date.now();
            businessClosures.push({ id: 'cl' + nextId, ...data });
        }
    }

    editingClosureId = null;
    closeAvailabilityModal();
    renderAvailabilityList();
}

function deleteClosure(id) {
    if (!confirm('Remove this business closure date?')) return;

    if (typeof businessClosures !== 'undefined') {
        businessClosures = businessClosures.filter(x => x.id !== id);
    }
    renderAvailabilityList();
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
