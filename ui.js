/* ==========================================================================
   UI MODULE: Rendering Engines & Template Generators
   ========================================================================== */

function generateQuickActionsHTML(householdId) {
  return `
    <div class="qa-container" onclick="event.stopPropagation();">
      <div class="qa-icon-btn" data-tooltip="Book Visit" onclick="executeAction('Book Visit','${householdId}')">📅<span>Book Visit</span></div>
      <div class="qa-icon-btn" data-tooltip="Add Pet" onclick="executeAction('Add Pet','${householdId}')">🐕<span>Add Pet</span></div>
      <div class="qa-icon-btn" data-tooltip="Add Person" onclick="executeAction('Add Person','${householdId}')">👤<span>Add Person</span></div>
      <div class="qa-icon-btn" data-tooltip="Add Vet" onclick="executeAction('Add Vet','${householdId}')">🏥<span>Add Vet</span></div>
      <div class="qa-icon-btn" data-tooltip="Request Payment" onclick="executeAction('Request Payment','${householdId}')">💳<span>Request Payment</span></div>
      <div class="qa-icon-btn" data-tooltip="Send Email" onclick="executeAction('Send Email','${householdId}')">✉️<span>Send Email</span></div>
      <div class="qa-icon-btn" data-tooltip="View as Owner" onclick="event.stopPropagation();activateOwnerView('${householdId}')" style="background:#e0f2fe;border-color:#7dd3fc;">👁<span>View as Owner</span></div>
    </div>
  `;
}

function renderAllDashboards() {
  applyLayout();
  const searchVal = document.getElementById('crm-search') ? document.getElementById('crm-search').value.toLowerCase() : '';

  // Render Staff Guest Dashboard
  const staffGuestsContainer = document.getElementById('staff-guests-container');
  if (staffGuestsContainer) {
    staffGuestsContainer.innerHTML = '';
    const kennelsEl = document.getElementById('stat-kennels');
    if (kennelsEl) kennelsEl.innerText = `${pets.length} / 20`;
    
    pets.forEach(pet => {
      const hOwner = households.find(h => h.id === pet.householdId);
      const isAlert = pet.status === 'expired' || pet.status.includes('Expired');
      staffGuestsContainer.innerHTML += `
        <div class="crm-card ${isAlert ? 'warning' : ''}">
          <div class="item-header">
            <h3>${pet.name} <span class="badge luxury">${pet.room}</span></h3>
            <span class="entity-badge pets">Pet Guest</span>
          </div>
          <p style="margin:0;font-size:0.88rem;"><strong>Details:</strong> ${pet.details} &nbsp;·&nbsp; <strong>Household:</strong> ${hOwner ? hOwner.name : 'Unassigned'}</p>
          ${isAlert ? `<p class="pin-note">📌 <strong>Vaccine alert:</strong> Update medical records immediately.</p>` : ''}
          <div class="qa-container">
            <button class="btn" onclick="alert('Feeding logged for ${pet.name}')">+ Feeding Log</button>
            <button class="btn" onclick="alert('Potty logged for ${pet.name}')">+ Potty Log</button>
          </div>
        </div>
      `;
    });
  }

  // Render CRM Cards
  const crmContainer = document.getElementById('crm-list-container');
  if (crmContainer) {
    crmContainer.innerHTML = '';
    if (currentEntityFilter === 'all' || currentEntityFilter === 'household') {
      households.forEach(h => {
        if (!h.name.toLowerCase().includes(searchVal)) return;
        const hPeople = people.filter(p => p.householdId === h.id);
        const hPets = pets.filter(p => p.householdId === h.id);
        
        crmContainer.innerHTML += `
          <div class="crm-card" onclick="openFullscreenProfile('household','${h.id}')">
            <div class="item-header">
              <div class="clickable-profile-zone"><h3>${h.name}</h3></div>
              <span class="entity-badge household">Household</span>
            </div>
            ${isCardLayoutMode ? `<p class="pin-note">📌 ${h.note}</p>` : ''}
            <div class="crm-section-block">
              <h4>Members</h4>
              <ul>
                ${hPeople.map(p => `<li>👤 ${p.name} (${p.role})</li>`).join('')}
                ${hPets.map(p => `<li>🐾 ${p.name} — ${p.details}</li>`).join('')}
              </ul>
            </div>
            ${generateQuickActionsHTML(h.id)}
          </div>
        `;
      });
    }
  }
}

function applyLayout() {
  const container = document.getElementById('crm-list-container');
  if (!container) return;
  const useList = !isCardLayoutMode || (window.innerWidth <= 768);
  container.className = useList ? 'list-layout' : 'card-layout';
  const btn = document.querySelector('.toggle-layout-btn');
  if (btn) btn.innerText = isCardLayoutMode ? '📋 Switch to List View' : '🗂️ Switch to Card View';
}

/* ==========================================================================
   STAFF ROSTER UI RENDERERS
   ========================================================================== */

function renderStaffRoster() {
    const el = document.getElementById('staff-roster-list');
    if (!el) return;
    if (!staffMembers.length) { 
        el.innerHTML = '<div class="biz-empty">No staff members yet.</div>'; 
        return; 
    }
    
    el.innerHTML = staffMembers.map(s => {
        return `
            <div class="staff-card">
                <div class="staff-avatar">${s.initials || 'ST'}</div>
                <div class="staff-info">
                    <h4>${s.name}</h4>
                    <p>${s.contact || 'No contact on file'}</p>
                    <span class="staff-role-pill">${s.role}</span>
                </div>
                <div class="staff-actions">
                    <button class="btn" onclick="openStaffModal('${s.id}')">Edit</button>
                    <button class="btn" style="color:var(--danger-text);" onclick="deleteStaff('${s.id}')">Remove</button>
                </div>
            </div>
        `;
    }).join('');
}

function renderStaffQualEditor(staffObj) {
    const editor = document.getElementById('stf-qual-editor');
    if (!editor) return;
    const currentQuals = staffObj ? (staffQualifications[staffObj.id] || []) : [];
    
    editor.innerHTML = serviceTypes.map(svc => {
        const q = currentQuals.find(item => item.serviceId === svc.id);
        const checked = q ? 'checked' : '';
        const cap = q ? q.dailyMax : (svc.category === 'boarding' ? 99 : 3);
        return `
            <div class="qual-row">
                <input type="checkbox" id="qual-chk-${svc.id}" ${checked}>
                <label class="qual-row-label" for="qual-chk-${svc.id}">${svc.name}</label>
                <div class="qual-row-cap">
                    <input type="number" id="qual-cap-${svc.id}" value="${cap}" min="1" max="99">
                </div>
            </div>
        `;
    }).join('');
}
