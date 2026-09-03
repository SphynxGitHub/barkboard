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

/* ==========================================================================
   APP CONTROLLER: Event Handlers & View Management
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
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
    const filterBtn = document.getElementById('filter-' + filterType);
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

function populateStaffSelects() {
    if (typeof staffMembers === 'undefined' || !Array.isArray(staffMembers)) return;

    const opts = staffMembers
        .map(s => `<option value="${s.id}">${s.name} · ${s.role}</option>`)
        .join('');

    const selectIds = ['sav-who', 'asgn-staff', 'stsk-who'];
    selectIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = opts;
    });

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

/* ==========================================================================
   CROSS-ENTITY RELATIONSHIP MODAL CONTROLLER
   ========================================================================== */

function openRelationshipModal() {
    const selectA = document.getElementById('modal-entity-a');
    if (selectA && typeof households !== 'undefined') {
        selectA.innerHTML = households.map(h => `<option value="${h.id}">${h.name}</option>`).join('');
    }
    populateTargetDropdown();
    const modal = document.getElementById('relationship-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeRelationshipModal() {
    const modal = document.getElementById('relationship-modal');
    if (modal) modal.classList.add('hidden');
}

function toggleRelationshipFields() {
    populateTargetDropdown();
}

function populateTargetDropdown() {
    const typeEl = document.getElementById('modal-relation-type');
    const selectB = document.getElementById('modal-entity-b');
    if (!typeEl || !selectB) return;

    const type = typeEl.value;
    selectB.innerHTML = '';

    if (type === 'vet' && typeof vets !== 'undefined') {
        selectB.innerHTML = vets.map(v => `<option value="${v.id}">${v.name}</option>`).join('');
    } else if (typeof households !== 'undefined') {
        selectB.innerHTML = households.map(h => `<option value="${h.id}">${h.name}</option>`).join('');
    }
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

/**
 * Switch active tab inside the Calendar / Resource Grid view
 */
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

/* === RESOURCE MODAL CONTROLLERS === */

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

/**
 * Switch active tab inside the Business view (Dashboard vs. Availability)
 */
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

/* === BUSINESS AVAILABILITY / CLOSURES MODAL CONTROLLERS === */

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
