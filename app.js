// Central Data State Arrays Model
let households = [
    { id: 'h-miller', name: 'The Miller Household', note: 'Gate code is #4412.', address: '742 Evergreen Terrace' },
    { id: 'h-davis', name: 'The Davis Household', note: 'Alice handles drop-offs.', address: '122 Maple Road' }
];

let people = [
    { id: 'p-john', householdId: 'h-miller', name: 'John Miller', contact: '555-0192 | john.m@email.com', role: 'Primary' },
    { id: 'p-jane', householdId: 'h-miller', name: 'Jane Miller', contact: '555-0193', role: 'Secondary' },
    { id: 'p-alice', householdId: 'h-davis', name: 'Alice Davis', contact: '555-3341', role: 'Primary' }
];

let pets = [
    { id: 'pet-max', householdId: 'h-miller', name: 'Max', details: 'Golden Retriever (3yo, 72 lbs)', status: '✅ Vaccines Current' },
    { id: 'pet-bella', householdId: 'h-miller', name: 'Bella', details: 'Siamese Cat (7yo, 11 lbs)', status: '❌ Vaccines Expired' },
    { id: 'pet-luna', householdId: 'h-davis', name: 'Luna', details: 'French Bulldog (2yo, 22 lbs)', status: '✅ Vaccines Current' }
];

let vets = [
    { id: 'v-oakridge', name: 'Oakridge Vet Clinic', details: 'Dr. Arrington | 555-9981' },
    { id: 'v-city', name: 'City Animal Hospital', details: 'Emergency Dispatch | 555-1212' }
];

let crossRelationships = [
    { entityId: 'h-miller', targetId: 'v-oakridge', type: 'vet', note: 'Primary Care' },
    { entityId: 'h-davis', targetId: 'v-city', type: 'vet', note: 'Emergency Backup Only' }
];

let currentEntityFilter = 'all';
let isCardLayoutMode = true;

document.addEventListener("DOMContentLoaded", () => {
    renderCRM();
});

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
    renderCRM();
}

function toggleLayout() {
    isCardLayoutMode = !isCardLayoutMode;
    const container = document.getElementById('crm-list-container');
    const toggleBtn = document.querySelector('.toggle-layout-btn');
    
    container.className = isCardLayoutMode ? 'card-layout' : 'list-layout';
    toggleBtn.innerText = isCardLayoutMode ? '📋 Switch to List View' : '🗂️ Switch to Card View';
    renderCRM();
}

/**
 * GENERATOR UTILITY: Standardizes Quick Action Button Configurations
 */
function generateQuickActionsHTML(householdId) {
    return `
        <div class="qa-container" onclick="event.stopPropagation();">
            <button class="qa-icon-btn" data-tooltip="Book Visit" onclick="executeAction('Book Visit', '${householdId}')">📅<span>Book Visit</span></button>
            <button class="qa-icon-btn" data-tooltip="Add Pet" onclick="executeAction('Add Pet', '${householdId}')">🐕<span>Add Pet</span></button>
            <button class="qa-icon-btn" data-tooltip="Add Person" onclick="executeAction('Add Person', '${householdId}')">👤<span>Add Person</span></button>
            <button class="qa-icon-btn" data-tooltip="Add Vet" onclick="executeAction('Add Vet', '${householdId}')">🏥<span>Add Vet</span></button>
            <button class="qa-icon-btn" data-tooltip="Request Payment" onclick="executeAction('Request Payment', '${householdId}')">💳<span>Request Payment</span></button>
            <button class="qa-icon-btn" data-tooltip="Send Email" onclick="executeAction('Send Email', '${householdId}')">✉️<span>Send Email</span></button>
        </div>
    `;
}

function executeAction(actionName, id) {
    alert(`System Operation Dispatched:\n[${actionName}] event triggered for target registration sequence entry reference ID: ${id}`);
}

/**
 * RE-ENGINEERED CRM ENGINE: Injects global click handles to load full profiles
 */
