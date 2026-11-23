export interface Employee {
  [key: string]: unknown;
  id: number;
  name: string;
  role: string;
  team: string;
  office: string;
  started: string;
  salary: number;
  rating: number;
}

const FIRST = ['Aarav', 'Aisha', 'Amelia', 'Ananya', 'Arjun', 'Beatriz', 'Bilal', 'Camila', 'Chen', 'Chloé', 'Dmitri', 'Elena', 'Emeka', 'Fatima', 'Felix', 'Gabriel', 'Hana', 'Hiroshi', 'Ines', 'Isaac', 'Ishaan', 'Jamal', 'Jin', 'José', 'Kavya', 'Kenji', 'Lars', 'Leila', 'Lucas', 'Maya', 'Mei', 'Mateo', 'Nadia', 'Noah', 'Olu', 'Omar', 'Priya', 'Rafael', 'Rhea', 'Rohan', 'Sakura', 'Sara', 'Siddharth', 'Sofia', 'Tariq', 'Thandiwe', 'Tomás', 'Uma', 'Vikram', 'Wei', 'Yara', 'Yusuf', 'Zainab', 'Zoë'];
const LAST = ['Adeyemi', 'Agarwal', 'Alvarez', 'Bauer', 'Bose', 'Chen', 'Costa', 'Das', 'Dubois', 'Eriksson', 'Fernandes', 'García', 'Gupta', 'Haddad', 'Ito', 'Iyer', 'Jensen', 'Kapoor', 'Kim', 'Kowalski', 'Kumar', 'Larsen', 'Mehta', 'Müller', 'Nakamura', 'Nair', 'Novak', 'Okafor', 'Olsen', 'Park', 'Patel', 'Rao', 'Reddy', 'Rossi', 'Sato', 'Schmidt', 'Shah', 'Silva', 'Singh', 'Tanaka', 'Verma', 'Wang', 'Yamamoto', 'Zhang'];
const ROLES = ['Software Engineer', 'Senior Software Engineer', 'Staff Engineer', 'Engineering Manager', 'Product Manager', 'Product Designer', 'Data Analyst', 'Data Scientist', 'QA Engineer', 'SRE', 'Technical Writer', 'Solutions Architect', 'Account Executive', 'Support Specialist'];
const TEAMS = ['Payments', 'Growth', 'Platform', 'Search', 'Mobile', 'Data', 'Infra', 'Security', 'Messaging', 'Analytics'];
const OFFICES = ['Bengaluru', 'Berlin', 'Gurugram', 'Lagos', 'London', 'Mumbai', 'New York', 'Pune', 'São Paulo', 'Singapore', 'Tokyo', 'Toronto'];

/** Small, fast, seeded PRNG so every visitor sees the same data. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const START = Date.UTC(2012, 0, 1);
const SPAN_DAYS = 365 * 13;

export function makeEmployees(count: number, seed = 42): Employee[] {
  const make = employeeFactory(seed);
  const rows = new Array<Employee>(count);
  for (let i = 0; i < count; i++) rows[i] = make(i);
  return rows;
}

/** Same data as makeEmployees, generated in ~12ms slices so the page stays responsive. */
export async function makeEmployeesAsync(count: number, seed = 42): Promise<Employee[]> {
  const make = employeeFactory(seed);
  const rows = new Array<Employee>(count);
  let i = 0;
  while (i < count) {
    const started = performance.now();
    while (i < count && performance.now() - started < 12) {
      const end = Math.min(count, i + 2000);
      for (; i < end; i++) rows[i] = make(i);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return rows;
}

function employeeFactory(seed: number) {
  const random = mulberry32(seed);
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
  return (i: number): Employee => {
    const role = pick(ROLES);
    const seniority = role.startsWith('Staff') || role.endsWith('Manager') || role === 'Solutions Architect' ? 1.6 : role.startsWith('Senior') ? 1.3 : 1;
    return {
      id: i + 1,
      name: `${pick(FIRST)} ${pick(LAST)}`,
      role,
      team: pick(TEAMS),
      office: pick(OFFICES),
      started: new Date(START + Math.floor(random() * SPAN_DAYS) * 864e5).toISOString().slice(0, 10),
      salary: Math.round((52_000 + random() * 90_000) * seniority / 100) * 100,
      rating: Math.round((2.5 + random() * 2.5) * 10) / 10,
    };
  };
}
