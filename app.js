// 1. DATA STORE: Centralized State Simulation Data Model
let households = [
    { id: 'h-miller', name: 'The Miller Household', note: 'Gate code is #4412.', vaxAlert: false },
    { id: 'h-davis', name: 'The Davis Household', note: 'Alice handles drop-offs.', vaxAlert: true }
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

// Relationships arrays store explicit bidirectional reference indices
let crossRelationships = [
    { entityId: 'h-miller', targetId: 'v-oakridge', type: 'vet', note: 'Primary Care' },
    { entityId: 'h-davis', targetId: 'v-city', type: 'vet', note: 'Emergency Backup Only' }
];

// Configuration layout tracking properties
let currentEntityFilter = 'all';
let isCardLayoutMode = true;

// Trigger UI setup loop on load
document.addEventListener("DOMContentLoaded", () => {
    renderCRM();
});

function switchView(viewId) {
    const panels = document.querySelectorAll('.view-panel');
    panels.forEach(panel => panel.classList.add('hidden'));
    const buttons = document.querySelectorAll('.nav-btn');
    buttons.forEach(btn => btn.classList.remove('active'));
    document.getElementById(viewId).classList.remove('hidden');
    const activeBtn = Array.from(buttons).find(btn => btn.getAttribute('onclick').includes(viewId));
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
    if (isCardLayoutMode) {
        container.className = 'card-layout';
        toggleBtn.innerText = '📋 Switch to List View';
    } else {
        container.className = 'list-layout';
        toggleBtn.innerText = '🗂️ Switch to Card View';
    }
    renderCRM();
}

/**
 * 2. CORE RENDERING ENGINE: Resolves deep data references dynamically
 */
function renderCRM() {
    const container = document.getElementById('crm-list-container');
    const searchVal = document.getElementById('crm-search').value.toLowerCase();
    container.innerHTML = ''; // Flush viewport

    // --- RENDER HOUSEHOLDS ---
    if (currentEntityFilter === 'all' || currentEntityFilter === 'household') {
        households.forEach(h => {
            if (!h.name.toLowerCase().includes(searchVal)) return;

            // Gather associated assets via logical filters
            const hPeople = people.filter(p => p.householdId === h.id);
            const hPets = pets.filter(p => p.householdId === h.id);
            
            // Map connected relationships
            const hVets = crossRelationships.filter(r => r.entityId === h.id && r.type === 'vet')
                .map(r => ({ ...vets.find(v => v.id === r.targetId), note: r.note }));
            const hRelated = crossRelationships.filter(r => r.entityId === h.id && r.type !== 'vet')
                .map(r => ({ target: getEntityNameAndType(r.targetId), note: r.note, type: r.type }));

            container.innerHTML += `
                <div class="crm-card" data-type="household">
                    <div class="item-header"><h3>${h.name}</h3><span class="entity-badge household">Household</span></div>
                    <p class="pin-note">📝 <strong>Household Context:</strong> ${h.note}</p>
                    
                    <div class="crm-section-block">
                        <h4>Members (People & Pets)</h4>
                        <ul>
                            ${hPeople.map(p => `<li>👤 <strong>${p.name}</strong> (${p.role} Contact) - ${p.contact}</li>`).join('')}
                            ${hPets.map(p => `<li>🐾 <strong>${p.name}</strong> - ${p.details} | <em>${p.status}</em></li>`).join('')}
                        </ul>
                    </div>

                    <div class="crm-section-block">
                        <h4>Linked Veterinary COIs</h4>
                        <ul>
                            ${hVets.length ? hVets.map(v => `<li>🏥 <strong>${v.name}</strong> (${v.details}) <span class="relation-tag">${v.note}</span></li>`).join('') : '<li>No preferred clinic set.</li>'}
                        </ul>
                    </div>

                    <div class="crm-section-block">
                        <h4>Related Circles & External Contacts</h4>
                        <ul>
                            ${hRelated.length ? hRelated.map(r => `<li>🔗 Linked to <strong>${r.target.name}</strong> <span class="entity-badge ${r.target.type}">${r.target.type}</span> - <span class="relation-tag">${r.type}: ${r.note}</span></li>`).join('') : '<li>No external relations linked.</li>'}
                        </ul>
                    </div>
                </div>
            `;
        });
    }

    // --- RENDER PEOPLE ---
    if (currentEntityFilter === 'all' || currentEntityFilter === 'people') {
        people.forEach(p => {
            if (!p.name.toLowerCase().includes(searchVal)) return;
            const parentH = households.find(h => h.id === p.householdId);
            const hPeople = people.filter(o => o.householdId === p.householdId && o.id !== p.id);
            const hPets = pets.filter(o => o.householdId === p.householdId);

            container.innerHTML += `
                <div class="crm-card" data-type="people">
                    <div class="item-header"><h3>${p.name}</h3><span class="entity-badge person">Person</span></div>
                    <p><strong>Contact Info:</strong> ${p.contact}</p>
                    
                    <div class="crm-section-block">
                        <h4>Household Unit Reference (Read-Only)</h4>
                        <p>🏠 Associated with <strong>${parentH.name}</strong></p>
                        <ul>
                            ${hPeople.map(o => `<li>👤 Co-resident: ${o.name}</li>`).join('')}
                            ${hPets.map(pt => `<li>🐾 Shared Pet: ${pt.name} (${pt.details})</li>`).join('')}
                        </ul>
                    </div>
                </div>
            `;
        });
    }

    // --- RENDER PETS ---
    if (currentEntityFilter === 'all' || currentEntityFilter === 'pets') {
        pets.forEach(pt => {
            if (!pt.name.toLowerCase().includes(searchVal)) return;
            const parentH = households.find(h => h.id === pt.householdId);

            container.innerHTML += `
                <div class="crm-card" data-type="pets">
                    <div class="item-header"><h3>${pt.name}</h3><span class="entity-badge pets">Pet</span></div>
                    <p><strong>Attributes:</strong> ${pt.details}</p>
                    <p><strong>Status:</strong> ${pt.status}</p>
                    <div class="crm-section-block">
                        <h4>Household Hierarchy</h4>
                        <p>🏠 Part of <strong>${parentH.name}</strong></p>
                    </div>
                </div>
            `;
        });
    }

    // --- RENDER VETS ---
    if (currentEntityFilter === 'all' || currentEntityFilter === 'vets') {
        vets.forEach(v => {
            if (!v.name.toLowerCase().includes(searchVal)) return;
            
            // Query for households linked to this clinic
            const connectedClients = crossRelationships.filter(r => r.targetId === v.id && r.type === 'vet')
                .map(r => households.find(h => h.id === r.entityId));

            let clientsTreeHTML = '';
            if (connectedClients.length) {
                connectedClients.forEach(clientH => {
                    const hPeople = people.filter(p => p.householdId === clientH.id);
                    const hPets = pets.filter(p => p.householdId === clientH.id);
                    
                    clientsTreeHTML += `
                        <div class="indent-level-1">
                            🏢 <strong>${clientH.name}</strong>
                            ${hPeople.map(p => `<div class="indent-level-2">👤 ${p.name} (${p.contact})</div>`).join('')}
                            ${hPets.map(p => `<div class="indent-level-2">🐾 ${p.name} - ${p.details}</div>`).join('')}
                        </div>
                    `;
                });
            } else {
                clientsTreeHTML = '<p style="font-size:0.9rem; padding-left:1rem;">No households currently mapped.</p>';
            }

            container.innerHTML += `
                <div class="crm-card" data-type="vets">
                    <div class="item-header"><h3>${v.name}</h3><span class="entity-badge vets">Vet / COI</span></div>
                    <p><strong>Details:</strong> ${v.details}</p>
                    <div class="crm-section-block">
                        <h4>Registered Client Manifest</h4>
                        ${clientsTreeHTML}
                    </div>
                </div>
            `;
        });
    }
}

// 3. REFLECTION ENGINE HELPER: Resolves raw entity ids back to visual names
function getEntityNameAndType(id) {
    let match = households.find(e => e.id === id); if (match) return { name: match.name, type: 'household' };
    match = people.find(e => e.id === id); if (match) return { name: match.name, type: 'person' };
    match = pets.find(e => e.id === id); if (match) return { name: match.name, type: 'pets' };
    match = vets.find(e => e.id === id); if (match) return { name: match.name, type: 'vets' };
    return { name: 'Unknown', type: 'general' };
}

/**
 * 4. INTERACTIVE RELATIONSHIP MODAL MANAGEMENT
 */
function openRelationshipModal() {
    const modal = document.getElementById('relationship-modal');
    const selectA = document.getElementById('modal-entity-a');
    const selectB = document.getElementById('modal-entity-b');
    
    selectA.innerHTML = ''; selectB.innerHTML = '';
    
    // Aggregate potential relationship entities into the picklist options
    households.forEach(h => selectA.innerHTML += `<option value="${h.id}">${h.name} [Household]</option>`);
    people.forEach(p => selectA.innerHTML += `<option value="${p.id}">${p.name} [Person]</option>`);
    
    populateTargetDropdown();
    modal.classList.remove('hidden');
}

function toggleRelationshipFields() {
    populateTargetDropdown();
}

function populateTargetDropdown() {
    const type = document.getElementById('modal-relation-type').value;
    const selectB = document.getElementById('modal-entity-b');
    selectB.innerHTML = '';

    if (type === 'vet') {
        vets.forEach(v => selectB.innerHTML += `<option value="${v.id}">${v.name} [Vet/COI]</option>`);
    } else {
        households.forEach(h => selectB.innerHTML += `<option value="${h.id}">${h.name} [Household]</option>`);
        people.forEach(p => selectB.innerHTML += `<option value="${p.id}">${p.name} [Person]</option>`);
    }
}

function closeRelationshipModal() {
    document.getElementById('relationship-modal').classList.add('hidden');
    document.getElementById('relation-form').reset();
}

/**
 * 5. TWO-WAY CROSS-POPULATION PROCESSOR
 */
function saveNewRelationship(e) {
    e.preventDefault();
    const entityA = document.getElementById('modal-entity-a').value;
    const type = document.getElementById('modal-relation-type').value;
    const entityB = document.getElementById('modal-entity-b').value;
    const note = document.getElementById('modal-relation-note').value || 'Linked Link';

    // Establish link from A to B
    crossRelationships.push({ entityId: entityA, targetId: entityB, type: type, note: note });
    
    // Automatically establish reciprocal inverse connection if it's an external contact relationship
    if (type !== 'vet') {
        crossRelationships.push({ entityId: entityB, targetId: entityA, type: type, note: `Inverse link: ${note}` });
    }

    closeRelationshipModal();
    renderCRM(); // Force atomic repaint across current viewport views
}