function renderCRM() {
    const container = document.getElementById('crm-list-container');
    const searchVal = document.getElementById('crm-search').value.toLowerCase();
    container.innerHTML = '';

    // Households Layout Render Execution
    if (currentEntityFilter === 'all' || currentEntityFilter === 'household') {
        households.forEach(h => {
            if (!h.name.toLowerCase().includes(searchVal)) return;
            const hPeople = people.filter(p => p.householdId === h.id);
            const hPets = pets.filter(p => p.householdId === h.id);
            const actionsHTML = generateQuickActionsHTML(h.id);

            container.innerHTML += `
                <div class="crm-card" onclick="openFullscreenProfile('household', '${h.id}')">
                    <div class="item-header">
                        <div class="clickable-profile-zone"><h3>${h.name}</h3></div>
                        <span class="entity-badge household">Household</span>
                    </div>
                    ${isCardLayoutMode ? `<p class="pin-note">📌 <strong>Alert:</strong> ${h.note}</p>` : ''}
                    <div class="crm-section-block">
                        <h4>Members</h4>
                        <ul>
                            ${hPeople.map(p => `<li>👤 ${p.name} (${p.role})</li>`).join('')}
                            ${hPets.map(p => `<li>🐾 ${p.name} - ${p.details}</li>`).join('')}
                        </ul>
                    </div>
                    ${actionsHTML}
                </div>
            `;
        });
    }

    // Secondary items check for individual rows context routing
    ['people', 'pets', 'vets'].forEach(category => {
        if (currentEntityFilter === 'all' || currentEntityFilter === category) {
            window[category].forEach(item => {
                if (!item.name.toLowerCase().includes(searchVal)) return;
                
                // Safe check to see if the entity has a parent household
                const parentHId = item.householdId || '';
                
                container.innerHTML += `
                    <div class="crm-card" onclick="openFullscreenProfile('${category}', '${item.id}')">
                        <div class="item-header">
                            <div class="clickable-profile-zone"><h3>${item.name}</h3></div>
                            <span class="entity-badge ${category}">${category}</span>
                        </div>
                        <p>${item.contact || item.details || 'Registered Service Provider Profile Entry Card'}</p>
                        ${parentHId ? generateQuickActionsHTML(parentHId) : ''}
                    </div>
                `;
            });
        }
    });
}

/**
 * FULL SCREEN CRM PROFILE GENERATION ENGINE
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
        const hVets = crossRelationships.filter(r => r.entityId === h.id && r.type === 'vet').map(r => vets.find(v => v.id === r.targetId));

        title.innerText = `${h.name} - Master Command Profile`;
        actionsAnchor.innerHTML = `<h4>Household Actions</h4>` + generateQuickActionsHTML(h.id);
        
        payloadAnchor.innerHTML = `
            <div class="crm-section-block"><h3>Physical Location</h3><p>📍 ${h.address}</p></div>
            <div class="crm-section-block"><h3>Administrative Internal System Log Context</h3><p>${h.note}</p></div>
            <div class="crm-section-block">
                <h3>Family Members (People)</h3>
                <ul>${hPeople.map(p => `<li>👤 <strong>${p.name}</strong> - Access Role Classification: ${p.role} Contact Card (${p.contact})</li>`).join('')}</ul>
            </div>
            <div class="crm-section-block">
                <h3>Animal Profiles (Pets)</h3>
                <ul>${hPets.map(p => `<li>🐾 <strong>${p.name}</strong> - ${p.details} | Health Prerequisites Check: <strong>${p.status}</strong></li>`).join('')}</ul>
            </div>
            <div class="crm-section-block">
                <h3>Linked Primary Care Centers of Influence</h3>
                <ul>${hVets.map(v => `<li>🏥 <strong>${v.name}</strong> - Provider Data: ${v.details}</li>`).join('')}</ul>
            </div>
        `;
    } else {
        // Universal single asset profile lookup routing fallback
        let targetItem = [...people, ...pets, ...vets].find(x => x.id === id);
        title.innerText = `${targetItem.name} - Individual Node Card File`;
        if (targetItem.householdId) {
            actionsAnchor.innerHTML = `<h4>Parent Actions</h4>` + generateQuickActionsHTML(targetItem.householdId);
        }
        payloadAnchor.innerHTML = `
            <div class="crm-section-block"><h3>System Reference Attributes</h3><p>${targetItem.contact || targetItem.details || 'No data notes compiled.'}</p></div>
            ${targetItem.status ? `<div class="crm-section-block"><h3>Health Status Log</h3><p>${targetItem.status}</p></div>` : ''}
        `;
    }

    overlay.classList.remove('hidden');
}

function closeFullscreenProfile() {
    document.getElementById('fullscreen-modal').classList.add('hidden');
}

/* Modal Creation utility triggers */
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
        note: document.getElementById('modal-relation-note').value || 'Linked Node'
    });
    closeRelationshipModal();
    renderCRM();
}
