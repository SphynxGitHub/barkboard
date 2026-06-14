/**
 * Simple Single-Page App router to swap views without a full reload
 */
function switchView(viewId) {
    // Hide all view panels
    const panels = document.querySelectorAll('.view-panel');
    panels.forEach(panel => panel.classList.add('hidden'));

    // Deactivate all navigation buttons
    const buttons = document.querySelectorAll('.nav-btn');
    buttons.forEach(btn => btn.classList.remove('active'));

    // Show the targeted panel
    document.getElementById(viewId).classList.remove('hidden');

    // Find the button clicking this action and set it active
    const activeBtn = Array.from(buttons).find(btn => btn.getAttribute('onclick').includes(viewId));
    if (activeBtn) activeBtn.classList.add('active');
}
