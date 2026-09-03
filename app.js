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
