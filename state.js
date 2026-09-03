/* ==========================================================================
   STATE MODULE: Central Application Data Store & Utilities
   ========================================================================== */

var households = [
  { id: 'h-miller', name: 'The Miller Household', note: 'Gate code is #4412. Prefer early morning drop-off.', address: '742 Evergreen Terrace, Springfield, IL 62701' },
  { id: 'h-davis', name: 'The Davis Household', note: 'Alice handles all drop-offs and pickups.', address: '122 Maple Road, Springfield, IL 62704' }
];

var people = [
  { id: 'p-john', householdId: 'h-miller', name: 'John Miller', contact: '555-0192 | john.m@email.com', role: 'Primary' },
  { id: 'p-jane', householdId: 'h-miller', name: 'Jane Miller', contact: '555-0193 | jane.m@email.com', role: 'Secondary' },
  { id: 'p-alice', householdId: 'h-davis', name: 'Alice Davis', contact: '555-3341 | alice.d@email.com', role: 'Primary' }
];

var pets = [
  { id: 'pet-max', householdId: 'h-miller', name: 'Max', species: 'dog', details: 'Golden Retriever · 3 yrs · 72 lbs', status: 'current', room: 'Luxury Suite #5', vaccineExpiry: 'Dec 2026', allergies: 'None', food: 'Blue Buffalo Large Breed, 2 cups twice daily' },
  { id: 'pet-bella', householdId: 'h-miller', name: 'Bella', species: 'cat', details: 'Siamese Cat · 7 yrs · 11 lbs', status: 'expired', room: 'Cat Condo A', vaccineExpiry: 'Mar 2024', allergies: 'Chicken proteins', food: 'Royal Canin Siamese, ¼ cup twice daily' },
  { id: 'pet-luna', householdId: 'h-davis', name: 'Luna', species: 'dog', details: 'French Bulldog · 2 yrs · 22 lbs', status: 'current', room: 'Standard Run B', vaccineExpiry: 'Sep 2026', allergies: 'None', food: 'Hill\'s Science Diet Small Breed, 1 cup twice daily' }
];

var vets = [
  { id: 'v-oakridge', name: 'Oakridge Vet Clinic', details: 'Dr. Arrington · 555-9981 · 300 Oak St, Springfield', specialty: 'Primary Care' },
  { id: 'v-city', name: 'City Animal Hospital', details: 'Emergency Dispatch · 555-1212 · 88 Central Ave, Springfield', specialty: 'Emergency' }
];

var crossRelationships = [
  { entityId: 'h-miller', targetId: 'v-oakridge', type: 'vet', note: 'Primary Care' },
  { entityId: 'h-davis', targetId: 'v-city', type: 'vet', note: 'Emergency Backup Only' }
];

var visits = {
  'h-miller': [
    { id: 'v1', petName: 'Max', service: 'Luxury Suite Boarding', checkIn: 'Jun 10, 2026', checkOut: 'Jun 14, 2026', nights: 4, amount: 220, staff: 'Kayla R.', status: 'completed', rating: '⭐⭐⭐⭐⭐' },
    { id: 'v2', petName: 'Bella', service: 'Cat Condo Boarding', checkIn: 'May 3, 2026', checkOut: 'May 6, 2026', nights: 3, amount: 105, staff: 'Tom H.', status: 'completed', rating: '⭐⭐⭐⭐' },
    { id: 'v3', petName: 'Max', service: 'Private Agility Training', checkIn: 'Apr 18, 2026', checkOut: 'Apr 18, 2026', nights: null, amount: 75, staff: 'Maria C.', status: 'completed', rating: '⭐⭐⭐⭐⭐' },
    { id: 'v4', petName: 'Max', service: 'Luxury Suite Boarding', checkIn: 'Feb 14, 2026', checkOut: 'Feb 17, 2026', nights: 3, amount: 165, staff: 'Kayla R.', status: 'completed', rating: '⭐⭐⭐⭐⭐' }
  ],
  'h-davis': [
    { id: 'v5', petName: 'Luna', service: 'Standard Boarding', checkIn: 'Jun 1, 2026', checkOut: 'Jun 14, 2026', nights: 13, amount: 455, staff: 'Tom H.', status: 'completed', rating: '⭐⭐⭐⭐' }
  ]
};

var bookings = {
  'h-miller': [
    { id: 'b1', petName: 'Max', service: 'Luxury Suite Boarding', checkIn: 'Jul 3, 2026', checkOut: 'Jul 7, 2026', nights: 4, amount: 220, status: 'upcoming', confirmCode: 'BK-4421' },
    { id: 'b2', petName: 'Max + Bella', service: 'Luxury Suite + Cat Condo', checkIn: 'Aug 21, 2026', checkOut: 'Aug 28, 2026', nights: 7, amount: 490, status: 'upcoming', confirmCode: 'BK-4488' }
  ],
  'h-davis': [
    { id: 'b3', petName: 'Luna', service: 'Standard Boarding', checkIn: 'Jul 10, 2026', checkOut: 'Jul 14, 2026', nights: 4, amount: 140, status: 'upcoming', confirmCode: 'BK-4435' }
  ]
};

