// --- CENTRAL APPLICATION DATABASE STATE MOCK ---
var households = [
    { id: 'h-miller', name: 'The Miller Household', note: 'Gate code is #4412.', address: '742 Evergreen Terrace' },
    { id: 'h-davis', name: 'The Davis Household', note: 'Alice handles drop-offs.', address: '122 Maple Road' }
];

var people = [
    { id: 'p-john', householdId: 'h-miller', name: 'John Miller', contact: '555-0192 | john.m@email.com', role: 'Primary' },
    { id: 'p-jane', householdId: 'h-miller', name: 'Jane Miller', contact: '555-0193', role: 'Secondary' },
    { id: 'p-alice', householdId: 'h-davis', name: 'Alice Davis', contact: '555-3341', role: 'Primary' }
];

var pets = [
    { id: 'pet-max', householdId: 'h-miller', name: 'Max', details: 'Golden Retriever (3yo, 72 lbs)', status: '✅ Vaccines Current', room: 'Luxury Suite #5' },
    { id: 'pet-bella', householdId: 'h-miller', name: 'Bella', details: 'Siamese Cat (7yo, 11 lbs)', status: '❌ Vaccines Expired', room: 'Cat Condo A' },
    { id: 'pet-luna', householdId: 'h-davis', name: 'Luna', details: 'French Bulldog (2yo, 22 lbs)', status: '✅ Vaccines Current', room: 'Standard Run B' }
];

var vets = [
    { id: 'v-oakridge', name: 'Oakridge Vet Clinic', details: 'Dr. Arrington | 555-9981' },
    { id: 'v-city', name: 'City Animal Hospital', details: 'Emergency Dispatch | 555-1212' }
];

var crossRelationships = [
    { entityId: 'h-miller', targetId: 'v-oakridge', type: 'vet', note: 'Primary Care' },
    { entityId: 'h-davis', targetId: 'v-city', type: 'vet', note: 'Emergency Backup Only' }
];

var currentEntityFilter = 'all';
var isCardLayoutMode = true;

// Initial execution hook on load
document.addEventListener("DOMContentLoaded", () => {
    renderAllDashboards();
});

/**
 * Global Routing Manager
 */
function switchView(viewId) {
    document.querySelectorAll('.view-panel').forEach(panel => panel.classList.add('hidden'));
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    
    document.getElementById(viewId).classList.remove('hidden');
    
    const activeBtn = Array.from(document.querySelectorAll('.nav-btn')).find(btn => btn.getAttribute('onclick').includes(viewId));
    if (activeBtn) activeBtn.classList.add('active');
}

function setEntityFilter(filterType) {
    currentEntityFilter = filterType;
    document.querySelectorAll('.filter-chip').forEach(chip => chip.classList.remove('active'));
    document.getElementById(`filter-${filterType}`).classList.add('active');
    renderAllDashboards();
}

function toggleLayout() {
    isCardLayoutMode = !isCardLayoutMode;
    const container = document.getElementById('crm-list-container');
    const toggleBtn = document.querySelector('.toggle-layout-btn');
    
    container.className = isCardLayoutMode ? 'card-layout' : 'list-layout';
    toggleBtn.innerText = isCardLayoutMode ? '📋 Switch to List View' : '🗂️ Switch to Card View';
    renderAllDashboards();
}

/**
 * REUSABLE ACTIONS UTILITY FOR HOUSEHOLDS
 */
function generateQuickActionsHTML(householdId) {
    return `
        <div class="qa-container" onclick="event.stopPropagation();">
            <div class="qa-icon-btn" data-tooltip="Book Visit" onclick="executeAction('Book Visit', '${householdId}')">📅<span>Book Visit</span></div>
            <div class="qa-icon-btn" data-tooltip="Add Pet" onclick="executeAction('Add Pet', '${householdId}')">🐕<span>Add Pet</span></div>
            <div class="qa-icon-btn" data-tooltip="Add Person" onclick="executeAction('Add Person', '${householdId}')">👤<span>Add Person</span></button></div>
            <div class="qa-icon-btn" data-tooltip="Add Vet" onclick="executeAction('Add Vet', '${householdId}')">🏥<span>Add Vet</span></div>
            <div class="qa-icon-btn" data-tooltip="Request Payment" onclick="executeAction('Request Payment', '${householdId}')">💳<span>Request Payment</span></div>
            <div class="qa-icon-btn" data-tooltip="Send Email" onclick="executeAction('Send Email', '${householdId}')">✉️<span>Send Email</span></div>
        </div>
    `;
}

