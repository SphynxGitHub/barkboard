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
  renderAllDashboards();
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
  currentEntityFilter = filterType;
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
  const filterBtn = document.getElementById('filter-' + filterType);
  if (filterBtn) filterBtn.classList.add('active');
  renderAllDashboards();
}

function toggleLayout() {
  isCardLayoutMode = !isCardLayoutMode;
  renderAllDashboards();
}

function executeAction(actionName, id) {
  alert(`CRM Action: [${actionName}] requested for household key: ${id}`);
}

function activateOwnerView(householdId) {
  currentOwnerHouseholdId = householdId;
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
  currentOwnerHouseholdId = null;
  const banner = document.getElementById('owner-banner');
  if (banner) banner.classList.add('hidden');
  switchView('crm-view');
}

// Window resize listener to keep layout modes dynamic
var resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    applyLayout();
  }, 80);
});

/* ==========================================================================
   STAFF MANAGEMENT CONTROLLER
   ========================================================================== */

/* === STAFF VIEW INITIALIZATION === */
function initStaffView() {
    if (typeof populateStaffSelects === 'function') {
        populateStaffSelects();
    }
    if (typeof switchStaffTab === 'function') {
        switchStaffTab('roster');
    }
}

/**
 * Populates all staff dropdown selects across modals and filter menus
 */
function populateStaffSelects() {
    if (typeof staffMembers === 'undefined' || !Array.isArray(staffMembers)) return;

    const opts = staffMembers
        .map(s => `<option value="${s.id}">${s.name} · ${s.role}</option>`)
        .join('');

    // Target dropdown IDs across all modals
    const selectIds = ['sav-who', 'asgn-staff', 'stsk-who'];
    selectIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = opts;
    });

    // Target task list filter dropdown
    const filterSel = document.getElementById('staff-task-filter');
    if (filterSel) {
        filterSel.innerHTML = '<option value="all">All staff</option>' + opts;
    }
}

async function renderStaffRoster() {
   const client = getSupabase();
   if (!client) return;
   
   const { data: staff, error } = await client
       .from('resources')
       .select('*')
       .order('created_at', { ascending: false });
   
    const el = document.getElementById('staff-roster-list');
    if (!el) return;

    // Fetch live rows from Supabase
    const { data: staff, error } = await supabase
        .from('resources')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Supabase fetch error:', error.message);
        el.innerHTML = '<div class="biz-empty" style="color:var(--danger-text);">Failed to load staff from Supabase.</div>';
        return;
    }

    if (!staff || staff.length === 0) {
        el.innerHTML = '<div class="biz-empty">No staff members in Supabase database yet.</div>';
        return;
    }

    el.innerHTML = staff.map(s => `
        <div class="staff-card">
            <div class="staff-avatar">${s.name.slice(0, 2).toUpperCase()}</div>
            <div class="staff-info">
                <h4>${s.name}</h4>
                <p>${s.description || 'No role/contact details'}</p>
            </div>
            <div class="staff-actions">
                <button class="btn" style="color:var(--danger-text);" onclick="deleteStaff('${s.id}')">Remove</button>
            </div>
        </div>
    `).join('');
}

/**
 * Switch active tab inside the Staff Management section
 */
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

/**
 * Staff Modal Controls
 */
function openStaffModal(id) {
    editingStaffId = id;
    const s = id ? staffMembers.find(x => x.id === id) : null;
    
    const titleEl = document.getElementById('staff-modal-title');
    if (titleEl) titleEl.textContent = s ? 'Edit Staff Member' : 'Add Staff Member';
    
    const nameInput = document.getElementById('stf-name');
    const roleSelect = document.getElementById('stf-role');
    const contactInput = document.getElementById('stf-contact');
    const notesInput = document.getElementById('stf-notes');
    
    if (nameInput) nameInput.value = s ? s.name : '';
    if (roleSelect) roleSelect.value = s ? s.role : 'Trainer';
    if (contactInput) contactInput.value = s ? s.contact : '';
    if (notesInput) notesInput.value = s ? s.notes : '';

    // Render service qualifications options inside the modal
    if (typeof renderStaffQualEditor === 'function') {
        renderStaffQualEditor(s);
    }
    
    const modal = document.getElementById('staff-modal');
    if (modal) modal.classList.remove('hidden');
}

function closeStaffModal() {
    const modal = document.getElementById('staff-modal');
    if (modal) modal.classList.add('hidden');
}

async function saveStaffMember() {
   const client = getSupabase();
   if (!client) return alert('Database connection unavailable.');
   
   const { error } = await client
       .from('resources')
       .insert([{ name: name, description: role }]);
   
    const nameInput = document.getElementById('stf-name');
    const roleSelect = document.getElementById('stf-role');
    const name = nameInput ? nameInput.value.trim() : '';
    
    if (!name) return alert('Please enter a name.');

    const role = roleSelect ? roleSelect.value : 'Staff';

    // Insert record directly into Supabase
    const { error } = await supabase
        .from('resources')
        .insert([{ name: name, description: role }]);

    if (error) {
        alert('Error saving to Supabase: ' + error.message);
        console.error(error);
    } else {
        closeStaffModal();
        await renderStaffRoster(); // Reload roster live from DB
    }
}

async function deleteStaff(id) {
   const client = getSupabase();
   if (!client) return;
   
   const { error } = await client
       .from('resources')
       .delete()
       .eq('id', id);
   
    if (!confirm('Remove this staff member from Supabase?')) return;

    const { error } = await supabase
        .from('resources')
        .delete()
        .eq('id', id);

    if (error) {
        alert('Error deleting row: ' + error.message);
    } else {
        await renderStaffRoster();
    }
}