var payments = {
  'h-miller': {
    balance: 0, credit: 50, totalSpend: 565, cardOnFile: 'Visa ending 4411',
    history: [
      { date: 'Jun 14, 2026', description: 'Luxury Suite Boarding (4 nights)', amount: 220, status: 'paid' },
      { date: 'May 6, 2026', description: 'Cat Condo Boarding (3 nights)', amount: 105, status: 'paid' },
      { date: 'Apr 18, 2026', description: 'Private Agility Training', amount: 75, status: 'paid' },
      { date: 'Feb 17, 2026', description: 'Luxury Suite Boarding (3 nights)', amount: 165, status: 'paid' }
    ]
  },
  'h-davis': {
    balance: 0, credit: 0, totalSpend: 455, cardOnFile: 'Mastercard ending 8832',
    history: [
      { date: 'Jun 14, 2026', description: 'Standard Boarding (13 nights)', amount: 455, status: 'paid' }
    ]
  }
};

var communications = {
  'h-miller': [
    { from: 'staff', name: 'Barkboard Team', text: 'Hi John! Just a reminder that Max\'s boarding begins July 3rd.', date: 'Jun 12, 2026 · 10:14 AM' },
    { from: 'owner', name: 'John Miller', text: 'Thanks! Will do — I\'ll also pack his favorite rope toy.', date: 'Jun 12, 2026 · 11:32 AM' }
  ],
  'h-davis': [
    { from: 'staff', name: 'Barkboard Team', text: 'Luna has been an absolute joy this stay!', date: 'Jun 10, 2026 · 2:45 PM' }
  ]
};

var notes = {
  'h-miller': [
    { author: 'Kayla R.', date: 'Jun 14, 2026', text: 'Max completed his stay in excellent spirits.' }
  ],
  'h-davis': [
    { author: 'Tom H.', date: 'Jun 14, 2026', text: 'Luna is a high-energy dog who does best with morning play.' }
  ]
};

var documents = {
  'h-miller': [
    { name: 'Max — Vaccination Record 2025.pdf', type: 'PDF', size: '184 KB', date: 'Dec 2025' }
  ],
  'h-davis': [
    { name: 'Luna — Vaccination Record 2025.pdf', type: 'PDF', size: '201 KB', date: 'Sep 2025' }
  ]
};

var serviceTypes = [
  { id:'svc-agility', name:'Agility Training', category:'training', color:'#ede9fe', textColor:'#5b21b6' },
  { id:'svc-obedience', name:'Obedience Training', category:'training', color:'#dbeafe', textColor:'#1e40af' },
  { id:'svc-boarding-luxury', name:'Luxury Suite Boarding', category:'boarding', color:'#e0f2fe', textColor:'#0369a1' },
  { id:'svc-boarding-std', name:'Standard Boarding', category:'boarding', color:'#f3f4f6', textColor:'#4b5563' }
];

var staffMembers = [
  { id:'s1', name:'Maria C.', role:'Trainer', contact:'maria@barkboard.com', notes:'Lead agility trainer', initials:'MC' },
  { id:'s2', name:'Kayla R.', role:'Boarding Staff', contact:'kayla@barkboard.com', notes:'Senior boarding attendant', initials:'KR' },
  { id:'s3', name:'Tom H.', role:'Boarding Staff', contact:'tom@barkboard.com', notes:'Cat specialist', initials:'TH' }
];

var staffQualifications = {
  's1': [{ serviceId:'svc-agility', dailyMax:4 }],
  's2': [{ serviceId:'svc-boarding-luxury', dailyMax:99 }, { serviceId:'svc-boarding-std', dailyMax:99 }],
  's3': [{ serviceId:'svc-boarding-std', dailyMax:99 }]
};

var staffBookingLedger = {
  '2026-06-14': { 'svc-agility':{'s1':2} }
};

var staffAvailability = [];
var petAssignments = [];
var staffTasks = [];
var editingStaffId = null;
var nextStaffId = 10;

// App Runtime Control State
var currentEntityFilter = 'all';
var isCardLayoutMode = true;
var currentOwnerHouseholdId = null;
var currentFsHouseholdId = null;
var currentOwnerSection = 'household';

// Utility Date Helpers
function today() { return new Date(2026, 5, 14); }
function isoToDate(s) { const [y,m,d] = s.split('-').map(Number); return new Date(y,m-1,d); }
function dateToIso(d) { return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function fmtDate(iso) { return isoToDate(iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