function executeAction(actionName, id) {
    alert(`CRM Dispatch Event:\n[${actionName}] requested for household target mapping key: ${id}`);
}

/**
 * MASTER ENGINE: Repaints all dashboard layers from centralized state arrays
 */
function renderAllDashboards() {
    const searchVal = document.getElementById('crm-search') ? document.getElementById('crm-search').value.toLowerCase() : '';
    
    // ---------------- PANEL 1: STAFF DASHBOARD REPAINT ----------------
    const staffGuestsContainer = document.getElementById('staff-guests-container');
    if (staffGuestsContainer) {
        staffGuestsContainer.innerHTML = '';
        // Set dynamic live capacity counter metric
        document.getElementById('stat-kennels').innerText = `${pets.length} / 20`;
        
        pets.forEach(pet => {
            const hOwner = households.find(h => h.id === pet.householdId);
            const isAlert = pet.status.includes('Expired');
            
            staffGuestsContainer.innerHTML += `
                <div class="crm-card ${isAlert ? 'warning' : ''}">
                    <div class="item-header">
                        <h3>${pet.name} <span class="badge luxury">${pet.room}</span></h3>
                        <span class="entity-badge pets">Pet Guest</span>
                    </div>
                    <p><strong>Attributes:</strong> ${pet.details} | <strong>Family:</strong> ${hOwner.name}</p>
                    ${isAlert ? `<p class="pin-note">📌 <strong>Expired Vaccination Alert:</strong> Update medical sheets immediately.</p>` : ''}
                    <div class="qa-container">
                        <button class="btn" onclick="alert('Feeding event logged for ${pet.name}')">+ Feeding Log</button>
                        <button class="btn" onclick="alert('Potty event logged for ${pet.name}')">+ Potty Log</button>
                    </div>
                </div>
            `;
        });
    }

    // ---------------- PANEL 2: PEOPLE & PETS CRM REPAINT ----------------
    const crmContainer = document.getElementById('crm-list-container');
    if (crmContainer) {
        crmContainer.innerHTML = '';

        if (currentEntityFilter === 'all' || currentEntityFilter === 'household') {
            households.forEach(h => {
                if (!h.name.toLowerCase().includes(searchVal)) return;
                const hPeople = people.filter(p => p.householdId === h.id);
                const hPets = pets.filter(p => p.householdId === h.id);
                const hVets = crossRelationships.filter(r => r.entityId === h.id && r.type === 'vet').map(r => vets.find(v => v.id === r.targetId));

                crmContainer.innerHTML += `
                    <div class="crm-card" onclick="openFullscreenProfile('household', '${h.id}')">
                        <div class="item-header">
                            <div class="clickable-profile-zone"><h3>${h.name}</h3></div>
                            <span class="entity-badge household">Household</span>
                        </div>
                        ${isCardLayoutMode ? `<p class="pin-note">📌 <strong>Household Context:</strong> ${h.note}</p>` : ''}
                        <div class="crm-section-block">
                            <h4>Members Structure</h4>
                            <ul>
                                ${hPeople.map(p => `<li>👤 ${p.name} (${p.role})</li>`).join('')}
                                ${hPets.map(p => `<li>🐾 ${p.name} - ${p.details}</li>`).join('')}
                            </ul>
                        </div>
                        ${generateQuickActionsHTML(h.id)}
                    </div>
                `;
            });
        }

        ['people', 'pets', 'vets'].forEach(category => {
            if (currentEntityFilter === 'all' || currentEntityFilter === category) {
                window[category].forEach(item => {
                    if (!item.name.toLowerCase().includes(searchVal)) return;
                    const parentHId = item.householdId || '';
                    
                    crmContainer.innerHTML += `
                        <div class="crm-card" onclick="openFullscreenProfile('${category}', '${item.id}')">
                            <div class="item-header">
                                <div class="clickable-profile-zone"><h3>${item.name}</h3></div>
                                <span class="entity-badge ${category}">${category}</span>
                            </div>
                            <p>${item.contact || item.details || 'Registered COI Enterprise Network Row Data'}</p>
                            ${parentHId ? generateQuickActionsHTML(parentHId) : ''}
                        </div>
                    `;
                });
            }
        });
    }

    // ---------------- PANEL 3: RESOURCE CALENDAR REPAINT ----------------
    const calendarBody = document.getElementById('calendar-body-target');
    if (calendarBody) {
        calendarBody.innerHTML = `
            <tr><td><strong>Luxury Suite #5</strong></td><td class="booked" colspan="2">Max (The Millers)</td><td class="available">Available</td><td class="available">Available</td></tr>
            <tr><td><strong>Standard Run B</strong></td><td class="booked" colspan="4">Luna (The Davis Family)</td></tr>
            <tr><td><strong>Cat Condo A</strong></td><td class="available">Available</td><td class="booked">Bella (The Millers)</td><td class="available">Available</td><td class="available">Available</td></tr>
        `;
    }
}

