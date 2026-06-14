// State parameters for tracking interface configuration
let currentEntityFilter = 'all';
let isCardLayoutMode = true;

/**
 * Standard View switcher function
 */
function switchView(viewId) {
    const panels = document.querySelectorAll('.view-panel');
    panels.forEach(panel => panel.classList.add('hidden'));

    const buttons = document.querySelectorAll('.nav-btn');
    buttons.forEach(btn => btn.classList.remove('active'));

    document.getElementById(viewId).classList.remove('hidden');

    const activeBtn = Array.from(buttons).find(btn => btn.getAttribute('onclick').includes(viewId));
    if (activeBtn) activeBtn.classList.add('active');
}

/**
 * Secondary Sub-Menu Filter: Sets active target entity type
 */
function setEntityFilter(filterType) {
    currentEntityFilter = filterType;
    
    // Update active visual status for filter chips
    const chips = document.querySelectorAll('.filter-chip');
    chips.forEach(chip => chip.classList.remove('active'));
    
    document.getElementById(`filter-${filterType}`).classList.add('active');
    
    // Process matching directory results
    filterCRM();
}

/**
 * Layout Toggle Engine: Flips between Card Matrix and Row List View
 */
function toggleLayout() {
    const container = document.getElementById('crm-list-container');
    const toggleBtn = document.querySelector('.toggle-layout-btn');
    
    isCardLayoutMode = !isCardLayoutMode;
    
    if (isCardLayoutMode) {
        container.className = 'card-layout';
        toggleBtn.innerText = '📋 Switch to List View';
    } else {
        container.className = 'list-layout';
        toggleBtn.innerText = '🗂️ Switch to Card View';
    }
}

/**
 * Core Evaluation Engine: Intersects sub-filter category and search text inputs
 */
function filterCRM() {
    const searchInput = document.getElementById('crm-search').value.toLowerCase();
    const crmItems = document.querySelectorAll('.crm-item');

    crmItems.forEach(item => {
        const itemType = item.getAttribute('data-type');
        const searchMetadata = item.getAttribute('data-search').toLowerCase();
        
        // 1. Evaluate Entity Sub-Menu Alignment
        const matchesFilter = (currentEntityFilter === 'all' || itemType === currentEntityFilter);
        
        // 2. Evaluate Text Input Alignment
        const matchesSearch = searchMetadata.includes(searchInput);
        
        // Combine evaluations to toggle visibility
        if (matchesFilter && matchesSearch) {
            item.classList.remove('hidden');
        } else {
            item.classList.add('hidden');
        }
    });
}
