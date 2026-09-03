/* ==========================================================================
   APP CONTROLLER: Event Handlers & View Management
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  renderAllDashboards();
});

function switchView(viewId) {
  document.querySelectorAll('.view-panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  
  const targetView = document.getElementById(viewId);
  if (targetView) targetView.classList.remove('hidden');

  const activeBtn = Array.from(document.querySelectorAll('.nav-btn'))
    .find(b => b.getAttribute('onclick') && b.getAttribute('onclick').includes(viewId));
  if (activeBtn) activeBtn.classList.add('active');
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

/* switchView hook for staff-mgmt-view */
function initStaffView() {
    populateStaffSelects();
    switchStaffTab('roster'); // Ensures Roster tab and list load by default
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

function saveStaffMember() {
    const nameInput = document.getElementById('stf-name');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) return alert('Please enter a name.');
    
    const role = document.getElementById('stf-role').value;
    const contact = document.getElementById('stf-contact').value.trim();
    const notes = document.getElementById('stf-notes').value.trim();
    const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    
    const data = { name, role, contact, notes, initials };
    const targetId = editingStaffId || ('s' + (nextStaffId++));
    
    if (editingStaffId) {
        const existing = staffMembers.find(x => x.id === editingStaffId);
        if (existing) Object.assign(existing, data);
    } else {
        staffMembers.push({ id: targetId, ...data });
    }

    closeStaffModal();
    if (typeof renderStaffRoster === 'function') renderStaffRoster();
}

function deleteStaff(id) {
    if (!confirm('Remove this staff member?')) return;
    staffMembers = staffMembers.filter(x => x.id !== id);
    if (typeof renderStaffRoster === 'function') renderStaffRoster();
}