/**
 * FULL SCREEN COMMAND PROFILE HOOK OVERLAY
 */
function openFullscreenProfile(type, id) {
    const overlay = document.getElementById('fullscreen-modal');
    const title = document.getElementById('fs-title');
    const actionsAnchor = document.getElementById('fs-quick-actions-anchor');
    const payloadAnchor = document.getElementById('fs-details-payload');

    actionsAnchor.innerHTML = '';
    payloadAnchor.innerHTML = '';

    if (type === 'household') {
        const h = households.find(x => x.id === id);
        const hPeople = people.filter(p => p.householdId === h.id);
        const hPets = pets.filter(p => p.householdId === h.id);
        
        title.innerText = `${h.name} - Master Profile`;
        actionsAnchor.innerHTML = `<h4>Quick Operations</h4>` + generateQuickActionsHTML(h.id);
        
        payloadAnchor.innerHTML = `
            <div class="crm-section-block"><h4>📍 Street Address</h4><p>${h.address}</p></div>
            <div class="crm-section-block"><h4>📝 Notes Context</h4><p>${h.note}</p></div>
            <div class="crm-section-block">
                <h4>Household Human Members</h4>
                <ul>${hPeople.map(p => `<li>👤 <strong>${p.name}</strong> - Contact Type: ${p.role} (${p.contact})</li>`).join('')}</ul>
            </div>
            <div class="crm-section-block">
                <h4>Registered Animals</h4>
                <ul>${hPets.map(p => `<li>🐾 <strong>${p.name}</strong> - ${p.details} | Safety Clearance: <strong>${p.status}</strong></li>`).join('')}</ul>
            </div>
        `;
    } else {
        let targetItem = [...people, ...pets, ...vets].find(x => x.id === id);
        title.innerText = `${targetItem.name} - Node File`;
        if (targetItem.householdId) {
            actionsAnchor.innerHTML = `<h4>Quick Operations</h4>` + generateQuickActionsHTML(targetItem.householdId);
        }
        payloadAnchor.innerHTML = `
            <div class="crm-section-block"><h4>Attributes & Metadata</h4><p>${targetItem.contact || targetItem.details || 'No data records listed.'}</p></div>
            ${targetItem.status ? `<div class="crm-section-block"><h4>Health Status Flag</h4><p>${targetItem.status}</p></div>` : ''}
        `;
    }
    overlay.classList.remove('hidden');
}

function closeFullscreenProfile() {
    document.getElementById('fullscreen-modal').classList.add('hidden');
}

/* Secondary relationship modal utilities */
function openRelationshipModal() {
    const selectA = document.getElementById('modal-entity-a');
    selectA.innerHTML = '';
    households.forEach(h => selectA.innerHTML += `<option value="${h.id}">${h.name}</option>`);
    populateTargetDropdown();
    document.getElementById('relationship-modal').classList.remove('hidden');
}
function closeRelationshipModal() { document.getElementById('relationship-modal').classList.add('hidden'); }
function toggleRelationshipFields() { populateTargetDropdown(); }
function populateTargetDropdown() {
    const type = document.getElementById('modal-relation-type').value;
    const selectB = document.getElementById('modal-entity-b');
    selectB.innerHTML = '';
    if (type === 'vet') { vets.forEach(v => selectB.innerHTML += `<option value="${v.id}">${v.name}</option>`); }
    else { households.forEach(h => selectB.innerHTML += `<option value="${h.id}">${h.name}</option>`); }
}
function saveNewRelationship(e) {
    e.preventDefault();
    crossRelationships.push({
        entityId: document.getElementById('modal-entity-a').value,
        targetId: document.getElementById('modal-entity-b').value,
        type: document.getElementById('modal-relation-type').value,
        note: document.getElementById('modal-relation-note').value || 'Linked Node Link'
    });
    closeRelationshipModal();
    renderAllDashboards();
}
