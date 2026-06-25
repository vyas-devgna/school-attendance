// ponytail: seed demo data — Gujarat school, new schema
const fs = require('fs');
const path = require('path');
const { randomUUID: uuid } = require('crypto');

const DB_PATH = path.join(__dirname, 'db.json');

// --- Demo names (Gujarat) ---
const firstNames = [
  'Aarav','Vivaan','Aditya','Vihaan','Arjun','Reyansh','Sai','Arnav','Dhruv','Kabir',
  'Harsh','Jay','Karan','Nirav','Parth','Ravi','Sahil','Tanay','Uday','Yash',
  'Ananya','Diya','Myra','Sara','Aadhya','Isha','Kiara','Riya','Priya','Meera',
  'Divya','Hiral','Jinal','Komal','Minal','Nisha','Pooja','Riddhi','Sneha','Tejal',
];
const lastNames = [
  'Patel','Shah','Mehta','Joshi','Desai','Bhatt','Trivedi','Dave','Parikh','Modi',
  'Chauhan','Solanki','Raval','Thakkar','Panchal','Vyas','Pandya','Amin','Kothari','Nair',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// --- Classes ---
const classes = [
  { id: 'c5a', name: '5', division: 'A', label: '5-A' },
  { id: 'c5b', name: '5', division: 'B', label: '5-B' },
  { id: 'c6a', name: '6', division: 'A', label: '6-A' },
];

// --- Students (top-level, 30 per class) ---
const students = [];
for (const cls of classes) {
  for (let i = 1; i <= 30; i++) {
    students.push({
      id: uuid(),
      name: `${pick(firstNames)} ${pick(lastNames)}`,
      rollNo: i,
      classId: cls.id,
      active: true,
    });
  }
}

// --- Users ---
const users = [
  { id: 'admin-1', name: 'Admin', role: 'admin', active: true },
  { id: 'ct-1', name: 'Mrs. Sharma', role: 'class_teacher', active: true },
  { id: 'ct-2', name: 'Mr. Patel', role: 'class_teacher', active: true },
  { id: 'ct-3', name: 'Mrs. Desai', role: 'class_teacher', active: true },
  { id: 'st-1', name: 'Ms. Mehta', role: 'subject_teacher', active: true },
  { id: 'st-2', name: 'Mr. Trivedi', role: 'subject_teacher', active: true },
];

// --- Assignments ---
const assignments = [
  { id: uuid(), userId: 'ct-1', classId: 'c5a', type: 'class_teacher', days: null, startDate: null, endDate: null, temporary: false },
  { id: uuid(), userId: 'ct-2', classId: 'c5b', type: 'class_teacher', days: null, startDate: null, endDate: null, temporary: false },
  { id: uuid(), userId: 'ct-3', classId: 'c6a', type: 'class_teacher', days: null, startDate: null, endDate: null, temporary: false },
];

// --- DB ---
const db = {
  settings: {
    schoolName: 'Sunrise School, Anand',
    academicYear: '2025-26',
    terms: [
      { name: 'Term 1', start: '2025-06-16', end: '2025-10-15' },
      { name: 'Term 2', start: '2025-10-27', end: '2026-03-15' },
    ],
    lockAfterHours: 24,
    setupDone: true,
  },
  users,
  classes,
  students,
  assignments,
  devices: [],
  enrollmentTokens: [],
  attendance: [],
  corrections: [],
  log: [],
};

fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
console.log('Seed data written to db.json');
console.log(`Users: ${users.map(u => `${u.name} (${u.role})`).join(', ')}`);
console.log(`Classes: ${classes.map(c => c.label).join(', ')}`);
console.log(`Students: ${students.length} total`);
